#!/bin/bash
# 把 Tools/Models 里的 .mlpackage 编译成 iOS 用的 .mlmodelc，放进 App 资源目录。
#
#   Tools/Models/compile_model.sh
#
# 为什么要有这一步：App 的 target 用的是 Xcode 16 的「文件系统同步组」，
# Resources 目录里的东西会被自动纳入。正常情况下把 .mlpackage 直接丢进
# Resources 就行，Xcode 会自己调 coremlc 编译。
#
# 但 coremlc 在 Xcode 里是被 sandbox-exec 包着跑的，而这台机器上
# sandbox-exec 直接不可用（连 `/usr/bin/sandbox-exec ... /bin/echo` 都返回
# "sandbox_apply: Operation not permitted"），于是任何一个要编译 Core ML 模型的
# 构建都会失败在 CoreMLModelCompile 这一步。所以这里改成**随包携带编译产物**：
# 构建期不再需要 coremlc，任何机器都能编过。
#
# 代价：模型换了必须重新跑这个脚本，否则 App 用的还是旧模型。
# 加回自动编译的办法：把 .mlpackage 放回 BrewPhase/Resources/，并确认那台机器上
# sandbox-exec 可用（`sandbox-exec -p '(version 1)(allow default)' /bin/echo ok`）。
#
# 验证模型对不对只能靠工程里的验收测试——它是拿合成数据训练的，看数字也看不出来：
#   xcodebuild test -only-testing:BrewPhaseTests/FlavorModelTests
# 那份测试里钉着基准曲线；换模型后基准要同步，否则它会红。

set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/Tools/Models/brewphase_xgb.mlpackage"
DEST="$ROOT/BrewPhase/Resources/brewphase_xgb.mlmodelc"

# 本机 xcode-select 指向 CommandLineTools，coremlc 得从 Xcode 里显式取。
DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
COREMLC="$DEVELOPER_DIR/Toolchains/XcodeDefault.xctoolchain/usr/bin/coremlc"

if [ ! -x "$COREMLC" ]; then
  echo "找不到 coremlc：$COREMLC"
  echo "装好 Xcode 或设一下 DEVELOPER_DIR 再试。"
  exit 1
fi
[ -d "$SRC" ] || { echo "找不到 $SRC"; exit 1; }

# 模型必须按 App 的最低系统版本来编，否则真机上加载会失败。
DEPLOYMENT_TARGET=$(sed -n 's/.*IPHONEOS_DEPLOYMENT_TARGET = \([0-9.]*\);.*/\1/p' \
  "$ROOT/BrewPhase.xcodeproj/project.pbxproj" | head -1)
DEPLOYMENT_TARGET="${DEPLOYMENT_TARGET:-18.0}"

SDK=$(xcrun --sdk iphonesimulator --show-sdk-path)
echo "编译 $SRC"
echo "  deployment target : $DEPLOYMENT_TARGET"
echo "  sdk               : $SDK"

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

"$COREMLC" compile "$SRC" "$STAGE/" \
  --deployment-target "$DEPLOYMENT_TARGET" \
  --sdkroot "$SDK" \
  --platform ios \
  --container bundle-resources

rm -rf "$DEST"
cp -R "$STAGE/brewphase_xgb.mlmodelc" "$DEST"

echo "已写入 $DEST"
du -sh "$DEST"
echo
echo "注意：这个模型是用合成数据训练的实验模型，产物与 feature_schema.json 是绑定的。"
echo "换模型时，除了重跑本脚本，还要把 Reports/metrics.json 的 example_curve 同步到"
echo "BrewPhaseTests/FlavorModelTests.swift，否则那条验收测试会红。"
