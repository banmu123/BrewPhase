import SwiftUI
import AVFoundation

/// 桌面同步：一次「个人空间延伸到桌面」的连续体验，而不是一组设置表单。
///
/// 页面结构（Editorial × Studio × Connection）：
///   未配对  — 品牌 Hero → 连接插画 → 配对操作 → 下载链接 → 安全边界
///   配对中  — 同一视觉主体，按钮进入 loading，连接线转为活动态
///   首次同步 — Connected 确认页，数据数量来自 `countLocalData`
///   已配对  — 设备面板 + 同步状态/统计 + 立即同步 + 解除配对
///
/// 状态是**派生**的（`stage`），不新增业务状态字段；所有同步动作、Token、
/// 冲突处理、解除配对与远端清理都仍由 `SyncManager` 负责，本文件只负责呈现。
struct DesktopSyncView: View {
    @Environment(\.modelContext) private var context
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// 与「记录增删后的自动推送」共用同一个实例：否则自动同步成功了，
    /// 这一页还显示着旧的上次同步时间。
    @ObservedObject private var manager = SyncManager.shared

    @State private var showsScanner = false
    /// 正常启动为 nil；只有 UI inspection 会预置一条展示用错误。
    @State private var pairingError: String? = DebugLaunch.syncInspectionError
    /// 正常启动为 false；只有 UI inspection 会预置「正在配对」。
    @State private var pairingInFlight = DebugLaunch.showsSyncPairing
    /// 刚配对成功、还没做首次同步：展示确认区。日常启动恒为 false；
    /// 只有带 `-BrewPhaseScreen desktopSyncFirstSync` 的 UI inspection 会预置它。
    @State private var awaitingFirstSync = DebugLaunch.showsSyncFirstSyncConfirmation
    @State private var localCounts: SyncManager.LocalCounts?
    /// 解除配对要选后果：只断开，还是连 Mac 上的同步内容一起清掉。
    @State private var showsUnpairOptions = false
    @State private var unpairNote: String?

    /// UI 的连续阶段。只从现有字段推算，避免再维护一份会漂移的状态机。
    private enum Stage: Equatable {
        case unpaired
        case pairing
        case firstSync(SyncManager.LocalCounts)
        case paired
    }

    var body: some View {
        ScrollView {
            Group {
                switch stage {
                case .unpaired, .pairing:
                    connectionPage
                        .transition(.opacity)
                case .firstSync(let counts):
                    firstSyncPage(counts)
                        .transition(.opacity)
                case .paired:
                    pairedPage
                        .transition(.opacity)
                }
            }
            .animation(reduceMotion ? Motion.fade : Motion.settle, value: stage)
            .padding(.horizontal, Metric.gutter)
            // 底部留出完整的一格呼吸，安全区域由 ScrollView 自己接管。
            .padding(.bottom, Metric.Space.xxxxl)
        }
        .background(Palette.paper)
        .navigationTitle("桌面同步")
        .navigationBarTitleDisplayMode(.inline)
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

    private var stage: Stage {
        guard pairedDevice != nil else {
            return pairingInFlight ? .pairing : .unpaired
        }
        if awaitingFirstSync, let counts = localCounts { return .firstSync(counts) }
        return .paired
    }

    // MARK: - 未配对 / 配对中

    private var connectionPage: some View {
        VStack(alignment: .leading, spacing: 0) {
            editorialHero
            ConnectionIllustration(active: pairingInFlight)
                .padding(.top, Metric.Space.lg)
            pairingSection
                .padding(.top, Metric.Space.xl)
            downloadLink
                .padding(.top, Metric.Space.sm)
            // 解除配对的结果（尤其是「远端没清成」）必须在断开之后还看得见。
            if let unpairNote {
                unpairNotice(unpairNote)
                    .padding(.top, Metric.Space.lg)
            }
            privacyFooter
                .padding(.top, Metric.Space.sm)
        }
    }

    private var editorialHero: some View {
        VStack(alignment: .leading, spacing: Metric.Space.sm) {
            // 拉丁字专属的衬线小字；中文标题留在无衬线阶梯上。
            Text(verbatim: "BREWPHASE / CONNECTION")
                .font(TypeScale.brandMark)
                .italic()
                .tracking(2.4)
                .foregroundStyle(Palette.inkFaint)

            Text("让你的个人空间，延伸到桌面。")
                .font(TypeScale.greeting)
                .foregroundStyle(Palette.ink)
                .lineSpacing(5)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, Metric.Space.sm)

            // 一条短线作编辑式分隔，不叠卡片、不加阴影。
            Rectangle()
                .fill(Palette.latte)
                .frame(width: 30, height: 1)
                .padding(.top, Metric.Space.xxs)

            Text("咖啡、记录与画布，在你的设备之间自然延续。")
                .font(TypeScale.callout)
                .foregroundStyle(Palette.inkSoft)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, Metric.Space.xxl)
    }

    private var pairingSection: some View {
        VStack(alignment: .leading, spacing: Metric.Space.md) {
            Text("连接你的桌面端")
                .font(TypeScale.cardTitle)
                .foregroundStyle(Palette.espresso)

            Text("打开 BrewPhase Desktop，在设备同步中生成配对二维码。")
                .font(TypeScale.callout)
                .foregroundStyle(Palette.inkSoft)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)

            scanButton
                .padding(.top, Metric.Space.xs)

            if pairingInFlight {
                pairingProgress
            }
            if let pairingError {
                pairingFailure(pairingError)
            }
        }
    }

    private var scanButton: some View {
        Button {
            showsScanner = true
        } label: {
            HStack(spacing: 9) {
                if pairingInFlight {
                    ProgressView()
                        .tint(Palette.card)
                        .scaleEffect(0.85)
                } else {
                    Image(systemName: "qrcode.viewfinder")
                        .font(.system(size: 16, weight: .medium))
                }
                if pairingInFlight {
                    Text("正在连接桌面端…")
                } else {
                    Text("扫描二维码")
                }
            }
            .font(TypeScale.bodyMedium)
            .foregroundStyle(Palette.card)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(
                RoundedRectangle(cornerRadius: Metric.radiusSmall + 2, style: .continuous)
                    .fill(Palette.espresso)
            )
        }
        .buttonStyle(CardButtonStyle())
        .disabled(pairingInFlight)
    }

    /// 配对没有可观测的百分比进度，所以只陈述确实发生了什么，不编造阶段数字。
    private var pairingProgress: some View {
        VStack(alignment: .leading, spacing: Metric.Space.sm) {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 12))
                    .foregroundStyle(Palette.moss)
                Text("已读取二维码")
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkSoft)
            }
            HStack(alignment: .center, spacing: 8) {
                ProgressView()
                    .scaleEffect(0.7)
                Text("正在验证桌面端信息并保存连接…")
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, Metric.Space.xxs)
    }

    private func pairingFailure(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: Metric.Space.xs) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.circle")
                    .font(.system(size: 13, weight: .medium))
                Text(verbatim: message)
                    .font(TypeScale.caption)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .foregroundStyle(Palette.priority)

            Button {
                showsScanner = true
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.counterclockwise")
                        .font(.system(size: 11, weight: .semibold))
                    Text("重新扫描")
                        .font(TypeScale.callout.weight(.medium))
                }
                .foregroundStyle(Palette.roast)
            }
            .buttonStyle(.plain)
            .disabled(pairingInFlight)
        }
        .padding(.horizontal, Metric.Space.md)
        .padding(.vertical, Metric.Space.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Metric.radiusSmall, style: .continuous)
                .fill(Palette.priority.opacity(0.06))
        )
    }

    private var downloadLink: some View {
        Link(destination: AppLinks.desktopDownload) {
            HStack(spacing: 5) {
                Text("还没有安装？下载桌面端")
                    .font(TypeScale.callout)
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 10, weight: .semibold))
            }
            .foregroundStyle(Palette.roast)
            .frame(maxWidth: .infinity, minHeight: 36)
        }
    }

    private var privacyFooter: some View {
        VStack(alignment: .leading, spacing: Metric.Space.sm) {
            Hairline()

            HStack(spacing: 7) {
                Image(systemName: "shield")
                    .font(.system(size: 11, weight: .medium))
                Text("仅在可信局域网内同步 · iPhone → Desktop")
                    .font(TypeScale.caption)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .foregroundStyle(Palette.inkFaint)
            .padding(.top, Metric.Space.sm)

            // 安全边界不能含糊：明文 HTTP、无 TLS、单向同步都要写在页面上。
            Text("局域网传输使用 HTTP（无 TLS），不要在公共网络使用；当前为 iPhone → Desktop 单向同步，桌面端的修改不会自动回传 iPhone。")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func unpairNotice(_ note: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "info.circle")
                .font(.system(size: 12, weight: .medium))
            Text(verbatim: note)
                .font(TypeScale.caption)
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(Palette.inkSoft)
        .padding(Metric.Space.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Metric.radiusSmall, style: .continuous)
                .fill(Palette.well)
        )
    }

    // MARK: - 首次同步确认

    private func firstSyncPage(_ counts: SyncManager.LocalCounts) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(verbatim: "CONNECTED")
                .font(TypeScale.brandMark)
                .italic()
                .tracking(2.4)
                .foregroundStyle(Palette.roast)
                .padding(.top, Metric.Space.xxxl)

            Text("你的桌面空间已准备就绪。")
                .font(TypeScale.greeting)
                .foregroundStyle(Palette.ink)
                .lineSpacing(5)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, Metric.Space.md)

            Text("先确认要带过去的内容，再开始第一次同步。")
                .font(TypeScale.callout)
                .foregroundStyle(Palette.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, Metric.Space.sm)

            devicePanel(compact: true)
                .padding(.top, Metric.Space.xl)

            SectionLabel(title: "即将同步的数据")
                .padding(.top, Metric.Space.xl)

            dataBreakdown(counts)
                .padding(.top, Metric.Space.sm)

            firstSyncButton
                .padding(.top, Metric.Space.xl)

            firstSyncNotes
                .padding(.top, Metric.Space.lg)
                .padding(.bottom, Metric.Space.md)
        }
    }

    /// 有数量的分类严格取自 `countLocalData`；标签、规则、节点、媒体没有
    /// 独立计数，只说明它们随内容一起走，不虚构数字。
    private func dataBreakdown(_ counts: SyncManager.LocalCounts) -> some View {
        VStack(spacing: 0) {
            dataCountRow(symbol: "cup.and.saucer", title: "咖啡豆及相关记录", count: counts.beans)
            dataCountRow(symbol: "drop", title: "冲煮", count: counts.brews)
            dataCountRow(symbol: "sparkles", title: "品鉴", count: counts.tastings)
            dataCountRow(symbol: "square.on.square", title: "收藏记录", count: counts.records)
            dataCountRow(symbol: "square.grid.2x2", title: "画布", count: counts.canvases)

            CardDivider()
                .padding(.vertical, Metric.Space.xs)

            dataNoteRow(symbol: "tag", title: "标签、阶段规则与画布节点", note: "随内容一起同步")
            dataNoteRow(symbol: "photo", title: "相关媒体文件", note: "按引用自动传输")
        }
    }

    private func dataCountRow(symbol: String, title: LocalizedStringKey, count: Int) -> some View {
        HStack(spacing: Metric.Space.sm) {
            Image(systemName: symbol)
                .font(.system(size: 13))
                .foregroundStyle(Palette.latte)
                .frame(width: 20)
            Text(title)
                .font(TypeScale.body)
                .foregroundStyle(Palette.ink)
            Spacer(minLength: 8)
            Text(verbatim: String(count))
                .font(TypeScale.numeral)
                .foregroundStyle(Palette.inkSoft)
        }
        .padding(.vertical, 9)
    }

    private func dataNoteRow(symbol: String, title: LocalizedStringKey, note: LocalizedStringKey) -> some View {
        HStack(spacing: Metric.Space.sm) {
            Image(systemName: symbol)
                .font(.system(size: 13))
                .foregroundStyle(Palette.hairline)
                .frame(width: 20)
            Text(title)
                .font(TypeScale.callout)
                .foregroundStyle(Palette.inkSoft)
            Spacer(minLength: 8)
            Text(note)
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
        }
        .padding(.vertical, 8)
    }

    private var firstSyncButton: some View {
        Button {
            awaitingFirstSync = false
            Task { await manager.syncNow(context: context) }
        } label: {
            HStack(spacing: 8) {
                if isSyncing {
                    ProgressView()
                        .tint(Palette.card)
                        .scaleEffect(0.85)
                    Text("正在同步…")
                } else {
                    Text("开始首次同步")
                }
            }
            .font(TypeScale.bodyMedium)
            .foregroundStyle(Palette.card)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(
                RoundedRectangle(cornerRadius: Metric.radiusSmall + 2, style: .continuous)
                    .fill(Palette.espresso)
            )
        }
        .buttonStyle(CardButtonStyle())
        .disabled(isSyncing)
    }

    private var firstSyncNotes: some View {
        VStack(alignment: .leading, spacing: Metric.Space.sm) {
            Hairline()
            Text("数据范围与冲突处理")
                .font(TypeScale.section)
                .tracking(1.1)
                .foregroundStyle(Palette.inkSoft)
            Text("将把这台 iPhone 上的咖啡记录、冲煮、品鉴、画布和相关媒体复制到这台电脑。原始 iPhone 数据不会被删除；电脑上已有的不同数据不会被覆盖，冲突会停下来等你裁决。")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - 已配对

    private var pairedPage: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(verbatim: "BREWPHASE / CONNECTION")
                .font(TypeScale.brandMark)
                .italic()
                .tracking(2.4)
                .foregroundStyle(Palette.inkFaint)
                .padding(.top, Metric.Space.xxxl)

            Text("桌面空间，与你同步。")
                .font(TypeScale.greeting)
                .foregroundStyle(Palette.ink)
                .lineSpacing(5)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, Metric.Space.md)

            Text("这台电脑已经加入你的个人空间。")
                .font(TypeScale.callout)
                .foregroundStyle(Palette.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, Metric.Space.sm)

            devicePanel(compact: false)
                .padding(.top, Metric.Space.xl)

            syncStateBlock
                .padding(.top, Metric.Space.xl)

            syncButton
                .padding(.top, Metric.Space.lg)

            unpairButton
                .padding(.top, Metric.Space.md)

            pairedFooter
                .padding(.top, Metric.Space.xl)
        }
    }

    /// 一张设备面板：设备名是视觉主信息，状态是小型标识，时间与结果用信息排版。
    private func devicePanel(compact: Bool) -> some View {
        Card {
            VStack(alignment: .leading, spacing: Metric.Space.md) {
                HStack(alignment: .center, spacing: Metric.Space.sm) {
                    Image(systemName: "laptopcomputer")
                        .font(.system(size: 22, weight: .light))
                        .foregroundStyle(Palette.roast)

                    VStack(alignment: .leading, spacing: 4) {
                        Text(verbatim: deviceName)
                            .font(TypeScale.title)
                            .foregroundStyle(Palette.ink)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        if let hostAddress {
                            Text(verbatim: hostAddress)
                                .font(TypeScale.dataSmall)
                                .foregroundStyle(Palette.inkFaint)
                        }
                    }

                    Spacer(minLength: 6)
                    statusBadge
                }

                if !compact {
                    CardDivider()
                    HStack(alignment: .top, spacing: Metric.Space.md) {
                        infoColumn(title: "最近同步", value: lastSyncText)
                        Spacer(minLength: 8)
                        infoColumn(title: "最近结果", value: lastResultText)
                    }
                }
            }
        }
    }

    private var statusBadge: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(statusColor)
                .frame(width: 6, height: 6)
            // 状态词由 L() 查表得到，已是最终文本，不再走 LocalizedStringKey。
            Text(verbatim: statusLabel)
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkSoft)
                .fixedSize()
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(Capsule(style: .continuous).fill(Palette.well))
    }

    private func infoColumn(title: LocalizedStringKey, value: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
            Text(verbatim: value)
                .font(TypeScale.callout)
                .foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// 同步进度与结果：原有每一条信息（阶段、媒体、冲突、失败原因）都保留，
    /// 只是换成编辑式排版，不再塞进 List 的 footer。
    @ViewBuilder
    private var syncStateBlock: some View {
        switch manager.phase {
        case .done(let applied, let skipped, let conflicts, let failed):
            VStack(alignment: .leading, spacing: Metric.Space.sm) {
                HStack(spacing: 0) {
                    statCell(value: String(applied), label: "新增/更新")
                    statCell(value: String(skipped), label: "内容一致")
                    statCell(value: String(conflicts), label: "冲突")
                    statCell(value: String(failed), label: "失败")
                }

                if conflicts > 0 {
                    Text(L("有 %@ 条冲突停在桌面端的设置页等你裁决。", String(conflicts)))
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.priority)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let media = manager.lastMediaStats, media.images + media.videos + media.failed > 0 {
                    Text(L("媒体文件：图片 %@ · 视频 %@ · 失败 %@", String(media.images), String(media.videos), String(media.failed)))
                        .font(TypeScale.caption)
                        .foregroundStyle(Palette.inkSoft)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if failed > 0 {
                    ForEach(Array(manager.lastFailedReasons.prefix(4).enumerated()), id: \.offset) { _, reason in
                        Text(verbatim: reason)
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.priority)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if manager.lastFailedReasons.count > 4 {
                        Text(L("…等 %@ 条失败", String(manager.lastFailedReasons.count)))
                            .font(TypeScale.caption)
                            .foregroundStyle(Palette.inkFaint)
                    }
                }
            }

        case .failed(let message):
            stateBanner(symbol: "exclamationmark.circle", text: message, tint: Palette.priority)

        case .sendingData(let step):
            progressBanner(
                L("%@（第 %@/10 步）…", SyncManager.stageLabel(for: step), String(step))
            )

        case .sendingMedia(let done, let total):
            progressBanner(
                L("正在传输图片和视频 %@/%@…", String(done), String(total))
            )

        case .preparing:
            progressBanner(L("正在准备数据…"))

        case .idle:
            EmptyView()
        }
    }

    private func statCell(value: String, label: LocalizedStringKey) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: value)
                .font(TypeScale.numeral)
                .foregroundStyle(Palette.ink)
            Text(label)
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
                .fixedSize()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func progressBanner(_ text: String) -> some View {
        HStack(spacing: 9) {
            ProgressView()
                .scaleEffect(0.75)
            Text(verbatim: text)
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Metric.Space.md)
        .padding(.vertical, Metric.Space.sm)
        .background(
            RoundedRectangle(cornerRadius: Metric.radiusSmall, style: .continuous)
                .fill(Palette.well)
        )
    }

    private func stateBanner(symbol: String, text: String, tint: Color) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: symbol)
                .font(.system(size: 13, weight: .medium))
            Text(verbatim: text)
                .font(TypeScale.caption)
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(tint)
        .padding(Metric.Space.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Metric.radiusSmall, style: .continuous)
                .fill(tint.opacity(0.06))
        )
    }

    private var syncButton: some View {
        Button {
            Task { await manager.syncNow(context: context) }
        } label: {
            HStack(spacing: 8) {
                if isSyncing {
                    ProgressView()
                        .tint(Palette.card)
                        .scaleEffect(0.85)
                    Text("正在同步…")
                } else {
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .font(.system(size: 14, weight: .medium))
                    Text("立即同步到桌面端")
                }
            }
            .font(TypeScale.bodyMedium)
            .foregroundStyle(Palette.card)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(
                RoundedRectangle(cornerRadius: Metric.radiusSmall + 2, style: .continuous)
                    .fill(Palette.espresso)
            )
        }
        .buttonStyle(CardButtonStyle())
        .disabled(isSyncing)
    }

    private var unpairButton: some View {
        Button {
            unpairNote = nil
            showsUnpairOptions = true
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "link.badge.minus")
                    .font(.system(size: 12, weight: .medium))
                Text("解除配对")
                    .font(TypeScale.callout.weight(.medium))
            }
            .foregroundStyle(Palette.priority)
            .frame(maxWidth: .infinity, minHeight: 40)
        }
        .buttonStyle(.plain)
    }

    private var pairedFooter: some View {
        VStack(alignment: .leading, spacing: Metric.Space.sm) {
            Hairline()
            Text("第一版方向为 iPhone → 桌面端。两端都改过的数据会停在桌面端的冲突列表里等你裁决。同步走局域网 HTTP（无 TLS），请在可信网络使用，桌面端需保持运行。")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
            Text("这不是云端同步：所有数据都只走局域网。")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - 派生信息

    /// 真实凭据优先；只有带 `-BrewPhaseScreen` 的 UI inspection 才会回退到
    /// 展示用设备信息。生产路径与 `manager.pairedDevice()` 完全一致。
    private var pairedDevice: (host: String, port: Int, deviceId: String, token: String)? {
        manager.pairedDevice() ?? SyncInspection.placeholderDevice
    }

    private var deviceName: String {
        if let inspection = SyncInspection.deviceName { return inspection }
        let stored = SyncKeychain.string(forKey: "desktop.deviceName") ?? ""
        return stored.isEmpty ? "BrewPhase Desktop" : stored
    }

    private var hostAddress: String? {
        guard let device = pairedDevice else { return nil }
        return "\(device.host):\(device.port)"
    }

    /// 本地只知道凭据与最近一次同步结果，不探测在线状态，所以状态词不夸大。
    private var statusLabel: String {
        if isSyncing { return L("正在同步") }
        if case .failed = manager.phase { return L("上次同步失败") }
        return L("已配对")
    }

    private var statusColor: Color {
        if isSyncing { return Palette.roast }
        if case .failed = manager.phase { return Palette.priority }
        return Palette.moss
    }

    private var lastSyncText: String {
        guard let date = manager.lastSyncAt else { return L("尚未同步") }
        return Fmt.dayTime(date)
    }

    private var lastResultText: String {
        switch manager.phase {
        case .done(let applied, _, let conflicts, let failed):
            if conflicts > 0 { return L("有 %@ 条冲突", String(conflicts)) }
            if failed > 0 { return L("有 %@ 条失败", String(failed)) }
            return L("已同步 %@ 项", String(applied))
        case .failed:
            return L("同步失败")
        case .preparing, .sendingData, .sendingMedia:
            return L("进行中")
        case .idle:
            return manager.lastSyncAt == nil ? L("暂无结果") : L("已完成")
        }
    }

    private var isSyncing: Bool {
        switch manager.phase {
        case .preparing, .sendingData, .sendingMedia: return true
        default: return false
        }
    }

    // MARK: - 业务动作（保持原有实现）

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

    private func refreshCounts() {
        guard pairedDevice != nil else { return }
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

// MARK: - 连接插画（自绘轮廓，不用图标堆砌）

/// 手机里的三类内容 → 汇聚成一条细线 → 落到桌面里的内容行。
/// 主体是分层 `Shape`；动效只改透明度，不做 Path 插值——持续重算 Path
/// 的 `repeatForever` 会让整个插画层在模拟器上错位甚至消失。
private struct ConnectionIllustration: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var active: Bool

    @ScaledMetric(relativeTo: .body) private var plateHeight: CGFloat = 156
    @State private var isBreathing = false

    var body: some View {
        ZStack {
            ConnectionDiagram(active: active)
            ConnectionFlow(progress: 0.55)
                .stroke(
                    active ? Palette.roast : Palette.latte,
                    style: StrokeStyle(lineWidth: 2.2, lineCap: .round)
                )
                .opacity(reduceMotion ? 1 : (isBreathing ? 1 : 0.55))
        }
        .frame(maxWidth: .infinity)
        .frame(height: plateHeight)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(Animation.easeInOut(duration: 2.4).repeatForever(autoreverses: true)) {
                isBreathing = true
            }
        }
        .accessibilityHidden(true)
    }
}

/// 所有几何都从同一个 rect 推导；分层 Shape 叠加，不依赖 Canvas 的绘制时机。
private enum DiagramGeometry {
    static func screen(_ r: CGRect) -> CGRect {
        CGRect(x: r.width * 0.595, y: r.height * 0.12,
               width: r.width * 0.365, height: r.height * 0.56)
    }

    static func phone(_ r: CGRect) -> CGRect {
        CGRect(x: r.width * 0.055, y: r.height * 0.055,
               width: r.width * 0.235, height: r.height * 0.80)
    }

    static var moduleYs: [CGFloat] { [0.34, 0.50, 0.66] }
    static var rowYs: [CGFloat] { [0.44, 0.61, 0.78] }

    static func junction(_ r: CGRect) -> CGPoint {
        CGPoint(x: r.width * 0.30, y: r.height * 0.50)
    }

    static func link(_ r: CGRect) -> Path {
        var path = Path()
        path.move(to: junction(r))
        path.addCurve(
            to: CGPoint(x: r.width * 0.595, y: r.height * 0.47),
            control1: CGPoint(x: r.width * 0.40, y: r.height * 0.36),
            control2: CGPoint(x: r.width * 0.49, y: r.height * 0.62)
        )
        return path
    }
}

private struct ConnectionDiagram: View {
    var active: Bool

    private var accent: Color { Palette.roast.opacity(active ? 0.95 : 0.75) }

    var body: some View {
        ZStack {
            DiagramSurfaces()
                .fill(Palette.well.opacity(0.5))
            DiagramOutlines()
                .stroke(
                    Palette.inkFaint.opacity(0.7),
                    style: StrokeStyle(lineWidth: 1.1, lineCap: .round)
                )
            DiagramLink()
                .stroke(
                    Palette.roast.opacity(0.5),
                    style: StrokeStyle(lineWidth: 1.3, lineCap: .round, dash: [4, 4])
                )
            DiagramAccents()
                .fill(accent)
        }
    }
}

/// 两块浅灰面：桌面屏幕与手机机身，靠明度而不是阴影分层。
private struct DiagramSurfaces: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        p.addPath(RoundedRectangle(cornerRadius: 9, style: .continuous)
            .path(in: DiagramGeometry.screen(r)))
        p.addPath(RoundedRectangle(cornerRadius: 13, style: .continuous)
            .path(in: DiagramGeometry.phone(r)))
        return p
    }
}

/// 全部细线：设备轮廓、顶栏、内容行、底座、听筒、三条汇聚支线。
private struct DiagramOutlines: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        let s = DiagramGeometry.screen(r)
        let phone = DiagramGeometry.phone(r)

        p.addPath(RoundedRectangle(cornerRadius: 9, style: .continuous).path(in: s))
        p.addPath(RoundedRectangle(cornerRadius: 13, style: .continuous).path(in: phone))

        let barY = s.minY + s.height * 0.22
        p.move(to: CGPoint(x: s.minX + 13, y: barY))
        p.addLine(to: CGPoint(x: s.maxX - 13, y: barY))

        for f in DiagramGeometry.rowYs {
            let y = s.minY + s.height * f
            p.move(to: CGPoint(x: s.minX + 28, y: y))
            p.addLine(to: CGPoint(x: s.maxX - 15, y: y))
        }

        p.move(to: CGPoint(x: s.midX, y: s.maxY))
        p.addLine(to: CGPoint(x: s.midX, y: s.maxY + r.height * 0.075))
        p.move(to: CGPoint(x: s.midX - r.width * 0.072, y: s.maxY + r.height * 0.082))
        p.addLine(to: CGPoint(x: s.midX + r.width * 0.072, y: s.maxY + r.height * 0.082))

        p.move(to: CGPoint(x: phone.midX - 9, y: phone.minY + 9))
        p.addLine(to: CGPoint(x: phone.midX + 9, y: phone.minY + 9))

        let junction = DiagramGeometry.junction(r)
        for f in DiagramGeometry.moduleYs {
            let y = r.height * f
            p.move(to: CGPoint(x: phone.maxX - 2, y: y))
            p.addQuadCurve(
                to: junction,
                control: CGPoint(x: r.width * 0.265, y: y + (junction.y - y) * 0.35)
            )
        }
        return p
    }
}

private struct DiagramLink: Shape {
    func path(in r: CGRect) -> Path { DiagramGeometry.link(r) }
}

/// 三个几何模块 + 桌面接收点 + 两端节点。实心小形，不堆 SF Symbols。
private struct DiagramAccents: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        let phone = DiagramGeometry.phone(r)
        let s = DiagramGeometry.screen(r)
        let mx = phone.minX + phone.width * 0.28
        let ys = DiagramGeometry.moduleYs.map { r.height * $0 }

        // Coffee：圆 · Records：两条短线 · Canvas：方框
        p.addEllipse(in: CGRect(x: mx - 6, y: ys[0] - 6, width: 12, height: 12))
        p.addRect(CGRect(x: mx - 7, y: ys[1] - 4, width: 14, height: 2))
        p.addRect(CGRect(x: mx - 7, y: ys[1] + 2, width: 14, height: 2))
        p.addRect(CGRect(x: mx - 6, y: ys[2] - 6, width: 12, height: 12))

        for f in DiagramGeometry.rowYs {
            let y = s.minY + s.height * f
            p.addEllipse(in: CGRect(x: s.minX + 15, y: y - 2.5, width: 5, height: 5))
        }

        let junction = DiagramGeometry.junction(r)
        for point in [junction, CGPoint(x: r.width * 0.595, y: r.height * 0.47)] {
            p.addEllipse(in: CGRect(x: point.x - 3, y: point.y - 3, width: 6, height: 6))
        }
        return p
    }
}

/// 主曲线中段的短描边：给静止的连接线一个「正在连通」的落点。
/// 进度固定，不做 Path 插值；页面的动效交给插画层的透明度呼吸。
private struct ConnectionFlow: Shape {
    var progress: CGFloat

    func path(in rect: CGRect) -> Path {
        let end = min(1, max(0, progress))
        let start = min(end, max(0, progress - 0.18))
        return DiagramGeometry.link(rect).trimmedPath(from: start, to: end)
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
