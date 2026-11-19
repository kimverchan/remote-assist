# 受控端（android-host）

被协助者手机上安装此 App。职责：显示 6 位配对码、采集屏幕编码为 H.264 推流、把协助者的操作注入本机。

## 打开与编译

1. Android Studio（Ladybug 或更新）→ `File > Open` 选择本目录。
2. 首次打开若提示缺少 Gradle Wrapper JAR，执行 `gradle wrapper`（已提供 `gradle/wrapper/gradle-wrapper.properties`，Gradle 8.7），或直接用 Android Studio 自带的 Gradle Sync。
3. 需要 SDK Platform 35、Build Tools 35、JDK 17。
4. `Build > Generate Signed Bundle / APK` 或点 Run 安装到真机。

> 本仓库没有提供 `gradle-wrapper.jar` 二进制文件，Android Studio 打开时会自动补齐。

### Windows 中文路径说明

仓库根目录名含中文（`安卓远程控制`），AGP 会中止构建。已通过两个 `gradle.properties` 中的 `android.overridePathCheck=true` 绕过（AGP 8.6.1 + Gradle 8.7 实测可构建）。

若后续在 aapt2 / 资源链接环节遇到编码类报错，请**不要移动仓库**，改用 ASCII junction 打开：已建好 `C:\rd-relay`（指向仓库根目录），在 Android Studio 里 `File > Open` 选择 `C:\rd-relay\android-host` 即可，与原路径是同一份文件。

## 使用步骤

1. 启动后端中继服务（见根目录 README），在首页填入服务器地址：
   - 真机与电脑在同一 WiFi：`http://<电脑局域网IP>:3000`
   - 模拟器访问宿主机：`http://10.0.2.2:3000`
2. 点「开启无障碍服务」，在系统设置里找到「远程协助 · 受控端」并开启。**没有它只能看画面、不能操作。**
3. 点「开始协助」，在系统弹窗中确认投屏，App 会显示 6 位配对码。
4. 把配对码口头告知协助者（60 秒内有效，一次性）。
5. 对方输入配对码后自动开始共享；随时点「结束协助」或通知栏返回即可断开。

### 无人值守 / 免点击模式

勾选「启用无人值守」并填好设备 ID + 访问密钥后，本机不再弹「允许协助」确认、不再需要 6 位配对码，断线或会话关闭会自动重建会话。配置方法、服务端白名单、自动恢复边界与安全要求见 [`docs/UNATTENDED.md`](../docs/UNATTENDED.md)。

> 普通安装（无 ADB / 无 root）仍需**一次性**人工开启无障碍服务、点一次系统投屏授权；投屏 token 被系统回收（锁屏、杀进程、重启）后也需要再点一次，App 会明确提示，不会假装自动恢复。

## 关键实现

| 文件 | 作用 |
|---|---|
| `capture/ScreenEncoder.kt` | MediaProjection + MediaCodec 异步 H.264 编码，输出 Annex-B NALU 并打 12 字节头 |
| `inject/RemoteAccessibilityService.kt` | dispatchGesture 注入点击/长按/滑动，全局动作，ACTION_SET_TEXT 输入文本 |
| `service/HostForegroundService.kt` | 前台服务编排：授权后立即建唯一采集、建会话、连 WS、等配对、按协助者在线状态启停推流、401 刷新、断线重连 |
| `net/RelayClient.kt` | OkHttp WebSocket，Authorization 头鉴权、指数退避重连、心跳 |
| `net/TokenStore.kt` | EncryptedSharedPreferences 加密存令牌 |
| `protocol/Protocol.kt` | 帧编解码，与 `docs/PROTOCOL.md` 同步 |
| `config/UnattendedConfig.kt` | 无人值守配置：固定设备 ID + 预共享密钥，只存加密 SharedPreferences |
| `service/HostForegroundService.kt`（无人值守部分） | 自动同意 `authorize_request`、会话层指数退避自动重建、人工急停压过自动重连 |

## 已知限制（重要）

- **任意 KeyEvent 无法注入**：非 root、非系统签名应用只能通过无障碍服务执行手势与 `GLOBAL_ACTION_*`。因此 `control.key` 仅支持 HOME / BACK / RECENTS / 通知栏，其余会返回明确的 `control.ack(ok=false)`，不会假装成功。需要完整按键注入须接入设备厂商 MDM / 系统签名权限。
- **文本输入**依赖当前有聚焦的可编辑控件；没有焦点时会返回失败。可用 `control.tap` 先点输入框。
- **投屏授权是一次性的，且有 5 分钟时效（Android 14+ / targetSdk 34+ 强制）**：系统从用户点「立即开始」起只给 5 分钟（AOSP `MediaProjectionManagerService.mDefaultTimeoutMs`），一个 `MediaProjection` 实例只允许 `createVirtualDisplay()` 一次，同一个 `resultData` 也不能重复消费，否则抛 `SecurityException: Don't re-use the resultData...`。因此受控端在拿到授权后**立即**创建唯一的 VirtualDisplay 并一直持有：等待配对码期间编码器空转但不推流，协助者断线只暂停推流（不释放 VirtualDisplay），重连时复用采集并补发 SPS/PPS + 关键帧。要重新采集只能重新授权（点「结束协助」后再点「开始协助」）。等待配对期间的编码空转是这套系统约束下的必要取舍。
- **无人值守不能自动恢复采集 token**：自动重连只重建「REST 建会话 + WebSocket」这一层，复用已持有的 `MediaProjection` / 编码器。锁屏、系统杀进程、设备重启、用户点「随时断开」、其他投屏抢占都会让 token 失效，此时必须人工再点一次「开始协助」。详见 `docs/UNATTENDED.md`。
- 屏幕旋转时目前不重建 VirtualDisplay（Android 14 要求改用 `VirtualDisplay.resize` / `setSurface`），横竖屏切换可能短暂拉伸，后续版本处理。
- 开发期为方便局域网调试开启了 `android:usesCleartextTraffic="true"`。**生产必须改为 WSS / HTTPS 并移除该属性**，同时加入证书锁定。
- 编码器固定 2 Mbps / 30fps / 长边最大 1280，未做码率自适应协商；弱网下降帧率需后续扩展 `stream.quality`。
