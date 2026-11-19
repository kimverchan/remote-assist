package com.pcxx.remote.controller.ui

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.pcxx.remote.controller.BuildConfig
import com.pcxx.remote.controller.R
import com.pcxx.remote.controller.net.ApiClient
import com.pcxx.remote.controller.net.ApiException
import com.pcxx.remote.controller.net.TokenStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** 单一入口：设备号（9 位）+ 6 位数字密码直连，配对码已移除 */
class PairingActivity : AppCompatActivity() {

    private lateinit var serverUrl: EditText
    private lateinit var deviceIdInput: EditText
    private lateinit var passwordInput: EditText
    private lateinit var status: TextView
    private lateinit var connectButton: Button
    private lateinit var tokens: TokenStore

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_pairing)
        applySafeAreaInsets(findViewById<View>(R.id.rootPairing))
        tokens = TokenStore(this)

        serverUrl = findViewById(R.id.etServerUrl)
        deviceIdInput = findViewById(R.id.etDeviceId)
        passwordInput = findViewById(R.id.etCode)
        status = findViewById(R.id.tvStatus)
        connectButton = findViewById(R.id.btnConnect)

        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val saved = prefs.getString(KEY_SERVER, null).orEmpty()
        serverUrl.setText(
            if (saved.isBlank() && BuildConfig.DEFAULT_SERVER.isNotBlank()) {
                prefs.edit().putString(KEY_SERVER, BuildConfig.DEFAULT_SERVER).apply()
                BuildConfig.DEFAULT_SERVER
            } else {
                saved
            }
        )
        connectButton.setOnClickListener { attempt() }
    }

    private fun validateServerUrl(url: String): String? = when {
        url.isBlank() -> "请填写中继服务器地址"
        !url.startsWith("http://") && !url.startsWith("https://") ->
            "中继服务器地址必须以 http:// 或 https:// 开头"
        !BuildConfig.ALLOW_CLEARTEXT && !url.startsWith("https://") ->
            "正式包必须使用 HTTPS 中继服务器地址"
        else -> null
    }

    /** 设备号 + 6 位密码直连 */
    private fun attempt() {
        val url = serverUrl.text.toString().trim()
        // 设备号允许输入时带空格（向日葵分组格式 382 915 046），统一去掉
        val deviceId = deviceIdInput.text.toString().replace(" ", "").trim()
        val password = passwordInput.text.toString().trim()
        validateServerUrl(url)?.let { return toast(it) }
        if (!Regex("^\\d{9}$").matches(deviceId)) return toast("设备号必须是 9 位数字")
        if (!Regex("^\\d{6}$").matches(password)) return toast("密码必须是 6 位数字")

        setConnecting(true)
        status.text = getString(R.string.status_direct_connecting)
        lifecycleScope.launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    claimDeviceWithRetry(url, deviceId, password)
                }
                onClaimed(url, result)
            } catch (e: Exception) {
                status.text = directError(e)
            } finally {
                setConnecting(false)
            }
        }
    }

    private fun onClaimed(url: String, result: JSONObject) {
        val sessionId = result.getString("sessionId")
        val access = result.getString("accessToken")
        val refresh = result.getString("refreshToken")
        val hostModel = result.optJSONObject("host")?.optString("model") ?: "受控设备"

        tokens.save(access, refresh, sessionId)
        getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_SERVER, url)
            .apply()

        status.text = "已连接：$hostModel"
        startActivity(Intent(this@PairingActivity, ControlActivity::class.java).apply {
            putExtra(ControlActivity.EXTRA_SERVER_URL, url)
            putExtra(ControlActivity.EXTRA_ACCESS_TOKEN, access)
            putExtra(ControlActivity.EXTRA_SESSION_ID, sessionId)
            putExtra(ControlActivity.EXTRA_HOST_MODEL, hostModel)
        })
    }

    private fun setConnecting(active: Boolean) {
        connectButton.isEnabled = !active
    }

    /** 4xx 立即失败；5xx 自动重试最多 3 次 */
    private suspend fun withClaimRetry(call: () -> JSONObject): JSONObject {
        var attempt = 0
        while (true) {
            try {
                return call()
            } catch (e: ApiException) {
                if (e.status < 500 || attempt >= 2) throw e
                attempt += 1
                delay(500L * attempt)
            }
        }
    }

    private suspend fun claimDeviceWithRetry(
        url: String,
        deviceId: String,
        password: String
    ): JSONObject {
        val api = ApiClient(url)
        return withClaimRetry { api.claimDevice(deviceId, password, buildDeviceInfo()) }
    }

    private fun buildDeviceInfo(): JSONObject {
        val metrics = resources.displayMetrics
        return JSONObject()
            .put("model", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
            .put("osVersion", "Android ${Build.VERSION.RELEASE}")
            .put("appVersion", "1.0.0")
            .put(
                "screen", JSONObject()
                    .put("width", metrics.widthPixels)
                    .put("height", metrics.heightPixels)
                    .put("density", metrics.density.toDouble())
                    .put("rotation", 0)
            )
    }

    /** 服务端 401/404/429 已返回统一 message，直接展示 */
    private fun directError(error: Exception): String = when (error) {
        is ApiException -> error.message ?: getString(R.string.err_direct_failed)
        is IllegalArgumentException -> error.message ?: getString(R.string.err_server_url_invalid)
        else -> getString(R.string.err_network)
    }

    private fun toast(message: String) =
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()

    private companion object {
        const val PREFS = "controller_settings"
        const val KEY_SERVER = "server_url"
    }
}
