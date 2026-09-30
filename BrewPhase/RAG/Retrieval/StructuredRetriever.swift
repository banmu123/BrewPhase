import Foundation

/// 结构化直查（协议 §7 第一层）。
///
/// 它和向量检索的分工是：**这一层给答案，向量层给线索。** 「这包豆什么时候开封的」
/// 有一个唯一正确答案，向量检索永远只是「比较像而已」——问日期、问评分、问剩多少，
/// 都该直接从库里算出来。
///
/// 产出的是**结论**而不是原始记录：不是「这是你的 5 条冲煮记录」，而是「你给这包豆
/// 打过分 4 次，最高 5 分，出现在 9月25日」。前者模型还得自己数一遍，后者它照抄就行。
@MainActor
enum StructuredRetriever {

    static func facts(
        plan: QueryPlan,
        beans: [Bean],
        brews: [Brew],
        tastings: [Tasting],
        book: PhaseRuleBook?,
        now: Date = Date(),
        calendar: Calendar = DateMath.calendar
    ) -> [RetrievedPassage] {
        var passages: [RetrievedPassage] = []

        let focusBean = plan.focusBeanID.flatMap { id in beans.first { $0.id == id } }

        if plan.intents.contains(.inventory) {
            if let inventory = inventoryFact(beans: beans, book: book, now: now, calendar: calendar) {
                passages.append(inventory)
            }
        }
        if plan.intents.contains(.rating), let focusBean,
           let fact = ratingFact(bean: focusBean, calendar: calendar) {
            passages.append(fact)
        }
        if plan.intents.contains(.timing), let focusBean,
           let fact = timingFact(bean: focusBean, book: book, now: now, calendar: calendar) {
            passages.append(fact)
        }
        if plan.intents.contains(.recipe), let focusBean,
           let fact = recipeFact(bean: focusBean, count: plan.requestedCount ?? 3, calendar: calendar) {
            passages.append(fact)
        }
        if plan.intents.contains(.status), let focusBean,
           let fact = statusFact(bean: focusBean, book: book, now: now, calendar: calendar) {
            passages.append(fact)
        }

        // 结构化事实是「算出来的答案」，相关度给得高——但仍然按顺序递减，
        // 免得同一包里三四个事实并列，上下文里的先后变得随机。
        return passages.enumerated().map { index, passage in
            var passage = passage
            passage.relevance = max(0.9, 1.0 - Double(index) * 0.02)
            return passage
        }
    }

    // MARK: - 各类事实

    private static func inventoryFact(
        beans: [Bean],
        book: PhaseRuleBook?,
        now: Date,
        calendar: Calendar
    ) -> RetrievedPassage? {
        let active = beans.filter { !$0.isFinished }
        guard !active.isEmpty else { return nil }

        // 按烘焙后天数从大到小：越老的越该先处理，这也是用户问「有哪些」时
        // 最想先看到的那几包。
        let ordered = active.sorted { ($0.currentDayAfterRoast ?? -1) > ($1.currentDayAfterRoast ?? -1) }

        var lines: [String] = [L("用户现在有 %@ 包还没喝完的豆子。", String(active.count))]
        for bean in ordered {
            let reading = PhaseEngine.reading(
                for: bean.snapshot, rule: book?.rule(for: bean.roastLevel), today: now, calendar: calendar
            )
            let day = reading.dayAfterRoast.map { L("烘焙后第 %@ 天", String($0)) } ?? L("没有烘焙日期")
            lines.append(L("「%@」：%@，%@，剩 %@。",
                           bean.displayName, day, reading.phase.title, Fmt.gramsShort(bean.remainingG)))
        }

        if let book,
           let pick = InsightFactory.todaysPick(active, book: book),
           let bean = active.first(where: { $0.id == pick.id }) {
            lines.append(L("按现有的窗口规则，今天最该喝的是「%@」。", bean.displayName))
        }

        return RetrievedPassage(
            id: "fact:inventory",
            origin: .structuredFact,
            sourceType: .bean,
            title: L("豆仓现状"),
            content: lines.joined(separator: "\n"),
            metadata: DocumentMetadata(docDate: now),
            relevance: 1,
            updatedAt: now
        )
    }

    private static func ratingFact(bean: Bean, calendar: Calendar) -> RetrievedPassage? {
        let scored = bean.brewsNewestFirst.filter { $0.score > 0 }
        guard !scored.isEmpty else {
            return RetrievedPassage(
                id: "fact:rating:\(bean.id.uuidString)",
                origin: .structuredFact,
                sourceType: .brew,
                title: L("「%@」的评分", bean.displayName),
                content: L("这包豆冲过 %@ 次，但用户一次都没有打过分。", String(bean.brewsCount)),
                metadata: DocumentMetadata(beanID: bean.id),
                relevance: 1,
                updatedAt: bean.updatedAt
            )
        }

        let average = Double(scored.map(\.score).reduce(0, +)) / Double(scored.count)
        let best = scored.max { $0.score < $1.score }
        let listed = scored.prefix(6).map { L("%@（%@）", String($0.score), Fmt.short($0.date, calendar: calendar)) }

        var lines = [L("「%@」一共冲过 %@ 次，其中 %@ 次打过分，平均 %@ 分。",
                       bean.displayName, String(bean.brewsCount), String(scored.count), Fmt.number(average))]
        if let best {
            lines.append(L("最高 %@ 分，出现在 %@。", String(best.score), Fmt.short(best.date, calendar: calendar)))
        }
        lines.append(L("按时间从新到旧：%@。", listed.joined(separator: L("，"))))

        return RetrievedPassage(
            id: "fact:rating:\(bean.id.uuidString)",
            origin: .structuredFact,
            sourceType: .brew,
            title: L("「%@」的评分", bean.displayName),
            content: lines.joined(separator: "\n"),
            metadata: DocumentMetadata(
                beanID: bean.id,
                docDate: best?.date,
                score: best?.score,
                origin: bean.origin.nonEmpty,
                process: bean.process.nonEmpty
            ),
            relevance: 1,
            similarity: nil,
            updatedAt: bean.updatedAt
        )
    }

    private static func timingFact(
        bean: Bean,
        book: PhaseRuleBook?,
        now: Date,
        calendar: Calendar
    ) -> RetrievedPassage? {
        var lines: [String] = []
        if let roast = bean.roastDate {
            let day = DateMath.daysBetween(roast, now, calendar: calendar)
            lines.append(L("烘焙日期是 %@，今天是烘焙后第 %@ 天。",
                           Fmt.precise(roast, calendar: calendar), String(day)))
        } else {
            lines.append(L("这包豆子没有记录烘焙日期。"))
        }
        if let purchase = bean.purchaseDate {
            lines.append(L("购买日期是 %@。", Fmt.precise(purchase, calendar: calendar)))
        }
        if let open = bean.openDate {
            let days = DateMath.daysBetween(open, now, calendar: calendar)
            lines.append(L("开封日期是 %@，已经开封 %@ 天。",
                           Fmt.precise(open, calendar: calendar), String(days)))
        } else {
            lines.append(L("没有记录开封日期。"))
        }

        let reading = PhaseEngine.reading(
            for: bean.snapshot, rule: book?.rule(for: bean.roastLevel), today: now, calendar: calendar
        )
        if let day = reading.dayAfterRoast {
            lines.append(L("窗口规则里的黄金期是第 %@–%@ 天，今天在第 %@ 天。",
                           String(reading.peakStartDay), String(reading.peakEndDay), String(day)))
        }

        return RetrievedPassage(
            id: "fact:timing:\(bean.id.uuidString)",
            origin: .structuredFact,
            sourceType: .bean,
            title: L("「%@」的时间线", bean.displayName),
            content: lines.joined(separator: "\n"),
            metadata: DocumentMetadata(
                beanID: bean.id,
                docDate: bean.roastDate,
                dayAfterRoast: reading.dayAfterRoast,
                origin: bean.origin.nonEmpty
            ),
            relevance: 1,
            similarity: nil,
            updatedAt: bean.updatedAt
        )
    }

    private static func recipeFact(bean: Bean, count: Int, calendar: Calendar) -> RetrievedPassage? {
        let brews = Array(bean.brewsNewestFirst.prefix(max(1, count)))
        guard !brews.isEmpty else {
            return RetrievedPassage(
                id: "fact:recipe:\(bean.id.uuidString)",
                origin: .structuredFact,
                sourceType: .brew,
                title: L("「%@」的冲煮参数", bean.displayName),
                content: L("这包豆还没有冲煮记录。"),
                metadata: DocumentMetadata(beanID: bean.id),
                relevance: 1,
                updatedAt: bean.updatedAt
            )
        }

        var lines: [String] = [L("「%@」最近的 %@ 次冲煮参数（从新到旧）：",
                                 bean.displayName, String(brews.count))]
        for brew in brews {
            lines.append("· " + brewRecipeLine(brew, calendar: calendar))
        }

        return RetrievedPassage(
            id: "fact:recipe:\(bean.id.uuidString)",
            origin: .structuredFact,
            sourceType: .brew,
            title: L("「%@」的冲煮参数", bean.displayName),
            content: lines.joined(separator: "\n"),
            metadata: DocumentMetadata(
                beanID: bean.id,
                method: brews.first?.method.nonEmpty,
                docDate: brews.first?.date,
                origin: bean.origin.nonEmpty,
                process: bean.process.nonEmpty
            ),
            relevance: 1,
            similarity: nil,
            updatedAt: bean.updatedAt
        )
    }

    /// 一次冲煮的参数行。和 `DocumentBuilder` 写的是同一批字段，但这里是**表格式**
    /// 的——用户问「怎么冲的」，他想看到的是数，不是句子。
    static func brewRecipeLine(_ brew: Brew, calendar: Calendar = DateMath.calendar) -> String {
        var parts: [String] = [Fmt.short(brew.date, calendar: calendar)]
        if let method = brew.method.nonEmpty { parts.append(method) }
        if brew.coffeeG > 0 { parts.append(L("粉 %@", Fmt.gramsShort(brew.coffeeG))) }
        if brew.waterG > 0 { parts.append(L("水 %@", Fmt.gramsShort(brew.waterG))) }
        if brew.coffeeG > 0, brew.waterG > 0 { parts.append(brew.ratioText) }
        if brew.waterTemp > 0 { parts.append(L("%@°C", Fmt.number(brew.waterTemp))) }
        if let grind = brew.grindSize.nonEmpty { parts.append(L("研磨 %@", grind)) }
        if brew.timeSeconds > 0 { parts.append(brew.timeText) }
        if brew.score > 0 { parts.append(L("%@ 分", String(brew.score))) }
        if !brew.notes.trimmed.isEmpty { parts.append(brew.notes.trimmed) }
        return parts.joined(separator: L(" · "))
    }

    private static func statusFact(
        bean: Bean,
        book: PhaseRuleBook?,
        now: Date,
        calendar: Calendar
    ) -> RetrievedPassage? {
        let reading = PhaseEngine.reading(
            for: bean.snapshot, rule: book?.rule(for: bean.roastLevel), today: now, calendar: calendar
        )

        var lines: [String] = []
        if let day = reading.dayAfterRoast {
            lines.append(L("「%@」今天是烘焙后第 %@ 天，处于「%@」（%@）。",
                           bean.displayName, String(day), reading.phase.title, reading.phase.subtitle))
        } else {
            lines.append(L("「%@」没有烘焙日期，无法判断处在哪个阶段。", bean.displayName))
        }
        if reading.phase.isInWindow {
            lines.append(L("按窗口规则现在适合喝。"))
        } else if reading.dayAfterRoast != nil {
            if reading.daysUntilPeakStart > 0 {
                lines.append(L("距离进入窗口还有约 %@ 天。", String(reading.daysUntilPeakStart)))
            } else if reading.daysUntilWindowEnd < 0 {
                lines.append(L("已经过了窗口约 %@ 天。", String(abs(reading.daysUntilWindowEnd))))
            }
        }
        lines.append(L("还剩 %@。", Fmt.gramsShort(bean.remainingG)))

        return RetrievedPassage(
            id: "fact:status:\(bean.id.uuidString)",
            origin: .structuredFact,
            sourceType: .bean,
            title: L("「%@」现在的状态", bean.displayName),
            content: lines.joined(separator: "\n"),
            metadata: DocumentMetadata(
                beanID: bean.id,
                docDate: now,
                dayAfterRoast: reading.dayAfterRoast,
                roastLevel: bean.roastLevel.rawValue
            ),
            relevance: 1,
            similarity: nil,
            updatedAt: bean.updatedAt
        )
    }
}
