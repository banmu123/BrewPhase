import Foundation

/// 回答正文的轻量排版。
///
/// 为什么需要这一层：抽取式回答原本是一串**等重**的 `· 行`——结论、依据、建议、
/// 知识库里的话全在同一个视觉层级上，一屏十几行平铺下来读着累，也看不出哪一句
/// 是重点。真机截图确认过：同一段文字换成有层次的排版，信息一个字没少，读起来
/// 完全是另一回事。
///
/// 这里定义的是一套**极小的 Markdown 子集**，只够表达层次，不做通用解析：
///
/// | 写法 | 含义 | 界面（`AnswerBody`） |
/// |---|---|---|
/// | `# 字` | 小节标题 | 小号、浅色、带字距 |
/// | `- 字` | 条目 | 圆点 + 悬挂缩进 |
/// | `! 字` | 重点 | 浅底 + 左侧色条 |
/// | `~ 字` | 脚注 | 更小、更浅 |
/// | `**字**` | 行内加重 | 半粗 |
/// | 行尾 `[3]` | 引用编号 | 角标（浅褐、上标） |
/// | 行尾 `：` | 引出下面几条 | 与小节标题同排 |
///
/// 两个刻意的克制：
///
/// 1. **不引入 Markdown 库**。需要表达的只有这四层，通用解析器（表格、嵌套列表、
///    链接、HTML 转义…）带来的全是本项目用不到的分支和依赖。
/// 2. **引用只认行尾的 `[n]`**。行内的方括号（「我加了 [2] 克粉」）不算引用——
///    用户自己的记录、豆名、笔记都会流进这段正文，把句中的方括号渲染成角标会
///    凭空造出一个出处，这是这个应用最不能犯的错。
///
/// 选 Markdown 而不是自造一套结构，是因为 V2 把生成式模型挂回来时，模型输出的
/// 天然就是它——那时界面这一层一个字都不用改。
enum AnswerMarkup {

    // MARK: - 标记

    static let heading = "# "
    static let bullet = "- "
    static let callout = "! "
    static let note = "~ "

    // MARK: - 结构

    enum Kind: Equatable, Sendable {
        case heading
        case bullet
        /// 重点块：一段话里最该被看见的那一句。
        case callout
        /// 脚注：依据、来源这类补充说明。
        case note
        case paragraph
    }

    /// 行内片段。分开存是为了让界面能给出「这一小段要半粗、这一小段是角标」，
    /// 而不是先拼成 AttributedString 再猜。
    enum Run: Equatable, Sendable {
        case text(String)
        case strong(String)
        case citation(String)
    }

    struct Block: Equatable, Sendable, Identifiable {
        let id: Int
        let kind: Kind
        let runs: [Run]
    }

    // MARK: - 解析

    /// 把一段正文切成块。空的、只有标记没有内容的行直接丢掉。
    static func parse(_ text: String) -> [Block] {
        var blocks: [Block] = []
        for raw in text.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n") {
            let line = String(raw).trimmed
            guard !line.isEmpty else { continue }
            let (content, citation) = citationAtEnd(of: line)
            let (kind, body) = classify(content)
            var runs = runs(in: body)
            if let citation { runs.append(.citation(citation)) }
            guard !runs.isEmpty else { continue }
            blocks.append(Block(id: blocks.count, kind: kind, runs: runs))
        }
        return blocks
    }

    /// 这一行有没有自带排版标记。
    ///
    /// 抽取式回答用它区分两种正文：结构化事实自带 `#` / `-` / `!` / `~`（它的顺序
    /// 与重点本来就是算好的），普通记录没有标记，一律按条目列出来。
    static func isMarked(_ line: String) -> Bool {
        classify(citationAtEnd(of: line).text).0 != .paragraph
    }

    /// 去掉排版标记的纯文本。
    ///
    /// 用处是引用列表里那两行摘要：那里要的是一句人话，不是一个带 `##` 的原文。
    /// 引用编号一并去掉——摘要旁边就写着 `[1]`，正文里再来一个只是重复。
    static func plain(_ text: String) -> String {
        parse(text)
            .map { block in
                block.runs
                    .map { run -> String in
                        switch run {
                        case .text(let value), .strong(let value): return value
                        case .citation: return ""
                        }
                    }
                    .joined()
            }
            .joined(separator: " ")
            .trimmed
    }

    // MARK: - 行

    private static func classify(_ line: String) -> (Kind, String) {
        for (prefix, kind) in [(heading, Kind.heading), (bullet, Kind.bullet),
                               (callout, Kind.callout), (note, Kind.note)] where line.hasPrefix(prefix) {
            return (kind, String(line.dropFirst(prefix.count)).trimmed)
        }
        // 以冒号收尾的一行是在**引出**下面那几条（「最近的 3 次冲煮参数：」）。
        // 它是小节标题而不是列表里的第一颗子弹——事实正文里最常出现的正是这种写法，
        // 按标题排出来，一眼就知道下面那几条是一组。
        if line.hasSuffix("：") || line.hasSuffix(":") {
            return (.heading, String(line.dropLast()).trimmed)
        }
        return (.paragraph, line)
    }

    private static func runs(in line: String) -> [Run] {
        var result: [Run] = []
        var buffer = ""
        func flush() {
            guard !buffer.isEmpty else { return }
            result.append(.text(buffer))
            buffer = ""
        }

        var index = line.startIndex
        while index < line.endIndex {
            // `**加重**`：成对出现才生效，落单的星号按普通字符走。
            if line[index...].hasPrefix("**"),
               let close = line.range(of: "**", range: line.index(index, offsetBy: 2)..<line.endIndex) {
                flush()
                let inner = String(line[line.index(index, offsetBy: 2)..<close.lowerBound])
                if !inner.isEmpty { result.append(.strong(inner)) }
                index = close.upperBound
                continue
            }
            buffer.append(line[index])
            index = line.index(after: index)
        }
        flush()
        return result
    }

    /// 行尾的 `[n]`，以及剥掉它之后剩下的正文。
    ///
    /// 三条都要满足才算：以 `]` 收尾、括号里全是数字、`[` 前面是空格。
    /// 第三条是关键——「我加了 [2] 克粉」不会因此变成一个出处。
    private static func citationAtEnd(of line: String) -> (text: String, citation: String?) {
        let trimmed = line.trimmed
        guard trimmed.hasSuffix("]"), let open = trimmed.lastIndex(of: "[") else { return (trimmed, nil) }
        let digits = trimmed[trimmed.index(after: open)..<trimmed.index(before: trimmed.endIndex)]
        guard !digits.isEmpty, digits.allSatisfy(\.isNumber) else { return (trimmed, nil) }
        let before = trimmed[trimmed.startIndex..<open]
        guard before.isEmpty || before.hasSuffix(" ") else { return (trimmed, nil) }
        return (String(before).trimmed, String(digits))
    }
}
