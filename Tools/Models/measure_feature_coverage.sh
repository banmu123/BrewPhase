#!/bin/bash
# 量一件事：App 手上真实存在的数据，能填满风味窗口模型 85 个特征里的几个？
#
#   Tools/Models/measure_feature_coverage.sh
#
# 为什么值得留一个可跑的工具，而不是把数字写进文档就算了：这个覆盖率是「该不该为模型
# 补字段」的判据，补一个字段就应该重量一次。手写在文档里的数字会过期，工具不会。
#
# 判据是**槽位是否携带来自 App 的信息**：
#   * one-hot 组匹配上了 -> 组内只有那个 1.0 算有信息，其余 0 是结构性的；
#   * 数值特征有真实值（或能从真实值推出来，例如液重按水量算）-> 算；用训练均值补的不算；
#   * 二值特征只有 App 真提供了才算。
#
# 它用**产品代码本身**（FlavorFeatureBuilder）来编码，不是另写一份，所以量到的就是
# App 真正会喂给模型的东西。

set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/BrewPhase"
RESOURCES="$APP/Resources"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

[ -f "$RESOURCES/feature_schema.json" ] || { echo "找不到 feature_schema.json"; exit 1; }
[ -f "$RESOURCES/flavor_mapping.json" ] || { echo "找不到 flavor_mapping.json"; exit 1; }

# 编码层要在可执行文件旁边找这两分 JSON（Bundle.main.bundleURL 是它所在目录）。
cp "$RESOURCES/feature_schema.json" "$RESOURCES/flavor_mapping.json" "$WORK/"

# metrics.json 用来换算「权重覆盖率」；没有就跳过那一段。
METRICS="$ROOT/Tools/Models/metrics.json"
[ -f "$METRICS" ] && cp "$METRICS" "$WORK/" || echo "提示：没有 Tools/Models/metrics.json，将跳过权重覆盖率"

# 顶层代码只有在名为 main.swift 的文件里才允许。
cat > "$WORK/main.swift" <<'SWIFT'
import Foundation

guard let schema = FlavorModelResources.schema,
      let mapping = FlavorModelResources.mapping,
      let index = FlavorModelResources.aliasIndex
else {
    print("资源没加载起来")
    exit(1)
}

// 一个真实用户手上那包豆子——App 能提供的全部信息，一样不多。
// 中英混写的产区、真实烘焙商名、自由文本的研磨度，都是实际情况。
let realistic = FlavorInput(
    roastLevel: .light,
    originCountryText: "埃塞俄比亚 · Guji",
    originRegionText: "埃塞俄比亚 · Guji",
    processText: "水洗",
    roasterText: "启程咖啡",
    brewMethodText: "V60",
    openDayAfterRoast: 6,
    openBasis: .openDate,
    doseG: 18,
    waterTempC: 92,
    waterWeightG: 300,
    beverageWeightG: nil,          // App 没有液重字段
    brewTimeSeconds: 150,
    grindSizeTenScale: nil         // App 存的是「22 格」，1–10 刻度无从得知
)

let output = FlavorFeatureBuilder.build(
    input: realistic, dayAfterRoast: 12, schema: schema, mapping: mapping, index: index
)
let diagnostics = output.diagnostics

let unavailable = Set(diagnostics.unavailable)
let unmatched = Set(diagnostics.unmatched)
// 按设计就永远对不上的组（烘焙商：模型只认 Roaster_01…20 占位名）在诊断里是**静默跳过**
// 的，不会出现在上面两个集合里。不单独排除的话会被误算成「App 提供了这个信息」。
let alwaysUnmatched = Set(mapping.expectedUnmatched.keys)

let matchedGroups = schema.categoricalNames.filter {
    !unavailable.contains($0) && !unmatched.contains($0) && !alwaysUnmatched.contains($0)
}
let liveNumerics = schema.numericNames.filter { !unavailable.contains($0) }
// `opened` 由真实开封日派生，算；`one_way_valve` App 没有字段、悄悄填了 0，不算。
let liveBinaries = schema.binaryNames.filter { $0 == "opened" }

let imputedNumerics = schema.numericNames.filter { unavailable.contains($0) }
let informative = matchedGroups.count + liveNumerics.count + liveBinaries.count

print("=== App 能提供的真实信息，能填满几个特征槽位 ===")
print("模型特征总数            : \(schema.featureNames.count)")
print("携带 App 真实信息的槽位  : \(informative)")
print("其余                    : \(schema.featureNames.count - informative)（默认值或结构性 0）")
print()
print("有信息的 one-hot 组 (\(matchedGroups.count)/\(schema.categoricalNames.count))：")
print("  " + matchedGroups.joined(separator: "、"))
print("没有的组 (\(schema.categoricalNames.count - matchedGroups.count))：")
print("  " + schema.categoricalNames.filter { !matchedGroups.contains($0) }.joined(separator: "、"))
print()
print("有真实值的数值特征 (\(liveNumerics.count)/\(schema.numericNames.count))：")
print("  " + liveNumerics.joined(separator: "、"))
print("用训练均值补的 (\(imputedNumerics.count))：")
print("  " + imputedNumerics.joined(separator: "、"))
print("二值：\(liveBinaries.joined(separator: "、"))（one_way_valve 走默认值）")

// MARK: - 换算成「权重覆盖率」：模型真正在意的那部分，App 能不能提供

let metricsURL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    .appendingPathComponent("metrics.json")
guard let data = try? Data(contentsOf: metricsURL),
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let importance = json["feature_importance_top20"] as? [[Any]]
else {
    print("\n(没有 metrics.json，跳过权重覆盖率)")
    exit(0)
}

func isInformative(_ feature: String) -> Bool {
    if let range = feature.range(of: "__") {
        let group = String(feature[feature.startIndex..<range.lowerBound])
        return matchedGroups.contains(group)
    }
    if schema.binaryNames.contains(feature) { return liveBinaries.contains(feature) }
    return liveNumerics.contains(feature)
}

var totalWeight = 0.0
var coveredWeight = 0.0
var lines: [(String, Double, Bool)] = []
for entry in importance {
    guard let name = entry.first as? String, let weight = entry.last as? Double else { continue }
    let covered = isInformative(name)
    totalWeight += weight
    if covered { coveredWeight += weight }
    lines.append((name, weight, covered))
}

print()
print("=== 模型 top20 重要性里，App 能提供的部分 ===")
for (name, weight, covered) in lines.sorted(by: { $0.1 > $1.1 }) {
    print(String(format: "  [%@] %-34@ %5.2f%%", covered ? "有" : "缺", name as NSString, weight * 100))
}
print()
print(String(format: "top20 权重合计 %.2f%%，其中 App 能提供 %.2f%%（覆盖 %.0f%%）",
             totalWeight * 100, coveredWeight * 100,
             totalWeight > 0 ? coveredWeight / totalWeight * 100 : 0))
SWIFT

echo "== 编译（用 App 的真实源码，不是复制品）=="
swiftc -O -o "$WORK/coverage" "$WORK/main.swift" \
  "$APP/ML/FlavorModelResources.swift" \
  "$APP/ML/FlavorFeatureBuilder.swift" \
  "$APP/Models/RoastLevel.swift" \
  "$APP/App/LanguageManager.swift" \
  "$APP/App/AppLog.swift" 2>&1 | grep -E "error:" && { echo "编译失败"; exit 1; }

echo "== 运行 =="
cd "$WORK"
./coverage
