package com.pcxx.remote.host.capture

import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.projection.MediaProjection
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import com.pcxx.remote.host.protocol.Protocol

/**
 * MediaProjection → MediaCodec(H.264) → 12 字节头二进制帧。
 * 使用异步 Callback 模式，避免轮询线程空转；编码器输出为 Annex-B NALU。
 */
class ScreenEncoder(
    private val projection: MediaProjection,
    private val width: Int,
    private val height: Int,
    private val densityDpi: Int,
    private val onFrame: (frameType: Int, nalu: ByteArray) -> Unit,
    private val onError: (String) -> Unit
) {
    private var codec: MediaCodec? = null
    private var display: VirtualDisplay? = null
    private var thread: HandlerThread? = null
    @Volatile private var running = false
    private var configSent = false

    fun start() {
        check(!running) { "编码器已在运行" }
        val format = MediaFormat.createVideoFormat(MIME, width, height).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, BIT_RATE)
            setInteger(MediaFormat.KEY_FRAME_RATE, FRAME_RATE)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
            setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR)
        }

        val encoder = MediaCodec.createEncoderByType(MIME)
        encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        val surface = encoder.createInputSurface()

        val worker = HandlerThread("h264-encode").also { it.start() }
        thread = worker
        encoder.setCallback(object : MediaCodec.Callback() {
            override fun onInputBufferAvailable(codec: MediaCodec, index: Int) {
                // Surface 输入模式由系统填充，无需手动排队输入缓冲
            }

            override fun onOutputBufferAvailable(
                codec: MediaCodec,
                index: Int,
                info: MediaCodec.BufferInfo
            ) = emit(codec, index, info)

            override fun onError(codec: MediaCodec, e: MediaCodec.CodecException) {
                onError("H.264 编码器异常：${e.message}")
            }

            override fun onOutputFormatChanged(codec: MediaCodec, format: MediaFormat) {
                emitCodecConfig(format)
            }
        }, Handler(worker.looper))

        codec = encoder
        running = true
        configSent = false
        display = projection.createVirtualDisplay(
            "RemoteAssist",
            width, height, densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            surface, null, Handler(worker.looper)
        )
        encoder.start()
    }

    /** 收到 stream.config 中的 SPS/PPS，必须作为首帧发给解码端 */
    private fun emitCodecConfig(format: MediaFormat) {
        if (!running || configSent) return
        val sps = format.getByteBuffer("csd-0") ?: return
        val pps = format.getByteBuffer("csd-1") ?: return
        val spsBytes = ByteArray(sps.remaining())
        sps.get(spsBytes)
        val ppsBytes = ByteArray(pps.remaining())
        pps.get(ppsBytes)
        configSent = true
        onFrame(Protocol.FRAME_CONFIG, spsBytes + ppsBytes)
    }

    private fun emit(encoder: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
        if (!running) return
        try {
            if (info.size > 0) {
                val buffer = encoder.getOutputBuffer(index)
                if (buffer != null) {
                    val data = ByteArray(info.size)
                    buffer.position(info.offset)
                    buffer.limit(info.offset + info.size)
                    buffer.get(data)
                    val isConfig = (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0
                    val isKey = (info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0
                    when {
                        isConfig -> {
                            configSent = true
                            onFrame(Protocol.FRAME_CONFIG, data)
                        }
                        else -> onFrame(
                            if (isKey) Protocol.FRAME_KEYFRAME else Protocol.FRAME_DELTA,
                            data
                        )
                    }
                }
            }
            encoder.releaseOutputBuffer(index, false)
        } catch (e: Exception) {
            onError("读取编码帧失败：${e.message}")
        }
    }

    /** 控制端请求关键帧（首连、切后台恢复、丢帧后） */
    fun requestKeyframe() {
        runCatching {
            codec?.setParameters(Bundle().apply {
                putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0)
            })
        }
    }

    fun stop() {
        running = false
        runCatching { display?.release() }
        runCatching { codec?.stop() }
        runCatching { codec?.release() }
        thread?.quitSafely()
        display = null
        codec = null
        thread = null
    }

    private companion object {
        const val MIME = "video/avc"
        const val BIT_RATE = 2_000_000
        const val FRAME_RATE = 30
    }
}
