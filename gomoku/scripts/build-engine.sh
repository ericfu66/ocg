#!/usr/bin/env bash
# 从 GitHub 拉取最新 Rapfi 源码与最新权重，编译并组装到引擎目录。
#
# 用法：scripts/build-engine.sh [输出目录]
# 环境变量：
#   CPU_TARGET   avx2（默认，兼容 2013 年后绝大多数 x86 服务器）| avx512 | avxvnni | sse | native | arm64
#   RAPFI_REPO   Rapfi 源码仓库（默认 https://github.com/dhbloo/rapfi）
#   RAPFI_REF    分支/标签（默认 master）
#   NETWORKS_REPO 权重仓库（默认 https://github.com/dhbloo/rapfi-networks）
#   NETWORKS_REF  分支/标签（默认 main）
#   WORK_DIR     源码下载目录（默认 /tmp/rapfi-build）
#   JOBS         并行编译数（默认 CPU 核数）
set -euo pipefail

OUT_DIR="$(realpath -m "${1:-$(dirname "$0")/../engine}")"
CPU_TARGET="${CPU_TARGET:-avx2}"
RAPFI_REPO="${RAPFI_REPO:-https://github.com/dhbloo/rapfi}"
RAPFI_REF="${RAPFI_REF:-master}"
NETWORKS_REPO="${NETWORKS_REPO:-https://github.com/dhbloo/rapfi-networks}"
NETWORKS_REF="${NETWORKS_REF:-main}"
WORK_DIR="${WORK_DIR:-/tmp/rapfi-build}"
JOBS="${JOBS:-$(nproc)}"

case "$CPU_TARGET" in
  sse)     FLAGS="-DUSE_SSE=ON -DUSE_AVX2=OFF -DUSE_AVX512=OFF -DUSE_BMI2=OFF -DUSE_VNNI=OFF" ;;
  avx2)    FLAGS="-DUSE_SSE=ON -DUSE_AVX2=ON -DUSE_AVX512=OFF -DUSE_BMI2=OFF -DUSE_VNNI=OFF" ;;
  avxvnni) FLAGS="-DUSE_SSE=ON -DUSE_AVX2=ON -DUSE_AVX512=OFF -DUSE_BMI2=ON -DUSE_VNNI=ON" ;;
  avx512)  FLAGS="-DUSE_SSE=ON -DUSE_AVX2=ON -DUSE_AVX512=ON -DUSE_BMI2=ON -DUSE_VNNI=ON" ;;
  native)  FLAGS="-DUSE_SSE=ON -DUSE_AVX2=ON" ;;  # x86 下会在后面按本机 CPU 自动细化
  arm64)   FLAGS="-DUSE_NEON=ON -DUSE_NEON_DOTPROD=OFF" ;;
  *) echo "未知 CPU_TARGET: $CPU_TARGET" >&2; exit 1 ;;
esac

if [ "$CPU_TARGET" = native ] && [ "$(uname -m)" = x86_64 ]; then
  # 根据本机 CPU 自动选择指令集
  if grep -q avx512_vnni /proc/cpuinfo; then FLAGS="-DUSE_SSE=ON -DUSE_AVX2=ON -DUSE_AVX512=ON -DUSE_BMI2=ON -DUSE_VNNI=ON"
  elif grep -q avx_vnni /proc/cpuinfo; then FLAGS="-DUSE_SSE=ON -DUSE_AVX2=ON -DUSE_AVX512=OFF -DUSE_BMI2=ON -DUSE_VNNI=ON"
  elif grep -q avx2 /proc/cpuinfo; then FLAGS="-DUSE_SSE=ON -DUSE_AVX2=ON -DUSE_AVX512=OFF -DUSE_BMI2=OFF -DUSE_VNNI=OFF"
  else FLAGS="-DUSE_SSE=ON -DUSE_AVX2=OFF -DUSE_AVX512=OFF -DUSE_BMI2=OFF -DUSE_VNNI=OFF"; fi
  echo "native -> $FLAGS"
fi

CC_BIN=clang; CXX_BIN=clang++
command -v clang++ >/dev/null || { CC_BIN=gcc; CXX_BIN=g++; echo "未找到 clang，改用 gcc（速度略慢）"; }

mkdir -p "$WORK_DIR"
fetch() { # repo ref dir
  if [ -d "$3/.git" ]; then
    git -C "$3" fetch --depth 1 origin "$2" && git -C "$3" checkout -q FETCH_HEAD
  else
    git clone --depth 1 --branch "$2" "$1" "$3"
  fi
}
echo ">> 下载 Rapfi 源码 ($RAPFI_REF)"
fetch "$RAPFI_REPO" "$RAPFI_REF" "$WORK_DIR/rapfi"
echo ">> 下载最新权重 ($NETWORKS_REF)"
fetch "$NETWORKS_REPO" "$NETWORKS_REF" "$WORK_DIR/networks"

echo ">> 编译 Rapfi ($CPU_TARGET)"
BUILD="$WORK_DIR/rapfi/Rapfi/build/$CPU_TARGET"
cmake -S "$WORK_DIR/rapfi/Rapfi" -B "$BUILD" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_COMPILER=$CC_BIN -DCMAKE_CXX_COMPILER=$CXX_BIN -DNO_COMMAND_MODULES=ON $FLAGS
cmake --build "$BUILD" -j "$JOBS"

echo ">> 组装引擎目录 $OUT_DIR"
mkdir -p "$OUT_DIR"
install -m 755 "$BUILD/pbrain-rapfi" "$OUT_DIR/pbrain-rapfi"
N="$WORK_DIR/networks"
cp "$N"/config-example/config.toml "$OUT_DIR/config.toml"   # 官方 NNUE 配置（坐标模式 none，适配 Piskvork 协议）
cp "$N"/classical/*.bin "$OUT_DIR/"
for d in "$N"/*/; do  # 所有 NNUE 权重目录（如 mix9svq）
  case "$(basename "$d")" in classical|config-example) continue ;; esac
  cp "$d"*.lz4 "$OUT_DIR/" 2>/dev/null || true
  cp "$d"*.bin "$OUT_DIR/" 2>/dev/null || true
done
{
  echo "rapfi:    $(git -C "$WORK_DIR/rapfi" rev-parse HEAD) ($(git -C "$WORK_DIR/rapfi" log -1 --format=%cd --date=short))"
  echo "networks: $(git -C "$N" rev-parse HEAD) ($(git -C "$N" log -1 --format=%cd --date=short))"
  echo "target:   $CPU_TARGET"
} > "$OUT_DIR/VERSION.txt"

echo ">> 自检"
printf 'START 15\nINFO rule 0\nINFO timeout_turn 1000\nBEGIN\nEND\n' | (cd "$OUT_DIR" && timeout 30 ./pbrain-rapfi) | grep -E "nnue|^[0-9]+,[0-9]+$|ERROR" || true
cat "$OUT_DIR/VERSION.txt"
ls -la "$OUT_DIR"
echo ">> 完成"
