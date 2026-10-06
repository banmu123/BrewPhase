import SwiftData
import SwiftUI

/// 问一问：统一提问入口——「我有问题，我主动问。」
///
/// 界面上只有三样东西：一句「问问你的咖啡」、输入框、和回答。内部依旧调用
/// 结构化查询、诊断、推荐、语义检索与本地知识库，但那是引擎的事，用户看见的
/// 只有回答与它的依据（引用列表）——embedding、provider、engine 这类词不上台面。
/// 回答的可信度依然建立在「你能看见它凭什么这么说」之上：依据收在回答卡里，
/// 而不是把内部模块的名字摆出来。
struct AskView: View {

    /// 从某包豆子的页面进来时带上它，「这包豆…」就不必念名字。
    var focusBean: Bean?

    @Environment(\.modelContext) private var context
    @Query(sort: \Bean.createdAt, order: .reverse) private var beans: [Bean]
    @Query(sort: \Brew.date, order: .reverse) private var brews: [Brew]
    @Query(sort: \Tasting.date, order: .reverse) private var tastings: [Tasting]
    @Query private var rules: [PhaseRule]

    @State private var question = ""
    @State private var exchanges: [Exchange] = []
    /// 多轮对话的语义状态（规格 §七）。
    ///
    /// 它和 `exchanges` 是两件事，刻意分开：`exchanges` 只负责「界面上显示过什么」，
    /// 这里只负责「下一轮该继承什么」。把两者合成一个会立刻出问题——用户翻回上一轮
    /// 看的时候，展示历史就成了检索上下文。
    ///
    /// 不持久化（规格 §二十四）：退出这个页面就没了，重进是新会话。因此不新增
    /// SwiftData 模型、不落盘聊天记录。
    @State private var conversation = ConversationContext.empty
    @State private var isAsking = false
    /// 调试入口留下的追问队列（`-BrewPhaseAskMore`）。正常使用里始终为空。
    @State private var pendingDebugQuestions: [String] = []
    @State private var engine: AskEngine?
    @FocusState private var isFocused: Bool

    private var settings: RAGSettings { RAGSettings.current() }
    private var book: PhaseRuleBook { PhaseRuleBook.make(stored: rules) }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    intro
                    if exchanges.isEmpty {
                        suggestions
                    } else {
                        ForEach(exchanges) { exchange in
                            exchangeView(exchange).id(exchange.id)
                        }
                    }
                    Color.clear.frame(height: 1).id(ScrollAnchor.bottom)
                }
                .padding(.horizontal, Metric.gutter)
                .padding(.top, 12)
                .padding(.bottom, 24)
            }
            .background(Palette.paper)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: exchanges.count) {
                guard let last = exchanges.last else { return }
                withAnimation(Motion.settle) { proxy.scrollTo(last.id, anchor: .top) }
            }
            .onChange(of: isAsking) {
                guard isAsking else { return }
                withAnimation(Motion.settle) { proxy.scrollTo(ScrollAnchor.bottom, anchor: .bottom) }
            }
            // 答案到达时再滚一次，滚到这一轮的**顶部**。
            //
            // 只按「问题已发出」那一刻滚到底是不够的：回答比等待指示器高得多，落到底部
            // 会让用户停在回答中段，得自己往回拨。多轮对话里一屏里同时有几轮的时候，
            // 这一点直接决定「上一轮说了什么」还看得到看不到。
            .onChange(of: exchanges.last?.answer?.id) {
                guard let last = exchanges.last, last.answer != nil else { return }
                withAnimation(Motion.settle) { proxy.scrollTo(last.id, anchor: .top) }
            }
        }
        .safeAreaInset(edge: .bottom) { composer }
        .navigationTitle("问一问")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            prepareEngineIfNeeded()
            // 只有从 `Tools/run.sh --ask "…"` 启动时才有值，正常使用里是 nil。
            pendingDebugQuestions = DebugLaunch.askFollowUps
            if let seeded = DebugLaunch.askQuestion, exchanges.isEmpty {
                submit(seeded)
            }
        }
    }

    // MARK: - 顶部说明

    private var intro: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(focusBean.map { LocalizedStringKey.alreadyLocalized(L("正在问「%@」", $0.displayName)) }
                 ?? LocalizedStringKey("问问你的咖啡"))
                .font(TypeScale.title)
                .foregroundStyle(Palette.ink)

            Text("回答只用这台设备上的记录和 BrewPhase 自带的知识条目。不联网，不上传，也没有账号。")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.bottom, 2)
    }

    private var suggestions: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "可以这样问")
            FlowLayout(spacing: 8) {
                ForEach(suggestionTexts, id: \.self) { text in
                    Button {
                        submit(text)
                    } label: {
                        Text(LocalizedStringKey.alreadyLocalized(text))
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.roast)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(Capsule(style: .continuous).fill(Palette.cream.opacity(0.6)))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    /// 推荐问题只留最常用的四条（规格：不要堆太多）。从豆子页进来时第一条
    /// 直接问那包豆，不用用户念名字。
    private var suggestionTexts: [String] {
        if let focusBean {
            return [
                L("「%@」现在是什么阶段？", focusBean.displayName),
                L("下一杯怎么调？"),
                L("上一杯为什么酸？"),
                L("最近哪杯最好？"),
            ]
        }
        return [
            L("今天喝哪包？"),
            L("下一杯怎么调？"),
            L("最近哪杯最好？"),
            L("我最近的参数有什么变化？"),
        ]
    }

    // MARK: - 一轮问答

    private func exchangeView(_ exchange: Exchange) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Spacer(minLength: 40)
                Text(LocalizedStringKey.alreadyLocalized(exchange.question))
                    .font(TypeScale.body)
                    .foregroundStyle(Palette.card)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(Palette.espresso)
                    )
            }

            if let answer = exchange.answer {
                answerCard(answer)
            } else {
                thinking
            }
        }
    }

    private var thinking: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text("正在翻你的记录…")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkSoft)
        }
        .padding(.leading, 4)
    }

    private func answerCard(_ answer: AskAnswer) -> some View {
        Card {
            VStack(alignment: .leading, spacing: 14) {
                // 回答正文由 `AnswerBody` 排版：小节标题、条目、重点块各有各的字号
                // 与留白。之前是一整段等重的文字，十几行平铺下来读者找不到重点。
                AnswerBody(text: answer.text)

                if answer.hasEvidence {
                    Divider().overlay(Palette.hairline)
                    citationList(answer)
                }

                footnotes(answer)
            }
        }
    }

    private func citationList(_ answer: AskAnswer) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if !answer.context.userBlocks.isEmpty {
                citationGroup(title: "来自你的记录", blocks: answer.context.userBlocks)
            }
            if !answer.context.knowledgeBlocks.isEmpty {
                citationGroup(title: "来自 BrewPhase 知识库", blocks: answer.context.knowledgeBlocks)
            }
        }
    }

    private func citationGroup(title: LocalizedStringKey, blocks: [BuiltContext.Block]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(TypeScale.micro)
                .foregroundStyle(Palette.inkSoft)
                .tracking(0.6)

            ForEach(blocks) { block in
                HStack(alignment: .top, spacing: 7) {
                    Text("[\(block.citation)]")
                        .font(TypeScale.micro.monospacedDigit())
                        .foregroundStyle(Palette.latte)
                        .padding(.top, 1)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(LocalizedStringKey.alreadyLocalized(block.passage.title))
                            .font(TypeScale.caption.weight(.medium))
                            .foregroundStyle(Palette.ink)
                        Text(LocalizedStringKey.alreadyLocalized(AnswerMarkup.plain(block.passage.content)))
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.inkFaint)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                }
            }
        }
    }

    private func footnotes(_ answer: AskAnswer) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let failure = answer.failureNote {
                Text(LocalizedStringKey.alreadyLocalized(failure))
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.priority)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let summary = answer.plan.summary {
                Text(LocalizedStringKey.alreadyLocalized(summary))
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(answer.notes, id: \.self) { note in
                Text(LocalizedStringKey.alreadyLocalized(note))
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - 输入

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            // 「正在讨论」：把这一轮真正继承到的东西摆在明面上（规格 §四十二）。
            //
            // 放在输入框正上方而不是页面顶部，是因为顶部会随对话滚走：多轮对话最容易
            // 出的问题是「它悄悄换了对象」——用户以为在聊这包豆，系统已经在聊另一包。
            // 这一行常驻在用户视线落点上，跑偏随时看得见，也解释了回答为什么是这样。
            if let label = discussionLabel {
                HStack(spacing: 6) {
                    Image(systemName: "bubble.left.and.bubble.right.fill")
                        .font(.system(size: 10))
                    Text(L("正在讨论：%@", label))
                        .font(TypeScale.micro)
                        .lineLimit(1)
                }
                .foregroundStyle(Palette.roast)
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .background(Capsule(style: .continuous).fill(Palette.cream.opacity(0.55)))
                .accessibilityLabel(L("正在讨论：%@", label))
            }

            HStack(spacing: 10) {
                TextField("问点关于你的豆子的事…", text: $question, axis: .vertical)
                    .font(TypeScale.body)
                    .lineLimit(1...4)
                    .focused($isFocused)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(
                        RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Palette.well)
                    )
                    .submitLabel(.send)
                    .onSubmit { submit(question) }

                Button {
                    submit(question)
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Palette.card)
                        .frame(width: 36, height: 36)
                        .background(Circle().fill(canSend ? Palette.roast : Palette.inkFaint))
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
            }
        }
        .padding(.horizontal, Metric.gutter)
        .padding(.top, 10)
        .padding(.bottom, 10)
        .background(.ultraThinMaterial)
    }

    /// 当前上下文的一句话（「Ethiopia Guji · V60 · 水温」）。空会话时为 nil。
    private var discussionLabel: String? {
        conversation.discussionLabel(languageCode: LanguageManager.shared.current.resolvedCode)
    }

    private var canSend: Bool {
        !isAsking && !question.trimmed.isEmpty
    }

    // MARK: - 动作

    private func prepareEngineIfNeeded() {
        if engine == nil { engine = AskEngine(context: context) }
    }

    private func submit(_ text: String) {
        let trimmed = text.trimmed
        guard !trimmed.isEmpty, !isAsking else { return }

        prepareEngineIfNeeded()
        guard let engine else { return }

        let exchange = Exchange(question: trimmed)
        exchanges.append(exchange)
        question = ""
        isAsking = true
        isFocused = false

        let settings = self.settings
        let book = self.book
        let beans = self.beans
        let brews = self.brews
        let tastings = self.tastings
        let languageCode = LanguageManager.shared.current.resolvedCode
        let focusID = focusBean?.id
        // 上一轮的语义状态。视图只做搬运，解析与继承都在引擎那一侧（规格 §二十八）。
        let previousConversation = conversation

        Task {
            let answer = await engine.ask(
                trimmed,
                focusBeanID: focusID,
                conversation: previousConversation,
                beans: beans,
                brews: brews,
                tastings: tastings,
                book: book,
                settings: settings,
                languageCode: languageCode
            )
            if let index = exchanges.firstIndex(where: { $0.id == exchange.id }) {
                exchanges[index].answer = answer
            }
            // 状态推进只发生在成功拿到答案之后：这一轮的解析结果由引擎算好，
            // 视图负责写回，下一轮就能接着聊。
            conversation = answer.conversationUpdate
            isAsking = false

            // 调试入口预置的追问：一条条问下去，每条都真的等上一条结束——
            // 截图里看到的因此是一条真实的多轮对话，而不是摆出来的样子。
            // 中间留一点停顿：人不会在同一帧里连发三句，而 SwiftUI 的滚动动画需要
            // 一帧才能落位，抢在同一帧里连发会让截图停在中途。
            if let next = pendingDebugQuestions.first {
                pendingDebugQuestions.removeFirst()
                try? await Task.sleep(nanoseconds: 700_000_000)
                submit(next)
            }
        }
    }

    private struct Exchange: Identifiable {
        let id = UUID()
        let question: String
        var answer: AskAnswer?
    }

    private enum ScrollAnchor { case bottom }
}
