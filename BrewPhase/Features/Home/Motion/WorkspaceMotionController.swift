import CoreGraphics
import CoreMotion
import Foundation
import Observation

/// 一帧设备重力的值类型投影。
///
/// `CMDeviceMotion` 没有公开构造器，测试无法伪造；把数据源协议收敛到
/// 这个三值结构，控制器因此完全可以在 XCTest 里用模拟输入驱动。
struct DeviceGravitySample: Equatable, Sendable {
    var x: Double
    var y: Double
    var z: Double
}

/// 设备姿态的数据源抽象。测试注入 Mock，真机用 CoreMotion 实现。
protocol DeviceMotionSourcing: AnyObject {
    /// 当前是否有可用的设备姿态（模拟器通常为 false）。
    var isAvailable: Bool { get }
    /// 以指定频率开始推送姿态。
    func start(updateInterval: TimeInterval, handler: @escaping (DeviceGravitySample) -> Void)
    func stop()
}

/// 真实的 CoreMotion 数据源。
///
/// 用 `CMDeviceMotion.gravity` 而不是原始加速度：它是设备融合算法的输出，
/// 已经滤掉了用户主动的线性加速度——举起/放下手机不会被误判成桌面倾斜，
/// 正是需求 §4 要求的那一点。
final class CoreMotionDeviceMotionSource: DeviceMotionSourcing {

    private let manager = CMMotionManager()

    var isAvailable: Bool { manager.isDeviceMotionAvailable }

    func start(updateInterval: TimeInterval, handler: @escaping (DeviceGravitySample) -> Void) {
        guard manager.isDeviceMotionAvailable, !manager.isDeviceMotionActive else { return }
        manager.deviceMotionUpdateInterval = updateInterval
        let queue = OperationQueue()
        queue.name = "brewphase.gravity.motion"
        queue.qualityOfService = .userInitiated
        manager.startDeviceMotionUpdates(to: queue) { motion, _ in
            guard let motion else { return }
            handler(
                DeviceGravitySample(
                    x: motion.gravity.x,
                    y: motion.gravity.y,
                    z: motion.gravity.z
                )
            )
        }
    }

    func stop() {
        manager.stopDeviceMotionUpdates()
    }
}

/// Gravity Cards：首页共用的唯一姿态控制器。
///
/// 职责边界：传感器启停、基准姿态校准、滤波 / 死区 / 限幅。**不做物理**——
/// 输出「屏幕平面内的归一化重力方向」，交给 `WorkspaceGravityField` 分发。
///
/// 屏幕方向映射（竖屏，Home 在下）：
///
/// - `dx > 0`：设备右倾（右边缘向下）→ 卡片向右。
/// - `dy > 0`：设备底边下沉 → 卡片向下。
///
/// 基准校准记录「进入首页那一刻的设备重力」，之后一律用**相对基准的差**：
/// 不假设用户平放手机，也不做跨坐标系的四元数变换（推导见 Phase 2 报告 §4：
/// 完整变换会退化成常量，相对量只能来自同一设备系下的投影差）。
@MainActor
@Observable
final class WorkspaceMotionController {

    enum Phase {
        /// 未启动（离开首页 / 设置关闭 / Reduce Motion）。
        case idle
        /// 正常采样。
        case active
        /// 用户交互中（滚动 / 键盘）或 App 在后台：传感器已停。
        case suspended
    }

    private(set) var phase: Phase = .idle

    /// 最近一次的屏幕平面重力方向。**不参与观察**：30Hz 的写入不该
    /// 触发任何视图刷新，渲染由时间线统一驱动。
    @ObservationIgnored private(set) var screenGravity: CGVector = .zero

    /// 新方向产生时的回调（`WorkspaceGravityField` 在首页装配）。
    @ObservationIgnored var onGravity: ((CGVector) -> Void)?

    /// 基准重力（设备系，进入首页或恢复时采集）。
    @ObservationIgnored private var baselineGravity: (x: Double, y: Double, z: Double)?
    /// 滤波后的相对重力（设备系）。
    @ObservationIgnored private var smoothed: (dx: Double, dy: Double) = (0, 0)

    @ObservationIgnored private let source: any DeviceMotionSourcing
    /// 调试注入：`-BrewPhaseGravityTilt x,y`。模拟器没有传感器，
    /// 这是截图验收的唯一通道；正常启动时为 nil。
    @ObservationIgnored private let debugTilt: CGVector?

    init(
        source: any DeviceMotionSourcing = CoreMotionDeviceMotionSource(),
        debugTilt: CGVector? = nil
    ) {
        self.source = source
        // 默认值不能引用 MainActor 隔离的静态属性（默认参数在调用方上下文
        // 求值），所以在 init 体内读一次启动参数。
        self.debugTilt = debugTilt ?? Self.parseDebugTilt()
    }

    // MARK: - 生命周期

    /// 进入首页：校准基准并开始采样。
    func activate() {
        guard phase == .idle else { return }

        if let debugTilt {
            phase = .active
            emit(debugTilt)
            return
        }

        // 没有传感器（模拟器）：安全降级为静态，不报错、不假装能动。
        guard source.isAvailable else { return }

        baselineGravity = nil
        smoothed = (0, 0)
        phase = .active
        startSource()
    }

    /// 离开首页：停传感器、清全部临时状态。
    func deactivate() {
        source.stop()
        phase = .idle
        screenGravity = .zero
        baselineGravity = nil
        smoothed = (0, 0)
        onGravity?(.zero)
    }

    /// 暂停（滚动 / 键盘 / 后台）：停采样，输出归零让卡片自然滑停。
    func suspend() {
        guard phase == .active else { return }
        source.stop()
        phase = .suspended
        emit(.zero)
    }

    /// 恢复：**必须重新校准基准**，再继续采样。
    ///
    /// 暂停期间用户可能换了个握姿，不校准的话恢复瞬间会把「握姿差」
    /// 当成一次倾斜，卡片凭空跳一下。
    func resume() {
        guard phase == .suspended else { return }
        baselineGravity = nil
        smoothed = (0, 0)
        phase = .active
        emit(.zero)
        if debugTilt == nil { startSource() }
    }

    private func startSource() {
        source.start(
            updateInterval: 1.0 / WorkspaceMotionSettings.motionUpdateHz
        ) { [weak self] sample in
            Task { @MainActor in
                self?.ingest(sample)
            }
        }
    }

    // MARK: - 采样

    /// 传感器样本进入：校准 / 滤波 / 死区 / 限幅。
    ///
    /// `internal` 是为了让测试直接喂样本，不必真的转动机器。
    func ingest(_ sample: DeviceGravitySample) {
        let gravity: (x: Double, y: Double, z: Double) = (sample.x, sample.y, sample.z)
        guard phase == .active, debugTilt == nil else { return }

        // 第一帧 = 基准姿态（或刚被要求重校准）。
        guard let base = baselineGravity else {
            baselineGravity = gravity
            smoothed = (0, 0)
            emit(.zero)
            return
        }

        // 相对基准的差（同一设备坐标系内，因此可以直接相减）。
        //
        // 符号约定（竖屏，屏幕 y 向下为正）：
        // - 右边缘下沉 → 重力偏向设备 +x → 卡片向右：dy 用 +Δg.x。
        // - 下边缘下沉 → 重力偏向设备 -y → 卡片向下：屏幕向下 = -Δg.y。
        let rawX = gravity.x - base.x
        let rawY = base.y - gravity.y

        // 低通滤波：倾斜是慢动作，手抖不是输入。
        let alpha = WorkspaceMotionSettings.gravitySmoothing
        smoothed.dx += alpha * (rawX - smoothed.dx)
        smoothed.dy += alpha * (rawY - smoothed.dy)

        let magnitude = hypot(smoothed.dx, smoothed.dy)
        let deadZone = WorkspaceMotionSettings.tiltDeadZone

        // 死区：参考姿态附近不产生任何运动。
        guard magnitude >= deadZone else {
            emit(.zero)
            return
        }

        // 限幅：超过最大倾角后只保留方向，不再加力。
        let capped = min(magnitude, WorkspaceMotionSettings.tiltMaxRadians)
        let unitX = smoothed.dx / magnitude
        let unitY = smoothed.dy / magnitude

        // 强度沿「超出死区的比例」上升：死区边界 0 → 满倾 1，
        // 避免一过死区就跳到最大力。
        //
        // Phase 2.1：再做一次幂函数整形，让大倾角明显快于小倾角。
        // **整形只发生在这一处**——引擎对强度是纯线性的，两边各来一次
        // 会把曲线叠成平方，响应过猛（规格 §3.3）。
        let range = max(WorkspaceMotionSettings.tiltMaxRadians - deadZone, 0.0001)
        let linear = min(1, max(0, (capped - deadZone) / range))
        let intensity = pow(linear, WorkspaceMotionSettings.tiltResponseExponent)

        emit(CGVector(dx: unitX * intensity, dy: unitY * intensity))
    }

    private func emit(_ gravity: CGVector) {
        screenGravity = gravity
        onGravity?(gravity)
    }

    // MARK: - 调试注入

    /// `-BrewPhaseGravityTilt x,y`：x/y ∈ [-1, 1]，直接作为屏幕重力方向。
    ///
    /// 直接读 `ProcessInfo`：`DebugLaunch.value` 会把以 `-` 开头的值当作
    /// 下一个开关（那是给枚举型参数用的），而这里需要负方向。
    private static func parseDebugTilt() -> CGVector? {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: "-BrewPhaseGravityTilt"),
              args.indices.contains(index + 1) else { return nil }
        let raw = args[index + 1]
        let parts = raw
            .split(separator: ",")
            .compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard parts.count == 2 else { return nil }
        return CGVector(dx: parts[0], dy: parts[1])
    }
}
