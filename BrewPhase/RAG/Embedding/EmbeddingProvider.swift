import Foundation

/// 文本向量化（协议 §9）。
///
/// 协议要求这一层「不允许和业务逻辑强绑定」，所以它只有四个成员，而且没有一个
/// 提到咖啡：接到别的语料上照样能用。换模型不该改业务代码，改一个 provider 就够。
///
/// **为什么是 `async`**：端侧模型是同步的，但 Ollama 走 HTTP。如果协议声明成同步，
/// 远程 provider 就只能靠阻塞主线程或者塞一个信号量——那是把一个异步问题伪装成
/// 同步接口。让协议直接接受这个事实。
protocol EmbeddingProvider: Sendable {

    /// 模型身份。**含语言与版本**：同一个模型换个语言就是另一个向量空间，两者
    /// 的向量长度甚至不同（中文 640 维、英文 512 维），混着用会得到毫无意义的
    /// 相似度。这个字符串会随向量一起落库，不匹配就重建索引。
    var modelIdentifier: String { get }

    /// 向量维度。调用方用它校验「取出来的向量和模型说的是不是一回事」。
    var dimension: Int { get }

    /// 单条文本向量化。空文本或模型不可用时返回 nil，绝不返回零向量——
    /// 零向量和任何东西的相似度都是 0，那会让「算不出来」看起来像「不相关」。
    func embed(_ text: String) async -> [Float]?

    /// 批量向量化。默认实现是逐条调用，远程 provider 可以覆盖它以减少往返。
    func embedBatch(_ texts: [String]) async -> [[Float]?]
}

extension EmbeddingProvider {
    func embedBatch(_ texts: [String]) async -> [[Float]?] {
        var results: [[Float]?] = []
        results.reserveCapacity(texts.count)
        for text in texts {
            results.append(await embed(text))
        }
        return results
    }
}

/// 索引里这批向量是谁算的。
///
/// 落库的是 `modelIdentifier` 字符串，这个枚举只服务于界面与设置项，所以它带
/// 标签文案，而真正决定兼容性的仍然是那个字符串。
enum EmbeddingBackend: String, Codable, CaseIterable, Identifiable, Sendable {
    /// Apple NaturalLanguage 的端侧句向量。默认。
    case onDevice
    /// 哈希词法向量。没有模型也能跑，永远可用。
    case lexical
    /// Ollama。开发期用，需要本机跑着服务。
    case ollama

    var id: String { rawValue }

    var label: String {
        switch self {
        case .onDevice: return L("端侧语义模型")
        case .lexical: return L("本地词法匹配")
        case .ollama: return L("Ollama 本地服务")
        }
    }

    var detail: String {
        switch self {
        case .onDevice: return L("系统自带，离线可用，按界面语言选择模型")
        case .lexical: return L("不依赖任何模型，中英混写也能匹配，但只认字面相近")
        case .ollama: return L("需要本机运行 Ollama，换模型更灵活")
        }
    }
}
