import SwiftData
import SwiftUI

/// 画布 —— 一级页面之三。
///
/// 一块画布是一个自己命名的空间：先有名字和一句说明，内容下一步再往里放。
/// 这一版只把「有哪些画布」这件事做实：列表、封面、新建与详情都是真的，
/// 不存在「点进去什么都没有发生」的入口。
struct CanvasListView: View {

    @Environment(\.modelContext) private var context

    @Query(sort: \Canvas.updatedAt, order: .reverse) private var canvases: [Canvas]

    @State private var detail: Canvas?
    @State private var pendingDelete: Canvas?
    @State private var showsAdd = false

    private let columns = [
        GridItem(.flexible(), spacing: 12),
        GridItem(.flexible(), spacing: 12),
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    header

                    if canvases.isEmpty {
                        EmptyStateView(
                            symbol: "square.grid.2x2",
                            title: "还没有画布",
                            message: "画布是一个自己命名的空间，用来把咖啡与记录里的东西放在一起。",
                            actionLabel: "新建画布",
                            action: { showsAdd = true }
                        )
                        .padding(.top, 40)
                    } else {
                        LazyVGrid(columns: columns, alignment: .leading, spacing: 12) {
                            ForEach(canvases) { canvas in
                                Button {
                                    detail = canvas
                                } label: {
                                    CanvasCard(canvas: canvas)
                                }
                                .buttonStyle(CardButtonStyle())
                                .contextMenu {
                                    Button(role: .destructive) {
                                        pendingDelete = canvas
                                    } label: {
                                        Label("删除这块画布", systemImage: "trash")
                                    }
                                }
                            }
                        }
                        .padding(.top, 18)
                    }
                }
                .padding(.horizontal, Metric.gutter)
                .padding(.top, 6)
                .padding(.bottom, 28)
            }
            .background(Palette.paper)
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(item: $detail) { canvas in
                CanvasDetailView(canvas: canvas)
            }
            .sheet(isPresented: $showsAdd) {
                AddSheet()
            }
            .confirmationDialog(
                "删除这块画布？",
                isPresented: Binding(
                    get: { pendingDelete != nil },
                    set: { if !$0 { pendingDelete = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("删除", role: .destructive) {
                    if let canvas = pendingDelete { delete(canvas) }
                    pendingDelete = nil
                }
                Button("取消", role: .cancel) { pendingDelete = nil }
            } message: {
                Text("删除后不可恢复。")
            }
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 5) {
                Text("画布")
                    .font(TypeScale.display)
                    .foregroundStyle(Palette.ink)

                if !canvases.isEmpty {
                    Text(L("%@ 块", String(canvases.count)))
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkFaint)
                }
            }

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
            .accessibilityLabel("新建画布")
        }
        .padding(.top, 10)
    }

    private func delete(_ canvas: Canvas) {
        context.delete(canvas)
        do {
            try context.save()
        } catch {
            AppLog.store.error("canvas delete failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
        }
    }
}

/// 画布详情：名字、说明、创建时间，以及「内容」这一块目前的位置。
///
/// 内容聚合还没有接入持久化，所以这里如实留白：不摆假条目，也不放一个点了
/// 没反应的「添加内容」。能做的事只有两件——改名字，或者删掉它。
struct CanvasDetailView: View {

    let canvas: Canvas

    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    @State private var isEditing = false
    @State private var isConfirmingDelete = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                CanvasCover(name: canvas.name, height: 168)
                    .padding(.top, 6)

                Text(LocalizedStringKey.alreadyLocalized(canvas.displayName))
                    .font(TypeScale.beanName)
                    .foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 18)

                if !canvas.note.trimmed.isEmpty {
                    Text(canvas.note)
                        .font(TypeScale.callout)
                        .foregroundStyle(Palette.inkSoft)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 8)
                }

                Text(L("创建于 %@", Fmt.precise(canvas.createdAt, calendar: DateMath.calendar)))
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
                    .padding(.top, 10)

                Hairline().padding(.top, 24)

                SectionLabel(title: "内容")
                    .padding(.top, 18)

                Text("这块画布还是空的。")
                    .font(TypeScale.callout)
                    .foregroundStyle(Palette.inkFaint)
                    .padding(.top, 10)

                Button(role: .destructive) {
                    isConfirmingDelete = true
                } label: {
                    Text("删除这块画布")
                        .font(TypeScale.callout)
                        .foregroundStyle(Palette.priority)
                }
                .buttonStyle(.plain)
                .padding(.top, 32)
            }
            .padding(.horizontal, Metric.gutter)
            .padding(.bottom, 40)
        }
        .background(Palette.paper)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("编辑") { isEditing = true }
                    .font(TypeScale.callout)
                    .foregroundStyle(Palette.roast)
            }
        }
        .sheet(isPresented: $isEditing) {
            CanvasEditorView(existing: canvas)
        }
        .confirmationDialog("删除这块画布？", isPresented: $isConfirmingDelete,
                            titleVisibility: .visible) {
            Button("删除", role: .destructive) { delete() }
            Button("取消", role: .cancel) {}
        } message: {
            Text("删除后不可恢复。")
        }
    }

    private func delete() {
        context.delete(canvas)
        do {
            try context.save()
        } catch {
            AppLog.store.error("canvas delete failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
            return
        }
        dismiss()
    }
}
