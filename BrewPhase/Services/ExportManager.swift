import Foundation
import SwiftData

/// 一个格子，连同它的来路。
///
/// 区分「用户输入的文本」和「我们自己生成的数值/日期/标识」不是分类癖：
/// 名称、备注这类文本可能以 `=`、`+`、`-`、`@` 开头，表格软件会把它当公式执行；
/// 而数值列里的负号（`-3`、`-92.5`）是合法数据，绝不能加前缀。两者的编码规则
/// 因此必须分开，不能靠「给所有字段加引号」蒙混过关——引号不阻止公式执行。
enum CSVField: Equatable {
    /// 用户可控文本：先中和公式前缀，再做 RFC 4180 引号处理。
    case text(String)
    /// 我们自己生成的数值、日期、枚举、标识：只做 RFC 4180 引号处理。
    case value(String)

    var csv: String {
        switch self {
        case .text(let text): return ExportManager.csvText(text)
        case .value(let value): return ExportManager.csvField(value)
        }
    }
}

/// A table ready to become a CSV file.
struct CSVTable: Equatable {
    var name: String
    var header: [String]
    var rows: [[CSVField]]

    var filename: String { "brewphase-\(name).csv" }

    func text() -> String {
        // 表头是代码里写死的列名，不是用户内容，走数值路径即可。
        ([header.map(CSVField.value)] + rows)
            .map { $0.map(\.csv).joined(separator: ",") }
            .joined(separator: "\r\n") + "\r\n"
    }
}

/// Writes backups out, in two shapes.
///
/// JSON is the complete, re-importable record. CSV is the one a person can open
/// in a spreadsheet. Both are produced from the same `ExportBundle`, so they can
/// never disagree about what is in the app.
enum ExportManager {

    static var appVersion: String {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "1.0"
    }

    // MARK: - Building

    static func build(
        beans: [Bean],
        rules: [PhaseRule],
        appVersion: String = ExportManager.appVersion,
        now: Date = Date(),
        calendar: Calendar = DateMath.calendar
    ) -> ExportBundle {
        let book = PhaseRuleBook.make(stored: rules)

        let beanDTOs: [BeanDTO] = beans.map { bean in
            let reading = PhaseEngine.reading(for: bean.snapshot,
                                              rule: book.rule(for: bean.roastLevel),
                                              today: now,
                                              calendar: calendar)
            return BeanDTO(
                id: bean.id,
                name: bean.name,
                roaster: bean.roaster,
                origin: bean.origin,
                process: bean.process,
                roastLevel: bean.roastLevel.rawValue,
                roastDate: bean.roastDate,
                purchaseDate: bean.purchaseDate,
                openDate: bean.openDate,
                weightG: bean.weightG,
                remainingG: bean.remainingG,
                price: bean.price,
                channel: bean.channel,
                imagePath: bean.imagePath,
                flavorTags: bean.flavorTags,
                notes: bean.notes,
                status: bean.status.rawValue,
                createdAt: bean.createdAt,
                updatedAt: bean.updatedAt,
                dayAfterRoast: reading.dayAfterRoast,
                phaseAtExport: reading.phase.rawValue
            )
        }

        // Brevs and tastings are collected from the beans rather than fetched
        // separately, so an entity can never be exported without its parent.
        var brewDTOs: [BrewDTO] = []
        var tastingDTOs: [TastingDTO] = []
        var reminderDTOs: [ReminderDTO] = []

        for bean in beans {
            for brew in (bean.brews ?? []).sorted(by: { $0.date < $1.date }) {
                brewDTOs.append(BrewDTO(
                    id: brew.id,
                    beanID: bean.id,
                    beanName: bean.name,
                    date: brew.date,
                    dayAfterRoast: brew.dayAfterRoast,
                    method: brew.method,
                    grinder: brew.grinder,
                    grindSize: brew.grindSize,
                    waterTemp: brew.waterTemp,
                    coffeeG: brew.coffeeG,
                    waterG: brew.waterG,
                    ratio: brew.ratio,
                    timeSeconds: brew.timeSeconds,
                    score: brew.score,
                    acidity: brew.acidity,
                    sweetness: brew.sweetness,
                    bitterness: brew.bitterness,
                    body: brew.body,
                    aftertaste: brew.aftertaste,
                    flavorNotes: brew.flavorTags,
                    notes: brew.notes
                ))
            }

            for tasting in (bean.tastings ?? []).sorted(by: { $0.date < $1.date }) {
                tastingDTOs.append(TastingDTO(
                    id: tasting.id,
                    beanID: bean.id,
                    beanName: bean.name,
                    date: tasting.date,
                    dayAfterRoast: tasting.dayAfterRoast,
                    flavor: tasting.flavorTags,
                    score: tasting.score,
                    notes: tasting.notes,
                    source: tasting.source.rawValue
                ))
            }

            for reminder in (bean.reminders ?? []).sorted(by: { $0.fireDate < $1.fireDate }) {
                reminderDTOs.append(ReminderDTO(
                    id: reminder.id,
                    beanID: bean.id,
                    beanName: bean.name,
                    type: reminder.kind.rawValue,
                    fireDate: reminder.fireDate,
                    enabled: reminder.enabled,
                    identifier: reminder.identifier
                ))
            }
        }

        let ruleDTOs: [PhaseRuleDTO] = RoastLevel.pickerOrder.map { level in
            let data = book.rule(for: level)
            return PhaseRuleDTO(
                roastLevel: level.rawValue,
                restMinDays: data.restMinDays,
                restMaxDays: data.restMaxDays,
                peakStartDay: data.peakStartDay,
                peakEndDay: data.peakEndDay,
                declineStartDay: data.declineStartDay,
                enabled: data.enabled,
                isDefault: data.matchesDefaults()
            )
        }

        return ExportBundle(
            app: "BrewPhase",
            formatVersion: ExportBundle.currentFormatVersion,
            appVersion: appVersion,
            exportedAt: now,
            disclaimer: DefaultPhaseRules.disclaimer,
            beans: beanDTOs,
            brews: brewDTOs,
            tastings: tastingDTOs,
            reminders: reminderDTOs,
            phaseRules: ruleDTOs
        )
    }

    // MARK: - JSON

    private static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return encoder
    }

    private static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }

    static func jsonData(_ bundle: ExportBundle) throws -> Data {
        try encoder().encode(bundle)
    }

    /// Proves a backup can be read back (§39: "JSON 可重新解析").
    static func decode(_ data: Data) throws -> ExportBundle {
        try decoder().decode(ExportBundle.self, from: data)
    }

    // MARK: - CSV

    static func csvTables(_ bundle: ExportBundle) -> [CSVTable] {
        [beanTable(bundle), brewTable(bundle), tastingTable(bundle)]
    }

    private static func beanTable(_ bundle: ExportBundle) -> CSVTable {
        CSVTable(
            name: "beans",
            header: ["id", "name", "roaster", "origin", "process", "roastLevel",
                     "roastDate", "purchaseDate", "openDate", "weightG", "remainingG",
                     "price", "channel", "status", "dayAfterRoast", "phase",
                     "flavorTags", "notes", "createdAt"],
            rows: bundle.beans.map { bean in
                [
                    .value(bean.id.uuidString),
                    // 名称/烘焙商/产地/处理法/渠道/风味标签/备注都是用户写的。
                    .text(bean.name), .text(bean.roaster), .text(bean.origin),
                    .text(bean.process),
                    .value(bean.roastLevel),
                    .value(dateText(bean.roastDate)), .value(dateText(bean.purchaseDate)),
                    .value(dateText(bean.openDate)),
                    .value(number(bean.weightG)), .value(number(bean.remainingG)),
                    .value(number(bean.price)),
                    .text(bean.channel),
                    .value(bean.status),
                    .value(bean.dayAfterRoast.map(String.init) ?? ""),
                    .value(bean.phaseAtExport),
                    .text(bean.flavorTags.joined(separator: " / ")),
                    .text(bean.notes),
                    .value(timestampText(bean.createdAt)),
                ]
            }
        )
    }

    private static func brewTable(_ bundle: ExportBundle) -> CSVTable {
        CSVTable(
            name: "brews",
            header: ["id", "beanName", "date", "dayAfterRoast", "method", "grinder",
                     "grindSize", "waterTemp", "coffeeG", "waterG", "ratio",
                     "timeSeconds", "score", "acidity", "sweetness", "bitterness",
                     "body", "aftertaste", "flavorTags", "notes"],
            rows: bundle.brews.map { brew in
                [
                    .value(brew.id.uuidString),
                    .text(brew.beanName),
                    .value(timestampText(brew.date)),
                    .value(brew.dayAfterRoast.map(String.init) ?? ""),
                    // 方式/磨豆机/研磨度是自由文本，可能以「-」这类字符开头。
                    .text(brew.method), .text(brew.grinder), .text(brew.grindSize),
                    .value(number(brew.waterTemp)),
                    .value(number(brew.coffeeG)), .value(number(brew.waterG)),
                    .value(brew.ratio > 0 ? String(format: "%.2f", brew.ratio) : ""),
                    .value(brew.timeSeconds > 0 ? String(brew.timeSeconds) : ""),
                    .value(String(brew.score)), .value(String(brew.acidity)),
                    .value(String(brew.sweetness)), .value(String(brew.bitterness)),
                    .value(String(brew.body)), .value(String(brew.aftertaste)),
                    .text(brew.flavorNotes.joined(separator: " / ")),
                    .text(brew.notes),
                ]
            }
        )
    }

    private static func tastingTable(_ bundle: ExportBundle) -> CSVTable {
        CSVTable(
            name: "tastings",
            header: ["id", "beanName", "date", "dayAfterRoast", "score", "flavorTags", "notes", "source"],
            rows: bundle.tastings.map { tasting in
                [
                    .value(tasting.id.uuidString),
                    .text(tasting.beanName),
                    .value(timestampText(tasting.date)),
                    .value(String(tasting.dayAfterRoast)),
                    .value(String(tasting.score)),
                    .text(tasting.flavor.joined(separator: " / ")),
                    .text(tasting.notes),
                    .value(tasting.source),
                ]
            }
        )
    }

    // MARK: - Files

    static func writeJSON(_ bundle: ExportBundle, filename: String? = nil) throws -> URL {
        let url = try temporaryURL(filename: filename ?? jsonFilename())
        try jsonData(bundle).write(to: url, options: .atomic)
        return url
    }

    static func writeCSV(_ table: CSVTable) throws -> URL {
        let url = try temporaryURL(filename: table.filename)
        guard let data = table.text().data(using: .utf8) else {
            throw ExportError.encodingFailed
        }
        try data.write(to: url, options: .atomic)
        return url
    }

    static func jsonFilename(now: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return "brewphase-backup-\(formatter.string(from: now)).json"
    }

    /// Everything lives in a per-session temp folder so a burst of exports does
    /// not pile up in `tmp/`, and so the share sheet shows one tidy location.
    private static func temporaryURL(filename: String) throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("BrewPhaseExport", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent(filename)
    }

    static func cleanupTemporaryFiles() {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("BrewPhaseExport", isDirectory: true)
        try? FileManager.default.removeItem(at: dir)
    }

    // MARK: - Formatting

    /// RFC 4180-ish quoting: quote only when the value needs it.
    static func csvField(_ value: String) -> String {
        let needsQuoting = value.contains(",") || value.contains("\"")
            || value.contains("\n") || value.contains("\r")
        guard needsQuoting else { return value }
        return "\"" + value.replacingOccurrences(of: "\"", with: "\"\"") + "\""
    }

    /// 用户文本的编码：先中和公式前缀，再套 RFC 4180 引号。
    ///
    /// 引号只解决分隔符问题，**不阻止公式执行**：`"=1+1"` 在 Excel 里照样会算。
    /// 所以文本列必须单独处理，而不是靠 `csvField` 一把梭。
    static func csvText(_ value: String) -> String {
        csvField(neutralisedFormulaPrefix(value))
    }

    /// 以电子表格会当成公式的前缀开头时，在前面加一个单引号，强制按文本显示。
    ///
    /// 危险前缀是 `=`、`+`、`-`、`@`。判断时跳过前导空白：Excel 会先 trim 再决定
    /// 一个格子是不是公式，`"  =1+1"` 和 `"=1+1"` 一样危险，制表符/回车同理。
    /// 这里只处理文本列；数值列的负号是数据，不能碰。
    static func neutralisedFormulaPrefix(_ value: String) -> String {
        guard let firstMeaningful = value.first(where: { !$0.isWhitespace }) else { return value }
        guard "=+-@".contains(firstMeaningful) else { return value }
        return "'" + value
    }

    private static func number(_ value: Double) -> String {
        value.rounded() == value ? String(Int(value)) : String(format: "%.1f", value)
    }

    private static func dateText(_ date: Date?) -> String {
        guard let date else { return "" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    private static func timestampText(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        return formatter.string(from: date)
    }
}

enum ExportError: LocalizedError {
    case encodingFailed

    var errorDescription: String? {
        switch self {
        case .encodingFailed: return L("导出时出了一点问题，请再试一次")
        }
    }
}
