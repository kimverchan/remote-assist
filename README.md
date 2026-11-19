# 安卓远程协助系统

一套可运行的远程协助方案：**受控端 Android App + 控制端 Android App + Node/TS 中继服务器 + React 只读运维看板**。
受控端 App 自动生成 **9 位设备号 + 6 位数字密码**（首次安装即生成，重装保持稳定），协助者在自己手机上输入设备号和密码即可连接；**受控端默认在通知里自动点「允许协助」**（可关闭改为人工确认）。会话期间常驻通知可随时断开。

---

## 目录结构

```
.
├── server/                 中继服务器（Node 22 + TypeScript + Express + ws）
│   ├── src/
│   │   ├── config/         集中配置与环境变量启动校验
│   │   ├── shared/         协议常量、类型化错误、结构化日志、中间件
│   │   └── features/       pairing / auth / session / health（按功能分层）
│   ├── scripts/            smoke.mjs（本地）、verify-remote.mjs（线上全链路）
│   ├── Dockerfile          多阶段生产镜像（非 root + HEALTHCHECK）
│   └── .dockerignore
├── docker-compose.yml      本地一键起中继容器（强制校验两个密钥，端口仅绑回环）
├── deploy/                 ★ 云服务器生产部署包（relay + Caddy 自动 HTTPS，一键脚本）
├── android-host/           受控端 App（Kotlin）
├── android-controller/     控制端 App（Kotlin）
├── web-console/            Web 只读运维看板（Vite + React + TS）
├── docs/
│   ├── PROTOCOL.md         ★ 三端唯一权威协议约定（v2）
│   ├── ARCHITECTURE.md     架构决策、迁移路径、上线加固清单
│   ├── DEPLOYMENT.md       ★ 生产部署指南（平台要求、反代 WS 配置、验证）
│   └── WSL-FIX.md          本机 Docker Desktop / WSL 启动故障的诊断与修复
├── dist/
│   ├── debug/              调试包（可含临时明文隧道地址）
│   └── release/            正式签名包（强制 HTTPS、不预置地址）
└── .env.example            环境变量模板（仅占位值）
```

> `dist/` 根目录还留有 4 个 v1 历史包（`*-natapp.apk` 与旧 `*-release.apk`），仅供回溯，**请勿分发**：它们使用 v1 协议、预置明文隧道地址，与 v2 服务端不兼容。常规新产物在 `dist/debug/` 与 `dist/release/`，IP 直连专用包在 `dist/ip-http/`。

## 快速启动

### 1. 中继服务器

```bash
cd server
cp .env.example .env          # Windows: copy .env.example .env
# 编辑 .env，把 JWT_SECRET 改成 32 字符以上随机值，ADMIN_API_KEY 改成随机值
npm install
npm run build
npm start                     # 按 .env 为 8080；未设 PORT 时默认 3000
```

验证：

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/ready
npm run smoke                 # 端到端冒烟：REST + 失败锁定 + 授权门禁 + 双端 WS
```

`JWT_SECRET`、`ADMIN_API_KEY` 缺失或过短时服务**拒绝启动**（fail fast）。

### 2. Web 运维看板（可选）

```bash
cd web-console
cp .env.example .env.local    # 设置 VITE_API_BASE_URL
npm install
npm run dev                   # http://127.0.0.1:5173
```

用 `.env` 中的 `ADMIN_API_KEY` 登录。看板**只读**：显示会话、设备、在线状态、授权状态与转发流量，不显示画面、不能下发指令。

### 3. 两个 Android App

用 Android Studio 分别打开 `android-host/` 与 `android-controller/`，安装到两台真机：

- SDK Platform 35、Build Tools 35、JDK 17、Gradle 8.7
- 两个 App 的首页都填入**同一个**中继服务器地址（真机同 WiFi 填 `http://<电脑局域网IP>:8080`；模拟器填 `http://10.0.2.2:8080`；release 包必须填 `https://`）
- 受控端需先在系统设置里开启「远程协助 · 受控端」无障碍服务，否则只能看画面、不能操作
- 受控端首次启动自动生成设备号与 6 位密码 → 点「开始协助」并确认投屏 → 控制端输入设备号 + 密码 → **受控端自动同意（或人工点「允许协助」）** → 开始共享画面并允许操作

命令行打包（无需 Android Studio，脚本自动选用本机 JDK 21 + 缓存的 Gradle 8.7）：

```bash
bash scripts/build-apk.sh all debug     # 调试包 → dist/debug/
bash scripts/build-apk.sh all release   # 正式签名包 → dist/release/（v2 + v3；minSdk 26 无需 v1）
```

**debug / release 网络配置已隔离**：`BuildConfig.DEFAULT_SERVER` 只在 debug 变体预置跨网联调用的临时隧道地址；release 变体为空且 `ALLOW_CLEARTEXT=false`，强制用户填写 `https://` 地址。明文 HTTP 仅由 `app/src/debug/AndroidManifest.xml` 开启，正式包默认禁止。两个变体都**不会覆盖用户已保存的地址**。

正式包使用仓库根 `signing/remote-assist-release.jks`（别名 `remote-assist`，RSA 2048、30 年），密码写在 `keystore.properties`。**这两个文件已被 `.gitignore` 排除，必须自行离线备份**：密钥丢失就无法再为同包名应用签发升级包，密码泄露则他人可冒名签发。分发前校验：

```bash
/d/Android/Sdk/build-tools/34.0.0/apksigner.bat verify --verbose --print-certs <apk>
```

**IP 直连专用正式包（明文 HTTP + 预置地址，仅临时联调）**：常规 release 包强制 `https://`，而纯公网 IP 拿不到公开可信证书。用 `scripts/build-apk-ip-http.sh` 通过 Gradle `-P` 参数注入，产出两个**正式签名**的 release 包，单独放在 `dist/ip-http/`，不覆盖 `dist/release/`：

```bash
bash scripts/build-apk-ip-http.sh                      # 默认 http://8.138.221.245:3000
bash scripts/build-apk-ip-http.sh http://1.2.3.4:3000 # 换服务器地址
```

`-PrelayDefaultUrl=... -PrelayAllowCleartext=true` 把 `DEFAULT_SERVER`、`ALLOW_CLEARTEXT` 写进 release 的 `BuildConfig`，并让 `app/src/release/AndroidManifest.xml` 的 `usesCleartextTraffic` placeholder 变成 `true`；**不带参数构建时 release 仍然强制 HTTPS、不预置地址、禁止明文**，默认安全语义不变。产物与 `dist/release/` 用同一把证书（v2 + v3 签名，可直接覆盖安装）；但 App **不会覆盖已保存的地址**，若之前填过别的地址，需清除应用数据 / 卸载重装，或手动改成同一地址。两端都填 `http://8.138.221.245:3000`。

> ⚠️ 这类包把画面、控制指令、设备号与密码、JWT 全部明文过公网，且地址写死。**仅限配合 `deploy/switch-ip-http.sh` 临时联调，禁止对外分发或用于真实协助**；要正式分发请用 `dist/release/` 的 HTTPS 包并配真实域名。

> release 包与 debug 包签名不同，覆盖安装会失败，需先卸载旧版（`adb uninstall com.pcxx.remote.host` / `com.pcxx.remote.controller`），卸载后无障碍服务要重新开启。
> 为保持离线可复现，release 构建关闭了 `lintVital`（`checkReleaseBuilds = false`）；需要完整检查时联网单独执行 `:app:lintRelease`。

### 4. 连不上中继服务器时的报错与排查

受控端点「开始协助」后如果**连不上中继服务器**，会明确报错，不再静默卡住：

| 失败阶段 | 触发条件 | 界面表现 |
|---|---|---|
| 建会话 REST 请求 | 连接超时 / DNS 解析失败 / 连接被拒 / HTTPS 证书错误 / HTTP 4xx·5xx | 状态栏红色错误文案 + 一次 Toast 摘要 |
| 建会话长时间无响应 | 超过 20 秒仍无结果 | 按「连接超时」报错 |
| WebSocket 首次握手 | 从未连通过且连续失败 3 次（如反代未透传 `/ws` 的 Upgrade） | 报出失败原因与重试次数，停止无限重连 |

报错为「中文可读结论 + 排查指引」（① 中继服务是否已启动 ② 地址含端口是否填对 ③ 手机网络与服务器安全组是否放行），同时自动释放屏幕采集与前台通知，开始按钮变为「重试连接」；修好服务器后直接点它即可重新授权并连接。**曾经连上后掉线**仍保留原有的指数退避重连（会话宽限期恢复），不会误报为连接失败。

排查顺序：`curl http://<地址>/health` 验证服务 → 核对两端 App 首页地址（含端口）与协议（`http://`↔`ws://`、`https://`↔`wss://`）→ 检查手机网络与云安全组 → HTTPS 模式下检查证书。

> 控制端已改为单一「设备号 + 6 位密码」入口，服务端 401/404/429 均返回统一中文文案，两端口径一致。

## 生产部署（跨网 / 公网）

> ⚠️ 中继的 WebSocket 是核心通道，**部署平台必须透传 HTTP Upgrade**。WorkBuddy「发布为应用」的临时链接实测不透传 Upgrade，只能用于 REST / 运维看板调试，不能让两台手机完成远程协助，详见 `docs/DEPLOYMENT.md`。

**自有云服务器（已装 Docker）→ 用 `deploy/` 一键部署包（推荐）**：把中继与 Caddy 编成两个容器，Caddy 自动申请/续期 Let's Encrypt 证书、透传 WebSocket、覆盖 `X-Forwarded-For`；relay 端口仍只绑 `127.0.0.1`。

```bash
# ① 本地打包上传（Windows Git Bash；也可用面板/rsync，注意排除 node_modules、dist、.env）
tar czf relay-deploy.tgz --exclude=node_modules --exclude=dist --exclude=.env server deploy
scp relay-deploy.tgz user@<公网IP>:/opt/
ssh user@<公网IP> 'mkdir -p /opt/remote-assist-relay && tar xzf /opt/relay-deploy.tgz -C /opt/remote-assist-relay'

# ② 前置：域名 A 记录指向该机，云安全组放行 TCP 80/443（不要放行 3000）
cd /opt/remote-assist-relay/deploy
bash deploy.sh relay.example.com      # 生成强随机密钥 → 构建 → 启动 → 健康检查
bash verify.sh                        # REST + 双端 WS 全链路验证
```

> **验证报 `curl: (6) Could not resolve host: relay.example.com`**：说明 `.env` 里还是示例占位域名（DNS 不存在）。把 `RELAY_DOMAIN` 改成真实域名后执行 `docker compose up -d --force-recreate caddy`（Caddyfile 由环境变量注入，必须重建才生效）；暂时没有域名可先用 `bash verify.sh http://127.0.0.1:3000` 只验证服务本身。更多排查见 `docs/DEPLOYMENT.md` 第 7 节。

> **服务器是密码登录时**：`scp` / `ssh` 命令里不用写密码，执行时会各自交互式提示 `password:`（输入不回显属正常，共两次）。把 `user@<公网IP>` 换成真实用户名与公网 IP；SSH 非 22 端口用 `scp -P <端口>` / `ssh -p <端口>`。不想反复输密码可配公钥免密，或直接用 `bash deploy/upload.sh user@<公网IP> [端口]` 一键上传（脚本自动重新打包）。**密码不要写进命令行或脚本**——会留在 shell 历史与进程列表里。

> **在 Windows PowerShell / CMD 里执行 `bash ...` 报 `<3>WSL ... ERROR: CreateProcessCommon:881: execvpe(/bin/bash) failed: No such file or directory`**：这是本机 WSL 的问题，跟服务器和部署包无关。`C:\Windows\System32\bash.exe` 是 WSL 启动器，当默认发行版只有 `docker-desktop`（内部没有 `/bin/bash`）时就会失败——可用 `where bash` 与 `wsl --list --verbose` 确认。**不要为此改默认发行版或重装 WSL**，Docker Desktop 正在运行在该发行版上。绕开 bash 即可：
>
> ```powershell
> # 方式 1：PowerShell 原生上传脚本（只用 Windows 自带 tar/scp/ssh）
> powershell -ExecutionPolicy Bypass -File deploy\upload.ps1 root@<公网IP>
>
> # 方式 2：包已生成好时直接两条命令，连打包都不用
> scp dist\relay-deploy.tgz root@<公网IP>:/opt/
> ssh root@<公网IP> "mkdir -p /opt/remote-assist-relay && tar xzf /opt/relay-deploy.tgz -C /opt/remote-assist-relay"
> ```
>
> 在 Git Bash 里执行则不受影响（那里 `bash` 是 Git 自带实现，不是 WSL 启动器）；**服务器是 Linux，`bash switch-ip-http.sh` 照常可用**，不受本机 WSL 影响。

`deploy/` 内含 `docker-compose.yml`（`TRUST_PROXY=true`，限流按真实客户端 IP）、`Caddyfile`（3600s 长连接超时）、`docker-compose.ip-http.yml`（纯 IP 明文直连）、`.env.example`、`upload.sh`（Git Bash 上传）、`upload.ps1`（PowerShell 上传，无需 WSL）、`deploy.sh`（HTTPS 域名部署）、`switch-ip-http.sh`（切到 IP 直连）、`verify.sh`（线上验证）。后续更新只需重传 `server/` 再跑 `bash deploy.sh`；域名与密钥写在 `deploy/.env`，请勿提交代码库。

### 只想用公网 IP 访问（不配域名）

**先看清约束**：release 包强制 `https://`，而 Let's Encrypt 不给纯 IP 签发公开可信证书（Caddy 对 IP 只会出自签证书，App 不信任）；debug 包才允许 `http://`。所以有两条路：

- **推荐 · 免费域名指向该 IP，HTTPS 架构一点不改**：注册免费 DDNS 子域（如 DuckDNS `xxx.duckdns.org`）把 A 记录填服务器公网 IP，或零注册用 `<公网IP>.nip.io`（此类公共后缀常被 Let's Encrypt 证书数量限流，签不下来就换 DDNS）。只改 `.env` 的 `RELAY_DOMAIN` / `CADDY_EMAIL` 两行，再 `docker compose up -d --force-recreate caddy`；App 仍填 `https://...`，**release 包可用**。
- **纯 IP 明文 HTTP（仅 debug 包 / 临时联调）**：`deploy/switch-ip-http.sh` 一条命令完成切换——用 `docker-compose.ip-http.yml` 把 relay 重建为 `0.0.0.0:3000`、`TRUST_PROXY=false`，并用 `--remove-orphans` 清掉 HTTPS 模式的 Caddy，随后自动做健康检查、全链路验证、探测公网 IP 并打印剩余步骤：

  ```bash
  # 本地：服务器上是旧部署包时先重传（密码交互式输入，共两次）
  bash deploy/upload.sh user@<公网IP>                       # Git Bash
  powershell -ExecutionPolicy Bypass -File deploy\upload.ps1 user@<公网IP>   # Windows PowerShell / CMD
  # 或只传新增/修改的三个文件：
  scp deploy/docker-compose.ip-http.yml deploy/switch-ip-http.sh deploy/verify.sh user@<公网IP>:/opt/remote-assist-relay/deploy/

  # 服务器
  cd /opt/remote-assist-relay/deploy
  bash switch-ip-http.sh
  ```

  也可手动执行 `docker compose -f docker-compose.ip-http.yml up -d --build --remove-orphans` 和 `bash verify.sh http://127.0.0.1:3000`。两个编排共用 `name: remote-assist-relay`，所以 `--remove-orphans` 能正确识别并移除 Caddy，切换前无需先 `stop`；切换脚本在 `.env` 缺失时会自动生成只含随机密钥的最小配置。

  云安全组与系统防火墙放行 **TCP 3000**（本模式唯一需要开的端口），从外网 `curl http://<公网IP>:3000/health` 确认可达。两个 App 装 `dist/debug/` 的包并填 `http://<公网IP>:3000`；**debug 包预置的是旧的 natapp 隧道地址 `http://sfedf6bb.natappfree.cc`，必须手动清空改成新地址，两端填的必须完全一致**（debug 与 release 签名不同，覆盖安装需先卸载；报 `INSTALL_FAILED_TEST_ONLY` 用 `adb install -t -r`）。该模式 `TRUST_PROXY=false`——无反代时 socket 对端就是真实客户端 IP，开 `TRUST_PROXY` 反而让伪造 `X-Forwarded-For` 绕过限流。**画面、指令、设备号与密码、JWT 全部明文过公网，仅供临时联调，禁止分发或用于真实协助**。切回 HTTPS 前先把 `.env` 的 `RELAY_DOMAIN` / `CADDY_EMAIL` 补成真实值，再 `docker compose up -d --build --remove-orphans`。

不用一键包时，也可用根目录 compose 手动起 relay，再自行配反代：

```bash
# 仓库根目录
docker build -t remote-assist-relay:latest ./server
JWT_SECRET=<32字符随机值> ADMIN_API_KEY=<16字符随机值> docker compose up -d --build

# 绑定公网域名后，验证 REST + 双端 WS 全链路
cd server && BASE_URL=https://relay.example.com node scripts/verify-remote.mjs
```

`docker-compose.yml` 只把容器端口绑定到 `127.0.0.1`，公网流量必须经反代接入；反代需覆盖 `X-Forwarded-For`（不能透传客户端自带值），否则 `TRUST_PROXY=true` 时按 IP 的限流可被伪造请求头绕过。`docs/DEPLOYMENT.md` 含环境变量表、Caddy / Nginx 反代的 WebSocket 配置、PaaS 部署要点、上线安全清单与故障排查表。两端 App 首页填 `https://<域名>`，代码会自动转成 `wss://`。

## 无人值守 / 免点击模式（可选）

设备号 + 6 位密码直连（类似向日葵）：受控端 App 自动生成 9 位设备号与 6 位数字密码（首页可复制），首次建会话自动注册到服务端；支持限时临时密码（默认 15 分钟）；断线 / 会话关闭 / 令牌过期自动重建会话。控制端输入设备号 + 密码即可连接。服务端只存 peppered 摘要、带失败锁定与双层限流，无需在 `.env` 配置白名单；`WebSocket` 的会话级授权流程保持不变。详见 `docs/UNATTENDED.md`。

> 普通安装（无 ADB / 无 root）**仍需一次性人工启用**：开无障碍服务 + 点一次系统投屏授权；投屏 token 被系统回收后也需再点一次。这是 Android 的平台限制，不是实现缺陷。完整的配置步骤、自动恢复边界、安全基线与 ADB 预置方案见 [`docs/UNATTENDED.md`](docs/UNATTENDED.md)。

## 协议摘要（v2）

完整约定见 `docs/PROTOCOL.md`。**v2 与 v1 不兼容**：信封 `v` 与二进制帧头 `version` 均为 2，三端必须同步升级。

| 项 | 约定 |
|---|---|
| 配对 | 6 位数字，60s TTL，一次性；**按码累计失败次数，5 次即作废旧码**（与 IP 无关） |
| 鉴权 | JWT HS256，access 15min；refresh token 服务端内存存储、刷新即轮换；WebSocket 用 `Authorization` 头 |
| 会话授权 | 控制端入房后服务端向受控端发 `session.authorize_request`（附协助者设备信息）；受控端点「允许」回 `authorize_grant` 后才转发 `control.*`；授权绑定控制端设备，`authorize_deny` 立即关闭会话 |
| 角色 | `host` / `controller` / `observer`，observer 只读且不允许建立 WS |
| 视频帧 | 二进制：12 字节头（magic/version=2/type/flags/uint64BE 时间戳）+ H.264 Annex-B NALU |
| 指令帧 | JSON 信封 `{v,type,ts,seq,payload}`，坐标一律归一化 `0..1` |
| 心跳 | 服务端每 15s ping，30s 无 pong 断开 |
| 错误 | 统一 `{error:{code,message,requestId}}`，客户端按码表映射中文，绝不返回堆栈 |

**安全底线**：令牌不进 URL 查询参数、不进 localStorage（Android 用 EncryptedSharedPreferences，Web 只存内存）；中继服务器不解码、不落盘、不缓存任何屏幕内容；未获会话授权前既不推画面也不下发指令；受控端常驻「随时断开」通知并写入本地操作审计日志（`filesDir/remote-assist-audit.log`，只记类型/序号/结果，不记文本内容与画面）；受控端断开即销毁会话、令牌与本地注入能力。

## 已完成的验证

| 检查 | 结果 |
|---|---|
| `server` TypeScript 编译（`tsc -p`） | 通过，0 错误 |
| `npm run smoke` 端到端冒烟 | **32/32 通过**：健康检查、设备自动注册、**密码错误失败锁定**、JWT 拒绝、**未授权指令拦截、授权后放行、拒绝授权关闭会话**、双端文本/二进制帧转发、角色越权拒绝(close 4000)、refresh 轮换与旧令牌失效、运维统计（含 `authorizedSessions`）、非法令牌拒绝建连 |
| `verify-remote.mjs`（生产配置 REST + 双端 WS 帧） | **23/23 通过**（本地 3010 端口，`NODE_ENV=production`、`TRUST_PROXY=false`）；公网部署后需按真实域名重跑 |
| `docker compose config` | 通过；缺少两个密钥时按 `:?` 明确报错，不会带病启动 |
| Docker 镜像构建 | **通过**（2026-11-18，引擎 v29.9.2）：`docker build -t remote-assist-relay:latest ./server` 多阶段构建成功；实跑容器 `/health` / `/ready` 均 200、`USER=node` 非 root。`caddy:2-alpine` 校验 `deploy/Caddyfile` 为 `Valid configuration`，`caddy adapt` 确认 XFF 为覆盖式 `set`；`deploy/docker-compose.yml` 通过 `docker compose config` |
| 生产部署包 | `deploy/` 新增：relay + Caddy 编排、自动 HTTPS、一键部署 `deploy.sh`、线上全链路验证 `verify.sh`（脚本 `bash -n` 通过）。**公网域名证书与真实 WS 全链路仍需在服务器上跑 `verify.sh` 验证** |
| `web-console` 构建 | 见「交付验证」输出 |
| Android 两个工程 debug / release | 均 `BUILD SUCCESSFUL`（本机 JDK 21 + Gradle 8.7，仅原有 `recycle()` deprecation 警告）；产物在 `dist/debug/` 与 `dist/release/`。已核验 release dex 不含临时隧道地址 |
| release 明文策略 | release 包无 `usesCleartextTraffic`、无预置地址，且 `ApiClient` / `RelayClient` 拒绝 `http://` |
| 无人值守改造（本次） | **代码级验证通过**：受控端 `assembleDebug` / `assembleRelease`、控制端 `assembleDebug` 均 BUILD SUCCESSFUL（Gradle 8.7 + JDK 21）；服务端 `build` 通过、冒烟 **32/32**、临时密码/密码重置接口定向校验通过、两组设备并发集成验证 **14/14**（房间不串流、关闭一组不影响另一组）。设备号 + 6 位密码改造后两端 `compileDebugKotlin` 均通过。**三端真机端到端仍未验证**，按 `docs/UNATTENDED.md` 执行 |

## 关键限制（务必阅读）

1. **任意物理按键无法注入**：非 root / 非系统签名应用只能通过 `AccessibilityService` 执行手势与 `GLOBAL_ACTION_*`。因此 `control.key` 仅支持 HOME / BACK / RECENTS / 通知栏，其余会返回 `control.ack(ok=false)` 说明原因，不会假装成功。需要完整按键注入须接入厂商 MDM 或系统签名权限。
2. **文本输入**依赖受控端当前存在聚焦的可编辑控件；建议先点一下输入框再发送文字。密码框会被明确拒绝。
3. **单进程中继**：会话状态在内存中，服务重启后全部会话失效（符合安全模型），客户端会自动重连但需重新配对。水平扩展需替换三个 Repository 为 Redis（见 `docs/ARCHITECTURE.md`）。
4. **明文 HTTP 仅限 debug 变体**：`src/debug/AndroidManifest.xml` 为调试包开启明文；release 包强制 HTTPS/WSS 且不预置服务器地址。生产仍需配置显式 CORS 白名单与**证书锁定（尚未接入）**。
5. 编码器固定 2 Mbps / 30fps / 长边 1280，未做码率自适应；解码端无抖动缓冲，弱网可能轻微卡顿。
6. **WorkBuddy 临时发布链接不支持 WebSocket**：发布网关不代理 HTTP Upgrade（实测四种凭证组合均被网关 401），该链接已于 2026-11-15 下线。跨网联调必须换用支持 WS 的平台或自建反代，见 `docs/DEPLOYMENT.md`。
7. **授权请求依赖通知权限**：Android 13+ 需授予 `POST_NOTIFICATIONS`，否则被协助者看不到「允许协助」通知，会话会停在等待确认状态。
8. **无人值守 ≠ 零点击**：普通安装（无 ADB/root）仍需一次性人工开启无障碍服务、点一次系统投屏授权；锁屏、杀进程、重启会回收投屏 token，需再点一次。系统权限弹窗无法由无障碍服务自动确认，详见 `docs/UNATTENDED.md`。

## 下一步建议

- 接入 `stream.quality` 做码率自适应与网络探测
- 补 WebRTC 数据通道作为局域网直连回落（当前为纯中继）
- 中继侧接入 Redis Pub/Sub 支持多实例，配置网关层限流与 WSS 证书锁定
- 补齐自动化测试与 CI、三端协议常量一致性校验脚本，修复解码缓冲索引、重连竞态与旋转重发 config 帧

---

本方案为产品设计参考，具体实施请结合公司合规与法务要求确认。
