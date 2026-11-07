import SwiftUI
import AVFoundation

/// 桌面同步：扫码配对 + 首次同步确认 + 同步状态。保持 iOS 既有视觉语言，不做改版。
struct DesktopSyncView: View {
    @Environment(\.modelContext) private var context
    @StateObject private var manager = SyncManager()
    @State private var showsScanner = false
    @State private var pairingError: String?
    @State private var pairingInFlight = false
    /// 刚配对成功、还没做首次同步：展示确认区。
    @State private var awaitingFirstSync = false
    @State private var localCounts: SyncManager.LocalCounts?

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

                if awaitingFirstSync, let counts = localCounts {
                    firstSyncConfirm(counts)
                }

                Section {
                    syncResult
                    Button {
                        Task { await manager.syncNow(context: context) }
                    } label: {
                        if isSyncing {
                            HStack { ProgressView(); Text("正在同步…") }
                        } else {
                            Text("立即同步到桌面端")
                        }
                    }
                    .disabled(isSyncing)

                    Button("解除配对", role: .destructive) {
                        manager.unpair()
                        awaitingFirstSync = false
                        localCounts = nil
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
                    .disabled(pairingInFlight)
                    if pairingInFlight {
                        HStack { ProgressView(); Text("正在连接桌面端…") }
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
        .onAppear(perform: refreshCounts)
    }

    /// 首次同步确认（§4）：明确告诉用户会发生什么，需要一次主动确认。
    private func firstSyncConfirm(_ counts: SyncManager.LocalCounts) -> some View {
        Section {
            LabeledContent("将同步的内容", value: counts.summary)
            Button {
                awaitingFirstSync = false
                Task { await manager.syncNow(context: context) }
            } label: {
                if isSyncing {
                    HStack { ProgressView(); Text("正在同步…") }
                } else {
                    Text("开始首次同步").fontWeight(.semibold)
                }
            }
            .disabled(isSyncing)
        } header: {
            Text("已连接桌面端")
        } footer: {
            Text("将把这台 iPhone 上的咖啡记录、冲煮、品鉴、画布和相关媒体复制到这台电脑。原始 iPhone 数据不会被删除；电脑上已有的不同数据不会被覆盖，冲突会停下来等你裁决。")
        }
    }

    @ViewBuilder
    private var syncResult: some View {
        switch manager.phase {
        case .done(let applied, let skipped, let conflicts, let failed):
            VStack(alignment: .leading, spacing: 4) {
                Text("同步完成：已新增/更新 \(applied) · 内容一致 \(skipped) · 冲突 \(conflicts) · 失败 \(failed)")
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkSoft)
                if conflicts > 0 {
                    Text("有 \(conflicts) 条冲突停在桌面端的设置页等你裁决。")
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.priority)
                }
                if let media = manager.lastMediaStats, media.images + media.videos + media.failed > 0 {
                    Text("媒体文件：图片 \(media.images) · 视频 \(media.videos) · 失败 \(media.failed)")
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkSoft)
                }
            }
        case .failed(let message):
            Text(message).font(TypeScale.caption).foregroundStyle(Palette.priority)
        case .sendingData(let step):
            Text("\(SyncManager.stageLabel(for: step))（第 \(step)/10 步）…")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkSoft)
        case .sendingMedia(let done, let total):
            Text("正在传输图片和视频 \(done)/\(total)…")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkSoft)
        case .preparing:
            Text("正在准备数据…").font(TypeScale.caption).foregroundStyle(Palette.inkSoft)
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

    private func refreshCounts() {
        guard manager.pairedDevice() != nil else { return }
        localCounts = SyncManager.countLocalData(context: context)
    }

    private func handleScanned(_ raw: String) {
        guard let link = SyncPairingLink.parse(raw) else {
            pairingError = "这不是 BrewPhase 的配对二维码"
            return
        }
        pairingError = nil
        pairingInFlight = true
        Task {
            defer { pairingInFlight = false }
            do {
                let response = try await manager.pair(with: link, deviceName: UIDevice.current.name)
                awaitingFirstSync = true
                refreshCounts()
                _ = response
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
