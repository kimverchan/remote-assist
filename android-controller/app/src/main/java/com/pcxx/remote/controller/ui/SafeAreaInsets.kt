package com.pcxx.remote.controller.ui

import android.app.Activity
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/**
 * targetSdk 35（Android 15+）强制 edge-to-edge：界面内容默认会绘制到系统状态栏、
 * 手势导航条和刘海下面。不处理 insets 时，控制页顶部状态栏连同右侧「断开」按钮
 * 会被系统状态栏盖住，点按该区域还容易误触发下拉通知栏。
 *
 * 这里把整个界面收进系统栏 + 刘海之外的安全区。仅在内容 View 上加 padding，
 * 不改变画面渲染逻辑；API 26~34 由 decor view 自行处理系统栏，传给内容 View 的
 * insets 为 0，因此不会重复加 padding。
 *
 * @param forceDarkSurface 界面背景固定为深色（控制页）时，把状态栏/导航栏图标改成浅色，
 *                        否则沿用 DayNight 主题按亮/暗模式设置的图标颜色（配对页）。
 */
internal fun Activity.applySafeAreaInsets(root: View, forceDarkSurface: Boolean = false) {
    if (forceDarkSurface) {
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
    }

    val initialLeft = root.paddingLeft
    val initialTop = root.paddingTop
    val initialRight = root.paddingRight
    val initialBottom = root.paddingBottom

    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
        val safe = insets.getInsets(
            WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
        )
        view.setPadding(
            initialLeft + safe.left,
            initialTop + safe.top,
            initialRight + safe.right,
            initialBottom + safe.bottom
        )
        insets
    }
    ViewCompat.requestApplyInsets(root)
}
