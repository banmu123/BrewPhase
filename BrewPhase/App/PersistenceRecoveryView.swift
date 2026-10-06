import SwiftData
import SwiftUI

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
/// 不提供任何数据操作——没有「先记着、以后再导」，没有设置项，只有一句解释、
/// 一次重试、和一条用户能自己动手的建议。底层错误留在日志里，不摆到这里吓人。
struct PersistenceRecoveryView: View {

    /// 「重新尝试」要做的事：重建持久化容器。成功时这个视图会随状态切换消失；
    /// 仍然失败则留在原地——用户看到的还是同一句「打不开」，这就是反馈本身。
    let onRetry: () -> Void

    var body: some View {
        ZStack {
            Palette.paper.ignoresSafeArea()

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

                Text("如果问题持续存在，请先确认设备存储空间正常。")
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 28)
            .frame(maxWidth: 420, alignment: .leading)
        }
    }
}
