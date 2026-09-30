import Foundation
import NaturalLanguage

/// 用 Apple 的 `NLEmbedding` 做端侧句向量。
///
/// 为什么选它作为默认：它是系统自带的，**不需要下载模型、不需要网络、不需要用户
/// 配任何东西**，离线可用——这正好对上项目 local-first 的那条线。代价是它按语言
/// 分开：中文 640 维、英文 512 维，两个空间不能互查。所以索引是**按语言建立**的，
/// 语言是这个 provider 身份的一部分（见 `modelIdentifier`）。
///
/// 如果某种语言在这台设备上还没有对应的模型（系统按需下载），`init` 返回 nil，
/// 由 factory 退到词法 provider。宁可用弱一点的检索，也不让功能整个消失。
final class AppleSentenceEmbeddingProvider: EmbeddingProvider, @unchecked Sendable {

    /// 语言代码 → 模型。只在 init 里赋一次，之后只读。
    private let model: NLEmbedding
    private let languageCode: String

    /// `NLEmbedding` 没有承诺线程安全，而向量化会被放到后台跑（几毫秒一条，
    /// 但几百条加起来足够让界面卡一下）。与其赌它可以并发读，不如加一把锁——
    /// 这个量级下锁的开销可以忽略。
    private let lock = NSLock()

    let dimension: Int
    let modelIdentifier: String

    init?(languageCode: String) {
        // `NLLanguage(rawValue:)` 不是可失败的构造器：它接受任何字符串，不认识的
        // 语言会在下面拿模型时表现为 nil。
        let language = NLLanguage(rawValue: languageCode)
        guard let model = NLEmbedding.sentenceEmbedding(for: language) else { return nil }

        self.model = model
        self.languageCode = languageCode
        self.dimension = model.dimension
        // 带上语言与 revision：revision 升级或换语言就等于换空间，索引必须重建。
        self.modelIdentifier = "apple.nl.sentence.\(languageCode).r\(model.revision).v1"
    }

    func embed(_ text: String) async -> [Float]? {
        let trimmed = text.trimmed
        guard !trimmed.isEmpty else { return nil }
        return vector(for: trimmed)
    }

    /// 真正的取向量在这里，**同步**函数。
    ///
    /// 加锁不能写在 `async` 函数体里：`NSLock` 在异步上下文里是不可用的，Swift 6
    /// 会把它当编译错误——理由是持锁跨挂起点会死锁。这里没有挂起点，但编译器看
    /// 的是函数是不是 async 的。所以锁被挪进这个同步函数，行为完全相同，诊断消失。
    /// 和 `DateFormatterCache` 的做法一致。
    private func vector(for trimmed: String) -> [Float]? {
        lock.lock()
        defer { lock.unlock() }

        guard let vector = model.vector(for: trimmed) else { return nil }
        // `NLEmbedding` 给的是 Double，索引里存 Float 省一半空间——精度损失
        // 远小于相似度排序需要的分辨率。
        return vector.map(Float.init)
    }
}
