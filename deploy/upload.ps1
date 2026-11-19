# Local upload helper for Windows PowerShell / CMD. No Git Bash, no WSL, no bash required.
#
#   powershell -ExecutionPolicy Bypass -File deploy\upload.ps1 root@8.138.221.245
#   powershell -ExecutionPolicy Bypass -File deploy\upload.ps1 root@8.138.221.245 2222
#
# Non-root account without write permission on /opt:
#   powershell -ExecutionPolicy Bypass -File deploy\upload.ps1 -Target ubuntu@1.2.3.4 -RemoteDir /home/ubuntu/remote-assist-relay -RemotePkg /home/ubuntu/relay-deploy.tgz
#
# Password login: scp and ssh each prompt once. Passwords are never written to
# the command line, a file, or shell history. ASCII-only on purpose: Windows
# PowerShell 5.1 reads BOM-less .ps1 with the system ANSI code page.

param(
    [string]$Target,
    [int]$Port = 22,
    [string]$RemoteDir = "/opt/remote-assist-relay",
    [string]$RemotePkg = "/opt/relay-deploy.tgz"
)

$ErrorActionPreference = "Stop"

if (-not $Target) {
    Write-Host "Usage: powershell -ExecutionPolicy Bypass -File deploy\upload.ps1 <user@PUBLIC_IP> [SSH_PORT]"
    exit 1
}

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$tar = Join-Path $env:SystemRoot "System32\tar.exe"
$scp = Join-Path $env:SystemRoot "System32\OpenSSH\scp.exe"
$ssh = Join-Path $env:SystemRoot "System32\OpenSSH\ssh.exe"
foreach ($tool in @($tar, $scp, $ssh)) {
    if (-not (Test-Path $tool)) { throw "Missing Windows built-in tool: $tool" }
}

$distDir = Join-Path $projectRoot "dist"
if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir | Out-Null }
$pkg = Join-Path $distDir "relay-deploy.tgz"

Write-Host "-> Packaging server/ and deploy/ (excluding node_modules / dist / .env)"
& $tar czf $pkg --exclude=node_modules --exclude=dist --exclude=.env server deploy
if ($LASTEXITCODE -ne 0) { throw "tar packaging failed (exit $LASTEXITCODE)" }

Write-Host "-> Uploading to ${Target}:${RemotePkg}  (enter password when prompted, no echo)"
& $scp -P $Port $pkg "${Target}:${RemotePkg}"
if ($LASTEXITCODE -ne 0) { throw "scp upload failed (exit $LASTEXITCODE)" }

Write-Host "-> Extracting on server (password prompt once more)"
& $ssh -p $Port $Target "mkdir -p $RemoteDir && tar xzf $RemotePkg -C $RemoteDir && echo UPLOAD_OK"
if ($LASTEXITCODE -ne 0) { throw "ssh extract failed (exit $LASTEXITCODE)" }

Write-Host ""
Write-Host "OK. Next, log in to the server:"
Write-Host "  ssh -p $Port $Target"
Write-Host "  cd $RemoteDir/deploy"
Write-Host "  bash switch-ip-http.sh          # plain-HTTP direct-IP mode (debug APKs only)"
Write-Host "  # or HTTPS domain mode:  bash deploy.sh relay.yourdomain.com"
Write-Host ""
Write-Host "NOTE: relay.example.com is only a placeholder. Never copy it verbatim."
