import SwiftData
import SwiftUI

/// 编辑器里的标签选择：一排可以点选的标签，加一个「新建」。
///
/// 标签是可选项——不选也能保存。这里只负责「贴哪几个」，改名和删除在
/// `TagManagerView` 里做，两个入口分开，避免在一个小格子里塞满操作。
struct TagPickerSection: View {

    let allTags: [RecordTag]
    @Binding var selected: [RecordTag]
    var onManage: () -> Void

    @Environment(\.modelContext) private var context
    @State private var isCreating = false
    @State private var newName = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                SectionLabel(title: "标签")
                Spacer(minLength: 0)
                Button(action: onManage) {
                    Text("管理")
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkFaint)
                }
                .buttonStyle(.plain)
            }

            Card(padding: 14) {
                FlowLayout(spacing: 7, lineSpacing: 7) {
                    ForEach(allTags) { tag in
                        chip(tag)
                    }
                    newTagChip
                }
            }
        }
        .alert("新建标签", isPresented: $isCreating) {
            TextField("标签名", text: $newName)
            Button("创建") { create() }
            Button("取消", role: .cancel) { newName = "" }
        } message: {
            Text("标签由你定义，可以随时改名或删掉。")
        }
    }

    private func chip(_ tag: RecordTag) -> some View {
        let isOn = selected.contains { $0.id == tag.id }
        return Button {
            if isOn {
                selected.removeAll { $0.id == tag.id }
            } else {
                selected.append(tag)
            }
        } label: {
            Text(LocalizedStringKey.alreadyLocalized(tag.displayName))
                .font(TypeScale.caption)
                .foregroundStyle(isOn ? Palette.card : Palette.inkSoft)
                .lineLimit(1)
                .padding(.horizontal, 11)
                .padding(.vertical, 7)
                .background(
                    Capsule(style: .continuous)
                        .fill(isOn ? Palette.espresso : Palette.well)
                )
        }
        .buttonStyle(.plain)
        .animation(Motion.quick, value: isOn)
        .accessibilityAddTraits(isOn ? [.isSelected] : [])
    }

    private var newTagChip: some View {
        Button {
            newName = ""
            isCreating = true
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "plus")
                    .font(.system(size: 9, weight: .bold))
                Text("新标签")
                    .font(TypeScale.caption)
            }
            .foregroundStyle(Palette.roast)
            .padding(.horizontal, 11)
            .padding(.vertical, 7)
            .background(
                Capsule(style: .continuous)
                    .strokeBorder(Palette.latte.opacity(0.5), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private func create() {
        let name = newName.trimmed
        newName = ""
        guard !name.isEmpty else { return }

        if let match = allTags.first(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) {
            if !selected.contains(where: { $0.id == match.id }) { selected.append(match) }
            return
        }
        let tag = RecordTag(name: name)
        context.insert(tag)
        try? context.save()
        selected.append(tag)
    }
}

/// 标签管理：改名、删除、新建，以及每个标签被多少条记录用过。
///
/// 删除一个标签只解除它和记录的关联——记录一条都不会少。这句话在确认框里
/// 说清楚，因为「删标签」听起来像是会删内容。
struct TagManagerView: View {

    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    @Query(sort: \RecordTag.createdAt) private var tags: [RecordTag]

    @State private var renaming: RecordTag?
    @State private var renameText = ""
    @State private var deleting: RecordTag?
    @State private var isCreating = false
    @State private var createText = ""
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text("标签由你定义。六个建议标签只是起点——改成自己的说法、删掉用不上的，都可以。")
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkFaint)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.bottom, 14)

                    if tags.isEmpty {
                        Text("还没有标签。")
                            .font(TypeScale.callout)
                            .foregroundStyle(Palette.inkSoft)
                            .padding(.vertical, 20)
                    } else {
                        Card(padding: 0) {
                            VStack(spacing: 0) {
                                ForEach(Array(tags.enumerated()), id: \.element.id) { index, tag in
                                    row(tag)
                                    if index != tags.count - 1 { CardDivider() }
                                }
                            }
                        }
                    }

                    Button {
                        createText = ""
                        isCreating = true
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "plus")
                                .font(.system(size: 11, weight: .semibold))
                            Text("新建标签")
                                .font(TypeScale.callout)
                        }
                        .foregroundStyle(Palette.roast)
                        .padding(.vertical, 16)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)

                    if let errorMessage {
                        Text(errorMessage)
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.priority)
                    }
                }
                .padding(.horizontal, Metric.gutter)
                .padding(.top, 14)
                .padding(.bottom, 32)
            }
            .background(Palette.paper)
            .navigationTitle("标签")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                        .foregroundStyle(Palette.roast)
                }
            }
            .alert("重命名标签", isPresented: renamingBinding) {
                TextField("标签名", text: $renameText)
                Button("保存") { commitRename() }
                Button("取消", role: .cancel) { renaming = nil }
            }
            .alert("新建标签", isPresented: $isCreating) {
                TextField("标签名", text: $createText)
                Button("创建") { commitCreate() }
                Button("取消", role: .cancel) { createText = "" }
            }
            .confirmationDialog(
                "删除这个标签？",
                isPresented: Binding(
                    get: { deleting != nil },
                    set: { if !$0 { deleting = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("删除", role: .destructive) {
                    if let tag = deleting { delete(tag) }
                    deleting = nil
                }
                Button("取消", role: .cancel) { deleting = nil }
            } message: {
                Text("标签会从所有记录上移除，记录本身不受影响。")
            }
        }
    }

    private func row(_ tag: RecordTag) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(LocalizedStringKey.alreadyLocalized(tag.displayName))
                    .font(TypeScale.body)
                    .foregroundStyle(Palette.ink)
                Text(L("%@ 条记录", String(tag.usageCount)))
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
            }

            Spacer(minLength: 8)

            Menu {
                Button {
                    renameText = tag.name
                    renaming = tag
                } label: {
                    Label("重命名", systemImage: "pencil")
                }
                Button(role: .destructive) {
                    deleting = tag
                } label: {
                    Label("删除", systemImage: "trash")
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Palette.inkFaint)
                    .frame(width: 34, height: 34)
                    .contentShape(Rectangle())
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(minHeight: 56)
        .contentShape(Rectangle())
        .onTapGesture {
            renameText = tag.name
            renaming = tag
        }
    }

    private var renamingBinding: Binding<Bool> {
        Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })
    }

    // MARK: - 动作

    private func commitRename() {
        guard let tag = renaming else { return }
        let name = renameText.trimmed
        renaming = nil
        guard !name.isEmpty else { return }
        // 重名会让筛选条上出现两个一模一样的词，直接拒绝并说清楚。
        if tags.contains(where: { $0.id != tag.id && $0.name.caseInsensitiveCompare(name) == .orderedSame }) {
            errorMessage = L("已经有一个同名标签了")
            return
        }
        errorMessage = nil
        tag.name = name
        persist()
    }

    private func commitCreate() {
        let name = createText.trimmed
        createText = ""
        guard !name.isEmpty else { return }
        guard !tags.contains(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) else {
            errorMessage = L("已经有一个同名标签了")
            return
        }
        errorMessage = nil
        context.insert(RecordTag(name: name))
        persist()
    }

    /// 删除标签只解除关联：`Record.tags` 是多对多，记录不会跟着走。
    private func delete(_ tag: RecordTag) {
        context.delete(tag)
        persist()
    }

    private func persist() {
        do {
            try context.save()
        } catch {
            AppLog.store.error("tag change failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
            errorMessage = L("没能保存下来，请再试一次")
        }
    }
}
