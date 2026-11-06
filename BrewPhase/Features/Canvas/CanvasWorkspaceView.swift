import SwiftData
import SwiftUI

/// 画布屏幕坐标空间的唯一名字。手势在这个空间里拿到的是**屏幕点**，
/// 再由 `CanvasViewport` 换算成世界坐标——换算只此一处。
private let canvasScreenSpace = "canvas-screen"

/// 节点在手势回调里读的实时视口参数。
///
/// 为什么用引用类型而不是 View 参数：`scale` 在捏合时每帧都变，作为参数传进
/// 每个节点，就会让所有可见节点跟着重算 body。放进一个不参与视图比较的小盒子，
/// 节点只在**手势开始那一刻**读一次，缩放过程只剩世界层的一次变换。
private final class CanvasCamera {
    var scale: CGFloat = 1
    var isPinching = false
}

/// 一块画布的工作区：自由摆放记录的地方。
///
/// 坐标分三层：节点存**世界坐标**；`CanvasWorldLayer` 是一个按世界尺寸布局的
/// 容器；整层只做一次 `scaleEffect + offset`。平移/缩放时改变的是这一层变换，
/// 而不是逐个节点重新定位——这是「整块空间一起移动」的手感来源。
///
/// 数据只有一条路径：**显式读取**（`CanvasNodeStore.nodes`）→ 对账
/// （`CanvasNodeReconciler`）→ 渲染。不挂 `@Query`：重进画布时节点必须来自
/// 一次确定的查询，而不是「视图重建时查询恰好还没有结果」——那会让用户看到
/// 一块空画布，再被清理逻辑当成孤儿。
struct CanvasWorkspaceView: View {

    let canvas: Canvas

    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    @State private var nodes: [CanvasNode] = []
    @State private var recordsByID: [UUID: Record] = [:]
    /// 加载状态：空画布只能来自「读取成功且确实没有节点」。
    @State private var loadState: CanvasLoadState = .loading

    @State private var viewport = CanvasViewport()
    @State private var canvasSize: CGSize = .zero
    /// 只在「第一次拿到非空节点」时装窗一次，之后布局由用户掌控。
    @State private var didFitContent = false
    /// 上一次装窗用的画布尺寸。第一次布局报上来的尺寸不一定是最终尺寸
    /// （容器还没定下来时会先给一个占位值），尺寸变了就得重算一次。
    @State private var fittedSize: CGSize = .zero
    /// 用户自己平移/缩放过之后，装窗不再自动覆盖他的视角。
    @State private var hasUserAdjusted = false

    @State private var camera = CanvasCamera()

    @State private var playingNodeID: UUID?
    @State private var draggingNodeID: UUID?
    @State private var newIDs: Set<UUID> = []

    @State private var isPinching = false
    @State private var magnifyBase: CanvasViewport?
    @State private var panBase: CGSize?

    @State private var showsPicker = false
    @State private var isEditing = false
    @State private var isConfirmingDelete = false
    @State private var annotationNode: CanvasNode?
    @State private var pendingRemove: CanvasNode?
    @State private var actionError: String?
    /// 「打开原记录」用同一层导航推详情：详情页的工具栏依赖外层 NavigationStack。
    @State private var openRecordSheet: Record?

    private var visibleWorldRect: CGRect {
        viewport.worldRect(in: canvasSize)
    }

    /// 世界层的布局范围：包住所有节点，并留出向外拖动的余量。
    /// 它只在节点集合/位置变化时重算，平移缩放不会动它。
    private var worldBounds: CGRect {
        guard let content = CanvasViewport.contentBounds(nodes.map(\.frame)) else {
            return CGRect(x: -400, y: -400, width: 800, height: 800)
        }
        return content.insetBy(dx: -800, dy: -800)
    }

    /// 只渲染视口附近的节点；正在拖的节点固定保留，免得拖到边缘被裁掉
    /// 而中断手势。
    private var visibleNodes: [CanvasNode] {
        let rect = visibleWorldRect
        guard rect.width > 0, rect.height > 0 else { return [] }
        let margin = CGRect(x: rect.minX - rect.width * 0.2,
                            y: rect.minY - rect.height * 0.2,
                            width: rect.width * 1.4,
                            height: rect.height * 1.4)
        return nodes.filter { margin.intersects($0.frame) || $0.id == draggingNodeID }
    }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                Palette.paper

                CanvasDotGrid(viewport: viewport)
                    .allowsHitTesting(false)

                // 空白处：单指平移。节点在自己的视图里处理拖动，不会被这里抢走。
                Color.clear
                    .contentShape(Rectangle())
                    .gesture(panGesture)

                worldLayer

                if loadState == .empty {
                    emptyCanvas
                } else if loadState == .loading && nodes.isEmpty {
                    loadingCanvas
                }
            }
            .coordinateSpace(.named(canvasScreenSpace))
            .simultaneousGesture(magnifyGesture)
            // 尺寸只认 `GeometryReader` 自己给的那份。实测在本页上
            // `onGeometryChange` 会报出容器占位尺寸（800×800、甚至像素级
            // 的 2460×2976），按它装窗会把整块内容推出屏幕。
            .onAppear { updateCanvasSize(geo.size) }
            .onChange(of: geo.size) { _, size in updateCanvasSize(size) }
        }
        .background(Palette.paper)
        .navigationTitle(canvas.displayName)
        .navigationBarTitleDisplayMode(.inline)
        // 列表页把导航栏藏起来做无栏构图；工作区必须显式要回来。
        .toolbar(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { moreMenu }
        }
        .navigationDestination(item: $openRecordSheet) { record in
            RecordDetailView(record: record)
        }
        .overlay(alignment: .bottomTrailing) { floatingControls }
        .safeAreaInset(edge: .top, spacing: 0) {
            if case .failed(let kind) = loadState {
                failureBanner(kind)
            }
        }
        .sheet(isPresented: $showsPicker) {
            CanvasRecordPicker(canvas: canvas) { picked in
                add(picked)
            }
        }
        .sheet(isPresented: $isEditing) {
            CanvasEditorView(existing: canvas)
        }
        .sheet(item: $annotationNode) { node in
            CanvasNodeAnnotationView(node: node)
        }
        .confirmationDialog("从画布移除这个节点？",
                            isPresented: Binding(
                                get: { pendingRemove != nil },
                                set: { if !$0 { pendingRemove = nil } }
                            ),
                            titleVisibility: .visible) {
            Button("移除", role: .destructive) {
                if let node = pendingRemove { remove(node) }
                pendingRemove = nil
            }
            Button("取消", role: .cancel) { pendingRemove = nil }
        } message: {
            Text("只会把它从这块画布拿走，记录本身还在。")
        }
        .confirmationDialog("删除这块画布？", isPresented: $isConfirmingDelete,
                            titleVisibility: .visible) {
            Button("删除", role: .destructive) { deleteCanvas() }
            Button("取消", role: .cancel) {}
        } message: {
            Text("画布上的节点会一起消失，原始记录不受影响。")
        }
        .alert("没能保存", isPresented: Binding(
            get: { actionError != nil },
            set: { if !$0 { actionError = nil } }
        )) {
            Button("好") { actionError = nil }
        } message: {
            Text(actionError ?? "")
        }
        .task {
            loadCanvas()
            // UI 验收用：`simctl` 点不到右下角的添加按钮。
            if CanvasDebugSeed.opensPicker {
                try? await Task.sleep(for: .milliseconds(700))
                showsPicker = true
            }
        }
        .onChange(of: nodes.count) { _, _ in fitIfNeeded() }
        .onChange(of: viewport.scale) { _, new in camera.scale = new }
        .onChange(of: isPinching) { _, new in camera.isPinching = new }
        .onDisappear {
            // 离开画布：不留任何播放器继续出声。
            playingNodeID = nil
            isPinching = false
            camera.isPinching = false
        }
    }

    // MARK: - 世界层

    /// 整块世界只做一次变换。节点在层内用自己的世界坐标定位。
    private var worldLayer: some View {
        let bounds = worldBounds
        return CanvasWorldLayer(
            bounds: bounds,
            nodes: visibleNodes,
            recordsByID: recordsByID,
            showsPlaceholders: loadState == .failed(.records),
            playingNodeID: playingNodeID,
            draggingNodeID: draggingNodeID,
            newIDs: newIDs,
            camera: camera,
            onOpen: { openRecord($0) },
            onTogglePlay: { togglePlay($0) },
            onOpenSource: { record in
                if let url = record.openLink { openURL(url) }
            },
            onAnnotate: { annotationNode = $0 },
            onRemove: { pendingRemove = $0 },
            onDragBegan: { draggingNodeID = $0 },
            onDragEnded: { node, worldTranslation in
                draggingNodeID = nil
                CanvasNodeStore.move(node,
                                     to: CGPoint(x: node.positionX + worldTranslation.width,
                                                 y: node.positionY + worldTranslation.height),
                                     context: context)
            },
            onReload: { loadCanvas() }
        )
        .frame(width: bounds.width, height: bounds.height, alignment: .topLeading)
        .scaleEffect(viewport.scale, anchor: .topLeading)
        .offset(x: viewport.offset.width + bounds.minX * viewport.scale,
                y: viewport.offset.height + bounds.minY * viewport.scale)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // MARK: - 手势

    private var panGesture: some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { value in
                guard !isPinching else { return }
                let base = panBase ?? viewport.offset
                if panBase == nil { panBase = viewport.offset; hasUserAdjusted = true }
                viewport.offset = CGSize(width: base.width + value.translation.width,
                                         height: base.height + value.translation.height)
            }
            .onEnded { value in
                panBase = nil
                // 惯性：把预测位移的一小段收进一次短动画。衰减快、不弹回；
                // 新手势从落点继续，不会和它打架。
                let extra = CGSize(
                    width: (value.predictedEndTranslation.width - value.translation.width) * 0.28,
                    height: (value.predictedEndTranslation.height - value.translation.height) * 0.28
                )
                guard abs(extra.width) + abs(extra.height) > 20 else { return }
                withAnimation(.easeOut(duration: 0.42)) {
                    viewport.offset = CGSize(width: viewport.offset.width + extra.width,
                                             height: viewport.offset.height + extra.height)
                }
            }
    }

    /// 双指缩放：以手势起始的两指中点为锚，内容在放大时不会从手指底下跑掉。
    /// 这里**不用** UIKit 识别器桥：真机上它会抢走捏合，缩放直接失效。
    private var magnifyGesture: some Gesture {
        MagnifyGesture(minimumScaleDelta: 0.01)
            .onChanged { value in
                isPinching = true
                hasUserAdjusted = true
                let base = magnifyBase ?? viewport
                if magnifyBase == nil { magnifyBase = viewport }
                let anchor = CGPoint(x: value.startAnchor.x * canvasSize.width,
                                     y: value.startAnchor.y * canvasSize.height)
                viewport = base.zoomed(to: base.scale * value.magnification, anchor: anchor)
            }
            .onEnded { _ in
                magnifyBase = nil
                isPinching = false
            }
    }

    // MARK: - 悬浮控件

    private var floatingControls: some View {
        VStack(spacing: 10) {
            // 添加素材是这里唯一「写数据」的动作，和下面的视角控制分开。
            floatingButton(symbol: "rectangle.badge.plus", filled: true, label: "添加记录到画布") {
                showsPicker = true
            }
            .padding(.bottom, 6)

            floatingButton(symbol: "plus.magnifyingglass", label: "放大画布") {
                zoom(by: 1.25)
            }
            floatingButton(symbol: "minus.magnifyingglass", label: "缩小画布") {
                zoom(by: 1 / 1.25)
            }
            floatingButton(symbol: "arrow.up.left.and.arrow.down.right",
                           label: "缩放到适合内容") {
                withAnimation(Motion.settle) { fitCanvas() }
            }

            Text(verbatim: "\(Int((viewport.scale * 100).rounded()))%")
                .font(TypeScale.micro.monospacedDigit())
                .foregroundStyle(Palette.inkFaint)
                .padding(.top, 2)
        }
        .padding(.trailing, 18)
        .padding(.bottom, 22)
    }

    private func floatingButton(symbol: String,
                                filled: Bool = false,
                                label: LocalizedStringKey,
                                action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(filled ? Palette.card : Palette.inkSoft)
                .frame(width: 46, height: 46)
                .background(Circle().fill(filled ? Palette.espresso : Palette.card))
                .overlay(Circle().strokeBorder(filled ? .clear : Palette.hairline, lineWidth: 0.8))
                .shadow(color: Palette.liftedShadow.opacity(0.45), radius: 9, x: 0, y: 4)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    // MARK: - 加载 / 失败 / 空

    /// 首次读取时的指示。只在还没有内容时出现——重试时上一屏保持不动。
    private var loadingCanvas: some View {
        ProgressView()
            .controlSize(.regular)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityLabel("正在读取画布")
    }

    /// 读取失败：说明 + 重试。**不是**空状态，也不清任何内容。
    private func failureBanner(_ kind: CanvasLoadFailure) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 12, weight: .medium))
            Text(kind == .nodes ? "画布内容没能读出来。" : "有些内容暂时读不到。")
                .font(TypeScale.caption)
                .lineLimit(2)
            Spacer(minLength: 8)
            Button {
                loadCanvas()
            } label: {
                Text("重新加载")
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.roast)
            }
            .buttonStyle(.plain)
        }
        .foregroundStyle(Palette.inkSoft)
        .padding(.horizontal, Metric.gutter)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity)
        .background(Palette.well)
        .overlay(alignment: .bottom) { Hairline() }
    }

    private var emptyCanvas: some View {
        VStack(spacing: 10) {
            Image(systemName: "rectangle.on.rectangle.angled")
                .font(.system(size: 22, weight: .ultraLight))
                .foregroundStyle(Palette.inkFaint)
            Text("这块画布还是空的")
                .font(TypeScale.callout)
                .foregroundStyle(Palette.inkSoft)
            Text("从记录里挑几样东西放进来，再按你的想法摆开。")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
                .multilineTextAlignment(.center)
            Button {
                showsPicker = true
            } label: {
                Text("从记录中添加")
                    .font(TypeScale.callout)
                    .foregroundStyle(Palette.roast)
            }
            .buttonStyle(.plain)
            .padding(.top, 2)
        }
        .padding(.horizontal, 40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var moreMenu: some View {
        Menu {
            Button {
                isEditing = true
            } label: {
                Label("重命名与说明", systemImage: "pencil")
            }
            Divider()
            Button(role: .destructive) {
                isConfirmingDelete = true
            } label: {
                Label("删除这块画布", systemImage: "trash")
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(Palette.roast)
        }
        .accessibilityLabel("更多操作")
    }

    // MARK: - 操作

    private func togglePlay(_ id: UUID) {
        playingNodeID = playingNodeID == id ? nil : id
    }

    private func openRecord(_ record: Record) {
        playingNodeID = nil
        openRecordSheet = record
    }

    private func zoom(by factor: CGFloat) {
        hasUserAdjusted = true
        let anchor = CGPoint(x: canvasSize.width / 2, y: canvasSize.height / 2)
        withAnimation(Motion.settle) {
            viewport = viewport.zoomed(to: viewport.scale * factor, anchor: anchor)
        }
    }

    private func add(_ records: [Record]) {
        guard !records.isEmpty else { return }
        do {
            let created = try CanvasNodeStore.add(records, to: canvas,
                                                  visibleWorldRect: visibleWorldRect,
                                                  context: context)
            guard !created.isEmpty else { return }
            nodes.append(contentsOf: created)
            loadState = .loaded
            newIDs.formUnion(created.map(\.id))
            let ids = Set(created.map(\.id))
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(1200))
                newIDs.subtract(ids)
            }
            // 记录走同一套对账：新节点没有对应记录时不会渲染成空白卡。
            reconcileRecords()
            fitIfNeeded()
        } catch {
            AppLog.store.error("canvas add failed: \(error.localizedDescription, privacy: .public)")
            actionError = L("没能把它们放进画布，请再试一次")
        }
    }

    private func remove(_ node: CanvasNode) {
        // 只有真的落库成功，才把它从渲染列表里拿掉；失败时它还在库里，
        // 界面就不该假装已经没了。
        if CanvasNodeStore.remove(node, context: context) {
            nodes.removeAll { $0.id == node.id }
            if nodes.isEmpty { loadState = .empty }
        }
        if playingNodeID == node.id { playingNodeID = nil }
    }

    private func deleteCanvas() {
        do {
            // 唯一事务入口：节点查不出来就不删画布；保存失败整体回滚。
            try CanvasNodeStore.deleteCanvas(canvas, context: context)
        } catch {
            AppLog.store.error("canvas delete failed: \(error.localizedDescription, privacy: .public)")
            actionError = L("没能删除，请再试一次")
            return
        }
        dismiss()
    }

    // MARK: - 记录与视口

    private func updateCanvasSize(_ size: CGSize) {
        guard size.width > 0, size.height > 0 else { return }
        canvasSize = size
        fitIfNeeded()
        ensureContentVisible()
    }

    /// 进入画布、重试、以及每次回到前台：读节点 → 与记录对账。
    ///
    /// 状态与内容都由 `CanvasContentLoader` 给出：读取失败时它保留上一次成功的
    /// 节点与记录缓存，只把状态标成 failed——界面因此**不会**把「读不到」
    /// 画成一块正常的空画布。
    private func loadCanvas() {
        if nodes.isEmpty { loadState = .loading }
        let next = CanvasContentLoader.load(
            canvasID: canvas.id,
            context: context,
            previous: CanvasContentLoad(nodes: nodes, recordsByID: recordsByID, state: loadState),
            simulatedFailure: CanvasDebugSeed.simulatedLoadFailure
        )
        nodes = next.nodes
        recordsByID = next.recordsByID
        loadState = next.state
        fitIfNeeded()
        ensureContentVisible()
    }

    /// 节点与源记录对账（添加节点后单独走一次，不必重读节点）。
    /// 清理只发生在**读取成功**之后，且只删确认取不到的节点。
    private func reconcileRecords() {
        let outcome = CanvasNodeReconciler.reconcile(nodes: nodes, context: context)
        guard !outcome.didFail else {
            loadState = .failed(.records)
            return
        }
        recordsByID = outcome.recordsByID
        AppLog.store.info("canvas: resolved \(recordsByID.count) record(s), purged \(outcome.purgedNodeIDs.count)")
        if !outcome.purgedNodeIDs.isEmpty {
            let purged = Set(outcome.purgedNodeIDs)
            nodes.removeAll { purged.contains($0.id) }
        }
        if nodes.isEmpty { loadState = .empty }
    }

    /// 装窗只发生在「第一次看到非空节点」时。
    ///
    /// 之前是 `didFit` 一次性开关：如果视图第一次拿到尺寸时节点还没读出来，
    /// 装窗会退化成「原点 + 100%」，等节点到了却不再装窗——坐标偏远的画布
    /// 看起来就是一块空画布。现在空集合不占用这次机会。
    private func fitIfNeeded() {
        guard canvasSize.width > 0, canvasSize.height > 0 else { return }
        guard !nodes.isEmpty else {
            if didFitContent {
                didFitContent = false
                fittedSize = .zero
                viewport = CanvasViewport()
            }
            return
        }
        if didFitContent {
            // 已装过窗：只有「尺寸变了且用户还没动过」才重新装窗。第一次布局
            // 拿到的尺寸可能只是容器给的占位值，按它算出来的视口会把整块内容
            // 推到屏幕外——看起来就是「节点不见了」。
            guard !hasUserAdjusted, fittedSize != canvasSize else { return }
        }
        fitCanvas()
    }

    private func fitCanvas() {
        guard let bounds = CanvasViewport.contentBounds(nodes.map(\.frame)) else {
            viewport = CanvasViewport()
            return
        }
        didFitContent = true
        fittedSize = canvasSize
        viewport = viewport.fitted(content: bounds, in: canvasSize)
        AppLog.store.info("canvas fit: bounds=\(String(describing: bounds), privacy: .public) size=\(String(describing: canvasSize), privacy: .public) scale=\(viewport.scale)")
    }

    /// 兜底：整块内容都被推到屏幕外时重新装窗。
    /// 这不是用户能用平移摆出来的状态（那需要把内容一直推出可视区），
    /// 只可能来自视口与真实尺寸失配，恢复它比让用户面对一块空画布好。
    private func ensureContentVisible() {
        guard canvasSize.width > 0, canvasSize.height > 0,
              let bounds = CanvasViewport.contentBounds(nodes.map(\.frame)) else { return }
        let origin = viewport.screenPoint(bounds.origin)
        let onScreen = CGRect(origin: origin,
                              size: CGSize(width: bounds.width * viewport.scale,
                                           height: bounds.height * viewport.scale))
        let visible = CGRect(origin: .zero, size: canvasSize).insetBy(dx: 24, dy: 24)
        guard !onScreen.intersects(visible) else { return }
        AppLog.store.info("canvas: content off-screen, refitting")
        fitCanvas()
    }
}

// MARK: - 世界层

/// 一次变换承载所有节点：平移/缩放只改这一层，节点自己的视图不重新定位。
private struct CanvasWorldLayer: View {

    let bounds: CGRect
    let nodes: [CanvasNode]
    let recordsByID: [UUID: Record]
    /// 记录读不到时，仍把节点画成占位卡：位置、备注、移除入口都还在。
    let showsPlaceholders: Bool
    let playingNodeID: UUID?
    let draggingNodeID: UUID?
    let newIDs: Set<UUID>
    let camera: CanvasCamera
    let onOpen: (Record) -> Void
    let onTogglePlay: (UUID) -> Void
    let onOpenSource: (Record) -> Void
    let onAnnotate: (CanvasNode) -> Void
    let onRemove: (CanvasNode) -> Void
    let onDragBegan: (UUID) -> Void
    let onDragEnded: (CanvasNode, CGSize) -> Void
    let onReload: () -> Void

    var body: some View {
        ZStack(alignment: .topLeading) {
            ForEach(nodes) { node in
                if let record = recordsByID[node.recordID] {
                    CanvasNodeLayer(
                        node: node,
                        record: record,
                        isPlaying: playingNodeID == node.id,
                        isNew: newIDs.contains(node.id),
                        camera: camera,
                        onOpen: { onOpen(record) },
                        onTogglePlay: { onTogglePlay(node.id) },
                        onOpenSource: { onOpenSource(record) },
                        onAnnotate: { onAnnotate(node) },
                        onRemove: { onRemove(node) },
                        onDragBegan: { onDragBegan(node.id) },
                        onDragEnded: { onDragEnded(node, $0) }
                    )
                    // 节点内容与视口无关：平移/缩放时跳过它们 body 的重算。
                    .equatable()
                    .frame(width: node.frame.width, height: node.frame.height)
                    .position(x: node.frame.midX - bounds.minX,
                              y: node.frame.midY - bounds.minY)
                    // 拖动的卡片临时抬到最上层；只改渲染层级，不写库。
                    .zIndex(node.id == draggingNodeID ? 10_000 : Double(node.zIndex))
                } else if showsPlaceholders {
                    // 节点还在、源记录暂时读不到：占住原来的位置，别让布局塌掉，
                    // 也别假装它不存在。
                    CanvasPlaceholderLayer(node: node,
                                           onRetry: onReload,
                                           onRemove: { onRemove(node) })
                        .frame(width: node.frame.width, height: node.frame.height)
                        .position(x: node.frame.midX - bounds.minX,
                                  y: node.frame.midY - bounds.minY)
                        .zIndex(Double(node.zIndex))
                }
            }
        }
        .frame(width: bounds.width, height: bounds.height, alignment: .topLeading)
    }
}

// MARK: - 单个节点

/// 一张节点卡：点击打开原记录、拖动移动、长按出操作菜单。
///
/// 拖动只改 `translation`（内存，**世界单位**），松手才交给存储层。
/// `Equatable` 只比较真正影响内容的东西：视口缩放、捏合状态、闭包身份都不参与，
/// 所以捏合/平移时这些卡片的 body 不会被重算。
private struct CanvasNodeLayer: View, Equatable {

    let node: CanvasNode
    let record: Record
    let isPlaying: Bool
    let isNew: Bool
    /// 实时视口参数：只在手势开始那一刻读（拖动换算 / 捏合让位）。
    let camera: CanvasCamera
    let onOpen: () -> Void
    let onTogglePlay: () -> Void
    let onOpenSource: () -> Void
    let onAnnotate: () -> Void
    let onRemove: () -> Void
    let onDragBegan: () -> Void
    /// 世界位移（已经除过缩放），调用方直接加到世界坐标上。
    let onDragEnded: (CGSize) -> Void

    @State private var translation: CGSize = .zero
    /// 拖动开始时的那一档缩放：中途视口不会变（捏合会打断拖动），
    /// 所以屏幕位移换算成世界位移只算一次。
    @State private var dragScale: CGFloat = 1
    @State private var isDragging = false
    @State private var appeared = false

    static func == (lhs: CanvasNodeLayer, rhs: CanvasNodeLayer) -> Bool {
        lhs.node.id == rhs.node.id
            && lhs.node.positionX == rhs.node.positionX
            && lhs.node.positionY == rhs.node.positionY
            && lhs.node.annotation == rhs.node.annotation
            && lhs.isPlaying == rhs.isPlaying
            && lhs.isNew == rhs.isNew
            && lhs.record.id == rhs.record.id
            && lhs.record.updatedAt == rhs.record.updatedAt
            && lhs.record.displayTitle == rhs.record.displayTitle
            && lhs.record.note == rhs.record.note
            && lhs.record.previewPath == rhs.record.previewPath
    }

    var body: some View {
        CanvasNodeCard(
            record: record,
            annotation: node.annotation,
            isPlaying: isPlaying,
            onTogglePlay: onTogglePlay,
            onOpenSource: onOpenSource
        )
        .contentShape(Rectangle())
        .onTapGesture {
            // 播放中把点击让给播放器控件：碰视频不该跳走。
            if !isPlaying { onOpen() }
        }
        .gesture(dragGesture)
        .contextMenu {
            Button { onOpen() } label: {
                Label("打开原记录", systemImage: "arrow.up.right.square")
            }
            Button { onAnnotate() } label: {
                Label("画布备注", systemImage: "text.bubble")
            }
            Divider()
            Button(role: .destructive) { onRemove() } label: {
                Label("从画布移除", systemImage: "minus.circle")
            }
        }
        .offset(x: translation.width, y: translation.height)
        .scaleEffect(appeared ? 1 : 0.97)
        .opacity(appeared ? 1 : 0)
        .onAppear {
            guard !appeared else { return }
            if isNew {
                withAnimation(.easeOut(duration: 0.18)) { appeared = true }
            } else {
                appeared = true
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(verbatim: record.displayTitle.isEmpty
                                 ? record.carrier.title
                                 : record.displayTitle))
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("打开原记录")
        .accessibilityAction(named: "打开原记录") { onOpen() }
        .accessibilityAction(named: "从画布移除") { onRemove() }
    }

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 8, coordinateSpace: .named(canvasScreenSpace))
            .onChanged { value in
                guard !camera.isPinching else { return }
                if !isDragging {
                    isDragging = true
                    dragScale = max(camera.scale, 0.001)
                    onDragBegan()
                }
                translation = CGSize(width: value.translation.width / dragScale,
                                     height: value.translation.height / dragScale)
            }
            .onEnded { _ in
                let wasDragging = isDragging
                let world = translation
                isDragging = false
                translation = .zero
                guard wasDragging, !camera.isPinching else { return }
                onDragEnded(world)
            }
    }
}

// MARK: - 读不到记录的占位卡

/// 节点读到了、源记录暂时读不到时的那张卡。
///
/// 它不是错误页：位置、尺寸、备注和移除入口都还在，只是内容暂时缺席。
/// 不创建播放器、不查库，重试由顶部提示条统一负责。
private struct CanvasPlaceholderLayer: View {

    let node: CanvasNode
    let onRetry: () -> Void
    let onRemove: () -> Void

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: "questionmark.square.dashed")
                .font(.system(size: 19, weight: .light))
                .foregroundStyle(Palette.inkFaint)
            Text("内容暂时读不到")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkSoft)
            if !node.annotation.trimmed.isEmpty {
                Text(node.annotation)
                    .font(TypeScale.micro)
                    .foregroundStyle(Palette.inkFaint)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                .fill(Palette.well.opacity(0.7))
        )
        .overlay(
            RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                .strokeBorder(Palette.hairline,
                              style: StrokeStyle(lineWidth: 0.8, dash: [4, 4]))
        )
        .contentShape(Rectangle())
        .contextMenu {
            Button { onRetry() } label: {
                Label("重新加载", systemImage: "arrow.clockwise")
            }
            Divider()
            Button(role: .destructive) { onRemove() } label: {
                Label("从画布移除", systemImage: "minus.circle")
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("内容暂时读不到"))
    }
}

// MARK: - 点阵背景

/// 轻点阵：像纸面一样随空间一起移动、一起缩放。不画网格线，密度随缩放
/// 自动收敛，放大时不会变成一张噪点图。
private struct CanvasDotGrid: View {

    let viewport: CanvasViewport

    var body: some View {
        SwiftUI.Canvas { context, size in
            guard viewport.scale > 0.01 else { return }
            // 世界间距按 2 的幂放大/缩小，让**屏幕**间距始终落在 14–40pt。
            // 缩到 35% 时点阵仍然在（旧实现直接隐藏，整块画布看着是空白的）。
            var spacing: CGFloat = 26
            while spacing * viewport.scale < 14 { spacing *= 2 }
            while spacing * viewport.scale > 40 { spacing /= 2 }
            let step = spacing * viewport.scale
            let radius: CGFloat = 1.05
            let startX = viewport.offset.width.truncatingRemainder(dividingBy: step) - step
            let startY = viewport.offset.height.truncatingRemainder(dividingBy: step) - step

            var path = Path()
            var y = startY
            while y < size.height + step {
                var x = startX
                while x < size.width + step {
                    path.addEllipse(in: CGRect(x: x - radius, y: y - radius,
                                               width: radius * 2, height: radius * 2))
                    x += step
                }
                y += step
            }
            context.fill(path, with: .color(Palette.inkFaint.opacity(0.22)))
        }
        .allowsHitTesting(false)
    }
}

// MARK: - 节点备注

/// 画布里的专属备注。它写的是 `CanvasNode.annotation`，不会碰 Record.note。
struct CanvasNodeAnnotationView: View {

    let node: CanvasNode

    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @State private var text: String

    init(node: CanvasNode) {
        self.node = node
        _text = State(initialValue: node.annotation)
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                Text("只属于这块画布，不会改动记录本身。")
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
                TextEditor(text: $text)
                    .font(TypeScale.body)
                    .scrollContentBackground(.hidden)
                    .padding(8)
                    .background(
                        RoundedRectangle(cornerRadius: Metric.radiusSmall, style: .continuous)
                            .fill(Palette.well)
                    )
                    .frame(minHeight: 160)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Metric.gutter)
            .padding(.top, 12)
            .background(Palette.paper)
            .navigationTitle("画布备注")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("取消") { dismiss() }
                        .foregroundStyle(Palette.inkSoft)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("保存") {
                        CanvasNodeStore.setAnnotation(text, on: node, context: context)
                        dismiss()
                    }
                    .foregroundStyle(Palette.roast)
                }
            }
        }
    }
}
