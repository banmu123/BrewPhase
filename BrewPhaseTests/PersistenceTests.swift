import SwiftData
import UIKit
import XCTest
@testable import BrewPhase

/// §42 asks for the store, the deletion path and the image lifecycle to be
/// verified rather than assumed. This is that.
@MainActor
final class PersistenceTests: XCTestCase {

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

    // MARK: - Round trip

    func testABeanSurvivesTheRoundTripThroughTheStore() throws {
        let bean = Bean(name: "Guji", roaster: "启程", origin: "Guji", process: "水洗",
                        roastLevel: .light, roastDate: DateMath.add(days: -16, to: Date()),
                        weightG: 200, remainingG: 86, flavorTags: ["茉莉", "柑橘"], notes: "备注")
        context.insert(bean)
        try context.save()

        let fetched = try XCTUnwrap(try context.fetch(FetchDescriptor<Bean>()).first)
        XCTAssertEqual(fetched.name, "Guji")
        XCTAssertEqual(fetched.roastLevel, .light)
        XCTAssertEqual(fetched.remainingG, 86)
        XCTAssertEqual(fetched.flavorTags, ["茉莉", "柑橘"])
        XCTAssertEqual(fetched.imagePath, nil)
        XCTAssertEqual(fetched.status, .active)
    }

    func testBrewsAndTastingsComeBackWithTheirBean() throws {
        let bean = Bean(name: "Guji", roastLevel: .light,
                        roastDate: DateMath.add(days: -16, to: Date()), weightG: 200, remainingG: 86)
        context.insert(bean)
        context.insert(Brew(date: DateMath.add(days: -3, to: Date()), method: "V60",
                            coffeeG: 18, waterG: 300, score: 5, bean: bean))
        context.insert(Tasting(date: Date(), dayAfterRoast: 16, score: 5, bean: bean))
        try context.save()

        let fetched = try XCTUnwrap(try context.fetch(FetchDescriptor<Bean>()).first)
        XCTAssertEqual(fetched.brewsCount, 1)
        XCTAssertEqual(fetched.tastingsOldestFirst.count, 1)
        XCTAssertEqual(fetched.latestBrew?.method, "V60")
        XCTAssertEqual(fetched.latestScore, 5)
        XCTAssertEqual(fetched.brewSamples.first?.coffeeG, 18)
    }

    func testBrewsAreReturnedNewestFirst() throws {
        let bean = Bean(name: "Guji", roastLevel: .light,
                        roastDate: DateMath.add(days: -20, to: Date()), weightG: 200, remainingG: 86)
        context.insert(bean)
        for offset in [9, 3, 6] {
            context.insert(Brew(date: DateMath.add(days: -offset, to: Date()),
                                method: "V60", coffeeG: 18, bean: bean))
        }
        try context.save()

        let fetched = try XCTUnwrap(try context.fetch(FetchDescriptor<Bean>()).first)
        let dates = fetched.brewsNewestFirst.map(\.date)
        XCTAssertEqual(dates, dates.sorted(by: >))
        // Roasted 20 days ago and the newest brew was 3 days ago → day 17.
        XCTAssertEqual(fetched.brewsNewestFirst.first?.dayAfterRoast, 17)
    }

    // MARK: - Deletion (§33, §21)

    func testDeletingABeanTakesItsWholeHistory() throws {
        let bean = Bean(name: "Guji", roastLevel: .light,
                        roastDate: DateMath.add(days: -16, to: Date()), weightG: 200, remainingG: 86)
        context.insert(bean)
        context.insert(Brew(date: Date(), method: "V60", coffeeG: 18, bean: bean))
        context.insert(Tasting(date: Date(), dayAfterRoast: 16, score: 5, bean: bean))
        context.insert(PhaseReminder(kind: .windowOpens, fireDate: Date(), identifier: "x", bean: bean))
        try context.save()

        XCTAssertEqual(try context.fetchCount(FetchDescriptor<Brew>()), 1)
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<Tasting>()), 1)
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<PhaseReminder>()), 1)

        context.delete(bean)
        try context.save()

        // Cascade: an orphaned brew would be a record that belongs to nothing.
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<Bean>()), 0)
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<Brew>()), 0)
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<Tasting>()), 0)
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<PhaseReminder>()), 0)
    }

    func testDeletingOneBagLeavesTheOthersAlone() throws {
        let keep = Bean(name: "Keep", roastLevel: .light, roastDate: Date(), weightG: 200, remainingG: 200)
        let drop = Bean(name: "Drop", roastLevel: .light, roastDate: Date(), weightG: 200, remainingG: 200)
        context.insert(keep)
        context.insert(drop)
        context.insert(Brew(date: Date(), method: "V60", coffeeG: 18, bean: drop))
        try context.save()

        context.delete(drop)
        try context.save()

        let remaining = try context.fetch(FetchDescriptor<Bean>())
        XCTAssertEqual(remaining.count, 1)
        XCTAssertEqual(remaining.first?.name, "Keep")
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<Brew>()), 0)
    }

    /// The sequence `BeanDetailView.deleteBean()` performs.
    func testDeleteBeanSequenceRemovesTheImageToo() throws {
        let image = makeImage(width: 900, height: 900)
        let name = try ImageStore.shared.save(image)
        XCTAssertNotNil(ImageStore.shared.image(named: name))

        let bean = Bean(name: "With photo", roastLevel: .light,
                        roastDate: DateMath.add(days: -5, to: Date()),
                        weightG: 200, remainingG: 200, imagePath: name)
        context.insert(bean)
        try context.save()

        let path = bean.imagePath
        context.delete(bean)
        try context.save()
        ImageStore.shared.delete(path)

        XCTAssertNil(ImageStore.shared.image(named: name))
        XCTAssertFalse(FileManager.default.fileExists(atPath: ImageStore.shared.url(for: name).path))
    }

    // MARK: - Stock arithmetic

    func testConsumeSubtractsAndClampsAtZero() throws {
        let bean = Bean(name: "Guji", roastLevel: .light, roastDate: Date(), weightG: 200, remainingG: 20)
        context.insert(bean)

        bean.consume(18)
        XCTAssertEqual(bean.remainingG, 2, accuracy: 0.0001)

        bean.consume(18)
        XCTAssertEqual(bean.remainingG, 0, accuracy: 0.0001)
        XCTAssertFalse(bean.remainingG < 0)
    }

    func testConsumeNeverLetsRemainingExceedTheBag() throws {
        let bean = Bean(name: "Guji", roastLevel: .light, roastDate: Date(), weightG: 200, remainingG: 100)
        context.insert(bean)
        bean.consume(-50)          // a correction that adds coffee back
        XCTAssertEqual(bean.remainingG, 150, accuracy: 0.0001)
        bean.consume(-500)
        XCTAssertEqual(bean.remainingG, 200, accuracy: 0.0001)
    }

    func testIsFinishedFollowsStatusOrAnEmptyBag() throws {
        let running = Bean(name: "A", roastLevel: .light, roastDate: Date(), weightG: 200, remainingG: 10)
        let empty = Bean(name: "B", roastLevel: .light, roastDate: Date(), weightG: 200, remainingG: 0)
        let done = Bean(name: "C", roastLevel: .light, roastDate: Date(), weightG: 200, remainingG: 50)
        done.status = .finished
        for bean in [running, empty, done] { context.insert(bean) }

        XCTAssertFalse(running.isFinished)
        XCTAssertTrue(empty.isFinished)
        XCTAssertTrue(done.isFinished)
    }

    // MARK: - Phase rules

    func testSeedingCreatesARuleForEveryRoastLevelAndIsIdempotent() throws {
        let suite = try XCTUnwrap(UserDefaults(suiteName: "brewphase.tests.seed"))
        suite.removePersistentDomain(forName: "brewphase.tests.seed")

        XCTAssertTrue(PhaseRuleBook.seedIfNeeded(context: context, defaults: suite))
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<PhaseRule>()), RoastLevel.allCases.count)
        XCTAssertTrue(try XCTUnwrap(suite.object(forKey: PrefKey.seededPhaseRules) as? Bool))

        // Running it again must not duplicate anything — it runs on every launch.
        XCTAssertFalse(PhaseRuleBook.seedIfNeeded(context: context, defaults: suite))
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<PhaseRule>()), RoastLevel.allCases.count)

        let book = PhaseRuleBook.make(stored: try context.fetch(FetchDescriptor<PhaseRule>()))
        XCTAssertTrue(book.isPristine)
        XCTAssertEqual(book.rule(for: .light).peakEndDay, 28)
        suite.removePersistentDomain(forName: "brewphase.tests.seed")
    }

    func testAnEditedRuleIsPickedUpAndCanBeReset() throws {
        PhaseRuleBook.seedIfNeeded(context: context)

        let row = try XCTUnwrap(
            try context.fetch(FetchDescriptor<PhaseRule>()).first { $0.roastLevel == .light }
        )
        var edited = row.data
        edited.peakEndDay = 40
        edited.declineStartDay = 40
        row.apply(edited)
        try context.save()

        var book = PhaseRuleBook.make(stored: try context.fetch(FetchDescriptor<PhaseRule>()))
        XCTAssertEqual(book.rule(for: .light).peakEndDay, 40)
        XCTAssertFalse(book.isPristine)
        XCTAssertEqual(book.customized, [.light])
        XCTAssertEqual(book.rule(for: .medium).peakEndDay, 21, "editing one level must not touch another")

        PhaseRuleBook.resetToDefaults(context: context)
        book = PhaseRuleBook.make(stored: try context.fetch(FetchDescriptor<PhaseRule>()))
        XCTAssertTrue(book.isPristine)
    }

    func testAMissingStoredRuleFallsBackToTheDefault() {
        let book = PhaseRuleBook(rules: [:])
        XCTAssertEqual(book.rule(for: .espressoBlend), DefaultPhaseRules.data(for: .espressoBlend))
        XCTAssertTrue(book.isPristine)
    }

    // MARK: - Insight wiring

    func testInsightFactoryReadsTheStoredBag() throws {
        let bean = Bean(name: "Guji", roastLevel: .light,
                        roastDate: DateMath.add(days: -16, to: Date()), weightG: 200, remainingG: 86)
        context.insert(bean)
        context.insert(Brew(date: DateMath.add(days: -3, to: Date()), method: "V60",
                            coffeeG: 18, waterG: 300, score: 5, bean: bean))
        PhaseRuleBook.seedIfNeeded(context: context)
        try context.save()

        let book = PhaseRuleBook.make(stored: try context.fetch(FetchDescriptor<PhaseRule>()))
        let insight = InsightFactory.insight(for: bean, book: book)

        XCTAssertEqual(insight.reading.phase, .peak)
        XCTAssertEqual(insight.reading.dayAfterRoast, 16)
        XCTAssertEqual(insight.estimate.averageDoseG, 18, accuracy: 0.001)
        XCTAssertEqual(insight.candidate.lastScore, 5)
        XCTAssertFalse(insight.verdict.headline.isEmpty)
    }

    func testTodaysPickIsNilForAnEmptyCellar() throws {
        XCTAssertNil(InsightFactory.todaysPick([], book: .defaults))
    }

    func testRankingAnEmptyCellarIsEmpty() throws {
        XCTAssertTrue(InsightFactory.ranked([], book: .defaults).isEmpty)
    }

    // MARK: - Images (§21)

    private func makeImage(width: CGFloat, height: CGFloat) -> UIImage {
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format).image { ctx in
            UIColor.brown.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
    }

    func testAMissingImageFileReturnsNilInsteadOfCrashing() {
        XCTAssertNil(ImageStore.shared.image(named: "definitely-not-here.jpg"))
        XCTAssertNil(ImageStore.shared.image(named: nil))
        XCTAssertNil(ImageStore.shared.image(named: ""))
    }

    func testSavingAnImageDownscalesItAndMakesAThumbnail() throws {
        let name = try ImageStore.shared.save(makeImage(width: 3000, height: 2000))
        defer { ImageStore.shared.delete(name) }

        let display = try XCTUnwrap(ImageStore.shared.image(named: name, thumbnail: false))
        XCTAssertEqual(max(display.size.width, display.size.height), ImageStore.maxDimension, accuracy: 1)
        // Aspect ratio survives the downscale.
        XCTAssertEqual(display.size.width / display.size.height, 1.5, accuracy: 0.01)

        let thumb = try XCTUnwrap(ImageStore.shared.image(named: name, thumbnail: true))
        XCTAssertEqual(max(thumb.size.width, thumb.size.height), ImageStore.thumbnailDimension, accuracy: 1)

        XCTAssertTrue(FileManager.default.fileExists(atPath: ImageStore.shared.url(for: name).path))
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: ImageStore.shared.url(for: name, thumbnail: true).path))
    }

    func testASmallImageIsNotUpscaled() throws {
        let name = try ImageStore.shared.save(makeImage(width: 120, height: 120))
        defer { ImageStore.shared.delete(name) }
        let loaded = try XCTUnwrap(ImageStore.shared.image(named: name, thumbnail: false))
        XCTAssertEqual(loaded.size.width, 120, accuracy: 1)
    }

    func testReplacingAnImageRemovesTheOldFile() throws {
        let first = try ImageStore.shared.save(makeImage(width: 500, height: 500))
        let second = try ImageStore.shared.replace(makeImage(width: 600, height: 600), previous: first)

        XCTAssertNotEqual(first, second)
        XCTAssertFalse(FileManager.default.fileExists(atPath: ImageStore.shared.url(for: first).path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: ImageStore.shared.url(for: second).path))
        ImageStore.shared.delete(second)
    }

    func testOrphanCleanupOnlyRemovesUnreferencedFiles() throws {
        let kept = try ImageStore.shared.save(makeImage(width: 300, height: 300))
        let orphan = try ImageStore.shared.save(makeImage(width: 300, height: 300))
        defer {
            ImageStore.shared.delete(kept)
            ImageStore.shared.delete(orphan)
        }

        let orphans = ImageStore.shared.orphanedFiles(referenced: [kept]).map(\.lastPathComponent)
        XCTAssertTrue(orphans.contains(orphan))
        XCTAssertFalse(orphans.contains(kept))

        // A cleanup that keeps a referenced file must leave it loadable.
        _ = ImageStore.shared.clearOrphans(referenced: [kept])
        XCTAssertNotNil(ImageStore.shared.image(named: kept, thumbnail: false))
    }

    func testImageStoreReportsSizeAndCount() throws {
        let name = try ImageStore.shared.save(makeImage(width: 800, height: 800))
        defer { ImageStore.shared.delete(name) }
        XCTAssertGreaterThan(ImageStore.shared.totalBytes(), 0)
        XCTAssertGreaterThan(ImageStore.shared.fileCount(), 0)
    }
}
