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
}
