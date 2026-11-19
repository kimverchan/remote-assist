package com.pcxx.remote.controller.protocol

import org.json.JSONObject
import java.util.concurrent.atomic.AtomicLong

/**
 * 协议常量与帧编解码。与 docs/PROTOCOL.md v1、server/src/shared/protocol.ts 保持同步。
 */
object Protocol {
    const val VERSION = 2
    const val BINARY_MAGIC: Byte = 0xA5.toByte()
    const val BINARY_HEADER_SIZE = 12

    const val FRAME_CONFIG = 1
    const val FRAME_KEYFRAME = 2
    const val FRAME_DELTA = 3
    const val FRAME_PREVIEW = 4

    object Type {
        const val PING = "ping"
        const val PONG = "pong"
        const val SESSION_READY = "session.ready"
        const val PEER_JOINED = "session.peer_joined"
        const val PEER_LEFT = "session.peer_left"
        const val SESSION_CLOSED = "session.closed"
        const val SESSION_ERROR = "session.error"
        const val AUTHORIZE_REQUEST = "session.authorize_request"
        const val AUTHORIZE_GRANT = "session.authorize_grant"
        const val AUTHORIZE_DENY = "session.authorize_deny"
        const val AUTHORIZE_STATE = "session.authorize_state"
        const val STREAM_CONFIG = "stream.config"
        const val STREAM_START = "stream.start"
        const val STREAM_STOP = "stream.stop"
        const val KEYFRAME_REQUEST = "stream.keyframe_request"
        const val DEVICE_STATE = "device.state"
        const val ACK = "control.ack"
        const val TAP = "control.tap"
        const val LONG_PRESS = "control.long_press"
        const val SWIPE = "control.swipe"
        const val SCROLL = "control.scroll"
        const val KEY = "control.key"
        const val TEXT = "control.text"
        const val HOME = "control.home"
        const val BACK = "control.back"
        const val RECENTS = "control.recents"
    }

    private val sequence = AtomicLong(0)

    fun nextSeq(): Long = sequence.incrementAndGet()

    fun envelope(type: String, payload: JSONObject): String = JSONObject()
        .put("v", VERSION)
        .put("type", type)
        .put("ts", System.currentTimeMillis())
        .put("seq", nextSeq())
        .put("payload", payload)
        .toString()

    data class Frame(val type: Int, val timestampMs: Long, val payload: ByteArray)

    fun parseFrame(data: ByteArray): Frame? {
        if (data.size < BINARY_HEADER_SIZE) return null
        if (data[0] != BINARY_MAGIC || data[1].toInt() != VERSION) return null
        val type = data[2].toInt() and 0xFF
        if (type !in FRAME_CONFIG..FRAME_PREVIEW) return null
        var timestamp = 0L
        for (i in 0 until 8) {
            timestamp = (timestamp shl 8) or (data[4 + i].toLong() and 0xFFL)
        }
        return Frame(type, timestamp, data.copyOfRange(BINARY_HEADER_SIZE, data.size))
    }
}
