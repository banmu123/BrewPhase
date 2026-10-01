import Foundation
import SwiftData

/// 记录一次冲煮的**唯一写入路径**。
///
/// 为什么要把这件事从视图里搬出来：写入要同时做完四件事——校验、从库存里扣粉、
/// 维护风味时间线上那条镜像记录、重建提醒。任何一个编辑器（完整表单、30 秒快记、
/// 以后可能有的导入）漏掉其中一件，数据就会悄悄不一致：库存扣了但时间线没长，
/// 或者改了粉量而镜像记录还写着旧值。
///
/// 视图只负责收集输入（`Draft`），剩下的都在这里。`@MainActor` 与既有的编辑器一致。
enum BrewRecorder {

    /// 一次记录的全部输入。
    ///
    /// 时间的处理刻意留在这里：编辑器里那个字段是文本（「2:35」/「155」/「2.35」），
    /// 解析规则只有一个地方说了算，两个编辑器不该各解析一次。
    struct Draft: Equatable, Sendable {
        var recipe: BrewRecipe
        var timeText: String
        var date: Date
        var score: Int
        var acidity: Int
        var sweetness: Int
        var bitterness: Int
        var body: Int
        var aftertaste: Int
        var flavorTags: [String]
        var notes: String

        init(
            recipe: BrewRecipe,
            timeText: String = "",
            date: Date = Date(),
            score: Int = 0,
            acidity: Int = 0,
            sweetness: Int = 0,
            bitterness: Int = 0,
            body: Int = 0,
            aftertaste: Int = 0,
            flavorTags: [String] = [],
            notes: String = ""
        ) {
            self.recipe = recipe
            self.timeText = timeText
            self.date = date
            self.score = score
            self.acidity = acidity
            self.sweetness = sweetness
            self.bitterness = bitterness
            self.body = body
            self.aftertaste = aftertaste
            self.flavorTags = flavorTags
            self.notes = notes
        }

        /// 从既有记录回填（编辑时用）。
        init(existing: Brew) {
            self.init(
                recipe: existing.recipe,
                timeText: existing.timeText,
                date: existing.date,
                score: existing.score,
                acidity: existing.acidity,
                sweetness: existing.sweetness,
                bitterness: existing.bitterness,
                body: existing.body,
                aftertaste: existing.aftertaste,
                flavorTags: existing.flavorTags,
                notes: existing.notes
            )
        }

        /// 解析出时间之后的配方。校验与写入都用它，免得两处各算一遍。
        var resolvedRecipe: BrewRecipe {
            var recipe = recipe
            recipe.timeSeconds = BrewMath.parseTime(timeText) ?? 0
            return recipe
        }

        var validation: BrewValidation { BrewMath.validate(resolvedRecipe) }
    }

    enum Failure: Error, Equatable {
        /// 校验没过。消息是可以直接给用户看的一句话。
        case invalid(String)
        case saveFailed(String)
    }

    /// 保存（新建或更新）。
    ///
    /// - Returns: 落库的那条记录。
    @discardableResult
    static func save(
        _ draft: Draft,
        bean: Bean,
        existing: Brew? = nil,
        in context: ModelContext
    ) throws -> Brew {
        let resolved = draft.resolvedRecipe

        let validation = BrewMath.validate(resolved)
        guard validation.canSave else {
            throw Failure.invalid(validation.blocking.first ?? L("这次记录还差一点信息"))
        }

        let brew: Brew
        if let existing {
            // 编辑：库存按**差值**调整，改一个打错的粉量不该再扣一次。
            let delta = resolved.coffeeG - existing.coffeeG
            existing.date = draft.date
            existing.method = resolved.method.trimmed
            existing.grinder = resolved.grinder.trimmed
            existing.grindSize = resolved.grindSize.trimmed
            existing.waterTemp = resolved.waterTemp
            existing.coffeeG = resolved.coffeeG
            existing.waterG = resolved.waterG
            existing.timeSeconds = resolved.timeSeconds
            existing.score = BrewMath.clampScore(draft.score)
            existing.acidity = draft.acidity
            existing.sweetness = draft.sweetness
            existing.bitterness = draft.bitterness
            existing.body = draft.body
            existing.aftertaste = draft.aftertaste
            existing.flavorTags = draft.flavorTags
            existing.notes = draft.notes.trimmed
            if delta != 0 { bean.consume(delta) }
            brew = existing
        } else {
            let created = Brew(
                date: draft.date,
                method: resolved.method.trimmed,
                grinder: resolved.grinder.trimmed,
                grindSize: resolved.grindSize.trimmed,
                waterTemp: resolved.waterTemp,
                coffeeG: resolved.coffeeG,
                waterG: resolved.waterG,
                timeSeconds: resolved.timeSeconds,
                score: BrewMath.clampScore(draft.score),
                acidity: draft.acidity,
                sweetness: draft.sweetness,
                bitterness: draft.bitterness,
                body: draft.body,
                aftertaste: draft.aftertaste,
                flavorTags: draft.flavorTags,
                notes: draft.notes.trimmed,
                bean: bean
            )
            context.insert(created)
            bean.consume(resolved.coffeeG)
            brew = created
        }

        syncMirrorTasting(for: brew, bean: bean, in: context)
        bean.touch()

        do {
            try context.save()
        } catch {
            AppLog.store.error("brew save failed: \(error.localizedDescription, privacy: .public)")
            throw Failure.saveFailed(L("没能保存下来，请再试一次"))
        }
        return brew
    }

    /// 删除一次冲煮：把粉还回袋里，并带走它在风味时间线上留下的那一条。
    static func delete(_ brew: Brew, in context: ModelContext) {
        if let bean = brew.bean {
            bean.remainingG = min(bean.weightG, bean.remainingG + brew.coffeeG)
            if bean.status == .finished, bean.remainingG > 0 { bean.status = .active }
            for tasting in (bean.tastings ?? []) where tasting.brewID == brew.id {
                context.delete(tasting)
            }
            bean.touch()
        }
        context.delete(brew)
        try? context.save()
    }

    /// 库存变了，提醒与「还剩几次」也得跟着变。
    static func rescheduleReminders(for bean: Bean, in context: ModelContext) async {
        let stored = (try? context.fetch(FetchDescriptor<PhaseRule>())) ?? []
        let book = PhaseRuleBook.make(stored: stored)
        let insight = InsightFactory.insight(for: bean, book: book)
        await NotificationManager.shared.sync(
            bean: bean,
            rule: book.rule(for: bean.roastLevel),
            estimate: insight.estimate,
            context: context
        )
    }

    // MARK: - 私有

    /// 让风味时间线上那条镜像记录跟上这次冲煮，或者在它不再有话可说时移除。
    private static func syncMirrorTasting(for brew: Brew, bean: Bean, in context: ModelContext) {
        let linked = (bean.tastings ?? []).first { $0.brewID == brew.id }
        if brew.hasTimelineMaterial {
            if let linked {
                linked.date = brew.date
                linked.dayAfterRoast = brew.dayAfterRoast ?? 0
                linked.score = brew.score
                linked.flavorTags = brew.flavorTags
                linked.notes = brew.notes
            } else {
                let tasting = brew.makeTasting()
                tasting.bean = bean
                context.insert(tasting)
            }
        } else if let linked {
            context.delete(linked)
        }
    }
}
