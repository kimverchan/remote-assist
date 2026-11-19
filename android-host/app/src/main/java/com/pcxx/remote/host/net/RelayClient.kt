package com.pcxx.remote.host.net

import com.pcxx.remote.host.BuildConfig
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

/** 首次连接最多尝试次数：超过即停止重连并向上层报错 */
private const val MAX_INITIAL_ATTEMPTS = 3

/**
 * WebSocket 传输层：Authorization 头鉴权（禁止 query 传令牌）、心跳保活、
 * 指数退避重连、401 触发上层刷新令牌。回调发生在 OkHttp 线程，由上层自行切线程。
 *
 * 连接状态分两种：从未连上过（首次连接失败达到上限即明确报错，不无限重连）、
 * 连上后掉线（保留原有无限退避重连，用于会话中断后的宽限期恢复）。
 */
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
        /** 首次连接阶段连续失败且已放弃重连：上层必须给出明确报错 */
        fun onConnectFailed(reason: String, attempts: Int) {}
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
    // 区分「首次就连不上」与「连上之后掉线」：后者保留无限退避重连
    private var everConnected = false
    private var connectFailedReported = false
    private var lastFailureReason = "连接失败"

    private val reconnectTask = Runnable { token?.let { open(it) } }

    private fun wsUrl(): String = when {
        root.startsWith("https://") -> "wss://${root.removePrefix("https://")}/ws"
        root.startsWith("http://") -> "ws://${root.removePrefix("http://")}/ws"
        else -> throw IllegalArgumentException("中继服务器地址必须是 http(s) 协议")
    }

    fun connect(accessToken: String) {
        closedByUser = false
        everConnected = false
        connectFailedReported = false
        attempts = 0
        lastFailureReason = "连接失败"
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
                everConnected = true
                connectFailedReported = false
                listener.onStateChanged(State.CONNECTED)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                runCatching { listener.onTextMessage(JSONObject(text)) }
                    .onFailure { listener.onClosed(-1, "文本帧解析失败") }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                listener.onBinaryMessage(bytes.toByteArray())
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                lastFailureReason = reason.ifBlank { "连接被服务端关闭（代码 $code）" }
                listener.onClosed(code, reason)
                handleDisconnect(code)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (response?.code == 401) {
                    listener.onAuthExpired()
                    return
                }
                lastFailureReason = t.message?.takeIf { it.isNotBlank() } ?: "连接失败"
                listener.onClosed(-1, lastFailureReason)
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
        // 从未连上过：连续失败达到上限即停止无限重连，向上层报明确错误；
        // 曾连上过：保留原有的无限退避重连（会话中断后的宽限期恢复）。
        if (!everConnected && attempts >= MAX_INITIAL_ATTEMPTS) {
            if (!connectFailedReported) {
                connectFailedReported = true
                listener.onConnectFailed(lastFailureReason, attempts)
            }
            listener.onStateChanged(State.CLOSED)
            return
        }
        val delay = min(1000L shl min(attempts, 5), 30_000L)
        listener.onStateChanged(State.RECONNECTING)
        main.postDelayed(reconnectTask, delay)
    }

    fun refreshToken(newAccessToken: String) {
        // 新令牌在下一次连接时生效；强制重连以替换服务端连接上的旧身份
        socket?.close(1000, "令牌已刷新")
        main.removeCallbacks(reconnectTask)
        attempts = 0
        open(newAccessToken)
    }

    fun send(text: String): Boolean = socket?.send(text) ?: false

    fun send(frame: ByteArray): Boolean =
        socket?.send(ByteString.of(*frame)) ?: false

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
