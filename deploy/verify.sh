#!/usr/bin/env bash
# 线上全链路验证：REST + 双端 WebSocket（含 Upgrade 透传、二进制帧逐字节一致）
# 直接在 relay 容器内运行，复用镜像自带的 Node 22 与 ws 依赖，宿主机无需装 Node。
#   bash verify.sh [https://relay.example.com]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [ ! -f .env ]; then
  echo "错误：未找到 .env，请先执行 bash deploy.sh <域名>" >&2
  exit 1
fi

env_get() {
  local key="$1" default="${2:-}" val
  val="$(grep -E "^${key}=" .env 2>/dev/null | head -n1 | cut -d= -f2- | tr -d '"' | tr -d '\r' || true)"
  printf '%s' "${val:-$default}"
}

BASE="${1:-https://$(env_get RELAY_DOMAIN)}"
SCRIPT="$ROOT/../server/scripts/verify-remote.mjs"

# 示例占位域名不会解析，给出可操作的提示，而不是甩一个裸 curl 报错
case "$BASE" in
  *example.com|*example.org|*example.net)
    echo "✗ 目标还是示例占位域名 ${BASE}（DNS 不存在，故 Could not resolve host）。" >&2
    echo "  有真实域名：改 deploy/.env 的 RELAY_DOMAIN，然后重建反代：" >&2
    echo "    docker compose up -d --force-recreate caddy" >&2
    echo "  只想先验服务本身（不需要域名/证书）：" >&2
    echo "    bash verify.sh http://127.0.0.1:3000" >&2
    exit 1
    ;;
esac

if [ ! -f "$SCRIPT" ]; then
  echo "错误：未找到 ../server/scripts/verify-remote.mjs" >&2
  exit 1
fi
if ! docker ps --format '{{.Names}}' | grep -qx remote-assist-relay; then
  echo "错误：remote-assist-relay 容器未运行，请先执行 bash deploy.sh" >&2
  exit 1
fi

echo "→ 目标：${BASE}"
echo "→ 1/3 健康检查"
if ! HEALTH="$(curl -fsS --connect-timeout 10 "${BASE}/health")"; then
  echo
  echo "✗ 访问 ${BASE} 失败。按顺序排查：" >&2
  echo "  1) 容器：docker compose -f docker-compose.ip-http.yml ps / logs --tail=80 relay" >&2
  echo "  2) 域名 HTTPS 模式：getent hosts <域名> 应返回公网 IP；docker compose logs --tail=50 caddy 看证书" >&2
  echo "  3) 安全组：域名模式放行 TCP 80/443；IP 直连模式放行 TCP 3000" >&2
  echo "  4) 只验服务本身：bash verify.sh http://127.0.0.1:3000" >&2
  exit 1
fi
echo "$HEALTH"
curl -fsS "${BASE}/ready"; echo

echo "→ 2/3 载入验证脚本到容器"
docker cp "$SCRIPT" remote-assist-relay:/app/verify-remote.mjs

echo "→ 3/3 全链路验证（REST 配对鉴权 + 双端 WS 文本/二进制帧）"
if ! docker exec -e "BASE_URL=${BASE}" -w /app remote-assist-relay node verify-remote.mjs; then
  echo
  echo "✗ 验证失败。先看日志：" >&2
  echo "  IP 直连模式：docker compose -f docker-compose.ip-http.yml logs --tail=80 relay" >&2
  echo "  域名模式：docker compose logs --tail=80 caddy（WS 全失败多为反代未透传 Upgrade 或证书未签发）" >&2
  echo "若容器内访问自身公网地址不通（NAT 回流限制），可把 BASE_URL 换成宿主机可达的等价地址重试。" >&2
  exit 1
fi

echo
case "$BASE" in
  http://127.0.0.1*|http://localhost*)
    echo "✓ 服务本身全链路通过（本地回环直连，未经域名 / HTTPS / 反代）。"
    echo "  接下来二选一："
    echo "  · IP 直连模式：云安全组放行 TCP 3000，两端装 debug 包并填 http://<公网IP>:3000，"
    echo "    再从外网执行 curl http://<公网IP>:3000/health 确认公网可达。"
    echo "  · 域名 HTTPS 模式：改 .env 的 RELAY_DOMAIN / CADDY_EMAIL，"
    echo "    docker compose up -d --build --remove-orphans，再 bash verify.sh https://<域名>"
    ;;
  *)
    echo "✓ 全链路通过。两端 App 填 ${BASE} 即可跨网远程协助。"
    ;;
esac
