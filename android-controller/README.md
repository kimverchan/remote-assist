# 控制端（android-controller）

协助者手机上安装此 App。职责：输入 6 位配对码认领会话、接收 H.264 流解码显示、把本地手势换算成归一化坐标指令发回受控端。

## 打开与编译

1. Android Studio（Ladybug 或更新）→ `File > Open` 选择本目录。
2. 需要 SDK Platform 35、Build Tools 35、JDK 17、Gradle 8.7（已提供 wrapper properties，缺 jar 时执行 `gradle wrapper`）。
3. 点 Run 安装到真机。

### Windows 中文路径说明

仓库根目录名含中文，`gradle.properties` 已加 `android.overridePathCheck=true` 绕过 AGP 检查（AGP 8.6.1 + Gradle 8.7 实测可构建）。若后续遇编码类构建报错，用 `File > Open` 打开 ASCII junction 路径 `C:\rd-relay\android-controller`（已建好，同一份文件，无需移动仓库）。

## 使用步骤

1. 先启动中继服务器，再让受控端 App 显示配对码。
2. 在控制端首页填入同一个服务器地址，输入 6 位配对码，点「连接设备」。
3. 进入画面后：单指点击 = 点击，静止长按住 = 长按，拖动 = 滑动；底部按钮提供返回 / 主页 / 最近任务 / 输入文字。
4. 点顶部右侧「断开」结束会话；按钮固定位于系统状态栏下方的安全区（48dp 高触摸区域），按系统返回键同样会立即断开。

## 关键实现

| 文件 | 作用 |
|---|---|
| `decode/H264Decoder.kt` | MediaCodec 异步解码到 TextureView Surface，SPS/PPS 拼在关键帧前 |
| `input/TouchMapper.kt` | 本地像素 → 归一化 0..1 坐标，识别 tap / long_press / swipe |
| `ui/PairingActivity.kt` | 认领会话、4xx 不重试 / 5xx 最多 3 次、错误码映射中文提示 |
| `ui/ControlActivity.kt` | 会话编排、画面宽高比自适应、401 刷新令牌、断开清理 |
| `ui/SafeAreaInsets.kt` | Android 15（targetSdk 35）强制 edge-to-edge 的系统栏/刘海安全区处理，保证顶栏「断开」与底部按钮不被状态栏、手势条遮挡 |
| `net/RelayClient.kt` | OkHttp WebSocket，Header 鉴权、心跳、指数退避重连 |

## 已知限制

- 只读画面，不做本地录制；服务端也不缓存任何屏幕内容。
- 文本输入依赖受控端当前存在聚焦的可编辑控件；可先点一下输入框再发送文字。
- 非 root 受控端只能执行 HOME / BACK / RECENTS 等全局动作，任意物理按键无法注入（见 `android-host/README.md`）。
- 开发期为局域网调试开启了明文 HTTP；**生产必须切 WSS 并移除 `usesCleartextTraffic`**，建议加证书锁定。
- 解码器按固定 33ms PTS 递增渲染，未实现抖动缓冲；弱网下可能出现轻微卡顿。
