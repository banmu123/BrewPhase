import SwiftData
import XCTest
@testable import BrewPhase

/// §39: export covers empty data, a single bean, and a full record — and the JSON
/// must parse back into the same thing.
@MainActor
final class ExportTests: XCTestCase {

    private var container: ModelContainer!
    private var context: ModelContext!

    override func setUpWithError() throws {
        let schema = Schema([Bean.self, Brew.self, Tasting.self, PhaseReminder.self, PhaseRule.self])
        container = try ModelContainer(
            for: schema,
            configurations: [ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)]
        )
        context = ModelContext(container)
    }

    override func tearDown() {
        context = nil
        container = nil
    }

    private var rules: [PhaseRule] {
        RoastLevel.allCases.map { PhaseRule(data: DefaultPhaseRules.data(for: $0)) }
    }

    // MARK: - Empty

    func testEmptyDataStillProducesAValidFile() throws {
        let bundle = ExportManager.build(beans: [], rules: [], now: Date(timeIntervalSince1970: 1_780_000_000))
        XCTAssertEqual(bundle.beans.count, 0)
        XCTAssertEqual(bundle.brews.count, 0)
        XCTAssertEqual(bundle.tastings.count, 0)
        XCTAssertEqual(bundle.formatVersion, ExportBundle.currentFormatVersion)

        // An export is never truly empty: it always records which windows the
        // records were judged against, even with nothing to judge.
        XCTAssertEqual(bundle.phaseRules.count, RoastLevel.allCases.count)
        XCTAssertEqual(bundle.totalRecords, RoastLevel.allCases.count)
        XCTAssertTrue(bundle.phaseRules.allSatisfy(\.isDefault))

        let data = try ExportManager.jsonData(bundle)
        XCTAssertFalse(data.isEmpty)
        let reloaded = try ExportManager.decode(data)
        XCTAssertEqual(reloaded.beans.count, 0)
        XCTAssertEqual(reloaded.disclaimer, DefaultPhaseRules.disclaimer)
    }

    func testEmptyCSVsAreHeadersOnly() {
        let bundle = ExportManager.build(beans: [], rules: [], now: Date())
        for table in ExportManager.csvTables(bundle) {
            XCTAssertFalse(table.header.isEmpty)
            XCTAssertTrue(table.rows.isEmpty)
            let lines = table.text().split(separator: "\r\n")
            XCTAssertEqual(lines.count, 1, "\(table.name) should be a header and nothing else")
        }
    }

    // MARK: - Content

    func testOneBeanExportsWithItsPhase() throws {
        let bean = Bean(name: "Guji", roaster: "启程", roastLevel: .light,
                        roastDate: DateMath.add(days: -16, to: Date()),
                        weightG: 200, remainingG: 86, flavorTags: ["茉莉", "柑橘"])
        context.insert(bean)
        try context.save()

        let bundle = ExportManager.build(beans: [bean], rules: rules)
        let dto = try XCTUnwrap(bundle.beans.first)
        XCTAssertEqual(dto.name, "Guji")
        XCTAssertEqual(dto.dayAfterRoast, 16)
        XCTAssertEqual(dto.phaseAtExport, "peak")
        XCTAssertEqual(dto.flavorTags, ["茉莉", "柑橘"])
        XCTAssertEqual(dto.remainingG, 86)
        XCTAssertEqual(bundle.phaseRules.count, RoastLevel.allCases.count)
        XCTAssertTrue(bundle.phaseRules.allSatisfy(\.isDefault))
    }

    func testBeanWithBrewsAndTastingsExportsTogether() throws {
        let bean = Bean(name: "Guji", roastLevel: .light,
                        roastDate: DateMath.add(days: -16, to: Date()),
                        weightG: 200, remainingG: 86)
        context.insert(bean)

        let brew = Brew(date: DateMath.add(days: -3, to: Date()), method: "V60",
                        grinder: "C40", grindSize: "22", waterTemp: 92,
                        coffeeG: 18, waterG: 300, timeSeconds: 155, score: 5,
                        sweetness: 4, flavorTags: ["蜂蜜"], notes: "很平衡", bean: bean)
        context.insert(brew)

        let tasting = Tasting(date: brew.date, dayAfterRoast: 13, flavorTags: ["蜂蜜"],
                              score: 5, notes: "很平衡", source: .brew, brewID: brew.id, bean: bean)
        context.insert(tasting)

        try context.save()

        let bundle = ExportManager.build(beans: [bean], rules: rules)
        XCTAssertEqual(bundle.beans.count, 1)
        XCTAssertEqual(bundle.brews.count, 1)
        XCTAssertEqual(bundle.tastings.count, 1)

        let brewDTO = try XCTUnwrap(bundle.brews.first)
        XCTAssertEqual(brewDTO.beanName, "Guji")
        XCTAssertEqual(brewDTO.dayAfterRoast, 13)
        // The ratio is derived on the way out, never stored.
        XCTAssertEqual(brewDTO.ratio, 300.0 / 18.0, accuracy: 0.0001)
        XCTAssertEqual(brewDTO.timeSeconds, 155)
        XCTAssertEqual(brewDTO.flavorNotes, ["蜂蜜"])

        let tastingDTO = try XCTUnwrap(bundle.tastings.first)
        XCTAssertEqual(tastingDTO.source, TastingSource.brew.rawValue)
        XCTAssertEqual(tastingDTO.dayAfterRoast, 13)
    }

    func testRemindersAppearInTheExport() throws {
        let bean = Bean(name: "Guji", roastLevel: .light,
                        roastDate: DateMath.add(days: -1, to: Date()), weightG: 200, remainingG: 200)
        context.insert(bean)

        let reminder = PhaseReminder(kind: .windowOpens, fireDate: DateMath.add(days: 6, to: Date()),
                                     identifier: "x", bean: bean)
        context.insert(reminder)
        try context.save()

        let bundle = ExportManager.build(beans: [bean], rules: rules)
        XCTAssertEqual(bundle.reminders.count, 1)
        XCTAssertEqual(bundle.reminders.first?.type, "windowOpens")
        XCTAssertEqual(bundle.reminders.first?.beanName, "Guji")
    }

    // MARK: - JSON round trip

    func testJSONRoundTripsFaithfully() throws {
        let bean = Bean(name: "Guji", roaster: "启程", origin: "Guji", process: "水洗",
                        roastLevel: .light, roastDate: DateMath.add(days: -16, to: Date()),
                        purchaseDate: DateMath.add(days: -12, to: Date()),
                        openDate: DateMath.add(days: -10, to: Date()),
                        weightG: 200, remainingG: 86, price: 138, channel: "门店",
                        imagePath: "abc.jpg", flavorTags: ["茉莉"], notes: "备注")
        context.insert(bean)

        let brew = Brew(date: DateMath.add(days: -3, to: Date()), method: "V60",
                        waterTemp: 92, coffeeG: 18, waterG: 300, timeSeconds: 155,
                        score: 5, acidity: 4, sweetness: 5, bitterness: 2, body: 4, aftertaste: 4,
                        flavorTags: ["蜂蜜", "柑橘"], notes: "一句话", bean: bean)
        context.insert(brew)
        context.insert(Tasting(date: brew.date, dayAfterRoast: 13, flavorTags: ["蜂蜜"],
                               score: 5, notes: "note", source: .brew, brewID: brew.id, bean: bean))
        try context.save()

        let original = ExportManager.build(beans: [bean], rules: rules)
        let data = try ExportManager.jsonData(original)
        let reloaded = try ExportManager.decode(data)

        // Everything survives, apart from sub-second detail on dates: the backup
        // uses plain ISO-8601, which is the format a person can open and read, so
        // an instant comes back to the second.
        XCTAssertEqual(reloaded.app, original.app)
        XCTAssertEqual(reloaded.formatVersion, original.formatVersion)
        XCTAssertEqual(reloaded.appVersion, original.appVersion)
        XCTAssertEqual(reloaded.disclaimer, original.disclaimer)
        XCTAssertEqual(reloaded.beans.count, original.beans.count)
        XCTAssertEqual(reloaded.brews.count, original.brews.count)
        XCTAssertEqual(reloaded.tastings.count, original.tastings.count)
        XCTAssertEqual(reloaded.phaseRules, original.phaseRules)
        XCTAssertEqual(reloaded.exportedAt.timeIntervalSince1970,
                       original.exportedAt.timeIntervalSince1970, accuracy: 1)

        let reloadedBean = try XCTUnwrap(reloaded.beans.first)
        let originalBean = try XCTUnwrap(original.beans.first)
        XCTAssertEqual(reloadedBean.id, originalBean.id)
        XCTAssertEqual(reloadedBean.name, originalBean.name)
        XCTAssertEqual(reloadedBean.roaster, originalBean.roaster)
        XCTAssertEqual(reloadedBean.origin, originalBean.origin)
        XCTAssertEqual(reloadedBean.process, originalBean.process)
        XCTAssertEqual(reloadedBean.roastLevel, originalBean.roastLevel)
        XCTAssertEqual(reloadedBean.phaseAtExport, originalBean.phaseAtExport)
        XCTAssertEqual(reloadedBean.dayAfterRoast, originalBean.dayAfterRoast)
        XCTAssertEqual(reloadedBean.flavorTags, originalBean.flavorTags)
        XCTAssertEqual(reloadedBean.notes, originalBean.notes)
        XCTAssertEqual(reloadedBean.imagePath, "abc.jpg")
        XCTAssertEqual(reloadedBean.weightG, originalBean.weightG)
        XCTAssertEqual(reloadedBean.remainingG, originalBean.remainingG)
        XCTAssertEqual(reloadedBean.price, originalBean.price)
        let roastDate = try XCTUnwrap(reloadedBean.roastDate)
        XCTAssertEqual(roastDate.timeIntervalSince1970,
                       try XCTUnwrap(originalBean.roastDate).timeIntervalSince1970, accuracy: 1)

        let reloadedBrew = try XCTUnwrap(reloaded.brews.first)
        let originalBrew = try XCTUnwrap(original.brews.first)
        XCTAssertEqual(reloadedBrew.beanName, "Guji")
        XCTAssertEqual(reloadedBrew.method, "V60")
        XCTAssertEqual(reloadedBrew.coffeeG, 18)
        XCTAssertEqual(reloadedBrew.waterG, 300)
        XCTAssertEqual(reloadedBrew.waterTemp, 92)
        XCTAssertEqual(reloadedBrew.timeSeconds, 155)
        XCTAssertEqual(reloadedBrew.score, 5)
        XCTAssertEqual(reloadedBrew.sweetness, 5)
        XCTAssertEqual(reloadedBrew.flavorNotes, ["蜂蜜", "柑橘"])
        XCTAssertEqual(reloadedBrew.ratio, originalBrew.ratio, accuracy: 0.0001)
        XCTAssertEqual(reloadedBrew.date.timeIntervalSince1970,
                       originalBrew.date.timeIntervalSince1970, accuracy: 1)

        let reloadedTasting = try XCTUnwrap(reloaded.tastings.first)
        XCTAssertEqual(reloadedTasting.notes, "note")
        XCTAssertEqual(reloadedTasting.source, TastingSource.brew.rawValue)
        XCTAssertEqual(reloadedTasting.dayAfterRoast, 13)
    }

    func testJSONRoundTripsExactlyOnSecondBoundaries() throws {
        // With whole-second instants there is nothing to lose, and the decoded
        // bundle is identical — the "can be re-parsed" claim in §39, strictly.
        let base = Date(timeIntervalSince1970: 1_780_000_000)
        let bean = Bean(name: "Guji", roastLevel: .light, roastDate: base,
                        weightG: 200, remainingG: 86, flavorTags: ["茉莉"])
        context.insert(bean)
        try context.save()

        let bundle = ExportManager.build(beans: [bean], rules: rules, now: base)
        let reloaded = try ExportManager.decode(try ExportManager.jsonData(bundle))

        XCTAssertEqual(reloaded.exportedAt, bundle.exportedAt)
        XCTAssertEqual(reloaded.phaseRules, bundle.phaseRules)
        XCTAssertEqual(reloaded.beans.first?.roastDate, bundle.beans.first?.roastDate)
        XCTAssertEqual(reloaded.beans.first?.name, "Guji")
        XCTAssertNil(reloaded.beans.first?.imagePath)
    }

    func testJSONUsesStableKeysSoFutureVersionsCanReadIt() throws {
        let bundle = ExportManager.build(beans: [], rules: rules, now: Date(timeIntervalSince1970: 0))
        let data = try ExportManager.jsonData(bundle)
        let text = try XCTUnwrap(String(data: data, encoding: .utf8))
        for key in ["formatVersion", "exportedAt", "disclaimer", "beans", "brews", "tastings",
                    "reminders", "phaseRules"] {
            XCTAssertTrue(text.contains("\"\(key)\""), "missing \(key) in \(text.prefix(200))")
        }
    }

    // MARK: - CSV

    func testCSVQuotesOnlyWhatNeedsQuoting() {
        XCTAssertEqual(ExportManager.csvField("Guji"), "Guji")
        XCTAssertEqual(ExportManager.csvField("Guji, Ethiopia"), "\"Guji, Ethiopia\"")
        XCTAssertEqual(ExportManager.csvField("He said \"hi\""), "\"He said \"\"hi\"\"\"")
        XCTAssertEqual(ExportManager.csvField("two\nlines"), "\"two\nlines\"")
    }

    func testCSVIncludesTheColumnsAPersonWouldWant() throws {
        let bean = Bean(name: "Guji, Ethiopia", roaster: "启程", roastLevel: .light,
                        roastDate: DateMath.add(days: -16, to: Date()),
                        weightG: 200, remainingG: 86, flavorTags: ["茉莉", "柑橘"])
        context.insert(bean)
        try context.save()

        let bundle = ExportManager.build(beans: [bean], rules: rules)
        let tables = ExportManager.csvTables(bundle)
        XCTAssertEqual(tables.map(\.name), ["beans", "brews", "tastings"])

        let beans = try XCTUnwrap(tables.first)
        XCTAssertEqual(beans.filename, "brewphase-beans.csv")
        let rows = beans.text().split(separator: "\r\n")
        XCTAssertEqual(rows.count, 2)
        XCTAssertTrue(rows[0].contains("dayAfterRoast"))
        XCTAssertTrue(rows[0].contains("phase"))
        // A comma in the name must not break the row.
        XCTAssertTrue(rows[1].contains("\"Guji, Ethiopia\""))
        XCTAssertTrue(rows[1].contains("茉莉 / 柑橘"))
    }

    func testCSVFileIsWrittenAndReadable() throws {
        let bean = Bean(name: "Guji", roastLevel: .light,
                        roastDate: DateMath.add(days: -16, to: Date()), weightG: 200, remainingG: 86)
        context.insert(bean)
        try context.save()

        let bundle = ExportManager.build(beans: [bean], rules: rules)
        let tables = ExportManager.csvTables(bundle)
        for table in tables {
            let url = try ExportManager.writeCSV(table)
            XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
            let text = try String(contentsOf: url, encoding: .utf8)
            XCTAssertTrue(text.contains(table.header.first!))
        }
        ExportManager.cleanupTemporaryFiles()
    }

    func testJSONFileIsWrittenWithADateStampedName() throws {
        let bundle = ExportManager.build(beans: [], rules: rules)
        let url = try ExportManager.writeJSON(bundle)
        XCTAssertTrue(url.lastPathComponent.hasPrefix("brewphase-backup-"))
        XCTAssertEqual(url.pathExtension, "json")
        let reloaded = try ExportManager.decode(try Data(contentsOf: url))
        XCTAssertEqual(reloaded.formatVersion, ExportBundle.currentFormatVersion)
        ExportManager.cleanupTemporaryFiles()
    }
}
