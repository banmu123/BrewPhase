import Foundation
import CryptoKit

/// 桌面端同步服务的 HTTP 客户端。
///
/// 鉴权与桌面端 `auth.ts` 同一套：Bearer token；写请求加
/// `x-bp-timestamp / x-bp-nonce / x-bp-signature`，签名 =
/// `HMAC-SHA256(token, timestamp \n nonce \n sha256(body))`。
/// 第一版为局域网 HTTP（威胁模型与 BrewPing 相同；TLS 见协议文档的下一步）。
struct SyncNetworkClient {
    var host: String
    var port: Int
    var token: String?

    let session: URLSession

    init(host: String, port: Int, token: String?, timeout: Double = 20) {
        self.host = host
        self.port = port
        self.token = token
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = 300
        self.session = URLSession(configuration: configuration)
    }

    var baseURL: URL {
        URL(string: "http://\(host):\(port)")!
    }

    enum ClientError: LocalizedError {
        case http(Int, String)
        case invalidResponse

        var errorDescription: String? {
            switch self {
            case .http(let status, let message): return L("服务返回 %@：%@", String(status), message)
            case .invalidResponse: return L("服务响应无法解析")
            }
        }
    }

    // MARK: - 配对

    struct ServiceStatus: Codable {
        var service: String
        var protocolVersion: Int
    }

    /// 健康检查（无鉴权）：多地址候选的连通性探测用。
    func serviceStatus() async throws -> ServiceStatus {
        try await get("api/status")
    }

    func pair(pairingCode: String, deviceName: String) async throws -> PairResponse {
        struct PairBody: Codable { var pairingCode: String; var deviceName: String }
        let payload = try JSONEncoder().encode(PairBody(pairingCode: pairingCode, deviceName: deviceName))
        return try await post("api/pair", bodyData: payload, authenticated: false)
    }

    // MARK: - 同步

    /// 连通性/版本探针：iOS 只检查请求成功，响应内容不消费。
    struct Manifest: Codable {
        var protocolVersion: Int
        var desktopDeviceId: String
    }

    func manifest() async throws -> Manifest {
        try await get("api/sync/manifest")
    }

    func apply(_ batch: SyncBatch) async throws -> ApplyOutcome {
        // SyncBatch 是 Swift struct：必须走 JSONEncoder。JSONSerialization
        // 遇到 Swift struct 会抛无法捕获的 NSException（2026-11-07 真机
        // 「开始同步即崩溃」的根因）。
        let payload = try JSONEncoder().encode(batch)
        return try await post("api/sync/apply", bodyData: payload, authenticated: true)
    }

    func mediaManifest(_ entries: [MediaManifestEntry]) async throws -> MediaManifestCheck {
        let payload = try JSONEncoder().encode(["media": entries])
        return try await post("api/sync/media/manifest", bodyData: payload, authenticated: true)
    }

    func uploadChunk(name: String, offset: Int, data: Data) async throws {
        guard let token else { throw ClientError.http(401, "未配对") }
        guard let encoded = name.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "\(baseURL)/api/sync/media/chunk?name=\(encoded)&offset=\(offset)") else {
            throw ClientError.invalidResponse
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/octet-stream", forHTTPHeaderField: "content-type")
        // 身份头必须与签名头同在：桌面端先验 Bearer 再验 HMAC（2026-11-07 修复：
        // 之前漏了 Bearer，媒体分块全部 401）。
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        sign(&request, body: data)
        request.httpBody = data
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw ClientError.http(status, "chunk rejected")
        }
    }

    func finalizeMedia(name: String, sha256: String, byteSize: Int) async throws {
        struct FinalizeBody: Codable { var name: String; var sha256: String; var byteSize: Int }
        let payload = try JSONEncoder().encode(FinalizeBody(name: name, sha256: sha256, byteSize: byteSize))
        let _: [String: String] = try await post("api/sync/media/finalize", bodyData: payload, authenticated: true)
    }

    // MARK: - 清空（撤销配对）

    /// 让桌面端清空「同步实体」：记录 / 标签 / 画布 / 媒体文件。
    ///
    /// `confirm` 是服务端的显式确认串：清空不可逆，空 body 的请求会被 400 拒掉。
    /// 豆子、冲煮、品鉴不在清空范围内——它们只属于那台 Mac。
    func wipeSyncedContent() async throws {
        struct WipeBody: Codable { var confirm: String }
        struct WipeOutcome: Codable {
            var records: Int
            var tags: Int
            var canvases: Int
            var mediaFiles: Int
        }
        let payload = try JSONEncoder().encode(WipeBody(confirm: "DELETE_SYNCED_CONTENT"))
        let _: WipeOutcome = try await post("api/sync/wipe", bodyData: payload, authenticated: true)
    }

    // MARK: - 传输原语

    private func get<T: Decodable>(_ path: String) async throws -> T {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "GET"
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await session.data(for: request)
        return try decode(data, response)
    }

    /// 所有请求体统一走 JSONEncoder（Swift struct 安全）；JSONSerialization
    /// 只允许出现在「确定传入纯 Foundation 集合」的场景，这里已全部消除。
    private func post<T: Decodable>(_ path: String, bodyData: Data, authenticated: Bool) async throws -> T {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        if authenticated {
            guard let token else { throw ClientError.http(401, "未配对") }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            sign(&request, body: bodyData)
        }
        request.httpBody = bodyData
        let (data, response) = try await session.data(for: request)
        return try decode(data, response)
    }

    /// 写请求签名头。TS 侧 `expectedSignature(token, timestamp, nonce, sha256(body))`。
    private func sign(_ request: inout URLRequest, body: Data) {
        guard let token else { return }
        let timestamp = String(Int(Date().timeIntervalSince1970 * 1000))
        let nonce = UUID().uuidString
        let bodyHash = Self.sha256(body)
        let key = SymmetricKey(data: Data(token.utf8))
        let message = Data("\(timestamp)\n\(nonce)\n\(bodyHash)".utf8)
        let signature = HMAC<SHA256>.authenticationCode(for: message, using: key)
        let signatureHex = signature.map { String(format: "%02x", $0) }.joined()
        request.setValue(timestamp, forHTTPHeaderField: "x-bp-timestamp")
        request.setValue(nonce, forHTTPHeaderField: "x-bp-nonce")
        request.setValue(signatureHex, forHTTPHeaderField: "x-bp-signature")
    }

    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func decode<T: Decodable>(_ data: Data, _ response: URLResponse) throws -> T {
        guard let http = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode([String: String].self, from: data))?["error"] ?? ""
            throw ClientError.http(http.statusCode, message)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
