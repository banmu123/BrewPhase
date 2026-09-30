import Foundation

/// 把 App 的域模型翻译成**自然语言资料**（协议 §5）。
///
/// 这一层是「结构化数据」与「可检索文本」之间唯一的翻译处。协议明确要求
/// 「不要直接把数据库原始 JSON 当成 embedding 文本」，原因很实际：那样嵌入的是
/// 键名、括号和引号，而不是语义。而一段「用户用埃塞俄比亚 Guji 水洗豆做了一次
/// V60，粉量 18 克…」才是查询能对得上的东西。
///
/// 三条设计约束：
/// 1. **不假设字段存在。** 协议 §4 写着「必须根据当前仓库实际模型映射，不允许
///    假设字段一定存在」。所以每个字段都按可选处理，缺了就不写那一句——而不是
///    写「未知」，后者会变成噪声被嵌进向量里。
/// 2. **复用既有引擎，不重算。** 阶段、烘焙后天数都来自 `PhaseEngine` 与
///    `BrewMath`，和界面上显示的是同一套算术。RAG 自己算一遍迟早会和界面对不上。
/// 3. **可复现。** 同一份数据、同一天、同一语言，生成同一段文本——否则内容指纹
///    每次都变，索引会没完没了地重建。
enum DocumentBuilder {

    /// 生成全部用户数据资料的入口。
    ///
    /// `brews` / `tastings` 单独传入而不是从 `bean.brews` 里取：`Brew.bean` 是
    /// 可选的，理论上存在没有归属的记录，从列表取才漏不掉。
    static func documents(
        beans: [Bean],
        brews: [Brew],
        tastings: [Tasting],
        book: PhaseRuleBook? = nil,
        now: Date = Date(),
        calendar: Calendar = DateMath.calendar
    ) -> [CoffeeKnowledgeDocument] {
        var documents: [CoffeeKnowledgeDocument] = []
        documents.reserveCapacity(beans.count + brews.count + tastings.count + 1)

        for bean in beans {
            documents.append(beanDocument(bean, book: book, now: now, calendar: calendar))
        }
        for brew in brews {
            documents.append(brewDocument(brew, now: now))
        }
        documents.append(contentsOf: tastingDocuments(tastings: tastings, brews: brews, now: now))
        if let preference = preferenceDocument(beans: beans, brews: brews, now: now) {
            documents.append(preference)
        }
        return documents
    }

    // MARK: - 豆子

    static func beanDocument(
        _ bean: Bean,
        book: PhaseRuleBook? = nil,
        now: Date = Date(),
        calendar: Calendar = DateMath.calendar
    ) -> CoffeeKnowledgeDocument {
        var lines: [String] = []

        // 第一句：这是什么。产地/烘焙商缺失时不能留下一个空引号。
        lines.append(L("「%@」是 %@ 的一包咖啡豆。", bean.origin.nonEmpty ?? bean.name, bean.roaster.nonEmpty ?? L("没有记录烘焙商")))

        // 处理法与烘焙度：模型和知识库都关心这两项，所以给它们独立的句子。
        var traits: [String] = []
        if let process = bean.process.nonEmpty { traits.append(L("处理法：%@", process)) }
        traits.append(L("烘焙度：%@", bean.roastLevel.label))
        lines.append(traits.joined(separator: "；") + "。")

        // 时间线：只写存在的那些日期。
        var dates: [String] = []
        if let roastDate = bean.roastDate { dates.append(L("%@ 烘焙", Fmt.short(roastDate, calendar: calendar))) }
        if let purchaseDate = bean.purchaseDate { dates.append(L("%@ 购买", Fmt.short(purchaseDate, calendar: calendar))) }
        if let openDate = bean.openDate { dates.append(L("%@ 开封", Fmt.short(openDate, calendar: calendar))) }
        if !dates.isEmpty { lines.append(dates.joined(separator: "，") + "。") }

        // 存量。`remainingG` 为 0 时 `Bean.init` 会把它设成 `weightG`，所以
        // 0 反而说明这是一包没填规格的豆子——那种情况就不写这一句。
        if bean.weightG > 0 {
            lines.append(L("规格 %@，目前剩 %@。", Fmt.gramsShort(bean.weightG), Fmt.gramsShort(bean.remainingG)))
        }

        if !bean.flavorTags.isEmpty {
            lines.append(L("风味标签：%@。", FlavorLibrary.displayList(bean.flavorTags)))
        }
        if let notes = bean.notes.nonEmpty {
            lines.append(L("备注：%@", notes))
        }

        // 阶段：直接问既有引擎，保证和详情页说的是同一句话。
        let reading = PhaseEngine.reading(
            for: bean.snapshot,
            rule: book?.rule(for: bean.roastLevel),
            today: now,
            calendar: calendar
        )
        if let day = reading.dayAfterRoast {
            lines.append(L("今天是烘焙后第 %@ 天，处于「%@」。", String(day), reading.phase.title))
        } else {
            lines.append(L("这包豆子没有烘焙日期，所以无法判断它现在处于哪个阶段。"))
        }

        // 冲煮历史的一句摘要。评分只在 > 0 时才算——这是 App 的约定，
        // 0 是「没打分」而不是「1 分」的邻居。
        let scored = bean.brewsNewestFirst.filter { $0.score > 0 }
        if !bean.brewsNewestFirst.isEmpty {
            if let latest = scored.first {
                lines.append(L("这包豆一共冲过 %@ 次，最近一次评分 %@ 分（%@）。",
                               String(bean.brewsCount), String(latest.score), Fmt.short(latest.date, calendar: calendar)))
            } else {
                lines.append(L("这包豆一共冲过 %@ 次，还没有打过分。", String(bean.brewsCount)))
            }
        }
        if bean.isFinished {
            lines.append(L("这包豆已经标记为喝完。"))
        }

        let title = bean.name.nonEmpty ?? bean.origin.nonEmpty ?? L("没有名字的豆子")
        return CoffeeKnowledgeDocument(
            sourceType: .bean,
            sourceId: bean.id.uuidString,
            title: title,
            content: lines.joined(separator: "\n"),
            metadata: DocumentMetadata(
                beanID: bean.id,
                docDate: bean.roastDate ?? bean.purchaseDate ?? bean.createdAt,
                dayAfterRoast: reading.dayAfterRoast,
                score: scored.first?.score,
                origin: bean.origin.nonEmpty,
                process: bean.process.nonEmpty,
                roaster: bean.roaster.nonEmpty,
                roastLevel: bean.roastLevel.rawValue,
                entityIds: entityIDs(for: bean, now: now)
            ),
            updatedAt: bean.updatedAt
        )
    }

    // MARK: - 冲煮

    static func brewDocument(_ brew: Brew, now: Date = Date()) -> CoffeeKnowledgeDocument {
        let bean = brew.bean
        let beanName = bean?.displayName ?? L("一包没有记录的豆子")

        var lines: [String] = []
        lines.append(L("用户在 %@ 用「%@」做了一次 %@。",
                       Fmt.short(brew.date), beanName, brew.method.nonEmpty ?? L("冲煮")))

        // 配方。粉水比由 `BrewMath` 现算（`ratio` 不落库，就是为了不出现
        // 「18g/300g 但比例写着 1:15」这种自相矛盾）。
        var recipe: [String] = []
        if brew.coffeeG > 0 { recipe.append(L("粉量 %@", Fmt.gramsShort(brew.coffeeG))) }
        if brew.waterG > 0 { recipe.append(L("水量 %@", Fmt.gramsShort(brew.waterG))) }
        if brew.coffeeG > 0, brew.waterG > 0 { recipe.append(L("粉水比 %@", brew.ratioText)) }
        if brew.waterTemp > 0 { recipe.append(L("水温 %@°C", Fmt.number(brew.waterTemp))) }
        if let grind = brew.grindSize.nonEmpty { recipe.append(L("研磨度 %@", grind)) }
        if brew.timeSeconds > 0 { recipe.append(L("总时间 %@", brew.timeText)) }
        if let grinder = brew.grinder.nonEmpty { recipe.append(L("磨豆机 %@", grinder)) }
        if !recipe.isEmpty { lines.append(recipe.joined(separator: "，") + "。") }

        if let day = brew.dayAfterRoast {
            lines.append(L("这次冲煮在烘焙后第 %@ 天。", String(day)))
        }

        // 评分与分项。分项 0 表示没填，不写成「苦 0」——那会被读成「一点苦都没有」，
        // 和「没评价」是两回事。
        if brew.score > 0 {
            var verdict = L("这次评分 %@ 分", String(brew.score))
            var parts: [String] = []
            if brew.acidity > 0 { parts.append(L("酸 %@", String(brew.acidity))) }
            if brew.sweetness > 0 { parts.append(L("甜 %@", String(brew.sweetness))) }
            if brew.bitterness > 0 { parts.append(L("苦 %@", String(brew.bitterness))) }
            if brew.body > 0 { parts.append(L("醇厚度 %@", String(brew.body))) }
            if brew.aftertaste > 0 { parts.append(L("余韵 %@", String(brew.aftertaste))) }
            if !parts.isEmpty { verdict += L("（%@）", parts.joined(separator: "、")) }
            lines.append(verdict + "。")
        }

        if !brew.flavorTags.isEmpty {
            lines.append(L("记录到的风味：%@。", FlavorLibrary.displayList(brew.flavorTags)))
        }
        if let notes = brew.notes.nonEmpty {
            lines.append(L("备注：%@", notes))
        }

        return CoffeeKnowledgeDocument(
            sourceType: .brew,
            sourceId: brew.id.uuidString,
            title: L("%@ 的 %@ 冲煮", Fmt.short(brew.date), brew.method.nonEmpty ?? L("冲煮")),
            content: lines.joined(separator: "\n"),
            metadata: DocumentMetadata(
                beanID: bean?.id,
                brewID: brew.id,
                method: brew.method.nonEmpty,
                grinder: brew.grinder.nonEmpty,
                docDate: brew.date,
                dayAfterRoast: brew.dayAfterRoast,
                score: brew.score > 0 ? brew.score : nil,
                origin: bean?.origin.nonEmpty,
                process: bean?.process.nonEmpty,
                roaster: bean?.roaster.nonEmpty,
                roastLevel: bean?.roastLevel.rawValue,
                entityIds: entityIDs(for: bean, method: brew.method.nonEmpty, now: now),
                note: brew.notes.nonEmpty
            ),
            updatedAt: brew.createdAt
        )
    }

    // MARK: - 风味记录

    /// 风味记录，**跳过那些完全由冲煮镜像出来的**。
    ///
    /// 这是这个项目里最容易踩的一个坑：`Brew.makeTasting()` 会把每次冲煮顺手写成
    /// 一条风味记录，所以一条冲煮在库里是两行。如果两条都建索引，检索会把同一件
    /// 事当成两条独立证据，回答里就会出现「你在两次冲煮里都提到了柑橘」——
    /// 而实际只冲过一次。
    ///
    /// 判据是内容而不是来源标记：用户后来手动改过那条镜像记录的话，它就带上了
    /// 冲煮里没有的信息，那就得留下。
    static func tastingDocuments(tastings: [Tasting], brews: [Brew], now: Date = Date()) -> [CoffeeKnowledgeDocument] {
        let brewsByID = Dictionary(brews.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })

        return tastings.compactMap { tasting in
            // 没有任何可嵌入内容的记录是噪声，不是数据点。
            guard tasting.score > 0 || !tasting.flavorTags.isEmpty || !tasting.notes.trimmed.isEmpty else {
                return nil
            }

            if tasting.source == .brew, let brewID = tasting.brewID, let brew = brewsByID[brewID] {
                let mirrored = brew.score == tasting.score
                    && brew.flavorTags == tasting.flavorTags
                    && brew.notes == tasting.notes
                if mirrored { return nil }
            }
            return tastingDocument(tasting, now: now)
        }
    }

    static func tastingDocument(_ tasting: Tasting, now: Date = Date()) -> CoffeeKnowledgeDocument {
        let bean = tasting.bean
        let beanName = bean?.displayName ?? L("一包没有记录的豆子")

        var lines: [String] = []
        lines.append(L("用户在 %@ 给「%@」记了一次风味，那时是烘焙后第 %@ 天。",
                       Fmt.short(tasting.date), beanName, String(tasting.dayAfterRoast)))

        if tasting.score > 0 {
            lines.append(L("评分 %@ 分。", String(tasting.score)))
        }
        if !tasting.flavorTags.isEmpty {
            lines.append(L("风味：%@。", FlavorLibrary.displayList(tasting.flavorTags)))
        }
        if let notes = tasting.notes.nonEmpty {
            lines.append(L("用户写下的原话：%@", notes))
        }
        if tasting.source == .manual {
            lines.append(L("这条是用户单独记的，不是某次冲煮的附笔。"))
        }

        return CoffeeKnowledgeDocument(
            sourceType: .tasting,
            sourceId: tasting.id.uuidString,
            title: L("%@ 的风味记录", Fmt.short(tasting.date)),
            content: lines.joined(separator: "\n"),
            metadata: DocumentMetadata(
                beanID: bean?.id,
                tastingID: tasting.id,
                docDate: tasting.date,
                dayAfterRoast: tasting.dayAfterRoast,
                score: tasting.score > 0 ? tasting.score : nil,
                origin: bean?.origin.nonEmpty,
                process: bean?.process.nonEmpty,
                roaster: bean?.roaster.nonEmpty,
                roastLevel: bean?.roastLevel.rawValue,
                entityIds: entityIDs(for: bean, now: now),
                note: tasting.notes.nonEmpty
            ),
            updatedAt: tasting.createdAt
        )
    }

    // MARK: - 口味偏好

    /// 把散在记录里的偏好聚成一条资料。
    ///
    /// 为什么值得单独一条：协议 §4 把「用户偏好」列为一类数据源，而「我喜欢什么」
    /// 这种问题在几百条冲煮记录里做向量检索是靠运气的——它问的是**统计**，不是
    /// 某一次记录。聚合一次，问题就变成了对一条资料的检索。
    ///
    /// 只有真的存在记录时才生成；一包豆都没有的空库里，「你的偏好是 V60」
    /// 是编出来的。
    static func preferenceDocument(beans: [Bean], brews: [Brew], now: Date = Date()) -> CoffeeKnowledgeDocument? {
        guard !beans.isEmpty || !brews.isEmpty else { return nil }

        var lines: [String] = []

        // 风味偏好：只统计打过分、且分数在及格线以上的记录，否则统计的是
        // 「喝过的」而不是「喜欢的」。
        let liked = brews.filter { $0.score >= 4 }
        var tagCounts: [String: Int] = [:]
        for brew in liked {
            for tag in brew.flavorTags { tagCounts[tag, default: 0] += 1 }
        }
        if !tagCounts.isEmpty {
            let ranked = tagCounts.sorted { ($0.value, $1.key) > ($1.value, $0.key) }.prefix(6)
            let text = ranked.map { L("%@（%@ 次）", FlavorLibrary.displayName(for: $0.key), String($0.value)) }
            lines.append(L("用户给高分时最常记到的风味是：%@。", text.joined(separator: "、")))
        }

        // 常用冲煮方式与器具。
        if let methods = topCounts(brews.map(\.method)), !methods.isEmpty {
            let text = methods.map { L("%@（%@ 次）", $0.key, String($0.value)) }
            lines.append(L("用户最常用的冲煮方式是：%@。", text.joined(separator: "、")))
        }
        if let grinders = topCounts(brews.map(\.grinder)), !grinders.isEmpty {
            lines.append(L("用户常用的磨豆机是：%@。", grinders.map(\.key).joined(separator: "、")))
        }

        // 常用参数。只取填了值的记录求平均，把空值当 0 会把均值拉垮。
        var parameterParts: [String] = []
        if let dose = mean(brews.compactMap { $0.coffeeG > 0 ? $0.coffeeG : nil }) {
            parameterParts.append(L("粉量约 %@", Fmt.gramsShort(dose)))
        }
        if let water = mean(brews.compactMap { $0.waterG > 0 ? $0.waterG : nil }) {
            parameterParts.append(L("水量约 %@", Fmt.gramsShort(water)))
        }
        if let temp = mean(brews.compactMap { $0.waterTemp > 0 ? $0.waterTemp : nil }) {
            parameterParts.append(L("水温约 %@°C", Fmt.number(temp)))
        }
        if !parameterParts.isEmpty {
            lines.append(L("用户常用的参数是：%@。", parameterParts.joined(separator: "，")))
        }

        // 评价最好的豆子。
        let bestBeans = beans
            .compactMap { bean -> (String, Double)? in
                let scores = bean.brewsNewestFirst.filter { $0.score > 0 }.map { Double($0.score) }
                guard !scores.isEmpty else { return nil }
                return (bean.displayName, scores.reduce(0, +) / Double(scores.count))
            }
            .sorted { $0.1 > $1.1 }
            .prefix(3)
        if !bestBeans.isEmpty {
            let text = bestBeans.map { L("%@（平均 %@ 分）", $0.0, Fmt.number($0.1)) }
            lines.append(L("用户评价最高的豆子是：%@。", text.joined(separator: "、")))
        }

        lines.append(L("用户目前有 %@ 包豆子、%@ 次冲煮记录。", String(beans.count), String(brews.count)))

        return CoffeeKnowledgeDocument(
            sourceType: .preference,
            sourceId: "preference",
            title: L("口味偏好"),
            content: lines.joined(separator: "\n"),
            metadata: DocumentMetadata(docDate: now),
            updatedAt: now
        )
    }

    // MARK: - 小工具

    /// 从豆子（可选带上这次冲煮的方式）解析出知识实体 id，挂到资料上。
    ///
    /// 用户自己的记录也要带实体：这样「同一产区 / 同一处理法 / 同一烘焙度的往次
    /// 记录」可以被**实体过滤**直接捞出来，而不是靠语义相似度碰运气——后者在
    /// 「换一种说法描述同一件事」时会漏。
    ///
    /// 用的是同一套 `BeanContextResolver`，所以详情页、冲煮页、检索层看到的
    /// 「这包豆关联了什么」永远是同一个答案。
    private static func entityIDs(for bean: Bean?, method: String? = nil, now: Date) -> [String]? {
        guard let bean else { return nil }
        let context = BeanContextResolver().context(for: bean, method: method, today: now)
        return context.entityIDs.isEmpty ? nil : context.entityIDs
    }

    /// 出现次数排序后的前几名。空格与空串先剔掉。
    private static func topCounts(_ values: [String], limit: Int = 4) -> [(key: String, value: Int)]? {
        var counts: [String: Int] = [:]
        for value in values {
            let trimmed = value.trimmed
            guard !trimmed.isEmpty else { continue }
            counts[trimmed, default: 0] += 1
        }
        guard !counts.isEmpty else { return nil }
        return counts.sorted { ($0.value, $1.key) > ($1.value, $0.key) }.prefix(limit).map { ($0.key, $0.value) }
    }

    private static func mean(_ values: [Double]) -> Double? {
        guard !values.isEmpty else { return nil }
        return values.reduce(0, +) / Double(values.count)
    }
}

// MARK: - 便利访问

extension Bean {
    /// 展示用名字：优先用户起的名字，退回到产地，最后给个不尴尬的占位。
    var displayName: String {
        name.nonEmpty ?? origin.nonEmpty ?? L("没有名字的豆子")
    }
}
