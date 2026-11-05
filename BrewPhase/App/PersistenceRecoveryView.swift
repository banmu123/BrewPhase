import SwiftData
import SwiftUI
import UIKit

/// 本地数据库的两种姿态。
///
/// 刻意只有两种，没有第三种「能用但不落盘」的中间态——那种状态在界面上无法
/// 诚实表达，只能等用户自己发现，而这正是这一版要消灭的东西。
enum PersistenceState {
    /// 持久化容器已经打开，应用可以正常读写。
    case ready(ModelContainer)
    /// 容器打不开。应用停在这里：不读、不写、不假装。
    case failed
}

/// 打不开本地数据库时，App 唯一的界面。
///
/// 它背后的决定只有一条：**宁可什么都不做，也不假装保存成功**。所以这个页面
/// 没有任何写操作——没有「先记着、以后再导」，没有设置项。底层错误留在日志里。
///
/// 但「不写」不等于「什么都不给」：数据库打不开时，用户在别处也没有第二次
/// 机会。这里提供的唯一动作是**把原始数据库文件导出**（复制一份，原件不动），
/// 让记录还能被带走、被支持人员接手。这不是备份功能，是最后一条出口。
struct PersistenceRecoveryView: View {

    /// 「重新尝试」要做的事：重建持久化容器。成功时这个视图会随状态切换消失；
    /// 仍然失败则留在原地——用户看到的还是同一句「打不开」，这就是反馈本身。
    let onRetry: () -> Void

    @State private var share: StoreFiles?
    @State private var exportFailure: String?

    /// 分享面板要的一组文件 URL。
    private struct StoreFiles: Identifiable {
        let id = UUID()
        let urls: [URL]
    }

    var body: some View {
        ZStack {
            Palette.paper.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Image(systemName: "externaldrive.badge.exclamationmark")
                        .font(.system(size: 30, weight: .light))
                        .foregroundStyle(Palette.latte)

                    VStack(alignment: .leading, spacing: 8) {
                        Text("无法打开本地数据")
                            .font(TypeScale.cardTitle)
                            .foregroundStyle(Palette.ink)

                        Text("BrewPhase 暂时无法访问已有记录。\n为了避免数据丢失，当前不会保存新的数据。")
                            .font(TypeScale.body)
                            .foregroundStyle(Palette.inkSoft)
                            .lineSpacing(3)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    PrimaryButton(title: "重新尝试", systemImage: "arrow.clockwise", action: onRetry)

                    VStack(alignment: .leading, spacing: 8) {
                        SecondaryButton(title: "导出数据文件", systemImage: "square.and.arrow.up") {
                            exportDataFiles()
                        }
                        Text("导出的文件就是数据库本身，不是备份。先保存到「文件」App，再重装或联系支持时都用得上。")
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.inkFaint)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    if let exportFailure {
                        Text(exportFailure)
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.priority)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Text("如果问题持续存在，请先确认设备存储空间正常。")
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkFaint)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 28)
                .padding(.vertical, 32)
                .frame(maxWidth: 420, alignment: .leading)
            }
        }
        .sheet(item: $share) { files in
            ActivitySheet(items: files.urls)
                .presentationDetents([.medium, .large])
        }
    }

    /// 复制一份数据库文件再交给分享面板。原件不动——导出失败也不该让情况更糟。
    private func exportDataFiles() {
        exportFailure = nil
        do {
            let folder = try StoreRecovery.archive(to: FileManager.default.temporaryDirectory)
            share = StoreFiles(urls: StoreRecovery.storeFiles(in: folder))
        } catch {
            AppLog.store.error("store export failed: \(String(describing: error), privacy: .public)")
            exportFailure = L("没能导出数据文件。请确认设备还有可用空间，然后再试一次。")
        }
    }
}

/// `UIActivityViewController` 的薄包装。
///
/// 用系统分享面板而不是 `ShareLink`：这里要一次交出一组文件（`.store` 与两个
/// 旁路日志），少一个都不完整，而分享面板能一次收下全部。
private struct ActivitySheet: UIViewControllerRepresentable {

    let items: [URL]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
