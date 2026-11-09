import SwiftUI
import AVFoundation

/// 桌面同步：扫码配对 + 首次同步确认 + 同步状态。保持 iOS 既有视觉语言，不做改版。
struct DesktopSyncView: View {
    @Environment(\.modelContext) private var context
    /// 与「记录增删后的自动推送」共用同一个实例：否则自动同步成功了，
    /// 这一页还显示着旧的上次同步时间。
    @ObservedObject private var manager = SyncManager.shared
    @State private var showsScanner = false
    @State private var pairingError: String?
    @State private var pairingInFlight = false
    /// 刚配对成功、还没做首次同步：展示确认区。
    @State private var awaitingFirstSync = false
    @State private var localCounts: SyncManager.LocalCounts?
    /// 解除配对要选后果：只断开，还是连 Mac 上的同步内容一起清掉。
    @State private var showsUnpairOptions = false
    @State private var unpairNote: String?

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
                        unpairNote = nil
                        showsUnpairOptions = true
                    }
                    if let unpairNote {
                        Text(unpairNote).font(TypeScale.caption).foregroundStyle(Palette.inkFaint)
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
        .confirmationDialog("解除配对", isPresented: $showsUnpairOptions, titleVisibility: .visible) {
            Button("解除并清空 Mac 上的同步内容", role: .destructive) {
                Task { await performUnpair(wipe: true) }
            }
            Button("只解除配对", role: .destructive) {
                Task { await performUnpair(wipe: false) }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text(
                "清空会删掉 Mac 上从这台手机同步过来的内容：记录、标签、画布、媒体文件，以及全部咖啡数据——豆子、冲煮、品鉴（包括 Mac 上自己录入的）。清空不可恢复。"
            )
        }
    }

    /// 先让桌面端处置数据与授权，再清本地凭据（顺序见 `SyncManager.unpair`）。
    private func performUnpair(wipe: Bool) async {
        let outcome = await manager.unpair(wipeRemote: wipe)
        awaitingFirstSync = false
        localCounts = nil
        switch outcome {
        case .clean:
            unpairNote = wipe ? L("已解除配对，Mac 上的同步内容已清空。") : L("已解除配对。")
        case .incomplete(let notes):
            // 逐条说清远端还剩什么没做：断开成功 ≠ 清空成功 ≠ 授权已撤销。
            unpairNote = notes.joined(separator: "\n")
        }
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
                Text(L("同步完成：已新增/更新 %@ · 内容一致 %@ · 冲突 %@ · 失败 %@", String(applied), String(skipped), String(conflicts), String(failed)))
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkSoft)
                if conflicts > 0 {
                    Text(L("有 %@ 条冲突停在桌面端的设置页等你裁决。", String(conflicts)))
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.priority)
                }
                if let media = manager.lastMediaStats, media.images + media.videos + media.failed > 0 {
                    Text(L("媒体文件：图片 %@ · 视频 %@ · 失败 %@", String(media.images), String(media.videos), String(media.failed)))
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkSoft)
                }
                if failed > 0 {
                    ForEach(Array(manager.lastFailedReasons.prefix(4).enumerated()), id: \.offset) { _, reason in
                        Text(reason)
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.priority)
                    }
                    if manager.lastFailedReasons.count > 4 {
                        Text(L("…等 %@ 条失败", String(manager.lastFailedReasons.count)))
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.inkFaint)
                    }
                }
            }
        case .failed(let message):
            Text(message).font(TypeScale.caption).foregroundStyle(Palette.priority)
        case .sendingData(let step):
            Text(L("%@（第 %@/10 步）…", SyncManager.stageLabel(for: step), String(step)))
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkSoft)
        case .sendingMedia(let done, let total):
            Text(L("正在传输图片和视频 %@/%@…", String(done), String(total)))
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
            pairingError = L("这不是 BrewPhase 的配对二维码")
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
