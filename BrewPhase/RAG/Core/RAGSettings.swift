import Foundation

/// 回答由谁生成。
///
/// 三种都是**本地**的（协议 §10：现在不实现云端 provider）：
/// * `onDeviceSummary` 完全不依赖模型，把检索到的证据组织成一段话；
/// * `appleIntelligence` 用系统的端侧模型，只在支持的设备上出现；
/// * `ollama` 走本机 Ollama。
///
/// 设置里选的是**偏好**而不是保证：选中的引擎不可用时自动降级，并把实际用了
/// 哪一个如实告诉用户——比假装成功好。
enum AnswerEngine: String, Codable, CaseIterable, Identifiable, Sendable {
    case onDeviceSummary
    case appleIntelligence
    case ollama

    var id: String { rawValue }

    var label: String {
        switch self {
        case .onDeviceSummary: return L("本地摘要")
        case .appleIntelligence: return L("系统端侧模型")
        case .ollama: return L("Ollama")
        }
    }

    var detail: String {
        switch self {
        case .onDeviceSummary:
            return L("不用任何模型，直接把检索到的记录和知识整理成回答，永远可用")
        case .appleIntelligence:
            return L("用 Apple 的端侧模型生成，需要支持的设备和已开启的 Apple 智能")
        case .ollama:
            return L("在本机运行模型生成，回答更自然，但需要你先把 Ollama 跑起来")
        }
    }
}

/// 问答相关的全部偏好。
///
/// 值类型，从 `UserDefaults` 读一次就能整轮使用——问答过程里不该反复读偏好，
/// 否则用户中途改设置会让同一次回答前后不一致。
struct RAGSettings: Equatable, Sendable {

    var isEnabled: Bool
    var embeddingBackend: EmbeddingBackend
    var preferredEngine: AnswerEngine
    /// 进上下文的资料条数上限。默认 8：再多会让本地小模型的注意力散掉，
    /// 而真正的瓶颈是证据质量不是数量。
    var passageLimit: Int

    var ollamaBaseURL: String
    var ollamaEmbeddingModel: String
    var ollamaChatModel: String

    static let defaultPassageLimit = 8
    static let defaultOllamaEmbeddingModel = "nomic-embed-text"
    static let defaultOllamaChatModel = "qwen2.5:7b"

    static let standard = RAGSettings(
        isEnabled: true,
        embeddingBackend: .onDevice,
        preferredEngine: .onDeviceSummary,
        passageLimit: defaultPassageLimit,
        ollamaBaseURL: OllamaClient.defaultBaseURL,
        ollamaEmbeddingModel: defaultOllamaEmbeddingModel,
        ollamaChatModel: defaultOllamaChatModel
    )

    static func current(from defaults: UserDefaults = .standard) -> RAGSettings {
        var settings = RAGSettings(
            isEnabled: defaults.bool(forKey: PrefKey.askEnabled, default: true),
            embeddingBackend: (defaults.string(forKey: PrefKey.askEmbeddingBackend))
                .flatMap(EmbeddingBackend.init(rawValue:)) ?? .onDevice,
            preferredEngine: (defaults.string(forKey: PrefKey.askAnswerEngine))
                .flatMap(AnswerEngine.init(rawValue:)) ?? .onDeviceSummary,
            passageLimit: max(3, min(defaults.object(forKey: PrefKey.askPassageLimit) as? Int ?? defaultPassageLimit, 20)),
            ollamaBaseURL: defaults.string(forKey: PrefKey.ollamaBaseURL) ?? OllamaClient.defaultBaseURL,
            ollamaEmbeddingModel: defaults.string(forKey: PrefKey.ollamaEmbeddingModel)
                ?? defaultOllamaEmbeddingModel,
            ollamaChatModel: defaults.string(forKey: PrefKey.ollamaChatModel) ?? defaultOllamaChatModel
        )
        // V1（协议 §二）不使用任何 LLM：无论偏好里存了什么，回答引擎固定为本地
        // 抽取式。枚举与其余 provider 保留为接口，V2 引入可选 LLM 层时删掉这一行
        // 即可恢复「按偏好选择」。
        settings.preferredEngine = .onDeviceSummary
        return settings
    }
}
