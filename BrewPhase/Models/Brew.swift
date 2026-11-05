import Foundation
import SwiftData

/// One brew. Named `Brew` rather than `BrewRecord` because in the UI it is just
/// "a brew", and its job is to answer two questions: what did I do, and how was
/// it.
///
/// `ratio` is *derived*, never stored — storing a ratio alongside dose and water
/// invites the three values to disagree, and §32 is explicit that the numbers
/// must stay consistent.
@Model
final class Brew {

    static let tagSeparator = Bean.tagSeparator

    // MARK: - Identity

    var id: UUID = UUID()
    var date: Date = Date()

    // MARK: - Recipe

    var method: String = ""
    var grinder: String = ""
    var grindSize: String = ""
    var waterTemp: Double = 0
    var coffeeG: Double = 0
    var waterG: Double = 0
    /// Brew time, in seconds. Stored as a number so it can be compared and
    /// averaged; shown as `2:35` everywhere.
    var timeSeconds: Int = 0

    // MARK: - Verdict

    var score: Int = 0
    var acidity: Int = 0
    var sweetness: Int = 0
    var bitterness: Int = 0
    var body: Int = 0
    var aftertaste: Int = 0
    var flavorTagsRaw: String = ""
    var notes: String = ""

    // MARK: - Housekeeping

    var createdAt: Date = Date()

    /// 这条记录当时**实际**从库存里扣掉的克数。
    ///
    /// 不总是等于 `coffeeG`：袋里只剩 5g 时记一杯 18g，只扣得掉 5g。以前删除
    /// 时按 `coffeeG` 退，一次「记错 → 删掉」就能让库存凭空多出 13g。
    ///
    /// nil = 这条记录写于本字段存在之前。旧数据没有真相可查，只能按粉量退，
    /// 也就是旧行为；它不会比升级前更差。
    var stockDeductedG: Double?

    var bean: Bean?

    init(
        date: Date = Date(),
        method: String = "",
        grinder: String = "",
        grindSize: String = "",
        waterTemp: Double = 0,
        coffeeG: Double = 0,
        waterG: Double = 0,
        timeSeconds: Int = 0,
        score: Int = 0,
        acidity: Int = 0,
        sweetness: Int = 0,
        bitterness: Int = 0,
        body: Int = 0,
        aftertaste: Int = 0,
        flavorTags: [String] = [],
        notes: String = "",
        bean: Bean? = nil
    ) {
        self.id = UUID()
        self.date = date
        self.method = method
        self.grinder = grinder
        self.grindSize = grindSize
        self.waterTemp = waterTemp
        self.coffeeG = coffeeG
        self.waterG = waterG
        self.timeSeconds = timeSeconds
        self.score = score
        self.acidity = acidity
        self.sweetness = sweetness
        self.bitterness = bitterness
        self.body = body
        self.aftertaste = aftertaste
        self.flavorTagsRaw = flavorTags.joined(separator: Self.tagSeparator)
        self.notes = notes
        self.bean = bean
        self.createdAt = Date()
    }

    // MARK: - Typed accessors

    var flavorTags: [String] {
        get {
            flavorTagsRaw
                .components(separatedBy: Self.tagSeparator)
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
        }
        set {
            flavorTagsRaw = newValue
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .joined(separator: Self.tagSeparator)
        }
    }

    // MARK: - Derived recipe

    /// The ratio the drinker actually achieved, as a single number (16.7 means 1:16.7).
    var ratio: Double {
        BrewMath.ratioValue(coffeeG: coffeeG, waterG: waterG)
    }

    var ratioText: String { Fmt.ratio(coffeeG: coffeeG, waterG: waterG) }

    var timeText: String { BrewMath.formatTime(timeSeconds) }

    var doseLine: String { Fmt.doseLine(coffeeG: coffeeG, waterG: waterG) }

    /// 「酸 4 · 甜 3 · 苦 2」——只列填了的轴，一个都没填就是 nil。
    /// 最近一杯摘要、Quick Log 的上一杯卡都用这一行，口径只有一处。
    var tasteLine: String? {
        var parts: [String] = []
        if acidity > 0 { parts.append(L("酸 %@", String(acidity))) }
        if sweetness > 0 { parts.append(L("甜 %@", String(sweetness))) }
        if bitterness > 0 { parts.append(L("苦 %@", String(bitterness))) }
        if body > 0 { parts.append(L("醇厚 %@", String(body))) }
        if aftertaste > 0 { parts.append(L("余韵 %@", String(aftertaste))) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    var dayAfterRoast: Int? {
        bean?.dayAfterRoast(on: date)
    }

    /// 撤销这条记录时该退回的克数。旧记录没有实扣量，退回粉量本身。
    var appliedStockDeductedG: Double {
        stockDeductedG ?? coffeeG
    }

    /// 这条记录是否已经被一次**人工盘点**结算过。
    ///
    /// 盘点之后 `remainingG` 就是用户称出来的事实，盘之前记录的冲煮已经没有
    /// 单独回补的余地：再把粉退回去，得到的会是用户从没称过的数字。
    func isSettledForStock(in bean: Bean) -> Bool {
        guard let countedAt = bean.stockCountedAt else { return false }
        return createdAt < countedAt
    }

    /// Whether any taste judgement was filled in at all.
    var hasTasteDetail: Bool {
        acidity > 0 || sweetness > 0 || bitterness > 0 || body > 0 || aftertaste > 0
    }

    /// The brew's recipe as a value type, for "copy last parameters" and for
    /// testing without a store.
    var recipe: BrewRecipe {
        BrewRecipe(
            method: method,
            grinder: grinder,
            grindSize: grindSize,
            waterTemp: waterTemp,
            coffeeG: coffeeG,
            waterG: waterG,
            timeSeconds: timeSeconds
        )
    }

    /// A tasting row that mirrors this brew, so the flavour timeline fills
    /// itself in as a side effect of brewing (§40).
    func makeTasting() -> Tasting {
        Tasting(
            date: date,
            dayAfterRoast: dayAfterRoast ?? 0,
            flavorTags: flavorTags,
            score: score,
            notes: notes,
            source: .brew,
            brewID: id
        )
    }

    /// Whether this brew has anything worth showing on the timeline.
    ///
    /// A brew with no score, no tags and no note is still a data point, but an
    /// empty node on the timeline is noise — so it does not get one.
    var hasTimelineMaterial: Bool {
        score > 0 || !flavorTags.isEmpty || !notes.trimmed.isEmpty
    }
}
