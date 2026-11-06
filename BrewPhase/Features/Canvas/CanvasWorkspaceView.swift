import SwiftData
import SwiftUI

/// 一块画布的工作区：自由摆放记录的地方。
///
/// 坐标系分两层——节点存**世界坐标**，视口存 `scale/offset`。手势只改视口或
/// 节点自己的世界坐标，绝不把屏幕像素写进模型：换个屏幕尺寸、换个缩放比例，
/// 节点之间的相对位置仍然是用户摆的那个样子。
///
/// 手势分工（冲突是这类页面的头号问题）：
/// * 空白处单指拖动 → 平移视口；双指捏合 → 以两指中点为锚缩放（任意位置可捏）；
/// * 节点上的单指拖动 → 移动节点；拖动过程只改内存偏移，松手才写库；
/// * 点击节点 → 选中；双击 → 打开原记录。
/// 捏合开始后节点拖动会让位（`isPinching`），不会一边缩放一边把卡片拖走。
struct CanvasWorkspaceView: View {

    let canvas: Canvas

    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    /// 只取这块画布的节点：画布多起来时，不该把所有节点都读进内存。
    @Query private var nodes: [CanvasNode]

    @State private var recordsByID: [UUID: Record] = [:]
    @State private var viewport = CanvasViewport()
    @State private var canvasSize: CGSize = .zero
    @State private var didFit = false

    @State private var selectedNodeID: UUID?
    @State private var playingNodeID: UUID?
    @State private var draggingNodeID: UUID?

    @State private var isPinching = false
    @State private var magnifyBase: CanvasViewport?
    @State private var panBase: CGSize?

    @State private var showsPicker = false
    @State private var isEditing = false
    @State private var isConfirmingDelete = false
    @State private var annotationNode: CanvasNode?
    @State private var pendingRemove: CanvasNode?
    @State private var actionError: String?
    /// 「打开原记录」用同一层导航推详情，而不是另开一个 sheet——
    /// 详情页的工具栏与返回按钮都依赖外层的 NavigationStack。
    @State private var openRecordSheet: Record?

    init(canvas: Canvas) {
        self.canvas = canvas
        let canvasID = canvas.id
        _nodes = Query(
            filter: #Predicate<CanvasNode> { $0.canvasID == canvasID },
            sort: [SortDescriptor(\.zIndex), SortDescriptor(\.createdAt)]
        )
    }

    /// 当前视口覆盖的世界矩形——新节点落位、可见性裁剪都用它。
    private var visibleWorldRect: CGRect {
        viewport.worldRect(in: canvasSize)
    }

    private var selectedNode: CanvasNode? {
        nodes.first { $0.id == selectedNodeID }
    }

    /// 只渲染视口附近的节点：画布上可能有上百个节点，屏幕外的卡片不该
    /// 常驻视图树（更不该为它们保留任何播放器）。留 20% 的余量，拖动到
    /// 边缘时不会闪。
    private var visibleNodes: [CanvasNode] {
        let rect = visibleWorldRect
        guard rect.width > 0, rect.height > 0 else { return [] }
        let margin = CGRect(x: rect.minX - rect.width * 0.2,
                            y: rect.minY - rect.height * 0.2,
                            width: rect.width * 1.4,
                            height: rect.height * 1.4)
        // 正在拖或刚选中的节点必须留在树里：拖到边缘时被裁掉会中断手势，
        // 松手的落点就丢了。
        let pinned = Set([selectedNodeID, draggingNodeID].compactMap { $0 })
        return nodes.filter { margin.intersects($0.frame) || pinned.contains($0.id) }
    }

    var body: some View {
        GeometryReader { geo in
            ZStack {
                Palette.paper

                // 空白处：平移 + 取消选择。放在节点下层，节点的拖动不会被抢走。
                Color.clear
                    .contentShape(Rectangle())
                    .gesture(panGesture)
                    .onTapGesture { select(nil) }

                ForEach(visibleNodes) { node in
                    if let record = recordsByID[node.recordID] {
                        nodeLayer(node: node, record: record)
                    }
                }

                if nodes.isEmpty {
                    emptyCanvas
                }
            }
            .simultaneousGesture(magnifyGesture)
            .onGeometryChange(for: CGSize.self) { $0.size } action: { size in
                canvasSize = size
                fitIfNeeded()
            }
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
        .safeAreaInset(edge: .bottom) { bottomBar }
        .sheet(isPresented: $showsPicker, onDismiss: reloadRecords) {
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
        .task(id: nodeRecordIDs) { reloadRecords() }
        .onDisappear {
            // 离开画布：不留任何播放器继续出声。
            playingNodeID = nil
        }
    }

    private var nodeRecordIDs: [UUID] {
        nodes.map(\.recordID)
    }

    // MARK: - 节点层

    private func nodeLayer(node: CanvasNode, record: Record) -> some View {
        // 定位在 CanvasNodeLayer 内部完成（它知道自己被拖动时的偏移）。
        // 这里**只**给层级：外层再 .position 一次会把整层坐标系搬走。
        CanvasNodeLayer(
            node: node,
            record: record,
            viewport: viewport,
            isSelected: selectedNodeID == node.id,
            isPlaying: playingNodeID == node.id,
            isPinching: isPinching,
            onSelect: { select(node.id) },
            onOpen: { openRecord(record) },
            onTogglePlay: { togglePlay(node.id) },
            onOpenSource: {
                if let url = record.openLink { openURL(url) }
            },
            onDragBegan: {
                draggingNodeID = node.id
                select(node.id)
            },
            onDragEnded: { translation in
                draggingNodeID = nil
                guard viewport.scale > 0 else { return }
                let world = CGPoint(x: node.positionX + translation.width / viewport.scale,
                                    y: node.positionY + translation.height / viewport.scale)
                CanvasNodeStore.move(node, to: world, context: context)
            }
        )
        .zIndex(selectedNodeID == node.id || draggingNodeID == node.id ? 10_000 : Double(node.zIndex))
    }

    // MARK: - 手势

    private var panGesture: some Gesture {
        DragGesture(minimumDistance: 6)
            .onChanged { value in
                guard !isPinching else { return }
                let base = panBase ?? viewport.offset
                if panBase == nil { panBase = viewport.offset }
                viewport.offset = CGSize(width: base.width + value.translation.width,
                                         height: base.height + value.translation.height)
            }
            .onEnded { _ in
                panBase = nil
            }
    }

    private var magnifyGesture: some Gesture {
        MagnifyGesture(minimumScaleDelta: 0.01)
            .onChanged { value in
                isPinching = true
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

    // MARK: - 底部

    @ViewBuilder
    private var bottomBar: some View {
        if let node = selectedNode, let record = recordsByID[node.recordID] {
            selectedBar(node: node, record: record)
        } else {
            canvasBar
        }
    }

    private var canvasBar: some View {
        HStack(spacing: Metric.Space.sm) {
            Button {
                showsPicker = true
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "plus")
                        .font(.system(size: 12, weight: .semibold))
                    Text("添加记录")
                        .font(TypeScale.callout.weight(.medium))
                }
                .foregroundStyle(Palette.card)
                .padding(.horizontal, 16)
                .padding(.vertical, 11)
                .background(Capsule(style: .continuous).fill(Palette.espresso))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("添加记录到画布")

            Spacer(minLength: 0)

            Button {
                withAnimation(Motion.settle) { fitCanvas() }
            } label: {
                Text(verbatim: "\(Int((viewport.scale * 100).rounded()))%")
                    .font(TypeScale.caption.monospacedDigit())
                    .foregroundStyle(Palette.inkSoft)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(Capsule(style: .continuous).fill(Palette.card))
                    .overlay(Capsule(style: .continuous).strokeBorder(Palette.hairline, lineWidth: 0.8))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("缩放到适合内容")
        }
        .padding(.horizontal, Metric.gutter)
        .padding(.bottom, 10)
        .padding(.top, 6)
        .background(Palette.paper)
        .overlay(alignment: .top) { Hairline() }
    }

    private func selectedBar(node: CanvasNode, record: Record) -> some View {
        HStack(spacing: 4) {
            selectionButton(title: "打开", systemImage: "arrow.up.right.square") {
                openRecord(record)
            }
            selectionButton(title: "备注", systemImage: "text.bubble") {
                annotationNode = node
            }
            selectionButton(title: "移除", systemImage: "minus.circle", role: .destructive) {
                pendingRemove = node
            }
            Spacer(minLength: 0)
            selectionButton(title: "完成", systemImage: "xmark") {
                select(nil)
            }
        }
        .padding(.horizontal, Metric.gutter)
        .padding(.vertical, 6)
        .background(Palette.paper)
        .overlay(alignment: .top) { Hairline() }
    }

    private func selectionButton(title: LocalizedStringKey,
                                 systemImage: String,
                                 role: ButtonRole? = nil,
                                 action: @escaping () -> Void) -> some View {
        Button(role: role, action: action) {
            VStack(spacing: 3) {
                Image(systemName: systemImage)
                    .font(.system(size: 15, weight: .regular))
                Text(title)
                    .font(TypeScale.micro)
            }
            .foregroundStyle(role == .destructive ? Palette.priority : Palette.inkSoft)
            .frame(width: 56, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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
        .allowsHitTesting(true)
    }

    // MARK: - 操作

    private func select(_ id: UUID?) {
        selectedNodeID = id
        // 换了焦点就不再让上一个节点继续出声。
        if id == nil || id != playingNodeID { playingNodeID = nil }
    }

    private func togglePlay(_ id: UUID) {
        playingNodeID = playingNodeID == id ? nil : id
    }

    private func openRecord(_ record: Record) {
        playingNodeID = nil
        // 用同一层导航推详情：详情页的工具栏/返回按钮依赖外层 NavigationStack，
        // 塞进一个裸 sheet 会把右上角菜单藏掉。
        openRecordSheet = record
    }

    private func add(_ records: [Record]) {
        guard !records.isEmpty else { return }
        do {
            try CanvasNodeStore.add(records, to: canvas, visibleWorldRect: visibleWorldRect, context: context)
            reloadRecords()
        } catch {
            AppLog.store.error("canvas add failed: \(error.localizedDescription, privacy: .public)")
            actionError = L("没能把它们放进画布，请再试一次")
        }
    }

    private func remove(_ node: CanvasNode) {
        CanvasNodeStore.remove(node, context: context)
        if selectedNodeID == node.id { selectedNodeID = nil }
        if playingNodeID == node.id { playingNodeID = nil }
    }

    private func deleteCanvas() {
        CanvasNodeStore.deleteNodes(in: canvas.id, context: context)
        context.delete(canvas)
        do {
            try context.save()
        } catch {
            AppLog.store.error("canvas delete failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
            actionError = L("没能删除，请再试一次")
            return
        }
        dismiss()
    }

    // MARK: - 记录与视口

    /// 按节点引用的 ID 取记录，不把整张记录表读进内存。
    /// 找不到的记录（极端情况下被外部删除、旧备份遗留）对应的节点直接清掉，
    /// 不留一个点开就空白的节点。
    private func reloadRecords() {
        let ids = Array(Set(nodes.map(\.recordID)))
        guard !ids.isEmpty else {
            recordsByID = [:]
            return
        }
        let descriptor = FetchDescriptor<Record>(predicate: #Predicate { ids.contains($0.id) })
        let found = (try? context.fetch(descriptor)) ?? []
        recordsByID = Dictionary(uniqueKeysWithValues: found.map { ($0.id, $0) })

        let missing = nodes.filter { recordsByID[$0.recordID] == nil }
        if !missing.isEmpty {
            AppLog.store.info("canvas: dropped \(missing.count) node(s) with missing record")
            for node in missing { context.delete(node) }
            try? context.save()
        }
    }

    /// 第一次拿到尺寸时把内容装进窗口；之后尺寸变化（旋屏）不再打扰用户
    /// 已经调好的视口，只保留节点自己的世界坐标。
    private func fitIfNeeded() {
        guard !didFit, canvasSize.width > 0, canvasSize.height > 0 else { return }
        didFit = true
        fitCanvas()
    }

    private func fitCanvas() {
        guard let bounds = CanvasViewport.contentBounds(nodes.map(\.frame)) else {
            viewport = CanvasViewport()
            return
        }
        viewport = viewport.fitted(content: bounds, in: canvasSize)
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
}

// MARK: - 单个节点的定位与手势

/// 负责「这张节点卡在世界里的哪个屏幕位置」以及拖动/点击。
///
/// 拖动过程中只改 `translation`（内存），松手才把屏幕位移换算成世界位移交给
/// 上层；因此一次拖动只产生**一次** SwiftData 写入，而不是每一帧一次。
private struct CanvasNodeLayer: View {

    let node: CanvasNode
    let record: Record
    let viewport: CanvasViewport
    let isSelected: Bool
    let isPlaying: Bool
    let isPinching: Bool
    let onSelect: () -> Void
    let onOpen: () -> Void
    let onTogglePlay: () -> Void
    let onOpenSource: () -> Void
    let onDragBegan: () -> Void
    let onDragEnded: (CGSize) -> Void

    @State private var translation: CGSize = .zero
    @State private var isDragging = false

    private var frame: CGRect { node.frame }

    var body: some View {
        CanvasNodeCard(
            record: record,
            annotation: node.annotation,
            isPlaying: isPlaying,
            isSelected: isSelected,
            onTogglePlay: onTogglePlay,
            onOpenSource: onOpenSource
        )
        .frame(width: frame.width, height: frame.height)
        .overlay(
            RoundedRectangle(cornerRadius: CanvasNodeCard.cornerRadius, style: .continuous)
                .strokeBorder(Palette.roast.opacity(isSelected ? 0.55 : 0), lineWidth: 1.2)
        )
        .scaleEffect(viewport.scale, anchor: .topLeading)
        // 手势与可访问性必须挂在缩放后的卡片上，**在 .position 之前**：
        // .position 会把视图撑满父级，挂到它后面等于整块画布都是热区。
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { onOpen() }
        .onTapGesture { onSelect() }
        .gesture(dragGesture)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(verbatim: record.displayTitle.isEmpty
                                 ? record.carrier.title
                                 : record.displayTitle))
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
        .accessibilityHint("双击打开原记录")
        .accessibilityAction(named: "打开原记录") { onOpen() }
        .position(x: viewport.screenPoint(frame.origin).x + frame.width / 2 + translation.width,
                  y: viewport.screenPoint(frame.origin).y + frame.height / 2 + translation.height)
    }

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                guard !isPinching else { return }
                if !isDragging {
                    isDragging = true
                    onDragBegan()
                }
                translation = value.translation
            }
            .onEnded { value in
                isDragging = false
                translation = .zero
                guard !isPinching else { return }
                onDragEnded(value.translation)
            }
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
                    Button("保存") { save() }
                        .foregroundStyle(Palette.roast)
                }
            }
        }
    }

    private func save() {
        node.annotation = text.trimmed
        node.touch()
        do {
            try context.save()
        } catch {
            AppLog.store.error("canvas annotation failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
            return
        }
        dismiss()
    }
}
