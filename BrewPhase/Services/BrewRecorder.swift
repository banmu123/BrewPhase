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

        /// 可以直接摆在界面上的那句话。校验失败与落库失败都是。
        var message: String {
            switch self {
            case .invalid(let message), .saveFailed(let message): return message
            }
        }
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

        // 失败清理要用的原值。`rollback()` 只撤得掉插入与删除，**撤不回既有
        // 对象的属性改动**（2026-10 实测，见 `PersistenceTests`），所以改过
        // 什么就得自己记着什么。
        let previousRemaining = bean.remainingG
        let previousDraft = existing.map { Draft(existing: $0) }
        let previousDeducted = existing?.stockDeductedG

        let brew: Brew
        if let existing {
            // **先**读实扣量再 apply：旧记录没有 `stockDeductedG`，兜底值就是
            // `coffeeG`，而 apply 会把 coffeeG 改成新粉量——顺序反了，差额永远
            // 是 0，改粉量不动库存。
            let previousApplied = existing.appliedStockDeductedG
            apply(draft, to: existing)
            if existing.isSettledForStock(in: bean) {
                // 这条记录已经被一次人工盘点结算过：库存数字是用户称出来的，
                // 改一条旧记录不能反过来改它。实扣量归零，将来删除也不再退。
                existing.stockDeductedG = 0
            } else {
                // 编辑：库存按**实扣量的差值**调整。用 `coffeeG` 做差值会把
                // 「袋里不够、只扣得掉一部分」的记录算错——那正是库存凭空
                // 变多或变少的地方。
                let delta = resolved.coffeeG - previousApplied
                let before = bean.remainingG
                bean.consume(delta)
                // `consume` 会夹紧；实际变动多少，实扣量就跟着改多少。
                existing.stockDeductedG = max(0, previousApplied - (bean.remainingG - before))
            }
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
            // 记下**实际**扣掉的量：袋里只有 5g 时，这一杯只扣得掉 5g。
            created.stockDeductedG = bean.deduct(resolved.coffeeG)
            brew = created
        }

        syncMirrorTasting(for: brew, bean: bean, in: context)
        bean.touch()

        do {
            try context.save()
        } catch {
            // 落库失败必须把一切退回原状：扣掉的粉、改过的字段、插入的记录、
            // 镜像风味，任何一样留下来都会在用户重试时叠加一次。
            // 编辑器的输入都在视图自己的状态里，这些清理不会弄丢它们。
            AppLog.store.error("brew save failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
            bean.remainingG = previousRemaining
            if let previousDraft {
                // 编辑：把上一版逐字段写回，并让镜像记录跟着回到旧值。
                apply(previousDraft, to: brew)
                brew.stockDeductedG = previousDeducted
                syncMirrorTasting(for: brew, bean: bean, in: context)
            }
            throw Failure.saveFailed(L("没能保存下来，请再试一次"))
        }
        return brew
    }

    /// 把 draft 写进 brew。新建与编辑共用这一份字段赋值，保存失败的写回
    /// 也用它——字段清单只有一处，不会漏项。
    static func apply(_ draft: Draft, to brew: Brew) {
        let resolved = draft.resolvedRecipe
        brew.date = draft.date
        brew.method = resolved.method.trimmed
        brew.grinder = resolved.grinder.trimmed
        brew.grindSize = resolved.grindSize.trimmed
        brew.waterTemp = resolved.waterTemp
        brew.coffeeG = resolved.coffeeG
        brew.waterG = resolved.waterG
        brew.timeSeconds = resolved.timeSeconds
        brew.score = BrewMath.clampScore(draft.score)
        brew.acidity = draft.acidity
        brew.sweetness = draft.sweetness
        brew.bitterness = draft.bitterness
        brew.body = draft.body
        brew.aftertaste = draft.aftertaste
        brew.flavorTags = draft.flavorTags
        brew.notes = draft.notes.trimmed
    }

    /// 删除一次冲煮：把**当时实际扣掉的粉**还回袋里，并带走它在风味时间线上
    /// 留下的那一条。
    ///
    /// 三种情况刻意分开：
    /// * 正常记录：退还 `stockDeductedG`（不是粉量——袋里不够时两者不等）；
    /// * 旧记录（没有实扣量）：按粉量退，与升级前的行为一致；
    /// * 已被人工盘点结算的记录：一分不退。盘点之后的剩余量是用户称出来的，
    ///   把一份已经算过这杯的账再退一次，得到的会是没人称过的数字。
    ///
    /// - Returns: 这条记录原来挂在哪包豆上，调用方据此重排提醒。
    /// - Throws: 落库失败时把一切退回删除前的样子再抛出——记录还在，
    ///   调用方必须把这一点告诉用户，不能说成删掉了。
    @discardableResult
    static func delete(_ brew: Brew, in context: ModelContext) throws -> Bean? {
        let bean = brew.bean
        let previousRemaining = bean?.remainingG
        let previousStatus = bean?.status
        let settled = bean.map { brew.isSettledForStock(in: $0) } ?? false

        if let bean {
            if !settled {
                bean.refund(brew.appliedStockDeductedG)
                if bean.status == .finished, bean.remainingG > 0 { bean.status = .active }
            }
            for tasting in (bean.tastings ?? []) where tasting.brewID == brew.id {
                context.delete(tasting)
            }
            bean.touch()
        }
        context.delete(brew)

        do {
            try context.save()
        } catch {
            AppLog.store.error("brew delete failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
            // 同上：rollback 撤得掉删除，撤不回还回去的粉与改掉的状态。
            if let bean, let previousRemaining { bean.remainingG = previousRemaining }
            if let bean, let previousStatus { bean.status = previousStatus }
            throw Failure.saveFailed(L("没能删除，请再试一次"))
        }
        return bean
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
