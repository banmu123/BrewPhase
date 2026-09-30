import Foundation

/// 抽取式回答：不用任何模型，把检索到的证据组织成一段话。
///
/// 它存在的理由不是「兜底」这么简单。协议把这一版定为 local-first——没有账号、
/// 没有服务器、飞行模式也要能用。如果回答必须依赖一个生成式模型，那么在没有
/// Ollama、设备也不支持端侧模型的机器上，这个功能就是空的。有了它，**检索这条
/// 链路本身的价值立刻可用**：用户问「我最近三次怎么冲这包豆的」，它给出的是真实
/// 的检索结果，而不是一句「请先安装模型」。
///
/// 它也能如实说「没找到」——而且比模型更可靠，因为它没有可以编造的语言能力。
struct ExtractiveLLMProvider: LLMProvider {

    let engine: AnswerEngine = .onDeviceSummary
    var identifier: String { "extractive.v1" }

    func generate(prompt: String, context: BuiltContext) async throws -> String {
        // `prompt` 是给生成式模型的纪律说明，这里用不上——抽取式不会跑题。
        _ = prompt

        guard !context.isEmpty else {
            return L("我在你的记录和 BrewPhase 知识库里都没有找到和这个问题相关的内容。可以换个说法再问一次，或者先补上这包豆子的烘焙日期、开封日期这类信息。")
        }

        var sections: [String] = []

        // 1 — 直接结论：结构化事实本身就是答案。
        let facts = context.userBlocks.filter(\.isFact)
        if !facts.isEmpty {
            var lines: [String] = [L("根据你的记录：")]
            for block in facts {
                for raw in block.passage.content.split(separator: "\n") {
                    let line = String(raw).trimmed
                    guard !line.isEmpty else { continue }
                    lines.append("· \(line) [\(block.citation)]")
                }
            }
            sections.append(lines.joined(separator: "\n"))
        }

        // 2 — 相关的记录片段：从每条里挑最贴题的两句，而不是整段贴上来。
        let documents = context.userBlocks.filter { !$0.isFact }
        if !documents.isEmpty {
            var lines: [String] = [facts.isEmpty ? L("你的记录里有这些：") : L("另外，相关的记录：")]
            for block in documents.prefix(3) {
                let excerpt = Self.bestSentences(in: block.passage.content, terms: context.terms, count: 2)
                guard !excerpt.isEmpty else { continue }
                lines.append("· \(block.passage.title)：\(excerpt) [\(block.citation)]")
            }
            if lines.count > 1 { sections.append(lines.joined(separator: "\n")) }
        }

        // 3 — 知识库的说法单独一段，绝不和用户自己的记录混在一起。
        if context.hasKnowledge {
            var lines: [String] = [L("BrewPhase 知识库里相关的说法：")]
            for block in context.knowledgeBlocks.prefix(2) {
                let excerpt = Self.bestSentences(in: block.passage.content, terms: context.terms, count: 2)
                guard !excerpt.isEmpty else { continue }
                lines.append("· \(block.passage.title)：\(excerpt) [\(block.citation)]")
            }
            if lines.count > 1 { sections.append(lines.joined(separator: "\n")) }
        }

        // 4 — 只说知识库的时候必须讲清楚：那不是用户的经历。
        if !context.hasUserData {
            sections.append(L("你的记录里没有相关内容，上面只有知识库里的通用说法，不代表你的实际情况。"))
        }

        return sections.joined(separator: "\n\n")
    }

    /// 从一段正文里挑最贴题的两句。
    ///
    /// 判据是「这句话里出现了几个问题里的关键词」，同分时**保留原文顺序**——
    /// 乱序拼出来的摘录读起来像坏掉的翻译，而连贯的句子即使不那么贴题也更容易看懂。
    static func bestSentences(in content: String, terms: [String], count: Int) -> String {
        let sentences = content
            .replacingOccurrences(of: "\n", with: "。")
            .components(separatedBy: "。")
            .map(\.trimmed)
            .filter { !$0.isEmpty }
        guard !sentences.isEmpty else { return "" }
        guard sentences.count > count else { return sentences.joined(separator: "。") + "。" }

        let scored = sentences.enumerated().map { index, sentence -> (index: Int, score: Int) in
            let normalised = LexicalEmbeddingProvider.normalised(sentence)
            let score = terms.reduce(0) { total, term in
                guard !term.isEmpty, normalised.contains(term) else { return total }
                return total + 1
            }
            return (index, score)
        }

        let picked = scored
            .sorted { ($0.score, -$0.index) > ($1.score, -$1.index) }
            .prefix(count)
            .map(\.index)
            .sorted()
        return picked.map { sentences[$0] }.joined(separator: "。") + "。"
    }
}
