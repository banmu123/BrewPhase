import SwiftData
import SwiftUI

/// 从 Records 里挑素材放进画布。
///
/// 复用 `RecordsDataSource` 的分页与搜索：记录多起来时不会把整张表读进内存，
/// 搜索也仍然走数据库谓词。画布只拿「被选中的那几条」，不接管 Records 的
/// 页面状态，也不会创建新的 Record。
struct CanvasRecordPicker: View {

    let canvas: Canvas
    let onAdd: ([Record]) -> Void

    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    @State private var dataSource: RecordsDataSource?
    @State private var searchText = ""
    @State private var carrier: RecordCarrier?
    /// 已在本画布里的记录：显示为「已在画布」，不能再选。
    @State private var existing: Set<UUID> = []
    /// 选择跨筛选保留：换一个载体看，之前勾的不会丢。
    @State private var picked: [Record] = []
    @State private var pickedIDs: Set<UUID> = []

    private var queryKey: String {
        searchText + "|" + (carrier?.rawValue ?? "")
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                filters
                Divider().overlay(Palette.hairline)
                list
            }
            .background(Palette.paper)
            .navigationTitle("添加记录")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("取消") { dismiss() }
                        .foregroundStyle(Palette.inkSoft)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(addButtonTitle) { add() }
                        .disabled(picked.isEmpty)
                        .foregroundStyle(picked.isEmpty ? Palette.inkFaint : Palette.roast)
                }
            }
            .task {
                existing = CanvasNodeStore.existingRecordIDs(in: canvas.id, context: context)
            }
            .task(id: queryKey) {
                try? await Task.sleep(for: .milliseconds(200))
                guard !Task.isCancelled else { return }
                reload()
            }
        }
    }

    private var addButtonTitle: String {
        picked.isEmpty ? L("加入画布") : L("加入 %@", String(picked.count))
    }

    // MARK: - 筛选

    private var filters: some View {
        VStack(spacing: 10) {
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

            ScrollView(.horizontal) {
                HStack(spacing: 7) {
                    FilterChip(title: L("全部"), isOn: carrier == nil) { carrier = nil }
                    ForEach(RecordCarrier.allCases) { item in
                        FilterChip(title: item.title, isOn: carrier == item) {
                            carrier = carrier == item ? nil : item
                        }
                    }
                }
                .padding(.vertical, 1)
            }
            .scrollIndicators(.hidden)
            .scrollClipDisabled()
        }
        .padding(.horizontal, Metric.gutter)
        .padding(.top, 10)
        .padding(.bottom, 12)
    }

    // MARK: - 列表

    @ViewBuilder
    private var list: some View {
        if let dataSource {
            if dataSource.records.isEmpty {
                emptyState
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(dataSource.records) { record in
                            row(record)
                            Divider().overlay(Palette.hairline)
                        }
                        if dataSource.canLoadMore {
                            ProgressView()
                                .padding(.vertical, 16)
                                .onAppear { dataSource.loadMore() }
                        }
                    }
                    .padding(.bottom, 20)
                }
            }
        } else {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Text("没有匹配的记录。")
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
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.vertical, 60)
    }

    private func row(_ record: Record) -> some View {
        let already = existing.contains(record.id)
        let isOn = pickedIDs.contains(record.id)

        return Button {
            guard !already else { return }
            toggle(record)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: record.carrier == .link ? record.provider.symbol : record.carrier.symbol)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(RecordPresentation.tint(record.carrier))
                    .frame(width: 22)

                VStack(alignment: .leading, spacing: 3) {
                    Text(.alreadyLocalized(record.displayTitle.isEmpty ? record.carrier.title : record.displayTitle))
                        .font(TypeScale.bodyMedium)
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                    Text(verbatim: subtitle(for: record))
                        .font(TypeScale.micro)
                        .foregroundStyle(Palette.inkFaint)
                        .lineLimit(1)
                }

                Spacer(minLength: 8)

                if already {
                    Text("已在画布")
                        .font(TypeScale.micro)
                        .foregroundStyle(Palette.inkFaint)
                } else {
                    Image(systemName: isOn ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 17, weight: .regular))
                        .foregroundStyle(isOn ? Palette.roast : Palette.inkFaint.opacity(0.5))
                }
            }
            .padding(.horizontal, Metric.gutter)
            .padding(.vertical, 11)
            .contentShape(Rectangle())
            .opacity(already ? 0.5 : 1)
        }
        .buttonStyle(.plain)
        .disabled(already)
        .accessibilityLabel(Text(verbatim: record.displayTitle.isEmpty ? record.carrier.title : record.displayTitle))
        .accessibilityValue(already ? Text("已在画布") : (isOn ? Text("已选择") : Text("未选择")))
    }

    private func subtitle(for record: Record) -> String {
        switch record.carrier {
        case .link:
            return record.providerLabel ?? record.linkHost ?? record.urlString
        case .text:
            return record.note.trimmed.split(separator: "\n").first.map(String.init) ?? ""
        case .image, .video:
            return record.note.trimmed.isEmpty ? record.carrier.title : record.note.trimmed
        }
    }

    // MARK: - 数据

    private func reload() {
        if dataSource == nil {
            dataSource = RecordsDataSource(context: context)
        }
        dataSource?.reload(query: RecordsQuery(searchText: searchText, carrier: carrier))
    }

    private func toggle(_ record: Record) {
        if let index = picked.firstIndex(where: { $0.id == record.id }) {
            picked.remove(at: index)
            pickedIDs.remove(record.id)
        } else {
            picked.append(record)
            pickedIDs.insert(record.id)
        }
    }

    private func add() {
        guard !picked.isEmpty else { return }
        onAdd(picked)
        dismiss()
    }
}
