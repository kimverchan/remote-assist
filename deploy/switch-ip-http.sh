#!/usr/bin/env bash
# 切换到「纯公网 IP + 明文 HTTP」直连模式（仅临时联调，两端必须装 debug 包）
#
#   在云服务器上的 deploy/ 目录内执行：bash switch-ip-http.sh
#
# 作用：用 docker-compose.ip-http.yml 重建 relay（0.0.0.0:3000、TRUST_PROXY=false），
#       并用 --remove-orphans 移除 HTTPS 模式的 Caddy 容器（与旧编排共用
#       project name = remote-assist-relay，所以能被正确识别并清理）。
# 切回 HTTPS 域名模式的方法打印在脚本末尾（docker compose up -d --build --remove-orphans）。
#
# ⚠ 屏幕画面、控制指令、设备号密码、JWT 全部明文过公网，可被中间人窃听或篡改。
#   仅限可信网络内临时联调，禁止分发、禁止用于真实远程协助。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

COMPOSE="docker-compose.ip-http.yml"
URL_LOCAL="http://127.0.0.1:3000"

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

# ---------- 前置检查 ----------
if [ ! -f "$ROOT/../server/Dockerfile" ]; then
  echo "错误：未找到 ../server/Dockerfile。上传时请确保 server/ 与 deploy/ 同级。" >&2
  exit 1
fi
if [ ! -f "$COMPOSE" ]; then
  echo "错误：未找到 $COMPOSE，服务器上的部署包还是旧版。" >&2
  echo "      请重新上传 dist/relay-deploy.tgz，或单独 scp 该文件到 deploy/：" >&2
  echo "      scp deploy/docker-compose.ip-http.yml deploy/switch-ip-http.sh deploy/verify.sh user@<公网IP>:/opt/remote-assist-relay/deploy/" >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "错误：需要 Docker Compose v2 插件（docker compose version）。" >&2
  exit 1
fi

# 纯 IP 模式不需要域名与证书；没有 .env 时生成一份最小配置（密钥随机）
if [ ! -f .env ]; then
  echo "→ 未发现 .env，生成纯 IP 模式所需的最小配置（随机密钥，权限 600）"
  umask 077
  cat > .env <<EOF
# 纯公网 IP 明文模式：不需要 RELAY_DOMAIN / CADDY_EMAIL，不启动 Caddy。
# 切回 HTTPS 域名模式时需手动补上这两行。
JWT_SECRET=$(randhex 32)
ADMIN_API_KEY=$(randhex 24)
CORS_ORIGINS=http://localhost:5173
LOG_LEVEL=info
MAX_FRAME_BYTES=524288
RATE_LIMIT_MAX=60
EOF
  echo "✓ 已生成 .env，请立即离线备份（含密钥，勿提交代码库）。"
else
  echo "✓ 沿用已有 .env（密钥不变）。"
fi

JWT="$(env_get JWT_SECRET)"
ADMIN="$(env_get ADMIN_API_KEY)"
if [ "${#JWT}" -lt 32 ] || [ "${#ADMIN}" -lt 16 ]; then
  echo "错误：.env 中 JWT_SECRET 需 ≥32 字符、ADMIN_API_KEY 需 ≥16 字符，服务端会拒绝启动。" >&2
  echo "      修正后重跑；注意换密钥会让已签发令牌全部失效。" >&2
  exit 1
fi
if [ -n "$(env_get RELAY_DOMAIN)" ]; then
  echo "   （.env 里残留的 RELAY_DOMAIN 在本模式不使用，无需改动）"
fi

echo
echo "⚠️  即将切到【明文 HTTP 直连】：relay 暴露 0.0.0.0:3000，无 TLS、无反代。"
echo "    画面 / 控制指令 / 设备号密码 / JWT 全部明文过公网，仅限临时联调。"
echo "    两端只能使用 dist/debug/ 的 APK；release 包会拒绝 http:// 地址。"
echo

# ---------- 切换编排 ----------
echo "→ 构建并启动 IP 直连模式（同时清理 HTTPS 模式的 Caddy）"
docker compose -f "$COMPOSE" up -d --build --remove-orphans

echo "→ 等待 relay 健康就绪"
STATUS=""
for _ in $(seq 1 30); do
  STATUS="$(docker inspect -f '{{.State.Health.Status}}' remote-assist-relay 2>/dev/null || echo starting)"
  [ "$STATUS" = "healthy" ] && break
  sleep 2
done
if [ "$STATUS" != "healthy" ]; then
  echo "✗ relay 未就绪（状态: ${STATUS}），最近日志：" >&2
  docker compose -f "$COMPOSE" logs --tail=80 relay >&2
  exit 1
fi
echo "✓ relay healthy"

echo "→ 容器状态与端口绑定（应为 0.0.0.0:3000，而不是 127.0.0.1:3000）"
docker compose -f "$COMPOSE" ps
docker port remote-assist-relay 3000/tcp || true

echo "→ 本机健康检查"
curl -fsS "${URL_LOCAL}/health"; echo
curl -fsS "${URL_LOCAL}/ready"; echo

# ---------- 全链路验证 ----------
if [ -f verify.sh ] && [ -f "$ROOT/../server/scripts/verify-remote.mjs" ]; then
  echo "→ REST + 双端 WebSocket 全链路验证"
  if ! bash verify.sh "$URL_LOCAL"; then
    echo "⚠ 全链路验证未通过，容器仍已启动；按上方报错排查后重跑：bash verify.sh $URL_LOCAL" >&2
  fi
else
  echo "⚠ 未找到 verify.sh 或验证脚本，跳过全链路验证（建议重传完整部署包）。"
fi

# ---------- 探测公网 IP，输出剩余步骤 ----------
PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP="$(curl -fsS --max-time 5 https://ifconfig.me/ip 2>/dev/null || true)"
fi
[ -n "$PUBLIC_IP" ] || PUBLIC_IP="<公网IP>"

echo
echo "=== 服务端切换完成，还需在云控制台 / 手机上完成 ==="
echo "1) 云安全组 + 系统防火墙放行 TCP 3000（本模式唯一需要开的端口；80/443 可不开）。"
echo "   服务器上确认监听：ss -tlnp | grep 3000  应看到 0.0.0.0:3000"
echo "2) 从另一台设备/手机浏览器验证公网可达：curl http://${PUBLIC_IP}:3000/health"
echo "   （不通就查安全组、firewalld/ufw、以及运营商是否封了高端口）"
echo "3) 两个 App 装 dist/debug/remote-host-debug.apk 与 remote-controller-debug.apk；"
echo "   debug 与 release 签名不同，覆盖安装需先卸载；报 INSTALL_FAILED_TEST_ONLY 用 adb install -t -r。"
echo "4) 两个 App 首页都填： http://${PUBLIC_IP}:3000"
echo "   ⚠ debug 包预置的是旧的 natapp 隧道地址 http://sfedf6bb.natappfree.cc，"
echo "     必须手动清空改成上面的地址；两端填的必须完全一致。"
echo
echo "切回 HTTPS 域名模式："
echo "  sed -i 's/^RELAY_DOMAIN=.*/RELAY_DOMAIN=relay.yourdomain.com/' .env   # 没有则手动加一行"
echo "  sed -i 's/^CADDY_EMAIL=.*/CADDY_EMAIL=admin@yourdomain.com/' .env     # 没有则手动加一行"
echo "  docker compose up -d --build --remove-orphans"
echo "  bash verify.sh https://relay.yourdomain.com"
