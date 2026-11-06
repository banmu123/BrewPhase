import SwiftUI
import UIKit

/// 把 `UIPinchGestureRecognizer` 挂到画布所在的宿主视图上。
///
/// 为什么不用 SwiftUI 的 `MagnifyGesture`：它只给「手势开始时的锚点」
/// （`startAnchor`），拿不到两指中心的**实时**位置。于是「捏合的同时移动两指」
/// 只能做到缩放，画布不会跟着走——空间感就断在这里。
/// `UIPinchGestureRecognizer.location(in: nil)` 返回的正是两指中心的窗口坐标，
/// 它既是缩放锚点，也自然是这次捏合的平移量。
///
/// 为什么加了它不影响节点：识别器挂在祖先视图上，没有新增任何可交互视图，
/// 也没有改变命中测试；`cancelsTouchesInView = false` 保证不会吞掉节点上的
/// 点击与单指拖动——而捏合本来就需要两指，与单指路径不重叠。
struct CanvasPinchBridge: UIViewRepresentable {

    /// 面板弹出时关掉，免得在面板上捏合把后面的画布缩了。
    var isEnabled: Bool = true
    var onBegan: () -> Void
    /// `scale` 是相对手势开始的倍数；`centroidInWindow` 是两指中心的窗口坐标。
    var onChange: (_ scale: CGFloat, _ centroidInWindow: CGPoint) -> Void
    var onEnded: () -> Void
    /// 识别器真的挂上去了。在此之前 SwiftUI 的缩放手势继续兜底。
    var onReady: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UIView {
        let view = HostView()
        view.isUserInteractionEnabled = false
        view.backgroundColor = .clear
        context.coordinator.update(onBegan: onBegan, onChange: onChange,
                                   onEnded: onEnded, onReady: onReady)
        context.coordinator.attach(from: view)
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.update(onBegan: onBegan, onChange: onChange,
                                   onEnded: onEnded, onReady: onReady)
        context.coordinator.pinch?.isEnabled = isEnabled
    }

    static func dismantleUIView(_ uiView: UIView, coordinator: Coordinator) {
        coordinator.detach()
    }

    private final class HostView: UIView {}

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {

        private var onBegan: () -> Void = {}
        private var onChange: (CGFloat, CGPoint) -> Void = { _, _ in }
        private var onEnded: () -> Void = {}
        private var onReady: () -> Void = {}

        private(set) var pinch: UIPinchGestureRecognizer?
        private weak var host: UIView?
        private var attempts = 0

        func update(onBegan: @escaping () -> Void,
                    onChange: @escaping (CGFloat, CGPoint) -> Void,
                    onEnded: @escaping () -> Void,
                    onReady: @escaping () -> Void) {
            self.onBegan = onBegan
            self.onChange = onChange
            self.onEnded = onEnded
            self.onReady = onReady
        }

        /// 视图刚建出来时还没进窗口，`superview` 链是断的——下一帧再试，
        /// 最多十帧。挂不上就保持 SwiftUI 兜底，不影响正常使用。
        func attach(from view: UIView) {
            DispatchQueue.main.async { [weak self, weak view] in
                guard let self, let view else { return }
                guard let host = Self.ancestorHost(of: view) else {
                    guard self.attempts < 10 else { return }
                    self.attempts += 1
                    self.attach(from: view)
                    return
                }
                self.install(on: host)
            }
        }

        private static func ancestorHost(of view: UIView) -> UIView? {
            var candidate = view.superview
            while let current = candidate {
                if current.window != nil { return current }
                candidate = current.superview
            }
            return nil
        }

        private func install(on host: UIView) {
            guard pinch == nil else { return }
            let gesture = UIPinchGestureRecognizer(target: self, action: #selector(handle(_:)))
            gesture.delegate = self
            gesture.cancelsTouchesInView = false
            gesture.delaysTouchesBegan = false
            gesture.delaysTouchesEnded = false
            host.addGestureRecognizer(gesture)
            self.host = host
            self.pinch = gesture
            onReady()
        }

        @objc private func handle(_ gesture: UIPinchGestureRecognizer) {
            switch gesture.state {
            case .began:
                onBegan()
            case .changed:
                onChange(gesture.scale, gesture.location(in: nil))
            case .ended, .cancelled, .failed:
                onEnded()
            default:
                break
            }
        }

        func detach() {
            if let pinch {
                pinch.view?.removeGestureRecognizer(pinch)
            }
            pinch = nil
            host = nil
        }

        // 与节点拖动、背景平移同时识别：捏合期间由上层用 isPinching 关掉它们，
        // 而不是让系统在其中挑一个赢家。
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            true
        }
    }
}
