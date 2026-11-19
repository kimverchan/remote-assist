package com.pcxx.remote.host.inject

/**
 * 无障碍能力的会话级门控。
 *
 * 「用户在系统设置里开启无障碍服务」不等于「允许远程注入」。只有在本会话内
 * 由被协助者显式点「允许协助」后，authorized 才为 true；会话结束、被拒绝、
 * 或新的协助请求到达时立即失效。这是防止无障碍权限被长期滥用的最后一道本地防线。
 */
object SessionGate {
    @Volatile private var activeSessionId: String? = null
    @Volatile private var granted = false

    val active: Boolean
        get() = granted && activeSessionId != null

    /** 开始（或重新）一次协助会话：先置为未授权，等待用户在通知里确认 */
    fun begin(sessionId: String?) {
        activeSessionId = sessionId
        granted = false
    }

    /** 被协助者点「允许」；只在存在活动会话时生效 */
    fun grant(): Boolean {
        if (activeSessionId == null) return false
        granted = true
        return true
    }

    fun end() {
        activeSessionId = null
        granted = false
    }
}
