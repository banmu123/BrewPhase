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
///
/// 产出的是**带轻量排版标记的正文**（`AnswerMarkup`），不是一坨等重的行：结论、
/// 依据、建议、知识库在版面上是四个不同的层级。标记只有四种，界面按它排版；
/// 将来换成生成式模型时，模型输出的 Markdown 落在同一套标记里，界面不用改。
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
            sections.append(factSection(facts))
        }

        // 2 — 相关的记录片段：从每条里挑最贴题的两句，而不是整段贴上来。
        let documents = context.userBlocks.filter { !$0.isFact }
        if !documents.isEmpty {
            let title = facts.isEmpty ? L("你的记录") : L("相关的记录")
            let lines = [AnswerMarkup.heading + title]
                + documents.prefix(3).compactMap { block -> String? in
                    let excerpt = Self.bestSentences(in: block.passage.content, terms: context.terms, count: 2)
                    guard !excerpt.isEmpty else { return nil }
                    return bullet(title: block.passage.title, body: excerpt, citation: block.citation)
                }
            if lines.count > 1 { sections.append(lines.joined(separator: "\n")) }
        }

        // 3 — 知识库的说法单独一段，绝不和用户自己的记录混在一起。
        if context.hasKnowledge {
            let lines = [AnswerMarkup.heading + L("知识库")]
                + context.knowledgeBlocks.prefix(2).compactMap { block -> String? in
                    let excerpt = Self.bestSentences(in: block.passage.content, terms: context.terms, count: 2)
                    guard !excerpt.isEmpty else { return nil }
                    return bullet(title: block.passage.title, body: excerpt, citation: block.citation)
                }
            if lines.count > 1 { sections.append(lines.joined(separator: "\n")) }
        }

        // 4 — 只说知识库的时候必须讲清楚：那不是用户的经历。
        if !context.hasUserData {
            sections.append(AnswerMarkup.callout
                            + L("你的记录里没有相关内容，上面只有知识库里的通用说法，不代表你的实际情况。"))
        }

        return sections.joined(separator: "\n\n")
    }

    /// 一条记录：标题加粗在前，摘录跟在后面，引用编号收在行尾。
    ///
    /// 分隔用 ` · `，和冲煮参数摘要（`18g · 300g · 92°C`）是同一个符号——它是
    /// **不翻译**的排版符号，中英文都用它。不用冒号是因为冒号在两种语言里的间距
    /// 不一样（中文紧跟、英文留空格），而一个只由标点组成的文案键进不了文案表：
    /// 收集器只认含汉字的字面量（见 `Tools/Localization/keys.py`），键进不了表
    /// 就会在英文界面下露出中文的全角冒号。
    private func bullet(title: String, body: String, citation: Int) -> String {
        AnswerMarkup.bullet + "**\(title)** · \(body) [\(citation)]"
    }

    /// 结构化事实的正文。
    ///
    /// 它**可以自带排版**（`#` / `-` / `!` / `~`）：诊断那类事实的顺序与重点本来
    /// 就是算好的，回答层再压平一次只会把层次丢掉。没带标记的行按条目列出来——
    /// 那是「几条并列的事实」，本来就是列表。
    ///
    /// 引用编号只在**第一行**标一次。一段事实的多行证据来自同一条记录，每行都挂
    /// 一个 `[1]` 是零信息量的重复，也是版面被塞满的主要原因之一。
    private func factSection(_ facts: [BuiltContext.Block]) -> String {
        var chunks: [String] = []

        for block in facts {
            var lines = block.passage.content
                .split(separator: "\n")
                .map { String($0).trimmed }
                .filter { !$0.isEmpty }
            guard !lines.isEmpty else { continue }

            for index in lines.indices where !AnswerMarkup.isMarked(lines[index]) {
                lines[index] = AnswerMarkup.bullet + lines[index]
            }
            lines[0] += " [\(block.citation)]"

            // 只有一条结构化事实时不另加标题：卡片下方的引用列表已经写着它的题目。
            if facts.count > 1 {
                chunks.append(([AnswerMarkup.heading + block.passage.title] + lines).joined(separator: "\n"))
            } else {
                chunks.append(lines.joined(separator: "\n"))
            }
        }

        return chunks.joined(separator: "\n\n")
    }

    /// 从一段正文里挑最贴题的几句。
    ///
    /// 判据是「这句话里出现了几个问题里的关键词」，同分时**保留原文顺序**——
    /// 乱序拼出来的摘录读起来像坏掉的翻译，而连贯的句子即使不那么贴题也更容易看懂。
    static func bestSentences(in content: String, terms: [String], count: Int) -> String {
        let sentences = split(content)
        guard !sentences.isEmpty else { return "" }
        guard sentences.count > count else { return sentences.joined().trimmed }

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
        return picked.map { sentences[$0] }.joined().trimmed
    }

    /// 断句：中文按「。！？」，西文按「. ! ?」——两边都要认。
    ///
    /// 只认中文句号的写法会把**整篇英文正文当成一句话**：英文知识条目里一个「。」
    /// 都没有，于是「挑最贴题的两句」变成「把整篇贴上来」，一条知识摘录能占二十行。
    /// 中英混排的知识库里，这是让回答变长最狠的一处。
    ///
    /// 拼接用空串而不是分隔符：句子连句末标点一起留下（切分是在标点**之后**断的），
    /// 后一句的前导空格也留在句首，所以中英文各自连得对——中文不留多余空格，
    /// 英文不会把两个句子粘成一个词。
    static func split(_ content: String) -> [String] {
        let terminators: Set<Character> = ["。", "！", "？", "!", "?"]
        let normalised = normalise(content)
        var sentences: [String] = []
        var buffer = ""

        var index = normalised.startIndex
        while index < normalised.endIndex {
            let character = normalised[index]
            buffer.append(character)
            let next = normalised.index(after: index)
            if terminators.contains(character) {
                sentences.append(buffer)
                buffer = ""
            } else if character == ".", endsASentence(normalised, at: index, before: buffer) {
                sentences.append(buffer)
                buffer = ""
            }
            index = next
        }
        if !buffer.isEmpty { sentences.append(buffer) }

        return sentences
            .map(dropTrailingWhitespace)
            .filter { !$0.trimmed.isEmpty }
    }

    /// 把换行折成句读——换行本来就是断句。
    ///
    /// 补什么跟着**上一行**的收尾走，因为两种语言在这里的规矩不一样：
    /// 中文句末标点后面不能再加东西（否则读成「V60。18g」，或者补出「V60。。」），
    /// 英文句号后面必须留一个空格（否则两个词粘在一起，而原文的换行本来就在词之间）。
    private static func normalise(_ content: String) -> String {
        var result = ""
        for raw in content.split(separator: "\n", omittingEmptySubsequences: true) {
            let line = String(raw).trimmed
            guard !line.isEmpty else { continue }
            result += separator(after: result) + line
        }
        return result
    }

    private static func separator(after text: String) -> String {
        guard let last = text.last else { return "" }
        if "。！？：；，、".contains(last) { return "" }
        if ".!?:;,".contains(last) { return " " }
        return "。"
    }

    /// 这个句号是不是句末。
    ///
    /// 两个排除：后面还跟着非空白的字符（`3.5`、`grind.co`），以及前面那个词是缩写
    /// （`e.g.`、`et al.`）或单字母（`J. Smith`）。宁可少断一句，也不要把一句话
    /// 从中间劈开——劈开之后的摘录读起来像坏掉的翻译。
    private static func endsASentence(_ text: String, at dot: String.Index, before soFar: String) -> Bool {
        let next = text.index(after: dot)
        guard next == text.endIndex || text[next].isWhitespace else { return false }
        return !endsWithAbbreviation(soFar)
    }

    private static let abbreviations: Set<String> = [
        "e.g", "i.e", "etc", "vs", "approx", "fig", "no", "cf", "al", "inc", "ltd",
        "dr", "mr", "mrs", "ms", "st", "min", "max",
    ]

    private static func endsWithAbbreviation(_ text: String) -> Bool {
        let token = text.split(whereSeparator: \.isWhitespace).last.map(String.init) ?? ""
        let stem = token.hasSuffix(".") ? String(token.dropLast()) : token
        guard !stem.isEmpty else { return false }
        if stem.count == 1, stem.first?.isLetter == true { return true }
        return abbreviations.contains(stem.lowercased())
    }

    private static func dropTrailingWhitespace(_ text: String) -> String {
        var trimmed = text
        while let last = trimmed.last, last.isWhitespace { trimmed.removeLast() }
        return trimmed
    }
}
