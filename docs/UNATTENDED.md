# 无人值守 / 免点击模式（设备号 + 6 位密码）

> 适用版本：v2 协议（会话级授权）。相关实现：
> `android-host/.../config/{DeviceIdentity,UnattendedConfig}.kt`、`service/HostForegroundService.kt`、
> `server/src/features/device/`、`server/src/features/session/`、`android-controller/`。
>
> **v2 重大变更**：彻底移除 6 位配对码。现在统一为「向日葵风格」——
> 设备号（9 位数字，自动生成）+ 6 位数字密码（默认长期，可选限时临时密码）。
> 配对码接口 `/claim`、pairing 模块、`PAIRING_*` 配置均已删除。

## 一、先说结论：普通安装做不到 100% 零点击

在**无 ADB、无 root、无系统签名、无厂商 MDM** 的普通安装条件下，Android 从系统设计上就不允许应用完全消除投屏授权弹窗。必须先接受这个边界。

| 人工交互点 | 归属 | 能否消除 | 本项目的处理 |
| --- | --- | --- | --- |
| 开启无障碍服务 | 系统设置 | **不能**（一次性人工） | `WRITE_SECURE_SETTINGS` 自 Android 10 起是 `signature\|privileged` 权限，普通 App 无法写入 |
| MediaProjection 投屏授权弹窗 | 系统 SystemUI | **首次不能**，之后可长期不再出现 | 首次点一次，之后长期持有唯一 `MediaProjection` / `VirtualDisplay`，不释放 token |
| 通知里点「允许协助」 | App 自建 | **已消除** | 收到 `session.authorize_request` 后自动回 `session.authorize_grant`（可在 App 关闭自动同意） |
| 传递配对码 | 业务协议 | **已消除** | 改为固定设备号 + 6 位数字密码，不再签发一次性配对码 |
| 每次新会话重新点击开始 | App | **已消除** | 断线 / 会话关闭 / 令牌过期自动重建会话，指数退避重连 |

> 系统侧硬限制：普通应用**无法读取硬件序列号**（`Build.getSerial()` 需要特权权限），
> 因此设备号的稳定性来自 `ANDROID_ID`（见第三节），不能承诺"刷机/换机后仍不变"。

## 二、设备号是怎么来的

`DeviceIdentity.deviceId()` 用 `Settings.Secure.ANDROID_ID` 经 SHA-256 派生出 **9 位纯数字**（UI 显示为 `382 915 046` 分组格式）。

- **同一签名证书 + 同一用户 + 同一台设备下，卸载重装保持不变**——这是普通应用能拿到的最稳定标识；
- **恢复出厂设置、更换设备、或更换签名证书（debug ↔ release）都会变化**；
- 少数 ROM / 模拟器返回无效 `ANDROID_ID` 时回退到安装标识（稳定性弱于 ANDROID_ID）。

这个边界必须由产品侧如实告知用户，不要承诺硬件级绑定。

## 三、密码模型

| 类型 | 生成 | 有效期 | 用途 |
| --- | --- | --- | --- |
| 长期密码 | 首次安装随机 6 位数字，用户可重置 | 永久（直到重置） | 日常直连；重置时须提供旧密码防劫持 |
| 临时密码 | 用户在受控端点「生成临时密码」 | 15 分钟（可配，上限 `TEMP_PASSWORD_MAX_MINUTES`） | 临时把控制权交给他人，到期自动失效 |

- 服务端**只保存摘要**：`HMAC-SHA256(pepper=JWT_SECRET, deviceId + ':' + 密码)`，用 pepper 防止凭据文件泄露后离线爆破 6 位数字；明文密码不写日志、不进 URL、不落服务端文件。
- 凭据文件：`data/device-credentials.json`（容器内 `/app/data`，由 compose 命名卷持久化，权限 600）。
- 临时密码到期后由后台 GC 自动清除；长期密码始终可用。

## 四、服务端配置

凭据**无需手工配置**：受控端首次建会话自动注册。`.env` 只需配置安全参数：

```bash
# 凭据持久化目录（容器内应为挂载卷，重启不丢）
DEVICE_DATA_DIR=/app/data
# 连续密码错误达到该次数后锁定设备
DEVICE_LOCK_THRESHOLD=5
# 锁定时长（分钟）
DEVICE_LOCK_MINUTES=15
# 临时密码最长有效期（分钟）
TEMP_PASSWORD_MAX_MINUTES=120
```

两个编排（`docker-compose.yml` / `docker-compose.ip-http.yml`）均已透传以上变量并挂载 `device-data` 卷。用旧版部署包部署的服务器需要重新上传编排与镜像才生效。改完 `.env` 后必须重建容器：

```bash
cd /opt/remote-assist-relay/deploy
# IP 直连模式
docker compose -f docker-compose.ip-http.yml up -d --force-recreate relay
# HTTPS 域名模式
docker compose up -d --force-recreate relay
# 核对容器内的配置
docker exec remote-assist-relay printenv DEVICE_LOCK_THRESHOLD
```

## 五、HTTP 接口

| 接口 | 请求 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `POST /api/v1/sessions` | `{role, device, deviceAuth:{deviceId, password, oldPassword?}}` | 无 | 受控端建会话；deviceId 首次自动注册；提供 oldPassword 时更新长期密码；**不再签发配对码** |
| `POST /api/v1/sessions/claim-device` | `{deviceId, password, device}` | 无（按密码本身鉴权） | 控制端直连认领；成功返回与原 `/claim` 一致的结构 |
| `POST /api/v1/devices/temporary` | `{deviceId, permanentPassword, temporaryPassword\|null, expiresAt}` | Host token | 设置/清除临时密码；须校验长期密码 |
| `POST /api/v1/devices/password` | `{deviceId, oldPassword, newPassword}` | Host token | 重置长期密码；旧密码错误则拒绝（防劫持） |

错误码：

| code | http | 含义 |
| --- | --- | --- |
| `DEVICE_AUTH_FAILED` | 401 | 设备号不存在或密码错误（两者响应完全一致，防枚举） |
| `DEVICE_NOT_ONLINE` | 404 | 凭据正确但当前没有可认领的在线会话（与 401 共用文案） |
| `DEVICE_LOCKED` | 429 | 密码连续错误达阈值，设备临时锁定 |
| `RATE_LIMITED` | 429 | 触犯 IP / deviceId 双层固定窗口限流 |

## 六、防爆破设计（6 位数字密码的必要补偿）

1. **per-IP 限流**：`/claim-device` 按真实来源 IP 8 次/分钟（未启用 trust proxy 时不可被 XFF 伪造）；
2. **per-deviceId 限流**：跨 IP 10 次/分钟，针对性爆破单台设备；
3. **失败锁定**：同一 deviceId 连续错误达 `DEVICE_LOCK_THRESHOLD`（默认 5）次，锁定 `DEVICE_LOCK_MINUTES`（默认 15）分钟；锁定期内即使正确密码也拒绝；
4. **peppered 摘要**：凭据文件泄露也无法离线爆破；
5. **常量时间比较 + 统一错误文案**：防白名单枚举与时序侧信道；
6. `logger.ts` 的 `SENSITIVE` 正则对 `password` / `credential` 等字段脱敏。

## 七、使用流程

### 受控端（一次性启用）
1. 安装并打开 App，**设备号与 6 位长期密码自动生成并显示在首页**（点按可复制）；
2. 填入 HTTPS 中继地址（release 包强制 HTTPS）；
3. 点「开启无障碍服务」，在系统设置里打开「远程协助 · 受控端」；
4. 勾选「自动同意协助请求」和「断线自动重建会话」；
5. 点「开始协助」，在系统投屏弹窗中点一次「立即开始」；
6. 需要临时授权时点「生成临时密码」，把临时密码告知对方，15 分钟后自动失效。

### 控制端
1. 打开 App，填同一个中继服务器地址；
2. 输入对方的 **9 位设备号** + **6 位密码**（长期或有效期内的临时密码）；
3. 点「连接设备」，复用原有 WebSocket / 解码 / 控制流程。

## 八、自动恢复的边界

| 场景 | 能否自动恢复 |
| --- | --- |
| 网络抖动、中继重启、WebSocket 断开 | 能，自动重建会话并复用采集 |
| JWT 过期 | 能，用 refresh token 轮换；失败则重建会话 |
| 会话被服务端关闭 | 开启「断线自动重建」时能 |
| 设备号变化（恢复出厂 / 换机 / 换签名） | 不能，需在服务端重新注册（App 自动完成新设备号注册），控制端更新设备号 |
| 长期密码重置 | 新密码立即生效，旧密码失效；控制端需更新 |
| 用户点「结束协助」 | 不会自动重连（人工急停） |

## 九、验证状态

- **服务端冒烟**：`node scripts/smoke.mjs` **32/32** 通过，覆盖：建会话自动注册、错误密码锁定、WS 双端握手、会话级授权门控、文本/二进制帧转发、令牌轮换、角色越权拒绝、拒绝授权关闭会话。
- **接口定向测试**：临时密码直连、密码重置后新密码生效、旧密码被拒，全部通过。
- **三端真机端到端**：尚未验证。

## 十、相关文件

- 设备身份：`android-host/app/src/main/java/com/pcxx/remote/host/config/DeviceIdentity.kt`
- 凭据配置：`.../config/UnattendedConfig.kt`
- 受控端 UI：`.../ui/MainActivity.kt`、`res/layout/activity_main.xml`
- 受控端会话/同步：`.../service/HostForegroundService.kt`、`.../net/ApiClient.kt`
- 服务端凭据：`server/src/features/device/{device-credentials.repository,device.controller}.ts`
- 服务端会话：`server/src/features/session/{session.controller,session.service,session.repository}.ts`
- 控制端：`android-controller/app/src/main/java/com/pcxx/remote/controller/ui/PairingActivity.kt`
