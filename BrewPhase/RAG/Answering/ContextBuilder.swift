import Foundation

/// 把检索结果整理成上下文。
///
/// 只做四件事，但每一件都是为了回答质量：
/// 1. **去掉几乎重复的**——同一天同样的配方冲了两次，两条都进上下文只会让模型
///    以为那是常态；
/// 2. **按来源分组**——用户数据在前、知识库在后，中间明确分隔；
/// 3. **守住字符预算**——本地小模型的注意力是有限的，塞满反而答得差；
/// 4. **编稳定的号**——模型在回答里要写 `[2]`，界面要能把 `[2]` 指回具体那条，
///    两边必须用同一套编号。
enum ContextBuilder {

    /// 默认预算，按字符算。
    ///
    /// 6000 字符大致相当于 3000–4000 个中文 token，对本地 7B 级模型是「塞得下
    /// 又不至于淹掉指令」的区间。
    static let defaultBudget = 6000

    static func build(
        question: String,
        passages: [RetrievedPassage],
        terms: [String] = [],
        budget: Int = defaultBudget
    ) -> BuiltContext {
        var context = BuiltContext(question: question, terms: terms, characterBudget: budget)

        let deduped = dropNearDuplicates(passages)

        let userPassages = deduped.filter(\.isUserData)
        let knowledgePassages = deduped.filter { !$0.isUserData }

        // 预算分配：知识库最多占三成。
        //
        // 为什么不是平分：用户问的是**他自己的咖啡**。知识库是背景，它该在需要
        // 的时候出现（解释处理法、休息期），但不该和用户自己的记录抢位置。反过来，
        // 当用户数据一条都没有时，知识库自然拿到全部预算。
        let knowledgeShare = knowledgePassages.isEmpty ? 0.0 : (userPassages.isEmpty ? 1.0 : 0.3)
        let userBudget = Int(Double(budget) * (1 - knowledgeShare))

        let (userBlocks, userUsed) = fill(userPassages, budget: userBudget, startingAt: 1)
        let (knowledgeBlocks, knowledgeUsed) = fill(
            knowledgePassages, budget: budget - userUsed, startingAt: userBlocks.count + 1
        )

        context.userBlocks = userBlocks
        context.knowledgeBlocks = knowledgeBlocks
        context.usedCharacters = userUsed + knowledgeUsed
        context.droppedForBudget = deduped.count - userBlocks.count - knowledgeBlocks.count
        context.rendered = render(context)
        return context
    }

    // MARK: - 去掉近乎重复的

    /// 用 token 集合的 Jaccard 相似度判断两条资料是不是在说同一件事。
    ///
    /// 为什么需要：`Brew` 和它的镜像 `Tasting` 已经在 `DocumentBuilder` 里去过一次
    /// 重了，但「昨天冲了一次、今天用同样的参数又冲了一次」是真实的重复——两条
    /// 记录本身都对，只是放进同一份简报里没有意义。
    private static func dropNearDuplicates(_ passages: [RetrievedPassage]) -> [RetrievedPassage] {
        var kept: [RetrievedPassage] = []
        var tokenSets: [Set<String>] = []

        for passage in passages {
            let tokens = Set(LexicalEmbeddingProvider.tokens(LexicalEmbeddingProvider.normalised(passage.content)))
            // 结构化事实不参与去重：它们本来就是「算出来的结论」，彼此内容不同，
            // 而且丢掉任何一条都会丢信息。
            if passage.origin == .structuredFact {
                kept.append(passage)
                tokenSets.append(tokens)
                continue
            }
            let isDuplicate = tokenSets.contains { existing in
                guard !existing.isEmpty, !tokens.isEmpty else { return false }
                let overlap = Double(existing.intersection(tokens).count)
                let union = Double(existing.union(tokens).count)
                return union > 0 && overlap / union >= 0.9
            }
            if !isDuplicate {
                kept.append(passage)
                tokenSets.append(tokens)
            }
        }
        return kept
    }

    // MARK: - 填预算

    private static func fill(
        _ passages: [RetrievedPassage],
        budget: Int,
        startingAt citation: Int
    ) -> ([BuiltContext.Block], Int) {
        var blocks: [BuiltContext.Block] = []
        var used = 0
        var next = citation

        for passage in passages {
            let cost = passage.title.count + passage.content.count + 8
            // 第一条永远收，哪怕它超预算——一条都没有的上下文比超一点更糟。
            if !blocks.isEmpty, used + cost > budget { break }
            blocks.append(BuiltContext.Block(citation: next, passage: passage))
            used += cost
            next += 1
        }
        return (blocks, used)
    }

    // MARK: - 渲染

    /// 渲染成给模型看的证据正文。
    ///
    /// 两处细节值得说明：
    /// * 分组标题用**用户当前的语言**，因为提示词里的规则也是那个语言；
    /// * 空的一侧也要写出来，并注明「没有找到」。不写的话，模型在看到只有知识库
    ///   的上下文时，很容易把知识库里的通用说法当成用户的经历复述出来。
    private static func render(_ context: BuiltContext) -> String {
        var sections: [String] = []

        sections.append(L("【用户自己的记录】"))
        if context.userBlocks.isEmpty {
            sections.append(L("（没有找到和这个问题相关的记录）"))
        } else {
            sections.append(contentsOf: context.userBlocks.map(render))
        }

        sections.append("")
        sections.append(L("【BrewPhase 内置知识库】"))
        if context.knowledgeBlocks.isEmpty {
            sections.append(L("（没有找到相关的知识条目）"))
        } else {
            sections.append(contentsOf: context.knowledgeBlocks.map(render))
        }

        return sections.joined(separator: "\n")
    }

    private static func render(_ block: BuiltContext.Block) -> String {
        "[\(block.citation)] \(block.passage.title)\n\(block.passage.content)"
    }
}
