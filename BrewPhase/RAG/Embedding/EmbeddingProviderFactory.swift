import Foundation

/// 决定这一轮用哪个 embedding provider。
///
/// 为什么需要它：`EmbeddingProvider` 是协议，但「哪个实现可用」是个运行时问题——
/// 端侧模型可能在这台设备上还没下载好，Ollama 可能没起。把这段判断集中在一处，
/// 上层（索引、检索）就只需要面对一个已经确定可用的 provider。
///
/// 降级链是**显式**的：用户选的 → 端侧 → 词法。中间任何一环成功就停。
/// 最后那环永远不会失败，所以这个函数不会返回 nil。
enum EmbeddingProviderFactory {

    struct Resolution: Sendable {
        let provider: EmbeddingProvider
        /// 用户想用的那个。
        let requested: EmbeddingBackend
        /// 实际用的是不是用户想用的那个。界面要据此说一句实话。
        var isFallback: Bool { provider.backend != requested }
    }

    /// 按降级链解析出一个可用的 provider。
    ///
    /// - Parameter languageCode: 界面当前语言。端侧模型按语言分空间，所以这一轮
    ///   的向量空间由它决定；同一份数据在两种语言下有两套索引，互不干扰。
    static func resolve(settings: RAGSettings, languageCode: String) async -> Resolution {
        let requested = settings.embeddingBackend

        var chain: [EmbeddingBackend] = [requested]
        for candidate in [EmbeddingBackend.onDevice, .lexical] where !chain.contains(candidate) {
            chain.append(candidate)
        }

        for backend in chain {
            if let provider = await make(backend, settings: settings, languageCode: languageCode) {
                if backend != requested {
                    AppLog.rag.info("embedding fell back from \(requested.rawValue, privacy: .public) to \(backend.rawValue, privacy: .public)")
                }
                return Resolution(provider: provider, requested: requested)
            }
        }

        // 词法 provider 没有前置条件，走不到这里。留着是为了让返回类型不是可选的
        // ——调用方不必为一条不可能发生的分支写处理代码。
        return Resolution(provider: LexicalEmbeddingProvider(), requested: requested)
    }

    private static func make(
        _ backend: EmbeddingBackend,
        settings: RAGSettings,
        languageCode: String
    ) async -> EmbeddingProvider? {
        switch backend {
        case .onDevice:
            return AppleSentenceEmbeddingProvider(languageCode: languageCode)
        case .lexical:
            return LexicalEmbeddingProvider()
        case .ollama:
            return await OllamaEmbeddingProvider.make(
                baseURLString: settings.ollamaBaseURL,
                model: settings.ollamaEmbeddingModel
            )
        }
    }
}

extension EmbeddingProvider {
    /// 反推自己是哪一种后端，用于界面显示与降级判断。
    ///
    /// 用 `modelIdentifier` 的前缀而不是加一个协议成员：后端种类是**展示**需要
    /// 的信息，不该污染那个只关心「向量能不能混用」的协议。
    var backend: EmbeddingBackend {
        if modelIdentifier.hasPrefix("apple.nl") { return .onDevice }
        if modelIdentifier.hasPrefix("ollama.") { return .ollama }
        return .lexical
    }
}
