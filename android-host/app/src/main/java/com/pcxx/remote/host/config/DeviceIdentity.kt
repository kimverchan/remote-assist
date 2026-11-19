package com.pcxx.remote.host.config

import android.content.Context
import android.provider.Settings
import java.security.MessageDigest
import java.util.Locale

/**
 * 设备身份：生成「向日葵风格」的 9 位设备号（显示为 3-3-3 分组）。
 *
 * 稳定性来源：ANDROID_ID（Settings.Secure.ANDROID_ID）。在「同一签名证书 + 同一用户 +
 * 同一台设备」下，卸载重装保持不变——这是普通（非系统签名）应用能拿到的最稳定的标识。
 *
 * 必须如实告知用户的边界：
 * - 恢复出厂设置、更换设备、或更换签名证书（如 debug ↔ release）都会导致设备号变化；
 * - 少数国产 ROM / 模拟器可能返回 null 或不稳定的 ANDROID_ID，此时回退到安装标识，
 *   回退值的稳定性弱于 ANDROID_ID；
 * - 普通应用无权读取序列号（Build.getSerial() 需要特权权限），无法做到真正的硬件绑定。
 */
object DeviceIdentity {

    private const val FALLBACK_PREFS = "device_identity"
    private const val KEY_FALLBACK_ID = "fallback_id"

    /** 返回 9 位纯数字设备号，例如 382 915 046（不含空格的原始值用于请求） */
    fun deviceId(context: Context): String {
        val androidId = runCatching {
            Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
        }.getOrNull()

        val seed = if (!androidId.isNullOrBlank() && !isKnownInvalid(androidId)) {
            androidId
        } else {
            fallbackId(context)
        }
        return toNineDigits(seed)
    }

    /** 展示格式：382 915 046 */
    fun format(deviceId: String): String = buildString {
        for (i in deviceId.indices) {
            if (i > 0 && i % 3 == 0) append(' ')
            append(deviceId[i])
        }
    }

    private fun isKnownInvalid(id: String): Boolean =
        id.equals("0000000000000000", true) ||
            id.equals("9774d56d682e549c", true) // 部分模拟器/已知占位值

    /** 极低概率 ANDROID_ID 不可用时，用安装标识回退并持久化，保证同一次安装内稳定 */
    private fun fallbackId(context: Context): String {
        val prefs = context.getSharedPreferences(FALLBACK_PREFS, Context.MODE_PRIVATE)
        val existing = prefs.getString(KEY_FALLBACK_ID, null)
        if (!existing.isNullOrBlank()) return existing
        val generated = java.util.UUID.randomUUID().toString()
        prefs.edit().putString(KEY_FALLBACK_ID, generated).apply()
        return generated
    }

    /** 取 SHA-256 前 8 字节转为十进制，取低 9 位，保证 9 位数字且分布均匀 */
    private fun toNineDigits(seed: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(seed.toByteArray(Charsets.UTF_8))
        var value = 0L
        for (i in 0 until 8) {
            value = (value shl 8) or (digest[i].toLong() and 0xFF)
        }
        if (value < 0) value = -value
        return String.format(Locale.US, "%09d", value % 1_000_000_000L)
    }
}
