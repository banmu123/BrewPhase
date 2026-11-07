import SwiftUI
import AVFoundation

/// 桌面同步：扫码配对 + 同步状态。保持 iOS 既有视觉语言，不做改版。
struct DesktopSyncView: View {
    @Environment(\.modelContext) private var context
    @StateObject private var manager = SyncManager()
    @State private var showsScanner = false
    @State private var pairingError: String?
    @State private var pairedName: String?

    var body: some View {
        List {
            if let device = manager.pairedDevice() {
                Section {

                    LabeledContent("设备", value: SyncKeychain.string(forKey: "desktop.deviceName") ?? "BrewPhase Desktop")
                    LabeledContent("地址", value: "\(device.host):\(device.port)")
                    if let lastSync = manager.lastSyncAt {
                        LabeledContent("上次同步", value: Fmt.precise(lastSync, calendar: DateMath.calendar))
                    }
                }

                Section {
                    syncResult
                    Button {
                        Task { await manager.syncNow(context: context) }
                    } label: {
                        if case .preparing = manager.phase {
                            HStack { ProgressView(); Text("正在同步…") }
                        } else {
                            Text("立即同步到桌面端")
                        }
                    }
                    .disabled(isSyncing)

                    Button("解除配对", role: .destructive) {
                        manager.unpair()
                        pairedName = nil
                    }
                } header: {
                    Text("已配对桌面端")
                } footer: {
                    Text("第一版方向为 iPhone → 桌面端。两端都改过的数据会停在桌面端的冲突列表里等你裁决。")
                }
            } else {
                Section {

                    Button {
                        showsScanner = true
                    } label: {
                        Label("扫描桌面端二维码", systemImage: "qrcode.viewfinder")
                    }
                    if let pairedName {
                        Text(pairedName).foregroundStyle(Palette.inkFaint)
                    }
                    if let pairingError {
                        Text(pairingError).foregroundStyle(Palette.priority)
                    }
                } header: {
                    Text("连接桌面端")
                } footer: {
                    Text("在 BrewPhase Desktop 的「更多 → 设备同步」里启用同步并出示二维码。")
                }
            }
        }
        .navigationTitle("桌面同步")
        .sheet(isPresented: $showsScanner) {
            SyncQRScannerView { raw in
                showsScanner = false
                handleScanned(raw)
            }
            .ignoresSafeArea()
        }
    }

    @ViewBuilder
    private var syncResult: some View {
        switch manager.phase {
        case .done(let applied, let skipped, let conflicts, let failed):
            Text("已应用 \(applied) · 一致 \(skipped) · 冲突 \(conflicts) · 失败 \(failed)")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkSoft)
        case .failed(let message):
            Text(message).font(TypeScale.caption).foregroundStyle(Palette.priority)
        case .sendingData(let step):
            Text("正在同步数据（第 \(step) 批）…").font(TypeScale.caption).foregroundStyle(Palette.inkSoft)
        case .sendingMedia(let done, let total):
            Text("正在传输媒体 \(done)/\(total)…").font(TypeScale.caption).foregroundStyle(Palette.inkSoft)
        default:
            EmptyView()
        }
    }

    private var isSyncing: Bool {
        switch manager.phase {
        case .preparing, .sendingData, .sendingMedia: return true
        default: return false
        }
    }

    private func handleScanned(_ raw: String) {
        guard let link = SyncPairingLink.parse(raw) else {
            pairingError = "这不是 BrewPhase 的配对二维码"
            return
        }
        pairingError = nil
        Task {
            do {
                let response = try await manager.pair(with: link, deviceName: UIDevice.current.name)
                pairedName = response.desktopDeviceName
            } catch {
                pairingError = error.localizedDescription
            }
        }
    }
}

// MARK: - 扫码（AVFoundation，只负责读码，解析交给 SyncPairingLink）

struct SyncQRScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onCode = onCode
        return controller
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {}

    final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onCode: ((String) -> Void)?
        private var session: AVCaptureSession?
        private let handledLock = NSLock()
        private var lastHandledCode: String?

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black

            guard AVCaptureDevice.default(for: .video) != nil else { return }
            let session = AVCaptureSession()
            guard let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device),
                  session.canAddInput(input) else { return }
            session.addInput(input)

            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]

            let preview = AVCaptureVideoPreviewLayer(session: session)
            preview.videoGravity = .resizeAspectFill
            preview.frame = view.bounds
            view.layer.addSublayer(preview)
            view.layer.insertSublayer(preview, at: 0)

            self.session = session
            DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            session?.stopRunning()
        }

        func metadataOutput(
            _ output: AVCaptureMetadataOutput,
            didOutput metadataObjects: [AVMetadataObject],
            from connection: AVCaptureConnection
        ) {
            guard let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
                  object.type == .qr,
                  let value = object.stringValue else { return }
            handledLock.lock()
            let duplicate = lastHandledCode == value
            lastHandledCode = value
            handledLock.unlock()
            guard !duplicate else { return }
            onCode?(value)
        }
    }
}
