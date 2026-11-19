package com.pcxx.remote.controller.net

import com.pcxx.remote.controller.BuildConfig
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

class ApiException(val code: String, val status: Int, message: String) : IOException(message)

/** REST 边界：同步调用，必须在 Dispatchers.IO 中执行 */
class ApiClient(baseUrl: String) {

    private val root = baseUrl.trim().trimEnd('/')
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .retryOnConnectionFailure(false)
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

    /** 设备号 + 6 位数字密码直连认领会话 */
    fun claimDevice(deviceId: String, password: String, device: JSONObject): JSONObject = post(
        "/api/v1/sessions/claim-device",
        JSONObject()
            .put("deviceId", deviceId)
            .put("password", password)
            .put("device", device),
        null
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
