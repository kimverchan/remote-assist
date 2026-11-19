package com.pcxx.remote.controller.input

import android.annotation.SuppressLint
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import com.pcxx.remote.controller.protocol.Protocol
import org.json.JSONObject
import kotlin.math.sqrt

/**
 * 把本地触摸换算成归一化 0..1 坐标的远程指令。
 * 短按 → tap，静止长按 → long_press，有位移 → swipe。
 */
class TouchMapper(
    private val send: (type: String, payload: JSONObject) -> Unit
) : View.OnTouchListener {

    private var startX = 0f
    private var startY = 0f
    private var startTime = 0L
    private var maxMove = 0f

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouch(view: View, event: MotionEvent): Boolean {
        val width = view.width.toFloat().coerceAtLeast(1f)
        val height = view.height.toFloat().coerceAtLeast(1f)
        val nx = { x: Float -> (x / width).coerceIn(0f, 1f).toDouble() }
        val ny = { y: Float -> (y / height).coerceIn(0f, 1f).toDouble() }

        return when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                startX = event.x
                startY = event.y
                startTime = SystemClock.uptimeMillis()
                maxMove = 0f
                true
            }

            MotionEvent.ACTION_MOVE -> {
                val dx = event.x - startX
                val dy = event.y - startY
                maxMove = maxOf(maxMove, sqrt(dx * dx + dy * dy))
                true
            }

            MotionEvent.ACTION_UP -> {
                val duration = SystemClock.uptimeMillis() - startTime
                when {
                    maxMove < MOVE_THRESHOLD && duration < TAP_MAX_MS -> send(
                        Protocol.Type.TAP,
                        JSONObject().put("x", nx(event.x)).put("y", ny(event.y))
                    )

                    maxMove < MOVE_THRESHOLD && duration >= LONG_PRESS_MS -> send(
                        Protocol.Type.LONG_PRESS,
                        JSONObject()
                            .put("x", nx(event.x)).put("y", ny(event.y))
                            .put("durationMs", duration.coerceAtMost(2000L))
                    )

                    else -> send(
                        Protocol.Type.SWIPE,
                        JSONObject()
                            .put("x1", nx(startX)).put("y1", ny(startY))
                            .put("x2", nx(event.x)).put("y2", ny(event.y))
                            .put("durationMs", duration.coerceIn(80L, 1200L))
                    )
                }
                true
            }

            MotionEvent.ACTION_CANCEL -> true
            else -> false
        }
    }

    private companion object {
        const val MOVE_THRESHOLD = 12f
        const val TAP_MAX_MS = 300L
        const val LONG_PRESS_MS = 500L
    }
}
