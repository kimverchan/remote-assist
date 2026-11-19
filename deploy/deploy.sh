#!/usr/bin/env bash
# 中继服务一键部署 / 更新（在云服务器上的 deploy/ 目录内执行）
#   bash deploy.sh relay.example.com [admin@example.com]   # 首次部署
#   bash deploy.sh                                        # 后续更新（沿用已有 .env，不换密钥）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [ ! -f "$ROOT/../server/Dockerfile" ]; then
  echo "错误：未找到 ../server/Dockerfile。上传时请确保 server/ 与 deploy/ 同级。" >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "错误：需要 Docker Compose v2 插件（docker compose version）。" >&2
  exit 1
fi

randhex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

env_get() {
  local key="$1" default="${2:-}" val
  val="$(grep -E "^${key}=" .env 2>/dev/null | head -n1 | cut -d= -f2- | tr -d '"' | tr -d '\r' || true)"
  printf '%s' "${val:-$default}"
}

DOMAIN="${1:-}"
EMAIL="${2:-}"

if [ ! -f .env ]; then
  if [ -z "$DOMAIN" ]; then
    read -r -p "请输入已解析到本机的中继域名（如 relay.example.com）: " DOMAIN
  fi
  if [ -z "$DOMAIN" ]; then
    echo "错误：必须提供域名，用法：bash deploy.sh relay.example.com" >&2
    exit 1
  fi
  case "$DOMAIN" in
    *example.com|*example.org|*example.net)
      echo "错误：${DOMAIN} 是示例占位域名，Caddy 无法为它申请证书，DNS 也解析不了。" >&2
      echo "      请换成已解析到本机公网 IP 的真实域名，如：bash deploy.sh relay.yourdomain.com" >&2
      echo "      暂时没有域名可先只验证服务：bash verify.sh http://127.0.0.1:3000" >&2
      exit 1
      ;;
  esac
  if [ -z "$EMAIL" ]; then
    EMAIL="admin@${DOMAIN}"
  fi

  umask 077
  cat > .env <<EOF
RELAY_DOMAIN=${DOMAIN}
CADDY_EMAIL=${EMAIL}
RELAY_PORT=3000
JWT_SECRET=$(randhex 32)
ADMIN_API_KEY=$(randhex 24)
TRUST_PROXY=true
TRUST_PROXY_HOPS=1
CORS_ORIGINS=http://localhost:5173
LOG_LEVEL=info
MAX_FRAME_BYTES=524288
RATE_LIMIT_MAX=60
EOF
  echo "✓ 已生成 .env（权限 600，含随机密钥）。请立即离线备份，切勿提交代码库。"
else
  echo "✓ 沿用已有 .env（密钥不变）；如需改域名请手动编辑 .env 中的 RELAY_DOMAIN。"
  DOMAIN="$(env_get RELAY_DOMAIN)"
  case "$DOMAIN" in
    *example.com|*example.org|*example.net|"")
      echo "⚠ 警告：.env 里 RELAY_DOMAIN='${DOMAIN}' 仍是示例占位值，Caddy 会一直申请证书失败。" >&2
      echo "   请编辑 .env 改成真实域名，再执行：docker compose up -d --force-recreate caddy" >&2
      echo "   暂时没有域名可先只验证服务：bash verify.sh http://127.0.0.1:3000" >&2
      ;;
  esac
fi

PORT="$(env_get RELAY_PORT 3000)"

echo "→ 构建并启动（域名: ${DOMAIN}）"
docker compose up -d --build

echo "→ 等待 relay 健康就绪"
STATUS=""
for _ in $(seq 1 30); do
  STATUS="$(docker inspect -f '{{.State.Health.Status}}' remote-assist-relay 2>/dev/null || echo starting)"
  [ "$STATUS" = "healthy" ] && break
  sleep 2
done
if [ "$STATUS" != "healthy" ]; then
  echo "✗ relay 未就绪（状态: ${STATUS}），最近日志：" >&2
  docker compose logs --tail=80 relay >&2
  exit 1
fi
echo "✓ relay healthy"

echo "→ 本机直连健康检查"
curl -fsS "http://127.0.0.1:${PORT}/health"; echo
curl -fsS "http://127.0.0.1:${PORT}/ready"; echo

echo
echo "=== 容器已启动，还需要在云控制台完成 ==="
echo "1) DNS：把 ${DOMAIN} 的 A 记录指向本机公网 IP（Caddy 靠它自动申请 HTTPS 证书）。"
echo "2) 安全组/防火墙：放行 TCP 80、443；不要放行 ${PORT}（relay 只绑回环）。"
echo "3) 证书签发后执行：bash verify.sh    # REST + 双端 WebSocket 全链路验证"
echo "4) 两个 Android App 首页填 https://${DOMAIN}（release 包强制 HTTPS，会自动转 wss://）。"
echo
echo "常用命令：docker compose ps / logs -f relay / logs -f caddy / down"
