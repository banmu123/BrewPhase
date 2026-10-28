import SwiftData
import SwiftUI
import UniformTypeIdentifiers

/// 完整备份与恢复。
///
/// 和「导出」页的分工：那边的 JSON/CSV 是给你看、给表格用的；这里生成的是
/// **能还原整台设备状态**的单文件备份（含图片），并负责把它安全地恢复回来。
///
/// 恢复只做「替换」：先选文件 → 验证并展示摘要 → 用户明确确认 → 才动数据。
/// 选完文件就删记录是不允许的，所以确认之前所有步骤都是只读的。
struct BackupView: View {

    @Environment(\.modelContext) private var context
    @Query private var beans: [Bean]
    @Query private var rules: [PhaseRule]

    @State private var backupURL: URL?
    @State private var isBuilding = false
    @State private var buildFailure: String?

    @State private var isPickingFile = false
    @State private var isValidating = false
    @State private var pending: PendingRestore?
    @State private var isRestoring = false
    @State private var restoreFailure: String?
    @State private var outcome: BackupRestorer.Outcome?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metric.sectionGap) {
                intro
                backupSection
                restoreSection

                if let buildFailure {
                    message(buildFailure)
                }
                if let restoreFailure {
                    message(restoreFailure)
                }
            }
            .padding(.horizontal, Metric.gutter)
            .padding(.top, 8)
            .padding(.bottom, 40)
        }
        .background(Palette.paper)
        .navigationTitle("完整备份")
        .navigationBarTitleDisplayMode(.inline)
        .fileImporter(isPresented: $isPickingFile,
                      allowedContentTypes: [.data],
                      allowsMultipleSelection: false) { result in
            handlePicked(result)
        }
        .sheet(item: $pending) { item in
            summarySheet(item)
                .presentationDetents([.medium, .large])
        }
        .alert("恢复完成", isPresented: outcomeBinding) {
            Button("好的", role: .cancel) { outcome = nil }
        } message: {
            if let outcome {
                Text(L("已恢复 %@ 包豆子、%@ 条冲煮记录、%@ 条风味记录。",
                       String(outcome.beans), String(outcome.brews), String(outcome.tastings)))
            }
        }
        .overlay {
            if isRestoring {
                restoringOverlay
            }
        }
    }

    // MARK: - Sections

    private var intro: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("把整个豆仓带走")
                .font(TypeScale.title)
                .foregroundStyle(Palette.ink)
            Text("完整备份把豆子、冲煮、风味、提醒、窗口规则和图片打包成一个文件。换手机或重装后，用它一次恢复。文件只保存在你选择的位置，BrewPhase 不会上传。")
                .font(TypeScale.callout)
                .foregroundStyle(Palette.inkSoft)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 4)
    }

    private var backupSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "备份")
            Card(padding: 0) {
                VStack(spacing: 0) {
                    Button {
                        build()
                    } label: {
                        row(title: isBuilding ? "正在打包…" : "生成完整备份",
                            detail: "含图片 · 可在另一台设备恢复",
                            systemImage: "archivebox")
                    }
                    .buttonStyle(.plain)
                    .disabled(isBuilding)

                    if let backupURL {
                        CardDivider()
                        ShareLink(item: backupURL) {
                            row(title: "保存完整备份文件",
                                detail: .alreadyLocalized(backupURL.lastPathComponent),
                                systemImage: "square.and.arrow.up")
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private var restoreSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "恢复", detail: "会替换当前数据")
            Card(padding: 0) {
                Button {
                    isPickingFile = true
                } label: {
                    row(title: isValidating ? "正在检查备份…" : "从备份恢复…",
                        detail: "先检查文件，确认后才会替换",
                        systemImage: "arrow.down.doc")
                }
                .buttonStyle(.plain)
                .disabled(isValidating || isRestoring)
            }

            Text("恢复会清空这台设备上的现有记录，并替换成备份里的内容。这一步无法撤销，确认前不会修改任何数据。")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.priority)
                .padding(.horizontal, 4)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func row(title: LocalizedStringKey,
                     detail: LocalizedStringKey,
                     systemImage: String) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(TypeScale.body)
                    .foregroundStyle(Palette.ink)
                Text(detail)
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
            }
            Spacer(minLength: 8)
            Image(systemName: systemImage)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Palette.roast)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(minHeight: 56)
        .contentShape(Rectangle())
    }

    private func message(_ text: String) -> some View {
        Text(text)
            .font(TypeScale.callout)
            .foregroundStyle(Palette.priority)
            .padding(.horizontal, 4)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var restoringOverlay: some View {
        ZStack {
            Palette.paper.opacity(0.85).ignoresSafeArea()
            VStack(spacing: 10) {
                ProgressView()
                Text("正在恢复…")
                    .font(TypeScale.callout)
                    .foregroundStyle(Palette.inkSoft)
            }
            .padding(24)
            .background(RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                .fill(Palette.card))
        }
    }

    // MARK: - 备份

    private func build() {
        guard !isBuilding else { return }
        buildFailure = nil
        backupURL = nil

        // 快照在主线程上一次取完（含偏好）；编码和写盘放到后台，避免大文件卡住界面。
        let data = BackupManager.snapshot(beans: beans, rules: rules)
        let preferences = BackupManager.preferences()
        let images = ImageStore.shared.directoryURL
        isBuilding = true

        Task {
            do {
                let url = try await Task.detached(priority: .userInitiated) {
                    try BackupManager.write(data,
                                            preferences: preferences,
                                            appVersion: ExportManager.appVersion,
                                            imagesDirectory: images)
                }.value
                backupURL = url
            } catch {
                buildFailure = backupFailureText(error)
                AppLog.export.error("backup failed: \(String(describing: error), privacy: .public)")
            }
            isBuilding = false
        }
    }

    private func backupFailureText(_ error: Error) -> String {
        if let backup = error as? BackupError { return backup.localizedDescription }
        return L("备份没有完成，请再试一次。")
    }

    // MARK: - 恢复

    private func handlePicked(_ result: Result<[URL], Error>) {
        restoreFailure = nil
        switch result {
        case .failure:
            restoreFailure = L("没能打开这个文件，请再选一次。")
        case .success(let urls):
            guard let url = urls.first else { return }
            isValidating = true
            Task {
                do {
                    let file = try await Task.detached(priority: .userInitiated) {
                        try BackupManager.read(from: url)
                    }.value
                    pending = PendingRestore(file: file, url: url)
                } catch {
                    restoreFailure = backupFailureText(error)
                    AppLog.export.error("backup validation failed: \(String(describing: error), privacy: .public)")
                }
                isValidating = false
            }
        }
    }

    private func summarySheet(_ item: PendingRestore) -> some View {
        let summary = item.file.manifest.summary
        let size = (try? item.url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        return VStack(alignment: .leading, spacing: 16) {
            Text("备份摘要")
                .font(TypeScale.title)
                .foregroundStyle(Palette.ink)

            VStack(spacing: 10) {
                summaryRow("创建时间", value: dateText(item.file.manifest.createdDate))
                summaryRow("App 版本", value: item.file.manifest.appVersion)
                summaryRow("文件大小", value: byteText(size))
            }

            HStack(spacing: 0) {
                count(summary.beans, "豆子")
                divider
                count(summary.brews, "冲煮")
                divider
                count(summary.tastings, "风味")
                divider
                count(summary.attachments, "图片")
            }
            .padding(.vertical, 12)
            .background(RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                .fill(Palette.card))

            Text("继续会用它替换这台设备上的全部记录。现有数据不会保留，也无法撤销。")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.priority)
                .fixedSize(horizontal: false, vertical: true)

            Spacer(minLength: 0)

            VStack(spacing: 10) {
                Button {
                    restore(item)
                } label: {
                    Text("替换并恢复")
                        .font(TypeScale.bodyMedium)
                        .frame(maxWidth: .infinity, minHeight: 48)
                }
                .buttonStyle(.borderedProminent)
                .tint(Palette.priority)

                Button {
                    pending = nil
                } label: {
                    Text("取消")
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Palette.inkSoft)
            }
        }
        .padding(20)
        .background(Palette.paper)
    }

    private func summaryRow(_ title: LocalizedStringKey, value: String) -> some View {
        HStack {
            Text(title)
                .font(TypeScale.callout)
                .foregroundStyle(Palette.inkSoft)
            Spacer()
            Text(verbatim: value)
                .font(TypeScale.callout)
                .foregroundStyle(Palette.ink)
        }
    }

    private func count(_ value: Int, _ label: LocalizedStringKey) -> some View {
        VStack(spacing: 4) {
            Text(verbatim: String(value))
                .font(TypeScale.numeral)
                .foregroundStyle(Palette.ink)
            Text(label)
                .font(TypeScale.micro)
                .foregroundStyle(Palette.inkFaint)
        }
        .frame(maxWidth: .infinity)
    }

    private var divider: some View {
        Rectangle()
            .fill(Palette.hairline)
            .frame(width: 0.7, height: 24)
    }

    private func restore(_ item: PendingRestore) {
        pending = nil
        isRestoring = true
        restoreFailure = nil
        let container = context.container
        let images = ImageStore.shared.directoryURL

        Task {
            do {
                let result = try await Task.detached(priority: .userInitiated) {
                    try BackupRestorer.restore(item.file, into: container, imagesDirectory: images)
                }.value
                outcome = result
            } catch {
                restoreFailure = (error as? BackupError)?.localizedDescription
                    ?? L("恢复没有完成，原有数据保持不动。")
                AppLog.export.error("restore failed: \(String(describing: error), privacy: .public)")
            }
            isRestoring = false
        }
    }

    private var outcomeBinding: Binding<Bool> {
        Binding(get: { outcome != nil }, set: { if !$0 { outcome = nil } })
    }

    // MARK: - Formatting

    private func dateText(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        return formatter.string(from: date)
    }

    private func byteText(_ bytes: Int) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(bytes))
    }

    // MARK: - Sheet model

    private struct PendingRestore: Identifiable {
        let id = UUID()
        let file: BackupFile
        let url: URL
    }
}
