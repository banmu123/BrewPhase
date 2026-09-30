import SwiftData
import SwiftUI

/// 问一问：向 BrewPhase 提问，回答只依据本机数据与自带知识库。
///
/// 界面刻意把三件事摆在明面上，而不是只给一段话：
/// 1. **这次是谁生成的**——本地摘要、系统端侧模型，还是 Ollama；
/// 2. **依据了哪几条**——带编号的引用列表，分「你的记录」和「知识库」两段；
/// 3. **检索范围是什么**——分析器认出来的意图与条数。
///
/// 为什么值得占这么多位置：这个功能的可信度完全建立在「你能看见它凭什么这么说」
/// 之上。一段没有出处的回答，看起来再通顺也不能用来判断自己那包豆子该不该喝。
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
    @State private var isAsking = false
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
        }
        .safeAreaInset(edge: .bottom) { composer }
        .navigationTitle("问一问")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            prepareEngineIfNeeded()
            // 只有从 `Tools/run.sh --ask "…"` 启动时才有值，正常使用里是 nil。
            if let seeded = DebugLaunch.askQuestion, exchanges.isEmpty {
                submit(seeded)
            }
        }
    }

    // MARK: - 顶部说明

    private var intro: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(focusBean.map { LocalizedStringKey.alreadyLocalized(L("正在问「%@」", $0.displayName)) }
                 ?? LocalizedStringKey("问一问"))
                .font(TypeScale.title)
                .foregroundStyle(Palette.ink)

            Text("回答只用这台设备上的记录和 BrewPhase 自带的知识条目。不联网，不上传，也没有账号。")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkSoft)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 6) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 10))
                Text(L("本次回答引擎：%@", settings.preferredEngine.label))
                    .font(TypeScale.micro)
            }
            .foregroundStyle(Palette.inkFaint)
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

    private var suggestionTexts: [String] {
        if let focusBean {
            return [
                L("「%@」现在适合喝吗？", focusBean.displayName),
                L("「%@」我最近三次怎么冲的？", focusBean.displayName),
                L("「%@」我打过分吗？", focusBean.displayName),
            ]
        }
        return [
            L("我最近三次怎么冲的？"),
            L("我今天还有哪些豆子？"),
            L("V60 一般用多少水温？"),
            L("我有没有遇到过类似的干涩？"),
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
            VStack(alignment: .leading, spacing: 12) {
                Text(LocalizedStringKey.alreadyLocalized(answer.text))
                    .font(TypeScale.body)
                    .foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)

                engineLine(answer)

                if answer.hasEvidence {
                    Divider().overlay(Palette.hairline)
                    citationList(answer)
                }

                footnotes(answer)
            }
        }
    }

    private func engineLine(_ answer: AskAnswer) -> some View {
        HStack(spacing: 8) {
            Label {
                Text(LocalizedStringKey.alreadyLocalized(L("%@ 生成", answer.engine.label)))
            } icon: {
                Image(systemName: answer.engine == .onDeviceSummary ? "text.magnifyingglass" : "sparkles")
            }
            .font(TypeScale.micro)
            .foregroundStyle(Palette.inkFaint)

            if answer.usedFallback {
                Text("已降级")
                    .font(TypeScale.micro)
                    .foregroundStyle(Palette.priority)
            }
            Spacer(minLength: 0)
            Text(L("耗 %@ 秒", Fmt.number(answer.elapsed.tidy)))
                .font(TypeScale.micro)
                .foregroundStyle(Palette.inkFaint)
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
                        Text(LocalizedStringKey.alreadyLocalized(block.passage.content.replacingOccurrences(of: "\n", with: " ")))
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
        .padding(.horizontal, Metric.gutter)
        .padding(.top, 10)
        .padding(.bottom, 10)
        .background(.ultraThinMaterial)
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

        Task {
            let answer = await engine.ask(
                trimmed,
                focusBeanID: focusID,
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
            isAsking = false
        }
    }

    private struct Exchange: Identifiable {
        let id = UUID()
        let question: String
        var answer: AskAnswer?
    }

    private enum ScrollAnchor { case bottom }
}
