package com.pcxx.remote.host.net

import com.pcxx.remote.host.BuildConfig
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

class ApiException(
    val code: String,
    val status: Int,
    message: String
) : IOException(message)

/** REST 边界：全部为同步调用，必须在 Dispatchers.IO 中执行 */
class ApiClient(baseUrl: String) {

    private val root = baseUrl.trim().trimEnd('/')
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    init {
        // release 变体强制 HTTPS：明文地址只允许出现在 debug 包（联调用临时隧道）
        require(root.startsWith("https://") || (BuildConfig.ALLOW_CLEARTEXT && root.startsWith("http://"))) {
            if (BuildConfig.ALLOW_CLEARTEXT) {
                "中继服务器地址必须以 http:// 或 https:// 开头"
            } else {
                "正式包必须使用 HTTPS 中继服务器地址"
            }
        }
    }

    /**
     * 建会话。deviceAuth 必填：deviceId + 6 位密码，首次自动注册到服务端。
     * oldPassword 仅在重置密码时提供。服务端不再签发配对码。
     */
    fun createSession(device: JSONObject, deviceAuth: JSONObject): JSONObject = post(
        "/api/v1/sessions",
        JSONObject().put("role", "host").put("device", device).put("deviceAuth", deviceAuth),
        null
    )

    /** 更新服务端密码摘要（重置长期密码时用旧密码防劫持，需 host token） */
    fun resetPassword(
        deviceId: String,
        oldPassword: String,
        newPassword: String,
        token: String
    ): JSONObject = post(
        "/api/v1/devices/password",
        JSONObject()
            .put("deviceId", deviceId)
            .put("oldPassword", oldPassword)
            .put("newPassword", newPassword),
        token
    )

    /** 设置/清除临时密码（需 host token） */
    fun setTemporaryPassword(
        deviceId: String,
        permanentPassword: String,
        temporaryPassword: String?,
        expiresAt: Long,
        token: String
    ): JSONObject = post(
        "/api/v1/devices/temporary",
        JSONObject()
            .put("deviceId", deviceId)
            .put("permanentPassword", permanentPassword)
            .put("temporaryPassword", temporaryPassword ?: JSONObject.NULL)
            .put("expiresAt", expiresAt),
        token
    )

    fun refresh(refreshToken: String): JSONObject = post(
        "/api/v1/auth/refresh",
        JSONObject().put("refreshToken", refreshToken),
        null
    )

    fun closeSession(sessionId: String, token: String) {
        val request = Request.Builder()
            .url("$root/api/v1/sessions/$sessionId")
            .delete()
            .header("Authorization", "Bearer $token")
            .build()
        runCatching { client.newCall(request).execute().use { } }
    }

    private fun post(path: String, body: JSONObject, token: String?): JSONObject {
        val builder = Request.Builder()
            .url("$root$path")
            .post(body.toString().toRequestBody(jsonType))
        token?.let { builder.header("Authorization", "Bearer $it") }
        return execute(builder.build())
    }

    private fun execute(request: Request): JSONObject {
        client.newCall(request).execute().use { response ->
            val raw = response.body?.string().orEmpty()
            val json = if (raw.isBlank()) JSONObject() else JSONObject(raw)
            if (!response.isSuccessful) {
                val error = json.optJSONObject("error")
                throw ApiException(
                    error?.optString("code") ?: "INTERNAL",
                    response.code,
                    error?.optString("message") ?: "请求失败（HTTP ${response.code}）"
                )
            }
            return json
        }
    }
}
