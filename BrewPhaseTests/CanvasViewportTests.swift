import CoreGraphics
import XCTest
@testable import BrewPhase

/// 画布几何：世界坐标 ↔ 屏幕坐标、围绕锚点缩放、初始装窗，以及新节点落位。
///
/// 这些规则决定「退出重进布局还在不在」「缩放时节点会不会漂」——它们都是
/// 可以离屏断言的事实，不该只靠盯着画布看。
final class CanvasViewportTests: XCTestCase {

    func testScreenAndWorldRoundTrip() {
        let viewport = CanvasViewport(scale: 1.6, offset: CGSize(width: -120, height: 64))
        let world = CGPoint(x: 40, y: -18)
        let screen = viewport.screenPoint(world)
        let back = viewport.worldPoint(screen)

        XCTAssertEqual(back.x, world.x, accuracy: 0.001)
        XCTAssertEqual(back.y, world.y, accuracy: 0.001)
    }

    /// 缩放时手指下面的那一点必须不动：这是「捏合不跑位」的全部依据。
    func testZoomKeepsTheAnchorPointFixed() {
        let base = CanvasViewport(scale: 1, offset: CGSize(width: 20, height: 30))
        let anchor = CGPoint(x: 180, y: 320)
        let worldBefore = base.worldPoint(anchor)

        let zoomed = base.zoomed(to: 2.2, anchor: anchor)
        let worldAfter = zoomed.worldPoint(anchor)

        XCTAssertEqual(worldAfter.x, worldBefore.x, accuracy: 0.001)
        XCTAssertEqual(worldAfter.y, worldBefore.y, accuracy: 0.001)
    }

    func testScaleIsClampedToTheAllowedRange() {
        XCTAssertEqual(CanvasViewport.clampedScale(0.01), CanvasViewport.minScale)
        XCTAssertEqual(CanvasViewport.clampedScale(99), CanvasViewport.maxScale)
        XCTAssertEqual(CanvasViewport.clampedScale(.nan), 1)
    }

    /// 缩放只改视口，不改任何节点的世界坐标。
    func testZoomingDoesNotChangeWorldCoordinates() {
        let viewport = CanvasViewport()
        let nodeFrame = CGRect(x: 120, y: 80, width: 220, height: 170)
        let before = viewport.screenPoint(nodeFrame.origin)

        let zoomed = viewport.zoomed(to: 1.8, anchor: CGPoint(x: 100, y: 100))
        XCTAssertEqual(zoomed.worldPoint(zoomed.screenPoint(nodeFrame.origin)).x,
                       nodeFrame.origin.x, accuracy: 0.001)
        XCTAssertNotEqual(zoomed.screenPoint(nodeFrame.origin), before)
    }

    /// 重新进入画布：内容包围盒被装进窗口并居中，小画布最多放大到 100%。
    func testFitCentersTheContentInsideTheWindow() {
        let content = CGRect(x: 0, y: 0, width: 600, height: 400)
        let size = CGSize(width: 390, height: 700)
        let viewport = CanvasViewport().fitted(content: content, in: size, padding: 40)

        XCTAssertLessThanOrEqual(viewport.scale, 1)
        let screenCenter = viewport.screenPoint(CGPoint(x: content.midX, y: content.midY))
        XCTAssertEqual(screenCenter.x, size.width / 2, accuracy: 0.5)
        XCTAssertEqual(screenCenter.y, size.height / 2, accuracy: 0.5)
    }

    func testFitReturnsIdentityWhenThereIsNoContent() {
        let viewport = CanvasViewport(scale: 1.4, offset: CGSize(width: 10, height: 10))
            .fitted(content: .zero, in: CGSize(width: 390, height: 700))
        XCTAssertEqual(viewport, CanvasViewport())
    }
}

/// 新节点落位：不压在已有节点上、不跑出可见区。
final class CanvasPlacementTests: XCTestCase {

    private let visible = CGRect(x: 0, y: 0, width: 390, height: 700)

    func testNewNodesAvoidOccupiedFrames() {
        let occupied = [CGRect(x: 0, y: 0, width: 220, height: 220)]
        let sizes = [CGSize(width: 220, height: 180), CGSize(width: 220, height: 180)]

        let origins = CanvasPlacement.origins(sizes: sizes, occupied: occupied, in: visible)
        XCTAssertEqual(origins.count, 2)

        var frames = occupied
        for (origin, size) in zip(origins, sizes) {
            let frame = CGRect(origin: origin, size: size)
            XCTAssertTrue(visible.contains(frame), "落位不能跑出可见区")
            XCTAssertFalse(occupied.contains { $0.insetBy(dx: -16, dy: -16).intersects(frame) },
                           "不能压在已有节点上")
            frames.append(frame)
        }
        XCTAssertFalse(frames[1].intersects(frames[2]), "同一批新节点之间也不能重叠")
    }

    func testPositionsStayInsideTheVisibleRect() {
        let origins = CanvasPlacement.origins(
            sizes: Array(repeating: CGSize(width: 160, height: 140), count: 3),
            occupied: [], in: visible)

        for origin in origins {
            XCTAssertGreaterThanOrEqual(origin.x, visible.minX)
            XCTAssertGreaterThanOrEqual(origin.y, visible.minY)
            XCTAssertLessThanOrEqual(origin.x + 160, visible.maxX)
            XCTAssertLessThanOrEqual(origin.y + 140, visible.maxY)
        }
    }

    /// 节点多起来之后，落位不能退化成一次「扫全图」。100 / 300 / 500 个
    /// 占位节点各跑一次：结果仍可用（不压住已有节点、同批不重叠），
    /// 且耗时留在一次点击可接受的范围里。
    func testPlacementStaysUsableWithHundredsOfOccupiedFrames() {
        let size = CGSize(width: 220, height: 170)
        for count in [100, 300, 500] {
            var occupied: [CGRect] = []
            let columns = 20
            for index in 0..<count {
                occupied.append(CGRect(x: CGFloat(index % columns) * 240,
                                       y: CGFloat(index / columns) * 200,
                                       width: 220, height: 170))
            }
            let visible = CGRect(x: 0, y: 0, width: 1_200, height: 2_000)

            let start = CFAbsoluteTimeGetCurrent()
            let origins = CanvasPlacement.origins(
                sizes: Array(repeating: size, count: 4),
                occupied: occupied, in: visible)
            let elapsed = CFAbsoluteTimeGetCurrent() - start

            XCTAssertEqual(origins.count, 4)
            XCTAssertLessThan(elapsed, 0.2, "\(count) 个占位节点下的落位耗时")
            for origin in origins {
                let frame = CGRect(origin: origin, size: size)
                XCTAssertFalse(occupied.contains { $0.intersects(frame) },
                               "\(count) 个占位时不能压住已有节点")
            }
        }
    }

    /// 可见区被占满时：顺着已有内容的下方排，而不是叠上去。
    func testWhenTheVisibleAreaIsFullNodesGoBelowTheContent() {
        let occupied = [CGRect(x: -200, y: -200, width: 900, height: 1_200)]
        let size = CGSize(width: 220, height: 170)
        let origin = CanvasPlacement.origins(sizes: [size], occupied: occupied, in: visible)[0]

        XCTAssertGreaterThanOrEqual(origin.y, occupied[0].maxY)
    }

    // MARK: - 双指中心

    /// 捏合时两指中心既拉开距离也会移动。中心点下面的世界内容必须一直压在
    /// 中心点上，否则内容会在手指底下漂——这是 `MagnifyGesture.startAnchor`
    /// 单独做不到的那一半。
    func testPinchKeepsTheWorldPointUnderTheMovingCentroid() {
        let start = CanvasViewport(scale: 1, offset: CGSize(width: 30, height: -20))
        let centroidStart = CGPoint(x: 200, y: 300)
        let anchor = start.worldPoint(centroidStart)

        // 拉开到 1.6 倍，同时中心点移到另一处。
        let moved = start.pinched(to: 1.6,
                                  centroid: CGPoint(x: 260, y: 240),
                                  anchorWorld: anchor)

        XCTAssertEqual(moved.scale, 1.6, accuracy: 0.0001)
        let under = moved.screenPoint(anchor)
        XCTAssertEqual(under.x, 260, accuracy: 0.001)
        XCTAssertEqual(under.y, 240, accuracy: 0.001)
    }

    /// 连续缩放都从**同一个 base** 解算：先后两次变化的中间态不会累积误差，
    /// 松手也就不会跳位。
    func testPinchIsComputedFromTheBaseViewportNotAccumulated() {
        let base = CanvasViewport(scale: 0.8, offset: CGSize(width: -120, height: 60))
        let anchor = base.worldPoint(CGPoint(x: 140, y: 480))

        let mid = base.pinched(to: 1.2, centroid: CGPoint(x: 150, y: 470), anchorWorld: anchor)
        let end = base.pinched(to: 2.0, centroid: CGPoint(x: 180, y: 420), anchorWorld: anchor)

        XCTAssertEqual(mid.scale, 1.2, accuracy: 0.0001)
        XCTAssertEqual(end.scale, 2.0, accuracy: 0.0001)
        XCTAssertEqual(end.screenPoint(anchor).x, 180, accuracy: 0.001)
        XCTAssertEqual(end.screenPoint(anchor).y, 420, accuracy: 0.001)
    }

    /// 缩放比例有上下限；钳住之后锚点依然稳定。
    func testPinchClampsScaleAndKeepsTheAnchor() {
        let base = CanvasViewport(scale: 1, offset: .zero)
        let anchor = base.worldPoint(CGPoint(x: 100, y: 100))
        let clamped = base.pinched(to: 99, centroid: CGPoint(x: 100, y: 100), anchorWorld: anchor)
        XCTAssertEqual(clamped.scale, CanvasViewport.maxScale, accuracy: 0.0001)
        let under = clamped.screenPoint(anchor)
        XCTAssertEqual(under.x, 100, accuracy: 0.001)
        XCTAssertEqual(under.y, 100, accuracy: 0.001)
    }
}
