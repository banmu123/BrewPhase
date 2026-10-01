import XCTest
@testable import BrewPhase

/// 回答排版的测试。
///
/// 这一层收的是抽取式回答生成的正文，出的是界面按它分层的块。两件事必须钉死：
/// **层次认得出来**（否则又回到一屏等重的字），以及**不会凭空造出一个出处**
/// （用户自己的记录、豆名、笔记都会流进这段正文，句中的方括号不能被当成引用）。
@MainActor
final class AnswerMarkupTests: XCTestCase {

    private let today = Date()

    override func setUpWithError() throws {
        // 断言里有中文文案（那是 L() 的结果），所以语言必须钉住：这台机器上跑过一次
        // 英文界面之后，App 的偏好会留在 en 上，测试就会拿到英文标题。
        LanguageManager.pinForTesting(.simplifiedChinese)
    }

    private func passage(
        id: String,
        sourceType: KnowledgeSourceType,
        title: String,
        content: String,
        origin: RetrievedPassage.Origin = .indexedDocument,
        relevance: Double = 0.8
    ) -> RetrievedPassage {
        RetrievedPassage(
            id: id, origin: origin, sourceType: sourceType, title: title, content: content,
            metadata: DocumentMetadata(), relevance: relevance, similarity: nil, updatedAt: today
        )
    }

    // MARK: - 块

    func testTheLinePrefixDecidesTheBlockKind() {
        let blocks = AnswerMarkup.parse("""
        # 看出来的问题
        - 本次 2:08，快了 20 秒
        ! 最近这一杯更接近「可能萃取不足」
        ~ 依据：3 次高评分记录
        普通的一段话
        """)

        XCTAssertEqual(blocks.map(\.kind), [.heading, .bullet, .callout, .note, .paragraph])
        XCTAssertEqual(blocks.compactMap { $0.runs.first },
                       [.text("看出来的问题"), .text("本次 2:08，快了 20 秒"),
                        .text("最近这一杯更接近「可能萃取不足」"),
                        .text("依据：3 次高评分记录"), .text("普通的一段话")])
    }

    func testBlankLinesAreDropped() {
        XCTAssertTrue(AnswerMarkup.parse("\n\n   \n").isEmpty, "空行不该占一个块")
        XCTAssertEqual(AnswerMarkup.parse("- 条目\n\n# 标题").map(\.kind), [.bullet, .heading])
    }

    func testABoldRunIsRecognisedInsideALine() {
        let block = AnswerMarkup.parse("- **保持不变**：水温 92°C").first

        XCTAssertEqual(block?.kind, .bullet)
        XCTAssertEqual(block?.runs, [.strong("保持不变"), .text("：水温 92°C")])
    }

    // MARK: - 引用只认行尾（不能凭空造出处）

    func testATrailingBracketBecomesACitation() {
        let block = AnswerMarkup.parse("- 本次 2:08 [1]").first

        XCTAssertEqual(block?.runs, [.text("本次 2:08"), .citation("1")])
    }

    func testABracketInsideASentenceIsNotACitation() {
        // 「我加了 [2] 克粉」——用户自己的话里出现方括号，不是一条出处。
        let block = AnswerMarkup.parse("- 我加了 [2] 克粉，尾段还是薄").first

        XCTAssertFalse(block?.runs.contains(.citation("2")) == true,
                       "句中的方括号被当成引用，会凭空多出一个来源")
        XCTAssertEqual(block?.runs, [.text("我加了 [2] 克粉，尾段还是薄")])
    }

    func testABracketWithoutASpaceBeforeItStaysPlainText() {
        // 生成正文时角标前面一定有一个空格；没有空格说明这是用户自己打的括号。
        let block = AnswerMarkup.parse("- 上次那份[2]的配方").first

        XCTAssertFalse(block?.runs.contains(.citation("2")) == true)
    }

    func testAMarkerIsRecognisedByPrefixOnly() {
        XCTAssertTrue(AnswerMarkup.isMarked("# 标题"))
        XCTAssertTrue(AnswerMarkup.isMarked("- 条目"))
        XCTAssertTrue(AnswerMarkup.isMarked("! 重点"))
        XCTAssertTrue(AnswerMarkup.isMarked("~ 脚注"))
        XCTAssertFalse(AnswerMarkup.isMarked("本次 2:08，快了 20 秒"))
    }

    func testALeadInLineEndingWithAColonBecomesASectionLabel() {
        // 结构化事实里最常见的写法：「最近的 3 次冲煮参数：」后面跟三条。
        // 它是引出语，不该和下面那几条一起当子弹。
        let blocks = AnswerMarkup.parse("最近的 3 次冲煮参数（从新到旧）：\n- 10月1日 · V60")

        XCTAssertEqual(blocks.first?.kind, .heading)
        XCTAssertEqual(blocks.first?.runs, [.text("最近的 3 次冲煮参数（从新到旧）")],
                       "冒号本身不进标题")
        XCTAssertEqual(blocks.last?.kind, .bullet)
    }

    func testALeadInThatAlreadyCarriesACitationIsStillASectionLabel() {
        let blocks = AnswerMarkup.parse("最近的 3 次冲煮参数： [1]\n- 10月1日 · V60")

        XCTAssertEqual(blocks.first?.kind, .heading)
        XCTAssertEqual(blocks.first?.runs, [.text("最近的 3 次冲煮参数"), .citation("1")])
    }

    func testAnEnglishLeadInEndingWithAColonIsAlsoASectionLabel() {
        XCTAssertEqual(AnswerMarkup.parse("Your last three brews:").first?.kind, .heading)
    }

    func testPlainTextDropsTheMarkupAndTheCitationNumbers() {
        let plain = AnswerMarkup.plain("""
        ! **可能萃取不足**（证据较足） [1]

        # 下一杯建议
        - 磨细一档
        """)

        XCTAssertEqual(plain, "可能萃取不足（证据较足） 下一杯建议 磨细一档")
    }

    // MARK: - 回答层怎么用它

    func testAStructuredFactKeepsItsLayoutAndIsCitedOnce() async throws {
        let markup = """
        ! 最近这一杯更接近「可能萃取不足」（证据较足）。
        # 看出来的问题
        - 本次 2:08，你的较好记录在 2:28–2:35
        - 这杯的甜是 2/5
        """
        let context = ContextBuilder.build(question: "为什么这杯不好喝？", passages: [
            passage(id: "fact:diagnosis:1", sourceType: .brew, title: "「Ethiopia Guji」最近这杯的分析",
                    content: markup, origin: .structuredFact, relevance: 1)
        ])

        let text = try await ExtractiveLLMProvider().generate(prompt: "", context: context)
        let blocks = AnswerMarkup.parse(text)

        XCTAssertEqual(blocks.map(\.kind), [.callout, .heading, .bullet, .bullet])
        XCTAssertEqual(blocks.first?.runs.last, .citation("1"), "结论那一行挂着出处")
        XCTAssertFalse(blocks.last?.runs.contains(.citation("1")) == true,
                       "同一条事实的多行证据不该每行都挂一遍引用——那是零信息量的重复")
    }

    func testPlainRecordsBecomeBulletsUnderAHeadingWithTheirOwnCitations() async throws {
        let context = ContextBuilder.build(question: "我最近怎么冲的？", passages: [
            passage(id: "b1", sourceType: .brew, title: "9月27日", content: "V60 · 18g/300g · 92°C。甜感明显。"),
            passage(id: "b2", sourceType: .brew, title: "9月25日", content: "V60 · 18g/300g · 91°C。酸质干净。", relevance: 0.7),
        ])

        let text = try await ExtractiveLLMProvider().generate(prompt: "", context: context)
        let blocks = AnswerMarkup.parse(text)

        XCTAssertEqual(blocks.first?.kind, .heading)
        XCTAssertEqual(blocks.first?.runs, [.text("你的记录")])
        XCTAssertEqual(blocks[1].kind, .bullet)
        XCTAssertEqual(blocks[1].runs.first, .strong("9月27日"), "记录标题加粗在前")
        XCTAssertEqual(blocks[1].runs.last, .citation("1"))
        XCTAssertEqual(blocks[2].runs.last, .citation("2"), "两条记录各有各的编号")
    }

    func testAKnowledgeOnlyAnswerSaysSoInACallout() async throws {
        let context = ContextBuilder.build(question: "水硬怎么办？", passages: [
            passage(id: "k1", sourceType: .knowledge, title: "水", content: "硬度会影响萃取。")
        ])

        let text = try await ExtractiveLLMProvider().generate(prompt: "", context: context)
        let blocks = AnswerMarkup.parse(text)

        XCTAssertEqual(blocks.first?.kind, .heading)
        XCTAssertEqual(blocks.last?.kind, .callout, "「这不是你的经历」要看得见，不能混在正文里")
        XCTAssertTrue(text.contains("不代表你的实际情况"), text)
    }

    func testAnAnswerWithNothingFoundIsStillOneParagraph() async throws {
        let context = ContextBuilder.build(question: "问我一个没有答案的问题", passages: [])

        let text = try await ExtractiveLLMProvider().generate(prompt: "", context: context)

        XCTAssertEqual(AnswerMarkup.parse(text).map(\.kind), [.paragraph])
    }

    // MARK: - 断句（英文正文不能被整篇贴上来）

    func testEnglishSentencesAreSplitOnLatinStops() {
        let content = "Grind size sets the resistance. A finer grind slows the flow. It also raises extraction."

        XCTAssertEqual(ExtractiveLLMProvider.split(content),
                       ["Grind size sets the resistance.", " A finer grind slows the flow.",
                        " It also raises extraction."])
        XCTAssertEqual(ExtractiveLLMProvider.bestSentences(in: content, terms: ["extraction"], count: 1),
                       "It also raises extraction.")
    }

    func testAnAbbreviationDoesNotEndASentence() {
        // 「e.g.」后面的句号不是句末——从这里劈开，摘录会断在半句话上。
        let content = "Use a finer grind, e.g. two clicks. It raises extraction."

        XCTAssertEqual(ExtractiveLLMProvider.split(content).count, 2, content)
    }

    func testADecimalPointDoesNotEndASentence() {
        XCTAssertEqual(ExtractiveLLMProvider.split("A ratio of 1:16.5 works well.").count, 1)
    }

    func testALineBreakIsNormalisedToOneSentenceStop() {
        XCTAssertEqual(ExtractiveLLMProvider.split("用 V60 冲的。\n18g 粉"),
                       ["用 V60 冲的。", "18g 粉"], "换行不该再补一个句号，读成「V60。。」")
        XCTAssertEqual(ExtractiveLLMProvider.split("用 V60 冲的\n18g 粉"),
                       ["用 V60 冲的。", "18g 粉"], "中文行尾没有标点时才补句号")
        XCTAssertEqual(ExtractiveLLMProvider.split("Brewed with a V60.\n18g coffee."),
                       ["Brewed with a V60.", " 18g coffee."], "英文句号后面要留空格，否则两个词会粘在一起")
    }

    func testAnEnglishDocumentIsNoLongerPastedWhole() {        let sentences = (1...6).map { "Sentence number \($0) mentions extraction and grind." }
        let content = sentences.joined(separator: " ")

        let picked = ExtractiveLLMProvider.bestSentences(in: content, terms: ["extraction"], count: 2)

        XCTAssertEqual(ExtractiveLLMProvider.split(content).count, 6)
        XCTAssertLessThan(picked.count, content.count / 2,
                          "整篇贴上来正是英文回答长得离谱的原因：\(picked)")
    }

    func testAnEnglishBulletDoesNotDoubleSpaceAfterItsLabel() async throws {
        LanguageManager.pinForTesting(.english)
        defer { LanguageManager.pinForTesting(.simplifiedChinese) }

        let context = ContextBuilder.build(question: "q", passages: [
            passage(id: "k1", sourceType: .knowledge, title: "Grinding",
                    content: "Grind size sets the resistance. It is the most direct lever.")
        ])

        let text = try await ExtractiveLLMProvider().generate(prompt: "", context: context)

        XCTAssertFalse(text.contains(":  "), "冒号后多出一个空格：\n\(text)")
        XCTAssertTrue(text.contains("**Grinding** · Grind size"), text)
        XCTAssertFalse(text.contains("："), "英文界面不该露出中文的全角冒号：\n\(text)")
    }
}
