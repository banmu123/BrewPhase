import Foundation

/// 交给模型的上下文。
///
/// 它不是「一堆片段」，而是一份**分好组、编好号、算过预算**的简报。协议 §11 点名
/// 说这是本阶段最重要的组件，核心要求就一条：不要把 Top 10 直接塞进提示词。
///
/// 三类信息在这里的位置是固定的：用户自己的记录在前，BrewPhase 知识库在后，
/// 中间有明确的分隔。这个顺序和分组不是为了好看——协议 §6 要求在回答里能区分
/// 「用户的历史数据」和「知识库」，而模型能区分的前提是上下文里本来就分开写着。
struct BuiltContext: Equatable, Sendable {

    /// 一条证据 + 它在这次回答里的引用编号。
    struct Block: Identifiable, Equatable, Sendable {
        /// `[1]`、`[2]`… 从 1 开始，**在这次回答内稳定**。
        let citation: Int
        let passage: RetrievedPassage

        var id: Int { citation }
        var isFact: Bool { passage.origin == .structuredFact }
    }

    let question: String
    /// 问题里被认出来的关键词。抽取式回答用它挑出最该出现的那几句话。
    var terms: [String] = []
    var userBlocks: [Block] = []
    var knowledgeBlocks: [Block] = []
    /// 因为字符预算没能进来的条数。告诉用户「我只看了这些」比不说要好。
    var droppedForBudget: Int = 0
    var characterBudget: Int = 0
    var usedCharacters: Int = 0

    /// 已经渲染好的证据正文。渲染一次就够，模型和界面都用它。
    var rendered: String = ""

    var allBlocks: [Block] { userBlocks + knowledgeBlocks }
    var isEmpty: Bool { userBlocks.isEmpty && knowledgeBlocks.isEmpty }
    var hasUserData: Bool { !userBlocks.isEmpty }
    var hasKnowledge: Bool { !knowledgeBlocks.isEmpty }
    var hasFacts: Bool { userBlocks.contains(where: \.isFact) }
}
