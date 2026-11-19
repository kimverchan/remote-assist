<#
.SYNOPSIS
    修复 WSL 3.x「MSIX 注册残留 + 主体文件丢失」导致的 REGDB_E_CLASSNOTREG，
    使 Docker Desktop 的 Linux 引擎能够启动。

.DESCRIPTION
    适用症状：
      - wsl --version / --status / --shutdown 超时
      - wsl --install 返回「没有注册类 / Wsl/CallMsi/Install/REGDB_E_CLASSNOTREG」
      - C:\Program Files\WSL 不存在，LxssManager / WslService 服务键不存在
      - 但 winget list --id Microsoft.WSL 显示「已安装」
      - Docker Desktop 报 "checking WSL version" / "WSL is unresponsive"

    原理：WSL 3.x 主体在 C:\Program Files\WSL\，System32\wsl.exe 只是转发 stub。
    主体丢失后 stub 会调 MSI 自修复并失败。必须清掉残留注册再重装主体。

    必须在【普通桌面会话】的【管理员 PowerShell】里运行，不要在 Agent 会话里跑。

.PARAMETER Version
    要安装的 WSL 版本，默认 3.0.5。

.PARAMETER Retries
    下载重试次数，默认 3。GitHub 直连不稳定时可加大。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\fix-wsl.ps1
#>
param(
    [string]$Version = '3.0.5',
    [int]$Retries = 3
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [!]  $msg" -ForegroundColor Yellow }

# ---------------------------------------------------------------- 0) 权限
Write-Step '检查权限'
$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '请以【管理员身份】运行 PowerShell（标题栏应显示「管理员」）。'
}
Write-Ok "当前用户：$($identity.Name)（管理员）"

# ---------------------------------------------------------------- 1) 现状
Write-Step '当前状态'
Get-AppxPackage -Name '*WindowsSubsystemForLinux*' -AllUsers -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host "  Appx 注册：$($_.Name) $($_.Version)  $($_.Status)" }
Write-Host "  C:\Program Files\WSL 存在：$(Test-Path 'C:\Program Files\WSL')"
foreach ($n in @('LxssManager', 'WslService')) {
    $s = Get-Service -Name $n -ErrorAction SilentlyContinue
    Write-Host "  服务 $n：$(if ($s) { $s.Status } else { '未注册' })"
}

# ---------------------------------------------------------------- 2) 清残留
Write-Step '清除残留的 MSIX 注册'
$pkgs = Get-AppxPackage -Name '*WindowsSubsystemForLinux*' -AllUsers -ErrorAction SilentlyContinue
if ($pkgs) {
    $pkgs | Remove-AppxPackage -AllUsers -ErrorAction SilentlyContinue
    Write-Ok "已移除 $($pkgs.Count) 个 Appx 注册"
} else {
    Write-Warn '没有找到 Appx 注册（可能已清理）'
}

$prov = Get-AppxProvisionedPackage -Online -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -like '*WindowsSubsystemForLinux*' -or $_.PackageName -like '*WindowsSubsystemForLinux*' }
if ($prov) {
    $prov | Remove-AppxProvisionedPackage -Online -AllUsers -ErrorAction SilentlyContinue | Out-Null
    Write-Ok "已移除 $($prov.Count) 个预置包注册"
} else {
    Write-Warn '没有找到预置包注册'
}

# 只 winget uninstall 会留下注册并导致 0x80073cfb，所以上面两步不能省。
if (Test-Path 'C:\Program Files\WSL') {
    Remove-Item 'C:\Program Files\WSL' -Recurse -Force -ErrorAction SilentlyContinue
    Write-Ok '已清理残留的主体目录'
}

# ---------------------------------------------------------------- 3) 下载
Write-Step "下载 WSL $Version 标准安装包（跳过联网许可证检索）"
$dlDir = Join-Path $env:TEMP 'wsl-pkg'
New-Item -ItemType Directory -Force -Path $dlDir | Out-Null
Get-ChildItem $dlDir -Filter '*.msixbundle' -File -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue

$bundle = $null
for ($i = 1; $i -le $Retries; $i++) {
    Write-Host "  第 $i/$Retries 次尝试…"
    & winget download --id Microsoft.WSL -e --version $Version -d $dlDir `
        --skip-license --skip-dependencies `
        --accept-package-agreements --accept-source-agreements --disable-interactivity
    $bundle = Get-ChildItem $dlDir -Filter '*.msixbundle' -File -ErrorAction SilentlyContinue |
              Sort-Object Length -Descending | Select-Object -First 1
    if ($bundle -and $bundle.Length -gt 100MB) { break }
    $bundle = $null
    if ($i -lt $Retries) { Start-Sleep -Seconds 10 }
}

if (-not $bundle) {
    Write-Warning '自动下载失败（GitHub 直连不稳定）。'
    Write-Host @'
  手动路径（任选其一）：
    1) 浏览器下载 https://github.com/microsoft/WSL/releases/download/3.0.5/wsl.3.0.5.0.x64.msi
       然后双击运行（367 MB，比 msixbundle 小一半），装完回来重跑本脚本的验证部分。
    2) 等网络恢复后重跑本脚本，或把下载好的 .msixbundle 放进：
       %TEMP%\wsl-pkg\ 再重跑本脚本。
'@ -ForegroundColor Yellow
    exit 1
}
Write-Ok "已下载：$($bundle.FullName)  $([math]::Round($bundle.Length / 1MB, 1)) MB"

# ---------------------------------------------------------------- 4) 本地安装
Write-Step '本地安装（不走 winget 的联网提交，绕开 0x80072efe）'
Add-AppxPackage -ForceUpdateFromAnyVersion -Path $bundle.FullName
Write-Ok 'MSIX 包安装完成'

# ---------------------------------------------------------------- 5) 验证
Write-Step '验证'
$verOk = $false
try {
    $out = & "$env:WINDIR\System32\wsl.exe" --version 2>&1
    if ($out) { $out | ForEach-Object { Write-Host "  $_" }; $verOk = $true }
} catch {
    Write-Warn "wsl --version 失败：$($_.Exception.Message)"
}
Write-Host "  C:\Program Files\WSL 存在：$(Test-Path 'C:\Program Files\WSL')"

if (-not $verOk) {
    Write-Warning 'wsl --version 仍未正常返回，建议重启 Windows 后再检查。'
    exit 2
}

Write-Host @'

  WSL 已恢复。接下来：
    1) 重启 Docker Desktop（托盘图标 → Restart），或在管理员 PowerShell 执行 docker info
    2) 确认 docker info 出现完整 Server: 段
    3) 在 server/ 目录执行： node scripts/verify-docker.mjs
       该脚本会跑完镜像构建、compose up、/health 轮询与 21/21 全链路验证。

'@ -ForegroundColor Green
