package com.pcxx.remote.host.audit

import android.content.Context
import java.io.File
import java.time.Instant

/**
 * 本地操作留痕：只记录指令类型、序号、结果与简短原因，
 * 绝不记录文本内容、坐标、屏幕画面或任何个人信息。
 * 文件写入应用私有目录，不上传、不写入外部存储，卸载 App 即删除。
 */
object OperationAudit {
    private const val FILE_NAME = "remote-assist-audit.log"

    fun record(
        context: Context,
        type: String,
        seq: Long,
        ok: Boolean,
        detail: String? = null
    ) {
        runCatching {
            val line = buildString {
                append(Instant.now().toString())
                append(" | type=").append(type)
                append(" | seq=").append(seq)
                append(" | ok=").append(ok)
                if (!detail.isNullOrBlank()) {
                    append(" | detail=").append(detail.replace('\n', ' ').take(120))
                }
                append('\n')
            }
            File(context.filesDir, FILE_NAME).appendText(line)
        }
    }

    fun logFile(context: Context): File = File(context.filesDir, FILE_NAME)
}
