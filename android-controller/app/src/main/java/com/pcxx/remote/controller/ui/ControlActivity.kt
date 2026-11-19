package com.pcxx.remote.controller.ui

import android.graphics.SurfaceTexture
import android.os.Bundle
import android.view.Gravity
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import com.pcxx.remote.controller.R
import com.pcxx.remote.controller.decode.H264Decoder
import com.pcxx.remote.controller.input.TouchMapper
import com.pcxx.remote.controller.net.ApiClient
import com.pcxx.remote.controller.net.RelayClient
import com.pcxx.remote.controller.net.TokenStore
import com.pcxx.remote.controller.protocol.Protocol
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject

class ControlActivity : AppCompatActivity(), TextureView.SurfaceTextureListener {

    private lateinit var texture: TextureView
    private lateinit var status: TextView
    private lateinit var tokens: TokenStore

    private var relay: RelayClient? = null
    private var api: ApiClient? = null
    private var decoder: H264Decoder? = null
    private var surface: Surface? = null
    private var serverUrl: String = ""
    private var sessionId: String = ""
    private var accessToken: String = ""
    private var streamWidth = 1080
    private var streamHeight = 1920
    // v2：只有受控端在会话内明确同意后，服务端才允许下发控制指令
    private var authorized = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_control)
        // Android 15（targetSdk 35）强制 edge-to-edge：把顶部栏（含「断开」）移出系统状态栏/刘海区域
        applySafeAreaInsets(findViewById<View>(R.id.rootControl), forceDarkSurface = true)

        serverUrl = intent.getStringExtra(EXTRA_SERVER_URL).orEmpty()
        sessionId = intent.getStringExtra(EXTRA_SESSION_ID).orEmpty()
        accessToken = intent.getStringExtra(EXTRA_ACCESS_TOKEN).orEmpty()
        val hostModel = intent.getStringExtra(EXTRA_HOST_MODEL).orEmpty()
        if (serverUrl.isBlank() || sessionId.isBlank() || accessToken.isBlank()) {
            finish()
            return
        }

        tokens = TokenStore(this)
        // release 变体会拒绝明文地址；构造失败时给出可读提示而不是崩溃
        api = try {
            ApiClient(serverUrl)
        } catch (e: IllegalArgumentException) {
            toast(e.message ?: "服务器地址不合法")
            finish()
            return
        }
        texture = findViewById(R.id.textureScreen)
        status = findViewById(R.id.tvStatus)
        texture.surfaceTextureListener = this

        val send: (String, JSONObject) -> Unit = { type, payload ->
            if (authorized) {
                relay?.send(Protocol.envelope(type, payload))
            } else {
                runOnUiThread { toast("对方尚未确认协助，操作暂不可用") }
            }
        }
        texture.setOnTouchListener(TouchMapper(send))

        findViewById<Button>(R.id.btnBack).setOnClickListener {
            send(Protocol.Type.BACK, JSONObject())
        }
        findViewById<Button>(R.id.btnHome).setOnClickListener {
            send(Protocol.Type.HOME, JSONObject())
        }
        findViewById<Button>(R.id.btnRecents).setOnClickListener {
            send(Protocol.Type.RECENTS, JSONObject())
        }
        findViewById<Button>(R.id.btnText).setOnClickListener { showTextDialog(send) }
        findViewById<Button>(R.id.btnDisconnect).setOnClickListener { button ->
            // 只响应一次，避免连点重复触发退出流程
            button.isEnabled = false
            finish()
        }

        status.text = "已连接：$hostModel，等待对方确认协助…"
        connectRelay()
    }

    private fun connectRelay() {
        val client = RelayClient(serverUrl, object : RelayClient.Listener {
            override fun onStateChanged(state: RelayClient.State) {
                runOnUiThread {
                    status.text = when (state) {
                        RelayClient.State.CONNECTED -> "已连接，等待画面…"
                        RelayClient.State.CONNECTING -> "正在连接…"
                        RelayClient.State.RECONNECTING -> "连接中断，正在重连…"
                        RelayClient.State.CLOSED -> "已断开"
                        else -> status.text.toString()
                    }
                }
            }

            override fun onTextMessage(envelope: JSONObject) = handleText(envelope)

            override fun onBinaryMessage(frame: ByteArray) {
                val parsed = Protocol.parseFrame(frame) ?: return
                decoder?.submit(parsed)
            }

            override fun onClosed(code: Int, reason: String) {
                if (code == 4001 || code == 4002) {
                    runOnUiThread {
                        toast("会话已结束：$reason")
                        finish()
                    }
                }
            }

            override fun onAuthExpired() = refreshAndReconnect()
        })
        relay = client
        client.connect(accessToken)
    }

    private fun handleText(envelope: JSONObject) {
        val type = envelope.optString("type")
        val payload = envelope.optJSONObject("payload") ?: JSONObject()
        when (type) {
            Protocol.Type.PING ->
                relay?.send(Protocol.envelope(Protocol.Type.PONG, JSONObject()))

            Protocol.Type.SESSION_READY -> runOnUiThread {
                // 关键帧等对方确认后再请求，授权前不触发对端任何动作
                status.text = "已连接，等待对方确认协助…"
            }

            Protocol.Type.AUTHORIZE_STATE -> {
                val granted = payload.optBoolean("authorized", false)
                authorized = granted
                runOnUiThread {
                    status.text = if (granted) {
                        "已获授权，正在接收画面…"
                    } else {
                        "等待对方确认协助：${payload.optString("reason", "请稍候")}"
                    }
                }
                if (granted) {
                    relay?.send(Protocol.envelope(Protocol.Type.KEYFRAME_REQUEST, JSONObject()))
                }
            }

            Protocol.Type.SESSION_ERROR -> runOnUiThread {
                toast(payload.optString("message", "操作未能执行"))
            }

            Protocol.Type.STREAM_CONFIG -> {
                streamWidth = payload.optInt("width", streamWidth)
                streamHeight = payload.optInt("height", streamHeight)
                runOnUiThread { applyAspectRatio() }
            }

            Protocol.Type.PEER_LEFT -> runOnUiThread {
                status.text = "受控端暂时断开，等待重连…"
            }

            Protocol.Type.ACK -> if (!payload.optBoolean("ok", true)) {
                runOnUiThread { toast(payload.optString("error", "操作未能执行")) }
            }

            Protocol.Type.SESSION_CLOSED -> runOnUiThread {
                toast("会话已关闭：${payload.optString("reason")}")
                finish()
            }

            else -> Unit
        }
    }

    private fun showTextDialog(send: (String, JSONObject) -> Unit) {
        val input = EditText(this).apply { hint = "输入要发送到对方手机的文字" }
        AlertDialog.Builder(this)
            .setTitle("输入文字")
            .setView(input)
            .setPositiveButton("发送") { _, _ ->
                val text = input.text.toString().take(512)
                if (text.isNotEmpty()) {
                    send(Protocol.Type.TEXT, JSONObject().put("text", text))
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun refreshAndReconnect() {
        val refresh = tokens.refreshToken ?: run {
            runOnUiThread { toast("登录已过期，请重新输入设备号和密码") }
            finish()
            return
        }
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val result = api?.refresh(refresh) ?: throw IllegalStateException("API 未初始化")
                val access = result.getString("accessToken")
                accessToken = access
                tokens.updateTokens(access, result.getString("refreshToken"))
                relay?.refreshToken(access)
            } catch (e: Exception) {
                runOnUiThread {
                    toast("登录已过期，请重新输入设备号和密码")
                    finish()
                }
            }
        }
    }

    private fun applyAspectRatio() {
        val frame = findViewById<FrameLayout>(R.id.frameScreen)
        frame.post {
            if (frame.width <= 0 || frame.height <= 0) return@post
            val ratio = streamWidth.toFloat() / streamHeight.coerceAtLeast(1)
            var w = frame.width.toFloat()
            var h = w / ratio
            if (h > frame.height) {
                h = frame.height.toFloat()
                w = h * ratio
            }
            texture.layoutParams = FrameLayout.LayoutParams(
                w.toInt().coerceAtLeast(1),
                h.toInt().coerceAtLeast(1),
                Gravity.CENTER
            )
        }
    }

    override fun onSurfaceTextureAvailable(surfaceTexture: SurfaceTexture, width: Int, height: Int) {
        val renderSurface = Surface(surfaceTexture)
        surface = renderSurface
        decoder = H264Decoder(
            renderSurface,
            onSizeChanged = { w, h ->
                streamWidth = w
                streamHeight = h
                runOnUiThread { applyAspectRatio() }
            },
            onError = { message -> runOnUiThread { toast(message) } }
        )
        decoder?.start()
        applyAspectRatio()
    }

    override fun onSurfaceTextureSizeChanged(surfaceTexture: SurfaceTexture, width: Int, height: Int) =
        applyAspectRatio()

    override fun onSurfaceTextureDestroyed(surfaceTexture: SurfaceTexture): Boolean {
        decoder?.stop()
        decoder = null
        surface?.release()
        surface = null
        return false
    }

    override fun onSurfaceTextureUpdated(surfaceTexture: SurfaceTexture) = Unit

    override fun onDestroy() {
        relay?.dispose()
        relay = null
        decoder?.stop()
        val token = tokens.accessToken
        tokens.clear()
        if (sessionId.isNotBlank() && token != null) {
            CoroutineScope(Dispatchers.IO).launch {
                api?.closeSession(sessionId, token)
            }
        }
        super.onDestroy()
    }

    private fun toast(message: String) =
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()

    companion object {
        const val EXTRA_SERVER_URL = "server_url"
        const val EXTRA_ACCESS_TOKEN = "access_token"
        const val EXTRA_SESSION_ID = "session_id"
        const val EXTRA_HOST_MODEL = "host_model"
    }
}
