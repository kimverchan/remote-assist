# 架构决策与工程约定

## 1. 系统组成

| 模块 | 目录 | 技术 | 职责 |
|---|---|---|---|
| 中继服务器 | `server/` | Node 22 + TypeScript + Express + ws | 配对、鉴权、WebSocket 房间转发、健康检查 |
| 受控端 | `android-host/` | Kotlin + MediaProjection + MediaCodec + AccessibilityService | 采集屏幕、H.264 编码推流、注入操作 |
| 控制端 | `android-controller/` | Kotlin + MediaCodec + OkHttp | 输入设备号 + 6 位密码、解码显示、手势映射 |
| Web 运维看板 | `web-console/` | Vite + React + TypeScript | 只读监控会话/设备/流量 |
| 协议 | `docs/PROTOCOL.md` | — | 三端唯一权威约定 |

**为什么控制端是原生 App 而不是 Web**：需求明确为「另一台安卓手机」发起协助。Web 看板因此被限定为只读运维面板，不承担控制能力，避免出现两个控制入口造成权限与状态竞争。

## 2. 分层

```
HTTP / WS 边界
  controller     解析请求、调用服务、格式化响应，不含业务规则
  service        业务规则与编排（配对状态机、令牌签发、转发策略）
  repository     内存状态访问（会话、令牌）+ 设备凭据持久化（peppered 摘要），带 TTL 清理
  gateway        WebSocket Upgrade 与房间，是独立的传输适配器
```

依赖方向单向向下，service 不 import `express` / `ws` 的请求类型。所有模块通过构造函数注入依赖，便于单测替换仓储。

## 3. 关键决策与理由

| 决策 | 理由 |
|---|---|
| 按功能组织目录（features/pairing、auth、session、health） | 同一功能的内聚变更只需改一个目录 |
| 会话内存仓储 + 设备凭据 JSON 持久化，不引入数据库 | 会话是「断开即失效」的易失状态；设备凭据需跨重启保留但只存摘要，JSON 足够且避免引入数据库 |
| 归一化坐标 0..1 | 两端分辨率/旋转不同，禁止控制端假设像素 |
| 视频走二进制帧、指令走文本帧 | 单一连接上隔离大流量与控制指令，避免队头阻塞 |
| access 15min + 服务端 refresh 轮换 | 远程控制权限极高，短时效 + 可撤销 |
| 心跳由服务端发起 | 客户端只回 pong，避免时钟漂移与伪造心跳 |
| 服务器不解码、不落盘视频 | 中继无状态，降低合规风险与内存占用 |
| 集中配置 + 启动校验 | 缺 `JWT_SECRET` 等直接退出，避免带病启动 |

## 4. 迁移到 Redis / 多实例

当前为单进程内存仓储。水平扩展时只需替换三个 Repository 实现：

- `PairingRepository` → Redis `SETEX pairing:<code>` + `INCR attempts:<code>`
- `SessionRepository` → Redis Hash + TTL，房间状态用 Pub/Sub 广播
- `TokenRepository` → Redis `SET refresh:<hash> <jti> EX 86400`

service 与 controller 无需改动；WebSocket 需增加粘性会话或跨节点 Pub/Sub 转发。

## 5. 上线前加固清单

- [ ] `JWT_SECRET`、`ADMIN_API_KEY` 换成 32 字节以上随机值，仅存环境变量
- [ ] `NODE_ENV=production`，`CORS_ORIGINS` 去掉本地地址
- [ ] 全链路 HTTPS / WSS；`TRUST_PROXY` 仅在「容器端口不对外 + 反代覆盖 XFF」时开启，反代需透传 WS Upgrade
- [ ] 配置反向代理层限流（当前进程内限流仅单实例有效；设备密码另有按设备计数与失败锁定，与 IP 无关）
- [ ] 开启 `MAX_SESSIONS` 告警与 `/ready` 探针接入编排系统
- [ ] Android 端接入证书锁定（certificate pinning）
- [x] 会话级授权：未获受控端确认前不推画面、不转发 `control.*`，授权绑定控制端设备（v2）
- [x] 受控端「随时断开」常驻通知 + 本地操作审计日志（`SessionGate` / `OperationAudit`，v2）
- [x] debug / release 网络配置隔离：明文地址与预置隧道仅存在 debug 变体（v2）
- [ ] 屏幕内容合规：不录制、不落盘、会话结束立即释放 MediaProjection

## 6. 已知边界

- 服务器为单进程，重启会清空全部会话（符合安全模型，但需客户端自动重连并重新配对）。
- H.264 编码参数在受控端按设备能力自适应；低端机可能降帧率，协议未做码率协商（后续可加 `stream.quality`）。
- Web 看板用 2s REST 轮询而非 WebSocket，因为浏览器 WebSocket API 无法自定义 `Authorization` 头，而规范禁止令牌出现在 URL 中。
