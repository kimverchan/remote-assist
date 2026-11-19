package com.pcxx.remote.host.inject

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.content.res.Resources
import android.graphics.Path
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import com.pcxx.remote.host.protocol.Protocol
import org.json.JSONObject
import kotlin.math.min

/**
 * 把归一化坐标的控制指令注入到本机。
 *
 * 重要限制：非 root / 非系统签名应用无法注入任意 KeyEvent。
 * 本实现只支持手势（dispatchGesture）、全局动作（HOME/BACK/RECENTS）
 * 与聚焦输入框文本（ACTION_SET_TEXT）；其余 keyCode 明确返回错误，不做虚假成功。
 */
class RemoteAccessibilityService : AccessibilityService() {

    override fun onServiceConnected() {
        instance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // 不消费事件内容，避免在服务端产生任何屏幕内容采集
    }

    override fun onInterrupt() {
        instance = null
    }

    override fun onUnbind(intent: Intent?): Boolean {
        instance = null
        return super.onUnbind(intent)
    }

    private val screenWidth: Int
        get() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getSystemService(WindowManager::class.java).currentWindowMetrics.bounds.width()
        } else {
            Resources.getSystem().displayMetrics.widthPixels
        }

    private val screenHeight: Int
        get() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getSystemService(WindowManager::class.java).currentWindowMetrics.bounds.height()
        } else {
            Resources.getSystem().displayMetrics.heightPixels
        }

    private fun px(payload: JSONObject, key: String): Float {
        val normalized = payload.optDouble(key, 0.0).toFloat().coerceIn(0f, 1f)
        return (normalized * screenWidth).coerceIn(1f, (screenWidth - 1).toFloat())
    }

    private fun py(payload: JSONObject, key: String): Float {
        val normalized = payload.optDouble(key, 0.0).toFloat().coerceIn(0f, 1f)
        return (normalized * screenHeight).coerceIn(1f, (screenHeight - 1).toFloat())
    }

    private fun handle(command: JSONObject, ack: (Boolean, String?) -> Unit) {
        val type = command.optString("type")
        val payload = command.optJSONObject("payload") ?: JSONObject()
        when (type) {
            Protocol.Type.TAP -> gesture(
                Path().apply { moveTo(px(payload, "x"), py(payload, "y")) },
                50L, ack
            )

            Protocol.Type.LONG_PRESS -> gesture(
                Path().apply { moveTo(px(payload, "x"), py(payload, "y")) },
                payload.optLong("durationMs", 600L), ack
            )

            Protocol.Type.SWIPE -> gesture(
                Path().apply {
                    moveTo(px(payload, "x1"), py(payload, "y1"))
                    lineTo(px(payload, "x2"), py(payload, "y2"))
                },
                payload.optLong("durationMs", 300L), ack
            )

            Protocol.Type.SCROLL -> {
                val x = px(payload, "x")
                val y = py(payload, "y")
                val dx = payload.optDouble("dx", 0.0).toFloat() * screenWidth
                val dy = payload.optDouble("dy", 0.0).toFloat() * screenHeight
                gesture(
                    Path().apply {
                        moveTo(x, y)
                        lineTo(
                            (x + dx).coerceIn(1f, screenWidth - 1f),
                            (y + dy).coerceIn(1f, screenHeight - 1f)
                        )
                    },
                    250L, ack
                )
            }

            Protocol.Type.HOME -> ack(performGlobalAction(GLOBAL_ACTION_HOME), null)
            Protocol.Type.BACK -> ack(performGlobalAction(GLOBAL_ACTION_BACK), null)
            Protocol.Type.RECENTS -> ack(performGlobalAction(GLOBAL_ACTION_RECENTS), null)

            Protocol.Type.KEY -> handleKey(payload.optInt("keyCode", -1), ack)

            Protocol.Type.TEXT -> {
                val text = payload.optString("text").take(512)
                if (text.isEmpty()) ack(false, "文本为空")
                else ack(setFocusedText(text), "未找到可编辑的聚焦输入框")
            }

            else -> ack(false, "不支持的指令类型：$type")
        }
    }

    private fun gesture(path: Path, durationMs: Long, ack: (Boolean, String?) -> Unit) {
        if (durationMs <= 0) {
            ack(false, "手势时长无效")
            return
        }
        val stroke = GestureDescription.StrokeDescription(path, 0L, min(durationMs, 60_000L))
        val description = GestureDescription.Builder().addStroke(stroke).build()
        val submitted = dispatchGesture(
            description,
            object : GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription?) = ack(true, null)
                override fun onCancelled(gestureDescription: GestureDescription?) =
                    ack(false, "手势被系统取消")
            },
            Handler(Looper.getMainLooper())
        )
        if (!submitted) ack(false, "系统拒绝提交手势")
    }

    private fun handleKey(keyCode: Int, ack: (Boolean, String?) -> Unit) {
        val action = when (keyCode) {
            KeyEvent.KEYCODE_HOME -> GLOBAL_ACTION_HOME
            KeyEvent.KEYCODE_BACK -> GLOBAL_ACTION_BACK
            KeyEvent.KEYCODE_APP_SWITCH -> GLOBAL_ACTION_RECENTS
            KeyEvent.KEYCODE_NOTIFICATION -> GLOBAL_ACTION_NOTIFICATIONS
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> {
                ack(false, "非 root 设备无法注入按键事件，请改用点击/文本指令")
                return
            }
            else -> {
                ack(false, "非 root 设备仅支持 HOME/BACK/RECENTS/通知栏，收到 keyCode=$keyCode")
                return
            }
        }
        ack(performGlobalAction(action), null)
    }

    private fun setFocusedText(text: String): Boolean {
        val root = rootInActiveWindow ?: return false
        val target = findEditable(root)
        if (target == null) {
            root.recycle()
            return false
        }
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        val ok = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        root.recycle()
        return ok
    }

    private fun findEditable(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        // 禁止向密码框写入文本，即便协助者误发也不执行
        if (node.isFocused && node.isEditable && !node.isPassword) return node
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            val found = findEditable(child)
            if (found != null) return found
            child.recycle()
        }
        return null
    }

    companion object {
        @Volatile
        private var instance: RemoteAccessibilityService? = null

        val isConnected: Boolean get() = instance != null

        fun dispatch(command: JSONObject, ack: (Boolean, String?) -> Unit) {
            // 会话级门控：即使服务已在系统设置里开启，未经本会话授权也不得注入
            if (!SessionGate.active) {
                ack(false, "当前没有已授权的协助会话，操作已拒绝")
                return
            }
            val service = instance
            if (service == null) {
                ack(false, "无障碍服务未开启，无法注入操作")
                return
            }
            service.handle(command, ack)
        }

    }
}
