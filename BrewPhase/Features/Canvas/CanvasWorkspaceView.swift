import SwiftData
import SwiftUI

/// 画布屏幕坐标空间的唯一名字。手势在这个空间里拿到的是**屏幕点**，
/// 再由 `CanvasViewport` 换算成世界坐标——换算只此一处。
private let canvasScreenSpace = "canvas-screen"

/// 一块画布的工作区：自由摆放记录的地方。
///
/// 坐标分三层：节点存**世界坐标**；`CanvasWorldLayer` 是一个按世界尺寸布局的
/// 容器；整层只做一次 `scaleEffect + offset`。平移/缩放时改变的是这一层变换，
/// 而不是逐个节点重新定位——这是「整块空间一起移动」的手感来源，也是节点多
/// 起来之后仍然跟手的关键。
///
/// 手势分工：
/// * 空白处单指拖动 → 平移（松手带短惯性）；双指捏合 → 以两指中点为锚缩放；
/// * 节点单指拖动 → 移动节点，过程只改内存，松手写一次库；
/// * 单击节点 → 打开原记录；长按 → 画布备注 / 移除。
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

    init(canvas: Canvas) {
        self.canvas = canvas
        let canvasID = canvas.id
        _nodes = Query(
            filter: #Predicate<CanvasNode> { $0.canvasID == canvasID },
            sort: [SortDescriptor(\.zIndex), SortDescriptor(\.createdAt)]
        )
    }

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
        GeometryReader { _ in
            ZStack(alignment: .topLeading) {
                Palette.paper

                CanvasDotGrid(viewport: viewport)
                    .allowsHitTesting(false)

                // 空白处：单指平移。节点在自己的视图里处理拖动，不会被这里抢走。
                Color.clear
                    .contentShape(Rectangle())
                    .gesture(panGesture)

                worldLayer

                if nodes.isEmpty {
                    emptyCanvas
                }
            }
            .coordinateSpace(.named(canvasScreenSpace))
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
        .overlay(alignment: .bottomTrailing) { floatingControls }
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
        .task(id: nodeRecordIDs) { reloadRecords() }
        .onDisappear {
            // 离开画布：不留任何播放器继续出声。
            playingNodeID = nil
        }
    }

    private var nodeRecordIDs: [UUID] {
        nodes.map(\.recordID)
    }

    // MARK: - 世界层

    /// 整块世界只做一次变换。节点在层内用自己的世界坐标定位。
    private var worldLayer: some View {
        let bounds = worldBounds
        return CanvasWorldLayer(
            bounds: bounds,
            nodes: visibleNodes,
            recordsByID: recordsByID,
            playingNodeID: playingNodeID,
            draggingNodeID: draggingNodeID,
            newIDs: newIDs,
            scale: viewport.scale,
            isPinching: isPinching,
            onOpen: { openRecord($0) },
            onTogglePlay: { togglePlay($0) },
            onOpenSource: { record in
                if let url = record.openLink { openURL(url) }
            },
            onAnnotate: { annotationNode = $0 },
            onRemove: { pendingRemove = $0 },
            onDragBegan: { draggingNodeID = $0 },
            onDragEnded: { node, translation in
                draggingNodeID = nil
                guard viewport.scale > 0 else { return }
                let world = CGPoint(x: node.positionX + translation.width / viewport.scale,
                                    y: node.positionY + translation.height / viewport.scale)
                CanvasNodeStore.move(node, to: world, context: context)
            }
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
                if panBase == nil { panBase = viewport.offset }
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

    // MARK: - 悬浮控件

    private var floatingControls: some View {
        VStack(spacing: 10) {
            floatingButton(symbol: "plus", filled: true, label: "添加记录到画布") {
                showsPicker = true
            }
            floatingButton(symbol: "arrow.up.left.and.arrow.down.right",
                           label: "缩放到适合内容") {
                withAnimation(Motion.settle) { fitCanvas() }
            }
            floatingButton(symbol: "minus", label: "缩小画布") {
                zoom(by: 1 / 1.25)
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

    // MARK: - 空画布

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
            newIDs.formUnion(created.map(\.id))
            // 记录不在这里重复取：节点 ID 变化会触发上面的 .task(id:)
            // 统一读一次，避免同一次添加把同一批记录读两遍。
            let ids = Set(created.map(\.id))
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(1200))
                newIDs.subtract(ids)
            }
        } catch {
            AppLog.store.error("canvas add failed: \(error.localizedDescription, privacy: .public)")
            actionError = L("没能把它们放进画布，请再试一次")
        }
    }

    private func remove(_ node: CanvasNode) {
        CanvasNodeStore.remove(node, context: context)
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
    /// 找不到的记录（极端情况下被外部删除）对应节点直接清掉。
    private func reloadRecords() {
        let ids = Array(Set(nodes.map(\.recordID)))
        guard !ids.isEmpty else {
            recordsByID = [:]
            return
        }
        let descriptor = FetchDescriptor<Record>(predicate: #Predicate { ids.contains($0.id) })
        let found = (try? context.fetch(descriptor)) ?? []
        let mapped = Dictionary(uniqueKeysWithValues: found.map { ($0.id, $0) })
        if mapped.keys.sorted(by: { $0.uuidString < $1.uuidString })
            != recordsByID.keys.sorted(by: { $0.uuidString < $1.uuidString }) {
            recordsByID = mapped
        }

        let missing = nodes.filter { mapped[$0.recordID] == nil }
        if !missing.isEmpty {
            AppLog.store.info("canvas: dropped \(missing.count) node(s) with missing record")
            for node in missing { context.delete(node) }
            try? context.save()
        }
    }

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
}

// MARK: - 世界层

/// 一次变换承载所有节点：平移/缩放只改这一层，节点自己的视图不重新定位。
private struct CanvasWorldLayer: View {

    let bounds: CGRect
    let nodes: [CanvasNode]
    let recordsByID: [UUID: Record]
    let playingNodeID: UUID?
    let draggingNodeID: UUID?
    let newIDs: Set<UUID>
    let scale: CGFloat
    let isPinching: Bool
    let onOpen: (Record) -> Void
    let onTogglePlay: (UUID) -> Void
    let onOpenSource: (Record) -> Void
    let onAnnotate: (CanvasNode) -> Void
    let onRemove: (CanvasNode) -> Void
    let onDragBegan: (UUID) -> Void
    let onDragEnded: (CanvasNode, CGSize) -> Void

    var body: some View {
        ZStack(alignment: .topLeading) {
            ForEach(nodes) { node in
                if let record = recordsByID[node.recordID] {
                    CanvasNodeLayer(
                        node: node,
                        record: record,
                        isPlaying: playingNodeID == node.id,
                        isNew: newIDs.contains(node.id),
                        isPinching: isPinching,
                        scale: scale,
                        onOpen: { onOpen(record) },
                        onTogglePlay: { onTogglePlay(node.id) },
                        onOpenSource: { onOpenSource(record) },
                        onAnnotate: { onAnnotate(node) },
                        onRemove: { onRemove(node) },
                        onDragBegan: { onDragBegan(node.id) },
                        onDragEnded: { onDragEnded(node, $0) }
                    )
                    .frame(width: node.frame.width, height: node.frame.height)
                    .position(x: node.frame.midX - bounds.minX,
                              y: node.frame.midY - bounds.minY)
                    // 拖动的卡片临时抬到最上层；只改渲染层级，不写库。
                    .zIndex(node.id == draggingNodeID ? 10_000 : Double(node.zIndex))
                }
            }
        }
        .frame(width: bounds.width, height: bounds.height, alignment: .topLeading)
    }
}

// MARK: - 单个节点

/// 一张节点卡：点击打开原记录、拖动移动、长按出操作菜单。
///
/// 拖动只改 `translation`（内存），松手才交给存储层；卡片本身不参与视口变换，
/// 所以平移/缩放画布不会让它们逐帧重算。
private struct CanvasNodeLayer: View {

    let node: CanvasNode
    let record: Record
    let isPlaying: Bool
    let isNew: Bool
    let isPinching: Bool
    let scale: CGFloat
    let onOpen: () -> Void
    let onTogglePlay: () -> Void
    let onOpenSource: () -> Void
    let onAnnotate: () -> Void
    let onRemove: () -> Void
    let onDragBegan: () -> Void
    let onDragEnded: (CGSize) -> Void

    @State private var translation: CGSize = .zero
    @State private var isDragging = false
    @State private var appeared = false

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
        .offset(x: translation.width / max(scale, 0.001),
                y: translation.height / max(scale, 0.001))
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
                guard !isPinching else { return }
                if !isDragging {
                    isDragging = true
                    onDragBegan()
                }
                translation = value.translation
            }
            .onEnded { value in
                let wasDragging = isDragging
                isDragging = false
                translation = .zero
                guard wasDragging, !isPinching else { return }
                onDragEnded(value.translation)
            }
    }
}

// MARK: - 点阵背景

/// 轻点阵：像纸面一样随空间一起移动、一起缩放。不画网格线，密度随缩放
/// 自动收敛，放大时不会变成一张噪点图。
private struct CanvasDotGrid: View {

    let viewport: CanvasViewport

    var body: some View {
        SwiftUI.Canvas { context, size in
            let spacing = 26 * viewport.scale
            guard spacing >= 12 else { return }
            let radius: CGFloat = 1.05
            let startX = viewport.offset.width.truncatingRemainder(dividingBy: spacing) - spacing
            let startY = viewport.offset.height.truncatingRemainder(dividingBy: spacing) - spacing

            var path = Path()
            var y = startY
            while y < size.height + spacing {
                var x = startX
                while x < size.width + spacing {
                    path.addEllipse(in: CGRect(x: x - radius, y: y - radius,
                                               width: radius * 2, height: radius * 2))
                    x += spacing
                }
                y += spacing
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
