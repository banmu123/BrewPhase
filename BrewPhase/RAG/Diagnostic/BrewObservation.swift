import Foundation

/// 五条味觉轴。名字与编辑器里那五个滑条一一对应，0 仍然表示「没填」。
enum TasteAxis: String, CaseIterable, Sendable {
    case acidity
    case sweetness
    case bitterness
    case body
    case aftertaste

    var label: String {
        switch self {
        case .acidity: return L("酸")
        case .sweetness: return L("甜")
        case .bitterness: return L("苦")
        case .body: return L("醇厚")
        case .aftertaste: return L("余韵")
        }
    }
}

/// 这条记录是怎么来的（规格 §二十三，**为 CP-012 预留**）。
///
/// 目前只有 `.manual`（App 里手记）。它的价值不在现在，而在将来：诊断、基线、
/// 建议全都只吃 `BrewObservation` 这个值类型，所以导入器接进来时只需要多写一个
/// 映射函数，不必回头动数据模型——这就是「不把 Brew 数据层设计死」的具体做法。
enum BrewRecordSource: String, CaseIterable, Sendable {
    /// 用户在 App 里手动记录。
    case manual
    /// 从文件/第三方 App 导入（本阶段不实现）。
    case imported
    /// 从设备直接读取（本阶段不实现）。
    case device
}

/// 一次冲煮在诊断层里的样子（值类型）。
///
/// **它存在的唯一理由是把 `@Model Brew` 挡在诊断层之外。** 基线、诊断、建议全都
/// 只认这个类型：纯值、可比较、可在没有数据库的测试里直接构造。映射只发生在
/// `init(brew:)` 一处。
struct BrewObservation: Equatable, Sendable, Identifiable {

    let id: UUID
    let date: Date
    let recipe: BrewRecipe
    let score: Int
    let acidity: Int
    let sweetness: Int
    let bitterness: Int
    let body: Int
    let aftertaste: Int
    let flavorTags: [String]
    let notes: String
    let source: BrewRecordSource

    init(
        id: UUID = UUID(),
        date: Date,
        recipe: BrewRecipe,
        score: Int = 0,
        acidity: Int = 0,
        sweetness: Int = 0,
        bitterness: Int = 0,
        body: Int = 0,
        aftertaste: Int = 0,
        flavorTags: [String] = [],
        notes: String = "",
        source: BrewRecordSource = .manual
    ) {
        self.id = id
        self.date = date
        self.recipe = recipe
        self.score = score
        self.acidity = acidity
        self.sweetness = sweetness
        self.bitterness = bitterness
        self.body = body
        self.aftertaste = aftertaste
        self.flavorTags = flavorTags
        self.notes = notes
        self.source = source
    }

    /// 从库里的一条记录映射过来。**唯一**的 `@Model → 值类型` 落点。
    init(brew: Brew) {
        self.init(
            id: brew.id,
            date: brew.date,
            recipe: brew.recipe,
            score: brew.score,
            acidity: brew.acidity,
            sweetness: brew.sweetness,
            bitterness: brew.bitterness,
            body: brew.body,
            aftertaste: brew.aftertaste,
            flavorTags: brew.flavorTags,
            notes: brew.notes,
            source: .manual
        )
    }

    // MARK: - 便利访问

    var method: String { recipe.method }
    var timeSeconds: Int { recipe.timeSeconds }

    var hasScore: Bool { score > 0 }

    /// 算不算「你自己觉得好」的一次。阈值与个人最佳分析器共用同一个常数。
    var isHighRated: Bool { score >= IntelligenceConfig.highRatingThreshold }

    /// 某条味觉轴的值。0 表示**没填**，不是「低」。
    func axis(_ axis: TasteAxis) -> Int {
        switch axis {
        case .acidity: return acidity
        case .sweetness: return sweetness
        case .bitterness: return bitterness
        case .body: return body
        case .aftertaste: return aftertaste
        }
    }

    /// 填过的轴（0 的不算）。判断「有没有味觉证据」用它。
    var filledAxes: [TasteAxis] { TasteAxis.allCases.filter { axis($0) > 0 } }

    /// 这条记录的正文（备注 + 风味标签），用来找干涩这类字面线索。
    var text: String {
        ([notes] + flavorTags).joined(separator: " ")
    }

    /// 某次数值参数的取值。为 0（没填）时返回 nil——「没填」不参与任何比较。
    func value(of parameter: BrewParameter) -> Double? {
        switch parameter {
        case .temperature: return recipe.waterTemp > 0 ? recipe.waterTemp : nil
        case .time: return recipe.timeSeconds > 0 ? Double(recipe.timeSeconds) : nil
        case .ratio: return recipe.ratioValue > 0 ? recipe.ratioValue : nil
        case .dose: return recipe.coffeeG > 0 ? recipe.coffeeG : nil
        }
    }
}
