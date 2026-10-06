import Foundation

/// Response Layer（协议 §28）：把分析结果变成模板文案。
///
/// 全部数字都来自传入的分析对象，模板只负责措辞。这里**不许出现**任何字面量
/// 数字——写死一个「92°C」进去，它迟早会和用户的数据对不上，而那正是这个功能
/// 最不能犯的错。
///
/// 措辞的边界也在这里守：偏离比较的对象是**用户自己的历史**，所以永远说「和你
/// 常用的不一样」，从不说「错了」；相似记录只报告分布（「3 次都用的是 V60」），
/// 不编造因果（「所以是萃取过度」）。
@MainActor
enum InsightFormatter {

    // MARK: 今日建议（协议 §23）

    static func todayPick(
        _ pick: BeanInsight,
        bean: Bean,
        today: Date = Date()
    ) -> Insight {
        var evidence: [Insight.Evidence] = []
        if let day = pick.reading.dayAfterRoast {
            evidence.append(Insight.Evidence(text: L("烘焙后第 %@ 天", String(day))))
        } else {
            evidence.append(Insight.Evidence(text: L("这包豆子没有记录烘焙日期。")))
        }
        if let open = bean.openDate {
            evidence.append(Insight.Evidence(
                text: L("开封后第 %@ 天", String(max(0, DateMath.daysBetween(open, today))))
            ))
        }
        evidence.append(Insight.Evidence(text: L("剩余 %@", Fmt.gramsShort(bean.remainingG))))

        let scores = bean.brewsNewestFirst.filter { $0.score > 0 }.map { Double($0.score) }
        if !scores.isEmpty {
            let average = scores.reduce(0, +) / Double(scores.count)
            evidence.append(Insight.Evidence(text: L("过去平均 %@ 分", Fmt.number(average))))
        }
        if pick.estimate.brewsRemaining > 0 {
            evidence.append(Insight.Evidence(
                text: L("预计还能冲 %@ 次", String(pick.estimate.brewsRemaining))
            ))
        }

        // 措辞跟着紧急程度走：真紧迫才说「优先」，否则只说「可以先喝这包」。
        // 一包还在养豆的豆子被说成「优先饮用」，是这套卡片最不能犯的错。
        let headline: String
        switch pick.verdict.tier {
        case .urgent, .high:
            headline = L("建议优先喝：%@", bean.displayName)
        case .normal, .low:
            headline = L("今天可以先喝这包：%@", bean.displayName)
        }

        let confidence: Insight.Confidence
        switch pick.verdict.tier {
        case .urgent, .high: confidence = .high
        case .normal: confidence = .medium
        case .low: confidence = .low
        }

        return Insight(
            id: UUID(),
            kind: .todayPick,
            headline: headline,
            reasons: pick.verdict.reasons,
            evidence: evidence,
            confidence: confidence,
            beanID: bean.id
        )
    }

    // MARK: 我的最佳参数（协议 §19）

    static func personalBest(_ analysis: PersonalBestAnalyzer.Analysis, bean: Bean) -> Insight {
        guard analysis.hasEnoughData, let recipe = analysis.bestRecipe else {
            // 协议 Case 5：证据不足时必须说清，且「N 条」要和系统的真实阈值一致。
            return Insight(
                id: UUID(),
                kind: .personalBest,
                headline: L("这包豆的历史还不够给出最佳参数"),
                reasons: [L("至少需要 %@ 条带评分的冲煮记录后才能进行比较。",
                            String(IntelligenceConfig.minimumSamplesForComparison))],
                evidence: [Insight.Evidence(
                    text: L("这包豆目前有 %@ 次带评分的记录。", String(analysis.scoredCount))
                )],
                confidence: .insufficientEvidence,
                beanID: bean.id
            )
        }

        var evidence: [Insight.Evidence] = [
            Insight.Evidence(text: bestRecipeLine(analysis, recipe: recipe))
        ]
        if let stats = analysis.temperature {
            evidence.append(Insight.Evidence(
                text: L("高评分记录的水温通常在 %@ 到 %@",
                        Fmt.number(stats.minimum), Fmt.number(stats.maximum))
            ))
        }
        if let stats = analysis.timeSeconds {
            evidence.append(Insight.Evidence(
                text: L("高评分记录的萃取时间通常在 %@ 到 %@",
                        BrewMath.formatTime(Int(stats.minimum.rounded())),
                        BrewMath.formatTime(Int(stats.maximum.rounded())))
            ))
        }
        if let stats = analysis.ratio {
            evidence.append(Insight.Evidence(
                text: L("高评分记录的粉水比通常在 1:%@ 到 1:%@",
                        Fmt.number(stats.minimum), Fmt.number(stats.maximum))
            ))
        }
        if let stats = analysis.dose {
            evidence.append(Insight.Evidence(
                text: L("高评分记录的粉量通常在 %@ 到 %@",
                        Fmt.gramsShort(stats.minimum), Fmt.gramsShort(stats.maximum))
            ))
        }
        if !analysis.bestFlavorTags.isEmpty {
            evidence.append(Insight.Evidence(
                text: L("记录到的风味：%@。", FlavorLibrary.displayList(analysis.bestFlavorTags))
            ))
        }

        return Insight(
            id: UUID(),
            kind: .personalBest,
            headline: L("「%@」你评分最高的一次", bean.displayName),
            reasons: [L("%@ 打了 %@ 分。",
                        analysis.bestDate.map { Fmt.short($0) } ?? L("那一天"),
                        String(analysis.bestScore))],
            evidence: evidence,
            confidence: .medium,
            beanID: bean.id
        )
    }

    /// 最佳记录那一行的配方文本。和 `StructuredRetriever.brewRecipeLine` 的字段
    /// 一致，但吃的是 `Analysis` 里的值类型——`Brew` 是 `@Model`，进不了统计层。
    private static func bestRecipeLine(
        _ analysis: PersonalBestAnalyzer.Analysis,
        recipe: BrewRecipe
    ) -> String {
        var parts: [String] = []
        if let date = analysis.bestDate { parts.append(Fmt.short(date)) }
        if !recipe.method.trimmed.isEmpty { parts.append(recipe.method) }
        if recipe.coffeeG > 0 { parts.append(L("粉 %@", Fmt.gramsShort(recipe.coffeeG))) }
        if recipe.waterG > 0 { parts.append(L("水 %@", Fmt.gramsShort(recipe.waterG))) }
        if recipe.coffeeG > 0, recipe.waterG > 0 { parts.append(recipe.ratioText) }
        if recipe.waterTemp > 0 { parts.append(L("%@°C", Fmt.number(recipe.waterTemp))) }
        if !recipe.grindSize.trimmed.isEmpty { parts.append(L("研磨 %@", recipe.grindSize)) }
        if recipe.timeSeconds > 0 { parts.append(recipe.timeText) }
        if analysis.bestScore > 0 { parts.append(L("%@ 分", String(analysis.bestScore))) }
        return parts.joined(separator: " · ")
    }

    // MARK: 参数偏离（协议 §20）

    static func deviation(_ analysis: ParameterDeviationAnalyzer.Analysis, bean: Bean) -> Insight {
        switch analysis.verdict {
        case .insufficientEvidence:
            let reason: String
            if analysis.shortcoming == .noBrews {
                reason = L("这包豆还没有冲煮记录。")
            } else {
                reason = L("至少需要 %@ 条带评分的冲煮记录后才能进行比较。",
                           String(IntelligenceConfig.minimumSamplesForComparison))
            }
            return Insight(
                id: UUID(),
                kind: .deviation,
                headline: L("还比较不了这次的参数"),
                reasons: [reason],
                evidence: [],
                confidence: .insufficientEvidence,
                beanID: bean.id
            )

        case .withinPersonalRange:
            return Insight(
                id: UUID(),
                kind: .deviation,
                headline: L("这次参数和你高评分记录的范围基本一致"),
                reasons: [L("每一项都在你自己的常用区间里，没有需要提醒的偏离。")],
                evidence: analysis.fields.map(evidenceRow),
                confidence: .high,
                beanID: bean.id
            )

        case .outsidePersonalRange:
            let reasons = analysis.outsideFields.map { field in
                field.directionIsHigher
                    ? L("%@ 比你常用值高了 %@", field.parameter.label,
                        field.parameter.formattedDelta(abs(field.delta)))
                    : L("%@ 比你常用值低了 %@", field.parameter.label,
                        field.parameter.formattedDelta(abs(field.delta)))
            }
            return Insight(
                id: UUID(),
                kind: .deviation,
                headline: L("这次参数偏离了你高评分记录的常用范围"),
                reasons: reasons,
                evidence: analysis.fields.map(evidenceRow),
                confidence: .medium,
                beanID: bean.id
            )
        }
    }

    private static func evidenceRow(_ field: DeviationField) -> Insight.Evidence {
        Insight.Evidence(text: L("%@：当前 %@（常用 %@）",
                                  field.parameter.label,
                                  field.parameter.formatted(field.current),
                                  field.parameter.formatted(field.typical)))
    }

    // MARK: 相似冲煮（协议 §21 / §25）

    static func similarHistory(hits: [VectorHit], query: String, beans: [Bean]) -> Insight {
        guard !hits.isEmpty else {
            return Insight(
                id: UUID(),
                kind: .similarHistory,
                headline: L("没有找到相似的记录"),
                reasons: [L("换一个说法再试，比如直接写「尾段发干」。")],
                evidence: [],
                confidence: .insufficientEvidence,
                beanID: nil
            )
        }

        var reasons: [String] = []

        // 共同点的统计：只报告**事实分布**，不下因果结论（协议 §21 的红线）。
        let methods = hits.compactMap(\.passage.metadata.method).filter { !$0.isEmpty }
        if !methods.isEmpty {
            var counts: [String: Int] = [:]
            for method in methods { counts[method, default: 0] += 1 }
            if let (method, count) = counts.max(by: { $0.value < $1.value }), count > 1 {
                reasons.append(L("%@ 条里有 %@ 次都用的是 %@。", String(hits.count), String(count), method))
            }
        }
        let scores = hits.compactMap(\.passage.metadata.score).filter { $0 > 0 }
        if !scores.isEmpty {
            let average = Double(scores.reduce(0, +)) / Double(scores.count)
            reasons.append(L("这些记录的平均评分是 %@ 分。", Fmt.number(average)))
        }

        let names = Dictionary(beans.map { ($0.id, $0.displayName) }, uniquingKeysWith: { first, _ in first })
        let evidence = hits.map { hit -> Insight.Evidence in
            var parts: [String] = []
            if let date = hit.passage.metadata.docDate {
                parts.append(Fmt.short(date))
            }
            if let method = hit.passage.metadata.method, !method.isEmpty {
                parts.append(method)
            }
            if let score = hit.passage.metadata.score, score > 0 {
                parts.append(L("%@ 分", String(score)))
            }
            if let beanID = hit.passage.metadata.beanID, let name = names[beanID] {
                parts.append(name)
            }
            if let note = hit.passage.metadata.note, !note.isEmpty {
                parts.append(L("「%@」", note))
            }
            return Insight.Evidence(text: parts.joined(separator: " · "))
        }

        return Insight(
            id: UUID(),
            kind: .similarHistory,
            headline: L("找到 %@ 条相似记录", String(hits.count)),
            reasons: reasons,
            evidence: evidence,
            confidence: .medium,
            beanID: nil
        )
    }
}
