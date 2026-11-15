import CoreGraphics
import Foundation

/// Gravity Cards：一个空间分区内每张卡片的临时运动状态。
///
/// position 是**相对原始堆叠位置的偏移**（pt），不是绝对坐标——原始布局
/// （负间距叠放、深度下沉）由 `WorkspaceStackLayout` 拥有，物理层只叠加
/// 位移。这样倾斜交互永远不会改布局计算，按钮语义、可点区域、ScrollView
/// 尺寸都保持原样。
///
/// 按 `WorkspaceCard.Identity` 索引（见 `WorkspacePhysicsEngine`），不按
/// 数组下标：内容增删后卡片不会继承别人的位置。
struct WorkspaceCardMotionState {

    /// 相对原始位置的偏移。
    var offset: CGPoint

    /// 速度（pt/s）。
    var velocity: CGVector

    /// 轻微旋转（弧度）。
    var rotation: CGFloat

    /// 已自然停止。settled 后跳过该卡的全部计算，直到新的重力输入唤醒。
    var settled: Bool

    /// 连续满足静止条件的步数。
    var settleStreak: Int

    /// 这张卡的个性参数（由堆叠深度决定，稳定、可复现）。
    ///
    /// 声明为 `var` 只为「上面的卡被删、这张卡上移一层」时跟着换一档；
    /// 值本身永远来自 `WorkspaceMotionSettings`，不随机。
    var responsiveness: CGFloat
    var extraFriction: CGFloat

    init(
        offset: CGPoint = .zero,
        velocity: CGVector = .zero,
        rotation: CGFloat = 0,
        settled: Bool = false,
        settleStreak: Int = 0,
        responsiveness: CGFloat = 1,
        extraFriction: CGFloat = 0
    ) {
        self.offset = offset
        self.velocity = velocity
        self.rotation = rotation
        self.settled = settled
        self.settleStreak = settleStreak
        self.responsiveness = responsiveness
        self.extraFriction = extraFriction
    }

    /// 从原始状态重新开始（离开首页 / 重新进入）。
    mutating func reset() {
        self = WorkspaceCardMotionState(
            responsiveness: responsiveness,
            extraFriction: extraFriction
        )
    }
}

/// Gravity Cards：一个分区允许卡片移动的范围。
///
/// 行程不是拍脑袋的常数：水平方向以「页面内容左右留白」为池、垂直方向以
/// 「与相邻分区的间距」为池，再被 `WorkspaceMotionSettings` 的上限收窄
/// （推导见 `WorkspaceGravityTravel.homeBounds`）。空间隔离因此是结构性的
/// ——Coffee 的引擎只知道 Coffee 自己的边界，卡片物理上无处可去别的分区。
struct WorkspaceGravityBounds {

    /// 每个方向从原始位置出发的单侧最大距离（pt）。
    var horizontalTravel: CGFloat
    var verticalTravel: CGFloat

    /// 空态 / 未知布局时的退化：不动。
    static let none = WorkspaceGravityBounds(horizontalTravel: 0, verticalTravel: 0)
}
