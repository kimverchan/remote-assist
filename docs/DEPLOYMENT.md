# 生产部署指南（必须支持 WebSocket）

中继服务器是**单端口 HTTP 服务**：REST 接口与 WebSocket `/ws` 共用一个端口。视频二进制帧和触控指令全部走 WebSocket，因此部署平台的反向代理**必须透传 HTTP Upgrade**，否则整个远程协助不可用。

---

## 1. 为什么不能用 WorkBuddy 的临时发布链接

2026-11-15 实测（发布网关 `CloudStudio Gateway`）：

| 请求 | 结果 |
|---|---|
| `GET /health?sharecode=...` | 200，正常到达后端 |
| `POST /api/v1/sessions?sharecode=...` | 400（缺 deviceAuth）；带 deviceAuth 时 201 |
| WebSocket Upgrade 到 `/ws`，分别带 `sharecode` / `__wb_rsc` Cookie / `Origin` 四种组合 | 全部 `401`，响应头 `Server: CloudStudio Gateway` |
| WebSocket Upgrade 到普通 REST 路径 `/health` | 网关 `404`，同一路径普通 GET 却是后端 `200` |

结论：该网关**不代理 Upgrade 请求**，请求根本到不了后端。加上它要求每个请求携带 `sharecode`（或持有其下发的 Cookie），临时发布链接只适合 REST / 运维看板调试，**不能**用于两台手机的真实远程协助。该链接已下线。

因此跨网联调要选下面任一类平台。

---

## 2. 平台硬性要求

- 一个公网端口，同时承载 HTTP 与 WebSocket（本服务已支持 `PORT` 注入、`0.0.0.0` 绑定）。
- 反代透传 `Upgrade` / `Connection` 头，且**空闲超时 ≥ 60s**（服务端 15s 心跳）。
- 提供 HTTPS/WSS；Android 端填 `https://` 域名时会自动转成 `wss://`（两端 `RelayClient.wsUrl()` 已实现）。
- 允许长连接与二进制帧（单帧上限默认 512 KB）。
- 部署后用第 6 节的脚本**实测 Upgrade**，不要只看「平台文档写了支持」。
- **纯公网 IP 拿不到公开可信证书**：Let's Encrypt 不为 IP 地址签发，Caddy 对 IP 只会出自签证书，而 release 包强制 HTTPS 且不信任自签证书。若坚持只用 IP，只能走 HTTP 明文 + debug 包：在服务器 `deploy/` 执行 `bash switch-ip-http.sh`（等价 `docker compose -f docker-compose.ip-http.yml up -d --build --remove-orphans`，两个编排共用 project name，会自动移除 Caddy），见 README「只想用公网 IP 访问」（仅临时联调，画面与指令明文过公网）。

---

## 3. 环境变量

`server/src/config/env.ts` 在启动时用 zod 校验，缺失或非法会**拒绝启动**（fail fast）。

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `JWT_SECRET` | ✅ | — | ≥32 字符随机值，签发 access token |
| `ADMIN_API_KEY` | ✅ | — | ≥16 字符随机值，运维看板换取 observer token |
| `PORT` | — | `3000` | 平台注入时自动生效；本地可在 `.env` 覆盖成 8080 |
| `HOST` | — | `0.0.0.0` | 容器/公网必须为 `0.0.0.0` |
| `NODE_ENV` | — | `development` | 生产设 `production` |
| `TRUST_PROXY` | — | `false` | **仅当**容器端口不对外开放、且边缘反代会覆盖 `X-Forwarded-For` 时才设 `true`；否则保持 `false` |
| `TRUST_PROXY_HOPS` | — | `1` | 启用 `TRUST_PROXY` 时可信的代理跳数（一般只有一层反代） |
| `CORS_ORIGINS` | — | `http://localhost:5173` | 逗号分隔；只填 Web 运维看板的源。Android 原生请求不受 CORS 限制 |
| `LOG_LEVEL` | — | `info` | `debug` / `info` / `warn` / `error` |
| `MAX_FRAME_BYTES` | — | `524288` | 单个 WS 帧上限，视频码率调高时需同步调大 |
| `RATE_LIMIT_MAX` | — | `60` | 每 IP 每窗口请求数 |
| `HEARTBEAT_INTERVAL_MS` / `HEARTBEAT_TIMEOUT_MS` | — | `15000` / `30000` | 后者必须大于前者 |
| `SESSION_TTL` / `MAX_SESSIONS` | — | `3600` / `200` | 会话存活与并发上限 |
| `DEVICE_DATA_DIR` | — | `/app/data`（容器）/ `./data`（本地） | 设备凭据摘要持久化目录，需用卷挂载跨重启保留 |
| `DEVICE_LOCK_THRESHOLD` | — | 5 | 连续密码错误锁定阈值 |
| `DEVICE_LOCK_MINUTES` | — | 15 | 锁定时长（分钟） |
| `TEMP_PASSWORD_MAX_MINUTES` | — | 120 | 临时密码最长有效期（分钟）。设备号与 6 位密码由受控端 App 自动生成并注册，无需白名单配置。见 `docs/UNATTENDED.md` |

> ⚠️ `TRUST_PROXY=true` 时 Express 会用 `X-Forwarded-For` 解析客户端 IP。若容器端口直接暴露在公网，攻击者每请求换一个伪造 IP 就能重置按 IP 的限流桶。因此仓库的 `docker-compose.yml` 只把端口绑定到 `127.0.0.1`，并要求反代**覆盖**（而非透传）该请求头。设备密码认领另有「按 deviceId」限流与服务端失败锁定，与 IP 完全无关，是防 6 位数字密码枚举的最后一道硬上限。

生成密钥：

```bash
node -e "const c=require('crypto');console.log('JWT_SECRET='+c.randomBytes(32).toString('hex'));console.log('ADMIN_API_KEY='+c.randomBytes(24).toString('hex'))"
```

---

## 4. 四种部署方式

### 方式 A：Docker 直接运行（最通用）

```bash
# 在仓库根目录构建
docker build -t remote-assist-relay:latest ./server

# 运行
docker run -d --name remote-assist-relay --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -e NODE_ENV=production \
  -e TRUST_PROXY=true \
  -e TRUST_PROXY_HOPS=1 \
  -e CORS_ORIGINS=https://console.example.com \
  -e JWT_SECRET=<32字符随机值> \
  -e ADMIN_API_KEY=<16字符随机值> \
  remote-assist-relay:latest

docker logs -f remote-assist-relay
```

镜像为多阶段构建：构建阶段装全量依赖并 `tsc` 编译，运行阶段只保留生产依赖 + `dist/`，以非 root 用户运行，自带 `HEALTHCHECK`。

### 方式 B：docker compose（本地 / VPS 一键）

```bash
# 仓库根目录
JWT_SECRET=<32字符随机值> ADMIN_API_KEY=<16字符随机值> \
  docker compose up -d --build

docker compose ps        # STATUS 应为 healthy
docker compose logs -f
```

`docker-compose.yml` 用 `:?` 强制校验两个密钥，没设置会直接报错而不是带病启动。可用 `RELAY_PORT` 改宿主机映射端口。

### 方式 C：自有 VPS + Caddy / Nginx 反代（推荐用于正式上线）

> 现成的一键编排已放在仓库 `deploy/`：`docker-compose.yml` + `Caddyfile` + `deploy.sh` + `verify.sh`，直接按该目录的脚本执行，等价于下面方式 B + C 的组合，且已把 `TRUST_PROXY=true`、XFF 覆盖、长连接超时配好。

**Caddy**（自动申请证书、自动透传 WebSocket，配置最简）：

```
relay.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

**Nginx**（需要在 `http` 块定义 map）：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name relay.example.com;

    ssl_certificate     /etc/letsencrypt/live/relay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # 覆盖而非透传：客户端自带的 X-Forwarded-For 不可信，
        # 透传会让攻击者伪造 IP 绕过按 IP 的限流。
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 关键：长连接空闲超时必须大于 15s 心跳，否则会被反代掐断
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
```

`proxy_buffering off` 与 `proxy_http_version 1.1` 不能省，前者避免帧被缓存、后者是 Upgrade 的前提。

### 方式 D：PaaS（Railway / Render / Fly.io 等）

1. 选择 **Dockerfile 部署**，构建上下文指向 `server/`，端口用平台注入的 `PORT`。
2. 在平台控制台配置第 3 节的必填变量。平台网关若会**覆盖** `X-Forwarded-For` 可设 `TRUST_PROXY=true` 与 `TRUST_PROXY_HOPS=1`；不确定时保持 `false`（按码限流与失败锁定仍生效）。
3. 绑定自定义域名并启用平台提供的 HTTPS。
4. 部署完立刻跑第 6 节的验证脚本。**若 WS 用例失败，说明该平台/套餐的网关不透传 Upgrade，换平台或改用方式 C。**

> 每个平台的反代行为会变，务必以实测结果为准，不要只看文档里的「支持 WebSocket」。

---

## 5. 上线前安全清单

- [ ] `JWT_SECRET` / `ADMIN_API_KEY` 换成强随机值，且不进入代码库。
- [ ] `TRUST_PROXY` 仅在「容器端口不对外 + 反代覆盖 XFF」时开启；反代用 `$remote_addr` 覆盖 `X-Forwarded-For`，不要 `$proxy_add_x_forwarded_for` 透传。
- [ ] `CORS_ORIGINS` 只列 Web 看板域名，不要写 `*`。
- [ ] 全链路 HTTPS/WSS；**只分发常规 release 包**（`dist/release/`，强制 HTTPS 且不预置地址）。`dist/ip-http/` 的 IP 直连专用包虽是正式签名，但放开了明文 HTTP 且写死 `http://8.138.221.245:3000`，仅限临时联调、禁止分发。
- [ ] 两端 App 首页填 `https://relay.example.com`（不要带 `?sharecode=`，那是 WorkBuddy 网关专用）。
- [ ] 网关层再加一层限流；当前服务内限流是单进程固定窗口，多实例部署需外置。设备密码另有按 deviceId 限流与失败锁定（与 IP 无关）。
- [ ] 确认受控端「允许协助」通知能正常弹出（Android 13+ 需授予 `POST_NOTIFICATIONS`）；被协助者未确认前不推画面、不下发操作。
- [ ] 会话是内存态，重启即全部失效（符合「断开即失效」安全模型）；不要为此加持久化。
- [ ] Web 运维看板 `VITE_API_BASE_URL` 指向该域名；看板只存内存中的 observer token。

---

## 6. 部署后验证

```bash
# 1) 基础健康
curl -i https://relay.example.com/health
curl -i https://relay.example.com/ready

# 2) 全链路（REST + 双端 WS 文本/二进制帧），在 server/ 目录下执行
cd server
BASE_URL=https://relay.example.com node scripts/verify-remote.mjs
```

脚本会检查：健康检查与 requestId、无令牌 401、创建会话（设备号 + 6 位密码自动注册）、错误密码锁定、双端 WS 握手、`session.ready` / `session.peer_joined`、双向文本帧转发、二进制视频帧逐字节一致、refresh 轮换与旧令牌失效、越权指令 `close 4000`、非法令牌拒绝建连。**全部 PASS 才说明这条链路能跑真实远程协助。**

若 `BASE_URL` 是 WorkBuddy 临时发布链接（带 `?sharecode=`），脚本会把 sharecode 附加到每个请求上；此时 WS 用例必然失败，属已知平台限制。

本地对照：`npm run smoke` 会自动拉起本机服务跑同一批用例，用于区分「代码问题」和「平台问题」。

---

## 7. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| WS 握手 401，响应头是网关名、带网关 trace id | 平台不代理 Upgrade | 换平台或改用方式 C 自建反代 |
| WS 握手 401，响应来自后端 | 令牌无效 / 会话已过期 / 同角色重复连接 | 重新配对；确认两端没有用同一 role 连两次 |
| WS 握手 426 或直接超时 | 反代没透传 `Upgrade` / `Connection` | 检查 Nginx map 与 `proxy_http_version 1.1` |
| 连上后约 30~60s 断开 | 反代空闲超时短于心跳 | 调大 `proxy_read_timeout` / 平台 idle timeout 至 ≥ 60s |
| 大画面帧被拒、连接 `close 1009` | `MAX_FRAME_BYTES` 小于实际帧 | 调大该值，或降低 `ScreenEncoder` 码率/分辨率 |
| Web 看板 401 或 CORS 报错 | `ADMIN_API_KEY` 不对 / 域名不在白名单 | 核对密钥，把看板源加入 `CORS_ORIGINS` |
| `curl: (6) Could not resolve host: relay.example.com` | `deploy/.env` 里还是示例占位域名，或真实域名未配 A 记录 | 把 `RELAY_DOMAIN` 改成真实域名后 `docker compose up -d --force-recreate caddy`（Caddyfile 用环境变量注入，必须重建才生效）；只想先验服务本身用 `bash verify.sh http://127.0.0.1:3000` |
| 服务启动即退出，日志提示环境变量校验失败 | 密钥缺失或过短、心跳超时 ≤ 心跳间隔 | 按日志逐项修正 |
| IP 直连模式手机连不上，服务器本机 `curl 127.0.0.1:3000/health` 正常 | 云安全组 / firewalld / ufw 没放行 TCP 3000，或 relay 仍绑在 `127.0.0.1` | `docker port remote-assist-relay 3000/tcp` 应看到 `0.0.0.0:3000`；放开端口后从外网 `curl http://<公网IP>:3000/health` |
| debug 包一直连到旧的 natapp 隧道地址 | debug 变体预置了 `http://sfedf6bb.natappfree.cc`，且保存过的值不会被覆盖 | 在两端 App 首页手动清空并改成 `http://<公网IP>:3000`，两端必须完全一致；release 包会直接拒绝 `http://` |
| 本机 `bash deploy/upload.sh ...` 报 `<3>WSL ... execvpe(/bin/bash) failed: No such file or directory` | Windows 把 `bash` 解析成 `C:\Windows\System32\bash.exe`（WSL 启动器），默认发行版只有 `docker-desktop`，其中没有 `/bin/bash` | 与服务器无关；**不要改默认发行版或重装 WSL**（Docker Desktop 正依赖它）。用 `powershell -ExecutionPolicy Bypass -File deploy\upload.ps1 root@<公网IP>`，或直接 `scp` 已生成的 `dist/relay-deploy.tgz` 再 `ssh` 解压；也可在 Git Bash 里执行 |
| 本机 `docker build` 报守护进程不可用 | 本机 Docker Desktop 引擎因 WSL 半安装起不来 | 见 `docs/WSL-FIX.md`；或直接用第 8 节的本地 Node 路径 |
| 受控端点「开始协助」后报「连接中继服务器超时 / 连接被拒绝 / 无法解析」 | 中继服务未启动、地址或端口填错、安全组未放行，或 `/ws` 通道不可用 | App 会红色报错并给排查指引，按 README「### 4. 连不上中继服务器时的报错与排查」逐项核对，修好后点「重试连接」；首次握手连续失败 3 次即停止无限重连 |

---

## 8. 已知边界

- 单进程中继：水平扩展需把三个 Repository 换成 Redis，并在网关层做会话粘滞，见 `docs/ARCHITECTURE.md`。
- 编码器固定 2 Mbps / 30fps / 长边 1280，无码率自适应；弱网可能卡顿。
- 两个 Android 工程可用 `bash scripts/build-apk.sh all debug|release` 命令行打包（本机 JDK 21 + 缓存的 Gradle 8.7），产物分别落在 `dist/debug/` 与 `dist/release/`；release 包强制 HTTPS，不含临时隧道地址。另有 `bash scripts/build-apk-ip-http.sh` 通过 `-P` 参数产出「允许明文 HTTP + 预置 `http://8.138.221.245:3000`」的正式签名包到 `dist/ip-http/`（不带参数构建时 release 安全语义不变），仅用于纯 IP 直连临时联调。
- **本机 Docker 引擎已恢复（2026-11-18，v29.9.2）**：`docker build -t remote-assist-relay:latest ./server` 多阶段构建通过；实跑容器 `/health`、`/ready` 均返回 200，并以非 root 的 `node` 用户运行。`caddy:2-alpine` 校验 `deploy/Caddyfile` 结果为 `Valid configuration`，`caddy adapt` 确认 `X-Forwarded-For` 为覆盖式 `set`。若再次遇到引擎启动失败，诊断与修复见 `docs/WSL-FIX.md`。

### 不依赖 Docker 的运行方式（已实测）

Docker 不是运行中继的前提。本机 Node 进程在生产配置下已跑通全链路：

```bash
cd server
npm run build
# 本地直连验证：没有边缘反代，TRUST_PROXY 必须为 false
PORT=3000 NODE_ENV=production TRUST_PROXY=false \
JWT_SECRET=<32字符随机> ADMIN_API_KEY=<16字符随机> \
node dist/index.js

# 另一个终端（协议 v2，三端需同步升级）
BASE_URL=http://127.0.0.1:3000 node scripts/verify-remote.mjs   # 23 项用例
npm run smoke                                                    # 31/31 PASS
```
