package com.pcxx.remote.host

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build

class RemoteHostApp : Application() {
    override fun onCreate() {
        super.onCreate()
        ensureChannel(this)
    }

    companion object {
        const val CHANNEL_ID = "remote_assist_session"
        const val CHANNEL_AUTH_ID = "remote_assist_authorization"

        fun ensureChannel(app: android.content.Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val manager = app.getSystemService(NotificationManager::class.java)
            if (manager.getNotificationChannel(CHANNEL_ID) == null) {
                manager.createNotificationChannel(
                    NotificationChannel(
                        CHANNEL_ID,
                        app.getString(R.string.notification_channel),
                        NotificationManager.IMPORTANCE_LOW
                    ).apply {
                        description = "远程协助会话进行中的常驻通知"
                        setShowBadge(false)
                    }
                )
            }
            // 授权请求是高优先级、需要用户即时确认的通知，单独用 HIGH 渠道
            if (manager.getNotificationChannel(CHANNEL_AUTH_ID) == null) {
                manager.createNotificationChannel(
                    NotificationChannel(
                        CHANNEL_AUTH_ID,
                        app.getString(R.string.notification_channel_auth),
                        NotificationManager.IMPORTANCE_HIGH
                    ).apply {
                        description = "协助者请求查看并操作屏幕时的确认通知"
                        setShowBadge(true)
                    }
                )
            }
        }
    }
}
