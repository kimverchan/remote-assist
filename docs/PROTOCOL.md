# 中继协议规范 v2

本文件是三端（受控端 / 控制端 / 中继服务器 / Web 运维看板）的**唯一权威约定**。
TS 实现见 `server/src/shared/protocol.ts`，Kotlin 实现见两个 Android 工程的 `protocol/Protocol.kt`。
修改协议必须同时更新三处，并递增 `PROTOCOL_VERSION`。

## 版本记录

| 版本 | 变更 | 兼容性 |
|---|---|---|
| v1 | 初版：配对、JWT、视频二进制帧、控制指令 | — |
| v2 | 新增会话级授权 `session.authorize_*`；改为设备号 + 6 位密码直连（移除配对码）；限流按 IP + 设备号双维度，含失败锁定 | **不兼容**：信封 `v` 与二进制帧头 `version` 均为 2，v1 客户端无法与 v2 服务端互通，三端必须同步升级 |

> **设备号 + 6 位密码（v2）**：`POST /sessions` 必填 `deviceAuth:{deviceId,password}`，首次自动注册；配对码 `/claim` 接口已删除。WebSocket 帧格式、消息类型与 `session.authorize_*` 流程未改变。详见 `docs/UNATTENDED.md`。

---

## 1. 会话生命周期

```
受控端                          中继服务器                     控制端
  |  POST /sessions (host)        |                              |
  |------------------------------>|                              |
  |  {sessionId, accessToken,...} |                              |
  |<------------------------------|                              |
  |  WS /ws  Authorization:       |                              |
  |==============================>|  等待配对                     |
  |                              |<-- POST /sessions/claim-device |  用户输入设备号 + 6 位密码
  |                              |  {controllerToken, hostInfo} ->|
  |  session.peer_joined <--------|<==============================|  WS /ws
  |  session.authorize_request <--|                              |
  |                              |-- authorize_state(false) ----->|  等待对方确认
  |  被协助者在通知中点「允许协助」  |  授权前 control.* 一律不转发   |
  |  session.authorize_grant ---->|                              |
  |  authorize_state(true) <------|--- authorize_state(true) ---->|  开始建立画面
  |  用户在系统弹窗中授权投屏       |                              |
  |  stream.config / 二进制帧 ---->|=============================>|  显示画面
  |<------------------------------|<==============================|  control.* 指令
  |  control.ack ---------------->|------------------------------>|
  |  通知栏「随时断开」             |  DELETE /sessions/:id         |
```

**关键约束**
- 设备号 9 位数字（ANDROID_ID 派生，重装稳定），密码 6 位数字（长期 + 限时临时）。
- **失败锁定**：认领失败按「设备号」累计次数，达到 `DEVICE_LOCK_THRESHOLD`（默认 5）锁定 `DEVICE_LOCK_MINUTES`（默认 15）分钟并返回 `DEVICE_LOCKED`；计数与客户端 IP、`X-Forwarded-For` 无关，换 IP 或伪造请求头都无法重置。
- 一个会话最多 1 个 host、1 个 controller；observer 通过 REST 只读，不进房间。
- **会话级授权（v2）**：控制端入房不等于获得控制权。服务端向受控端发 `session.authorize_request`（附带协助者设备型号与系统版本）；只有受控端回复 `session.authorize_grant` 后，服务端才允许转发 `control.*`。授权绑定到该控制端 `deviceId`，换设备重连必须重新确认；`session.authorize_deny` 立即关闭整个会话。授权前受控端也不推送画面。
- 受控端常驻通知必须提供「随时断开」，点击后 `DELETE /sessions/:id` 并释放本地注入能力。
- **设备直连模式**：控制端用 `deviceId + password` 直连，不再有配对码；服务端仍照常发 `session.authorize_request`，由受控端自动回 `session.authorize_grant`（本地审计标注 `unattended.auto_grant`）。服务端**不得**替无人值守会话跳过授权门控或放宽 `authorizedFor` 绑定。凭据校验失败一律返回统一错误，防止设备枚举。
- host 断线 → 房间立即关闭，controller 收到 `session.closed(code=4001)`；controller 断线 → host 收到 `session.peer_left` 并可等待重连（30s 宽限）。
- 会话绝对上限 `SESSION_TTL`（默认 3600s），到期强制关闭。

---

## 2. REST 接口（Base `/api/v1`）

除 `/health`、`/ready` 外，所有请求/响应均为 `application/json; charset=utf-8`。

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/sessions` | 无（限流） | 受控端创建会话；必填 `deviceAuth:{deviceId,password,oldPassword?}`，首次自动注册；不再签发配对码 |
| POST | `/sessions/claim-device` | 无（IP 8/min + 按 deviceId 10/min + 失败锁定） | 控制端用设备号 + 6 位密码认领会话：`{deviceId,password,device}` |
| POST | `/devices/temporary` | Bearer（host） | 设置/清除限时临时密码：`{deviceId,permanentPassword,temporaryPassword,expiresAt}` |
| POST | `/devices/password` | Bearer（host） | 重置长期密码（需旧密码）：`{deviceId,oldPassword,newPassword}` |
| GET | `/sessions/:id` | Bearer（host/controller/observer） | 查询会话状态（含 `authorized`） |
| DELETE | `/sessions/:id` | Bearer（host/controller） | 主动结束会话 |
| POST | `/auth/refresh` | Body `refreshToken` | 换新 access token |
| POST | `/auth/observer` | `X-Admin-Key` | 运维看板换取 observer token |
| GET | `/admin/overview` | Bearer（observer） | 会话/设备/流量统计（含 `authorizedSessions`） |
| GET | `/health` | 无 | 存活探针 |
| GET | `/ready` | 无 | 就绪探针 |

### POST /sessions
```jsonc
// request
{
  "role": "host",
  "device": {
    "model": "Pixel 8",
    "osVersion": "Android 14",
    "appVersion": "1.0.0",
    "screen": { "width": 1080, "height": 2400, "density": 2.75, "rotation": 0 }
  },
  "deviceAuth": {
    "deviceId": "382915046",
    "password": "483920"
  }
}
// response 201（不再签发配对码）
{
  "sessionId": "s_7f3a...",
  "expiresAt": 1763190123456,
  "expiresIn": 3600,
  "accessToken": "<jwt>",
  "refreshToken": "<opaque>",
  "accessTokenExpiresIn": 900
}
```

### POST /sessions/claim-device
```jsonc
// request
{ "deviceId": "382915046", "password": "483920", "device": { ...控制端设备信息... } }
// response 200（与原 /claim 结构一致）
{
  "sessionId": "s_7f3a...",
  "host": { "model": "Pixel 8", "osVersion": "Android 14",
            "screen": { "width": 1080, "height": 2400, "density": 2.75, "rotation": 0 } },
  "accessToken": "<jwt>", "refreshToken": "<opaque>", "accessTokenExpiresIn": 900
}
```

### 统一错误响应
```json
{ "error": { "code": "DEVICE_LOCKED", "message": "密码错误次数过多，设备已临时锁定", "requestId": "uuid" } }
```

### 错误码表
| code | HTTP | 含义 |
|---|---|---|
| `INVALID_INPUT` | 400 | 参数校验失败 |
| `UNAUTHORIZED` | 401 | 凭证缺失/无效/过期 |
| `FORBIDDEN` | 403 | 角色无权执行 |
| `DEVICE_AUTH_FAILED` | 401 | 设备号或密码错误（与设备不存在响应一致，防枚举） |
| `DEVICE_NOT_ONLINE` | 404 | 凭据正确但没有可认领的在线会话 |
| `SESSION_NOT_FOUND` | 404 | 会话不存在或已结束 |
| `SESSION_FULL` | 409 | 控制端名额已满 |
| `DEVICE_LOCKED` | 429 | 密码连续错误，设备临时锁定 |
| `SESSION_CLOSED` | 410 | 会话已关闭 |
| `RATE_LIMITED` | 429 | 触发限流 |
| `INTERNAL` | 500 | 内部错误（不返回堆栈） |

---

## 3. WebSocket

- URL：`ws(s)://<host>/ws`；协议版本 `v=2`（信封与二进制帧头均校验）。
- **鉴权**：`Authorization: Bearer <accessToken>` 请求头。**禁止把令牌放进 URL 查询参数**；浏览器端不直连 WS，改用 REST 轮询。
- 服务端校验 JWT 的 `sid`、`role`、`jti`，并把连接绑定到对应房间。
- 心跳：服务端每 15s 发 WebSocket `ping`，30s 内未收到 `pong` 则断开（close 4002）。
- 单帧上限：文本 16KB，二进制 512KB；超限关闭 4009。
- WS close codes：`4000` 协议错误 / `4001` 会话关闭 / `4002` 心跳超时 / `4003` 鉴权失败 / `4009` 帧过大。

### 文本帧（JSON 信封）
```jsonc
{
  "v": 2,
  "type": "control.tap",
  "ts": 1763190123456,
  "seq": 42,
  "payload": { "x": 0.4213, "y": 0.7301 }
}
```
`seq` 由发送端单调递增，用于对端丢弃乱序/重复指令。

| type | 方向 | payload |
|---|---|---|
| `ping` / `pong` | 双向 | `{}` |
| `session.ready` | S→C | `{ sessionId, role, peerOnline }` |
| `session.peer_joined` | S→两端 | `{ role, deviceId }` |
| `session.peer_left` | S→两端 | `{ role, graceMs }` |
| `session.closed` | S→两端 | `{ code, reason }` |
| `session.error` | S→C | `{ code, message }`，如 `NOT_AUTHORIZED` |
| `session.authorize_request` | S→H | `{ sessionId, controller: { model, osVersion } }` |
| `session.authorize_grant` | H→S | `{}`，服务端本地消费，不转发 |
| `session.authorize_deny` | H→S | `{ reason? }`，服务端关闭会话 |
| `session.authorize_state` | S→两端 | `{ authorized, reason? }` |
| `stream.config` | H→C | `{ width, height, density, rotation, codec:"h264", mime }` |
| `stream.start` / `stream.stop` | H→C | `{}` |
| `stream.keyframe_request` | C→H | `{}` |
| `device.state` | H→C | `{ battery, orientation, screenOn }` |
| `control.tap` | C→H | `{ x, y }` 归一化 0..1 |
| `control.long_press` | C→H | `{ x, y, durationMs }` |
| `control.swipe` | C→H | `{ x1, y1, x2, y2, durationMs }` |
| `control.scroll` | C→H | `{ x, y, dx, dy }` |
| `control.key` | C→H | `{ keyCode }` Android KeyEvent 常量 |
| `control.text` | C→H | `{ text }` UTF-8，最长 512 字符 |
| `control.home` / `control.back` / `control.recents` | C→H | `{}` |
| `control.ack` | H→C | `{ seq, ok, error? }` |
| `stats` | S→observer | 仅 REST `/admin/overview` 暴露 |

> **坐标约定**：所有坐标是相对屏幕宽高的归一化浮点 `0..1`。受控端按自身当前分辨率与旋转换算成像素再注入。禁止控制端发送绝对像素。

### 授权门禁（v2，硬约束）

| 状态 | 服务端行为 |
|---|---|
| 未授权 | `controller` 发出的任何 `CONTROL_TYPES` 帧一律不转发，回 `session.error(code=NOT_AUTHORIZED)`；host 不应推流 |
| 已授权 | 正常转发；授权记录绑定 `deviceId`，仅同一控制端重连可免二次确认 |
| 拒绝 | 服务端 `close(sessionId)`，双端收 `session.closed(4001)` |
| 会话结束 | 授权随会话销毁；受控端本地 `SessionGate` 同步置为不可用 |

受控端本地还有第二道门控：即使系统无障碍服务仍处于开启状态，未获本会话授权时 `RemoteAccessibilityService.dispatch()` 直接拒绝注入。所有下发指令与授权决定写入应用私有目录的 `remote-assist-audit.log`（只记类型、序号、结果，不记文本内容或画面）。

### 二进制帧（视频）
固定 12 字节头，小端序写入 `magic/version/type/flags`，时间戳大端序 uint64：

| offset | size | field | 说明 |
|---|---|---|---|
| 0 | 1 | `magic` | 固定 `0xA5` |
| 1 | 1 | `version` | **2** |
| 2 | 1 | `frameType` | 1=config(SPS/PPS) 2=keyframe(IDR) 3=delta(P) 4=jpeg-preview |
| 3 | 1 | `flags` | bit0=时间戳有效 |
| 4 | 8 | `timestampMs` | uint64 BE，单调时钟 |
| 12 | n | payload | H.264 Annex-B NALU 或 JPEG 字节 |

`frameType=1` 的 config 帧必须作为首帧发送，并在每次分辨率/旋转变化后重发。
服务器只做**透明转发 + 长度/速率校验**，不解码、不落盘、不缓存。

### 转发规则（服务端 RBAC + 授权门禁）
| 发送方 | 帧类型 | 允许目标 |
|---|---|---|
| host | binary / `stream.*` / `device.state` / `control.ack` | 房间内 controller |
| controller | `control.*` / `stream.keyframe_request` | 房间内 host，**且会话已授权** |
| controller | binary | **拒绝**（close 4000） |
| observer | 任意 WS 帧 | 不允许建立 WS |

---

## 4. 安全约束

1. JWT `HS256`，access token TTL 15min；refresh token 为 32 字节随机数，仅存服务端内存并绑定 `jti`，刷新后轮换。
2. 令牌不得写入 `localStorage`、不得出现在 URL query、不得写入日志。Android 端存 `EncryptedSharedPreferences`。
3. CORS 使用显式白名单，生产禁用 `*`。
4. **密码失败锁定按设备号计数**，并在 `/claim-device` 叠加按 deviceId 限流；限流键在 `TRUST_PROXY=false` 时取真实 TCP 对端，启用 `TRUST_PROXY` 必须由边缘反代覆盖 `X-Forwarded-For` 且容器端口不得直曝。
5. **控制指令必须经被协助者在会话内显式授权**，授权绑定控制端设备；配合系统投屏授权与无障碍服务开关，构成三道确认。
6. 服务端不缓存任何屏幕内容；受控端常驻「随时断开」通知，会话结束立即释放 MediaProjection 与本地注入能力。
7. release 构建禁用明文 HTTP、不预置任何服务器地址；明文地址仅存在于 debug 变体。
8. 所有输入在边界用 zod / Kotlin 端手工校验，绝不信任客户端坐标与文本长度。
