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

    /// 可见区被占满时：顺着已有内容的下方排，而不是叠上去。
    func testWhenTheVisibleAreaIsFullNodesGoBelowTheContent() {
        let occupied = [CGRect(x: -200, y: -200, width: 900, height: 1_200)]
        let size = CGSize(width: 220, height: 170)
        let origin = CanvasPlacement.origins(sizes: [size], occupied: occupied, in: visible)[0]

        XCTAssertGreaterThanOrEqual(origin.y, occupied[0].maxY)
    }
}
