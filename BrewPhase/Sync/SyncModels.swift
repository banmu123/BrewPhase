import Foundation
import CryptoKit

/// 同步协议 v1 的共享模型：QR 解析、规范指纹、epoch 毫秒。
///
/// 规范指纹与桌面端 `snapshot-importer.ts` **同一套规则**（字段序见
/// `Desktop/docs/SYNC_PROTOCOL.md` §指纹）：
/// - 字段用 `\u{1F}` 连接；
/// - `nil` → `~`；`Bool` → `true`/`false`；
/// - 数字 → 最多 6 位小数、去尾零（跨语言 1 与 1.0 同值）。
///
/// 指纹**不含时间戳**：iOS 触碰 `updatedAt` 不构成内容变更。
enum SyncFingerprint {
    static let separator = "\u{1F}"

    static func number(_ value: Double) -> String {
        guard value.isFinite else { return "~" }
        var text = String(format: "%.6f", value)
        if text.contains(".") {
            while text.hasSuffix("0") { text.removeLast() }
            if text.hasSuffix(".") { text.removeLast() }
        }
        return text
    }

    static func canonical(_ fields: [Any?]) -> String {
        fields
            .map { value -> String in
                switch value {
                case nil: return "~"
                case let boolean as Bool: return boolean ? "true" : "false"
                case let double as Double: return number(double)
                case let int as Int: return number(Double(int))
                case let int64 as Int64: return number(Double(int64))
                case let string as String: return string
                default: return "~"
                }
            }
            .joined(separator: separator)
    }

    static func of(_ canonicalString: String) -> String {
        let digest = SHA256.hash(data: Data(canonicalString.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

/// iOS `Date` → epoch 毫秒。同步 DTO 统一毫秒，秒值会被误当毫秒，
/// 所以这里对 < 1e11 的值做一次 ×1000 防御。
func epochMillis(_ date: Date?) -> Int64? {
    guard let date else { return nil }
    let millis = Int64(date.timeIntervalSince1970 * 1000)
    return millis < 100_000_000_000 ? millis * 1000 : millis
}

// MARK: - 配对深链

/// `brewphase://pair?host=&hosts=&port=&deviceId=&deviceName=&pairingCode=&protocolVersion=&expiresAt=`
///
/// 解析**只有这一处**：扫码与手输共用（BrewPing 的教训——两条路各写一份
/// 解析，字段就会漂移）。`hosts` 是桌面端全部候选地址（多网卡），连接前
/// 逐一探测，`host` 只是首选。
struct SyncPairingLink: Equatable {
    var host: String
    var hosts: [String]
    var port: Int
    var deviceId: String
    var deviceName: String
    var pairingCode: String
    var protocolVersion: Int
    var expiresAt: Date

    /// 探测顺序：host 优先，其余按二维码给出的次序，去重去空。
    var candidateHosts: [String] {
        var seen = Set<String>()
        return ([host] + hosts).filter { candidate in
            guard !candidate.isEmpty, seen.insert(candidate).inserted else { return false }
            return true
        }
    }

    static func parse(_ raw: String) -> SyncPairingLink? {
        guard let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme?.lowercased() == "brewphase",
              url.host?.lowercased() == "pair" else { return nil }
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let dict = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        guard let host = dict["host"], !host.isEmpty,
              let portText = dict["port"], let port = Int(portText), port > 0,
              let code = dict["pairingCode"], !code.isEmpty else { return nil }
        let version = Int(dict["protocolVersion"] ?? "1") ?? 1
        let expiresAt = Date(timeIntervalSince1970: (Double(dict["expiresAt"] ?? "0") ?? 0) / 1000)
        let hosts = (dict["hosts"] ?? "")
            .split(separator: ",")
            .map { String($0).trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        return SyncPairingLink(
            host: host,
            hosts: hosts,
            port: port,
            deviceId: dict["deviceId"] ?? "",
            deviceName: dict["deviceName"] ?? "BrewPhase Desktop",
            pairingCode: code,
            protocolVersion: version,
            expiresAt: expiresAt
        )
    }
}

// MARK: - 传输 DTO

/// 一批同步操作。`payload` 的键是 Swift 侧驼峰名，桌面端统一转 snake_case。
struct SyncUpsert: Codable {
    var id: String
    var fingerprint: String
    var payload: [String: AnyCodableValue]
}

/// 删除意图。`expectedFingerprint` 是**上一次成功同步时的基线指纹**（不是当前值）：
/// 桌面端拿它与本地现行指纹比对，一致才允许删除，否则进删除冲突（§6 非破坏性）。
struct SyncDelete: Codable {
    var id: String
    var expectedFingerprint: String?
}

struct SyncOperation: Codable {
    var entityType: String
    var upserts: [SyncUpsert]
    var deletes: [SyncDelete]
}

struct SyncBatch: Codable {
    var operations: [SyncOperation]
}

/// 逐条结果（§7）：iOS 按它决定基线推进，绝不能「整批 200 就全部提交」。
struct SyncItemResult: Codable {
    var entityType: String
    var id: String
    var status: String
    var reason: String?
}

/// JSON 值容器：payload 里有嵌套可选与混合类型。
enum AnyCodableValue: Codable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case null

    init(_ value: Any?) {
        switch value {
        case let value as String: self = .string(value)
        case let value as Bool: self = .bool(value)
        case let value as Int: self = .int(value)
            // epochMillis 返回 Int64?：Swift 运行时对 Any 里的 Int64 不会
            // 动态转换成 Int（实测 `Int64 as? Int` 为 nil），漏掉这个分支
            // 会让全部时间戳静默变 null（2026-11-07 真机 record_tags
            // created_at NOT NULL 失败的根因）。
        case let value as Int64: self = .int(Int(value))
        case let value as Double: self = .double(value)
        default: self = .null
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(Bool.self) { self = .bool(value); return }
        if let value = try? container.decode(Int.self) { self = .int(value); return }
        if let value = try? container.decode(Double.self) { self = .double(value); return }
        if let value = try? container.decode(String.self) { self = .string(value); return }
        self = .null
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .int(let value): try container.encode(value)
        case .double(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

struct ApplyOutcome: Codable {
    var appliedCount: Int
    var skippedCount: Int
    var conflictCount: Int
    var failedItems: [FailedItem]?
    /// 桌面端逐条结果；旧服务端没有时按整批处理（向后兼容）。
    var results: [SyncItemResult]?

    struct FailedItem: Codable {
        var id: String
        var reason: String
    }
}

struct MediaManifestEntry: Codable {
    var name: String
    var sha256: String
    var byteSize: Int
    var mediaType: String
    var mimeType: String
}

struct MediaManifestCheck: Codable {
    var missing: [MediaManifestEntry]
    var have: [String]
    var rejected: [Rejected]?

    struct Rejected: Codable {
        var name: String
        var reason: String
    }
}

struct PairResponse: Codable {
    var token: String
    var deviceId: String
    var desktopDeviceId: String
    var desktopDeviceName: String
    var protocolVersion: Int
}
