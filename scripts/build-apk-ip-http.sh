#!/usr/bin/env bash
# 构建「纯公网 IP + 明文 HTTP」专用的两个正式签名 APK（release 变体）
#
#   bash scripts/build-apk-ip-http.sh                       # 默认 http://8.138.221.245:3000
#   bash scripts/build-apk-ip-http.sh http://1.2.3.4:3000    # 换服务器地址
#
# 产物：dist/ip-http/remote-host-ip-http.apk、remote-controller-ip-http.apk
# 与 dist/release/ 的常规正式包（强制 HTTPS、不预置地址）完全隔离，不会覆盖。
#
# ⚠ 这类包放开明文 HTTP 并预置固定地址，画面 / 控制指令 / 配对码 / JWT 全部明文过公网，
#   仅限配合 deploy/switch-ip-http.sh 的 IP 直连模式临时联调，禁止对外分发。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_URL="${1:-http://8.138.221.245:3000}"
OUT_DIR="$ROOT/dist/ip-http"

case "$DEFAULT_URL" in
  http://*) ;;
  *)
    echo "错误：本脚本只用于明文 HTTP 地址，收到 ${DEFAULT_URL}" >&2
    echo "      HTTPS 正式包请用：bash scripts/build-apk.sh all release" >&2
    exit 2
    ;;
esac

JDK="/c/Users/Administrator/.jdks/jbr-21.0.11"
if [ ! -x "$JDK/bin/java.exe" ]; then
  echo "错误：找不到 JDK 21：$JDK" >&2
  exit 1
fi
export JAVA_HOME="$JDK"

GRADLE_BIN="$(find "$HOME/.gradle/wrapper/dists/gradle-8.7-bin" -maxdepth 5 -type f -name gradle 2>/dev/null | head -1 || true)"
if [ -z "$GRADLE_BIN" ]; then
  echo "错误：找不到缓存的 Gradle 8.7，先用 Android Studio 打开项目做一次 Gradle Sync" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

build() {
  local mod="$1" short="$2"
  echo "==> 构建 ${mod}（release 签名 + 预置 ${DEFAULT_URL}）"
  ( cd "$ROOT/$mod" && "$GRADLE_BIN" :app:assembleRelease \
      --console=plain --offline --no-daemon \
      "-PrelayDefaultUrl=${DEFAULT_URL}" -PrelayAllowCleartext=true )
  local apk="$ROOT/$mod/app/build/outputs/apk/release/app-release.apk"
  if [ ! -f "$apk" ]; then
    echo "✗ 未找到构建产物：$apk" >&2
    exit 1
  fi
  local target="$OUT_DIR/remote-${short}-ip-http.apk"
  cp -f "$apk" "$target"
  echo "    -> ${target} ($(du -h "$target" | cut -f1))"
}

build android-host host
build android-controller controller

echo
echo "→ 校验签名"
APKSIGNER_JAR="/d/Android/Sdk/build-tools/34.0.0/lib/apksigner.jar"
if [ -f "$APKSIGNER_JAR" ] && command -v cygpath >/dev/null 2>&1; then
  JAR_ARG="$(cygpath -w "$APKSIGNER_JAR")"
  for f in "$OUT_DIR"/*.apk; do
    APK_ARG="$(cygpath -w "$f")"
    echo "  $(basename "$f"):"
    "$JDK/bin/java.exe" -jar "$JAR_ARG" verify --verbose "$APK_ARG" 2>&1 \
      | grep -E 'Verifies|Signer #1 certificate DN' | head -3 || true
  done
else
  echo "  （未找到 apksigner.jar 或 cygpath，跳过签名校验）"
  echo "  /d/Android/Sdk/build-tools/34.0.0/apksigner.bat verify --verbose <apk>"
fi

echo
echo "✓ 完成：$(find "$OUT_DIR" -maxdepth 1 -name '*.apk' | wc -l | tr -d ' ') 个 APK 在 ${OUT_DIR}"
echo "  两端安装后首页已预填 ${DEFAULT_URL}，无需手输。"
echo "  与 dist/release/ 同一把正式证书，可直接覆盖安装；但 App 不覆盖已保存的地址，"
echo "  若之前填过别的地址，需清除应用数据 / 卸载重装，或手动改成同一地址。"
echo
echo "⚠ 这套包放开了明文 HTTP，仅限 IP 直连临时联调；"
echo "  正式分发请用 dist/release/ 的 HTTPS 包（bash scripts/build-apk.sh all release）。"
