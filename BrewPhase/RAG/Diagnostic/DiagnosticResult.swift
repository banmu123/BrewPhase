import Foundation

/// 诊断的候选结论（规格 §十）。
///
/// 名字里全部带「疑似 / 偏」：这一层永远不说「就是萃取不足」。理由不是客气——
/// 一杯咖啡的味道有六七个变量在拉扯，从三条证据推出唯一病因是不可能的，所以
/// 输出的是**候选**加**置信度**，判断留给用户下一杯去验证（规格 §十一）。
enum DiagnosticFinding: String, CaseIterable, Sendable {
    case suspectedUnderExtraction
    case suspectedOverExtraction
    case fastFlow
    case slowFlow
    case lowSweetness
    case highBitterness
    case thinBody
    case parameterDeviation

    var title: String {
        switch self {
        case .suspectedUnderExtraction: return L("可能萃取不足")
        case .suspectedOverExtraction: return L("可能过萃")
        case .fastFlow: return L("冲得偏快")
        case .slowFlow: return L("冲得偏慢")
        case .lowSweetness: return L("甜感偏低")
        case .highBitterness: return L("苦味偏重")
        case .thinBody: return L("口感偏薄")
        case .parameterDeviation: return L("参数偏离你的较好记录")
        }
    }

    /// 一句话解释这个结论是什么意思（界面用，避免只甩一个术语）。
    var explanation: String {
        switch self {
        case .suspectedUnderExtraction:
            return L("水流过快、萃取不够，常见的表现是酸高、甜少、口感偏薄。")
        case .suspectedOverExtraction:
            return L("萃得太久或太细，常见的表现是苦、干、余韵拖得长。")
        case .fastFlow:
            return L("这一杯比你自己的记录快，通常意味着通道或研磨偏粗。")
        case .slowFlow:
            return L("这一杯比你自己的记录慢，通常是研磨偏细或细粉堵住了。")
        case .lowSweetness:
            return L("甜感低于你自己好喝的那几杯。")
        case .highBitterness:
            return L("苦味高于你自己好喝的那几杯。")
        case .thinBody:
            return L("口感比你自己好喝的那几杯更薄。")
        case .parameterDeviation:
            return L("这一杯和你自己评价较高的那几次差得比较远。")
        }
    }
}

/// 一个候选结论 + 它的证据（规格 §十八：诊断必须有证据）。
struct DiagnosticCandidate: Equatable, Sendable, Identifiable {
    let finding: DiagnosticFinding
    /// 置信度沿用 `Insight.Confidence`：同一套说法在整条智能层里只该有一套。
    let confidence: Insight.Confidence
    /// 逐条证据。每一行都要有真实数字，否则就是编的。
    let evidence: [String]

    var id: String { finding.rawValue }
}

/// 可以动手调的旋钮。
///
/// 与 `BrewParameter` 的分工：那个是**可比较的数值参数**（水温/时间/粉水比/粉量），
/// 偏差分析用它；这个是**能拧的旋钮**，多一个研磨度——研磨是自由文本（「22 格」/
/// 「中细」），不参与数值比较，但它恰恰是调参时最常动的那个。
enum AdjustmentParameter: String, CaseIterable, Sendable {
    case grind
    case temperature
    case time
    case dose

    var label: String {
        switch self {
        case .grind: return L("研磨度")
        case .temperature: return L("水温")
        case .time: return L("萃取时间")
        case .dose: return L("粉量")
        }
    }
}

/// 往哪个方向调。
enum AdjustmentDirection: String, CaseIterable, Sendable {
    case finer
    case coarser
    case higher
    case lower
    case longer
    case shorter
    case more
    case less

    /// 措辞跟着参数走：同一个「更多」，在研磨上是「粗一档」、在粉量上是「多加一点」。
    func label(for parameter: AdjustmentParameter) -> String {
        switch (parameter, self) {
        case (.grind, .finer): return L("细一档")
        case (.grind, .coarser): return L("粗一档")
        case (.temperature, .higher): return L("调高一点")
        case (.temperature, .lower): return L("调低一点")
        case (.time, .longer): return L("稍微延长")
        case (.time, .shorter): return L("稍微缩短")
        case (.dose, .more): return L("多加一点粉")
        case (.dose, .less): return L("少一点粉")
        default: return rawValue
        }
    }
}

/// 下一杯怎么改（规格 §十六/§十七）。
///
/// 三条自律写进类型里：
/// 1. **一次只变一个主要变量**——所以只有 `parameter` + `direction` 一组，没有列表；
/// 2. **不硬算精确数值**——方向 + 相对措辞（「细一档」「调高一点」），
///    只有用户自己的历史区间是真实数字，可以写出来；
/// 3. 保持不变的东西与要观察的东西都显式列出来，用户才知道这次改动的边界在哪。
struct AdjustmentSuggestion: Equatable, Sendable {

    let parameter: AdjustmentParameter
    let direction: AdjustmentDirection
    /// 为什么这么改（来自诊断的证据）。
    let reason: String
    /// 预期会变好在哪里。
    let expectedEffect: String
    /// 保持不变的部分。
    let keep: [String]
    /// 下一杯要留意的表现。
    let observe: [String]
    /// 你自己的历史区间（有就写成「你的较好记录在 91–92°C」）。
    let referenceRange: String?

    /// 相对措辞，就是方向本身的说法。
    var relativeAdjustment: String { direction.label(for: parameter) }

    /// 界面上那一行（「研磨度：细一档」）。
    var headline: String { L("%@：%@", parameter.label, relativeAdjustment) }

    /// 「优先调整：…」——规格 §十六 的标题口径。
    static var priorityTitle: String { L("优先调整") }
    static var keepTitle: String { L("保持不变") }
    static var observeTitle: String { L("下一杯留意") }
}

/// 一份完整的诊断（规格 §九）。
struct BrewDiagnosis: Equatable, Sendable {

    /// 候选结论，强的在前。空 = 没找到值得说的信号。
    let candidates: [DiagnosticCandidate]
    let baseline: PersonalBaseline
    /// 下一杯的建议。数据不足或一切正常时为 nil——**不给建议也是结论**。
    let suggestion: AdjustmentSuggestion?
    /// 解释性说明（数据不足、缺了哪些信息）。
    let notes: [String]
    /// 知识库依据（规格 §十九）。
    let knowledge: [KnowledgeEvidence]

    var primary: DiagnosticCandidate? { candidates.first }
    var hasCandidates: Bool { !candidates.isEmpty }

    /// 数据不足，只能明说（规格 §二十六）。
    static func insufficient(_ baseline: PersonalBaseline, notes: [String]) -> BrewDiagnosis {
        BrewDiagnosis(candidates: [], baseline: baseline, suggestion: nil,
                      notes: notes, knowledge: [])
    }

    /// 有基线、但这杯看起来正常。
    static func unremarkable(_ baseline: PersonalBaseline, notes: [String]) -> BrewDiagnosis {
        BrewDiagnosis(candidates: [], baseline: baseline, suggestion: nil,
                      notes: notes, knowledge: [])
    }
}

// MARK: - 在「问一问」里的排版

extension BrewDiagnosis {

    /// 这份诊断写进回答正文的样子（`AnswerMarkup`，规格 §十/§十六/§十八）。
    ///
    /// 顺序就是用户问「为什么这杯不好喝」时想听到的顺序：
    /// **结论 → 看出来的问题 → 下一杯改哪一件事 → 保持不变 → 知识库 → 依据**。
    ///
    /// 之前这里是一串等重的句子，由回答层再给每行加一个圆点，结果十二行完全平铺；
    /// 现在把层次交给排版标记，回答层只负责把它带出去。
    ///
    /// 两条自律没有变：结论一律写成**候选**（「更接近」，不说「就是」），建议一律
    /// 只给**一个**旋钮。数据不够时这里写的是「还差几次」，不是硬凑一条建议。
    var markup: String {
        var lines: [String] = []

        if let primary {
            lines.append(AnswerMarkup.callout
                         + L("最近这一杯更接近「%@」（%@）。",
                             primary.finding.title, primary.confidence.diagnosticLabel))
            lines.append("")
            lines.append(AnswerMarkup.heading + L("看出来的问题"))
            for item in primary.evidence {
                lines.append(AnswerMarkup.bullet + item)
            }
            let extras = candidates.dropFirst().prefix(2).map(\.finding.title)
            if !extras.isEmpty {
                lines.append(AnswerMarkup.note + L("另外还看到：%@。", extras.joined(separator: L("、"))))
            }
        } else if baseline.isUsable {
            lines.append(AnswerMarkup.callout + L("最近这一杯在你自己的记录里没有明显异常。"))
        } else {
            lines.append(AnswerMarkup.callout + baseline.shortfallMessage)
            lines.append(AnswerMarkup.note + PersonalBaseline.keepRecordingAdvice)
        }

        if let suggestion {
            lines.append("")
            lines.append(AnswerMarkup.heading + L("下一杯建议"))
            // 改哪个旋钮、往哪边改，与「为什么」放在同一块里：这两句分开读，
            // 用户就容易只记住动作、忘掉理由。
            lines.append(AnswerMarkup.callout
                         + "**\(suggestion.headline)**" + L("。") + suggestion.reason)
            if !suggestion.keep.isEmpty {
                lines.append(AnswerMarkup.bullet
                             + L("**保持不变**：%@", suggestion.keep.joined(separator: L("、"))))
            }
            if !suggestion.observe.isEmpty {
                lines.append(AnswerMarkup.bullet
                             + L("**下一杯留意**：%@", suggestion.observe.joined(separator: L("、"))))
            }
        } else if baseline.isUsable, !candidates.isEmpty {
            lines.append(AnswerMarkup.note + L("这一轮没有足够把握给出单向的调整建议。"))
        }

        if !knowledge.isEmpty {
            lines.append("")
            lines.append(AnswerMarkup.heading + L("知识库"))
            for item in knowledge.prefix(2) {
                // 出处写在条目里，不另挂引用编号：这几条不是从用户记录里算出来的，
                // 标成 [1]（那条结构化事实）会把「谁说的」搅混。
                lines.append(AnswerMarkup.bullet + "**\(item.title)** · \(item.source)")
            }
        }

        // 依据有多硬写清楚，等于告诉用户这句话该信几分。
        //
        // 判据是「有没有参考记录」而不是「基线成不成立」：只有一条较好记录时基线
        // 不成立，但那时**更**需要写出来——否则用户会以为这一条结论跟三条记录时
        // 一样硬。真正没参考记录时不写：那时候「依据：0 次高评分记录」是自相矛盾
        // 的一句话，而上面的结论块已经在说「还差几次」。
        if baseline.highRatedCount > 0 {
            lines.append("")
            lines.append(AnswerMarkup.note + baseline.basisNote)
        }

        return lines.joined(separator: "\n")
    }
}
