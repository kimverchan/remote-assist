# OkHttp / kotlinx-coroutines 由各库自带 consumer rules 处理
# 保留通过反射访问的 MediaCodec 回调与无障碍服务组件
-keep class com.pcxx.remote.host.inject.RemoteAccessibilityService { *; }
-keep class com.pcxx.remote.host.service.HostForegroundService { *; }
