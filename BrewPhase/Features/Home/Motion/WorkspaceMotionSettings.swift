import CoreGraphics
import Foundation

/// Gravity Cards 的全部可调参数。集中一处，不散落在视图里。
///
/// 这些是**调试起点**，不是产品定论：真实手感只能在真机上校。任何一处
/// 调参都该只改这个文件。
///
/// Phase 2.1 重新平衡了三处（重力尺度、摩擦、速度上限）。原来的组合让
/// 「终端速度」远超上限——终端速度 ≈ gravityScale ÷ 摩擦时间常数 ≈ 2500×强度，
/// 于是任何超过 10% 的倾斜都会撞到同一个 `maxSpeed`，这正是「倾斜越大越快」
/// 感知不到的原因。现在的组合让终端速度随倾角线性上升，只有接近满倾才触及上限。
enum WorkspaceMotionSettings {

    // MARK: 传感器

    /// 设备姿态采样频率（Hz）。30Hz 足够描述一次手部倾斜，再高只是耗电。
    static let motionUpdateHz: Double = 30

    /// 姿态低通系数（0…1，越大越跟手）。倾斜是慢动作，不需要跟住每一次抖动。
    static let gravitySmoothing: Double = 0.35

    /// 倾斜死区（弧度）。参考姿态附近的轻微晃动不产生运动——
    /// 手持时的天然抖动大约在这个量级以下。
    static let tiltDeadZone: Double = 3.5 * .pi / 180

    /// 起算满力的倾角（弧度）。超过它只保留方向、不再加力。
    static let tiltMaxRadians: Double = 25 * .pi / 180

    /// 倾斜响应曲线的指数（Phase 2.1）。
    ///
    /// 控制器输出 = 归一化强度 ^ 本指数。1.0 是线性；> 1 让大倾角明显快于
    /// 小倾角，同时小倾角仍然给出柔和的起步（进了死区不会直接静止）。
    ///
    /// 1.4 按「轻 / 中 / 大」三档拉开约 5 倍速度差选取；再大（≥ 1.8）会让
    /// 8° 左右的倾斜几乎没反应，手感发死。
    ///
    /// **这条曲线只在这里生效**：物理引擎对强度是纯线性的，两处叠加会让
    /// 响应过强（Phase 2.1 规格 §3.3 明确要求）。
    static let tiltResponseExponent: Double = 1.4

    // MARK: 运动范围

    /// 多卡片（2–3 张）时每张卡的最大水平位移（pt）。
    ///
    /// 卡片互相压着，任何一张滑太远都会整张盖住别人，所以保守。
    static let maxHorizontalTravel: CGFloat = 16

    /// 最大垂直位移（pt）。垂直方向侵入了标题与相邻分区的领地，只给一半。
    static let maxVerticalTravel: CGFloat = 8

    /// 单卡片（分区里只有一张）时，卡片离内容区左右边缘至少留多少（pt）。
    ///
    /// 单卡片没有「压住别人」的顾虑，可以走满整行；这个余量只保证它
    /// 不会贴到页边、看起来像要被裁掉。
    static let singleCardSafeMargin: CGFloat = 6

    // MARK: 动力学

    /// 重力加速度尺度（pt/s²，满强度时）。
    ///
    /// 配合摩擦决定「倾斜后到多快」：终端速度 ≈ 本值 ÷ 摩擦时间常数。
    static let gravityScale: CGFloat = 380

    /// 速度上限（pt/s）。防失控的护栏；正常倾角下终端速度低于它，
    /// 只有接近满倾才贴近，因此上限**不会**把所有倾角压成同一个速度。
    static let maxSpeed: CGFloat = 210

    /// 每秒速度保留比例（0…1）。0.82 ≈ 时间常数 0.58 秒：
    /// 倾斜后约 0.6 秒到目标速度，松手后约 2.5 秒滑停。
    ///
    /// 这个值必须够大才有响应感：太小（如旧的 0.10）意味着加速时间常数
    /// 长达 10 秒，卡片会像在糖浆里走。
    static let frictionPerSecond: CGFloat = 0.82

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
        default: return 0.06
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
