import Foundation

/// 生成回答（协议 §10）。
///
/// 协议要求这个抽象「必须是可替换的」，并且点名了未来可能的几种实现。所以这里
/// 只有一件事是确定的：拿到系统提示词和整理好的上下文，返回一段话。**不承诺**
/// 它是流式的、是模型生成出来的、或者一定成功——这三点都由实现自己决定。
///
/// 现在有三个实现，都是本地的：Ollama（开发期）、Apple 端侧模型（支持的设备）、
/// 以及抽取式摘要（任何设备，永不失败）。云端 provider 一个都没有，因为这版
/// 明确不实现（协议 §10）。
protocol LLMProvider: Sendable {

    /// 用哪一种引擎。界面据此显示「这段回答是谁写的」。
    var engine: AnswerEngine { get }

    /// 日志用的身份，例如 `ollama.qwen2.5:7b`。
    var identifier: String { get }

    /// 生成回答。
    ///
    /// - Parameters:
    ///   - prompt: 系统提示词，说明角色、纪律和来源区分。
    ///   - context: 已经分好组、编好号、算过预算的证据，连同用户的问题。
    func generate(prompt: String, context: BuiltContext) async throws -> String
}

enum LLMError: LocalizedError {
    case unavailable(String)
    case empty

    var errorDescription: String? {
        switch self {
        case .unavailable(let detail): return L("这个回答引擎现在用不了：%@", detail)
        case .empty: return L("引擎返回了空回答")
        }
    }
}
