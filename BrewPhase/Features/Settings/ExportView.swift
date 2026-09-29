import SwiftData
import SwiftUI

/// 导出 (§34).
///
/// JSON is the complete, restorable backup; CSV is the version you can open in a
/// spreadsheet. Both are written to a temp folder and handed to the system share
/// sheet — the app never uploads anything, and it never asks where to put it.
struct ExportView: View {

    @Environment(\.modelContext) private var context
    @Query private var beans: [Bean]
    @Query private var rules: [PhaseRule]

    @State private var bundle: ExportBundle?
    @State private var jsonURL: URL?
    @State private var csvURLs: [URL] = []
    @State private var failure: String?

    private var hasData: Bool { !(bundle?.beans.isEmpty ?? true) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metric.sectionGap) {
                summary
                jsonSection
                csvSection
                privacyNote

                if let failure {
                    Text(failure)
                        .font(TypeScale.callout)
                        .foregroundStyle(Palette.priority)
                        .padding(.horizontal, 4)
                }
            }
            .padding(.horizontal, Metric.gutter)
            .padding(.top, 8)
            .padding(.bottom, 40)
        }
        .background(Palette.paper)
        .navigationTitle("导出")
        .navigationBarTitleDisplayMode(.inline)
        .task { build() }
        .onDisappear { ExportManager.cleanupTemporaryFiles() }
    }

    // MARK: - Sections

    private var summary: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("把记录带走")
                .font(TypeScale.title)
                .foregroundStyle(Palette.ink)
            Text("导出的文件只保存在这台设备上，通过系统分享面板发给你自己。BrewPhase 不会上传任何东西。")
                .font(TypeScale.callout)
                .foregroundStyle(Palette.inkSoft)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)

            if let bundle {
                HStack(spacing: 0) {
                    count(bundle.beans.count, "豆子")
                    divider
                    count(bundle.brews.count, "冲煮")
                    divider
                    count(bundle.tastings.count, "风味")
                    divider
                    count(bundle.phaseRules.count, "规则")
                }
                .padding(.vertical, 13)
                .frame(maxWidth: .infinity)
                .background(
                    RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                        .fill(Palette.card)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                        .strokeBorder(Palette.hairline.opacity(0.9), lineWidth: 0.7)
                )
            }
        }
        .padding(.top, 4)
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

    @ViewBuilder
    private var jsonSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "完整备份")
            if let jsonURL {
                shareRow(
                    title: "导出 JSON",
                    detail: "包含豆子、冲煮、风味、提醒和窗口规则",
                    url: jsonURL
                )
            } else {
                placeholderRow
            }
        }
    }

    @ViewBuilder
    private var csvSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "表格", detail: "可以用 Excel 打开")
            if csvURLs.count == 3 {
                VStack(spacing: 12) {
                    shareRow(title: "豆子清单", detail: "beans.csv", url: csvURLs[0])
                    shareRow(title: "冲煮记录", detail: "brews.csv", url: csvURLs[1])
                    shareRow(title: "风味记录", detail: "tastings.csv", url: csvURLs[2])
                }
            } else {
                placeholderRow
            }
        }
    }

    /// `title` is copy to translate; `detail` is sometimes a file name, which
    /// passes through the lookup unchanged because it has no entry.
    private func shareRow(title: LocalizedStringKey, detail: LocalizedStringKey, url: URL) -> some View {
        Card(padding: 0) {
            ShareLink(item: url) {
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
                    Image(systemName: "square.and.arrow.up")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Palette.roast)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .frame(minHeight: 56)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    private var placeholderRow: some View {
        Card {
            Text("正在准备文件…")
                .font(TypeScale.callout)
                .foregroundStyle(Palette.inkFaint)
        }
    }

    private var privacyNote: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "说明")
            Text(hasData
                 ? "导出的 JSON 可以完整还原你的记录。CSV 只包含豆子、冲煮和风味三张表，方便做统计。"
                 : "现在还没有记录。空数据也可以导出，出来的是一份结构完整、内容为空的文件。")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 4)
        }
    }

    // MARK: - Building

    private func build() {
        failure = nil
        do {
            let built = ExportManager.build(beans: beans, rules: rules)
            bundle = built

            jsonURL = try ExportManager.writeJSON(built)

            // Written eagerly rather than on tap: ShareLink needs a real file URL
            // to hand over, and building three small strings up front is cheaper
            // than the state machine an async version would need.
            csvURLs = try ExportManager.csvTables(built).map { try ExportManager.writeCSV($0) }

            AppLog.export.info("exported \(built.totalRecords) record(s)")
        } catch {
            failure = L("导出时出了一点问题，请再试一次")
            AppLog.export.error("export failed: \(error.localizedDescription, privacy: .public)")
        }
    }
}
