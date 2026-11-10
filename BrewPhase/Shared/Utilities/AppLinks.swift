import Foundation

/// 对外公开的固定链接。只此一处定义——应用内入口与 README 引用同一地址，
/// 换地址时不会散落多处硬编码。
enum AppLinks {

    /// 隐私政策正式入口：由本仓库的 `docs/` 目录经 GitHub Pages 发布。
    ///
    /// 注意：首次启用 Pages 前该地址不可访问（404）。启用步骤（Settings →
    /// Pages → Deploy from a branch → main /docs）记录在
    /// `Tools/Privacy-Compliance-Report.md`，属开发者手动操作。
    static let privacyPolicy = URL(string: "https://banmu123.github.io/BrewPhase/privacy.html")!

    /// BrewPhase Desktop 的下载入口：GitHub Releases 页。
    ///
    /// 2026-11-10 起指向仓库自己的 Releases（此前指向尚未部署的
    /// `commitbrew.com/brewphase`，一直 404）。`desktop-v0.1.0` 已发布
    /// （prerelease，含已公证的 macOS arm64 dmg/zip）；换成 Releases 列表页
    /// 而不是固定某个 tag，以后出 `desktop-v0.2.0` 也无需改代码。
    static let desktopDownload = URL(string: "https://github.com/banmu123/BrewPhase/releases")!
}
