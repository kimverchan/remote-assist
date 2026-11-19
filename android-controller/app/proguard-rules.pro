# OkHttp / kotlinx-coroutines 由各库自带 consumer rules 处理
# 保留 Activity（由 Manifest 反射实例化）
-keep class com.pcxx.remote.controller.ui.PairingActivity { *; }
-keep class com.pcxx.remote.controller.ui.ControlActivity { *; }
