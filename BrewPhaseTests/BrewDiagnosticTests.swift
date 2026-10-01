import XCTest
@testable import BrewPhase

/// 冲煮诊断的测试（规格 §二十八 的 3–9 项 + §二十九 的核心场景）。
///
/// 这一组全部用**值类型**构造输入：诊断层只认 `BrewObservation`，不认 `@Model`，
/// 所以规则可以在没有数据库的情况下逐条钉死——这也正是将来接导入数据时能直接
/// 复用同一批测试的原因。
@MainActor
final class BrewDiagnosticTests: XCTestCase {

    private let today = Date()

    override func setUpWithError() throws {
        // 这里有几处断言的期望值是中文文案（`L()` 的结果），所以语言要钉住，
        // 不能靠「别的测试类先跑、顺手把语言设成了中文」这种顺序上的巧合。
        LanguageManager.pinForTesting(.simplifiedChinese)
    }

    // MARK: - 夹具

    private func cup(
        daysAgo: Int,
        method: String = "V60",
        temp: Double = 92,
        dose: Double = 15,
        water: Double = 240,
        time: Int = 150,
        score: Int = 0,
        acidity: Int = 0,
        sweetness: Int = 0,
        bitterness: Int = 0,
        body: Int = 0,
        aftertaste: Int = 0,
        grind: String = "",
        notes: String = ""
    ) -> BrewObservation {
        BrewObservation(
            date: DateMath.add(days: -daysAgo, to: today),
            recipe: BrewRecipe(method: method, grinder: "司令官 C40", grindSize: grind,
                               waterTemp: temp, coffeeG: dose, waterG: water, timeSeconds: time),
            score: score,
            acidity: acidity,
            sweetness: sweetness,
            bitterness: bitterness,
            body: body,
            aftertaste: aftertaste,
            flavorTags: [],
            notes: notes
        )
    }

    /// 三次「你自己觉得好」的参考记录：91–92°C、15g/240g、2:28–2:35。
    private var goodHistory: [BrewObservation] {
        [
            cup(daysAgo: 12, temp: 91, time: 152, score: 5),
            cup(daysAgo: 8, temp: 92, time: 148, score: 4),
            cup(daysAgo: 4, temp: 91, time: 155, score: 5),
        ]
    }

    private func diagnose(
        _ current: BrewObservation,
        history: [BrewObservation]? = nil,
        all: [BrewObservation] = []
    ) -> BrewDiagnosis {
        BrewDiagnosticEngine.diagnose(
            current: current,
            beanHistory: history ?? goodHistory,
            allHistory: all,
            languageCode: "zh-Hans"
        )
    }

    // MARK: - 基线（规格 §28 第 3、4 项）

    func testSameBeanSameMethodBuildsItsOwnBaseline() {
        let baseline = PersonalBaselineBuilder.baseline(
            method: "V60",
            beanHistory: goodHistory,
            allHistory: goodHistory + [cup(daysAgo: 30, method: "爱乐压", score: 5)]
        )

        XCTAssertEqual(baseline.scope, .beanAndMethod("V60"))
        XCTAssertEqual(baseline.highRatedCount, 3)
        XCTAssertTrue(baseline.isUsable)
        XCTAssertEqual(baseline.range(of: .time)?.lowerBound, 148)
        XCTAssertEqual(baseline.range(of: .time)?.upperBound, 155)
        XCTAssertEqual(baseline.range(of: .temperature)?.lowerBound, 91)
        XCTAssertEqual(baseline.scope.label, "这包豆 + V60")
    }

    func testTheBaselineFallsBackFromBeanAndMethodToBeanToMethod() {
        // 这包豆 + V60 只有一次高分 → 退到「这包豆」层（含爱乐压那次）。
        let beanHistory = [
            cup(daysAgo: 3, temp: 92, time: 150, score: 5),
            cup(daysAgo: 6, method: "爱乐压", temp: 90, time: 90, score: 5),
            cup(daysAgo: 9, method: "爱乐压", temp: 90, time: 95, score: 4),
        ]
        let beanLevel = PersonalBaselineBuilder.baseline(
            method: "V60", beanHistory: beanHistory, allHistory: beanHistory
        )
        XCTAssertEqual(beanLevel.scope, .bean, "同豆同法不够就该退到「这包豆」")
        XCTAssertTrue(beanLevel.isUsable)

        // 这包豆只有一次 → 退到「同一冲法」（别的豆子的 V60 也算）。
        let thin = [cup(daysAgo: 3, temp: 92, time: 150, score: 5)]
        let others = [
            cup(daysAgo: 5, method: "V60", temp: 93, time: 160, score: 5),
            cup(daysAgo: 7, method: "V60", temp: 93, time: 158, score: 4),
            cup(daysAgo: 9, method: "V60", temp: 92, time: 162, score: 5),
        ]
        let methodLevel = PersonalBaselineBuilder.baseline(
            method: "V60", beanHistory: thin, allHistory: others
        )
        XCTAssertEqual(methodLevel.scope, .method("V60"))
        XCTAssertTrue(methodLevel.isUsable)
    }

    func testThePersonalBestThresholdIsStricterThanTheDiagnosticOne() {
        // 只有一次高分：诊断可以拿它当参考，但「个人最佳参数」那套（要 3 条）不认。
        let history = [cup(daysAgo: 3, temp: 91, time: 152, score: 5)]
        let baseline = PersonalBaselineBuilder.baseline(
            method: "V60",
            beanHistory: history,
            allHistory: history,
            requiredHighRated: IntelligenceConfig.diagnosticMinimumReferenceRecords
        )
        XCTAssertTrue(baseline.isUsable, "诊断只要一条参考记录")
        XCTAssertEqual(baseline.confidenceCeiling, .low, "但一条记录只能给最低置信度")

        let strict = PersonalBestAnalyzer.analyze(brews: [])
        XCTAssertFalse(strict.hasEnoughData)
        XCTAssertEqual(IntelligenceConfig.minimumSamplesForComparison, 3)
    }

    func testTooLittleDataNeverProducesAFakeBaseline() {
        let diagnosis = diagnose(cup(daysAgo: 0, time: 128, score: 3, acidity: 5, sweetness: 2), history: [])

        XCTAssertTrue(diagnosis.candidates.isEmpty, "没有任何参考记录就不许给结论")
        XCTAssertNil(diagnosis.suggestion)
        XCTAssertTrue(diagnosis.notes.contains(PersonalBaseline.keepRecordingAdvice))
        XCTAssertFalse(diagnosis.baseline.isUsable)
    }

    // MARK: - 核心场景（规格 §29）

    func testTheStaleCupReadsAsPossibleUnderExtraction() {
        // 本次：92°C / 15g / 240g / 2:08 / 3 分，酸 5、甜 2、苦 2、醇厚 2。
        let current = cup(daysAgo: 0, temp: 92, time: 128, score: 3,
                          acidity: 5, sweetness: 2, bitterness: 2, body: 2)

        let diagnosis = diagnose(current)

        let primary = diagnosis.primary
        XCTAssertEqual(primary?.finding, .suspectedUnderExtraction, diagnosis.candidates.map(\.id).description)
        XCTAssertEqual(primary?.confidence, .high, "三次参考记录 + 三个信号")
        XCTAssertNil(diagnosis.notes.first { $0.contains("萃取不足") }, "结论不该藏在 notes 里")

        // 证据必须是真实数字，且指向这杯与历史的差。
        let evidence = (primary?.evidence ?? []).joined(separator: " | ")
        XCTAssertTrue(evidence.contains("2:08"), evidence)
        XCTAssertTrue(evidence.contains("2:28") && evidence.contains("2:35"), evidence)
        XCTAssertTrue(evidence.contains("酸"), evidence)
        XCTAssertTrue(evidence.contains("甜"), evidence)

        // 建议：磨细一档，其余保持不变，下一杯看时间与甜感。
        let suggestion = diagnosis.suggestion
        XCTAssertEqual(suggestion?.parameter, .grind)
        XCTAssertEqual(suggestion?.direction, .finer)
        XCTAssertEqual(suggestion?.headline, "研磨度：细一档")
        XCTAssertTrue(suggestion?.keep.contains { $0.contains("92") } == true,
                      "水温柔要保持不变：\(suggestion?.keep ?? [])")
        XCTAssertTrue(suggestion?.keep.contains { $0.contains("粉量") } == true)
        XCTAssertTrue(suggestion?.keep.contains { $0.contains("240") } == true)
        XCTAssertTrue(suggestion?.observe.contains("总时间") == true)
        XCTAssertTrue(suggestion?.observe.contains("甜感") == true)
        XCTAssertTrue(suggestion?.referenceRange?.contains("2:28") == true,
                      suggestion?.referenceRange ?? "-")
    }

    func testAPleasantFastCupIsAdmittedInsteadOfInventingACause() {
        // 时间偏短但味觉什么都没填：不许说「萃取不足」，只说「偏快」。
        let current = cup(daysAgo: 0, temp: 92, time: 128, score: 3)

        let diagnosis = diagnose(current)

        XCTAssertEqual(diagnosis.primary?.finding, .fastFlow)
        XCTAssertEqual(diagnosis.primary?.confidence, .medium)
        XCTAssertTrue(diagnosis.notes.contains { $0.contains("没有填味觉细项") },
                      diagnosis.notes.description)
    }

    func testALongBitterDryCupReadsAsPossibleOverExtraction() {
        let current = cup(daysAgo: 0, temp: 92, time: 178, score: 2,
                          sweetness: 1, bitterness: 5, body: 4, notes: "尾段有点干涩")

        let diagnosis = diagnose(current)

        XCTAssertEqual(diagnosis.primary?.finding, .suspectedOverExtraction)
        XCTAssertEqual(diagnosis.primary?.confidence, .high)
        XCTAssertEqual(diagnosis.suggestion?.parameter, .grind)
        XCTAssertEqual(diagnosis.suggestion?.direction, .coarser)
        XCTAssertTrue(diagnosis.primary?.evidence.contains { $0.contains("干涩") } == true)
    }

    func testANormalTimeAndADryNoteDoNotBecomeOverExtraction() {
        // 干涩 + 苦高，但时间在个人区间里 → 不是过萃，最多是「苦味偏重」。
        let current = cup(daysAgo: 0, temp: 92, time: 150, score: 3, bitterness: 5, notes: "有点涩")

        let diagnosis = diagnose(current)

        XCTAssertEqual(diagnosis.primary?.finding, .highBitterness)
        XCTAssertNotEqual(diagnosis.primary?.finding, .suspectedOverExtraction,
                          "时间没偏就不该说过萃——那是把两件事硬拼在一起")
    }

    func testAParameterDriftIsFlaggedWithoutCallingItWrong() {
        // 94°C、时间正常 → 只报「参数偏离」，并且措辞是「偏离你的较好记录」。
        let current = cup(daysAgo: 0, temp: 94, time: 150, score: 3)

        let diagnosis = diagnose(current)

        XCTAssertEqual(diagnosis.primary?.finding, .parameterDeviation)
        XCTAssertEqual(diagnosis.primary?.finding.title, "参数偏离你的较好记录")
        XCTAssertEqual(diagnosis.suggestion?.parameter, .temperature)
        XCTAssertEqual(diagnosis.suggestion?.direction, .lower)
        XCTAssertTrue(diagnosis.suggestion?.referenceRange?.contains("91") == true,
                      diagnosis.suggestion?.referenceRange ?? "-")
        XCTAssertEqual(diagnosis.primary?.confidence, .medium)
    }

    // MARK: - 「一次只改一个」（规格 §28 第 8 项）

    func testTheSuggestionChangesExactlyOneKnobAndKeepsTheRest() {
        let current = cup(daysAgo: 0, temp: 94, time: 128, score: 2,
                          acidity: 5, sweetness: 2, bitterness: 4, body: 2, grind: "22 格")

        let diagnosis = diagnose(current)
        let suggestion = try? XCTUnwrap(diagnosis.suggestion)
        let parameter = try? XCTUnwrap(suggestion?.parameter)

        XCTAssertNotNil(parameter)
        XCTAssertFalse(suggestion?.keep.contains { $0.hasPrefix(parameter?.label ?? "") } == true,
                       "要改的那个旋钮不该同时出现在「保持不变」里：\(suggestion?.keep ?? [])")
        XCTAssertFalse(suggestion?.keep.contains { $0.contains("2:08") } == true,
                       "时间不是能设定的东西，它属于「下一杯留意」，不属于「保持不变」")
        XCTAssertTrue(suggestion?.observe.isEmpty == false)
    }

    // MARK: - 写进回答正文的排版

    func testTheMarkupIsLayeredRatherThanAFlatList() {
        let current = cup(daysAgo: 0, temp: 92, time: 128, score: 3,
                          acidity: 5, sweetness: 2, body: 2)

        let blocks = AnswerMarkup.parse(diagnose(current).markup)
        let kinds = blocks.map(\.kind)
        let headings = blocks.filter { $0.kind == .heading }.map(\.runs)

        XCTAssertEqual(kinds.first, .callout, "结论是一段话里最该被看见的那句")
        XCTAssertTrue(headings.contains([.text("看出来的问题")]), headings.description)
        XCTAssertTrue(headings.contains([.text("下一杯建议")]), headings.description)
        XCTAssertGreaterThanOrEqual(kinds.filter { $0 == .callout }.count, 2, "结论与建议各是一个重点块")
        XCTAssertTrue(kinds.contains(.bullet), "证据与「保持不变」都是条目")
        XCTAssertTrue(
            blocks.contains { $0.kind == .bullet && $0.runs.first == .strong(AdjustmentSuggestion.keepTitle) },
            "「保持不变」那一条要带加粗标签：\(blocks.map(\.runs).description)"
        )
        // 引用编号由回答层加：事实本身不知道自己会被编成几号。
        XCTAssertFalse(diagnose(current).markup.contains("[1]"))
    }

    func testTheMarkupNamesAThinBasisInsteadOfHidingIt() {
        let diagnosis = diagnose(
            cup(daysAgo: 0, temp: 92, time: 128, score: 3, acidity: 5, sweetness: 2),
            history: [cup(daysAgo: 3, temp: 91, time: 152, score: 5)]
        )

        XCTAssertEqual(diagnosis.primary?.confidence, .low)
        XCTAssertTrue(diagnosis.markup.contains("依据："),
                      "只有一条参考记录时更要把依据写出来：\n\(diagnosis.markup)")
        XCTAssertTrue(diagnosis.markup.contains("1 次"), diagnosis.markup)
    }

    func testTheMarkupClaimsNoBasisWhenThereIsNone() {
        let diagnosis = diagnose(cup(daysAgo: 0, temp: 92, time: 128, score: 3), history: [])

        XCTAssertFalse(diagnosis.markup.contains("依据："),
                       "一条参考记录都没有时不该写「依据：…」：\n\(diagnosis.markup)")
        XCTAssertTrue(diagnosis.markup.contains("还差"), diagnosis.markup)
    }

    // MARK: - 英文界面上不能出现中文句读

    func testSentenceAndListPunctuationAreTranslated() {
        LanguageManager.pinForTesting(.english)
        defer { LanguageManager.pinForTesting(.simplifiedChinese) }

        // 这些键里没有汉字，收集器是靠「出现在 L(...) 里」认出它们的；一旦这条
        // 规则失效，英文界面会读成「Washed，Light。」和「Water 92°C、Coffee 18g」。
        XCTAssertEqual(L("、"), ", ")
        XCTAssertEqual(L("，"), ", ")
        XCTAssertEqual(L("。"), ". ")
        XCTAssertEqual(L("；"), "; ")
        XCTAssertEqual(L("（%@）", "4/5"), " (4/5)")
        XCTAssertEqual(L("%@：%@", "Grind", "finer"), "Grind: finer")
    }

    func testTheSuggestionKeepsItsPunctuationInTheInterfaceLanguage() {
        LanguageManager.pinForTesting(.english)
        defer { LanguageManager.pinForTesting(.simplifiedChinese) }

        let diagnosis = diagnose(cup(daysAgo: 0, temp: 92, time: 128, score: 3, acidity: 5, sweetness: 2))
        let keepLine = diagnosis.markup
            .split(separator: "\n")
            .first { $0.contains(AdjustmentSuggestion.keepTitle) }
            .map(String.init)
        let line = try? XCTUnwrap(keepLine)

        XCTAssertNotNil(keepLine, diagnosis.markup)
        XCTAssertFalse(line?.contains("、") == true, line ?? "")
        XCTAssertFalse(line?.contains("：") == true, line ?? "")
        XCTAssertTrue(line?.contains(", ") == true, line ?? "")
    }

    func testEmptyAxesNeverProduceAStrongConclusion() {
        let current = cup(daysAgo: 0, temp: 92, time: 128, score: 3)

        let diagnosis = diagnose(current)

        XCTAssertTrue(diagnosis.candidates.allSatisfy { $0.confidence != .high },
                      "没有味觉证据时不许出现高置信结论：\(diagnosis.candidates.map { "\($0.id):\($0.confidence)" })")
    }

    func testOneReferenceRecordCapsTheConfidence() {
        let history = [cup(daysAgo: 3, temp: 91, time: 152, score: 5)]
        let current = cup(daysAgo: 0, temp: 92, time: 128, score: 3, acidity: 5, sweetness: 2)

        let diagnosis = diagnose(current, history: history)

        XCTAssertEqual(diagnosis.primary?.finding, .suspectedUnderExtraction)
        XCTAssertEqual(diagnosis.primary?.confidence, .low, "只有一条参考记录时，方向性结论只能是低置信")
        XCTAssertTrue(diagnosis.notes.contains { $0.contains("还只有 1 次") }, diagnosis.notes.description)
    }

    // MARK: - 正常的一杯

    func testAGoodCupGetsNoSuggestion() {
        let current = cup(daysAgo: 0, temp: 92, time: 152, score: 5,
                          acidity: 3, sweetness: 4, bitterness: 2, body: 4)

        let diagnosis = diagnose(current)

        XCTAssertTrue(diagnosis.candidates.isEmpty, diagnosis.candidates.map(\.id).description)
        XCTAssertNil(diagnosis.suggestion, "没有可说的就不说，这比硬凑一条建议强")
        XCTAssertTrue(diagnosis.notes.contains { $0.contains("没有明显异常") })
        XCTAssertTrue(diagnosis.baseline.isUsable)
    }

    // MARK: - 知识依据（规格 §十九）

    func testTheDiagnosisCarriesKnowledgeWithoutLettingItDecide() {
        let current = cup(daysAgo: 0, temp: 92, time: 128, score: 3,
                          acidity: 5, sweetness: 2, body: 2)

        let diagnosis = diagnose(current)

        // 知识只补充说法，判断仍然由规则给出——所以即使知识库没命中，
        // 结论与建议也不会变（这条断言守的就是这个顺序）。
        XCTAssertEqual(diagnosis.primary?.finding, .suspectedUnderExtraction)
        for item in diagnosis.knowledge {
            XCTAssertFalse(item.title.isEmpty)
            XCTAssertFalse(item.body.isEmpty)
        }
        // 配额是「一篇对症 + 一篇这杯用的冲法」：知识库里没有通用萃取条目，
        // 症状查到的常是别的冲法，配一篇 V60 自己的条目才拿得到能上手的东西。
        XCTAssertLessThanOrEqual(diagnosis.knowledge.count, 2)
        XCTAssertTrue(diagnosis.knowledge.contains { $0.title.contains("V60") },
                      diagnosis.knowledge.map(\.title).description)
    }
}
