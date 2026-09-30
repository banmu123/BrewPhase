import Foundation

#if canImport(FoundationModels)
import FoundationModels
#endif

/// 用 Apple 的端侧模型生成回答（协议 §10 里点名的 `FoundationModel` 这一类）。
///
/// 这是 iPhone 上唯一一个**零配置的真实本地 LLM**：不用装 Ollama、不用下载模型、
/// 不联任何网。代价是它有硬性门槛——需要支持的设备，并且用户打开了 Apple 智能。
///
/// 所以这个 provider 的核心不是「怎么调用」，而是**「不可用时要老实说」**：
/// `isAvailable` 在三个环节都会被问一次（构建 provider 链、设置页文案、回答的
/// 引擎标注），三个地方必须拿到同一个答案，否则会出现「设置里说能用、问了却说
/// 用不了」这种最让人困惑的状态。
struct FoundationModelLLMProvider: LLMProvider {

    let engine: AnswerEngine = .appleIntelligence
    var identifier: String { "apple.foundationmodel" }

    /// 这台设备现在能不能用。
    static var isAvailable: Bool {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            return SystemLanguageModel.default.availability == .available
        }
        return false
        #else
        return false
        #endif
    }

    func generate(prompt: String, context: BuiltContext) async throws -> String {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            let model = SystemLanguageModel.default
            guard case .available = model.availability else {
                throw LLMError.unavailable(Self.availabilityDescription)
            }
            // 每次提问新建一个 session：本阶段的对话是「一次问题一段回答」，不维护
            // 跨轮上下文。带着上一轮证据的 session 会让模型把两次问题的依据混在一起。
            let session = LanguageModelSession(instructions: prompt)
            let response = try await session.respond(to: PromptBuilder.user(context: context))
            let text = response.content.trimmed
            guard !text.isEmpty else { throw LLMError.empty }
            return text
        }
        #endif
        throw LLMError.unavailable(Self.availabilityDescription)
    }

    /// 给用户看的可用性说明。三种原因对应三种不同的建议动作，所以不能合成一句
    /// 「当前不可用」——设备不支持是换手机，没打开是去设置，没准备好是等。
    static var availabilityDescription: String {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                return L("可用")
            case .unavailable(let reason):
                switch reason {
                case .deviceNotEligible:
                    return L("这台设备不支持 Apple 智能")
                case .appleIntelligenceNotEnabled:
                    return L("系统里还没有打开 Apple 智能")
                case .modelNotReady:
                    return L("系统模型还没有准备好，稍后再试")
                @unknown default:
                    return L("系统端侧模型暂时不可用")
                }
            }
        }
        #endif
        return L("需要 iOS 26 或更新的系统")
    }
}
