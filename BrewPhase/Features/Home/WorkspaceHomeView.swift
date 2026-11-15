import SwiftData
import SwiftUI

/// 首页：三个平等的空间，纵向排开，每个空间一行卡片。
///
/// 这一页不回答「今天该喝哪包豆」，它回答「我有三个地方，先看哪一个」。
/// 三个分区同宽、同高、同一种卡片、同一个上限——咖啡不靠尺寸和颜色抢位置，
/// 它只靠内容。首页也不写任何业务数据：卡片是投影，点开回到原件。
///
/// 点分区 = 进这个空间的**列表**，不直接开某一条；要直接开某一条，用顶部搜索。
///
/// Gravity Cards（Phase 2）：本视图是重力交互的**唯一驱动方**——三个分区
/// 各一个引擎，但只有这里的一条 `TimelineView` 负责步进。滚动、键盘、
/// 后台、路由离开都在这里拦截，向下只暴露「引擎 + 输入方向」。
struct WorkspaceHomeView: View {

    /// 进入某个空间。导航状态住在 App 层，首页不自己持有路由。
    let onOpenSpace: (AppTab) -> Void

    @Query(sort: \Bean.createdAt, order: .reverse) private var beans: [Bean]
    @Query(sort: \Brew.date, order: .reverse) private var brews: [Brew]
    @Query(sort: \Tasting.date, order: .reverse) private var tastings: [Tasting]
    @Query(sort: \Record.createdAt, order: .reverse) private var records: [Record]
    @Query(sort: \Canvas.updatedAt, order: .reverse) private var canvases: [Canvas]

    @State private var destination: HomeDestination?

    /// 输入框里的字。
    @State private var searchText = DebugLaunch.searchQuery ?? ""
    /// 真正用于匹配的字：停手 200ms 才更新，打字过程不重算。
    @State private var query = ""

    /// Gravity Cards：总开关（设置里可关；Reduce Motion 时视为关）。
    @AppStorage(PrefKey.gravityCardsEnabled) private var gravityCardsEnabled = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// 唯一的姿态控制器，三个分区共享。
    @State private var motion = WorkspaceMotionController()
    /// 重力场：三个分区各自的引擎 + 是否静止。时间线暂停/唤醒看它。
    @State private var field = WorkspaceGravityField()
    /// 传感器是否处于「用户交互暂停」状态（滚动/键盘）。
    @State private var motionSuspended = false
    /// 搜索框焦点：键盘弹起 = 暂停重力。
    @FocusState private var searchFocused: Bool
    /// 场景阶段：后台 = 停传感器。
    @Environment(\.scenePhase) private var scenePhase

    /// 内容上限：iPad 上卡片不该被拉成一整屏宽。
    private let contentMaxWidth: CGFloat = 760

    /// 重力是否实际生效：设置开 && 无 Reduce Motion。
    private var gravityActive: Bool {
        gravityCardsEnabled && !reduceMotion
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    header

                    // 桌面端是三个空间共同的外围入口，放在首页顶端，而不是
                    // 长在咖啡那一栏下面。
                    DesktopSyncEntryRow(sync: .shared)
                        .padding(.top, Metric.Space.sm)

                    searchField.padding(.top, Metric.Space.sm)

                    content.padding(.top, Metric.Space.xl)
                }
                .padding(.horizontal, Metric.gutter)
                .padding(.top, 6)
                .padding(.bottom, Metric.sectionGap)
                .frame(maxWidth: contentMaxWidth)
                .frame(maxWidth: .infinity)
            }
            .background(Palette.paper)
            .scrollDismissesKeyboard(.interactively)
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(item: $destination) { target in
                destinationView(for: target)
            }
            // Gravity Cards：用户开始滚动时暂停传感器输入，滚动结束后
            // 重新校准基准再恢复——滚动本身不该被解读成倾斜。
            .onScrollPhaseChange { _, newPhase in
                switch newPhase {
                case .tracking, .interacting, .decelerating:
                    pauseGravity()
                case .idle, .animating:
                    resumeGravity()
                @unknown default:
                    break
                }
            }
            .task(id: searchText) {
                let typed = searchText
                if typed.trimmed.isEmpty {
                    query = ""
                    return
                }
                // 防抖：停手 200ms 才真的过滤，边打边算会把长列表拖顿。
                try? await Task.sleep(for: .milliseconds(200))
                guard !Task.isCancelled else { return }
                query = typed
            }
            .task(id: gravityActive) {
                configureGravity()
            }
            // 键盘：聚焦搜索 = 暂停；失焦 = 恢复。
            .onChange(of: searchFocused) { _, focused in
                if focused {
                    pauseGravity()
                } else {
                    resumeGravity()
                }
            }
            // 后台：停传感器；回前台：重校准再恢复（scenePhase 在
            // NavigationStack 外层监听也行，但放在这里语义更集中）。
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                case .active:
                    if !motionSuspended { resumeGravity() }
                case .background, .inactive:
                    motion.suspend()
                @unknown default:
                    break
                }
            }
            // Gravity Cards：离开首页（推开详情 / 被路由换走）时清理全部物理状态。
            // NavigationStack 推详情时根视图不一定会收到 onDisappear，
            // 所以同时盯住 destination：非空 = 已经离开首页。
            .onChange(of: destination) { _, target in
                if target == nil {
                    configureGravity()
                } else {
                    teardownGravity()
                }
            }
            .onDisappear {
                teardownGravity()
            }
        }
    }

    // MARK: - Gravity Cards 生命周期

    /// 滚动/键盘开始：停传感器、清力（速度保留，卡片自然滑停）。
    ///
    /// 不清速度：需求要的是「原有运动通过阻尼自然衰减」，不是急停。
    private func pauseGravity() {
        guard gravityActive else { return }
        motionSuspended = true
        motion.suspend()
        field.calm()
    }

    /// 滚动结束 / 键盘收起 / 回前台：重校准基准，恢复采样。
    ///
    /// 不检查 `motionSuspended`：后台恢复时它本来就是 false，但传感器确实
    /// 停了——是否真的需要重启由控制器的 phase 判断。
    private func resumeGravity() {
        guard gravityActive else { return }
        motionSuspended = false
        motion.resume()
    }

    /// 开关翻转 / 首页出现：把控制器的输出接到重力场，按配置启停传感器。
    private func configureGravity() {
        field.reset()
        motion.onGravity = { [field] gravity in
            field.setGravity(gravity)
        }
        if gravityActive {
            motion.activate()
        } else {
            motion.deactivate()
        }
    }

    /// 离开首页：停传感器、清全部物理状态（下次进入从原始堆叠开始）。
    private func teardownGravity() {
        motion.onGravity = nil
        motion.deactivate()
        field.reset()
        motionSuspended = false
    }

    /// 把当前三个分区的卡片交给引擎（内部有「没变就返回」的短路）。
    private func reconcileField() {
        guard gravityActive else { return }
        for space in AppTab.allCases {
            field.reconcile(cards: cards(for: space), for: space)
        }
    }

    /// 时间线是否暂停：重力关闭 / 全部卡片已静止。
    ///
    /// 交互暂停（滚动/键盘）**不**暂停时间线——那段时间卡片要靠惯性滑停，
    /// 冻结画面反而像卡住了。
    private var timelinePaused: Bool {
        !gravityActive || field.isQuiescent
    }

    // MARK: - 页头

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: "BREWPHASE / STUDIO")
                .font(TypeScale.brandMark)
                .italic()
                .tracking(2.4)
                .foregroundStyle(Palette.inkFaint)

            Text(verbatim: greeting.line)
                .font(TypeScale.greeting)
                .foregroundStyle(Palette.ink)

            Text(verbatim: dateLine)
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
        }
        .padding(.top, 10)
    }

    private var greeting: WorkspaceGreeting {
        let hour = DateMath.calendar.component(.hour, from: Date())
        return WorkspaceGreeting.at(hour: hour)
    }

    private var dateLine: String {
        let now = Date()
        return "\(Fmt.short(now)) · \(Fmt.weekday(now))"
    }

    // MARK: - 搜索

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Palette.inkFaint)

            TextField("搜索咖啡、记录、画布", text: $searchText)
                .font(TypeScale.body)
                .foregroundStyle(Palette.ink)
                .submitLabel(.search)
                .autocorrectionDisabled()
                .focused($searchFocused)

            if !searchText.isEmpty {
                Button {
                    searchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(Palette.inkFaint)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(verbatim: L("清除搜索")))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Capsule(style: .continuous).fill(Palette.card))
        .overlay(Capsule(style: .continuous).strokeBorder(Palette.hairline, lineWidth: 0.8))
    }

    // MARK: - 内容：三个分区，或搜索结果

    @ViewBuilder
    private var content: some View {
        if query.trimmed.isEmpty {
            sections
        } else {
            searchResults
        }
    }

    private var sections: some View {
        // Gravity Cards：全首页唯一的物理时间线。步进在这里发生，卡片只读
        // 引擎快照渲染——传感器回调不会重建整页，静止后时间线自己暂停。
        //
        // 步进写成 body 内的 `let _ =`（而不是 onChange）：TimelineView 的
        // 内容闭包每帧重建，onChange 抓不住「同一身份下日期变了」这件事。
        TimelineView(.animation(minimumInterval: nil, paused: timelinePaused)) { timeline in
            // 每帧对账一次：开关从关到开、卡片内容变化都在这里收敛，
            // 不依赖 onAppear（它不会因为开关翻转再触发一次）。
            let _ = reconcileField()
            let _ = field.step(at: timeline.date)
            VStack(spacing: 20) {
                ForEach(AppTab.allCases) { space in
                    WorkspaceCardStackView(
                        space: space,
                        cards: cards(for: space),
                        canvases: canvasByID,
                        accent: space.accent,
                        onOpenSpace: { onOpenSpace(space) },
                        field: gravityActive ? field : nil,
                        frameToken: timeline.date
                    )
                }
            }
        }
    }

    @ViewBuilder
    private var searchResults: some View {
        let hits = WorkspaceHomeFeed.matches(query, in: searchItems)

        if hits.isEmpty {
            EmptyStateView(
                symbol: "magnifyingglass",
                title: "没有找到",
                message: "换个词试试，或者清空搜索回到三个空间。",
                actionLabel: "清除搜索",
                action: { searchText = "" }
            )
        } else {
            VStack(spacing: 0) {
                ForEach(hits) { hit in
                    Button {
                        open(hit.target)
                    } label: {
                        searchRow(hit)
                    }
                    .buttonStyle(.plain)

                    if hit.id != hits.last?.id {
                        CardDivider()
                    }
                }
            }
        }
    }

    private func searchRow(_ hit: WorkspaceSearchItem) -> some View {
        HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(hit.space.accent.opacity(0.12))
                .frame(width: 34, height: 34)
                .overlay(
                    Image(systemName: glyph(for: hit.space))
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(hit.space.accent)
                )

            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: hit.title)
                    .font(TypeScale.bodyMedium)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)

                Text(verbatim: hit.subtitle)
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            Image(systemName: "chevron.right")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(Palette.inkFaint)
        }
        .frame(minHeight: 52)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private func glyph(for space: AppTab) -> String {
        switch space {
        case .coffee: return "cup.and.saucer"
        case .records: return "rectangle.stack"
        case .canvas: return "square.grid.2x2"
        }
    }

    // MARK: - 数据投影

    private func cards(for space: AppTab) -> [WorkspaceCard] {
        let picked = WorkspaceHomeFeed.cards(from: candidates(for: space))
        // 没有内容时不拿假数据填：给一张同尺寸的空态卡。
        return picked.isEmpty ? [.empty(for: space)] : picked
    }

    private func candidates(for space: AppTab) -> [WorkspaceCard] {
        switch space {
        case .coffee:
            return beans.prefix(candidatePool).map(WorkspaceCard.init(bean:))
                + brews.prefix(candidatePool).map(WorkspaceCard.init(brew:))
                + tastings.prefix(candidatePool).map(WorkspaceCard.init(tasting:))
        case .records:
            return records.prefix(candidatePool).map(WorkspaceCard.init(record:))
        case .canvas:
            return canvases.prefix(candidatePool).map(WorkspaceCard.init(canvas:))
        }
    }

    /// 候选池上限：只读够排序用的最近一段，不为看不见的卡片建对象。
    private var candidatePool: Int { 24 }

    /// 搜索的候选池比首页卡片宽得多：搜索就是要能翻到旧东西。
    private var searchItems: [WorkspaceSearchItem] {
        beans.prefix(searchPool).map(WorkspaceSearchItem.init(bean:))
            + brews.prefix(searchPool).map(WorkspaceSearchItem.init(brew:))
            + tastings.prefix(searchPool).map(WorkspaceSearchItem.init(tasting:))
            + records.prefix(searchPool).map(WorkspaceSearchItem.init(record:))
            + canvases.prefix(searchPool).map(WorkspaceSearchItem.init(canvas:))
    }

    private var searchPool: Int { 200 }

    private var canvasByID: [UUID: Canvas] {
        Dictionary(canvases.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    }

    // MARK: - 打开内容

    /// 搜索结果点开的是**这一条**：用户已经说出他要找什么，不必再从列表里翻。
    private func open(_ target: WorkspaceCard.Target) {
        switch target {
        case .bean(let id): destination = .bean(id)
        case .record(let id): destination = .record(id)
        case .canvas(let id): destination = .canvas(id)
        case .none: break
        }
    }

    @ViewBuilder
    private func destinationView(for target: HomeDestination) -> some View {
        switch target {
        case .bean(let id):
            if let bean = beans.first(where: { $0.id == id }) {
                BeanDetailView(bean: bean)
            } else {
                missing
            }
        case .record(let id):
            if let record = records.first(where: { $0.id == id }) {
                RecordDetailView(record: record)
            } else {
                missing
            }
        case .canvas(let id):
            if let canvas = canvases.first(where: { $0.id == id }) {
                CanvasWorkspaceView(canvas: canvas)
            } else {
                missing
            }
        }
    }

    /// 卡片在、原件不在：只可能发生在别的窗口删掉了它。不猜、不重建。
    private var missing: some View {
        Text("这条内容已经不在了")
            .font(TypeScale.body)
            .foregroundStyle(Palette.inkSoft)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Palette.paper)
    }
}

/// 首页能推开的三种详情。用 UUID 而不是模型对象：路由要能比较、要能跨视图
/// 传递，`@Model` 引用不该进入导航状态。
enum HomeDestination: Hashable {
    case bean(UUID)
    case record(UUID)
    case canvas(UUID)
}

extension AppTab {

    /// 首页三个分区的辅助色。低饱和、等亮度：它们是识别用的，不构成等级。
    var accent: Color {
        switch self {
        case .coffee: return Palette.roast
        case .records: return Palette.sage
        case .canvas: return Palette.lilac
        }
    }

    /// 空间空着时那张卡上的一句话。
    var emptyTitle: String {
        switch self {
        case .coffee: return L("还没有咖啡")
        case .records: return L("还没有记录")
        case .canvas: return L("还没有画布")
        }
    }
}
