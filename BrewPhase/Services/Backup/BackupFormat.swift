import Foundation

/// 完整备份的格式定义（schema v1）。
///
/// 与 `ExportManager` 的普通 JSON 导出的区别：普通导出是**给人看/给表格用**的
/// 记录清单，没有图片；这里定义的是**能还原整台设备状态**的备份，包含全部实体、
/// 稳定 ID、关联关系、图片附件与校验信息。两者共用同一批模型，但契约独立演进。
///
/// 版本策略：`schemaVersion` 一旦发布就冻结；解码器只接受 `<= currentSchemaVersion`，
/// 遇到更高版本直接拒绝，而不是「尽力读一读」——半个备份比没有备份更危险。
enum BackupFormat {

    /// 文件里的格式标记。防止把一个随便的 JSON 当成本应用的备份。
    static let identifier = "brewphase-backup"

    /// 当前写入的版本。新增字段走可选值 + 默认值，不轻易升版本。
    static let currentSchemaVersion = 1

    static let fileExtension = "brewphasebackup"

    /// 单文件上限。超过它的备份在解码前就拒绝，避免把设备内存打满。
    /// 解码时文件、Base64 字符串与解码后的图片会同时存在，峰值约为文件大小的
    /// 2–3 倍；256 MB 对应的峰值仍在近年 iPhone 可承受的范围内。
    static let maxFileBytes = 256 * 1024 * 1024

    /// 附件总量与数量上限。图片是唯一的外部文件，单独设限便于给出清楚的提示。
    static let maxAttachmentBytes = 256 * 1024 * 1024
    static let maxAttachments = 5_000

    /// 单类实体上限，防止畸形文件把恢复过程拖死。
    static let maxRecordsPerEntity = 100_000

    /// 附件只允许 ImageStore 自己生成的形状：UUID + `.jpg`。
    /// 这不是「大概检查一下」——恢复时会用这个名字写文件，它必须不可能带路径分隔符。
    static func isSafeAttachmentName(_ name: String) -> Bool {
        guard name.hasSuffix(".jpg"), !name.contains("/"), !name.contains("\\") else { return false }
        let stem = String(name.dropLast(4))
        guard !stem.isEmpty, stem.count <= 64 else { return false }
        return stem.allSatisfy { $0.isHexDigit || $0 == "-" }
    }
}

// MARK: - 文件结构

struct BackupFile: Codable, Equatable {
    var manifest: BackupManifest
    var data: BackupData
    var attachments: [BackupAttachment]
    /// 用户偏好（默认冲煮参数、提醒开关、实验开关、问答设置）。
    ///
    /// 这些不是「记录」，但换设备后重设一遍很烦，而且它们会影响恢复后 App 的
    /// 行为。只收白名单里的键；语言、引导是否看过这类设备/流程状态不收。
    /// 可选：没有这一段的旧文件仍然能读。
    var preferences: BackupPreferences?
}

/// 偏好值。用带类型的枚举而不是 `Any`：JSON 里必须能区分真假、整数与小数，
/// 恢复时也就能原样写回，不会把 `false` 写成 `0`。
enum BackupPreferenceValue: Codable, Equatable {
    case string(String)
    case number(Double)
    case integer(Int)
    case flag(Bool)
}

struct BackupPreferences: Codable, Equatable {
    var values: [String: BackupPreferenceValue]
}

/// 允许进备份的偏好键。白名单而不是「UserDefaults 里有什么就抄什么」：
/// 备份文件可能来自别人，恢复时不能凭它往任意键里写值。
enum BackupPreferenceKeys {

    static var all: [String] {
        strings + numbers + integers + flags
    }

    static let strings: [String] = [
        PrefKey.defaultMethod,
        PrefKey.askEmbeddingBackend,
        PrefKey.askAnswerEngine,
        PrefKey.ollamaBaseURL,
        PrefKey.ollamaEmbeddingModel,
        PrefKey.ollamaChatModel,
    ]

    static let numbers: [String] = [
        PrefKey.defaultDoseG,
        PrefKey.defaultWaterG,
        PrefKey.defaultWaterTemp,
    ]

    static let integers: [String] = [
        PrefKey.askPassageLimit,
    ]

    static var flags: [String] {
        [PrefKey.experimentalFlavorPrediction, PrefKey.askEnabled]
            + ReminderKind.allCases.map(PrefKey.reminderEnabled)
    }
}

struct BackupManifest: Codable, Equatable {
    var format: String
    var schemaVersion: Int
    var appVersion: String
    /// 秒（1970 起）。用数值而不是 ISO 字符串：`Date` 本身就是双精度秒，
    /// 数值往返不丢精度，也不会被时区或格式化器悄悄改掉。
    var createdAt: Double
    var summary: BackupSummary
    /// `data` 的规范化 JSON 摘要（SHA-256）。
    var dataDigest: String
    /// 全部附件「名字 + 各自摘要」的汇总摘要。
    var attachmentDigest: String

    var createdDate: Date { Date(timeIntervalSince1970: createdAt) }
}

struct BackupSummary: Codable, Equatable {
    var beans: Int
    var brews: Int
    var tastings: Int
    var reminders: Int
    var phaseRules: Int
    var attachments: Int
    var attachmentBytes: Int
}

struct BackupAttachment: Codable, Equatable {
    /// 存储文件名（如 `A1B2….jpg`），与 `Bean.imagePath` 是同一个值。
    var name: String
    var sha256: String
    /// 原始 JPEG 字节；Codable 会以 Base64 写进 JSON。
    var data: Data
}

struct BackupData: Codable, Equatable {
    var beans: [BackupBean]
    var brews: [BackupBrew]
    var tastings: [BackupTasting]
    var reminders: [BackupReminder]
    var phaseRules: [BackupPhaseRule]
}

// MARK: - 实体

/// 逐字段对应 `Bean`，包括会被界面读到的派生字段的原始存储（`flavorTagsRaw`）。
/// 派生值（`brewsNewestFirst` 等）不存——它们由关系重新算出来。
struct BackupBean: Codable, Equatable {
    var id: UUID
    var name: String
    var roaster: String
    var origin: String
    var process: String
    var roastLevelRaw: String
    var roastDate: Double?
    var purchaseDate: Double?
    var openDate: Double?
    var weightG: Double
    var remainingG: Double
    var price: Double
    var channel: String
    var imagePath: String?
    var flavorTagsRaw: String
    var notes: String
    var statusRaw: String
    var createdAt: Double
    var updatedAt: Double
    var isSample: Bool
}

struct BackupBrew: Codable, Equatable {
    var id: UUID
    var beanID: UUID
    var date: Double
    var method: String
    var grinder: String
    var grindSize: String
    var waterTemp: Double
    var coffeeG: Double
    var waterG: Double
    var timeSeconds: Int
    var score: Int
    var acidity: Int
    var sweetness: Int
    var bitterness: Int
    var body: Int
    var aftertaste: Int
    var flavorTagsRaw: String
    var notes: String
    var createdAt: Double
}

struct BackupTasting: Codable, Equatable {
    var id: UUID
    var beanID: UUID
    var date: Double
    var dayAfterRoast: Int
    var flavorTagsRaw: String
    var score: Int
    var notes: String
    var sourceRaw: String
    /// 由某条冲煮自动生成时记着它的 ID，用于恢复后仍能「删冲煮时一起删节点」。
    var brewID: UUID?
    var createdAt: Double
}

struct BackupReminder: Codable, Equatable {
    var id: UUID
    var beanID: UUID
    var kindRaw: String
    var fireDate: Double
    var enabled: Bool
    var identifier: String
    var createdAt: Double
}

struct BackupPhaseRule: Codable, Equatable {
    var id: UUID
    var roastLevelRaw: String
    var restMinDays: Int
    var restMaxDays: Int
    var peakStartDay: Int
    var peakEndDay: Int
    var declineStartDay: Int
    var enabled: Bool
    var updatedAt: Double
}

// MARK: - 错误

/// 备份/恢复失败的原因。面向用户的说法放在 `errorDescription`，
/// 技术细节（具体哪个 ID、哪条引用）只写日志，不进界面。
enum BackupError: LocalizedError, Equatable {

    case unreadableFile
    case fileTooLarge
    case malformed
    case unsupportedVersion(Int)
    case missingData
    case checksumMismatch
    case duplicateIdentifier
    case brokenReference
    case missingAttachment
    case invalidAttachmentName
    case attachmentTooLarge
    case tooManyRecords
    case imageConflict
    case restoreFailed

    var errorDescription: String? {
        switch self {
        case .unreadableFile:
            return L("这个文件打不开，可能已经被移动或删除。")
        case .fileTooLarge:
            return L("备份文件过大，这台设备无法安全地打开它。")
        case .malformed:
            return L("这不是一份完整的 BrewPhase 备份，文件可能已损坏。")
        case .unsupportedVersion:
            return L("这份备份来自更新版本的 BrewPhase，请先升级 App 再恢复。")
        case .missingData:
            return L("备份里缺少必要的数据，无法恢复。")
        case .checksumMismatch:
            return L("备份内容与校验信息不一致，可能已损坏。为安全起见没有做任何修改。")
        case .duplicateIdentifier:
            return L("备份里有重复的记录标识，无法安全恢复。")
        case .brokenReference:
            return L("备份里的记录关联不完整，无法安全恢复。")
        case .missingAttachment:
            return L("备份里缺少记录引用的图片，无法完整恢复。")
        case .invalidAttachmentName:
            return L("备份里的图片名称不合法，已停止恢复。")
        case .attachmentTooLarge:
            return L("备份里的图片数据超出可恢复的范围。")
        case .tooManyRecords:
            return L("备份包含的记录数量超出可恢复的范围。")
        case .imageConflict:
            return L("恢复时遇到同名但内容不同的图片，已停止恢复。")
        case .restoreFailed:
            return L("恢复没有完成，原有数据保持不动。")
        }
    }

    /// 日志里用的技术说明，不面向用户。
    var technicalDescription: String {
        switch self {
        case .unreadableFile: return "unreadable file"
        case .fileTooLarge: return "file exceeds size limit"
        case .malformed: return "malformed container"
        case .unsupportedVersion(let version): return "unsupported schemaVersion=\(version)"
        case .missingData: return "missing data section"
        case .checksumMismatch: return "checksum mismatch"
        case .duplicateIdentifier: return "duplicate identifier"
        case .brokenReference: return "broken reference"
        case .missingAttachment: return "missing attachment"
        case .invalidAttachmentName: return "invalid attachment name"
        case .attachmentTooLarge: return "attachment too large"
        case .tooManyRecords: return "too many records"
        case .imageConflict: return "image name conflict"
        case .restoreFailed: return "restore failed"
        }
    }
}
