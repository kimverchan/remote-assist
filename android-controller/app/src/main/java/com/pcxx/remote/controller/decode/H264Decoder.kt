package com.pcxx.remote.controller.decode

import android.media.MediaCodec
import android.media.MediaFormat
import android.os.Handler
import android.os.HandlerThread
import android.view.Surface
import com.pcxx.remote.controller.protocol.Protocol
import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicLong

/**
 * H.264 异步解码到 TextureView 的 Surface。
 * config 帧（SPS/PPS）缓存后拼在每个关键帧前，保证首帧与旋转后能立即解码。
 */
class H264Decoder(
    private val surface: Surface,
    private val onSizeChanged: (Int, Int) -> Unit,
    private val onError: (String) -> Unit
) {
    private var codec: MediaCodec? = null
    private var worker: HandlerThread? = null
    private val pending = ArrayDeque<ByteArray>()
    private val inputs = ArrayDeque<Int>()
    private val lock = Any()
    private val pts = AtomicLong(0)
    @Volatile private var running = false
    @Volatile private var codecConfig: ByteArray? = null

    fun start() {
        val thread = HandlerThread("h264-decode").also { it.start() }
        worker = thread
        val handler = Handler(thread.looper)
        val format = MediaFormat.createVideoFormat(MIME, 1080, 1920).apply {
            setInteger(MediaFormat.KEY_FRAME_RATE, 30)
        }
        val decoder = MediaCodec.createDecoderByType(MIME)
        decoder.setCallback(object : MediaCodec.Callback() {
            override fun onInputBufferAvailable(c: MediaCodec, index: Int) {
                synchronized(lock) { inputs.addLast(index) }
                pump(c)
            }

            override fun onOutputBufferAvailable(c: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
                try {
                    c.releaseOutputBuffer(index, true)
                } catch (e: Exception) {
                    onError("渲染解码帧失败：${e.message}")
                }
            }

            override fun onError(c: MediaCodec, e: MediaCodec.CodecException) {
                onError("H.264 解码器异常：${e.message}")
            }

            override fun onOutputFormatChanged(c: MediaCodec, format: MediaFormat) {
                val width = runCatching { format.getInteger(MediaFormat.KEY_WIDTH) }.getOrDefault(0)
                val height = runCatching { format.getInteger(MediaFormat.KEY_HEIGHT) }.getOrDefault(0)
                if (width > 0 && height > 0) onSizeChanged(width, height)
            }
        }, handler)
        decoder.configure(format, surface, null, 0)
        decoder.start()
        codec = decoder
        running = true
    }

    fun submit(frame: Protocol.Frame) {
        if (!running) return
        if (frame.type == Protocol.FRAME_CONFIG) {
            synchronized(lock) { codecConfig = frame.payload }
            return
        }
        val config = synchronized(lock) { codecConfig }
        val isKey = frame.type == Protocol.FRAME_KEYFRAME
        val data = if (isKey && config != null && config.isNotEmpty()) {
            config!! + frame.payload
        } else {
            frame.payload
        }
        val decoder = codec ?: return
        synchronized(lock) { pending.addLast(data) }
        pump(decoder)
    }

    private fun pump(decoder: MediaCodec) {
        synchronized(lock) {
            while (pending.isNotEmpty() && inputs.isNotEmpty()) {
                val data = pending.removeFirst()
                val index = inputs.removeFirst()
                try {
                    val buffer = decoder.getInputBuffer(index) ?: continue
                    if (data.size > buffer.capacity()) continue
                    buffer.clear()
                    buffer.put(data)
                    decoder.queueInputBuffer(index, 0, data.size, pts.addAndGet(33_333L), 0)
                } catch (e: Exception) {
                    onError("送入解码器失败：${e.message}")
                }
            }
        }
    }

    fun stop() {
        running = false
        runCatching { codec?.stop() }
        runCatching { codec?.release() }
        codec = null
        worker?.quitSafely()
        worker = null
        synchronized(lock) {
            pending.clear()
            inputs.clear()
        }
    }

    private companion object {
        const val MIME = "video/avc"
    }
}
