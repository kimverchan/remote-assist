package com.pcxx.remote.host.service

import android.app.Activity
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.IntentCompat
import com.pcxx.remote.host.R
import com.pcxx.remote.host.RemoteHostApp
import com.pcxx.remote.host.audit.OperationAudit
import com.pcxx.remote.host.capture.ScreenEncoder
import com.pcxx.remote.host.config.UnattendedConfig
import com.pcxx.remote.host.inject.RemoteAccessibilityService
import com.pcxx.remote.host.inject.SessionGate
import com.pcxx.remote.host.net.ApiClient
import com.pcxx.remote.host.net.ApiException
import com.pcxx.remote.host.net.RelayClient
import com.pcxx.remote.host.net.TokenStore
import com.pcxx.remote.host.protocol.Protocol
import com.pcxx.remote.host.ui.MainActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException
import kotlin.math.max
import kotlin.math.min

/** 建会话阶段总等待上限：超时即报错，避免中继不可达时长时间停在「正在连接」 */
private const val CONNECT_TIMEOUT_MS = 20_000L

/** 无人值守自动重连：2s 起指数退避，封顶 30s */
private const val RESTART_BASE_MS = 2_000L
private const val RESTART_MAX_MS = 30_000L

class HostForegroundService : Service() {

    enum class Phase {
        IDLE, CONNECTING, WAITING, AWAITING_AUTHORIZATION, STREAMING, ERROR, CLOSED
    }

    data class HostState(
        val phase: Phase = Phase.IDLE,
        val pairingCode: String? = null,
        val message: String? = null,
        val peerOnline: Boolean = false
    )

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var tokens: TokenStore
    private var api: ApiClient? = null
    private var relay: RelayClient? = null
    private var encoder: ScreenEncoder? = null
    private var projection: MediaProjection? = null
    private var projectionCallback: MediaProjection.Callback? = null
    private var sessionId: String? = null
    private var serverUrl: String = ""
    private var pendingControllerLabel = "协助设备"
    // 连接/建会话失败后固定展示的错误：stopAll / onDestroy 重复调用也不覆盖
    private var terminalError: String? = null

    private lateinit var unattended: UnattendedConfig
    /** 本次服务运行期间是否以无人值守模式工作（启动时快照，运行中改配置不生效） */
    @Volatile private var unattendedActive = false
    /** 用户主动点「结束协助」后置位，禁止任何自动重连 */
    @Volatile private var manualStop = false
    private var restartJob: Job? = null
    private var restartAttempts = 0

    // Android 14+（targetSdk 34+）约束：授权 token 从用户同意起仅 5 分钟有效，
    // 且一个 MediaProjection 实例只允许 createVirtualDisplay 一次。
    // 所以授权后立即启动编码器并长期持有唯一的 VirtualDisplay，
    // 只用 streaming 开关决定是否把帧推给协助者，绝不重建采集。
    @Volatile private var streaming = false
    @Volatile private var codecConfig: ByteArray? = null
    private var streamWidth = 0
    private var streamHeight = 0
    private var streamDensity = 0.0

    override fun onCreate() {
        super.onCreate()
        tokens = TokenStore(this)
        unattended = UnattendedConfig(this)
        RemoteHostApp.ensureChannel(this)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                // 重新开始时清掉上一次的失败态，否则新会话会被固定错误覆盖
                terminalError = null
                manualStop = false
                cancelRestart()
                restartAttempts = 0
                // 无人值守开关在启动瞬间做快照：运行中改配置不会影响当前会话
                // 设备号+密码直连始终启用；此标志只控制「是否自动同意授权」
                unattendedActive = unattended.enabled && unattended.isUsable()
                val url = intent.getStringExtra(EXTRA_SERVER_URL).orEmpty()
                val data = IntentCompat.getParcelableExtra(
                    intent, EXTRA_PROJECTION_DATA, Intent::class.java
                )
                if (url.isBlank() || data == null) {
                    terminalError = "服务器地址或投屏授权缺失，请重新开始协助"
                    setState(Phase.ERROR, null, terminalError, false)
                    stopSelf()
                    return START_NOT_STICKY
                }
                // 重复点击「开始协助」时先彻底清理旧会话，避免残留 WS / 编码器 / 旧授权
                if (relay != null || sessionId != null || projection != null || encoder != null) {
                    stopAll("重新开始协助")
                }
                serverUrl = url
                ServiceCompat.startForeground(
                    this, NOTIFICATION_ID, buildNotification(),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
                )
                // 必须在拿到授权后立即消费 token 并创建 VirtualDisplay：
                // 不能等协助者输入配对码（5 分钟后会超时），也不能等到 peer_joined 才创建。
                if (!prepareCapture(data)) return START_NOT_STICKY
                startSession()
            }
            ACTION_STOP -> {
                // 「随时断开」常驻通知 Action：人工急停，必须能压过无人值守的自动重连
                terminalError = null
                manualStop = true
                unattendedActive = false
                cancelRestart()
                stopAll("用户已结束协助")
                stopSelf()
            }
            ACTION_AUTHORIZE_GRANT -> grantAssistance()
            ACTION_AUTHORIZE_DENY -> denyAssistance()
            ACTION_SYNC_TEMP -> syncTemporaryPassword()
            ACTION_RESET_PASSWORD -> {
                val old = intent.getStringExtra(EXTRA_OLD_PASSWORD).orEmpty()
                val newPwd = intent.getStringExtra(EXTRA_NEW_PASSWORD).orEmpty()
                if (old.length == 6 && newPwd.length == 6) resetPasswordOnServer(old, newPwd)
            }
        }
        return START_NOT_STICKY
    }

    /** 把临时密码设置/清除同步到服务端（需已有 host token） */
    private fun syncTemporaryPassword() {
        val token = tokens.accessToken ?: return // 服务未建会话，下次建会话时会同步
        val api = api ?: return
        scope.launch {
            runCatching {
                api.setTemporaryPassword(
                    unattended.deviceId,
                    unattended.permanentPassword,
                    unattended.activeTemporaryPassword(),
                    unattended.temporaryExpiresAt,
                    token
                )
            }
        }
    }

    /** 重置长期密码：用旧密码调用服务端更新摘要，并在本地确认 */
    private fun resetPasswordOnServer(old: String, newPwd: String) {
        val token = tokens.accessToken ?: return
        val api = api ?: return
        scope.launch {
            runCatching {
                api.resetPassword(unattended.deviceId, old, newPwd, token)
            }
        }
    }

    private fun startSession() {
        setState(Phase.CONNECTING, null, "正在连接中继服务器…", false)
        scope.launch {
            try {
                // 总等待上限：中继不可达时也必须给出明确反馈，不能一直停在「正在连接」
                val created = withTimeout(CONNECT_TIMEOUT_MS) {
                    val client = ApiClient(serverUrl)
                    api = client
                    // 携带设备号 + 6 位密码，首次自动注册；服务端不再签发配对码
                    client.createSession(buildDeviceInfo(), unattended.credentials())
                }
                if (manualStop) return@launch
                val sid = created.getString("sessionId")
                sessionId = sid
                // 新会话一律以「未授权」开始；无人值守下由 authorize_request 自动放行
                SessionGate.begin(sid)
                tokens.save(
                    created.getString("accessToken"),
                    created.getString("refreshToken"),
                    sid
                )
                restartAttempts = 0
                setState(
                    Phase.WAITING, null,
                    "在线：等待控制端用设备号 ${com.pcxx.remote.host.config.DeviceIdentity.format(unattended.deviceId)} 直连",
                    false
                )
                val accessToken = created.getString("accessToken")
                // 若有临时密码，建会话后立即同步到服务端
                unattended.activeTemporaryPassword()?.let { temp ->
                    runCatching {
                        api!!.setTemporaryPassword(
                            unattended.deviceId,
                            unattended.permanentPassword,
                            temp,
                            unattended.temporaryExpiresAt,
                            accessToken
                        )
                    }
                }
                connectRelay(accessToken)
            } catch (e: Exception) {
                handleSessionFailure(describeConnectionError(e))
            }
        }
    }

    private fun connectRelay(accessToken: String) {
        val client = RelayClient(serverUrl, object : RelayClient.Listener {
            override fun onStateChanged(state: RelayClient.State) {
                when (state) {
                    RelayClient.State.CONNECTED ->
                        setState(
                            current.phase, current.pairingCode,
                            if (unattendedActive) "已连接，等待控制端直连" else "已连接，等待协助者",
                            current.peerOnline
                        )
                    RelayClient.State.RECONNECTING ->
                        setState(current.phase, current.pairingCode, "连接中断，正在重连…", false)
                    else -> Unit
                }
            }

            override fun onTextMessage(envelope: JSONObject) = handleText(envelope)

            override fun onBinaryMessage(frame: ByteArray) {
                // 受控端不接收视频帧，服务端也会拒绝 controller 的二进制帧
            }

            override fun onClosed(code: Int, reason: String) {
                if (code != 1000 && code != 4001) {
                    setState(current.phase, current.pairingCode, "连接断开：$reason", false)
                }
            }

            /** 首次连接连续失败、已放弃重连：无人值守下改为自动重建，普通模式明确报错 */
            override fun onConnectFailed(reason: String, attempts: Int) {
                handleSessionFailure(
                    "已重试 $attempts 次仍无法连接中继服务器：$reason\n" + describeRelayHint()
                )
            }

            override fun onAuthExpired() = refreshAndReconnect()
        })
        relay = client
        client.connect(accessToken)
    }

    /** 连接/建会话失败：普通模式报错停下；无人值守模式自动重建会话 */
    private fun handleSessionFailure(message: String) {
        if (unattendedActive && !manualStop && unattended.autoRestart) {
            scheduleRestart(message.substringBefore('\n'))
            return
        }
        failSession(message)
    }

    /** 连接/建会话失败：释放采集与前台状态，错误固定展示，用户可直接点「重试连接」 */
    private fun failSession(message: String) {
        terminalError = message
        stopAll(message)
    }

    /**
     * 只重建「会话层」（REST 建会话 + WebSocket），保留已拿到的 MediaProjection / 编码器。
     * 投屏 token 是一次性的，一旦释放就无法自动重建，因此这里绝不调用 stopAll()。
     */
    private fun scheduleRestart(reason: String) {
        cancelRestart()
        if (projection == null || encoder == null) {
            failSession(
                "屏幕采集已失效，无法自动恢复：$reason\n请人工重新点一次「开始协助」完成投屏授权"
            )
            return
        }
        val delayMs = min(RESTART_BASE_MS shl min(restartAttempts, 4), RESTART_MAX_MS)
        setState(
            Phase.WAITING, current.pairingCode,
            "无人值守：$reason；${delayMs / 1000}s 后自动重连（第 ${restartAttempts + 1} 次）",
            false
        )
        restartJob = scope.launch {
            delay(delayMs)
            if (manualStop || !unattendedActive) return@launch
            restartAttempts++
            streaming = false
            codecConfig = null
            SessionGate.end()
            dismissAuthorizationRequest()
            relay?.dispose()
            relay = null
            sessionId = null
            terminalError = null
            startSession()
        }
    }

    private fun cancelRestart() {
        restartJob?.cancel()
        restartJob = null
    }

    /** 底层异常 → 用户可读的中文报错：第一行结论，第二行排查指引 */
    private fun describeConnectionError(e: Exception): String = when (e) {
        is TimeoutCancellationException, is SocketTimeoutException ->
            "连接中继服务器超时，服务可能未启动或网络不通\n" + describeRelayHint()
        is UnknownHostException ->
            "找不到中继服务器（域名或 IP 无法解析）\n" + describeRelayHint()
        is ConnectException ->
            "无法连接中继服务器（连接被拒绝或超时）\n" + describeRelayHint()
        is SSLException ->
            "与中继服务器的加密连接失败，请检查 HTTPS 证书\n" + describeRelayHint()
        is ApiException -> when (e.status) {
            401, 403 -> "中继服务器拒绝本次连接（HTTP ${e.status}）\n" + describeRelayHint()
            in 500..599 -> "中继服务器暂时不可用（HTTP ${e.status}）\n" + describeRelayHint()
            else -> "连接中继服务器失败（HTTP ${e.status}）：${e.message}\n" + describeRelayHint()
        }
        is IllegalArgumentException -> "中继服务器地址不合法：${e.message}"
        else -> "连接中继服务器失败：${e.message ?: "网络不可用"}\n" + describeRelayHint()
    }

    private fun describeRelayHint(): String =
        "请检查：① 中继服务是否已启动；② 地址（含端口）是否填对；③ 手机网络与服务器安全组是否放行"

    private val current: HostState get() = state.value

    private fun handleText(envelope: JSONObject) {
        val type = envelope.optString("type")
        val payload = envelope.optJSONObject("payload") ?: JSONObject()
        when (type) {
            Protocol.Type.PING ->
                relay?.send(Protocol.envelope(Protocol.Type.PONG, JSONObject()))

            // v2：服务端在控制端入房后请求受控端确认，授权前既不推画面也不接受操作
            Protocol.Type.AUTHORIZE_REQUEST -> onAuthorizationRequest(payload)

            Protocol.Type.AUTHORIZE_STATE -> onAuthorizationState(payload)

            Protocol.Type.PEER_JOINED -> {
                if (SessionGate.active) {
                    // 同一控制端在宽限期内重连，授权仍然有效，直接恢复推流
                    startStreaming()
                } else {
                    setState(
                        Phase.AWAITING_AUTHORIZATION, current.pairingCode,
                        if (unattendedActive) "协助者已连接，正在自动授权…"
                        else "协助者已连接，请在通知中确认协助请求",
                        true
                    )
                }
            }

            Protocol.Type.PEER_LEFT -> {
                // 只停止推流，不停止编码器、不释放 VirtualDisplay。
                // 授权状态保留，等待同一控制端在宽限期内重连。
                streaming = false
                setState(Phase.WAITING, current.pairingCode, "协助者暂时断开，等待重连", false)
            }

            Protocol.Type.KEYFRAME_REQUEST -> encoder?.requestKeyframe()

            Protocol.Type.SESSION_CLOSED -> {
                val reason = "会话已关闭：${payload.optString("reason")}"
                if (unattendedActive && !manualStop) handleSessionFailure(reason)
                else stopAll(reason)
            }

            in CONTROL_TYPES -> inject(envelope)

            else -> Unit
        }
    }

    /**
     * 收到协助请求：先重置会话级授权门控。
     * 普通模式弹高优先级通知等待人工确认；无人值守模式校验会话一致后自动放行。
     * 无论哪种模式，开始推流仍以服务端 authorize_state 回执为准（见 onAuthorizationState）。
     */
    private fun onAuthorizationRequest(payload: JSONObject) {
        val requestedSession = payload.optString("sessionId", "").takeIf { it.isNotBlank() }
        // 无人值守下只放行属于当前会话的请求，避免旧会话/串会话消息触发自动授权。
        // 服务端本身按房间隔离，未带 sessionId 时按当前会话处理，保持向后兼容。
        if (unattendedActive && requestedSession != null && requestedSession != sessionId) {
            OperationAudit.record(
                this, Protocol.Type.AUTHORIZE_REQUEST, 0L, false,
                "unattended.rejected_session_mismatch"
            )
            return
        }
        val controller = payload.optJSONObject("controller")
        val model = controller?.optString("model").orEmpty().ifBlank { "协助设备" }
        val os = controller?.optString("osVersion").orEmpty().ifBlank { "未知系统" }
        pendingControllerLabel = "$model · $os"
        SessionGate.begin(sessionId)
        streaming = false
        OperationAudit.record(
            this, Protocol.Type.AUTHORIZE_REQUEST, 0L, true, pendingControllerLabel
        )
        if (unattendedActive && !manualStop) {
            // 服务端已用 deviceId+secret 校验过控制端身份，这里不再要求本机人工点击
            setState(
                Phase.AWAITING_AUTHORIZATION, current.pairingCode,
                "无人值守：已自动同意 $pendingControllerLabel", true
            )
            grantAssistance(auto = true)
        } else {
            setState(
                Phase.AWAITING_AUTHORIZATION, current.pairingCode,
                "协助者 $pendingControllerLabel 请求协助，请在通知中确认", true
            )
            showAuthorizationRequest()
        }
    }

    /** 以服务端回执为准：只有服务端确认授权后才开始推流 */
    private fun onAuthorizationState(payload: JSONObject) {
        if (payload.optBoolean("authorized", false)) {
            if (SessionGate.active) {
                dismissAuthorizationRequest()
                startStreaming()
            }
        } else {
            streaming = false
            setState(
                Phase.AWAITING_AUTHORIZATION, current.pairingCode,
                "等待对方确认协助请求…", true
            )
        }
    }

    /** 用户/无人值守逻辑同意协助；auto 只影响审计标注与状态文案，不改变协议行为 */
    private fun grantAssistance(auto: Boolean = false) {
        if (sessionId == null || relay == null) return
        if (!SessionGate.grant()) return
        OperationAudit.record(
            this, Protocol.Type.AUTHORIZE_GRANT, 0L, true,
            if (auto) "unattended.auto_grant · $pendingControllerLabel" else pendingControllerLabel
        )
        relay?.send(Protocol.envelope(Protocol.Type.AUTHORIZE_GRANT, JSONObject()))
        dismissAuthorizationRequest()
        setState(
            Phase.WAITING, current.pairingCode,
            if (auto) "无人值守：已自动同意，正在建立连接…" else "已同意协助，正在建立连接…",
            true
        )
        updateNotification()
    }

    /** 用户在通知里点「拒绝」：告知服务端并立即结束会话 */
    private fun denyAssistance() {
        OperationAudit.record(
            this, Protocol.Type.AUTHORIZE_DENY, 0L, true, pendingControllerLabel
        )
        relay?.send(
            Protocol.envelope(
                Protocol.Type.AUTHORIZE_DENY,
                JSONObject().put("reason", "受控端拒绝了本次协助")
            )
        )
        dismissAuthorizationRequest()
        stopAll("已拒绝协助请求")
        stopSelf()
    }

    /** 所有注入操作都要过会话级门控，并留下本地审计记录（不含文本内容） */
    private fun inject(envelope: JSONObject) {
        val seq = envelope.optLong("seq")
        val type = envelope.optString("type")
        if (!SessionGate.active) {
            OperationAudit.record(this, type, seq, false, "无已授权协助会话")
            relay?.send(Protocol.ack(seq, false, "当前没有已授权的协助会话"))
            return
        }
        RemoteAccessibilityService.dispatch(envelope) { ok, error ->
            OperationAudit.record(this, type, seq, ok, error)
            relay?.send(Protocol.ack(seq, ok, error))
        }
    }

    /**
     * 拿到授权 Intent 后立刻消费：一次 getMediaProjection + 一次 createVirtualDisplay。
     * 授权 Intent 不落盘、不缓存，之后任何重启采集都必须重新向用户申请授权。
     */
    private fun prepareCapture(data: Intent): Boolean = try {
        val manager = getSystemService(MediaProjectionManager::class.java)
        val mediaProjection = manager.getMediaProjection(Activity.RESULT_OK, data)
            ?: throw IllegalStateException("系统未返回 MediaProjection")

        // Android 14（targetSdk 34+）要求在 createVirtualDisplay 之前注册回调，
        // 系统撤销授权时通过 onStop 通知，不能假设会话一直有效。
        val callback = object : MediaProjection.Callback() {
            override fun onStop() {
                if (projection !== mediaProjection) return
                streaming = false
                codecConfig = null
                runCatching { encoder?.stop() }
                encoder = null
                projection = null
                projectionCallback = null
                runCatching { relay?.send(Protocol.envelope(Protocol.Type.STREAM_STOP, JSONObject())) }
                setState(
                    Phase.ERROR, current.pairingCode,
                    if (unattendedActive) {
                        "投屏授权被系统回收（锁屏、进程被杀或用户手动停止）。采集 token 无法自动重建，需人工再点一次「开始协助」"
                    } else {
                        "投屏授权已被系统停止，请点击「开始协助」重新授权"
                    },
                    false
                )
            }
        }
        mediaProjection.registerCallback(callback, Handler(Looper.getMainLooper()))
        projectionCallback = callback
        projection = mediaProjection

        val metrics = resources.displayMetrics
        val scale = min(1f, MAX_LONG_EDGE.toFloat() / max(metrics.widthPixels, metrics.heightPixels))
        val width = (metrics.widthPixels * scale).toInt() / 2 * 2
        val height = (metrics.heightPixels * scale).toInt() / 2 * 2
        streamWidth = width
        streamHeight = height
        streamDensity = metrics.density.toDouble()

        val screenEncoder = ScreenEncoder(
            mediaProjection, width, height, metrics.densityDpi,
            onFrame = { frameType, nalu ->
                // SPS/PPS 始终缓存，供协助者重连后作为首帧重发
                if (frameType == Protocol.FRAME_CONFIG) {
                    val firstConfig = codecConfig == null
                    codecConfig = nalu
                    if (streaming) {
                        sendFrame(frameType, nalu)
                        // 若协助者已在线但配置帧晚到，补一个关键帧让解码器立刻出画
                        if (firstConfig) encoder?.requestKeyframe()
                    }
                } else if (streaming) {
                    sendFrame(frameType, nalu)
                }
            },
            onError = { message -> setState(Phase.ERROR, current.pairingCode, message, false) }
        )
        encoder = screenEncoder
        screenEncoder.start()
        true
    } catch (e: Exception) {
        // 失败时把已创建的编码器 / 授权一并释放，避免残留 MediaCodec 与系统投屏指示
        runCatching { encoder?.stop() }
        encoder = null
        projectionCallback?.let { cb -> runCatching { projection?.unregisterCallback(cb) } }
        projectionCallback = null
        runCatching { projection?.stop() }
        projection = null
        failSession(describeCaptureError(e))
        false
    }

    /** 协助者上线或重连：复用已有采集，只重新下发解码参数与关键帧 */
    private fun startStreaming() {
        val activeEncoder = encoder
        if (activeEncoder == null) {
            setState(
                Phase.ERROR, current.pairingCode,
                "屏幕采集未就绪，请点击「开始协助」重新授权", false
            )
            return
        }
        streaming = true
        codecConfig?.let { sendFrame(Protocol.FRAME_CONFIG, it) }
        relay?.send(
            Protocol.envelope(
                Protocol.Type.STREAM_CONFIG,
                JSONObject()
                    .put("width", streamWidth)
                    .put("height", streamHeight)
                    .put("density", streamDensity)
                    .put("rotation", 0)
                    .put("codec", "h264")
                    .put("mime", "video/avc")
            )
        )
        relay?.send(Protocol.envelope(Protocol.Type.STREAM_START, JSONObject()))
        activeEncoder.requestKeyframe()
        setState(Phase.STREAMING, current.pairingCode, "正在共享屏幕", true)
    }

    private fun sendFrame(frameType: Int, nalu: ByteArray) {
        relay?.send(Protocol.buildFrame(frameType, SystemClock.uptimeMillis(), nalu))
    }

    private fun describeCaptureError(e: Exception): String {
        val raw = e.message.orEmpty()
        val reusedOrExpired = raw.contains("re-use the resultData", ignoreCase = true) ||
            raw.contains("timed out", ignoreCase = true) ||
            raw.contains("multiple captures", ignoreCase = true)
        return if (reusedOrExpired) {
            "投屏授权已失效（Android 14+ 一次授权只能采集一次，且授权后 5 分钟内必须使用）。请点击「开始协助」重新授权"
        } else {
            "启动屏幕采集失败：$raw"
        }
    }

    private fun refreshAndReconnect() {
        val refresh = tokens.refreshToken ?: run {
            handleSessionFailure("登录已过期，无法连接中继服务器，正在重建会话")
            return
        }
        scope.launch {
            try {
                val result = api?.refresh(refresh)
                    ?: throw IllegalStateException("API 未初始化")
                val access = result.getString("accessToken")
                tokens.updateTokens(access, result.getString("refreshToken"))
                relay?.refreshToken(access)
            } catch (e: Exception) {
                handleSessionFailure(
                    "无法刷新登录凭证，连接中继服务器失败：${e.message}\n" + describeRelayHint()
                )
            }
        }
    }

    private fun buildDeviceInfo(): JSONObject {
        val metrics = resources.displayMetrics
        return JSONObject()
            .put("model", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
            .put("osVersion", "Android ${Build.VERSION.RELEASE}")
            .put("appVersion", "1.0.0")
            .put(
                "screen", JSONObject()
                    .put("width", metrics.widthPixels)
                    .put("height", metrics.heightPixels)
                    .put("density", metrics.density.toDouble())
                    .put("rotation", 0)
            )
    }

    /** 常驻通知：会话进行中始终提供「随时断开」，不依赖用户回到 App 界面 */
    private fun buildNotification(): android.app.Notification {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, RemoteHostApp.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_remote)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(getString(R.string.notification_text))
            .setContentIntent(pending)
            .setOngoing(true)
            .setCategory(android.app.Notification.CATEGORY_SERVICE)
            .addAction(
                R.drawable.ic_stat_remote,
                getString(R.string.action_stop),
                servicePendingIntent(ACTION_STOP, 1)
            )
            .build()
    }

    /** 授权请求使用独立 HIGH 渠道，确保被协助者能即时看到并做出选择 */
    private fun showAuthorizationRequest() {
        RemoteHostApp.ensureChannel(this)
        val text = getString(R.string.auth_request_text, pendingControllerLabel)
        val notification = NotificationCompat.Builder(this, RemoteHostApp.CHANNEL_AUTH_ID)
            .setSmallIcon(R.drawable.ic_stat_remote)
            .setContentTitle(getString(R.string.auth_request_title))
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(android.app.Notification.CATEGORY_SERVICE)
            .setOngoing(true)
            .addAction(
                R.drawable.ic_stat_remote,
                getString(R.string.action_allow),
                servicePendingIntent(ACTION_AUTHORIZE_GRANT, 2)
            )
            .addAction(
                R.drawable.ic_stat_remote,
                getString(R.string.action_deny),
                servicePendingIntent(ACTION_AUTHORIZE_DENY, 3)
            )
            .build()
        getSystemService(NotificationManager::class.java)
            .notify(AUTH_NOTIFICATION_ID, notification)
    }

    private fun dismissAuthorizationRequest() {
        getSystemService(NotificationManager::class.java).cancel(AUTH_NOTIFICATION_ID)
    }

    private fun servicePendingIntent(action: String, requestCode: Int): PendingIntent {
        val intent = Intent(this, HostForegroundService::class.java).setAction(action)
        return PendingIntent.getService(
            this, requestCode, intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
    }

    private fun updateNotification() {
        getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, buildNotification())
    }

    private fun stopAll(reason: String) {
        // stopAll 代表本次采集彻底结束，任何待执行的自动重连都必须撤销
        cancelRestart()
        streaming = false
        // 会话结束即撤销注入能力：无障碍服务虽仍开启，但不再接受任何指令
        SessionGate.end()
        dismissAuthorizationRequest()
        codecConfig = null
        encoder?.stop()
        encoder = null
        relay?.dispose()
        relay = null
        // 先注销回调再 stop，避免 onStop 重入重复清理
        projectionCallback?.let { cb -> runCatching { projection?.unregisterCallback(cb) } }
        projectionCallback = null
        runCatching { projection?.stop() }
        projection = null

        val sid = sessionId
        val access = tokens.accessToken
        // 捕获局部引用：紧接着重新开始时 api 会被新会话覆盖
        val client = api
        sessionId = null
        api = null
        tokens.clear()
        if (sid != null && access != null && client != null) {
            scope.launch { runCatching { client.closeSession(sid, access) } }
        }
        // 连接失败时错误要固定展示：onDestroy 再次调用 stopAll 也不覆盖
        val heldError = terminalError
        setState(
            if (heldError != null) Phase.ERROR else Phase.CLOSED,
            null,
            heldError ?: reason,
            false
        )
        stopForeground(STOP_FOREGROUND_REMOVE)
    }

    private fun setState(phase: Phase, code: String?, message: String?, peerOnline: Boolean) {
        publish(HostState(phase, code, message, peerOnline))
    }

    override fun onDestroy() {
        cancelRestart()
        stopAll("服务已停止")
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        const val ACTION_START = "com.pcxx.remote.host.START"
        const val ACTION_STOP = "com.pcxx.remote.host.STOP"
        const val ACTION_AUTHORIZE_GRANT = "com.pcxx.remote.host.AUTHORIZE_GRANT"
        const val ACTION_AUTHORIZE_DENY = "com.pcxx.remote.host.AUTHORIZE_DENY"
        const val ACTION_SYNC_TEMP = "com.pcxx.remote.host.SYNC_TEMP"
        const val ACTION_RESET_PASSWORD = "com.pcxx.remote.host.RESET_PASSWORD"
        const val EXTRA_SERVER_URL = "server_url"
        const val EXTRA_PROJECTION_DATA = "projection_data"
        const val EXTRA_OLD_PASSWORD = "old_password"
        const val EXTRA_NEW_PASSWORD = "new_password"

        private const val NOTIFICATION_ID = 1001
        private const val AUTH_NOTIFICATION_ID = 1002
        private const val MAX_LONG_EDGE = 1280

        private val CONTROL_TYPES = setOf(
            Protocol.Type.TAP, Protocol.Type.LONG_PRESS, Protocol.Type.SWIPE,
            Protocol.Type.SCROLL, Protocol.Type.KEY, Protocol.Type.TEXT,
            Protocol.Type.HOME, Protocol.Type.BACK, Protocol.Type.RECENTS
        )

        private val _state = MutableStateFlow(HostState())
        val state: StateFlow<HostState> = _state

        fun publish(value: HostState) {
            _state.value = value
        }
    }
}
