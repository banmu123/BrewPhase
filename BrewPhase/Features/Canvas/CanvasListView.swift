import SwiftData
import SwiftUI

/// 画布 —— 一级页面之三。
///
/// 一块画布是一个自己命名的空间：列表回答「有哪些画布」，点进去是可自由
/// 摆放记录的工作区（`CanvasWorkspaceView`）。画布本身不复制记录内容，
/// 只通过 `CanvasNode` 引用它们。
struct CanvasListView: View {

    @Environment(\.modelContext) private var context

    @Query(sort: \Canvas.updatedAt, order: .reverse) private var canvases: [Canvas]

    @State private var detail: Canvas?
    @State private var pendingDelete: Canvas?
    @State private var showsCreate = false

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
                            action: { showsCreate = true }
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
                CanvasWorkspaceView(canvas: canvas)
            }
            .sheet(isPresented: $showsCreate) {
                CanvasEditorView()
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
                showsCreate = true
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
        // 画布与它的节点一起消失；节点只删引用，不碰任何 Record。
        CanvasNodeStore.deleteNodes(in: canvas.id, context: context)
        context.delete(canvas)
        do {
            try context.save()
        } catch {
            AppLog.store.error("canvas delete failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
        }
    }
}
