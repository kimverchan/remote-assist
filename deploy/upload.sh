#!/usr/bin/env bash
# 本机执行：把部署包上传到云服务器（Windows Git Bash / macOS / Linux 均可）
#
#   bash deploy/upload.sh root@1.2.3.4            # 默认 SSH 端口 22
#   bash deploy/upload.sh ubuntu@1.2.3.4 2222     # 自定义 SSH 端口
#
# 非 root 用户若对 /opt 无写权限，改用家目录：
#   REMOTE_DIR=/home/ubuntu/remote-assist-relay REMOTE_PKG=/home/ubuntu/relay-deploy.tgz \
#     bash deploy/upload.sh ubuntu@1.2.3.4
#
# 密码登录：scp / ssh 会各提示一次 "password:"，输入不回显，密码不写入任何文件、
# 不进命令行历史。想完全免密请先配 SSH 公钥（见 README 生产部署章节）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
PORT="${2:-22}"
PKG="$ROOT/dist/relay-deploy.tgz"
REMOTE_DIR="${REMOTE_DIR:-/opt/remote-assist-relay}"
REMOTE_PKG="${REMOTE_PKG:-/opt/relay-deploy.tgz}"

if [ -z "$TARGET" ]; then
  echo "用法：bash deploy/upload.sh <user@公网IP> [SSH端口]" >&2
  exit 1
fi

echo "→ 打包最新源码（排除 node_modules / dist / .env）"
mkdir -p "$ROOT/dist"
(cd "$ROOT" && tar czf dist/relay-deploy.tgz --exclude=node_modules --exclude=dist --exclude=.env server deploy)

echo "→ 上传到 ${TARGET}:${REMOTE_PKG}（提示 password: 时输入，不回显）"
scp -P "$PORT" "$PKG" "${TARGET}:${REMOTE_PKG}"

echo "→ 解压到 ${REMOTE_DIR}（会再提示一次密码）"
ssh -p "$PORT" "$TARGET" "mkdir -p ${REMOTE_DIR} && tar xzf ${REMOTE_PKG} -C ${REMOTE_DIR} && echo OK: ${REMOTE_DIR}"

echo
echo "✓ 上传完成。接下来登录服务器执行："
echo "  ssh -p ${PORT} ${TARGET}"
echo "  cd ${REMOTE_DIR}/deploy"
echo "  # HTTPS 域名模式（域名 A 记录已指向本机）："
echo "  bash deploy.sh relay.yourdomain.com && bash verify.sh"
echo "  # 或纯公网 IP 明文直连模式（仅 debug 包 / 临时联调）："
echo "  bash switch-ip-http.sh"
echo
echo "⚠ relay.example.com 只是示例占位域名，DNS 不存在，千万不要照抄。"
