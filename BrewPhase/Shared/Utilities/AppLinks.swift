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

    /// BrewPhase Desktop 下载页（CommitBrew 官网的 BrewPhase 专属页面）。
    ///
    /// 注意：`https://www.commitbrew.com/brewphase` 目前（2026-11-09）还未部署，
    /// 直接访问是 404。发布 Desktop 安装包之前必须先上线这个页面；在页面
    /// 就绪之前，这里的入口指向的是「尚未开放」的说明，不得伪造下载按钮。
    static let desktopDownload = URL(string: "https://www.commitbrew.com/brewphase")!
}
