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
                do {
                    existing = try CanvasNodeStore.existingRecordIDs(in: canvas.id, context: context)
                } catch {
                    // 读不出来就暂时不标「已在画布」：真的重复选到同一条，
                    // `CanvasNodeStore.add` 的那次读取会再去重，不会产生重复节点。
                    AppLog.store.error("canvas picker: existing node load failed — \(error.localizedDescription, privacy: .public)")
                }
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
            HStack(spacing: 12) {
                // 先看到内容，再读标题：图片/视频/网页给缩略图，文字给几行正文，
                // 找东西靠「认得出来」，不是靠读一串标题。
                CanvasPickerThumbnail(record: record)

                VStack(alignment: .leading, spacing: 4) {
                    Text(.alreadyLocalized(record.displayTitle.isEmpty ? record.carrier.title : record.displayTitle))
                        .font(TypeScale.bodyMedium)
                        .foregroundStyle(Palette.ink)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
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
                        .font(.system(size: 18, weight: .regular))
                        .foregroundStyle(isOn ? Palette.roast : Palette.inkFaint.opacity(0.5))
                }
            }
            .padding(.horizontal, Metric.gutter)
            .padding(.vertical, 10)
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

// MARK: - 选择器里的内容缩略图

/// 一条记录在「添加记录」面板里的小样：只读本地缓存，不建播放器、不请求网络。
private struct CanvasPickerThumbnail: View {

    let record: Record
    private let side: CGFloat = 64

    var body: some View {
        ZStack {
            switch record.carrier {
            case .image:
                picture(record.mediaPath, symbol: "photo")
            case .video:
                ZStack {
                    picture(record.previewPath, symbol: "video")
                    Image(systemName: "play.fill")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Palette.card)
                        .padding(7)
                        .background(Circle().fill(Palette.espresso.opacity(0.72)))
                }
            case .link:
                picture(record.previewPath, symbol: record.provider.symbol)
            case .text:
                textLines
            }
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(Palette.hairline, lineWidth: 0.7)
        )
    }

    @ViewBuilder
    private func picture(_ path: String?, symbol: String) -> some View {
        if let image = ImageStore.shared.image(named: path, thumbnail: true) {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: side, height: side)
                .clipped()
        } else {
            ZStack {
                Palette.well
                Image(systemName: symbol)
                    .font(.system(size: 15, weight: .light))
                    .foregroundStyle(RecordPresentation.tint(record.carrier).opacity(0.75))
            }
        }
    }

    /// 文字记录没有图：用几行「正文形状」的细线表示，和画布缩略图同一套语言。
    private var textLines: some View {
        VStack(alignment: .leading, spacing: 4) {
            Capsule().fill(Palette.inkSoft.opacity(0.5)).frame(height: 3)
            Capsule().fill(Palette.inkFaint.opacity(0.42)).frame(height: 2)
            Capsule().fill(Palette.inkFaint.opacity(0.42)).frame(height: 2)
            Capsule().fill(Palette.inkFaint.opacity(0.30)).frame(width: side * 0.45, height: 2)
            Spacer(minLength: 0)
        }
        .padding(10)
        .frame(width: side, height: side, alignment: .topLeading)
        .background(Palette.card)
    }
}
