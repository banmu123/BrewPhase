import SwiftUI
import UIKit

/// 引导计时器的时间账本。
///
/// 一只小钟只有两个数：累计了多少、从什么时候开始跑。用时永远按
/// 「累计 + 现在 − 起点」现算，而不是每秒 `+= 1`——后者在卡顿、后台切换、
/// 连续点击时会漂移，而日期相减不会。所有方法都接受 `now`，测试可以喂进
/// 自己的日期，不用真等一秒。
struct BrewClock: Equatable, Sendable {
    var accumulated: TimeInterval = 0
    var startedAt: Date?

    func elapsed(now: Date) -> TimeInterval {
        accumulated + (startedAt.map { max(now.timeIntervalSince($0), 0) } ?? 0)
    }

    /// 开始跑。已经在跑就是空操作——重复点击不会把起点拨回去。
    mutating func start(_ now: Date) {
        guard startedAt == nil else { return }
        startedAt = now
    }

    /// 暂停，把已跑的时间并进累计。没在跑就是空操作。
    mutating func pause(_ now: Date) {
        guard let startedAt else { return }
        accumulated += max(now.timeIntervalSince(startedAt), 0)
        self.startedAt = nil
    }

    /// 归零并停表。
    mutating func reset() {
        accumulated = 0
        startedAt = nil
    }

    /// 归零但保持原来的跑/停状态（「重置本步」不等于「停下不走」）。
    mutating func restartIfRunning(_ now: Date) {
        let wasRunning = startedAt != nil
        reset()
        if wasRunning { startedAt = now }
    }
}

/// 一次引导冲煮的会话状态：走到第几步、本步与全程的表。
///
/// 会话不落库、不触发保存——它是 pure UI state，退出页面就丢弃。真正的
/// 写入只有一条路：完成后把配方与实测时长交给 `QuickBrewLogView`，
/// 由 `BrewRecorder` 统一落库。
@MainActor
final class BrewGuideSession: ObservableObject {

    @Published private(set) var stepIndex = 0
    @Published private(set) var stepClock = BrewClock()
    @Published private(set) var totalClock = BrewClock()
    @Published private(set) var isFinished = false

    let steps: [BrewStep]

    init(steps: [BrewStep]) {
        self.steps = steps
    }

    // MARK: - 派生

    var currentStep: BrewStep? {
        steps.indices.contains(stepIndex) ? steps[stepIndex] : nil
    }

    /// 「第 3 步，共 9 步」的进度。完成态画满。
    var progress: Double {
        guard !steps.isEmpty else { return 0 }
        return isFinished ? 1 : Double(stepIndex) / Double(steps.count)
    }

    var isRunning: Bool { stepClock.startedAt != nil }

    var isFirstStep: Bool { stepIndex == 0 }

    /// 本步是否已经跑到了建议时长（表还在走，只是给个「够了」的提示）。
    func stepTargetReached(now: Date) -> Bool {
        guard let target = currentStep?.targetSeconds, target > 0 else { return false }
        return stepClock.elapsed(now: now) >= Double(target)
    }

    // MARK: - 动作

    /// 开始 / 暂停。开始时全程的表跟着走（做咖啡的时间是连续的）；
    /// 暂停时两块表一起停——用户接电话的十分钟不该算进制作时长。
    func toggleTimer(now: Date = Date()) {
        guard !isFinished else { return }
        if isRunning {
            stepClock.pause(now)
            totalClock.pause(now)
        } else {
            stepClock.start(now)
            totalClock.start(now)
        }
    }

    /// 重置本步的表。跑着就从头接着跑，停着就保持停。
    func resetStepTimer(now: Date = Date()) {
        guard !isFinished else { return }
        stepClock.restartIfRunning(now)
    }

    /// 手动完成当前步：本步的表归零（跑着就续跑下一步），步进 +1；
    /// 最后一步完成时停表、置完成位。全程的表不受换步影响。
    func completeStep(now: Date = Date()) {
        guard !isFinished else { return }
        let wasRunning = isRunning
        if wasRunning {
            totalClock.pause(now)
            totalClock.start(now)
        }
        stepClock.restartIfRunning(now)
        if stepIndex + 1 >= steps.count {
            isFinished = true
            stepClock.pause(now)
            totalClock.pause(now)
        } else {
            stepIndex += 1
        }
    }

    /// 退回上一步重做。表的状态跟着本步重置，全程的表照实走。
    func goBack(now: Date = Date()) {
        guard stepIndex > 0 || isFinished else { return }
        if isFinished {
            isFinished = false
            stepIndex = steps.count - 1
        } else {
            stepIndex -= 1
        }
        stepClock.restartIfRunning(now)
    }
}

/// 分步冲煮引导。
///
/// 一屏只回答三件事：做到哪了、这一步干什么、表走到哪了。操作说明一行以内，
/// 目标值（重量/温度/时长）用小标签摆在显眼处；完成最后一步后，配方与实测
/// 时长交回给调用方去打开记录页——引导自己从不写库。
struct BrewGuideView: View {

    let plan: DrinkRecipePlan
    /// 带着实测总时长（秒）离开引导。0 表示没开过表。
    let onFinish: (Int) -> Void

    @Environment(\.dismiss) private var dismiss
    @StateObject private var session: BrewGuideSession

    /// `session` 供调试演练注入自己的会话（`brewGuideDemo` 要按脚本拨表）；
    /// 正常使用传 nil，视图自建。
    init(
        plan: DrinkRecipePlan,
        session external: BrewGuideSession? = nil,
        onFinish: @escaping (Int) -> Void
    ) {
        self.plan = plan
        self.onFinish = onFinish
        _session = StateObject(wrappedValue: external ?? BrewGuideSession(steps: BrewStepBuilder.steps(for: plan)))
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.5)) { timeline in
            let now = timeline.date
            ScrollView {
                VStack(alignment: .leading, spacing: Metric.sectionGap) {
                    header
                    stepCard(now: now)
                    stepList
                }
                .padding(.horizontal, Metric.gutter)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
        }
        .background(Palette.paper)
        .navigationTitle(plan.drink.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("退出") { dismiss() }
                    .foregroundStyle(Palette.inkSoft)
            }
        }
        .safeAreaInset(edge: .bottom) { actionBar }
    }

    // MARK: - 顶部：进度

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if session.isFinished {
                    Text("制作完成")
                        .font(TypeScale.callout)
                        .foregroundStyle(Palette.inkSoft)
                } else {
                    Text(LocalizedStringKey.alreadyLocalized(
                        L("第 %@ 步，共 %@ 步",
                          String(session.stepIndex + 1), String(session.steps.count))))
                        .font(TypeScale.callout)
                        .foregroundStyle(Palette.inkSoft)
                }
                Spacer(minLength: 0)
                Text(LocalizedStringKey.alreadyLocalized(plan.method))
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
            }
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Palette.wellDeep)
                    Capsule()
                        .fill(session.isFinished ? Palette.peak : Palette.roast)
                        .frame(width: max(proxy.size.width * session.progress, 6))
                }
            }
            .frame(height: 5)
        }
    }

    // MARK: - 当前步

    private func stepCard(now: Date) -> some View {
        Group {
            if let step = session.currentStep, !session.isFinished {
                Card(lifted: true) {
                    VStack(alignment: .leading, spacing: 14) {
                        Text(LocalizedStringKey.alreadyLocalized(step.title))
                            .font(TypeScale.cardTitle)
                            .foregroundStyle(Palette.ink)
                        if !step.detail.isEmpty {
                            Text(LocalizedStringKey.alreadyLocalized(step.detail))
                                .font(TypeScale.body)
                                .foregroundStyle(Palette.inkSoft)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if let chip = step.targetChipText {
                            Text(LocalizedStringKey.alreadyLocalized(chip))
                                .font(TypeScale.callout.monospacedDigit())
                                .foregroundStyle(Palette.roast)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 5)
                                .background(
                                    Capsule().fill(Palette.well)
                                )
                        }
                        if step.usesTimer {
                            timerBlock(step: step, now: now)
                        }
                    }
                }
            } else {
                finishedCard
            }
        }
    }

    private var finishedCard: some View {
        Card(lifted: true) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(Palette.peak)
                    Text("这一杯做完了")
                        .font(TypeScale.cardTitle)
                        .foregroundStyle(Palette.ink)
                }
                Text("去记录这杯的味道吧——参数已经按配方目标填好，改成本次的实际值就行。")
                    .font(TypeScale.callout)
                    .foregroundStyle(Palette.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
                if session.totalClock.elapsed(now: Date()) > 0 {
                    Text(LocalizedStringKey.alreadyLocalized(
                        L("全程用时 %@", BrewMath.formatTime(Int(session.totalClock.elapsed(now: Date()).rounded())))))
                        .font(TypeScale.caption.monospacedDigit())
                        .foregroundStyle(Palette.inkFaint)
                }
            }
        }
    }

    /// 计时块：真实的表。开始/暂停、重置；跑到建议时长时提示「够了」。
    private func timerBlock(step: BrewStep, now: Date) -> some View {
        let elapsed = session.stepClock.elapsed(now: now)
        let reached = session.stepTargetReached(now: now)
        let elapsedText = elapsed > 0
            ? BrewMath.formatTime(Int(elapsed.rounded()))
            : "0:00"
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(verbatim: elapsedText)
                    .font(TypeScale.bigNumeral)
                    .foregroundStyle(reached ? Palette.peak : Palette.ink)
                if let target = step.targetSeconds, target > 0 {
                    Text(L("建议 %@", BrewMath.formatTime(target)))
                        .font(TypeScale.caption.monospacedDigit())
                        .foregroundStyle(reached ? Palette.peak : Palette.inkFaint)
                }
                Spacer(minLength: 0)
                Button {
                    session.toggleTimer()
                    Haptic.tick()
                } label: {
                    Text(session.isRunning ? "暂停" : (elapsed > 0 ? "继续" : "开始"))
                        .font(TypeScale.bodyMedium)
                        .foregroundStyle(Palette.roast)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 7)
                        .background(Capsule().strokeBorder(Palette.roast.opacity(0.5), lineWidth: 1))
                }
                .buttonStyle(.plain)
                if elapsed > 0 {
                    Button {
                        session.resetStepTimer()
                    } label: {
                        Text("重置")
                            .font(TypeScale.callout)
                            .foregroundStyle(Palette.inkFaint)
                    }
                    .buttonStyle(.plain)
                }
            }
            if reached {
                Text("到建议时长了，可以进入下一步。")
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.peak)
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: Metric.radiusSmall, style: .continuous)
                .fill(Palette.well.opacity(0.55))
        )
    }

    // MARK: - 步骤清单

    private var stepList: some View {
        Card(padding: 0) {
            VStack(spacing: 0) {
                ForEach(Array(session.steps.enumerated()), id: \.element.id) { index, step in
                    HStack(spacing: 10) {
                        Image(systemName: index < session.stepIndex || session.isFinished
                              ? "checkmark.circle.fill" : "circle")
                            .font(.system(size: 13))
                            .foregroundStyle(index < session.stepIndex || session.isFinished
                                             ? Palette.peak : Palette.inkFaint)
                        Text(LocalizedStringKey.alreadyLocalized(step.title))
                            .font(index == session.stepIndex && !session.isFinished
                                  ? TypeScale.bodyMedium : TypeScale.body)
                            .foregroundStyle(index == session.stepIndex && !session.isFinished
                                             ? Palette.ink : Palette.inkSoft)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 9)
                    .contentShape(Rectangle())
                    .onTapGesture {
                        // 点步骤名可以跳回去重看——只允许往回跳，往前提会
                        // 把没做完的步骤静默标成已完成。
                        if index < session.stepIndex || (session.isFinished && index <= session.stepIndex) {
                            session.jumpBack(to: index)
                        }
                    }
                    if index < session.steps.count - 1 {
                        CardDivider().padding(.leading, 16)
                    }
                }
            }
        }
    }

    // MARK: - 底部动作条

    private var actionBar: some View {
        HStack(spacing: 10) {
            if !session.isFinished {
                SecondaryButton(title: "上一步", systemImage: "chevron.left") {
                    session.goBack()
                }
                .disabled(session.isFirstStep)
                .opacity(session.isFirstStep ? 0.45 : 1)
            }
            PrimaryButton(title: session.isFinished
                          ? "去记录这杯"
                          : (session.stepIndex + 1 == session.steps.count ? "完成制作" : "完成本步")) {
                if session.isFinished {
                    let measured = Int(session.totalClock.elapsed(now: Date()).rounded())
                    Haptic.done()
                    onFinish(measured)
                } else {
                    session.completeStep()
                    Haptic.tick()
                }
            }
        }
        .padding(.horizontal, Metric.gutter)
        .padding(.top, 10)
        .padding(.bottom, 10)
        .background(.ultraThinMaterial)
    }
}

/// 触觉反馈只做点缀：切步与完成时轻一下。包装在一个地方，测试与
/// 不支持触觉的环境自然走空。
@MainActor
enum Haptic {
    static func tick() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    static func done() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }
}

/// UI inspection only（`-BrewPhaseScreen brewGuideDemo`）。
///
/// 模拟器不能点击，而「引导 → 交接 → 记录」这条链只有真的走完一遍才有东西
/// 可验：这里替用户按脚本拨计时器（开始 → 暂停 → 继续 → 换步 → 完成），
/// 然后把交接**连发两次**——落库必须仍然只有一条记录，时间必须是实测值
/// 而不是配方的目标耗时。配合 `-BrewPhaseQuickLogDemo yes` 时记录页会自动
/// 保存，结果页与库里的那一行就是验收证据。
@MainActor
struct BrewGuideDemoView: View {

    let bean: Bean?

    private let plan = DrinkRecipePlan.default(for: .latte)
    @StateObject private var session: BrewGuideSession
    /// `sheet(item:)` 的呈现载体：不是 nil 就呈现记录页，item 本身就是种子——
    /// 呈现时机与取值时机是同一个，杜绝 isPresented 闭包读旧状态的可能。
    @State private var recordSeed: GuidedBrewSeed?
    @State private var handoffs = 0

    init(bean: Bean?) {
        self.bean = bean
        let plan = DrinkRecipePlan.default(for: .latte)
        _session = StateObject(wrappedValue: BrewGuideSession(steps: BrewStepBuilder.steps(for: plan)))
    }

    var body: some View {
        BrewGuideView(plan: plan, session: session) { measured in
            handoff(measured: measured)
        }
        .task { await drive() }
        .sheet(item: $recordSeed) { seed in
            QuickBrewLogView(bean: bean, guidedSeed: seed)
        }
    }

    // MARK: - 脚本

    private func drive() async {
        // 先让第一帧稳定，截图能拍到「第 1 步」的样子。
        try? await Task.sleep(for: .seconds(1.5))
        session.toggleTimer(now: Date())                    // 开始
        try? await Task.sleep(for: .seconds(2))
        session.toggleTimer(now: Date())                    // 暂停
        try? await Task.sleep(for: .seconds(1))
        session.toggleTimer(now: Date())                    // 继续
        AppLog.lifecycle.info("guide demo: resumed, step elapsed \(self.session.stepClock.accumulated, privacy: .public)s")

        // 称粉/布粉这类步骤不需要真等，连着完成。
        for _ in 0..<2 {
            session.completeStep(now: Date())
            try? await Task.sleep(for: .seconds(0.8))
        }
        while !session.isFinished {
            session.completeStep(now: Date())
            try? await Task.sleep(for: .seconds(0.4))
        }
        try? await Task.sleep(for: .seconds(1.2))

        // 「去记录这杯」按钮在模拟器点不到；按视图按钮的同一份交接逻辑
        // 连发两次，防重复提交的验证落在库上。
        let measured = Int(session.totalClock.elapsed(now: Date()).rounded())
        handoff(measured: measured)
        handoff(measured: measured)
    }

    private func handoff(measured: Int) {
        handoffs += 1
        recordSeed = GuidedBrewSeed(plan: plan, measuredSeconds: measured)
        AppLog.lifecycle.info("guide demo handoff #\(self.handoffs, privacy: .public), measured=\(measured, privacy: .public)s, seedMethod=\(self.recordSeed?.recipe.method ?? "nil", privacy: .public)")
    }
}

extension BrewGuideSession {
    /// 点清单里已完成的步骤跳回去重做。完成态下任何一步都能跳。
    func jumpBack(to index: Int) {
        guard index >= 0, index < steps.count else { return }
        guard index < stepIndex || isFinished else { return }
        stepIndex = index
        stepClock.restartIfRunning(Date())
        isFinished = false
    }
}
