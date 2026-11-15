import CoreGraphics
import Foundation
import Observation
import SwiftUI

/// Gravity Cards：首页重力交互的唯一协调者。
///
/// 它把「传感器输入」「三个分区的物理引擎」「时间线是否该继续跑」收在一处：
///
/// - 引擎按 `AppTab` 分开，边界各自独立 → 卡片物理上不可能跨区（空间隔离
///   不是靠渲染层裁剪，而是引擎根本不知道别人的边界）。
/// - 重力方向由控制器写入，**不参与观察**（30Hz 写不触发任何视图刷新）。
/// - 只有 `isQuiescent`（无重力 + 全部卡片 settled）是可观察的，它的翻转
///   让宿主把 `TimelineView` 暂停/唤醒——静止后零计算，倾斜时立刻恢复。
@MainActor
@Observable
final class WorkspaceGravityField {

    /// 是否完全静止。时间线据此暂停：静止后不再有任何逐帧计算。
    private(set) var isQuiescent = true

    /// 当前屏幕平面重力方向（归一化）。不参与观察。
    @ObservationIgnored private(set) var gravity: CGVector = .zero

    /// 每个分区一个引擎。
    @ObservationIgnored private(set) var engines: [AppTab: WorkspacePhysicsEngine]

    /// 已排队一次静止状态翻转，避免逐帧重复排队。
    @ObservationIgnored private var flipPending = false

    init(bounds: WorkspaceGravityBounds = WorkspaceGravityTravel.homeBounds) {
        engines = Dictionary(
            uniqueKeysWithValues: AppTab.allCases.map {
                ($0, WorkspacePhysicsEngine(bounds: bounds))
            }
        )
    }

    // MARK: - 输入

    /// 控制器给出的新方向。非零 = 有新输入，必须唤醒时间线。
    func setGravity(_ newGravity: CGVector) {
        gravity = newGravity
        if newGravity != .zero, isQuiescent {
            isQuiescent = false
        }
    }

    /// 暂停输入但保留惯性：滚动 / 键盘期间卡片自然滑停。
    func calm() {
        gravity = .zero
        for engine in engines.values { engine.calmGravity() }
    }

    /// 内容对账（按稳定 ID，新卡从原位进入）。
    func reconcile(cards: [WorkspaceCard], for space: AppTab) {
        engines[space]?.reconcile(cards: cards)
    }

    /// 把「卡片数量 + 卡片区域实际宽度」交给该分区的引擎。
    ///
    /// 单卡片会拿到「走满整行」的行程，多卡片继续用保守边界（Phase 2.1）。
    /// 边界变小时引擎会把越界的偏移夹回并清掉该方向的速度。
    func setBounds(
        cardCount: Int,
        isEmpty: Bool,
        availableWidth: CGFloat,
        for space: AppTab
    ) {
        let bounds = WorkspaceGravityTravel.bounds(
            cardCount: cardCount,
            isEmpty: isEmpty,
            availableWidth: availableWidth
        )
        engines[space]?.update(bounds: bounds)
    }

    // MARK: - 帧驱动

    /// 时间线每帧调用一次：推进三个引擎，必要时把「已静止」翻上去。
    ///
    /// 翻转走一次 `Task` 跳到下一轮 runloop：视图更新期间改可观察状态会
    /// 触发 SwiftUI 的循环告警，而这只是「要不要继续跑」的一次性通知。
    func step(at date: Date) {
        let timestamp = date.timeIntervalSinceReferenceDate
        for engine in engines.values {
            engine.advance(gravity: gravity, timestamp: timestamp)
        }

        let nowQuiescent = gravity == .zero
            && engines.values.allSatisfy(\.allSettled)
        guard nowQuiescent != isQuiescent, !flipPending else { return }

        flipPending = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.flipPending = false
            self.isQuiescent = nowQuiescent
        }
    }

    /// 某张卡当前的渲染偏移与旋转。
    ///
    /// `frame` 只用来建立 SwiftUI 依赖：引擎状态不是可观察对象，卡片是否
    /// 重画由宿主时间线传入的帧令牌驱动（`TimelineView` 每帧给新值）。
    func render(
        for id: WorkspaceCard.Identity,
        in space: AppTab,
        at frame: Date
    ) -> (offset: CGPoint, rotation: CGFloat) {
        _ = frame
        return engines[space]?.render(for: id) ?? (.zero, 0)
    }

    /// 不带帧令牌的查询（测试与内部使用）。
    func render(
        for id: WorkspaceCard.Identity,
        in space: AppTab
    ) -> (offset: CGPoint, rotation: CGFloat) {
        engines[space]?.render(for: id) ?? (.zero, 0)
    }

    // MARK: - 生命周期

    /// 离开首页 / 关闭重力：清空全部临时物理状态
    /// （下次进入从原始堆叠开始）。
    func reset() {
        gravity = .zero
        for engine in engines.values { engine.clearAll() }
        isQuiescent = true
    }
}
