import Foundation

/// 跟本机 Ollama 说话的那一层。
///
/// 两个 provider（embedding、LLM）都要用它，所以 HTTP 只写一份。协议 §9/§10 都
/// 强调「开发阶段允许通过 Ollama 连接本地模型」——它是本地进程，不是云服务，
/// 所以不违反 local-first；但它**默认关闭**，因为不是每个用户都装了它。
///
/// 刻意不做的事：不重试、不排队、不流式。失败就如实失败，由上层选择降级路径，
/// 而不是在这里悄悄拖长时间。
struct OllamaClient: Sendable {

    static let defaultBaseURL = "http://127.0.0.1:11434"

    let baseURL: URL
    private let session: URLSession

    /// 地址不合法就返回 nil。
    ///
    /// 这里只做语法校验，不做连通性检查——连通性要发请求，而 `init` 不该做 I/O。
    init?(baseURLString: String) {
        let trimmed = baseURLString.trimmed
        guard !trimmed.isEmpty,
              let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              url.host != nil
        else { return nil }

        self.baseURL = url
        let configuration = URLSessionConfiguration.ephemeral
        // 本地模型生成一段回答要几秒到几十秒，超时给短了会把正常回答掐掉。
        configuration.timeoutIntervalForRequest = 90
        configuration.timeoutIntervalForResource = 180
        configuration.waitsForConnectivity = false
        self.session = URLSession(configuration: configuration)
    }

    // MARK: - 能力探测

    /// 服务在不在，以及装了哪些模型。设置页用它给用户一句实话。
    func installedModels() async -> [String]? {
        guard let json = try? await get(path: "api/tags"),
              let models = json["models"] as? [[String: Any]]
        else { return nil }
        return models.compactMap { $0["name"] as? String }
    }

    // MARK: - Embedding

    /// 老接口：一次一条。兼容性最好。
    func embedding(model: String, prompt: String) async throws -> [Float] {
        let json = try await post(path: "api/embeddings", body: [
            "model": model,
            "prompt": prompt,
        ])
        guard let values = json["embedding"] as? [Double], !values.isEmpty else {
            throw OllamaError.malformed("api/embeddings returned no vector")
        }
        return values.map(Float.init)
    }

    /// 新接口：一次一批。批量建索引时快很多。
    func embeddings(model: String, prompts: [String]) async throws -> [[Float]] {
        let json = try await post(path: "api/embed", body: [
            "model": model,
            "input": prompts,
        ])
        guard let rows = json["embeddings"] as? [[Double]], rows.count == prompts.count else {
            throw OllamaError.malformed("api/embed returned \(json["embeddings"] == nil ? "no" : "a mismatched number of") vectors")
        }
        return rows.map { $0.map(Float.init) }
    }

    // MARK: - Chat

    /// 一次性生成，不流式。
    ///
    /// 不流式是一个取舍：流式能一边生成一边显示，体验更好，但也意味着回答要边到
    /// 边解析、部分失败时无法回退到兜底引擎。第一版要的是「这句话到底有没有依据」，
    /// 所以先要一个完整的、能整体校验的回答。
    func chat(model: String, system: String, prompt: String, temperature: Double = 0.2) async throws -> String {
        let json = try await post(path: "api/chat", body: [
            "model": model,
            "stream": false,
            "options": ["temperature": temperature],
            "messages": [
                ["role": "system", "content": system],
                ["role": "user", "content": prompt],
            ],
        ])
        guard let message = json["message"] as? [String: Any],
              let content = message["content"] as? String,
              !content.trimmed.isEmpty
        else {
            throw OllamaError.malformed("api/chat returned an empty message")
        }
        return content.trimmed
    }

    // MARK: - 传输

    private func get(path: String) async throws -> [String: Any] {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "GET"
        return try await send(request)
    }

    private func post(path: String, body: [String: Any]) async throws -> [String: Any] {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await send(request)
    }

    private func send(_ request: URLRequest) async throws -> [String: Any] {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw OllamaError.unreachable(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw OllamaError.unreachable("no HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8)?.trimmed ?? ""
            throw OllamaError.status(http.statusCode, String(body.prefix(200)))
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw OllamaError.malformed("response was not a JSON object")
        }
        return json
    }
}

enum OllamaError: LocalizedError {
    case unreachable(String)
    case status(Int, String)
    case malformed(String)

    var errorDescription: String? {
        switch self {
        case .unreachable(let detail):
            return L("连不上 Ollama：%@", detail)
        case .status(let code, let body):
            return L("Ollama 返回了 %@：%@", String(code), body)
        case .malformed(let detail):
            return L("Ollama 的回答看不懂：%@", detail)
        }
    }
}
