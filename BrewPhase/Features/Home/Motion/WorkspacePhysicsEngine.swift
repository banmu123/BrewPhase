import CoreGraphics
import Foundation

/// Gravity Cards：一个空间分区的物理引擎。
///
/// 每个分区一个实例、独立边界，卡片永远出不了自己的分区。物理逻辑本身
/// 是**确定性纯计算**（同样的输入序列 → 同样的输出序列），不碰传感器、
/// 不碰 SwiftUI、不碰 SwiftData——XCTest 直接实例化并驱动，无需模拟视图。
/// 它是 class 只是因为渲染层需要在 TimelineView 的 tick 里原地步进
/// （`@State` 里的 struct 做不到），对物理没有任何影响。
///
/// 固定时间步 + 累积器：TimelineView 的 tick 间隔不均匀（掉帧、停顿），
/// 模拟必须只认固定 dt，结果才可复现。单帧最多消化 `maxFrameDelta`，
/// 防止切后台回来后的巨大 dt 让卡片瞬移。
final class WorkspacePhysicsEngine {

    /// 屏幕平面内的重力方向（归一化，指向「下坡」）。
    /// `.zero` = 手机回到参考姿态（或死区内），没有力。
    private(set) var gravity: CGVector = .zero

    /// 累积的未消费模拟时间（秒）。
    private var accumulator: Double = 0

    /// 每张卡的运动状态，按稳定身份索引。
    private(set) var states: [WorkspaceCard.Identity: WorkspaceCardMotionState]

    /// 本分区的运动边界。
    private(set) var bounds: WorkspaceGravityBounds

    /// 上一次 tick 的单调时钟（秒）。nil = 尚未开始。
    private var lastTimestamp: Double?

    /// 上一次对账的卡片顺序。内容没变就不重建字典（每帧对账要便宜）。
    private var registeredIDs: [WorkspaceCard.Identity] = []

    init(bounds: WorkspaceGravityBounds = .none) {
        self.bounds = bounds
        self.states = [:]
    }

    // MARK: - 内容对账

    /// 让引擎里的卡片集合与当前要展示的卡片一致。
    ///
    /// 按 ID 对账而不是按数组下标重建：新卡从初始位置进入，消失的卡
    /// 清掉状态，留下来的保留自己的位置与速度——数据顺序变化不会让
    /// 卡片继承错误的运动。深度变化（上面的卡被删）只换个性参数，
    /// 位置与速度仍是这张卡自己的。
    func reconcile(cards: [WorkspaceCard]) {
        let limit = WorkspaceStackLayout.visibleLimit
        let ids = cards.prefix(limit).map(\.id)
        // 内容没变：直接返回。每帧调用的前提是这一步足够便宜。
        if ids == registeredIDs, ids.allSatisfy({ states[$0] != nil }) { return }
        registeredIDs = ids

        var next: [WorkspaceCard.Identity: WorkspaceCardMotionState] = [:]

        for (depth, card) in cards.prefix(limit).enumerated() {
            if var existing = states[card.id] {
                existing.responsiveness =
                    WorkspaceMotionSettings.responsiveness(forDepth: depth)
                existing.extraFriction =
                    WorkspaceMotionSettings.extraFriction(forDepth: depth)
                next[card.id] = existing
            } else {
                next[card.id] = WorkspaceCardMotionState(
                    responsiveness: WorkspaceMotionSettings.responsiveness(forDepth: depth),
                    extraFriction: WorkspaceMotionSettings.extraFriction(forDepth: depth)
                )
            }
        }
        states = next
    }

    /// 更新边界（卡片数量变化、机型/字体导致的可用留白变化）。
    ///
    /// 边界**变小**时（3 张变 1 张不会；1 张变 3 张、屏幕变窄会），已有
    /// 偏移可能落在新边界外：位置夹回、该方向速度清零，而不是让卡片顶着
    /// 旧速度继续往外挤。边界变大时什么都不做——卡片留在原地继续用新空间。
    func update(bounds newBounds: WorkspaceGravityBounds) {
        guard newBounds != bounds else { return }
        let shrank = newBounds.horizontalTravel < bounds.horizontalTravel
            || newBounds.verticalTravel < bounds.verticalTravel
        bounds = newBounds
        guard shrank else { return }

        for id in states.keys {
            guard var state = states[id] else { continue }
            let fitted = newBounds.clamp(state.offset)
            // 只有真的被夹过才清速度：没越界的方向保持惯性。
            if fitted.clampedX { state.velocity.dx = 0 }
            if fitted.clampedY { state.velocity.dy = 0 }
            state.offset = fitted.offset
            states[id] = state
        }
    }

    // MARK: - 输入与查询

    /// 重设基准姿态后清掉力，但保留惯性让卡片自然滑停（滚动/键盘恢复用）。
    func calmGravity() {
        gravity = .zero
    }

    /// 是否还有任何一张卡值得继续模拟。
    var allSettled: Bool {
        states.values.allSatisfy(\.settled)
    }

    /// 是否为空分区（没有卡片）。
    var isEmpty: Bool { states.isEmpty }

    /// 某张卡当前的渲染偏移与旋转。
    func render(for id: WorkspaceCard.Identity) -> (offset: CGPoint, rotation: CGFloat) {
        let state = states[id]
        return (state?.offset ?? .zero, state?.rotation ?? 0)
    }

    /// 注入新的重力方向并推进一帧。
    ///
    /// - Parameters:
    ///   - gravity: 屏幕平面内的归一化重力方向。
    ///   - timestamp: 单调时钟（秒）。
    ///   - dt: 固定步长覆盖。测试传具体值即按该 dt 步进一次，忽略累积器。
    func advance(
        gravity newGravity: CGVector,
        timestamp: Double?,
        dt fixedDt: Double? = nil
    ) {
        gravity = newGravity
        advance(timestamp: timestamp, dt: fixedDt)
    }

    /// 只推进时间（重力保持上次输入）。TimelineView tick 调这个。
    func advance(timestamp: Double?, dt fixedDt: Double? = nil) {
        if let fixedDt {
            step(dt: fixedDt)
            return
        }
        guard let timestamp else { return }

        if let last = lastTimestamp {
            let delta = min(max(0, timestamp - last), WorkspaceMotionSettings.maxFrameDelta)
            accumulator += delta
        }
        lastTimestamp = timestamp

        while accumulator >= WorkspaceMotionSettings.fixedTimeStep {
            step(dt: WorkspaceMotionSettings.fixedTimeStep)
            accumulator -= WorkspaceMotionSettings.fixedTimeStep
        }
    }

    /// 一步模拟：重力 → 摩擦 → 速度上限 → 位置 → 软边界 → 旋转 → settled。
    ///
    /// 半隐式欧拉（先更新速度再更新位置）：稳定性和成本的最佳折中，
    /// 弹簧式的振荡在这里只会帮倒忙。
    private func step(dt: Double) {
        let fdt = CGFloat(dt)

        for id in states.keys {
            var state = states[id]!

            // settled 且无力：跳过——这是「静止后停止无意义计算」的落点。
            if state.settled, gravity == .zero { continue }

            // settled 但出现了新的重力输入：唤醒。
            if state.settled, gravity != .zero {
                state.settled = false
                state.settleStreak = 0
            }

            // 1. 重力加速（每张卡用自己的响应系数缩放）。
            if gravity != .zero {
                let ax = gravity.dx * WorkspaceMotionSettings.gravityScale
                    * state.responsiveness
                let ay = gravity.dy * WorkspaceMotionSettings.gravityScale
                    * state.responsiveness
                state.velocity.dx += ax * fdt
                state.velocity.dy += ay * fdt
            }

            // 2. 摩擦：指数衰减，per-second 语义。
            //    底数钳在 0.02 以上：即使把参数调到极端也不会出现负底数
            //    （那会让 pow 返回 NaN，卡片直接消失）。
            let keep = max(0.02, 1 - WorkspaceMotionSettings.frictionPerSecond - state.extraFriction)
            let friction = CGFloat(pow(Double(keep), dt))
            state.velocity.dx *= friction
            state.velocity.dy *= friction

            // 3. 速度上限。
            let speed = hypot(state.velocity.dx, state.velocity.dy)
            let capped = WorkspaceMotionSettings.maxSpeed
            if speed > capped {
                let scale = capped / speed
                state.velocity.dx *= scale
                state.velocity.dy *= scale
            }

            // 4. 位置更新。
            state.offset.x += state.velocity.dx * fdt
            state.offset.y += state.velocity.dy * fdt

            // 5. 软边界：行程内自由，缓冲区内阻尼减速，行程外钳制。
            state.offset.x = applySoftBound(
                value: state.offset.x,
                travel: bounds.horizontalTravel,
                velocity: &state.velocity.dx,
                dt: dt
            )
            state.offset.y = applySoftBound(
                value: state.offset.y,
                travel: bounds.verticalTravel,
                velocity: &state.velocity.dy,
                dt: dt
            )

            // 6. 旋转：跟随水平速度，很轻，不翻面。
            let targetRotation = (state.velocity.dx * WorkspaceMotionSettings.rotationPerSpeed)
                .clamped(to: -WorkspaceMotionSettings.maxRotation...WorkspaceMotionSettings.maxRotation)
            state.rotation += (targetRotation - state.rotation) * min(1, 8 * fdt)

            // 7. settled 判定：无力、速度与位移都足够小，连续若干步。
            let speedNow = hypot(state.velocity.dx, state.velocity.dy)
            let moved = speedNow * fdt
            if gravity == .zero,
               speedNow < WorkspaceMotionSettings.settleSpeed,
               moved < WorkspaceMotionSettings.settleDistance {
                state.settleStreak += 1
                if state.settleStreak >= WorkspaceMotionSettings.settleStreak {
                    state.settled = true
                    state.velocity = .zero
                    state.rotation = 0
                }
            } else {
                state.settleStreak = 0
            }

            states[id] = state
        }
    }

    /// 软边界：行程内自由 → 缓冲区线性阻尼 → 行程外钳制。
    ///
    /// 不做游戏式反弹：穿出边界的位置直接钳回，速度只衰减不反向——
    /// 边界处永远不可能持续振荡。
    private func applySoftBound(
        value: CGFloat,
        travel: CGFloat,
        velocity: inout CGFloat,
        dt: Double
    ) -> CGFloat {
        let limit = travel
        let clamped = value.clamped(to: -limit...limit)

        if clamped != value {
            // 已经越过行程：位置钳回，速度强衰减（不反弹）。
            let decay = CGFloat(
                exp(-Double(WorkspaceMotionSettings.boundaryDamping) * dt)
            )
            velocity *= decay
            return clamped
        }

        // 缓冲区内：按侵入深度比例额外吸收速度，越接近边界越沉。
        let buffer = min(WorkspaceMotionSettings.boundaryBuffer, limit)
        let overshoot = abs(value) - max(0, limit - buffer)
        if overshoot > 0, buffer > 0 {
            let factor = overshoot / buffer
            velocity *= 1 - min(0.5, factor * 0.25)
        }
        return clamped
    }

    /// 停止一切并清空（离开首页用）。
    func haltAndClear() {
        gravity = .zero
        accumulator = 0
        lastTimestamp = nil
        for id in states.keys {
            states[id]?.reset()
        }
    }

    /// 完全清空（离开首页/关闭重力）：连卡片注册也一起丢掉。
    func clearAll() {
        haltAndClear()
        states = [:]
        registeredIDs = []
    }
}

// MARK: - 小工具

extension CGFloat {
    fileprivate func clamped(to range: ClosedRange<CGFloat>) -> CGFloat {
        Swift.min(Swift.max(self, range.lowerBound), range.upperBound)
    }
}
