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
