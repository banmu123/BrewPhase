import SwiftUI

/// 「本次表现」+「下一杯建议」（规格 §二十五）。
///
/// 刻意不做成 AI 面板：用户要的三件事就三行——这杯怎么样、凭什么这么说、下一杯怎么办。
/// 所以卡片的结构固定为「结论 → 依据 → 建议」，任何一条没有就整块不显示，
/// 绝不用「暂无数据」把版面撑满。
struct BrewDiagnosticCard: View {

    let diagnosis: BrewDiagnosis
    /// 豆子详情页已经有知识区块时不重复显示；只显示与这次诊断直接相关的知识。
    var showsKnowledge = true
    /// 刚记完一杯时，「下一杯建议」是行动的落点，比「本次表现」重一档；
    /// 其它场景（豆子页、问一问）两段保持等重，各读各的。
    var emphasizesSuggestion = false

    var body: some View {
        VStack(alignment: .leading, spacing: Metric.sectionGap) {
            performanceSection
            if let suggestion = diagnosis.suggestion {
                suggestionSection(suggestion)
            }
            if showsKnowledge, !diagnosis.knowledge.isEmpty {
                knowledgeSection
            }
        }
    }

    // MARK: - 本次表现

    private var performanceSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "本次表现")
            Card {
                VStack(alignment: .leading, spacing: 12) {
                    if let primary = diagnosis.primary {
                        conclusion(primary)
                        Divider().overlay(Palette.hairline)
                        evidenceList(primary.evidence)
                        if diagnosis.candidates.count > 1 {
                            otherCandidates
                        }
                    } else {
                        noConclusion
                    }
                    if !diagnosis.notes.isEmpty {
                        noteLines
                    }
                }
            }
        }
    }

    private func conclusion(_ candidate: DiagnosticCandidate) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(candidate.finding.title)
                    .font(TypeScale.cardTitle)
                    .foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                confidenceChip(candidate.confidence)
            }
            Text(candidate.finding.explanation)
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// 置信度用「这些话有多硬」的说法，不用「87%」这种假精度。
    private func confidenceChip(_ confidence: Insight.Confidence) -> some View {
        Text(confidence.diagnosticLabel)
            .font(TypeScale.micro)
            .foregroundStyle(confidence == .low ? Palette.inkFaint : Palette.roast)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Capsule(style: .continuous).fill(Palette.well))
    }

    private func evidenceList(_ lines: [String]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("依据")
                .font(TypeScale.micro)
                .foregroundStyle(Palette.inkFaint)
                .tracking(0.6)
            ForEach(lines, id: \.self) { line in
                HStack(alignment: .top, spacing: 6) {
                    Circle()
                        .fill(Palette.latte)
                        .frame(width: 4, height: 4)
                        .padding(.top, 6)
                    Text(LocalizedStringKey.alreadyLocalized(line))
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkSoft)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var otherCandidates: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("另外还看到")
                .font(TypeScale.micro)
                .foregroundStyle(Palette.inkFaint)
            Text(LocalizedStringKey.alreadyLocalized(
                diagnosis.candidates.dropFirst().map { $0.finding.title }.joined(separator: L("、"))
            ))
            .font(TypeScale.caption)
            .foregroundStyle(Palette.inkSoft)
        }
    }

    /// 没有候选结论的两种情况：数据不够，或者这杯本来就正常。分开说。
    private var noConclusion: some View {
        VStack(alignment: .leading, spacing: 8) {
            if diagnosis.baseline.isUsable {
                Text("这一杯在你自己的记录里没有明显异常。")
                    .font(TypeScale.body)
                    .foregroundStyle(Palette.ink)
            } else {
                Text("目前数据还不足以建立个人基线。")
                    .font(TypeScale.body)
                    .foregroundStyle(Palette.ink)
                Text(LocalizedStringKey.alreadyLocalized(diagnosis.baseline.shortfallMessage))
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
                Text(LocalizedStringKey.alreadyLocalized(PersonalBaseline.keepRecordingAdvice))
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.roast)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var noteLines: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(diagnosis.notes, id: \.self) { note in
                Text(LocalizedStringKey.alreadyLocalized(note))
                    .font(TypeScale.micro)
                    .foregroundStyle(Palette.inkFaint)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - 下一杯建议

    /// 「本次表现」是解释，「下一杯建议」是行动。
    ///
    /// 在刚记完一杯的页面上这一点尤其成立——用户下一步要做的事就写在这张卡里，
    /// 所以它比「本次表现」重一档：抬高的卡片、23pt 的标题行。仅此而已，
    /// 没有评分大卡、图表或动画。
    private func suggestionSection(_ suggestion: AdjustmentSuggestion) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "下一杯建议", detail: .alreadyLocalized("只改一件事"))
            Card(lifted: emphasizesSuggestion) {
                VStack(alignment: .leading, spacing: 13) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(LocalizedStringKey.alreadyLocalized(suggestion.headline))
                            .font(emphasizesSuggestion ? TypeScale.emphasis : TypeScale.cardTitle)
                            .foregroundStyle(Palette.roast)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }

                    Text(LocalizedStringKey.alreadyLocalized(suggestion.reason))
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkSoft)
                        .fixedSize(horizontal: false, vertical: true)

                    if let range = suggestion.referenceRange {
                        labelled("你的记录", [range])
                    }
                    if !suggestion.keep.isEmpty {
                        labelled(AdjustmentSuggestion.keepTitle, suggestion.keep)
                    }
                    labelled(AdjustmentSuggestion.observeTitle, suggestion.observe)

                    Text(LocalizedStringKey.alreadyLocalized(suggestion.expectedEffect))
                        .font(TypeScale.micro)
                        .foregroundStyle(Palette.inkFaint)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func labelled(_ title: String, _ lines: [String]) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(LocalizedStringKey.alreadyLocalized(title))
                .font(TypeScale.micro)
                .foregroundStyle(Palette.inkFaint)
                .tracking(0.6)
            FlowLayout(spacing: 6, lineSpacing: 6) {
                ForEach(lines, id: \.self) { line in
                    Chip(text: line, tint: Palette.inkSoft, background: Palette.well)
                }
            }
        }
    }

    // MARK: - 知识依据

    private var knowledgeSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "知识库怎么说")
            Card {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(diagnosis.knowledge) { item in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(LocalizedStringKey.alreadyLocalized(item.title))
                                .font(TypeScale.caption.weight(.medium))
                                .foregroundStyle(Palette.ink)
                                .fixedSize(horizontal: false, vertical: true)
                            Text(LocalizedStringKey.alreadyLocalized(item.body))
                                .font(TypeScale.caption)
                                .foregroundStyle(Palette.inkFaint)
                                .lineLimit(3)
                                .fixedSize(horizontal: false, vertical: true)
                            if !item.source.isEmpty {
                                Text(verbatim: item.source)
                                    .font(TypeScale.micro)
                                    .foregroundStyle(Palette.inkFaint)
                            }
                        }
                    }
                    Text("知识库说的是通常情况，你的记录说的是这包豆的实际情况；两者不一致时以你的记录为准。")
                        .font(TypeScale.micro)
                        .foregroundStyle(Palette.inkFaint)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

extension Insight.Confidence {
    /// 置信度在诊断卡上的说法。
    ///
    /// 不用百分比：那会假装有一个概率模型在后面。这里说的其实是「证据有多硬」。
    var diagnosticLabel: String {
        switch self {
        case .high: return L("证据较足")
        case .medium: return L("可以参考")
        case .low: return L("只是方向")
        case .insufficientEvidence: return L("证据不足")
        }
    }
}
