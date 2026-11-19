package com.pcxx.remote.host.config

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONObject
import java.security.SecureRandom

/**
 * 设备身份与密码配置（等价于「向日葵风格」：设备号 + 6 位数字密码）。
 *
 * - deviceId：首次启动由 DeviceIdentity 自动生成（ANDROID_ID 派生，重装稳定），不可手填；
 * - 长期密码：6 位纯数字，首次自动生成，用户可随机重置；
 * - 临时密码：可选，6 位纯数字，带到期时间，到期自动失效，长期密码始终可用；
 * - 凭据只存加密 SharedPreferences，不进日志 / 审计 / URL；服务端只收到摘要。
 *
 * 系统侧限制：MediaProjection 授权弹窗与无障碍开关仍需一次性人工启用，
 * 之后只要投屏 token 未被系统回收即可长期免点击。
 */
class UnattendedConfig(context: Context) {

    private val prefs: SharedPreferences

    init {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        prefs = EncryptedSharedPreferences.create(
            context,
            FILE_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
        // 首次启动自动生成设备号与长期密码（直接读 prefs，避免属性初始化顺序问题）
        if (prefs.getString(KEY_DEVICE_ID, "").orEmpty().isBlank()) {
            prefs.edit().putString(KEY_DEVICE_ID, DeviceIdentity.deviceId(context)).apply()
        }
        if (prefs.getString(KEY_PASSWORD, "").orEmpty().isBlank()) {
            prefs.edit().putString(KEY_PASSWORD, randomSixDigits()).apply()
        }
    }

    var enabled: Boolean
        get() = prefs.getBoolean(KEY_ENABLED, true) // 默认开启
        set(value) = prefs.edit().putBoolean(KEY_ENABLED, value).apply()

    var autoRestart: Boolean
        get() = prefs.getBoolean(KEY_AUTO_RESTART, true)
        set(value) = prefs.edit().putBoolean(KEY_AUTO_RESTART, value).apply()

    var deviceId: String
        get() = prefs.getString(KEY_DEVICE_ID, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_DEVICE_ID, value.trim()).apply()

    /** 长期密码（6 位数字） */
    var permanentPassword: String
        get() = prefs.getString(KEY_PASSWORD, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_PASSWORD, value).apply()

    /** 临时密码（6 位数字），空 = 未启用 */
    var temporaryPassword: String
        get() = prefs.getString(KEY_TEMP_PASSWORD, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_TEMP_PASSWORD, value).apply()

    /** 临时密码到期时间戳（ms），0 = 未启用 */
    var temporaryExpiresAt: Long
        get() = prefs.getLong(KEY_TEMP_EXPIRES, 0L)
        set(value) = prefs.edit().putLong(KEY_TEMP_EXPIRES, value).apply()

    /** 凭据完整即可用；enabled 只控制「是否自动同意授权」，不影响设备号+密码直连本身 */
    fun isUsable(): Boolean =
        deviceId.length == 9 && permanentPassword.length == 6 &&
            permanentPassword.all { it.isDigit() }

    /** 交给 ApiClient.createSession 的 deviceAuth 字段（首次自动注册） */
    fun credentials(oldPassword: String? = null): JSONObject =
        JSONObject()
            .put("deviceId", deviceId)
            .put("password", permanentPassword)
            .apply { oldPassword?.let { put("oldPassword", it) } }

    /** 设置临时密码：随机 6 位，durationMinutes 分钟后到期 */
    fun generateTemporary(durationMinutes: Int): String {
        val pwd = randomSixDigits()
        temporaryPassword = pwd
        temporaryExpiresAt = System.currentTimeMillis() + durationMinutes * 60_000L
        return pwd
    }

    fun clearTemporary() {
        temporaryPassword = ""
        temporaryExpiresAt = 0L
    }

    /** 临时密码仍在有效期内则返回它 */
    fun activeTemporaryPassword(): String? = if (
        temporaryPassword.length == 6 && temporaryExpiresAt > System.currentTimeMillis()
    ) temporaryPassword else null

    fun clear() = prefs.edit().clear().apply()

    companion object {
        private const val FILE_NAME = "device_config"
        private const val KEY_ENABLED = "enabled"
        private const val KEY_AUTO_RESTART = "auto_restart"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_PASSWORD = "password"
        private const val KEY_TEMP_PASSWORD = "temp_password"
        private const val KEY_TEMP_EXPIRES = "temp_expires"

        private val secureRandom = SecureRandom()
        fun randomSixDigits(): String = buildString {
            repeat(6) { append(secureRandom.nextInt(10)) }
        }
        /** 供 UI 生成新长期密码，原来是默认值（保持调用点兼容） */
        fun randomSixDigitsFromUi(): String = randomSixDigits()
    }
}
