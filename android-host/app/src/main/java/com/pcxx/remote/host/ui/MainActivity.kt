package com.pcxx.remote.host.ui

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.pcxx.remote.host.BuildConfig
import com.pcxx.remote.host.R
import com.pcxx.remote.host.config.DeviceIdentity
import com.pcxx.remote.host.config.UnattendedConfig
import com.pcxx.remote.host.inject.RemoteAccessibilityService
import com.pcxx.remote.host.service.HostForegroundService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : AppCompatActivity() {

    private lateinit var serverUrl: EditText
    private lateinit var status: TextView
    private lateinit var accessibilityHint: TextView
    private lateinit var startButton: Button
    private lateinit var stopButton: Button
    private lateinit var cbUnattended: CheckBox
    private lateinit var cbAutoRestart: CheckBox
    private lateinit var tvDeviceId: TextView
    private lateinit var tvPassword: TextView
    private lateinit var tvTempPassword: TextView
    private lateinit var unattended: UnattendedConfig

    private val projectionLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val data = result.data
            if (result.resultCode != RESULT_OK || data == null) {
                toast("需要投屏授权才能开始协助")
                return@registerForActivityResult
            }
            val url = serverUrl.text.toString().trim()
            validateServerUrl(url)?.let {
                toast(it)
                return@registerForActivityResult
            }
            getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_SERVER, url)
                .apply()
            // 设备凭据始终随会话自动注册到服务器，无需手填
            val intent = Intent(this, HostForegroundService::class.java).apply {
                action = HostForegroundService.ACTION_START
                putExtra(HostForegroundService.EXTRA_SERVER_URL, url)
                putExtra(HostForegroundService.EXTRA_PROJECTION_DATA, data)
            }
            ContextCompat.startForegroundService(this@MainActivity, intent)
        }

    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (!granted) toast("通知权限被拒绝，会话仍可运行但不会有常驻提示")
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        serverUrl = findViewById(R.id.etServerUrl)
        status = findViewById(R.id.tvStatus)
        accessibilityHint = findViewById(R.id.tvAccessibility)
        startButton = findViewById(R.id.btnStart)
        stopButton = findViewById(R.id.btnStop)
        cbUnattended = findViewById(R.id.cbUnattended)
        cbAutoRestart = findViewById(R.id.cbAutoRestart)
        tvDeviceId = findViewById(R.id.tvDeviceId)
        tvPassword = findViewById(R.id.tvPassword)
        tvTempPassword = findViewById(R.id.tvTempPassword)
        unattended = UnattendedConfig(this)

        cbUnattended.isChecked = unattended.enabled
        cbAutoRestart.isChecked = unattended.autoRestart
        renderDeviceCard()

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

        startButton.setOnClickListener { begin() }
        stopButton.setOnClickListener {
            startService(Intent(this, HostForegroundService::class.java).apply {
                action = HostForegroundService.ACTION_STOP
            })
        }
        findViewById<Button>(R.id.btnAccessibility).setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }

        // 点击设备号/密码复制
        val copyAll = {
            val text = "设备号：${DeviceIdentity.format(unattended.deviceId)}\n密码：${unattended.permanentPassword}"
            val clipboard = getSystemService(android.content.ClipboardManager::class.java)
            clipboard.setPrimaryClip(android.content.ClipData.newPlainText("设备凭据", text))
            toast("设备号和密码已复制")
        }
        tvDeviceId.setOnClickListener { copyAll() }
        tvPassword.setOnClickListener { copyAll() }
        findViewById<Button>(R.id.btnCopyCredentials).setOnClickListener { copyAll() }

        // 重置长期密码：需要旧密码同步到服务器（防劫持）
        findViewById<Button>(R.id.btnResetPassword).setOnClickListener {
            AlertDialog.Builder(this)
                .setTitle("重置长期密码")
                .setMessage(R.string.device_reset_confirm)
                .setNegativeButton("取消", null)
                .setPositiveButton("确定") { _, _ -> resetPassword() }
                .show()
        }

        // 生成临时密码（15 分钟有效）
        findViewById<Button>(R.id.btnTempPassword).setOnClickListener {
            val pwd = unattended.generateTemporary(15)
            renderDeviceCard()
            toast(getString(R.string.temp_generated, DeviceIdentity.format(pwd), 15))
            syncTempPassword()
        }
        findViewById<Button>(R.id.btnClearTemp).setOnClickListener {
            unattended.clearTemporary()
            renderDeviceCard()
            toast(R.string.temp_cleared)
            syncTempPassword()
        }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                HostForegroundService.state.collect { render(it) }
            }
        }
    }

    /** 设备卡片展示（不含配对码） */
    private fun renderDeviceCard() {
        tvDeviceId.text = DeviceIdentity.format(unattended.deviceId)
        tvPassword.text = unattended.permanentPassword
        val temp = unattended.activeTemporaryPassword()
        tvTempPassword.text = if (temp != null) {
            val remain = (unattended.temporaryExpiresAt - System.currentTimeMillis()) / 60_000
            "临时密码：${DeviceIdentity.format(temp)}（剩余 ${remain} 分钟）"
        } else {
            getString(R.string.temp_none)
        }
    }

    private fun resetPassword() {
        val old = unattended.permanentPassword
        val newPwd = UnattendedConfig.randomSixDigitsFromUi()
        unattended.permanentPassword = newPwd
        renderDeviceCard()
        // 通知前台服务用旧密码调用 /devices/register 更新摘要
        val intent = Intent(this, HostForegroundService::class.java).apply {
            action = HostForegroundService.ACTION_RESET_PASSWORD
            putExtra(HostForegroundService.EXTRA_OLD_PASSWORD, old)
            putExtra(HostForegroundService.EXTRA_NEW_PASSWORD, newPwd)
        }
        startService(intent)
        toast(R.string.device_reset_done)
    }

    /** 临时密码同步到服务器（需 host token，服务未启动则下次建会话时同步） */
    private fun syncTempPassword() {
        val intent = Intent(this, HostForegroundService::class.java).apply {
            action = HostForegroundService.ACTION_SYNC_TEMP
        }
        startService(intent)
    }

    override fun onResume() {
        super.onResume()
        renderDeviceCard()
        accessibilityHint.text = if (RemoteAccessibilityService.isConnected ||
            isAccessibilityEnabled()
        ) {
            "无障碍服务：已开启"
        } else {
            "无障碍服务：未开启，协助者将无法操作你的手机，请先点击下方按钮开启"
        }
    }

    private fun validateServerUrl(url: String): String? = when {
        url.isBlank() -> "请先填写中继服务器地址"
        !url.startsWith("http://") && !url.startsWith("https://") ->
            "中继服务器地址必须以 http:// 或 https:// 开头"
        !BuildConfig.ALLOW_CLEARTEXT && !url.startsWith("https://") ->
            "正式包必须使用 HTTPS 中继服务器地址"
        else -> null
    }

    private fun saveConfig() {
        unattended.enabled = cbUnattended.isChecked
        unattended.autoRestart = cbAutoRestart.isChecked
    }

    private fun begin() {
        saveConfig()
        if (!unattended.isUsable()) {
            toast("设备凭据异常，请重装 App 以重新生成")
            return
        }
        if (!isAccessibilityEnabled()) {
            toast("请先开启无障碍服务")
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        val manager = getSystemService(MediaProjectionManager::class.java)
        projectionLauncher.launch(manager.createScreenCaptureIntent())
    }

    private fun isAccessibilityEnabled(): Boolean {
        val enabled = Settings.Secure.getString(
            contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        return enabled.split(':').any { it.contains(packageName, ignoreCase = true) }
    }

    private var lastShownError: String? = null

    private fun render(state: HostForegroundService.HostState) {
        val message = state.message ?: getString(R.string.status_idle)
        val isError = state.phase == HostForegroundService.Phase.ERROR
        status.text = message
        status.setTextColor(
            ContextCompat.getColor(
                this,
                if (isError) R.color.status_error else R.color.status_normal
            )
        )
        if (isError) {
            if (lastShownError != message) {
                lastShownError = message
                Toast.makeText(this, message.substringBefore('\n'), Toast.LENGTH_LONG).show()
            }
            startButton.text = getString(R.string.retry_start)
        } else {
            lastShownError = null
            startButton.text = getString(R.string.start)
        }
        val capturing = state.phase == HostForegroundService.Phase.CONNECTING ||
            state.phase == HostForegroundService.Phase.WAITING ||
            state.phase == HostForegroundService.Phase.AWAITING_AUTHORIZATION ||
            state.phase == HostForegroundService.Phase.STREAMING
        val serviceAlive = capturing || isError
        startButton.isEnabled = !capturing
        stopButton.isEnabled = serviceAlive
    }

    private fun toast(message: String) =
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()

    private fun toast(resId: Int) = Toast.makeText(this, resId, Toast.LENGTH_SHORT).show()

    private companion object {
        const val PREFS = "host_settings"
        const val KEY_SERVER = "server_url"
    }
}
