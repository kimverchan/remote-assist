#!/usr/bin/env bash
# 命令行构建两端 APK（无需打开 Android Studio）
#
# 环境依据（本机实测）：
#   - AGP 8.6.1 拒绝 JDK 25（AS/LiveEdit 自带的 jbr 是 25），必须用 IDE 下载的 JDK 21
#   - Gradle 8.7 发行版已由 Android Studio sync 缓存到 ~/.gradle/wrapper/dists
#   - Android SDK: D:\Android\Sdk（见各项目 local.properties 的 sdk.dir）
#
# 用法：bash scripts/build-apk.sh [host|controller|all] [debug|release]
#   release 包使用仓库根 keystore.properties 里的签名；文件缺失时仍可构建但 APK 不带签名
#   「纯公网 IP + 明文 HTTP 预置地址」的专用正式包请用 scripts/build-apk-ip-http.sh
set -euo pipefail

JDK="/c/Users/Administrator/.jdks/jbr-21.0.11"
if [ ! -x "$JDK/bin/java.exe" ]; then
  echo "找不到 JDK 21：$JDK" >&2
  echo "请在 Android Studio: Settings > Build Tools > Gradle > Gradle JDK 里下载 21，或用 -Dorg.gradle.java.home 指定" >&2
  exit 1
fi
export JAVA_HOME="$JDK"

GRADLE_BIN=$(find "$HOME/.gradle/wrapper/dists/gradle-8.7-bin" -maxdepth 5 -type f -name gradle 2>/dev/null | head -1 || true)
if [ -z "${GRADLE_BIN}" ]; then
  echo "找不到缓存的 Gradle 8.7，先用 Android Studio 打开项目做一次 Gradle Sync" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-all}"
MODE="${2:-debug}"
# 调试包与正式包分目录存放，避免把带明文隧道地址的 debug 包误当交付物分发
OUT_DIR="$ROOT/dist/$MODE"

case "$MODE" in
  debug)   TASK=":app:assembleDebug";   VARIANT="debug" ;;
  release) TASK=":app:assembleRelease"; VARIANT="release" ;;
  *) echo "用法: $0 [host|controller|all] [debug|release]" >&2; exit 2 ;;
esac

build() {
  local mod="$1"
  echo "==> 构建 $mod ($VARIANT)"
  ( cd "$ROOT/$mod" && "$GRADLE_BIN" "$TASK" --console=plain --offline --no-daemon )
  local apk="$ROOT/$mod/app/build/outputs/apk/$VARIANT/app-$VARIANT.apk"
  if [ -f "$apk" ]; then
    mkdir -p "$OUT_DIR"
    local target="$OUT_DIR/remote-${mod#android-}-$VARIANT.apk"
    cp -f "$apk" "$target"
    echo "    APK: $target ($(du -h "$target" | cut -f1))"
  fi
}

case "$TARGET" in
  host)       build android-host ;;
  controller) build android-controller ;;
  all)        build android-host; build android-controller ;;
  *)          echo "用法: $0 [host|controller|all] [debug|release]" >&2; exit 2 ;;
esac

if [ "$MODE" = "release" ]; then
  echo "完成。正式包请用 apksigner 校验签名后再分发："
  echo "  /d/Android/Sdk/build-tools/34.0.0/apksigner.bat verify --verbose <apk 路径>"
else
  echo "完成。安装到真机：adb install -r <apk 路径>"
fi
