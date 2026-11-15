import SwiftUI

/// 桌面同步入口：一条极简状态行，不是功能卡片。
///
/// 未配对 / 已配对 / 同步中 / 同步失败共用同一行布局，只换图标色、标题
/// 与辅助行；行本身透明、无边框、无按钮胶囊。
///
/// 它原先在咖啡页里，现在归首页：桌面端是三个空间共同的外围入口，
/// 不该长在咖啡这一栏下面。
struct DesktopSyncEntryRow: View {
    @ObservedObject var sync: SyncManager
    @Environment(\.modelContext) private var context
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if pairedDevice != nil {
                pairedRow
                    .transition(.opacity)
            } else {
                unpairedRow
                    .transition(.opacity)
            }
        }
        // 只在状态类别变化时过渡；同步进度刷新不改变 stage，不会重放动画。
        .animation(reduceMotion ? Motion.fade : Motion.standard, value: stage)
    }

    // MARK: 状态派生

    private enum Stage { case unpaired, paired, syncing, failed }

    private var stage: Stage {
        guard pairedDevice != nil else { return .unpaired }
        if isSyncing { return .syncing }
        if isFailed { return .failed }
        return .paired
    }

    private var isSyncing: Bool {
        switch sync.phase {
        case .preparing, .sendingData, .sendingMedia: return true
        default: return false
        }
    }

    private var isFailed: Bool {
        if case .failed = sync.phase { return true }
        return false
    }

    /// 生产路径读 Keychain；只有带 `-BrewPhaseScreen` 的 UI inspection 才
    /// 回退到展示用设备（与 DesktopSyncView 同一份数据），方便截图验收。
    private var pairedDevice: (host: String, port: Int, deviceId: String, token: String)? {
        sync.pairedDevice() ?? SyncInspection.placeholderDevice
    }

    private var deviceName: String {
        if let inspection = SyncInspection.deviceName, sync.pairedDevice() == nil {
            return inspection
        }
        let stored = SyncKeychain.string(forKey: "desktop.deviceName") ?? ""
        return stored.isEmpty ? "BrewPhase Desktop" : stored
    }

    private var iconColor: Color {
        switch stage {
        case .unpaired: return Palette.inkFaint
        case .paired: return Palette.moss
        case .syncing: return Palette.roast
        case .failed: return Palette.priority
        }
    }

    // MARK: 各状态

    private var unpairedRow: some View {
        NavigationLink {
            DesktopSyncView()
        } label: {
            entryRow(
                title: { Text("桌面空间") },
                subtitle: { Text("尚未配对 · 连接桌面端") },
                showsChevron: true
            )
        }
        .buttonStyle(CardButtonStyle())
    }

    private var pairedRow: some View {
        HStack(spacing: Metric.Space.xs) {
            NavigationLink {
                DesktopSyncView()
            } label: {
                entryRow(
                    title: { Text(verbatim: deviceName) },
                    subtitle: { pairedSubtitle },
                    showsChevron: true
                )
            }
            .buttonStyle(CardButtonStyle())

            // 重试是独立 Button，不嵌在 NavigationLink 里：一次点按只做一件事。
            if isFailed {
                Button {
                    Task { await sync.syncNow(context: context) }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Palette.roast)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(isSyncing)
                .accessibilityLabel(Text("重试"))
            }
        }
    }

    @ViewBuilder private var pairedSubtitle: some View {
        if isSyncing, let status = sync.compactStatus {
            HStack(spacing: 6) {
                ProgressView()
                    .controlSize(.mini)
                Text(LocalizedStringKey.alreadyLocalized(status))
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkSoft)
            }
        } else if isFailed {
            Text("已配对 · 同步失败")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.priority)
        } else if let last = sync.lastSyncAt {
            Text(LocalizedStringKey.alreadyLocalized(L("已配对 · 上次同步 %@", Fmt.dayTime(last))))
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
        } else {
            Text("已配对 · 尚未同步")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
        }
    }

    // MARK: 共用行布局

    private func entryRow<Title: View, Subtitle: View>(
        @ViewBuilder title: () -> Title,
        @ViewBuilder subtitle: () -> Subtitle,
        showsChevron: Bool
    ) -> some View {
        HStack(spacing: Metric.Space.sm) {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Palette.well)
                .frame(width: 32, height: 32)
                .overlay(
                    Image(systemName: "laptopcomputer.and.iphone")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(iconColor)
                )

            VStack(alignment: .leading, spacing: 2) {
                title()
                    .font(TypeScale.bodyMedium)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                subtitle()
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Palette.inkFaint)
            }
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}
