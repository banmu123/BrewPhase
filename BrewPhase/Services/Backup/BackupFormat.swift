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

    /// 当前写入的版本。
    ///
    /// v1（同日早先的提交）的 `dataDigest` 只覆盖 `data`，偏好不在摘要里，
    /// 改一个默认粉量不会被发现。v1 没有发布给任何外部用户（功能尚未上线），
    /// 因此这里提升到 v2 并把偏好纳入摘要，而不是悄悄改变 v1 的语义：
    /// 读到 v1 文件会明确拒绝并提示重新生成。
    static let currentSchemaVersion = 2

    static let fileExtension = "brewphasebackup"

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

    /// 附件数量上限。体积上限见 `BackupSizeLimits`。
    static let maxAttachments = 5_000
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
    /// 备份时**没有设置**的白名单键。恢复时要把目标设备上的同名键移除，
    /// 这样「生成备份时的状态」才是可还原的，而不是「只要备份里有值就覆盖、
    /// 没有就碰巧留着目标设备的值」。
    var unset: [String]

    static let empty = BackupPreferences(values: [:], unset: [])

    func value(for key: String) -> BackupPreferenceValue? { values[key] }

    /// v1 的偏好段只有 `values`。这里给 `unset` 一个空默认值，让旧文件能解出
    /// 结构、再由 `validate` 按版本明确拒绝，而不是在解码阶段变成「文件损坏」。
    init(values: [String: BackupPreferenceValue], unset: [String]) {
        self.values = values
        self.unset = unset
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        values = try container.decode([String: BackupPreferenceValue].self, forKey: .values)
        unset = try container.decodeIfPresent([String].self, forKey: .unset) ?? []
    }
}

enum BackupPreferenceKind: Equatable {
    case string
    case number
    case integer
    case flag
}

/// 每个白名单键的预期类型与合理范围。
///
/// 只有键名白名单不够：`defaultDoseG` 被写成字符串、`askEnabled` 被写成数字，
/// 都会在恢复时把错误类型塞进 UserDefaults。范围取自现有实现——
/// 冲煮表单允许 0 表示「没填」；问答条数在 `RAGSettings` 里被夹在 3…20，
/// 超出范围的值恢复后会被静默夹紧，所以这里直接拒绝。
enum BackupPreferenceSchema {

    static func kind(for key: String) -> BackupPreferenceKind? {
        if BackupPreferenceKeys.strings.contains(key) { return .string }
        if BackupPreferenceKeys.numbers.contains(key) { return .number }
        if BackupPreferenceKeys.integers.contains(key) { return .integer }
        if BackupPreferenceKeys.flags.contains(key) { return .flag }
        return nil
    }

    /// 数值偏好的合理区间。字符串只有长度上限（自由文本不设业务限制）。
    static func range(for key: String) -> ClosedRange<Double>? {
        switch key {
        case PrefKey.defaultDoseG: return 0...200
        case PrefKey.defaultWaterG: return 0...5_000
        case PrefKey.defaultWaterTemp: return 0...100
        case PrefKey.askPassageLimit: return 3...20
        default: return nil
        }
    }

    static func validate(_ value: BackupPreferenceValue, for key: String) throws {
        guard let kind = kind(for: key) else {
            throw BackupError.invalidValue("preferences.\(key)")
        }
        switch (kind, value) {
        case (.string, .string(let text)):
            guard text.count <= 512 else { throw BackupError.invalidValue("preferences.\(key)") }
            if key == PrefKey.askEmbeddingBackend {
                guard EmbeddingBackend(rawValue: text) != nil else {
                    throw BackupError.invalidValue("preferences.\(key)")
                }
            }
            if key == PrefKey.askAnswerEngine {
                guard AnswerEngine(rawValue: text) != nil else {
                    throw BackupError.invalidValue("preferences.\(key)")
                }
            }
        case (.number, .number(let number)):
            guard number.isFinite,
                  let range = range(for: key), range.contains(number) else {
                throw BackupError.invalidValue("preferences.\(key)")
            }
        case (.integer, .integer(let integer)):
            guard let range = range(for: key), range.contains(Double(integer)) else {
                throw BackupError.invalidValue("preferences.\(key)")
            }
        case (.flag, .flag):
            break
        default:
            // 类型与键不匹配：字符串键塞了数字、开关键塞了文本，都在这里拒绝。
            throw BackupError.invalidValue("preferences.\(key)")
        }
    }
}

/// 备份文件的体积策略。
///
/// 三个数字必须分开看，不能互相替代：
/// * **磁盘文件大小** `maxFileBytes`：读取端在解码之前先看它；
/// * **附件原始字节** `maxAttachmentBytes`：Base64 编码后变成 `4 × ceil(n / 3)`；
/// * **解码峰值**：整文件解码时，文件本身、Base64 文本、解码后的附件同时在内存里，
///   约等于 `fileBytes + attachmentBytes + base64Bytes`。
///
/// 上限依据（iOS 18 起最低支持 iPhone XS 一档，3–4 GB 内存）：
/// 80 MiB 原图 → Base64 约 106.7 MiB；数据段最多再用掉约 21.3 MiB，
/// 文件顶到 128 MiB。三条独立约束同时取满时：
/// `128 + 80 + 106.7 ≈ 314.7 MiB`（约 330 MB 十进制）——这是**估算上界**，
/// 也是实际可达上界（用大段备注文本把数据段填满即可），不是实测值。
///
/// 若上限放到 256 MB / 160 MB，同口径峰值约 629 MiB（256 + 160 + 213），
/// 在小内存机型上不可接受，因此本轮收紧。图片由 `ImageStore` 压到最长边
/// 1400 px、质量 0.8 再落盘，单张通常 150–500 KB，80 MiB 对应几百张照片，
/// 远超个人豆仓的实际用量。
///
/// **真机峰值未实测**：这些是字节数推算，不是性能测量结果。
struct BackupSizeLimits: Equatable {
    /// 读取端硬上限，也是生成端的最终上限。
    var maxFileBytes: Int
    /// 附件原始字节总和。
    var maxAttachmentBytes: Int
    /// 单张图片上限，避免一次解码就把内存顶满。
    var maxSingleAttachmentBytes: Int
    /// JSON 结构本身的余量（键名、标点、记录字段、偏好段）。测试可设为 0 精确验证边界。
    var overheadBytes: Int

    static let standard = BackupSizeLimits(
        maxFileBytes: 128 * 1024 * 1024,
        maxAttachmentBytes: 80 * 1024 * 1024,
        maxSingleAttachmentBytes: 16 * 1024 * 1024,
        overheadBytes: 16 * 1024
    )
}

enum BackupSizePolicy {

    /// Base64 后的字节数：每 3 字节变 4 字符，向上取整。
    /// 用 `(n + 2) / 3 * 4` 而不是先乘后除，避免小数被截断后低估。
    /// 溢出时饱和到 `Int.max`——调用方的比较会把饱和值判为超限。
    static func base64Bytes(_ raw: Int) -> Int {
        guard raw > 0 else { return 0 }
        let (padded, overflow) = raw.addingReportingOverflow(2)
        guard !overflow else { return Int.max }
        let (groups, multiplyOverflow) = (padded / 3).multipliedReportingOverflow(by: 4)
        return multiplyOverflow ? Int.max : groups
    }

    /// JSON 文件大小估算：数据段 + Base64 附件 + 结构余量。
    static func estimatedJSONBytes(attachmentBytes: Int,
                                   dataBytes: Int,
                                   overheadBytes: Int = BackupSizeLimits.standard.overheadBytes) -> Int {
        let (encodedAndData, overflow) = base64Bytes(attachmentBytes)
            .addingReportingOverflow(max(0, dataBytes))
        guard !overflow else { return Int.max }
        let (total, totalOverflow) = encodedAndData.addingReportingOverflow(max(0, overheadBytes))
        return totalOverflow ? Int.max : total
    }

    static func validate(attachmentBytes: Int,
                         largestAttachmentBytes: Int,
                         dataBytes: Int,
                         limits: BackupSizeLimits = .standard) throws {
        guard largestAttachmentBytes <= limits.maxSingleAttachmentBytes else {
            throw BackupError.attachmentTooLarge
        }
        guard attachmentBytes <= limits.maxAttachmentBytes else {
            throw BackupError.attachmentTooLarge
        }
        guard estimatedJSONBytes(attachmentBytes: attachmentBytes,
                                 dataBytes: dataBytes,
                                 overheadBytes: limits.overheadBytes) <= limits.maxFileBytes else {
            throw BackupError.fileTooLarge
        }
    }

    /// 写完之后核对真实文件大小：估计再保守，也要以磁盘上的字节为准。
    static func validateFinalFileSize(_ bytes: Int, limits: BackupSizeLimits = .standard) throws {
        guard bytes <= limits.maxFileBytes else { throw BackupError.fileTooLarge }
    }

    /// 读取峰值的保守估算（只用于文档与测试断言，**不参与准入判断**，也不是实测值）。
    ///
    /// 解码时同时驻留的三部分：文件本身（已含 Base64 文本）、JSONDecoder 展开的
    /// Base64 字符串、解码后的附件原始字节：
    /// `fileBytes + base64Bytes(attachmentBytes) + attachmentBytes`。
    ///
    /// 标准上限下取满：128 MiB + 106.7 MiB + 80 MiB ≈ 314.7 MiB。
    static func estimatedReadPeakBytes(fileBytes: Int, attachmentBytes: Int) -> Int {
        let raw = max(0, attachmentBytes)
        let (fileAndRaw, overflow) = max(0, fileBytes).addingReportingOverflow(raw)
        guard !overflow else { return Int.max }
        let (peak, peakOverflow) = fileAndRaw.addingReportingOverflow(base64Bytes(raw))
        return peakOverflow ? Int.max : peak
    }
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
    case legacyVersion(Int)
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
    /// 某个具体字段不合法（技术名放在关联值里，只进日志/测试）。
    case invalidValue(String)

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
        case .legacyVersion:
            return L("这份备份由旧版本生成，无法校验偏好是否完整，请重新生成一份备份。")
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
        case .invalidValue:
            return L("备份里有不合理的数据，无法恢复。")
        }
    }

    /// 日志里用的技术说明，不面向用户。
    var technicalDescription: String {
        switch self {
        case .unreadableFile: return "unreadable file"
        case .fileTooLarge: return "file exceeds size limit"
        case .malformed: return "malformed container"
        case .unsupportedVersion(let version): return "unsupported schemaVersion=\(version)"
        case .legacyVersion(let version): return "legacy schemaVersion=\(version)"
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
        case .invalidValue(let field): return "invalid value: \(field)"
        }
    }
}
