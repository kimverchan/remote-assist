#!/usr/bin/env bash
# 免交互一键部署 / 更新中继服务（在本机执行）
#
#   bash deploy/auto-deploy.sh root@8.138.221.245 ip-http
#   bash deploy/auto-deploy.sh root@8.138.221.245 https relay.yourdomain.com [admin@yourdomain.com]
#
# 认证通道自动选择：
#   1) Windows 原生 OpenSSH + 系统 ssh-agent（适合带 passphrase 的私钥，推荐）
#      私钥解锁缓存在 agent 里，脚本全程 BatchMode=yes，绝不提示输入密码。
#   2) 回退到 MSYS ssh + ~/.ssh/id_ed25519 显式私钥（密钥无 passphrase 时可用）
#
# 可覆盖的环境变量：
#   SSH_PORT=2222 SSH_KEY=~/.ssh/other_key \
#   REMOTE_DIR=/home/ubuntu/remote-assist-relay REMOTE_PKG=/home/ubuntu/relay-deploy.tgz \
#     bash deploy/auto-deploy.sh ...
#
# 说明：打包时排除 .env，服务器上已有的 .env（含 JWT_SECRET / ADMIN_API_KEY）不会被覆盖，
#       因此已签发的令牌在更新后依然有效。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
MODE="${2:-}"
DOMAIN="${3:-}"
EMAIL="${4:-}"
PORT="${SSH_PORT:-22}"
KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
REMOTE_DIR="${REMOTE_DIR:-/opt/remote-assist-relay}"
REMOTE_PKG="${REMOTE_PKG:-/opt/relay-deploy.tgz}"
PKG="$ROOT/dist/relay-deploy.tgz"

die() { echo "✗ $*" >&2; exit 1; }

[ -n "$TARGET" ] || die "用法：bash deploy/auto-deploy.sh <user@IP> <ip-http|https> [域名] [邮箱]"
case "$MODE" in
  ip-http) ;;
  https)
    [ -n "$DOMAIN" ] || die "HTTPS 模式必须提供已解析到本机的真实域名（deploy.sh 非交互环境无法提示输入）"
    case "$DOMAIN" in
      *example.com|*example.org|*example.net) die "${DOMAIN} 是示例占位域名，Caddy 无法申请证书" ;;
    esac
    ;;
  *) die "MODE 只能是 ip-http 或 https，当前值：${MODE:-空}" ;;
esac

# ---------- 选择 SSH 传输通道 ----------
WIN_SSH="/c/Windows/System32/OpenSSH/ssh.exe"
WIN_SCP="/c/Windows/System32/OpenSSH/scp.exe"
WIN_ADD="/c/Windows/System32/OpenSSH/ssh-add.exe"

if [ -x "$WIN_SSH" ] && [ -x "$WIN_SCP" ] && "$WIN_ADD" -l >/dev/null 2>&1; then
  SSH_BIN="$WIN_SSH"; SCP_BIN="$WIN_SCP"
  SSH_ARGS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -p "$PORT")
  SCP_ARGS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -P "$PORT")
  # Windows 原生 exe 不认 MSYS 的 /c/... 路径，转成 C:/... 形式
  LOCAL_PKG="$(cygpath -m "$PKG")"
  echo "→ 认证通道：Windows 原生 OpenSSH + 系统 ssh-agent（免密、非交互）"
else
  [ -f "$KEY" ] || die "找不到 SSH 私钥：$KEY，且系统 ssh-agent 无可用密钥"
  SSH_BIN="ssh"; SCP_BIN="scp"
  SSH_ARGS=(-i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -p "$PORT")
  SCP_ARGS=(-i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -P "$PORT")
  LOCAL_PKG="$PKG"
  echo "→ 认证通道：MSYS OpenSSH + 显式私钥 ${KEY}"
fi

echo "=== 0/5 免密连通性预检 ==="
if ! "$SSH_BIN" "${SSH_ARGS[@]}" "$TARGET" 'echo SSH_OK; whoami; uname -srm; docker compose version' 2>&1; then
  die "SSH 免密登录失败。请确认本机公钥已在服务器 ~/.ssh/authorized_keys，或把私钥加入系统 ssh-agent。"
fi

echo
echo "=== 1/5 打包最新源码（排除 node_modules / dist / .env）==="
mkdir -p "$ROOT/dist"
(cd "$ROOT" && tar czf dist/relay-deploy.tgz --exclude=node_modules --exclude=dist --exclude=.env server deploy)
ls -lh "$PKG"

echo
echo "=== 2/5 上传部署包到 ${TARGET}:${REMOTE_PKG} ==="
"$SCP_BIN" "${SCP_ARGS[@]}" "$LOCAL_PKG" "${TARGET}:${REMOTE_PKG}"

echo
echo "=== 3/5 远程解压到 ${REMOTE_DIR}（.env 不在包内，不会被覆盖）==="
"$SSH_BIN" "${SSH_ARGS[@]}" "$TARGET" "mkdir -p ${REMOTE_DIR} && tar xzf ${REMOTE_PKG} -C ${REMOTE_DIR} && echo EXTRACT_OK && echo '--- .env mtime (should be unchanged) ---' && stat -c '%y %a %U' ${REMOTE_DIR}/deploy/.env"

echo
echo "=== 4/5 远程部署（模式：${MODE}）==="
if [ "$MODE" = "https" ]; then
  "$SSH_BIN" "${SSH_ARGS[@]}" "$TARGET" "cd ${REMOTE_DIR}/deploy && bash deploy.sh '${DOMAIN}' '${EMAIL}'"
  VERIFY_BASE="https://${DOMAIN}"
else
  "$SSH_BIN" "${SSH_ARGS[@]}" "$TARGET" "cd ${REMOTE_DIR}/deploy && bash switch-ip-http.sh"
  VERIFY_BASE="http://127.0.0.1:3000"
fi

echo
echo "=== 5/5 最终验证：${VERIFY_BASE} ==="
"$SSH_BIN" "${SSH_ARGS[@]}" "$TARGET" "cd ${REMOTE_DIR}/deploy && bash verify.sh '${VERIFY_BASE}'"

echo
echo "=== 运行态 ==="
"$SSH_BIN" "${SSH_ARGS[@]}" "$TARGET" "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -E 'NAMES|remote-assist|caddy' || true; echo '--- health ---'; curl -fsS http://127.0.0.1:3000/health || true; echo"

echo "✓ 部署完成：${TARGET} (${MODE})"
