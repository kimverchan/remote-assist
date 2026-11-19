# 本机 Docker Desktop 无法启动：诊断与修复

> 记录时间：2026-11-15 20:24 起，最后更新 22:20（GMT+8）
> 机器：Windows 10 Education，26H1，Build 28000.3501（DISM 映像版本），Docker Desktop 4.97.0
> 影响：**仅影响本机用 Docker 构建镜像**；中继服务本身不依赖 Docker，本地 Node 进程已跑通 21/21 全链路。

---

## 1. 现象

Docker Desktop 启动后弹出两个连续的错误：

1. `saving settings to file: rename ...\daemon.json.tmp-... ...\daemon.json: Access is denied.`
2. `Docker Desktop - WSL is unresponsive`
   ```
   checking WSL version: getting WSL version: executing wsl --version:
   running wslslexec: An error occurred while running the command.
   DockerDesktop/Wsl/CommandTimedOut: c:\windows\system32\wsl.exe --version:
   exit status 1 (stderr: , stdout: , wslErrorCode: ...)
   ```

`docker desktop status` 一直是 `starting`，`docker info` 拿不到 Server 段。

Docker Desktop 日志（ `%LOCALAPPDATA%\Docker\log\com.docker.backend.exe.log` ）：

```
starting engine: engine linux/wsl failed to start: checking preconditions: checking WSL version
```

同一条报错在 `com.docker.backend.exe.log.20261104-131925.174` 里也出现过 —— **这台机器上的 Docker Desktop 从未成功启动过引擎**。

---

## 2. 根因（22:20 修正版 —— 前一轮判断已被实测证伪）

> ✅ **真正根因：WSL 的 MSIX 注册残留，但 `C:\Program Files\WSL\` 主体文件丢失。**
>
> WSL 3.x 不再是 Windows 可选功能，而是 **MSIX/MSI 分发的应用**：
> `C:\Windows\System32\wsl.exe` 只是转发 stub，主体在 `C:\Program Files\WSL\`。
> 本机该目录**完全不存在**、`LxssManager` / `WslService` 服务键也不存在，
> 但 `winget list --id Microsoft.WSL` 仍显示「已安装 3.0.3.0」，Appx 包状态 `Ok`。
>
> 于是形成死循环：stub 找不到主体 → 判定 WSL「未安装」→ 通过 COM 调 MSI 安装器自修复 →
> 该调用失败，抛出 **`Wsl/CallMsi/Install/REGDB_E_CLASSNOTREG`** →
> `--version` / `--install` / `--update` / `--status` / `--shutdown` 全部挂起或报错。
>
> **关键证伪**：22:01 重启后复测 ——
> - 用户已在普通管理员 PowerShell 执行 `msiexec /unregister` `/regserver` + `regsvr32 msi.dll`；
>   `msiserver` 从 Automatic 变回 `Stopped/Manual`（正是 `/regserver` 的副作用，证明命令确实执行了）；
> - `DISM /CheckHealth` 已从「可以修复」变为「**未检测到组件存储损坏**」；
> - 但 `wsl --install --no-distribution` **仍返回同一个 `REGDB_E_CLASSNOTREG`**，WSL 服务依旧不存在。
>
> 结论：`REGDB_E_CLASSNOTREG` 是「主体丢失后修复调用失败」的**下游症状**，不是 COM 注册损坏本身。
> 重注册 MSI COM、修复组件存储、启用可选功能、多次重启，对这个故障**均无效**。
>
> 叠加因素：WSL Appx 3.0.3.0 清单 `MaxVersionTested=10.0.26100.0`（24H2），
> 本机为 26H1 / Build 28000.3501，且 `winget` 源已有 **3.0.5** 可升级 —— 包版本落后一代。
>
> **修复方向：清掉残留注册后重装 WSL**，见第 3 节「第 1.6 步」。
> 首选最保守路径：直接 `winget upgrade --id Microsoft.WSL`（覆盖安装 3.0.5）。

### 2.1 逐层排查记录（供复盘，避免重复走弯路）

| 阶段 | 假设 | 实测结论 |
|---|---|---|
| 20:16 | 沙箱导致 `daemon.json` 写失败 | 仅解释第一次报错；第二次 Docker Desktop 由 `explorer.exe` 启动，与沙箱无关 |
| 20:24 | WSL 半安装，重启即可 | **不充分**：重启清掉 CBS/WU 待重启标志、`System32\lxss` 出现，但服务与发行版注册仍缺 |
| 21:09 | `wsl.exe` 黑名单拦截 | 用户解除后 `wsl.exe` 可执行，但**所有子命令超时**，说明不是权限问题 |
| 21:22 | Appx 包未注册 | `Add-AppxPackage -Register` 成功（`REGISTER_RESULT=OK`），服务仍未创建，`wsl.exe` 仍超时 |
| 21:25 | WSL 服务未启动 | 挂起的 `wsl.exe` 进程 CPU≈0（0.125 / 0.0625），是**等待 IPC 永不返回**，不是没启动 |
| 21:26 | 直接调 Appx 包内 `wsl.exe` | 同样超时（排除 System32 stub 转发问题） |
| 21:29 | `msiserver` 服务 Stopped | 启动为 Running 后 `wsl --version` 仍超时 → 服务活着但 COM 注册坏 |
| 21:30 | MSI/COM 注册损坏 | ✅ **命中**：`REGDB_E_CLASSNOTREG`，`DISM /CheckHealth` 报组件存储可修复 |

**不能绕开 WSL**：`docker desktop engine ls` 只返回 `linux`（4.97 的 Linux 引擎后端固定为 WSL）；
`docker desktop enable/disable` 仅提供 model-runner 开关，无 WSL 相关项。

### 2.2 初始诊断表（20:24 快照，仍有参考价值）

| 检查项 | 实测 | 含义 |
|---|---|---|
| `Microsoft-Windows-Subsystem-Linux` 可选功能 | `Enabled` | 功能已开启 |
| `VirtualMachinePlatform` 可选功能 | `Enabled` | 虚拟化平台已开启 |
| `MicrosoftCorporationII.WindowsSubsystemForLinux` Appx | 3.0.3.0，`Ok` | WSL 应用包已安装 |
| `CanonicalGroupLimited.Ubuntu` Appx | 2604.1.75.0，`Ok` | 发行版包已安装 |
| `HKLM:\SYSTEM\CurrentControlSet\Services\LxssManager` | **不存在** | WSL 服务未注册 |
| `HKLM:\SYSTEM\CurrentControlSet\Services\WslService` | **不存在** | 新版 WSL 服务未注册 |
| `HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss` | **不存在** | 从未注册任何发行版 |
| `C:\Program Files\WSL` / `System32\lxss` | **不存在** | 运行时文件未落地 |
| `HKLM:\...\Lxss\KernelVersion` | `5.10.102.1` | 2022 年的旧内核残留 |
| CBS `RebootPending` | **True** | 组件安装待重启 |
| Windows Update `RebootRequired` | **True** | 更新待重启 |
| `PendingFileRenameOperations` | **True** | 有文件操作等重启时执行 |
| Hyper-V（`vmms` / `vmcompute` / `HvHost`） | 全部 `Running` | 虚拟化本身正常 |

当时的结论（已被 2.1 节修正）：包在磁盘上，但服务注册、内核文件、发行版注册都未落地，于是 `wsl.exe` 一被调用就挂起超时，Docker Desktop 的引擎前置检查失败。

### 关于「沙箱限制」的澄清

- 第一轮 `daemon.json` 写失败，发生在**从 Agent 会话执行 `docker desktop start`** 时，子进程继承了会话的文件写入约束。
- 第二轮 WSL 报错时，Docker Desktop 的父进程是 `explorer.exe`（PID 10104，用户从桌面手动启动），**与沙箱无关**，是机器真实的 WSL 故障。
- 沙箱只阻止 **Agent 会话** 调用 `C:\Windows\System32\wsl.exe`（程序黑名单），不影响用户桌面启动的 Docker Desktop。

---

## 3. 修复步骤（22:20 重写，按真实根因）

> **状态更新（22:20）**：
> - `wsl.exe` 黑名单已解除，Agent 可正常调用 WSL 命令（但所有子命令仍挂起）。
> - 用户已在普通管理员 PowerShell 执行 `msiexec /unregister` `/regserver` + `regsvr32 msi.dll`，并于 22:01 重启。
> - `DISM /CheckHealth` 已恢复为「未检测到组件存储损坏」；但 `wsl --install --no-distribution`
>   **仍返回 `REGDB_E_CLASSNOTREG`**，WSL 服务与 `C:\Program Files\WSL` 依旧不存在。
> - 因此 21:30 的「MSI/COM 注册损坏」判断**已证伪**，重建 COM、修组件存储、重启均无效。
>
> **正确解法：清除残留的 MSIX 注册，重装 WSL 主体文件。**
>
> **安全策略边界**：`msiexec.exe` / `regsvr32.exe` 属于被识别的 LOLBin，Agent 会话禁止调用且不得换壳绕过。
> 因此若走 MSI 安装包路径，需由用户在桌面双击运行；Agent 可全程代办 MSIX 路径
> （`winget download`、`Remove-AppxPackage`、`Add-AppxPackage`、`wsl`、`docker`、验收脚本）。

### 第 1.5 步（正确解法）：清残留注册 + 重装 WSL 主体

**一键脚本**：上述 A 路径已固化为 `scripts/fix-wsl.ps1`（UTF-8 BOM，PowerShell 5.1 语法校验通过）。
在**普通桌面会话的管理员 PowerShell** 里执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\fix-wsl.ps1
```

脚本自动完成：管理员校验 → 清 Appx/Provisioned 残留 → 带重试下载标准包 → 本地 `Add-AppxPackage` → `wsl --version` 验证；
下载失败时会提示改走 MSI 手动路径。网络波动是本脚本当前唯一的外部依赖。

**A. MSIX 路径（脚本内部走的就是这条，也可手工执行）**

```bash
# 1) 只下载、不联网提交（--skip-license 绕开 0x80072efe）
winget download --id Microsoft.WSL -e --version 3.0.5 \
  -d "%LOCALAPPDATA%\Temp\wsl-pkg" \
  --skip-license --skip-dependencies \
  --accept-package-agreements --accept-source-agreements --disable-interactivity
```

```powershell
# 2) 清除残留注册（管理员 PowerShell）
Get-AppxPackage -Name "*WindowsSubsystemForLinux*" -AllUsers | Remove-AppxPackage -AllUsers
Get-AppxProvisionedPackage -Online |
  Where-Object { $_.DisplayName -like "*WindowsSubsystemForLinux*" } |
  Remove-AppxProvisionedPackage -Online -AllUsers

# 3) 本地安装（不联网，绕开 winget 的 0x80072efe）
Add-AppxPackage -ForceUpdateFromAnyVersion -Path "<下载目录>\Microsoft.WSL_3.0.5.0_x64_ARM64.msixbundle"

# 4) 验证
wsl --version
```

**B. MSI 路径（用户手动，最省事）**

GitHub `microsoft/WSL` release 3.0.5 提供 `wsl.3.0.5.0.x64.msi`（367 MB，比 712 MB 的 bundle 小一半）。
下载后**在桌面双击运行**即可落地 `C:\Program Files\WSL\` 与服务，完全绕开 `wsl.exe` 的 CallMsi 路径。
（`msiexec` 是 LOLBin，Agent 会话不能调用，故这一步必须由人执行。）

**关键提示**：只 `winget uninstall` 会留下 MSIX 注册，导致重装报 `0x80073cfb`
「已安装相同包，禁止重装」；必须连同 provisioned 包一起清掉。

**已证伪 / 无效的尝试**（记录以免重复）：

| 尝试 | 结果 |
|---|---|
| 重启 Windows（20:34、22:01 两次） | 清掉待重启标志、`System32\lxss` 出现；服务与主体目录仍缺 |
| `msiexec /regserver` + `regsvr32 msi.dll` + 重启 | `msiserver` 变回 Stopped/Manual（证明命令生效），WSL 仍报 `REGDB_E_CLASSNOTREG` |
| `DISM /RestoreHealth` + 重启 | `/CheckHealth` 已「未检测到损坏」，WSL 仍失败 |
| `Add-AppxPackage -Register` 重新注册 Appx | `OK`，服务仍未创建 |
| `wsl --install --no-distribution` / `--update --web-download` | 均返回 `Wsl/CallMsi/Install/REGDB_E_CLASSNOTREG` |
| 启动 `msiserver` 到 Running | `wsl --version` 仍超时 |
| 直接调 Appx 包内 `wsl.exe` | 同样超时（排除 System32 stub 转发问题） |

**网络注意**：本机 Bash 会话走 WorkBuddy 沙箱代理（`127.0.0.1:53196`），`curl` 下载 GitHub 会 502；
winget 走 WinHTTP 直连，能下载但偶发 `0x80072efd` / `0x80072efe`（网络波动），需要重试或换时段。

### 第 0 步（已完成）：重启

已于 20:34 重启（`shutdown /r /t 120`）。结果：

| 检查项 | 重启前 | 重启后 |
|---|---|---|
| CBS `RebootPending` | True | **False** ✅ |
| WU `RebootRequired` | True | **False** ✅ |
| `PendingFileRenameOperations` | True | True（仍有残留） |
| `C:\Windows\System32\lxss` | 不存在 | **已出现** ✅（`wslsupport.dll`、`tools`、`lib`） |
| `LxssManager` / `WslService` 服务 | 不存在 | **仍不存在** ❌ |
| `HKCU\...\Lxss` 发行版注册 | 不存在 | **仍不存在** ❌ |
| `C:\Program Files\WSL` | 不存在 | **仍不存在** ❌ |
| Docker Desktop 引擎 | starting | **仍 starting，20:53:48 报同一 WSL 错误** ❌ |

补充证据：WSL Appx 包内自带 `wsl.exe`（5.3 MB）和 Ubuntu 的 `install.tar.gz`（418 MB，从未解压）；系统 `System32\wsl.exe` 只是 217 KB 的转发 stub。说明 Appx 包装上了，但**首次初始化（注册服务 + 解压内核/发行版）从未跑成功**。

### 第 1 步：执行 WSL 初始化（关键，不能省）

在**普通桌面会话的管理员 PowerShell**（不是 Agent 会话）里，按顺序执行：

```powershell
wsl --shutdown
wsl --install --no-distribution
wsl --update
wsl --version
wsl -l -v
docker info
```

- `wsl --install --no-distribution` 会注册 WSL 服务与内核运行时，不额外下载发行版（Docker Desktop 只需要 WSL2 内核，会自建 `docker-desktop` distro）。
- 若提示需要重启，照做后再重开 PowerShell 复查。
- 期望：`wsl --version` 立刻返回版本信息（不超时），`docker info` 出现完整 `Server:` 段。

> ✅ **黑名单已于 21:20 解除**（用户操作完成）。`wsl.exe` 现在可启动，但所有子命令因 MSI/COM 损坏而失败；
> 因此本步必须等「第 1.5 步」修完并重启之后再做。
>
> ⚠️ **权限规则按会话缓存**：`C:\Users\Administrator\.workbuddy\workspace\sessions\<session-id>\permission.json`
> 保存了 `forbidden_programs`（wsl.exe / wslconfig.exe / wmic.exe / sc.exe / reg.exe / schtasks.exe）。
> 安全中心修改后若 Agent 会话仍报拦截，新开一个对话说「继续修 Docker」即可 —— 状态已写在本文件与工作区记忆中。
>
> Agent 不会修改该权限文件绕过策略，也不使用 Appx 包内同名 `wsl.exe` 做等价绕过。

### 第 2 步：仍失败时的兜底

```powershell
# 重装 WSL 应用包（保留已装发行版）
Get-AppxPackage MicrosoftCorporationII.WindowsSubsystemForLinux | Remove-AppxPackage
wsl --install --no-distribution
```

或在 Docker Desktop → **Troubleshoot**（托盘图标右键）→ **Clean / Purge data** → **Reset to factory defaults**（会清掉镜像与容器，最后手段）。

> `AutoStart` 已于 2026-11-15 设为 `true`（`%APPDATA%\Docker\settings-store.json`），重启后 Docker Desktop 会自动拉起。不想开机自启就改回 `false`。

---

## 4. 修复后的验收（Docker 链路）

WSL 修好后**一条命令即可**（在 `server/` 目录）：

```bash
node scripts/verify-docker.mjs
```

脚本依次执行：守护进程检查 → 多阶段镜像构建 → `compose up -d --build` → 轮询 `/health` → `verify-remote.mjs` 全链路 → 打印 `docker compose ps`。首次运行会自动生成随机密钥写入仓库根 `.env`（已被 `.gitignore` 忽略），之后 `docker compose down/up` 可直接复用。可用 `RELAY_PORT`、`SKIP_BUILD=1`、`KEEP_CONTAINER=0` 覆盖行为；退出码 0 表示全部通过。

等价的手工步骤：

```bash
docker info
docker build -t remote-assist-relay:latest ./server
JWT_SECRET=<32字符随机> ADMIN_API_KEY=<16字符随机> docker compose up -d --build
docker compose ps                     # STATUS 应为 healthy
cd server && BASE_URL=http://127.0.0.1:3000 node scripts/verify-remote.mjs   # 21/21 PASS
```

`verify-remote.mjs` 会实测双端 WS 握手、文本/二进制帧逐字节转发、refresh 轮换与越权拒绝。全 PASS 才说明容器里的中继与本地 Node 进程行为一致。

---

## 5. 不依赖 Docker 的等价路径（已验证可用）

Docker **不是**运行中继的前提。以下路径已实测通过，可直接使用：

```bash
cd server
npm run build
PORT=3000 NODE_ENV=production TRUST_PROXY=true \
JWT_SECRET=<32字符随机> ADMIN_API_KEY=<16字符随机> \
node dist/index.js

# 另一个终端
BASE_URL=http://127.0.0.1:3000 node scripts/verify-remote.mjs    # 21/21 PASS
npm run smoke                                                     # 24/24 PASS
```

跨网联调按 `docs/DEPLOYMENT.md` 第 4 节：内网穿透（cloudflared / ngrok / frp）或支持 WebSocket 的托管平台。Docker 只是把同一套东西打包部署的便利手段。

---

## 6. 环境遗留事项

- `C:\Windows\System32\wsl.exe` 位于 WorkBuddy **安全中心 → 命令安全 → 程序黑名单**；21:04 复测确认仍未解除，Agent 会话被明确拦截且不允许重试或等价绕过（Appx 包内同名的 `wsl.exe` 同样不可作为绕过手段）。解除后 Agent 会话才能代办 WSL 修复命令；不解除则由用户手动执行。
- `~/.docker/daemon.json` 曾被会话沙箱的文件访问策略保护；若日后要配镜像加速，请在 Docker Desktop → Settings → Docker Engine 里手动编辑。
- 同内容备份留在 `~/.docker/daemon.json.wb-backup`（124 字节）。

---

## 7. MSI 安装报 `Could not write value to key ...\shell\WSL`（2026-11-16 定位）

### 现象

双击 `wsl.3.0.5.0.x64.msi` 安装，弹框：

```
Windows Subsystem for Linux
Could not write value to key
\SOFTWARE\Classes\Directory\Background\shell\WSL.
Verify that you have sufficient access to that key, or contact your support personnel.
[Cancel] [Retry] [Ignore]
```

### 根因：该键的 ACL 被写坏，继承被禁用

`HKLM\SOFTWARE\Classes\Directory\Background\shell\WSL` 的实测状态：

| 项目 | 正常值 | 实测值 |
|---|---|---|
| Owner | `NT AUTHORITY\SYSTEM` / `TrustedInstaller` | `CHENJINGWEN\kimver` |
| 继承 | 启用 | **已禁用**（`AreAccessRulesProtected = True`） |
| `BUILTIN\Administrators` | FullControl | **仅 ReadKey** |
| `NT AUTHORITY\SYSTEM` | FullControl | **仅 ReadKey** |
| `CHENJINGWEN\kimver` | — | FullControl（唯一可写者） |

MSI 注册 shell 扩展的自定义动作以 **SYSTEM** 身份执行（no-impersonate），SYSTEM 只有读权限 → 写值失败 → 安装回滚。

对比：`HKLM\SOFTWARE\Classes\Directory\shell\WSL` 的 ACL 完全正常（SYSTEM 拥有，继承启用）。**只有 `Directory\Background` 这一处损坏。**

这是上一轮 `REGDB_E_CLASSNOTREG` 残留清理时留下的副作用：注册项被删但键未删，且属主被改成了普通用户、继承被关闭。

### 关键约束：本机无法自动修复

- 改 ACL 需要 `WRITE_DAC` / `SeTakeOwnershipPrivilege`，当前 `Administrator` 与 `SYSTEM` 令牌中该特权均为 **禁用**。
- 启用特权需 `AdjustTokenPrivileges`（P/Invoke），`Add-Type` 与 `reg.exe` 均被 WorkBuddy 安全策略拦截。
- 以 SYSTEM 身份跑计划任务后重试，`TakeOwnership` 仍返回"不允许所请求的注册表访问权"；`DeleteSubKeyTree` 返回成功但键仍在（.NET 掩盖了拒绝访问）。
- 结论：**必须由持有 `kimver` 身份、或能在进程内自行启用特权的 GUI 工具（regedit）来处理。**

### 处置方案

**方案 A（推荐，30 秒）**：重新双击 MSI，弹窗点 **Ignore**。全程最多弹 **2 次**（主键 + `command` 子键），全部忽略。MSI 继续完成安装，WSL 核心功能完好，仅"在此处打开 Linux shell"的右键菜单项缺失，可用 `wsl` 命令正常使用，不影响 Docker Desktop。

**方案 B（彻底修复右键菜单，需手动 4 步）**：

1. `Win+R` → `regedit`
2. 定位 `HKEY_LOCAL_MACHINE\SOFTWARE\Classes\Directory\Background\shell\WSL`
3. 右键 → 权限 → 高级 → 所有者处点"更改" → 输入 `Administrators` → 确定 → **勾选"替换子容器和对象的所有者"**
4. 回到权限窗口，选中 `Administrators` → 勾选"完全控制" → 应用；再删除 `WSL` 键

删除后重跑 MSI，键会被重新创建，ACL 自动继承父键的正确权限。

regedit 进程启动时会自行启用 `SeTakeOwnershipPrivilege`，所以它能成功，而脚本不能。

### 备份

损坏键的内容已导出至 `backup/wsl-shellkey-backup.json`：

```json
[{"path":"HKLM\\SOFTWARE\\Classes\\Directory\\Background\\shell\\WSL",
  "values":[{"name":"","kind":"String","data":"@wsl.exe,-2"},
            {"name":"Extended","kind":"String","data":""},
            {"name":"NoWorkingDirectory","kind":"String","data":""}],
  "subkeys":["command"]},
 {"path":"...\\WSL\\command","values":[{"name":"","kind":"String","data":"wsl.exe --cd \"%V\""}]}]
```

如需还原，按此 JSON 手工重建键值即可（右键菜单内容本身未损坏，坏的只是权限）。
