import SwiftUI
import WebKit

/// 播放器的三种状态。加载失败不是「这条记录坏了」——封面和原链接都还在。
enum ExternalPlayerState: Equatable {
    case loading
    case ready
    case failed
}

/// 统一的嵌入容器。
///
/// 它只做一件事：把**适配器拼出来的**地址放进 WKWebView 播放。它不接收 HTML，
/// 也不接收用户给的 embed 地址；主框架里任何越界的跳转都交给系统浏览器，
/// 所以一个被篡改的链接最多只能打开一个不相关的网页，不能把播放器变成一个
/// 任意浏览器。
///
/// `mediaTypesRequiringUserActionForPlayback = .all` 是第二道保险：即使播放器
/// 页面自己想自动播，iOS 也会等一次点击。
struct ExternalMediaPlayer: UIViewRepresentable {

    let embed: LinkEmbed
    @Binding var state: ExternalPlayerState
    var isScrollEnabled: Bool = false
    /// 帖子是浅色页面，WebView 的底色要跟着白，否则透明区域会露出黑色。
    var prefersDarkChrome: Bool = true
    var onExternalOpen: (URL) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = DebugLaunch.forceAutoplay ? [] : .all
        configuration.allowsPictureInPictureMediaPlayback = false
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.customUserAgent = LinkHTTP.userAgent
        let chrome = prefersDarkChrome ? UIColor.black : UIColor.white
        webView.isOpaque = false
        webView.backgroundColor = chrome
        webView.scrollView.backgroundColor = chrome
        webView.scrollView.isScrollEnabled = isScrollEnabled
        webView.scrollView.bounces = false
        webView.allowsBackForwardNavigationGestures = false

        context.coordinator.load(embed, in: webView)
        return webView
    }

    /// 只在地址真的变了时重新加载。SwiftUI 每次刷新都重载一次播放器，会让
    /// 正在播的视频从零开始。
    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.loadIfNeeded(embed, in: webView)
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        // 收起播放器必须真的停下来：否则音频会在后台继续响。
        coordinator.cancel()
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.loadHTMLString("", baseURL: nil)
    }

    final class Coordinator: NSObject, WKNavigationDelegate {

        var parent: ExternalMediaPlayer
        private var loaded: URL?
        /// 页面在 18 秒内没有任何回应就当失败：加载失败的播放器不该永远转圈。
        private var watchdog: DispatchWorkItem?
        private var settled = false

        init(_ parent: ExternalMediaPlayer) {
            self.parent = parent
        }

        func loadIfNeeded(_ embed: LinkEmbed, in webView: WKWebView) {
            guard loaded != embed.url else { return }
            load(embed, in: webView)
        }

        func load(_ embed: LinkEmbed, in webView: WKWebView) {
            loaded = embed.url
            settled = false
            report(.loading)

            let target = playbackURL(for: embed)
            AppLog.link.info("player load: \(target.absoluteString, privacy: .public)")
            if let origin = embed.parentOrigin {
                webView.loadHTMLString(Self.wrapperHTML(iframe: target), baseURL: origin)
            } else {
                var request = URLRequest(url: target)
                request.timeoutInterval = 20
                request.setValue(LinkHTTP.userAgent, forHTTPHeaderField: "User-Agent")
                webView.load(request)
            }
            armWatchdog()
        }

        /// 固定包装页：一个铺满视口的 iframe，没有脚本、没有用户内容。
        ///
        /// 它给嵌入请求一个真实来源（YouTube 没有 Referer 会回错误 153），
        /// 也给帖子组件一个 `width=device-width` 的移动视口（否则 X 会按固定
        /// 宽度排版，缩在左上角）。地址来自适配器，只做 HTML 转义。
        static func wrapperHTML(iframe url: URL) -> String {
            let escaped = url.absoluteString
                .replacingOccurrences(of: "&", with: "&amp;")
                .replacingOccurrences(of: "\"", with: "&quot;")
                .replacingOccurrences(of: "<", with: "&lt;")
            return """
            <!doctype html><html><head>
            <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
            <style>html,body{margin:0;padding:0;height:100%;background:transparent;overflow:hidden}
            iframe{border:0;width:100%;height:100%;display:block}</style>
            </head><body>
            <iframe src="\(escaped)" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen playsinline></iframe>
            </body></html>
            """
        }

        /// 只有调试开关会把 `autoplay=0` 换成 1；正式路径永远不带自动播放。
        private func playbackURL(for embed: LinkEmbed) -> URL {
            guard DebugLaunch.forceAutoplay,
                  var comps = URLComponents(url: embed.url, resolvingAgainstBaseURL: false) else {
                return embed.url
            }
            var items = comps.queryItems ?? []
            items.removeAll { $0.name == "autoplay" }
            items.append(URLQueryItem(name: "autoplay", value: "1"))
            comps.queryItems = items
            return comps.url ?? embed.url
        }

        func cancel() {
            watchdog?.cancel()
            watchdog = nil
        }

        private func armWatchdog() {
            watchdog?.cancel()
            let work = DispatchWorkItem { [weak self] in
                guard let self, !self.settled else { return }
                self.report(.failed)
            }
            watchdog = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 18, execute: work)
        }

        private func settle(_ state: ExternalPlayerState) {
            settled = true
            cancel()
            report(state)
        }

        private func report(_ state: ExternalPlayerState) {
            guard parent.state != state else { return }
            DispatchQueue.main.async {
                self.parent.state = state
            }
        }

        // MARK: - WKNavigationDelegate

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            AppLog.link.info("player finished: \(webView.url?.absoluteString ?? "-", privacy: .public)")
            if DebugLaunch.forceAutoplay {
                probePlayback(in: webView)
            }
            settle(.ready)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            fail(error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            fail(error)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            settle(.failed)
        }

        /// 验证用：模拟器点不动播放器自己的按钮，这里替用户点一下画面中心，
        /// 再看 video 元素有没有起来。正式路径永远走不到（开关只由启动参数打开）。
        private func probePlayback(in webView: WKWebView) {
            let click = "(function(){var el=document.elementFromPoint(window.innerWidth/2,window.innerHeight/2);"
                + "var tag=el?el.tagName:'none';if(el&&el.click){el.click();}return tag;})()"
            webView.evaluateJavaScript(click) { result, error in
                AppLog.link.info(
                    "autoplay click: \(String(describing: result)) \(String(describing: error), privacy: .public)"
                )
            }

            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                let play = "(function(){var v=document.querySelectorAll('video');"
                    + "if(!v.length){return 'no-video';}"
                    + "v[0].muted=true;v[0].play();"
                    + "return v.length+':'+v[0].currentTime.toFixed(1);})()"
                webView.evaluateJavaScript(play) { result, error in
                    AppLog.link.info(
                        "autoplay probe: \(String(describing: result)) \(String(describing: error), privacy: .public)"
                    )
                }
            }
        }

        private func fail(_ error: Error) {
            // 用户主动离开、或者视图被收起，不是「播放器坏了」。
            if (error as NSError).code == NSURLErrorCancelled { return }
            AppLog.link.error("player failed: \(error.localizedDescription, privacy: .public)")
            settle(.failed)
        }

        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }

            // 播放器内部的 iframe、脚本请求不走这里；这里只管主框架。
            if navigationAction.targetFrame?.isMainFrame == false {
                decisionHandler(.allow)
                return
            }

            let scheme = url.scheme?.lowercased() ?? ""
            guard scheme == "http" || scheme == "https" else {
                decisionHandler(.cancel)
                return
            }

            // 首次加载：地址是我们自己拼的，直接放行。
            if loaded == nil || url == loaded {
                decisionHandler(.allow)
                return
            }

            // 包装页本身（`loadHTMLString` 的 baseURL）。它的 host 不属于任何
            // 平台域名，但它是我们自己加载的那一页，必须放行。
            if let origin = parent.embed.parentOrigin, url == origin {
                decisionHandler(.allow)
                return
            }

            let host = url.host ?? ""

            // 只有「用户点了播放器里的链接」才算想离开。别的越界跳转直接取消，
            // 绝不自动打开系统浏览器——B 站播放页会把 player.html 重定向到
            // www.bilibili.com 的移动播放器，那是一次正常的站内跳转。
            if navigationAction.navigationType == .linkActivated {
                AppLog.link.debug("player link tapped, opening outside: \(url.absoluteString, privacy: .public)")
                parent.onExternalOpen(url)
                decisionHandler(.cancel)
                return
            }

            guard parent.embed.allows(host) else {
                AppLog.link.debug("player navigation blocked: \(url.absoluteString, privacy: .public)")
                decisionHandler(.cancel)
                return
            }

            decisionHandler(.allow)
        }
    }
}

// MARK: - 行内播放器

/// 详情页里那块播放区域：一条标题栏 + 16:9 画面 + 一行状态与出口。
///
/// 它只在用户点过「播放」之后才被创建，所以列表滚动时不会有任何嵌入内容在后台
/// 加载。收起时整个视图销毁，WebView 随之释放。
struct LinkPlayerView: View {

    let record: Record
    let embed: LinkEmbed
    var isPost: Bool = false
    let onCollapse: () -> Void
    let onFullscreen: () -> Void

    @Environment(\.openURL) private var openURL
    @State private var state: ExternalPlayerState = .loading
    @State private var reloadToken = UUID()

    private var providerName: String {
        record.provider.displayName.isEmpty ? L("网页") : record.provider.displayName
    }

    var body: some View {
        VStack(spacing: 0) {
            header

            ZStack {
                isPost ? Palette.card : Color.black

                if state == .failed {
                    failure
                } else {
                    ExternalMediaPlayer(
                        embed: embed,
                        state: $state,
                        isScrollEnabled: isPost,
                        prefersDarkChrome: !isPost,
                        onExternalOpen: { openURL($0) }
                    )
                    .id(reloadToken)

                    if state == .loading {
                        ProgressView()
                            .tint(.white)
                    }
                }
            }
            .frame(maxWidth: .infinity)
            .modifier(PlayerAspect(isPost: isPost))
            .clipped()

            footer
        }
        .background(Palette.card)
        .clipShape(RoundedRectangle(cornerRadius: Metric.radius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                .strokeBorder(Palette.hairline, lineWidth: 0.8)
        )
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: record.provider.symbol)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(Palette.roast)
            Text(verbatim: providerName)
                .font(TypeScale.micro)
                .foregroundStyle(Palette.inkSoft)
            Spacer(minLength: 6)
            if !isPost {
                Button(action: onFullscreen) {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Palette.inkSoft)
                        .frame(width: 30, height: 30)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("全屏播放")
            }
            Button(action: onCollapse) {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Palette.inkSoft)
                    .frame(width: 30, height: 30)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("收起播放器")
        }
        .padding(.leading, 12)
        .padding(.trailing, 6)
        .padding(.vertical, 4)
    }

    private var failure: some View {
        VStack(spacing: 10) {
            Image(systemName: "play.slash")
                .font(.system(size: 22, weight: .light))
                .foregroundStyle(.white.opacity(0.75))
            Text("播放器没能加载。")
                .font(TypeScale.callout)
                .foregroundStyle(.white)
            HStack(spacing: 14) {
                Button {
                    state = .loading
                    reloadToken = UUID()
                } label: {
                    Text("重试")
                        .font(TypeScale.caption)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(Capsule().fill(Color.white.opacity(0.16)))
                }
                .buttonStyle(.plain)

                if let url = record.openLink {
                    Button {
                        openURL(url)
                    } label: {
                        Text("在浏览器打开")
                            .font(TypeScale.caption)
                            .foregroundStyle(.white.opacity(0.85))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(16)
    }

    private var footer: some View {
        HStack(spacing: 8) {
            Text(verbatim: state == .failed
                 ? L("也可以换到浏览器看")
                 : (isPost ? L("内容由 %@ 提供", providerName) : L("%@ 提供播放", providerName)))
                .font(TypeScale.micro)
                .foregroundStyle(Palette.inkFaint)
                .lineLimit(1)
            Spacer(minLength: 6)
            if let url = record.openLink {
                Button {
                    openURL(url)
                } label: {
                    HStack(spacing: 3) {
                        Text("在浏览器打开")
                        Image(systemName: "arrow.up.right")
                            .font(.system(size: 8, weight: .bold))
                    }
                    .font(TypeScale.micro)
                    .foregroundStyle(Palette.roast)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

/// 视频用 16:9；帖子用固定高度并允许滚动（长帖不该被裁掉）。
private struct PlayerAspect: ViewModifier {
    let isPost: Bool

    func body(content: Content) -> some View {
        if isPost {
            content.frame(height: 300)
        } else {
            content.aspectRatio(16.0 / 9.0, contentMode: .fit)
        }
    }
}

// MARK: - 全屏

/// 全屏是**独立的一次播放**：进来会重新加载播放器，退出时行内那块回到封面。
/// 不做两个 WebView 同时存在——那会出现两份声音，而 iOS 上没有一个可靠的
/// 方式让其中一个安静下来。
struct FullScreenPlayerView: View {

    let record: Record
    let embed: LinkEmbed
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    @State private var state: ExternalPlayerState = .loading

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Image(systemName: record.provider.symbol)
                        .font(.system(size: 11, weight: .semibold))
                    Text(verbatim: record.provider.displayName)
                        .font(TypeScale.caption)
                    Spacer(minLength: 0)
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 40, height: 40)
                            .background(Circle().fill(Color.white.opacity(0.14)))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("关闭全屏")
                }
                .foregroundStyle(.white.opacity(0.8))
                .padding(.horizontal, 16)
                .padding(.top, 8)

                Spacer(minLength: 0)

                ExternalMediaPlayer(
                    embed: embed,
                    state: $state,
                    onExternalOpen: { openURL($0) }
                )
                .aspectRatio(16.0 / 9.0, contentMode: .fit)

                if state == .failed {
                    VStack(spacing: 10) {
                        Text("播放器没能加载。")
                            .font(TypeScale.callout)
                            .foregroundStyle(.white)
                        if let url = record.openLink {
                            Button {
                                openURL(url)
                            } label: {
                                Text("在浏览器打开")
                                    .font(TypeScale.caption)
                                    .foregroundStyle(.white.opacity(0.85))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.top, 14)
                }

                Spacer(minLength: 0)
            }
        }
        .statusBarHidden()
    }
}
