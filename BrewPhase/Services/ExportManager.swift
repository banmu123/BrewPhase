import Foundation
import SwiftData

/// A table ready to become a CSV file.
struct CSVTable: Equatable {
    var name: String
    var header: [String]
    var rows: [[String]]

    var filename: String { "brewphase-\(name).csv" }

    func text() -> String {
        ([header] + rows)
            .map { $0.map(ExportManager.csvField).joined(separator: ",") }
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
                    bean.id.uuidString, bean.name, bean.roaster, bean.origin, bean.process,
                    bean.roastLevel, dateText(bean.roastDate), dateText(bean.purchaseDate),
                    dateText(bean.openDate), number(bean.weightG), number(bean.remainingG),
                    number(bean.price), bean.channel, bean.status,
                    bean.dayAfterRoast.map(String.init) ?? "",
                    bean.phaseAtExport,
                    bean.flavorTags.joined(separator: " / "),
                    bean.notes,
                    timestampText(bean.createdAt),
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
                    brew.id.uuidString, brew.beanName, timestampText(brew.date),
                    brew.dayAfterRoast.map(String.init) ?? "",
                    brew.method, brew.grinder, brew.grindSize, number(brew.waterTemp),
                    number(brew.coffeeG), number(brew.waterG),
                    brew.ratio > 0 ? String(format: "%.2f", brew.ratio) : "",
                    brew.timeSeconds > 0 ? String(brew.timeSeconds) : "",
                    String(brew.score), String(brew.acidity), String(brew.sweetness),
                    String(brew.bitterness), String(brew.body), String(brew.aftertaste),
                    brew.flavorNotes.joined(separator: " / "), brew.notes,
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
                    tasting.id.uuidString, tasting.beanName, timestampText(tasting.date),
                    String(tasting.dayAfterRoast), String(tasting.score),
                    tasting.flavor.joined(separator: " / "), tasting.notes, tasting.source,
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
