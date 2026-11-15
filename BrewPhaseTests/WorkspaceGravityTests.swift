import CoreGraphics
import XCTest
@testable import BrewPhase

/// Gravity Cards（Phase 2）：物理引擎、行程边界、姿态控制器与生命周期。
///
/// 这些用例全部用**模拟输入**驱动，不碰真实传感器——真机上的手感与方向
/// 只能人工验收（见 `docs/testing/IOS_GRAVITY_CARDS_PHASE2_MANUAL_CHECKLIST.md`），
/// 单测负责把「算错了」和「本来就不该动」这两类问题挡在提测之前。
@MainActor
final class WorkspaceGravityTests: XCTestCase {

    override func setUp() {
        super.setUp()
        LanguageManager.pinForTesting(.simplifiedChinese)
    }

    // MARK: - 夹具

    private let frameStep: Double = 1.0 / 60.0
    private let wideBounds = WorkspaceGravityBounds(
        horizontalTravel: WorkspaceMotionSettings.maxHorizontalTravel,
        verticalTravel: WorkspaceMotionSettings.maxVerticalTravel
    )

    private func bean(_ name: String, at seconds: TimeInterval = 0) -> Bean {
        let bean = Bean(name: name)
        bean.createdAt = Date(timeIntervalSince1970: seconds)
        return bean
    }

    private func cards(_ names: String...) -> [WorkspaceCard] {
        names.enumerated().map { index, name in
            WorkspaceCard(bean: bean(name, at: Double(index)))
        }
    }

    private func engine(
        bounds: WorkspaceGravityBounds? = nil,
        cards: [WorkspaceCard]
    ) -> WorkspacePhysicsEngine {
        let engine = WorkspacePhysicsEngine(bounds: bounds ?? wideBounds)
        engine.reconcile(cards: cards)
        return engine
    }

    /// 以固定步长推进若干帧。
    private func run(
        _ engine: WorkspacePhysicsEngine,
        gravity: CGVector,
        frames: Int,
        dt: Double? = nil
    ) {
        let step = dt ?? frameStep
        for index in 1...max(frames, 1) {
            engine.advance(
                gravity: gravity,
                timestamp: Double(index) * step,
                dt: step
            )
        }
    }

    private func velocity(_ engine: WorkspacePhysicsEngine, _ id: WorkspaceCard.Identity) -> CGVector {
        engine.states[id]?.velocity ?? .zero
    }

    // MARK: - 1. 零重力不产生运动

    func testZeroGravityProducesNoAcceleration() {
        let list = cards("A", "B", "C")
        let engine = engine(cards: list)

        run(engine, gravity: .zero, frames: 120)

        for card in list {
            let offset = engine.render(for: card.id).offset
            XCTAssertEqual(offset.x, 0, accuracy: 0.0001)
            XCTAssertEqual(offset.y, 0, accuracy: 0.0001)
        }
    }

    // MARK: - 2…6. 四个方向与合成方向

    func testTiltRightMovesCardsRight() {
        let list = cards("A")
        let engine = engine(cards: list)
        run(engine, gravity: CGVector(dx: 1, dy: 0), frames: 30)
        XCTAssertGreaterThan(engine.render(for: list[0].id).offset.x, 0.5)
    }

    func testTiltLeftMovesCardsLeft() {
        let list = cards("A")
        let engine = engine(cards: list)
        run(engine, gravity: CGVector(dx: -1, dy: 0), frames: 30)
        XCTAssertLessThan(engine.render(for: list[0].id).offset.x, -0.5)
    }

    func testTiltForwardMovesCardsDown() {
        let list = cards("A")
        let engine = engine(cards: list)
        run(engine, gravity: CGVector(dx: 0, dy: 1), frames: 30)
        XCTAssertGreaterThan(engine.render(for: list[0].id).offset.y, 0.5)
    }

    func testTiltBackwardMovesCardsUp() {
        let list = cards("A")
        let engine = engine(cards: list)
        run(engine, gravity: CGVector(dx: 0, dy: -1), frames: 30)
        XCTAssertLessThan(engine.render(for: list[0].id).offset.y, -0.5)
    }

    func testDiagonalTiltMovesBothAxes() {
        let list = cards("A")
        let engine = engine(cards: list)
        run(engine, gravity: CGVector(dx: 0.6, dy: 0.6), frames: 40)
        let offset = engine.render(for: list[0].id).offset
        XCTAssertGreaterThan(offset.x, 0)
        XCTAssertGreaterThan(offset.y, 0)
    }

    // MARK: - 9/10. 每张卡独立、差异稳定

    func testCardsKeepIndependentStatesUnderOneInput() {
        let list = cards("A", "B", "C")
        let engine = engine(cards: list)
        run(engine, gravity: CGVector(dx: 1, dy: 0), frames: 20)

        // 三张卡都动了，但位置各不相同（前卡响应最快）。
        let offsets = list.map { engine.render(for: $0.id).offset.x }
        XCTAssertGreaterThan(offsets[0], offsets[1])
        XCTAssertGreaterThan(offsets[1], offsets[2])
        XCTAssertGreaterThan(offsets[2], 0)
    }

    func testPerCardResponseIsStableAcrossRuns() {
        // 同样的输入序列必须得到同样的结果：参数由 depth 决定，不随机。
        let first = cards("A", "B", "C")
        let second = cards("A", "B", "C")
        let e1 = engine(cards: first)
        let e2 = engine(cards: second)
        run(e1, gravity: CGVector(dx: 0.8, dy: -0.4), frames: 25)
        run(e2, gravity: CGVector(dx: 0.8, dy: -0.4), frames: 25)

        for (a, b) in zip(first, second) {
            XCTAssertEqual(
                e1.render(for: a.id).offset.x,
                e2.render(for: b.id).offset.x,
                accuracy: 0.0001
            )
            XCTAssertEqual(
                e1.render(for: a.id).offset.y,
                e2.render(for: b.id).offset.y,
                accuracy: 0.0001
            )
        }
    }

    // MARK: - 11/12. 速度与位移上限

    func testVelocityNeverExceedsTheCap() {
        let list = cards("A")
        let engine = engine(cards: list)
        run(engine, gravity: CGVector(dx: 1, dy: 0), frames: 600)

        let speed = hypot(
            velocity(engine, list[0].id).dx,
            velocity(engine, list[0].id).dy
        )
        XCTAssertLessThanOrEqual(speed, WorkspaceMotionSettings.maxSpeed + 0.001)
    }

    func testOffsetNeverLeavesTheConfiguredBounds() {
        let list = cards("A", "B", "C")
        let engine = engine(cards: list)
        run(engine, gravity: CGVector(dx: 1, dy: 1), frames: 900)

        for card in list {
            let offset = engine.render(for: card.id).offset
            XCTAssertLessThanOrEqual(offset.x, wideBounds.horizontalTravel + 0.001)
            XCTAssertLessThanOrEqual(offset.y, wideBounds.verticalTravel + 0.001)
        }
    }

    // MARK: - 13/14. 边界不穿出、不振荡

    func testCardsStopAtTheBoundaryInsteadOfCrossingIt() {
        let small = WorkspaceGravityBounds(horizontalTravel: 6, verticalTravel: 3)
        let list = cards("A")
        let engine = engine(bounds: small, cards: list)
        run(engine, gravity: CGVector(dx: 1, dy: 0), frames: 600)

        let offset = engine.render(for: list[0].id).offset
        XCTAssertEqual(offset.x, 6, accuracy: 0.001, "卡片必须停在行程边界上，不能穿出")
    }

    func testBoundaryDoesNotOscillate() {
        // 顶在边界上继续施加同向重力：位置必须稳定，速度衰减到接近零。
        let small = WorkspaceGravityBounds(horizontalTravel: 6, verticalTravel: 3)
        let list = cards("A")
        let engine = engine(bounds: small, cards: list)
        run(engine, gravity: CGVector(dx: 1, dy: 0), frames: 300)

        let settledPosition = engine.render(for: list[0].id).offset
        run(engine, gravity: CGVector(dx: 1, dy: 0), frames: 120)
        let laterPosition = engine.render(for: list[0].id).offset

        XCTAssertEqual(laterPosition.x, settledPosition.x, accuracy: 0.0001)
        XCTAssertLessThan(hypot(
            velocity(engine, list[0].id).dx,
            velocity(engine, list[0].id).dy
        ), WorkspaceMotionSettings.maxSpeed)
    }

    // MARK: - 15/16/17. 回正后衰减、settled、静止后不再计算

    func testVelocityDecaysWhenTiltReturnsToNeutral() {
        let list = cards("A")
        let engine = engine(cards: list)
        run(engine, gravity: CGVector(dx: 1, dy: 0), frames: 30)
        let moving = hypot(
            velocity(engine, list[0].id).dx,
            velocity(engine, list[0].id).dy
        )
        XCTAssertGreaterThan(moving, 0)

        run(engine, gravity: .zero, frames: 240)
        let resting = hypot(
            velocity(engine, list[0].id).dx,
            velocity(engine, list[0].id).dy
        )
        XCTAssertLessThan(resting, WorkspaceMotionSettings.settleSpeed)
    }

    func testCardsSettleAfterTiltEnds() {
        let list = cards("A", "B", "C")
        let engine = engine(cards: list)
        run(engine, gravity: CGVector(dx: 0.7, dy: 0.3), frames: 90)
        XCTAssertFalse(engine.allSettled)

        run(engine, gravity: .zero, frames: 300)
        XCTAssertTrue(engine.allSettled, "手机放平后所有卡片必须自然停下")
    }

    func testSettledCardsSkipFurtherUpdates() {
        let list = cards("A")
        let engine = engine(cards: list)
        run(engine, gravity: CGVector(dx: 0.5, dy: 0), frames: 60)
        run(engine, gravity: .zero, frames: 300)
        XCTAssertTrue(engine.allSettled)

        let before = engine.render(for: list[0].id).offset
        run(engine, gravity: .zero, frames: 120)
        let after = engine.render(for: list[0].id).offset
        XCTAssertEqual(before.x, after.x, accuracy: 0.0001)
        XCTAssertEqual(before.y, after.y, accuracy: 0.0001)
    }

    func testNewGravityWakesSettledCards() {
        let list = cards("A")
        let engine = engine(cards: list)
        run(engine, gravity: CGVector(dx: 0.5, dy: 0), frames: 60)
        run(engine, gravity: .zero, frames: 300)
        XCTAssertTrue(engine.allSettled)
        let settledAt = engine.render(for: list[0].id).offset.x

        run(engine, gravity: CGVector(dx: -1, dy: 0), frames: 20)
        XCTAssertFalse(engine.allSettled, "新的倾斜必须唤醒 settled 的卡片")
        XCTAssertLessThan(
            engine.render(for: list[0].id).offset.x,
            settledAt - 0.5,
            "唤醒后必须朝新的下坡方向移动"
        )
    }

    // MARK: - 18. 换向不瞬移

    func testChangingDirectionDoesNotTeleport() {
        let list = cards("A")
        let engine = engine(cards: list)
        run(engine, gravity: CGVector(dx: 1, dy: 0), frames: 40)
        let before = engine.render(for: list[0].id).offset.x

        // 一帧之内最多走 maxSpeed × dt。
        engine.advance(gravity: CGVector(dx: -1, dy: 0), timestamp: 41 * frameStep, dt: frameStep)
        let after = engine.render(for: list[0].id).offset.x
        let delta = abs(after - before)
        XCTAssertLessThanOrEqual(
            delta,
            WorkspaceMotionSettings.maxSpeed * CGFloat(frameStep) + 0.001,
            "换向的第一帧必须先减速，不能直接反方向跳"
        )
    }

    // MARK: - 19. 不同步长结果稳定

    func testSimulationIsStableAcrossTimeSteps() {
        let coarseCards = cards("A")
        let fineCards = cards("A")
        let coarse = engine(cards: coarseCards)
        let fine = engine(cards: fineCards)

        // 同样推进 0.5 秒，一个用 1/60，一个用 1/120。
        run(coarse, gravity: CGVector(dx: 0.8, dy: 0), frames: 30, dt: 1.0 / 60.0)
        run(fine, gravity: CGVector(dx: 0.8, dy: 0), frames: 60, dt: 1.0 / 120.0)

        let a = coarse.render(for: coarseCards[0].id).offset.x
        let b = fine.render(for: fineCards[0].id).offset.x
        XCTAssertGreaterThan(a, 0)
        XCTAssertEqual(a, b, accuracy: max(0.5, abs(a) * 0.15))
    }

    // MARK: - 内容变化：按 ID 对账

    func testRemovedCardDropsItsStateAndNewCardStartsAtRest() {
        let a = WorkspaceCard(bean: bean("A", at: 1))
        let b = WorkspaceCard(bean: bean("B", at: 2))
        let engine = WorkspacePhysicsEngine(bounds: wideBounds)
        engine.reconcile(cards: [a, b])
        run(engine, gravity: CGVector(dx: 1, dy: 0), frames: 40)

        let movedA = engine.render(for: a.id).offset.x
        XCTAssertGreaterThan(movedA, 0)

        // B 被删掉、C 新进来：A 保留自己的位置，C 从零开始。
        let c = WorkspaceCard(bean: bean("C", at: 3))
        engine.reconcile(cards: [a, c])

        XCTAssertNil(engine.states[b.id], "删掉的卡片必须清掉状态")
        XCTAssertEqual(engine.render(for: a.id).offset.x, movedA, accuracy: 0.0001)
        XCTAssertEqual(engine.render(for: c.id).offset.x, 0, accuracy: 0.0001)
    }

    func testSmallerBoundsAdaptTheTravel() {
        // 更小的分区（比如窄机型/更大字号把标题撑高）行程自动收窄。
        let tight = WorkspaceGravityBounds(horizontalTravel: 3, verticalTravel: 1.5)
        let list = cards("A")
        let engine = engine(bounds: tight, cards: list)
        run(engine, gravity: CGVector(dx: 1, dy: 1), frames: 600)

        let offset = engine.render(for: list[0].id).offset
        XCTAssertLessThanOrEqual(offset.x, 3.001)
        XCTAssertLessThanOrEqual(offset.y, 1.501)
    }

    // MARK: - 行程推导

    func testTravelIsCappedBySettingsAndByLayout() {
        let home = WorkspaceGravityTravel.homeBounds
        XCTAssertGreaterThan(home.horizontalTravel, 0)
        XCTAssertLessThanOrEqual(
            home.horizontalTravel,
            WorkspaceMotionSettings.maxHorizontalTravel
        )
        // 垂直行程必须小于标题间距，否则卡片会盖住自己的标题。
        XCTAssertLessThan(home.verticalTravel, Metric.Space.xs)
        XCTAssertLessThanOrEqual(
            home.verticalTravel,
            WorkspaceMotionSettings.maxVerticalTravel
        )
    }

    func testTravelShrinksWithSmallerPools() {
        let wide = WorkspaceGravityTravel.derive(horizontalPool: 200, verticalPool: 200)
        let narrow = WorkspaceGravityTravel.derive(horizontalPool: 8, verticalPool: 6)
        XCTAssertLessThan(narrow.horizontalTravel, wide.horizontalTravel)
        XCTAssertLessThan(narrow.verticalTravel, wide.verticalTravel)
        XCTAssertEqual(narrow.horizontalTravel, 4, accuracy: 0.001)
        XCTAssertEqual(narrow.verticalTravel, 3, accuracy: 0.001)
    }

    // MARK: - 空间隔离

    func testEachSpaceHasItsOwnEngineSoCardsCannotCross() {
        let coffee = cards("C1", "C2", "C3")
        let field = WorkspaceGravityField(bounds: wideBounds)
        field.reconcile(cards: coffee, for: .coffee)

        field.setGravity(CGVector(dx: 1, dy: 1))
        for index in 1...120 {
            field.step(at: Date(timeIntervalSinceReferenceDate: Double(index) * frameStep))
        }

        // Coffee 的卡动了。
        let moved = coffee.map { field.render(for: $0.id, in: .coffee).offset }
        XCTAssertTrue(moved.contains { $0.x > 0.5 })

        // Records / Canvas 没有卡片，也就不可能被 Coffee 的运动影响。
        for space in [AppTab.records, .canvas] {
            for card in coffee {
                let offset = field.render(for: card.id, in: space).offset
                XCTAssertEqual(offset.x, 0, accuracy: 0.0001)
                XCTAssertEqual(offset.y, 0, accuracy: 0.0001)
            }
        }
    }

    func testCardInOneSpaceNeverMovesWithAnotherSpacesInput() {
        let coffeeCard = WorkspaceCard(bean: bean("C", at: 1))
        let canvasCard = WorkspaceCard(bean: bean("V", at: 2))
        let field = WorkspaceGravityField(bounds: wideBounds)
        field.reconcile(cards: [coffeeCard], for: .coffee)
        field.reconcile(cards: [canvasCard], for: .canvas)

        field.setGravity(CGVector(dx: 1, dy: 0))
        for index in 1...120 {
            field.step(at: Date(timeIntervalSinceReferenceDate: Double(index) * frameStep))
        }

        XCTAssertGreaterThan(field.render(for: coffeeCard.id, in: .coffee).offset.x, 0.5)
        // Canvas 也收到了同样的重力（同一台设备），但它只动自己的卡——
        // 关键断言是「不会出现 Coffee 的卡跑到 Canvas 引擎里」。
        XCTAssertNil(field.engines[.canvas]?.states[coffeeCard.id])
        XCTAssertNil(field.engines[.coffee]?.states[canvasCard.id])
    }

    func testFieldResetsEverySpaceOnLeave() {
        let list = cards("A")
        let field = WorkspaceGravityField(bounds: wideBounds)
        field.reconcile(cards: list, for: .coffee)
        field.setGravity(CGVector(dx: 1, dy: 0))
        for index in 1...60 {
            field.step(at: Date(timeIntervalSinceReferenceDate: Double(index) * frameStep))
        }
        XCTAssertGreaterThan(field.render(for: list[0].id, in: .coffee).offset.x, 0)

        field.reset()

        XCTAssertEqual(field.render(for: list[0].id, in: .coffee).offset.x, 0, accuracy: 0.0001)
        XCTAssertEqual(field.gravity, .zero)
        XCTAssertTrue(field.isQuiescent)
    }

    // MARK: - 控制器：校准、死区、滤波、限幅

    private func controller(
        _ source: MockDeviceMotionSource,
        debugTilt: CGVector? = nil
    ) -> WorkspaceMotionController {
        WorkspaceMotionController(source: source, debugTilt: debugTilt)
    }

    func testActivateStartsSensorAndCalibratesOnFirstSample() {
        let source = MockDeviceMotionSource()
        let motion = controller(source)
        motion.activate()

        XCTAssertEqual(motion.phase, .active)
        XCTAssertEqual(source.startCount, 1)

        // 第一帧 = 基准，不产生任何方向。
        motion.ingest(DeviceGravitySample(x: 0, y: -1, z: 0))
        XCTAssertEqual(motion.screenGravity, .zero)
    }

    func testNoSensorFallsBackToStatic() {
        let source = MockDeviceMotionSource()
        source.available = false
        let motion = controller(source)
        motion.activate()

        // 模拟器：不启动、不报错、不假装能动。
        XCTAssertEqual(motion.phase, .idle)
        XCTAssertEqual(source.startCount, 0)
    }

    func testTiltMappingSignsFromDeviceGravity() {
        let source = MockDeviceMotionSource()
        let motion = controller(source)
        motion.activate()
        motion.ingest(DeviceGravitySample(x: 0, y: -1, z: 0))   // 基准：竖直握持

        // 右倾：设备 x 变正。
        feed(motion, x: 0.25, y: -0.97, z: 0)
        XCTAssertGreaterThan(motion.screenGravity.dx, 0.05)
        // 纯横滚时纵向分量只是三角函数的二阶残差，必须远小于横向。
        XCTAssertLessThan(abs(motion.screenGravity.dy), 0.15)

        // 左倾回到基准再往左。
        motion.ingest(DeviceGravitySample(x: 0, y: -1, z: 0))
        feed(motion, x: -0.25, y: -0.97, z: 0)
        XCTAssertLessThan(motion.screenGravity.dx, -0.05)
    }

    func testPitchSignMapsBottomEdgeDownToDownwardCards() {
        let source = MockDeviceMotionSource()
        let motion = controller(source)
        motion.activate()
        motion.ingest(DeviceGravitySample(x: 0, y: -0.7, z: -0.7))  // 基准：约 45°

        // 底边继续下沉：y 分量更负（-0.7 → -0.9），屏幕向下。
        feed(motion, x: 0, y: -0.9, z: -0.44)
        XCTAssertGreaterThan(motion.screenGravity.dy, 0.05, "底边下沉时卡片必须向下")

        // 顶边下沉：y 分量回到 -0.5 附近，屏幕向上。
        motion.ingest(DeviceGravitySample(x: 0, y: -0.7, z: -0.7))
        feed(motion, x: 0, y: -0.5, z: -0.87)
        XCTAssertLessThan(motion.screenGravity.dy, -0.05, "顶边下沉时卡片必须向上")
    }

    func testDeadZoneFiltersTinyTilts() {
        let source = MockDeviceMotionSource()
        let motion = controller(source)
        motion.activate()
        motion.ingest(DeviceGravitySample(x: 0, y: -1, z: 0))

        // 小于死区的噪声（约 1°）：输出必须为 0。
        for _ in 0..<30 {
            motion.ingest(DeviceGravitySample(x: 0.018, y: -1, z: 0))
        }
        XCTAssertEqual(motion.screenGravity, .zero)
    }

    func testSmoothingRampsUpInsteadOfJumping() {
        let source = MockDeviceMotionSource()
        let motion = controller(source)
        motion.activate()
        motion.ingest(DeviceGravitySample(x: 0, y: -1, z: 0))

        // 第一帧大倾斜：滤波后应明显小于满幅，随后逐帧收敛。
        motion.ingest(DeviceGravitySample(x: 0.4, y: -0.92, z: 0))
        let first = motion.screenGravity.dx
        for _ in 0..<20 {
            motion.ingest(DeviceGravitySample(x: 0.4, y: -0.92, z: 0))
        }
        let settled = motion.screenGravity.dx
        XCTAssertGreaterThan(first, 0)
        XCTAssertGreaterThan(settled, first)
        XCTAssertLessThanOrEqual(settled, 1.0001)
    }

    func testLargeTiltIsClampedToUnitMagnitude() {
        let source = MockDeviceMotionSource()
        let motion = controller(source)
        motion.activate()
        motion.ingest(DeviceGravitySample(x: 0, y: -0.2, z: -0.98))

        for _ in 0..<60 {
            motion.ingest(DeviceGravitySample(x: 0.95, y: -0.2, z: -0.24))
        }
        let magnitude = hypot(motion.screenGravity.dx, motion.screenGravity.dy)
        XCTAssertLessThanOrEqual(magnitude, 1.0001)
        XCTAssertGreaterThan(magnitude, 0.9, "满倾必须给出接近满幅的力")
    }

    // MARK: - 控制器：生命周期

    func testSuspendStopsSensorAndZeroesForce() {
        let source = MockDeviceMotionSource()
        let motion = controller(source)
        motion.activate()
        motion.ingest(DeviceGravitySample(x: 0, y: -1, z: 0))
        feed(motion, x: 0.4, y: -0.92, z: 0)
        XCTAssertNotEqual(motion.screenGravity, .zero)

        motion.suspend()

        XCTAssertEqual(motion.phase, .suspended)
        XCTAssertEqual(motion.screenGravity, .zero)
        XCTAssertEqual(source.stopCount, 1)
    }

    func testResumeRecalibratesSoTheNewPoseIsNeutral() {
        let source = MockDeviceMotionSource()
        let motion = controller(source)
        motion.activate()
        motion.ingest(DeviceGravitySample(x: 0, y: -1, z: 0))
        motion.suspend()

        // 暂停期间用户换了个握姿。
        motion.resume()
        XCTAssertEqual(motion.phase, .active)
        XCTAssertEqual(source.startCount, 2)

        motion.ingest(DeviceGravitySample(x: 0.3, y: -0.95, z: 0))
        XCTAssertEqual(motion.screenGravity, .zero, "恢复后的第一帧必须成为新基准")
    }

    func testDeactivateClearsEverything() {
        let source = MockDeviceMotionSource()
        let motion = controller(source)
        motion.activate()
        motion.ingest(DeviceGravitySample(x: 0, y: -1, z: 0))
        feed(motion, x: 0.4, y: -0.92, z: 0)

        motion.deactivate()

        XCTAssertEqual(motion.phase, .idle)
        XCTAssertEqual(motion.screenGravity, .zero)
        XCTAssertEqual(source.stopCount, 1)
    }

    func testReenteringStartsFromRestLayout() {
        let list = cards("A")
        let source = MockDeviceMotionSource()
        let motion = controller(source, debugTilt: nil)
        let field = WorkspaceGravityField(bounds: wideBounds)
        motion.onGravity = { field.setGravity($0) }

        motion.activate()
        motion.ingest(DeviceGravitySample(x: 0, y: -1, z: 0))
        feed(motion, x: 0.5, y: -0.86, z: 0)
        field.reconcile(cards: list, for: .coffee)
        for index in 1...60 {
            field.step(at: Date(timeIntervalSinceReferenceDate: Double(index) * frameStep))
        }
        XCTAssertGreaterThan(field.render(for: list[0].id, in: .coffee).offset.x, 0.5)

        // 离开首页再回来：位置必须回到原始堆叠。
        motion.deactivate()
        field.reset()
        motion.activate()
        motion.ingest(DeviceGravitySample(x: 0, y: -1, z: 0))
        field.reconcile(cards: list, for: .coffee)

        XCTAssertEqual(
            field.render(for: list[0].id, in: .coffee).offset.x,
            0,
            accuracy: 0.0001,
            "再次进入首页不能恢复上一次的偏移"
        )
    }

    func testDebugTiltOverridesSensorForScreenshots() {
        let source = MockDeviceMotionSource()
        source.available = false
        let motion = controller(source, debugTilt: CGVector(dx: 0.5, dy: -0.25))
        motion.activate()

        // 没有传感器也能给出固定方向（模拟器截图验收的通道）。
        XCTAssertEqual(motion.phase, .active)
        XCTAssertEqual(motion.screenGravity, CGVector(dx: 0.5, dy: -0.25))
        XCTAssertEqual(source.startCount, 0)
    }

    func testDisabledSettingNeverStartsTheSensor() {
        let source = MockDeviceMotionSource()
        let motion = controller(source)

        // 视图在关掉开关时根本不调 activate——这里钉住「不激活就零成本」。
        XCTAssertEqual(motion.phase, .idle)
        XCTAssertEqual(source.startCount, 0)
        XCTAssertEqual(motion.screenGravity, .zero)
    }

    // MARK: - Phase 2.1：单卡片行程

    /// 一台 402pt 宽的 iPhone 16 Pro，减去左右各 22pt 页留白。
    private let phoneContentWidth: CGFloat = 358

    func testSingleCardKeepsTheSameWidthAsInAStack() {
        // 只有一张卡也不许放大：宽度仍由「整行 ÷ 3」决定，与三卡完全一致。
        let width = WorkspaceStackLayout.cardWidth(in: phoneContentWidth)
        let expected = (phoneContentWidth + 2 * WorkspaceStackLayout.cardOverlap)
            / CGFloat(WorkspaceStackLayout.visibleLimit)
        XCTAssertEqual(width, expected, accuracy: 0.001)
        XCTAssertLessThan(width, phoneContentWidth / 2, "单卡不应被拉成半屏宽")
        XCTAssertEqual(WorkspaceStackLayout.cardWidth(in: 0), 0)
    }

    func testSingleCardSitsInTheMiddleSlot() {
        // 三个卡位等宽且对称 → 中间卡位的中心就是整行中点。
        XCTAssertEqual(
            WorkspaceStackLayout.cardSlot(forDepth: 0, cardCount: 1),
            WorkspaceStackLayout.visibleLimit / 2
        )
        // 多卡片仍按深度顺排，不居中。
        for depth in 0..<WorkspaceStackLayout.visibleLimit {
            XCTAssertEqual(WorkspaceStackLayout.cardSlot(forDepth: depth, cardCount: 3), depth)
        }

        // 用几何验证「中间卡位确实居中」：卡宽 w、重叠 c，中间卡位左缘 = w − c。
        let w = WorkspaceStackLayout.cardWidth(in: phoneContentWidth)
        let c = WorkspaceStackLayout.cardOverlap
        let center = (w - c) + w / 2
        XCTAssertEqual(center, phoneContentWidth / 2, accuracy: 0.001)
    }

    func testSingleCardTravelIsFarLargerThanSixteenPoints() {
        let single = WorkspaceGravityTravel.singleCardBounds(availableWidth: phoneContentWidth)
        let stacked = WorkspaceGravityTravel.homeBounds

        XCTAssertEqual(
            single.horizontalTravel,
            (phoneContentWidth - WorkspaceStackLayout.cardWidth(in: phoneContentWidth)) / 2
                - WorkspaceMotionSettings.singleCardSafeMargin,
            accuracy: 0.001
        )
        XCTAssertGreaterThan(
            single.horizontalTravel,
            WorkspaceMotionSettings.maxHorizontalTravel * 5,
            "单卡行程必须明显大于多卡片的 16pt"
        )
        // 垂直不放宽：上下都是标题与相邻分区。
        XCTAssertEqual(single.verticalTravel, stacked.verticalTravel, accuracy: 0.001)
    }

    func testSingleCardTravelGrowsWithWiderScreens() {
        let phone = WorkspaceGravityTravel.singleCardBounds(availableWidth: 358)
        let pad = WorkspaceGravityTravel.singleCardBounds(availableWidth: 650)
        XCTAssertGreaterThan(pad.horizontalTravel, phone.horizontalTravel)
        // 极窄区域（比卡片还窄）时退化为零，不能变负。
        XCTAssertEqual(
            WorkspaceGravityTravel.singleCardBounds(availableWidth: 40).horizontalTravel,
            0
        )
        XCTAssertEqual(
            WorkspaceGravityTravel.singleCardBounds(availableWidth: 0).horizontalTravel,
            0
        )
    }

    func testSingleCardSlidesBothWaysWithinTheSafeArea() {
        let bounds = WorkspaceGravityTravel.singleCardBounds(availableWidth: phoneContentWidth)
        let card = WorkspaceCard(bean: bean("A"))
        let engine = WorkspacePhysicsEngine(bounds: bounds)
        engine.reconcile(cards: [card])

        // 向右到满行程。
        run(engine, gravity: CGVector(dx: 1, dy: 0), frames: 240)
        let right = engine.render(for: card.id).offset.x
        XCTAssertEqual(right, bounds.horizontalTravel, accuracy: 0.001)
        XCTAssertGreaterThan(right, 90)

        // 向左到满行程。
        run(engine, gravity: CGVector(dx: -1, dy: 0), frames: 480)
        let left = engine.render(for: card.id).offset.x
        XCTAssertEqual(left, -bounds.horizontalTravel, accuracy: 0.001)
    }

    func testSingleCardNeverLeavesTheContentArea() {
        let bounds = WorkspaceGravityTravel.singleCardBounds(availableWidth: phoneContentWidth)
        let cardWidth = WorkspaceStackLayout.cardWidth(in: phoneContentWidth)
        let card = WorkspaceCard(bean: bean("A"))
        let engine = WorkspacePhysicsEngine(bounds: bounds)
        engine.reconcile(cards: [card])

        run(engine, gravity: CGVector(dx: 1, dy: 0), frames: 240)
        let offset = engine.render(for: card.id).offset.x

        // 居中 + 偏移后的左右边缘都必须留在内容区内。
        let center = phoneContentWidth / 2
        let leftEdge = center + offset - cardWidth / 2
        let rightEdge = center + offset + cardWidth / 2
        XCTAssertGreaterThanOrEqual(leftEdge, WorkspaceMotionSettings.singleCardSafeMargin - 0.001)
        XCTAssertLessThanOrEqual(
            rightEdge,
            phoneContentWidth - WorkspaceMotionSettings.singleCardSafeMargin + 0.001
        )
    }

    func testMultiCardBoundsStayConservative() {
        let two = WorkspaceGravityTravel.bounds(
            cardCount: 2, isEmpty: false, availableWidth: phoneContentWidth
        )
        let three = WorkspaceGravityTravel.bounds(
            cardCount: 3, isEmpty: false, availableWidth: phoneContentWidth
        )
        XCTAssertEqual(two, WorkspaceGravityTravel.homeBounds)
        XCTAssertEqual(three, WorkspaceGravityTravel.homeBounds)
        XCTAssertLessThanOrEqual(
            two.horizontalTravel,
            WorkspaceMotionSettings.maxHorizontalTravel,
            "多卡片不能因为单卡放宽而一起放大"
        )
    }

    func testEmptyCardDoesNotGetTheSingleCardTravel() {
        // 空态卡只是占位，不该「没内容反而动得最远」。
        let empty = WorkspaceGravityTravel.bounds(
            cardCount: 1, isEmpty: true, availableWidth: phoneContentWidth
        )
        XCTAssertEqual(empty, WorkspaceGravityTravel.homeBounds)
    }

    func testGoingFromThreeCardsToOneDoesNotResetTheSurvivor() {
        let a = WorkspaceCard(bean: bean("A", at: 1))
        let b = WorkspaceCard(bean: bean("B", at: 2))
        let c = WorkspaceCard(bean: bean("C", at: 3))
        let engine = WorkspacePhysicsEngine(bounds: WorkspaceGravityTravel.homeBounds)
        engine.reconcile(cards: [a, b, c])
        run(engine, gravity: CGVector(dx: 1, dy: 0), frames: 60)
        let moved = engine.render(for: a.id).offset.x
        XCTAssertGreaterThan(moved, 0)

        // B、C 被删，只剩 A：边界变宽，位置必须保留（不飞走、不归零）。
        engine.reconcile(cards: [a])
        engine.update(bounds: WorkspaceGravityTravel.singleCardBounds(availableWidth: phoneContentWidth))

        XCTAssertEqual(engine.render(for: a.id).offset.x, moved, accuracy: 0.0001)
        XCTAssertNil(engine.states[b.id])
        XCTAssertNil(engine.states[c.id])
    }

    func testShrinkingBoundsClampsPositionInsteadOfLeavingTheSpace() {
        let a = WorkspaceCard(bean: bean("A", at: 1))
        let engine = WorkspacePhysicsEngine(
            bounds: WorkspaceGravityTravel.singleCardBounds(availableWidth: phoneContentWidth)
        )
        engine.reconcile(cards: [a])
        run(engine, gravity: CGVector(dx: 1, dy: 0), frames: 240)
        XCTAssertGreaterThan(engine.render(for: a.id).offset.x, 90)

        // 内容变多 → 回到保守边界：越界的位置必须被夹回，速度清零。
        let b = WorkspaceCard(bean: bean("B", at: 2))
        engine.reconcile(cards: [a, b])
        engine.update(bounds: WorkspaceGravityTravel.homeBounds)

        let offset = engine.render(for: a.id).offset
        XCTAssertLessThanOrEqual(
            offset.x,
            WorkspaceGravityTravel.homeBounds.horizontalTravel + 0.001
        )
        XCTAssertEqual(velocity(engine, a.id).dx, 0, accuracy: 0.0001)
        // 状态本身没有被丢弃：还是这张卡的记录。
        XCTAssertNotNil(engine.states[a.id])
    }

    func testGrowingContentKeepsStatesByStableID() {
        let a = WorkspaceCard(bean: bean("A", at: 1))
        let engine = WorkspacePhysicsEngine(
            bounds: WorkspaceGravityTravel.singleCardBounds(availableWidth: phoneContentWidth)
        )
        engine.reconcile(cards: [a])
        run(engine, gravity: CGVector(dx: 1, dy: 0), frames: 120)
        let moved = engine.render(for: a.id).offset.x
        XCTAssertGreaterThan(moved, 0)

        // 一张变三张：A 仍在最前，位置与速度都归它自己。
        let b = WorkspaceCard(bean: bean("B", at: 2))
        let c = WorkspaceCard(bean: bean("C", at: 3))
        engine.reconcile(cards: [a, b, c])

        XCTAssertEqual(engine.states.count, 3)
        XCTAssertGreaterThan(engine.render(for: a.id).offset.x, 0)
        XCTAssertEqual(engine.render(for: b.id).offset.x, 0, accuracy: 0.0001)
        XCTAssertEqual(engine.render(for: c.id).offset.x, 0, accuracy: 0.0001)
    }

    // MARK: - Phase 2.1：倾斜角度 → 速度（控制器 + 引擎串联）

    /// 在同一初始姿态下倾斜 `degrees` 度，跑 `frames` 帧，返回末态强度/速度/位移。
    ///
    /// 真实链路：每一帧先喂传感器样本、取控制器输出，再用它驱动引擎一步。
    /// 行程给足（300pt），保证测的是「速度响应」而不是「撞到边界」。
    private func tiltRun(
        degrees: Double,
        frames: Int = 60,
        travel: CGFloat = 300
    ) -> (intensity: CGFloat, speed: CGFloat, distance: CGFloat) {
        let source = MockDeviceMotionSource()
        let motion = WorkspaceMotionController(source: source, debugTilt: nil)
        motion.activate()
        // 基准：竖直握持。
        motion.ingest(DeviceGravitySample(x: 0, y: -1, z: 0))

        let theta = degrees * .pi / 180
        let sample = DeviceGravitySample(x: sin(theta), y: -cos(theta), z: 0)

        let card = WorkspaceCard(bean: bean("A"))
        let engine = WorkspacePhysicsEngine(
            bounds: WorkspaceGravityBounds(
                horizontalTravel: travel,
                verticalTravel: WorkspaceMotionSettings.maxVerticalTravel
            )
        )
        engine.reconcile(cards: [card])

        var intensity: CGFloat = 0
        for index in 1...frames {
            motion.ingest(sample)
            intensity = motion.screenGravity.dx
            engine.advance(
                gravity: motion.screenGravity,
                timestamp: Double(index) / 60,
                dt: 1.0 / 60
            )
        }

        let state = engine.states[card.id]
        return (
            intensity,
            hypot(state?.velocity.dx ?? 0, state?.velocity.dy ?? 0),
            engine.render(for: card.id).offset.x
        )
    }

    func testTiltIntensityIsMonotonicInAngle() {
        let small = tiltRun(degrees: 8)
        let medium = tiltRun(degrees: 15)
        let large = tiltRun(degrees: 22)

        XCTAssertGreaterThan(small.intensity, 0, "小倾角也要有响应")
        XCTAssertGreaterThan(medium.intensity, small.intensity)
        XCTAssertGreaterThan(large.intensity, medium.intensity)
    }

    func testLargerTiltMovesFasterAndFurther() {
        // 规格 §5.2 的核心断言：同样时长、同样起点，倾角越大越快越远。
        let small = tiltRun(degrees: 8, frames: 45)
        let medium = tiltRun(degrees: 15, frames: 45)
        let large = tiltRun(degrees: 22, frames: 45)

        XCTAssertLessThan(small.speed, medium.speed)
        XCTAssertLessThan(medium.speed, large.speed)
        XCTAssertLessThan(small.distance, medium.distance)
        XCTAssertLessThan(medium.distance, large.distance)

        // 速度差要「能被感知」：大到小至少 3 倍，而不是几个百分点。
        XCTAssertGreaterThan(large.speed, small.speed * 3)
        print(
            """
            [Gravity 2.1] 45 帧（0.75s）:
              8°  intensity=\(String(format: "%.3f", small.intensity)) \
            speed=\(String(format: "%.1f", small.speed))pt/s \
            distance=\(String(format: "%.1f", small.distance))pt
              15° intensity=\(String(format: "%.3f", medium.intensity)) \
            speed=\(String(format: "%.1f", medium.speed))pt/s \
            distance=\(String(format: "%.1f", medium.distance))pt
              22° intensity=\(String(format: "%.3f", large.intensity)) \
            speed=\(String(format: "%.1f", large.speed))pt/s \
            distance=\(String(format: "%.1f", large.distance))pt
            """
        )
    }

    func testSustainedMaxTiltStopsAtTheSpeedCap() {
        // 行程给到 10000pt：这一条测的是「速度有没有被上限管住」，
        // 不能因为卡片先撞到边界（边界阻尼会把速度吃掉）而误判。
        let run = tiltRun(degrees: 40, frames: 240, travel: 10_000)
        XCTAssertLessThanOrEqual(
            run.speed,
            WorkspaceMotionSettings.maxSpeed + 0.001,
            "满倾也不能突破速度上限"
        )
        XCTAssertGreaterThan(
            run.speed,
            WorkspaceMotionSettings.maxSpeed * 0.9,
            "满倾必须接近上限，而不是被摩擦按住"
        )
    }

    func testTiltInsideDeadZoneProducesNoSpeed() {
        let run = tiltRun(degrees: 2, frames: 60)
        XCTAssertEqual(run.intensity, 0, accuracy: 0.0001)
        XCTAssertEqual(run.speed, 0, accuracy: 0.0001)
        XCTAssertEqual(run.distance, 0, accuracy: 0.0001)
    }

    func testReleasingTiltDecaysSpeedNaturally() {
        let bounds = WorkspaceGravityBounds(horizontalTravel: 300, verticalTravel: 8)
        let card = WorkspaceCard(bean: bean("A"))
        let engine = WorkspacePhysicsEngine(bounds: bounds)
        engine.reconcile(cards: [card])

        run(engine, gravity: CGVector(dx: 0.8, dy: 0), frames: 45)
        let moving = hypot(velocity(engine, card.id).dx, velocity(engine, card.id).dy)
        XCTAssertGreaterThan(moving, 50)

        run(engine, gravity: .zero, frames: 300)
        let resting = hypot(velocity(engine, card.id).dx, velocity(engine, card.id).dy)
        XCTAssertLessThan(resting, WorkspaceMotionSettings.settleSpeed)
        XCTAssertTrue(engine.allSettled)
        // 停在新的位置，不自动回原位。
        XCTAssertGreaterThan(engine.render(for: card.id).offset.x, 10)
    }

    func testReversingTiltNeverTeleportsUnderTheNewDynamics() {
        let bounds = WorkspaceGravityBounds(horizontalTravel: 300, verticalTravel: 8)
        let card = WorkspaceCard(bean: bean("A"))
        let engine = WorkspacePhysicsEngine(bounds: bounds)
        engine.reconcile(cards: [card])

        run(engine, gravity: CGVector(dx: 1, dy: 0), frames: 45)
        let before = engine.render(for: card.id).offset.x

        engine.advance(
            gravity: CGVector(dx: -1, dy: 0),
            timestamp: 46.0 / 60.0,
            dt: 1.0 / 60.0
        )
        let after = engine.render(for: card.id).offset.x
        XCTAssertLessThanOrEqual(
            abs(after - before),
            WorkspaceMotionSettings.maxSpeed / 60 + 0.001
        )
        // 先减速（速度变小），而不是立刻反向。
        XCTAssertGreaterThan(velocity(engine, card.id).dx, 0)
    }

    // MARK: - 工具

    /// 连续喂若干帧同样的倾斜，让低通滤波收敛。
    private func feed(
        _ motion: WorkspaceMotionController,
        x: Double,
        y: Double,
        z: Double
    ) {
        for _ in 0..<25 {
            motion.ingest(DeviceGravitySample(x: x, y: y, z: z))
        }
    }
}

/// 模拟设备姿态源：完全可控，不碰 CoreMotion。
private final class MockDeviceMotionSource: DeviceMotionSourcing {

    var available = true
    private(set) var startCount = 0
    private(set) var stopCount = 0

    var isAvailable: Bool { available }

    func start(updateInterval: TimeInterval, handler: @escaping (DeviceGravitySample) -> Void) {
        startCount += 1
    }

    func stop() {
        stopCount += 1
    }
}
