import CoreGraphics
import Foundation

/// Gravity Cards 的全部可调参数。集中一处，不散落在视图里。
///
/// 这些是**调试起点**，不是产品定论：真实手感只能在真机上校。任何一处
/// 调参都该只改这个文件。
enum WorkspaceMotionSettings {

    // MARK: 传感器

    /// 设备姿态采样频率（Hz）。30Hz 足够描述一次手部倾斜，再高只是耗电。
    static let motionUpdateHz: Double = 30

    /// 姿态低通系数（0…1，越大越跟手）。倾斜是慢动作，不需要跟住每一次抖动。
    static let gravitySmoothing: Double = 0.35

    /// 倾斜死区（弧度）。参考姿态附近的轻微晃动不产生运动——
    /// 手持时的天然抖动大约在这个量级以下。
    static let tiltDeadZone: Double = 3.5 * .pi / 180

    /// 死区外的输入按原始幅度线性传入（不放大、不阶梯化）。
    static let tiltMaxRadians: Double = 25 * .pi / 180

    // MARK: 运动范围

    /// 最大水平位移（pt）。实际行程还要被空间可用留白收窄（见
    /// `WorkspaceGravityBounds.travel`）——配置只是上限。
    static let maxHorizontalTravel: CGFloat = 16

    /// 最大垂直位移（pt）。垂直方向侵入了标题与相邻分区的领地，只给一半。
    static let maxVerticalTravel: CGFloat = 8

    // MARK: 动力学

    /// 重力加速度尺度（pt/s² per 单位归一化重力）。配合摩擦决定了
    /// 「倾斜后大约多久到达边界」。全部卡片共享同一个值，差异在
    /// 每张卡自己的响应系数上。
    static let gravityScale: CGFloat = 260

    /// 速度上限（pt/s）。防止长倾斜把卡片加速成弹射。
    static let maxSpeed: CGFloat = 240

    /// 每秒速度保留比例（0…1）。0.9 ≈ 倾斜停止后 1 秒内速度衰减到一半以下，
    /// 有滑行的惯性感，又不会拖着不走。
    static let frictionPerSecond: CGFloat = 0.10

    /// 软边界：进入缓冲区后每秒额外吸收的速度比例。
    static let boundaryDamping: CGFloat = 6.0

    /// 软边界缓冲宽度（pt）。边界前减速，而不是撞上反弹。
    static let boundaryBuffer: CGFloat = 4

    // MARK: 卡片个性

    /// 同一分区内，第 depth 张卡（0 = 最前）的响应系数。
    ///
    /// 深处的卡更「重」：响应略小、摩擦略大，像压在底下的纸。差异必须
    /// **稳定**（由 depth 决定，不随机），且同一个 depth 在三个空间里
    /// 是同一套值——不能让某个空间的卡天生跑得更远。
    static func responsiveness(forDepth depth: Int) -> CGFloat {
        switch max(depth, 0) {
        case 0: return 1.0
        case 1: return 0.85
        default: return 0.72
        }
    }

    /// 深层卡每秒多保留的速度比例（额外的静摩擦感）。
    static func extraFriction(forDepth depth: Int) -> CGFloat {
        switch max(depth, 0) {
        case 0: return 0
        case 1: return 0.04
        default: return 0.09
        }
    }

    // MARK: 旋转

    /// 最大旋转角（弧度，约 1.3°）。本阶段的主角是滑动，旋转只是纸感的余韵。
    static let maxRotation: CGFloat = 1.3 * .pi / 180

    /// 旋转对水平速度的敏感度（弧度 per pt/s）。
    static let rotationPerSpeed: CGFloat = 0.0032

    // MARK: settled 判定

    /// 速度低于此值视为静止（pt/s）。
    static let settleSpeed: CGFloat = 2.5

    /// 位移变化低于此值视为静止（pt/步）。
    static let settleDistance: CGFloat = 0.08

    /// 连续满足静止条件的步数，之后标记 settled、停止无意义更新。
    static let settleStreak: Int = 6

    // MARK: 物理时间步

    /// 引擎固定步长（秒）。TimelineView 的 tick 间隔不均匀，统一按固定
    /// dt 步进（累积器模式），模拟才可复现、可单测。
    static let fixedTimeStep: Double = 1.0 / 60.0

    /// 单次 tick 最多推进的模拟时间（秒）。切后台回来 tick 差值巨大时，
    /// 钳住它，防止卡片瞬移。
    static let maxFrameDelta: Double = 0.10
}
