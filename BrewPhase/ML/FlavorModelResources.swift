import Foundation

/// `feature_schema.json` — 模型契约，App 侧唯一权威来源。
///
/// 85 个特征的名字和顺序都从这里读，**不在 Swift 里硬编码**：协议里写明这是
/// Feature Schema v1（已冻结），将来会有 v2，App 的域模型不该跟着重新编译。
struct FlavorSchema: Sendable {

    /// 11 个数值特征，直接传 Double。
    let numericNames: [String]
    /// 2 个二值特征，传 0.0 / 1.0。
    let binaryNames: [String]
    /// 9 个 one-hot 组，每组内恰好一个 1.0、其余 0.0。
    let categoricalNames: [String]
    /// 85 个特征名，**这个顺序就是向量顺序**，一个都不能错、不能少。
    let featureNames: [String]
    /// 组名 -> 该组的可选值（大小写敏感，逐字匹配）。
    let oneHotCategories: [String: [String]]

    init?(json: [String: Any]) {
        guard let featureNames = json["feature_names"] as? [String],
              let numericNames = json["numeric"] as? [String],
              let binaryNames = json["binary"] as? [String],
              let categoricalNames = json["categorical"] as? [String],
              let oneHotCategories = json["onehot_categories"] as? [String: [String]]
        else { return nil }
        self.featureNames = featureNames
        self.numericNames = numericNames
        self.binaryNames = binaryNames
        self.categoricalNames = categoricalNames
        self.oneHotCategories = oneHotCategories
    }
}

/// `flavor_mapping.json` — App 的词到模型类别的翻译表。
///
/// 为什么单独放在数据文件里：这张表是「别名 -> 类别」的**数据**，不是文案；
/// App 的产区与处理法是中英混写的自由文本，这张表会一直长，长了不该重新编译。
/// 它还顺手绕开了本地化流水线——表里的中文是数据，不该被当成待翻译的界面文案。
struct FlavorMapping: Sendable {

    /// 数值特征缺省值。数值特征没有「缺失」取值，只能填一个数。
    struct NumericDefault: Sendable {
        let value: Double
        /// 这个数是怎么来的，写在数据文件里，省得以后有人以为是拍的。
        let derivation: String
    }

    /// 语法上无法对应到单一类别的原文（例如「厌氧日晒」同时含厌氧与日晒）。
    struct Unmappable: Sendable {
        let groups: [String]
        let reason: String
    }

    /// 组名 -> 规范类别 -> 别名列表。
    let aliases: [String: [String: [String]]]
    let numericDefaults: [String: NumericDefault]
    let binaryDefaults: [String: NumericDefault]
    let cannotMap: [String: Unmappable]
    /// 本来就对不上、没必要在界面上报出来的组。理由写在 JSON 里。
    let expectedUnmatched: [String: String]
    /// 加在模型原始输出上的修正量。见 JSON 里的 outputCorrection。
    let outputOffset: Double

    init?(json: [String: Any]) {
        guard let aliases = json["aliases"] as? [String: [String: [String]]] else { return nil }
        self.aliases = aliases
        self.expectedUnmatched = json["expectedUnmatched"] as? [String: String] ?? [:]
        let correction = json["outputCorrection"] as? [String: Any] ?? [:]
        self.outputOffset = correction["offset"] as? Double ?? 0

        func defaults(_ key: String) -> [String: NumericDefault] {
            let raw = json[key] as? [String: [String: Any]] ?? [:]
            return raw.compactMapValues { entry in
                guard let value = entry["value"] as? Double else { return nil }
                return NumericDefault(value: value, derivation: entry["derivation"] as? String ?? "")
            }
        }
        self.numericDefaults = defaults("numericDefaults")
        self.binaryDefaults = defaults("binaryDefaults")

        let cannot = json["cannotMap"] as? [String: [String: Any]] ?? [:]
        self.cannotMap = cannot.compactMapValues { entry in
            guard let groups = entry["groups"] as? [String] else { return nil }
            return Unmappable(groups: groups, reason: entry["reason"] as? String ?? "")
        }
    }
}

// MARK: - 从自由文本到类别

/// 把 App 里的自由文本翻成模型认识的类别值。
///
/// 匹配规则（和 `flavor_mapping.json` 里的 rules 一致）：
/// 1. 先归一化：全角转半角、转小写、去掉空白与连接符，「Sul de Minas」和
///    「suldeminas」因此等价；
/// 2. 整串先试一次，成功即返回——这样带空格的「French Press」不会被拆坏；
/// 3. 再按分隔符（`·` `/` `-` `,` 空白等）切成 token 逐个试。App 的产区就是
///    「埃塞俄比亚 · Guji」这种写法，整串匹配不上，拆开才能各自对上国家与产区；
/// 4. 都匹配不上就返回 nil。**调用方此时必须把整组填 0**，不猜、不取近似。
struct FlavorAliasIndex: Sendable {

    /// 组名 -> 归一化后的别名 -> 规范类别。
    private let index: [String: [String: String]]

    private static let separators = CharacterSet(charactersIn: "·•・/\\|,，、;；-—_+()（）[]【】 \t\n\r\"'")

    init(aliases: [String: [String: [String]]]) {
        var index: [String: [String: String]] = [:]
        for (group, canonicalToAliases) in aliases {
            var table: [String: String] = [:]
            for (canonical, list) in canonicalToAliases {
                // 规范值本身也算自己的别名：这样英文原文可以直接传进来。
                for alias in list + [canonical] {
                    let key = Self.normalised(alias)
                    if !key.isEmpty { table[key] = canonical }
                }
            }
            index[group] = table
        }
        self.index = index
    }

    func canonical(group: String, raw: String) -> String? {
        guard let table = index[group] else { return nil }

        let whole = Self.normalised(raw)
        if let hit = table[whole] { return hit }

        for token in raw.components(separatedBy: Self.separators) {
            let key = Self.normalised(token)
            if !key.isEmpty, let hit = table[key] { return hit }
        }
        return nil
    }

    /// 匹配前统一形态：全角转半角、去空白、去连接符、转小写。
    static func normalised(_ text: String) -> String {
        let halfWidth = text.applyingTransform(.fullwidthToHalfwidth, reverse: false) ?? text
        let lowered = halfWidth.lowercased()
        let scalars = lowered.unicodeScalars.filter { scalar in
            !CharacterSet.whitespacesAndNewlines.contains(scalar)
                && !CharacterSet(charactersIn: "·•・/\\|,，、;；-—_+()（）[]【】\"'").contains(scalar)
        }
        return String(String.UnicodeScalarView(scalars))
    }
}

// MARK: - Bundle 里的两分文件

/// 只负责把两分 JSON 从 Bundle 里找出来并读成值类型。
enum FlavorModelResources {

    /// 模型文件名（和 Core ML 编译产物同名，换成 .mlmodelc 而已）。
    static let modelName = "brewphase_xgb"

    private static let schemaFileName = "feature_schema"
    private static let mappingFileName = "flavor_mapping"

    /// 懒加载一次，之后复用。任何一步失败都返回 nil，由调用方降级。
    static let schema: FlavorSchema? = {
        guard let url = resourceURL(named: schemaFileName, extensions: ["json"]),
              let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            AppLog.flavor.error("feature_schema.json not found in the bundle")
            return nil
        }
        guard let schema = FlavorSchema(json: json) else {
            AppLog.flavor.error("feature_schema.json is not in the expected shape")
            return nil
        }
        guard schema.featureNames.count == schema.numericNames.count
                + schema.binaryNames.count
                + schema.oneHotCategories.values.reduce(0, { $0 + $1.count })
        else {
            AppLog.flavor.error("feature_schema.json is internally inconsistent")
            return nil
        }
        return schema
    }()

    static let mapping: FlavorMapping? = {
        guard let url = resourceURL(named: mappingFileName, extensions: ["json"]),
              let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            AppLog.flavor.error("flavor_mapping.json not found in the bundle")
            return nil
        }
        return FlavorMapping(json: json)
    }()

    static let aliasIndex: FlavorAliasIndex? = mapping.map { FlavorAliasIndex(aliases: $0.aliases) }

    /// 在 Bundle 里找一个资源。
    ///
    /// 实现在 `BundleResource`：RAG 的知识库也要用同一套查找规则，两边共用一份，
    /// 免得 Bundle 的资源摆法一变就得修两处。
    static func resourceURL(
        named name: String,
        extensions: [String],
        bundle: Bundle = .main
    ) -> URL? {
        BundleResource.url(named: name, extensions: extensions, bundle: bundle)
    }
}
