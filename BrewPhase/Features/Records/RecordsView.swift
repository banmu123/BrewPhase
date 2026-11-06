import AVKit
import SwiftData
import SwiftUI
import UIKit

/// 记录 —— 一级页面之二，一个人的内容收集空间。
///
/// 页面骨架：标题与添加入口、常驻搜索、单行标签筛选，内容区交给
/// `RecordsMasonryView` 的两列瀑布流。它不再全量 `@Query`——数据按批从
/// `RecordsDataSource` 取，列归属由 `MasonryColumnPlanner` 决定，测高修正
/// 走 `updateHeight`。系统只认四种载体；分类是用户自己贴的标签。
struct RecordsView: View {

    @Environment(\.modelContext) private var context
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// 标签只有几十个，`@Query` 拉全量无所谓；记录走数据源分页。
    @Query(sort: \RecordTag.createdAt) private var tags: [RecordTag]

    @State private var planner = MasonryColumnPlanner(interItemSpacing: Metric.Space.sm)
    @State private var dataSource: RecordsDataSource?
    @State private var searchText = ""
    @State private var selectedTag: RecordTag?
    /// Masonry 内容区量到的列宽。0 表示还没布局过。
    @State private var columnWidth: CGFloat = 0
    @State private var detail: Record?
    /// 长按删除要先过确认：列表上的长按太容易误触。
    @State private var pendingDelete: Record?
    @State private var showsAdd = false

    /// 保存回调只入队：等外层 AddSheet 完全关闭后才真正插入并播落下动画。
    @State private var pendingInsertions = PendingInsertions()
    /// 下落动画的串行序列：一次只让一条记录处于下落中，推进由动画完成回调
    /// 负责。旧实现用两个固定延时互相追，连续保存时会抢同一个动画状态。
    @State private var insertionSequence = InsertionSequence()
    /// 正在下落的记录（决定 transition 与 zIndex，播完清空，只播一次）。
    @State private var droppedRecordID: UUID?
    /// 回顶部用的代理：保存后先回到顶部，新卡片必须在视野里落下。
    @State private var scrollProxy: ScrollViewProxy?

    /// 页面顶部的稳定锚点。
    private static let topAnchor = "records-top"

    /// 筛选条只列「真的被用过」的标签：六个建议标签一条记录都没贴的时候，
    /// 摆六个点不动的筛选项只是噪音。
    private var filters: [RecordTag] {
        tags.filter { $0.usageCount > 0 }
    }

    private var currentQuery: RecordsQuery {
        RecordsQuery(searchText: searchText, tagID: selectedTag?.id)
    }

    /// 防抖的触发键：搜索词或标签变化才重启 `.task(id:)`。
    private var queryKey: String {
        currentQuery.searchText + "|" + (currentQuery.tagID?.uuidString ?? "")
    }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        header.id(Self.topAnchor)
                        searchField.padding(.top, 12)
                        if !filters.isEmpty {
                            filterBar.padding(.top, 10)
                        }
                        content.padding(.top, 16)
                    }
                    .padding(.horizontal, Metric.gutter)
                    .padding(.top, 6)
                    .padding(.bottom, 28)
                }
                .background(Palette.paper)
                .onAppear { scrollProxy = proxy }
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(item: $detail) { record in
                RecordDetailView(record: record)
            }
            // 保存回调只入队；真正插入与下落发生在 onDismiss——此时两层
            // sheet 都已收起，用户看得见列表。
            .sheet(isPresented: $showsAdd, onDismiss: {
                processPendingInsertions()
            }) {
                AddFlowView { record in
                    pendingInsertions.enqueue(record)
                }
            }
            // 搜索输入防抖：停手 250ms 才真正重查重建，打字过程不发请求。
            // 查询一变，还没落的记录就不属于新列表了：先作废动画序列，
            // 再让新查询接管（记录已在库里，不会因此消失）。
            .task(id: queryKey) {
                insertionSequence.cancel()
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled else { return }
                reloadForCurrentQuery()
            }
            // 从详情页返回、sheet 收起后核对一遍：被删除或被编辑出筛选范围
            // 的已加载记录，连同它的列位一起撤下。不补拉新记录。
            .onAppear {
                reconcileAfterReturn()
            }
            // 离开 Records（切页、进详情、收起 App）：没播完的动画不再推进。
            .onDisappear {
                insertionSequence.cancel()
                droppedRecordID = nil
            }
            .confirmationDialog(
                "删除这条记录？",
                isPresented: Binding(
                    get: { pendingDelete != nil },
                    set: { if !$0 { pendingDelete = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("删除", role: .destructive) {
                    if let record = pendingDelete { delete(record) }
                    pendingDelete = nil
                }
                Button("取消", role: .cancel) { pendingDelete = nil }
            } message: {
                Text("删除后不可恢复。")
            }
        }
    }

    // MARK: - 顶部

    private var header: some View {
        HStack(alignment: .center, spacing: 10) {
            Text("记录")
                .font(TypeScale.display)
                .foregroundStyle(Palette.ink)

            Spacer(minLength: 0)

            Button {
                showsAdd = true
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Palette.card)
                    .frame(width: 36, height: 36)
                    .background(Circle().fill(Palette.espresso))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("添加记录")
        }
        .padding(.top, 10)
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Palette.inkFaint)
            TextField("搜索标题、备注、标签", text: $searchText)
                .font(TypeScale.body)
                .foregroundStyle(Palette.ink)
                .submitLabel(.search)
            if !searchText.isEmpty {
                Button {
                    searchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(Palette.inkFaint)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Capsule(style: .continuous).fill(Palette.card))
        .overlay(Capsule(style: .continuous).strokeBorder(Palette.hairline, lineWidth: 0.8))
    }

    private var filterBar: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 7) {
                FilterChip(title: L("全部"), isOn: selectedTag == nil) {
                    withAnimation(Motion.quick) { selectedTag = nil }
                }
                ForEach(filters) { tag in
                    FilterChip(title: tag.displayName, isOn: selectedTag?.id == tag.id) {
                        withAnimation(Motion.quick) {
                            selectedTag = selectedTag?.id == tag.id ? nil : tag
                        }
                    }
                }
            }
            .padding(.vertical, 1)
        }
        .scrollIndicators(.hidden)
        .scrollClipDisabled()
    }

    // MARK: - 内容

    @ViewBuilder
    private var content: some View {
        if let dataSource, !dataSource.records.isEmpty {
            RecordsMasonryView(
                planner: $planner,
                dataSource: dataSource,
                droppedRecordID: droppedRecordID,
                reduceMotion: reduceMotion,
                onMeasure: { id, height in
                    measure(id: id, height: height)
                },
                onNearBottom: {
                    loadNextPage()
                },
                onOpen: { detail = $0 },
                onDelete: { pendingDelete = $0 },
                onWidthChange: { width in
                    adjustToWidth(width)
                }
            )
        } else {
            emptyState
        }
    }

    /// 三种空：还没记录（工作台空着）；搜索没命中（给清除搜索的出口）；
    /// 标签下没有内容（给返回全部的出口）。不用假数据填页面。
    @ViewBuilder
    private var emptyState: some View {
        if let dataSource, dataSource.lastLoadFailed {
            VStack(spacing: 10) {
                Text("这批记录没能读出来。")
                    .font(TypeScale.callout)
                    .foregroundStyle(Palette.inkSoft)
                Button {
                    reloadForCurrentQuery()
                } label: {
                    Text("重新加载")
                        .font(TypeScale.callout)
                        .foregroundStyle(Palette.roast)
                }
                .buttonStyle(.plain)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 60)
        } else if currentQuery.isActive {
            VStack(spacing: 10) {
                Text(selectedTag == nil ? "没有匹配的记录。" : "这个标签下还没有记录。")
                    .font(TypeScale.callout)
                    .foregroundStyle(Palette.inkSoft)
                if !searchText.trimmed.isEmpty {
                    Button {
                        searchText = ""
                    } label: {
                        Text("清除搜索")
                            .font(TypeScale.callout)
                            .foregroundStyle(Palette.roast)
                    }
                    .buttonStyle(.plain)
                }
                if selectedTag != nil {
                    Button {
                        selectedTag = nil
                    } label: {
                        Text("返回全部")
                            .font(TypeScale.callout)
                            .foregroundStyle(Palette.roast)
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 60)
        } else if dataSource == nil {
            // 首批还在路上：一小会儿的安静，不放骨架屏假卡片。
            ProgressView()
                .frame(maxWidth: .infinity)
                .padding(.vertical, 60)
        } else {
            EmptyStateView(
                symbol: "rectangle.stack",
                title: "还没有记录",
                message: "一段网页、一张照片、一段视频、一句话。放进来，再决定它对你意味着什么。",
                actionLabel: "添加第一条",
                action: { showsAdd = true }
            )
            .padding(.top, 28)
        }
    }

    // MARK: - 布局协调

    /// 一条记录的布局项：图片/封面按真实比例估算，其余按窄列文本近似。
    private func layoutItem(for record: Record) -> MasonryLayoutItem {
        let imagePath = record.carrier == .image ? record.mediaPath : record.previewPath
        let image = ImageStore.shared.imageDimensions(named: imagePath)
        let estimated = RecordCardHeightEstimator.estimate(
            for: record, columnWidth: effectiveColumnWidth, image: image)
        return MasonryLayoutItem(id: record.id, height: estimated)
    }

    /// 列宽还没量到时用 16 Pro 单列的近似值顶着：估算只影响初始分派，
    /// 实测回传后自会修正。
    private var effectiveColumnWidth: CGFloat {
        columnWidth > 0 ? columnWidth : 170
    }

    /// 搜索 / 标签变化：数据面与布局面在同一步里重建（§七）。
    private func reloadForCurrentQuery() {
        if dataSource == nil {
            dataSource = RecordsDataSource(context: context)
        }
        guard let dataSource else { return }
        // 重建后列表是另一套内容：进行中的下落与排队都不再成立。
        insertionSequence.cancel()
        droppedRecordID = nil
        dataSource.reload(query: currentQuery)
        planner.rebuild(with: dataSource.records.map(layoutItem))
    }

    /// 实测高度回传。只在差异明显时写回（0.75pt 以下视为同一块内容），
    /// `updateHeight` 不换列，所以这次回传不会引起任何已渲染卡片移动，
    /// 也就不会形成测量循环。
    private func measure(id: UUID, height: CGFloat) {
        if let current = planner.height(of: id), abs(current - height) > 0.75 {
            planner.updateHeight(of: id, to: height)
        }
    }

    /// 页脚哨兵（或人工重试）请求下一批。
    ///
    /// 「同一批只自动请求一次」由哨兵自己的身份保证（`pageGeneration`），
    /// 这里不再维护共享闸门；`loadMore` 内部仍有单请求保护与耗尽判断。
    /// 只把**真正新增**的记录交给 Planner——分页追加不重建已有历史布局。
    private func loadNextPage() {
        guard let dataSource else { return }
        let fresh = dataSource.loadMore()
        guard !fresh.isEmpty else { return }
        planner.append(fresh.map(layoutItem))
    }

    /// 内容区宽度变化（首帧、旋屏、机型不同）：列宽重算后按新宽度重估。
    /// 宽度重建是设计系统允许的重建场景——归属可能变，但这是用户可感知的
    /// 几何变化，不是闪动。
    private func adjustToWidth(_ contentWidth: CGFloat) {
        let gap = CGFloat(Metric.Space.sm)
        let newColumnWidth = max(0, (contentWidth - gap) / 2)
        guard abs(newColumnWidth - columnWidth) > 0.5 else { return }
        columnWidth = newColumnWidth
        if let dataSource, !dataSource.records.isEmpty {
            planner.rebuild(with: dataSource.records.map(layoutItem))
        }
    }

    // MARK: - 新增、删除与协调

    /// 外层 AddSheet 完全关闭后：先回顶部，再把队列里的记录一条条落进去。
    ///
    /// 顺序不能颠倒——用户在深滚动位置保存时，直接插入会让下落动画在
    /// 屏幕外播完，用户回到列表只看到一条已经静止的记录。
    ///
    /// 这里只做两件事：把匹配当前筛选的记录排进序列、发起回顶部的滚动。
    /// 记录之间的推进交给动画完成回调（见 `advanceInsertion`），不再用
    /// 「520ms 一条」的固定间隔去猜动画何时结束。
    private func processPendingInsertions() {
        guard !pendingInsertions.isEmpty else { return }
        let queued = pendingInsertions.drain()
        let matching = queued.filter { currentQuery.matches($0) }
        guard !matching.isEmpty else { return } // 不匹配就安静放过，不清筛选条件

        // 数据源尚未建立（极端时序）：先按当前查询安全初始化，planner 与
        // dataSource 必须在同一套查询下，否则列表和布局会对不上。
        if dataSource == nil { reloadForCurrentQuery() }

        insertionSequence.enqueue(matching)
        scrollToTop()

        // 等滚动落定再落第一块。这一段等的是**滚动**，不是动画串行：
        // 连着保存的第二、三条由完成回调在上一条落稳后自动接上。
        let settle = reduceMotion ? 80 : 340
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(settle))
            guard !Task.isCancelled else { return }
            advanceInsertion()
        }
    }

    /// 回到列表顶部：新记录必须在视野里落下，而不是在屏幕外播完。
    private func scrollToTop() {
        if reduceMotion {
            scrollProxy?.scrollTo(Self.topAnchor, anchor: .top)
        } else {
            withAnimation(Motion.settle) {
                scrollProxy?.scrollTo(Self.topAnchor, anchor: .top)
            }
        }
    }

    /// 推进序列：下落位空着时取下一条，确认它仍然属于**当前**查询后再插入。
    ///
    /// 等待滚动或等待上一条落稳的这段时间里，用户可能改了搜索词或标签。
    /// 所以每条记录真正插入之前都要重新核对一次：数据源的查询就是界面现在
    /// 的查询，且这条记录仍然匹配。不匹配就让出位置继续看下一条——绝不替
    /// 用户清空筛选条件来迁就新记录。
    ///
    /// 被跳过的记录只是不播动画、不进列表；它在保存时已经落库，后续正常
    /// 查询照样找得到。
    private func advanceInsertion() {
        guard let record = insertionSequence.takeNext() else { return }
        guard let dataSource, dataSource.canInsert(record, for: currentQuery) else {
            insertionSequence.finishActive()
            advanceInsertion()
            return
        }
        insertWithDrop(record)
    }

    /// 插入一条新记录并让它从上方落下。
    ///
    /// 数据面（dataSource）与布局面（planner）在同一个动画事务里更新；
    /// 列归属完全来自 `planner.insertNewest`，视图不自己算列。重复检查
    /// 用稳定的 `Record.id`。动画**完成回调**里才撤下 `droppedRecordID`
    /// 并推进下一条：清理只认自己那条记录的 id，不会打到后一条身上。
    ///
    /// Reduce Motion：不位移、不回弹，只做一次轻淡入（透明度过渡）。
    private func insertWithDrop(_ record: Record) {
        guard let dataSource else {
            // 没有数据面就没什么可插的；让出位置，别把后面的记录堵死。
            finishDrop(of: record.id)
            return
        }
        droppedRecordID = record.id
        let item = layoutItem(for: record)
        withAnimation(reduceMotion ? Motion.fade : Motion.drop) {
            dataSource.insertNewAtTop(record)
            planner.insertNewest(item)
        } completion: {
            finishDrop(of: record.id)
        }

        // 兜底：完成回调万一没来（视图不在窗口里、动画被系统吞掉），
        // 后面的记录不能永远卡在队列里。2s 是**失败超时**，不是动画节奏；
        // 正常的完成回调远早于此，走到这里说明这一条根本不会回调了。
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(2))
            finishDrop(of: record.id)
        }
    }

    /// 一条记录的下落真正结束：完成回调与超时兜底都走这里。
    /// 用 `activeID` 做幂等——谁先到谁推进，另一条路径自然变成空操作。
    private func finishDrop(of id: UUID) {
        guard insertionSequence.activeID == id else { return }
        if droppedRecordID == id { droppedRecordID = nil }
        insertionSequence.finishActive()
        advanceInsertion()
    }

    /// 从详情页返回 / sheet 收起后的核对：撤下被删除或被编辑出筛选范围的
    /// 记录（连同列位），其余原样。
    private func reconcileAfterReturn() {
        guard let dataSource, !dataSource.records.isEmpty else { return }
        for id in dataSource.staleIDs() {
            planner.remove(id: id)
            dataSource.remove(id: id)
        }
    }

    /// 与豆子删除同一个次序：**先让数据库删成功，再动磁盘上的文件**。
    private func delete(_ record: Record) {
        let media = record.mediaPath
        let preview = record.previewPath
        let carrier = record.carrier
        // 先清掉画布里引用它的节点：节点只存引用，记录的删除必须连带回收，
        // 否则画布上会留下点开一片空白的卡片。与记录同一次 save 提交。
        CanvasNodeStore.deleteNodes(referencing: record.id, context: context)
        context.delete(record)
        do {
            try context.save()
        } catch {
            AppLog.store.error("record delete failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
            return
        }
        planner.remove(id: record.id)
        dataSource?.remove(id: record.id)
        if carrier == .video {
            MediaStore.shared.delete(media)
        } else {
            ImageStore.shared.delete(media)
        }
        ImageStore.shared.delete(preview)
    }
}

// MARK: - 详情

/// 一条记录的完整样子：内容、自己的话、贴过的标签。
///
/// 视频在这里才真正播放；图片在这里才铺满宽度。列表里它们都是缩略的，因为
/// 列表回答的是「我收过什么」，不是「它长什么样」。
struct RecordDetailView: View {

    let record: Record

    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    @State private var isEditing = false
    @State private var isConfirmingDelete = false
    /// 播放器只在用户点过之后才存在：列表和详情打开时都不加载任何嵌入内容。
    @State private var isPlaying = false
    @State private var isFullscreen = false
    @State private var isRefreshing = false
    @State private var refreshFailure: LinkFailure?
    @State private var isHydratingCover = false
    /// 本地视频的播放器：进页面建一次，重绘不重建（重建会让播放从头开始）。
    @State private var player: AVPlayer?
    /// 复制成功的轻量反馈。用 token 而不是布尔：连续复制两次时，
    /// 第一次的隐藏任务不会把第二次的提示提前收走。
    @State private var copyFeedbackToken: UUID?

    /// `autoPlay` 只给调试截图用：正常路径必须先点封面才会创建播放器。
    init(record: Record, autoPlay: Bool = false) {
        self.record = record
        _isPlaying = State(initialValue: autoPlay)
    }

    private var tint: Color { RecordPresentation.tint(record.carrier) }

    /// 详情页的展示决策：标题、作者、正文、备注、来源各自只说一遍。
    private var presentation: RecordDetailPresentation {
        RecordDetailPresentation(record: record)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                originalContent.padding(.top, 18)
                personalNoteSection.padding(.top, 24)
                sourceSection.padding(.top, 24)
                tagsSection.padding(.top, 20)
                metadataSection.padding(.top, 24)
            }
            .padding(.horizontal, Metric.gutter)
            .padding(.top, 8)
            .padding(.bottom, 40)
        }
        .background(Palette.paper)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .overlay(alignment: .bottom) { copyConfirmation }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                moreMenu
            }
        }
        .sheet(isPresented: $isEditing) {
            RecordEditorView(carrier: record.carrier, existing: record)
        }
        .fullScreenCover(isPresented: $isFullscreen) {
            if let embed = record.linkEmbed {
                FullScreenPlayerView(record: record, embed: embed)
            }
        }
        .onChange(of: isFullscreen) { _, showing in
            // 全屏是一次独立的播放：退出后行内回到封面，避免两个播放器同时出声。
            if !showing { isPlaying = false }
        }
        .task(id: record.previewPath) {
            // 详情页是唯一的 force 重试口：列表里失败过的封面，打开详情再试一次。
            guard record.carrier == .link, record.previewPath == nil,
                  record.thumbnailURL != nil else { return }
            isHydratingCover = true
            _ = await CoverFetcher.shared.fetch(record, force: true)
            isHydratingCover = false
        }
        .confirmationDialog("删除这条记录？", isPresented: $isConfirmingDelete,
                            titleVisibility: .visible) {
            Button("删除", role: .destructive) { delete() }
            Button("取消", role: .cancel) {}
        } message: {
            Text("删除后不可恢复。")
        }
    }

    // MARK: - 01 Header

    private var header: some View {
        HStack(alignment: .center, spacing: 14) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 5) {
                    Image(systemName: record.carrier == .link ? record.provider.symbol : record.carrier.symbol)
                        .font(.system(size: 10, weight: .semibold))
                    Text(verbatim: headerBadge)
                        .font(TypeScale.micro)
                        .tracking(0.8)
                }
                .foregroundStyle(tint)

                if record.provider == .github {
                    // 仓库照 GitHub 的习惯拆两行：owner 是小字，仓库名才是标题。
                    VStack(alignment: .leading, spacing: 2) {
                        if let owner = record.repositoryOwner {
                            Text(verbatim: owner + " /")
                                .font(TypeScale.callout)
                                .foregroundStyle(Palette.inkFaint)
                                .lineLimit(1)
                        }
                        if !presentation.title.isEmpty {
                            titleText(presentation.title)
                        }
                    }
                } else if !presentation.title.isEmpty {
                    titleText(presentation.title)
                }

                // 作者是辅助信息，域名属于来源区——同一件事不在两处出现。
                if let credit = presentation.credit {
                    Text(verbatim: credit)
                        .font(TypeScale.callout)
                        .foregroundStyle(Palette.inkSoft)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if !record.repositoryStatItems.isEmpty {
                    HStack(spacing: 12) {
                        ForEach(Array(record.repositoryStatItems.enumerated()), id: \.offset) { _, item in
                            HStack(spacing: 3) {
                                if !item.symbol.isEmpty {
                                    Image(systemName: item.symbol)
                                        .font(.system(size: 10, weight: .semibold))
                                }
                                Text(verbatim: item.text)
                                    .font(TypeScale.caption)
                            }
                            .foregroundStyle(Palette.inkFaint)
                            .lineLimit(1)
                        }
                    }
                }
            }

            Spacer(minLength: 10)

            if record.provider == .github {
                RepositoryAvatar(record: record, size: 64)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 4)
    }

    private func titleText(_ text: String) -> some View {
        Text(.alreadyLocalized(text))
            .font(TypeScale.beanName)
            .foregroundStyle(Palette.ink)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
    }

    // MARK: - 02 原始内容

    /// 内容永远排在个人备注之前：先看「我收了什么」，再看「我当时怎么想」。
    @ViewBuilder
    private var originalContent: some View {
        switch record.carrier {
        case .image:
            if let image = ImageStore.shared.image(named: record.mediaPath, thumbnail: false) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: Metric.radius, style: .continuous))
            }

        case .video:
            videoPlayer

        case .link:
            VStack(alignment: .leading, spacing: 16) {
                linkMedia
                if let content = presentation.content {
                    Text(verbatim: content)
                        .font(TypeScale.callout)
                        .foregroundStyle(Palette.inkSoft)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

        case .text:
            // 文字记录的 note 就是原文：它是正文，不是备注。
            if let content = presentation.content {
                Text(verbatim: content)
                    .font(TypeScale.body)
                    .foregroundStyle(Palette.ink)
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - 03 我的备注

    @ViewBuilder
    private var personalNoteSection: some View {
        if let note = presentation.personalNote {
            VStack(alignment: .leading, spacing: 8) {
                Text("我的备注")
                    .font(TypeScale.micro)
                    .tracking(0.8)
                    .foregroundStyle(Palette.inkFaint)
                Text(verbatim: note)
                    .font(TypeScale.body)
                    .foregroundStyle(Palette.ink)
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - 04 来源

    @ViewBuilder
    private var sourceSection: some View {
        if let url = presentation.sourceURL {
            VStack(alignment: .leading, spacing: 8) {
                Text("来源")
                    .font(TypeScale.micro)
                    .tracking(0.8)
                    .foregroundStyle(Palette.inkFaint)

                Button {
                    openURL(url)
                } label: {
                    HStack(spacing: 8) {
                        Text(verbatim: record.providerLabel ?? record.linkHost ?? url.absoluteString)
                            .font(TypeScale.callout)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        Image(systemName: "arrow.up.right")
                            .font(.system(size: 11, weight: .semibold))
                    }
                    .foregroundStyle(Palette.roast)
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("打开原始来源")
                .accessibilityHint(record.linkHost ?? url.absoluteString)

                // 完整网址只是辅助：很长时中间截断，不换行撑破版面。
                Text(verbatim: url.absoluteString)
                    .font(TypeScale.micro)
                    .foregroundStyle(Palette.inkFaint)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - 05 标签

    @ViewBuilder
    private var tagsSection: some View {
        if !record.orderedTags.isEmpty {
            FlowLayout(spacing: 6, lineSpacing: 6) {
                ForEach(record.orderedTags) { tag in
                    Chip(text: tag.displayName, tint: Palette.inkSoft, background: Palette.well)
                }
            }
        }
    }

    // MARK: - 06 元数据

    private var metadataSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Hairline()
            // 来源与作者已经在标题区/来源区说过，这里只留时间。
            detailLine("记录于", Fmt.precise(record.createdAt, calendar: DateMath.calendar))
            if needsMetadataRefresh {
                refreshRow
            }
        }
    }

    // MARK: - 更多操作

    private var moreMenu: some View {
        Menu {
            Button {
                isEditing = true
            } label: {
                Label("编辑", systemImage: "square.and.pencil")
            }

            if let url = presentation.sourceURL {
                Button {
                    openURL(url)
                } label: {
                    Label("打开原始来源", systemImage: "arrow.up.right.square")
                }
                Button {
                    copyLink(url)
                } label: {
                    Label("复制链接", systemImage: "doc.on.doc")
                }
            }

            Divider()

            Button(role: .destructive) {
                isConfirmingDelete = true
            } label: {
                Label("删除这条记录", systemImage: "trash")
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.system(size: 17))
                .foregroundStyle(Palette.roast)
        }
        .accessibilityLabel("更多操作")
    }

    @ViewBuilder
    private var copyConfirmation: some View {
        if copyFeedbackToken != nil {
            Text("已复制链接")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.card)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(Capsule(style: .continuous).fill(Palette.espresso.opacity(0.92)))
                .padding(.bottom, 24)
                .transition(.opacity)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }

    private func copyLink(_ url: URL) {
        UIPasteboard.general.string = url.absoluteString
        let token = UUID()
        withAnimation(Motion.quick) { copyFeedbackToken = token }
        // 视觉提示一闪而过，辅助技术需要一次播报才知道复制成功了。
        UIAccessibility.post(notification: .announcement, argument: L("已复制链接"))
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.6))
            guard copyFeedbackToken == token else { return }
            withAnimation(Motion.quick) { copyFeedbackToken = nil }
        }
    }

    /// 链接的徽标只说平台，不说载体——「链接」这两个字对读者没有信息量。
    private var headerBadge: String {
        guard record.carrier == .link else { return record.carrier.title }
        return record.provider.displayName.isEmpty ? L("网页") : record.provider.displayName
    }

    // MARK: - 链接播放

    private var providerName: String {
        record.provider.displayName.isEmpty ? L("网页") : record.provider.displayName
    }

    /// 有官方组件就显示「封面 + 播放」；点之前不创建任何 WebView。
    @ViewBuilder
    private var linkMedia: some View {
        if let embed = record.linkEmbed {
            if isPlaying {
                LinkPlayerView(
                    record: record,
                    embed: embed,
                    isPost: record.embedCapability == .post,
                    onCollapse: { withAnimation(Motion.quick) { isPlaying = false } },
                    onFullscreen: { isFullscreen = true }
                )
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    linkPoster
                    Text(verbatim: record.embedCapability == .post
                         ? L("点击后加载 %@ 的官方帖子组件，届时会与对方服务器通信。", providerName)
                         : L("点击后加载 %@ 官方播放器，届时会与对方服务器通信。", providerName))
                        .font(TypeScale.micro)
                        .foregroundStyle(Palette.inkFaint)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        } else if record.provider != .github,
                  let preview = ImageStore.shared.image(named: record.previewPath, thumbnail: false) {
            Image(uiImage: preview)
                .resizable()
                .scaledToFill()
                .frame(height: 200)
                .frame(maxWidth: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: Metric.radius, style: .continuous))
        }
    }

    private var linkPoster: some View {
        Button {
            withAnimation(Motion.quick) { isPlaying = true }
        } label: {
            ZStack(alignment: .bottomLeading) {
                Group {
                    if let image = ImageStore.shared.image(named: record.previewPath, thumbnail: false) {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFill()
                    } else {
                        ZStack {
                            LinearGradient(colors: [Palette.wellDeep, Palette.well],
                                           startPoint: .topLeading, endPoint: .bottomTrailing)
                            Image(systemName: record.provider.symbol)
                                .font(.system(size: 34, weight: .ultraLight))
                                .foregroundStyle(Palette.inkFaint)
                            if isHydratingCover {
                                ProgressView().controlSize(.regular)
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity)
                .frame(height: record.embedCapability == .post ? 260 : 200)
                .clipped()

                LinearGradient(colors: [.clear, .black.opacity(0.72)],
                               startPoint: .center, endPoint: .bottom)

                HStack(spacing: 9) {
                    ZStack {
                        Circle().fill(Color.white)
                        Image(systemName: "play.fill")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(Palette.espresso)
                            .offset(x: 1)
                    }
                    .frame(width: 30, height: 30)

                    Text(record.canPlayInline ? "点击播放" : "点击查看帖子")
                        .font(TypeScale.callout.weight(.medium))
                        .foregroundStyle(.white)

                    Spacer(minLength: 0)
                }
                .padding(14)
            }
            .clipShape(RoundedRectangle(cornerRadius: Metric.radius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                    .strokeBorder(Palette.hairline, lineWidth: 0.8)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(record.canPlayInline ? "播放" : "查看帖子")
    }

    /// 只在这条链接**还没有**一份完整元数据时出现。抓不到的时候它就是个出口，
    /// 抓到了就不必占一行位置。
    private var needsMetadataRefresh: Bool {
        guard record.carrier == .link else { return false }
        switch record.metadataStatus {
        case .failed, .idle, .pending: return true
        case .resolved, .partial: return false
        }
    }

    private var refreshRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                refreshMetadata()
            } label: {
                HStack(spacing: 6) {
                    if isRefreshing {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 11, weight: .semibold))
                    }
                    Text(isRefreshing ? "正在重新获取…" : "重新获取网页信息")
                        .font(TypeScale.caption)
                }
                .foregroundStyle(Palette.roast)
            }
            .buttonStyle(.plain)
            .disabled(isRefreshing)

            if let refreshFailure {
                Text(refreshFailure.sentence)
                    .font(TypeScale.micro)
                    .foregroundStyle(Palette.inkFaint)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func refreshMetadata() {
        guard let url = record.resolvedLink, !isRefreshing else { return }
        // 请求发出前拍一张快照：等待期间用户可能改地址、也可能自己写了标题。
        // 回来时只把结果交给「还是同一条、同一个地址」的记录。
        let requestedURL = url
        let titleAtRequest = record.title
        isRefreshing = true
        refreshFailure = nil
        Task {
            let resolution = await LinkResolver.resolve(url)
            isRefreshing = false
            guard !Task.isCancelled else { return }
            // 用户换了地址：这份响应与记录已经无关，整份丢掉。
            guard record.resolvedLink == requestedURL else { return }

            record.adopt(resolution.match)
            if resolution.metadata.status == .failed {
                refreshFailure = resolution.metadata.failure ?? .parseFailed
                record.metadataStatus = resolution.metadata.status
            } else {
                record.adopt(resolution.metadata)
                // 只有「标题仍是请求发出时那一个」且为空，才接受抓回来的标题：
                // 用户在等待期间自己写的标题优先。
                if record.title == titleAtRequest, record.title.trimmed.isEmpty,
                   let fetched = resolution.metadata.title {
                    record.title = fetched
                }
            }
            record.touch()
            do {
                try context.save()
            } catch {
                AppLog.store.error("link refresh failed: \(error.localizedDescription, privacy: .public)")
                context.rollback()
            }
        }
    }

    /// 本地视频：文件在就播，不在就明说。
    ///
    /// 播放器实例挂在 `@State` 上，只在进入页面（或换了文件）时创建一次。
    /// 旧实现每次 body 求值都 `AVPlayer(url:)`，任何一次重绘——复制提示、
    /// 元数据刷新、从编辑页返回——都会换掉播放器，正在看的视频从头开始。
    @ViewBuilder
    private var videoPlayer: some View {
        if let path = record.mediaPath, MediaStore.shared.exists(path) {
            VideoPlayer(player: player)
                .frame(height: 220)
                .clipShape(RoundedRectangle(cornerRadius: Metric.radius, style: .continuous))
                .task(id: record.mediaPath) {
                    player?.pause()
                    player = AVPlayer(url: MediaStore.shared.url(for: path))
                }
                .onDisappear { player?.pause() }
        } else {
            VStack(spacing: 8) {
                Image(systemName: "video.slash")
                    .font(.system(size: 22, weight: .light))
                    .foregroundStyle(Palette.inkFaint)
                Text("这段视频的文件不在本机。")
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 160)
            .background(
                RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                    .fill(Palette.well)
            )
        }
    }

    private func detailLine(_ label: LocalizedStringKey, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(label)
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
                .frame(width: 48, alignment: .leading)
            Text(verbatim: value)
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkSoft)
            Spacer(minLength: 0)
        }
    }

    private func delete() {
        let media = record.mediaPath
        let preview = record.previewPath
        let carrier = record.carrier
        // 画布节点只存引用：记录删掉，引用必须一起回收。
        CanvasNodeStore.deleteNodes(referencing: record.id, context: context)
        context.delete(record)
        do {
            try context.save()
        } catch {
            AppLog.store.error("record delete failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
            return
        }
        if carrier == .video {
            MediaStore.shared.delete(media)
        } else {
            ImageStore.shared.delete(media)
        }
        ImageStore.shared.delete(preview)
        dismiss()
    }
}
