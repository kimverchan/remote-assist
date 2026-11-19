package com.pcxx.remote.controller.net

import com.pcxx.remote.controller.BuildConfig
import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.math.min

/** WebSocket 传输层：Header 鉴权、心跳、指数退避重连、401 触发令牌刷新 */
class RelayClient(
    baseUrl: String,
    private val listener: Listener
) {
    interface Listener {
        fun onStateChanged(state: State)
        fun onTextMessage(envelope: JSONObject)
        fun onBinaryMessage(frame: ByteArray)
        fun onClosed(code: Int, reason: String)
        fun onAuthExpired()
    }

    enum class State { IDLE, CONNECTING, CONNECTED, RECONNECTING, CLOSED }

    private val root = baseUrl.trim().trimEnd('/')

    init {
        require(root.startsWith("https://") || (BuildConfig.ALLOW_CLEARTEXT && root.startsWith("http://"))) {
            if (BuildConfig.ALLOW_CLEARTEXT) {
                "中继服务器地址必须以 http(s) 协议开头"
            } else {
                "正式包必须使用 HTTPS/WSS 连接中继服务器"
            }
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private var socket: WebSocket? = null
    private var token: String? = null
    private var attempts = 0
    @Volatile private var closedByUser = false
    private val reconnectTask = Runnable { token?.let { open(it) } }

    private fun wsUrl(): String = when {
        root.startsWith("https://") -> "wss://${root.removePrefix("https://")}/ws"
        root.startsWith("http://") -> "ws://${root.removePrefix("http://")}/ws"
        else -> throw IllegalArgumentException("中继服务器地址必须是 http(s) 协议")
    }

    fun connect(accessToken: String) {
        closedByUser = false
        main.removeCallbacks(reconnectTask)
        open(accessToken)
    }

    private fun open(accessToken: String) {
        token = accessToken
        listener.onStateChanged(if (attempts == 0) State.CONNECTING else State.RECONNECTING)
        val request = Request.Builder()
            .url(wsUrl())
            .header("Authorization", "Bearer $accessToken")
            .build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                attempts = 0
                listener.onStateChanged(State.CONNECTED)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                runCatching { listener.onTextMessage(JSONObject(text)) }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                listener.onBinaryMessage(bytes.toByteArray())
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                listener.onClosed(code, reason)
                handleDisconnect(code)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (response?.code == 401) {
                    listener.onAuthExpired()
                    return
                }
                listener.onClosed(-1, t.message ?: "连接失败")
                handleDisconnect(-1)
            }
        })
    }

    private fun handleDisconnect(code: Int) {
        if (closedByUser || code == 4001 || code == 4003) {
            listener.onStateChanged(State.CLOSED)
            return
        }
        attempts += 1
        val delay = min(1000L shl min(attempts, 5), 30_000L)
        listener.onStateChanged(State.RECONNECTING)
        main.postDelayed(reconnectTask, delay)
    }

    fun refreshToken(newAccessToken: String) {
        socket?.close(1000, "令牌已刷新")
        main.removeCallbacks(reconnectTask)
        attempts = 0
        open(newAccessToken)
    }

    fun send(text: String): Boolean = socket?.send(text) ?: false

    fun close() {
        closedByUser = true
        main.removeCallbacks(reconnectTask)
        runCatching { socket?.close(1000, "客户端主动结束") }
        socket = null
        listener.onStateChanged(State.CLOSED)
    }

    fun dispose() {
        close()
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
    }
}
