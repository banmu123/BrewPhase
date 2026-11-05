import SwiftData
import SwiftUI

/// 新建 / 重命名一块画布。
///
/// 只有两件事要填：名字，和一句说明。说明是可选的，因为「这块画布想装什么」
/// 常常是后来才想清楚的——但名字必须给，否则列表里会出现一块无名的色块。
struct CanvasEditorView: View {

    private let existing: Canvas?
    /// 在「添加」面板里由面板接管关闭；单独弹出时自己关。
    private let onSaved: (() -> Void)?

    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    @State private var name: String
    @State private var note: String
    @State private var errorMessage: String?
    @State private var didSave = false

    init(existing: Canvas? = nil, onSaved: (() -> Void)? = nil) {
        self.existing = existing
        self.onSaved = onSaved
        _name = State(initialValue: existing?.name ?? "")
        _note = State(initialValue: existing?.note ?? "")
    }

    private var isEditing: Bool { existing != nil }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    CanvasCover(name: name, height: 120)
                        .padding(.top, 6)

                    EditorSection(title: "画布") {
                        EditorRow(title: "名称") {
                            EditorTextField(placeholder: "比如 我的咖啡探索", text: $name)
                        }
                        EditorRow(title: "说明", alignsTop: true, showsDivider: false) {
                            EditorTextField(placeholder: "这块画布想装什么（可选）", text: $note)
                                .frame(minHeight: 66, alignment: .topLeading)
                        }
                    }
                    .padding(.top, 22)

                    if let errorMessage {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "info.circle").font(.system(size: 13))
                            Text(errorMessage)
                                .font(TypeScale.callout)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .foregroundStyle(Palette.priority)
                        .padding(.top, 14)
                    }

                    PrimaryButton(title: isEditing ? "保存" : "创建画布", isEnabled: !didSave) {
                        save()
                    }
                    .padding(.top, 22)
                }
                .padding(.horizontal, Metric.gutter)
                .padding(.top, 6)
                .padding(.bottom, 40)
            }
            .background(Palette.paper)
            .navigationTitle(isEditing ? "编辑画布" : "新建画布")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("取消") { dismiss() }
                        .foregroundStyle(Palette.inkSoft)
                }
            }
        }
    }

    private func save() {
        guard !didSave else { return }
        errorMessage = nil

        let trimmedName = name.trimmed
        guard !trimmedName.isEmpty else {
            errorMessage = L("给这块画布起个名字吧")
            return
        }

        let target: Canvas
        if let existing {
            target = existing
        } else {
            target = Canvas()
            context.insert(target)
        }
        target.name = trimmedName
        target.note = note.trimmed
        target.touch()

        do {
            try context.save()
        } catch {
            AppLog.store.error("canvas save failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
            errorMessage = L("没能保存下来，请再试一次")
            return
        }

        didSave = true
        if let onSaved { onSaved() } else { dismiss() }
    }
}
