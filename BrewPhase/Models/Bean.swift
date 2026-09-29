import Foundation
import SwiftData

/// One bag of coffee.
///
/// Fields the phase engine needs (`roastDate`, `roastLevel`, `weightG`) are
/// stored plainly; everything the engine does *not* need is allowed to be empty,
/// because §3's goal is a 30-second entry and every extra required field costs a
/// user.
///
/// Tag arrays are stored as one separator-joined string. It is less elegant than
/// an array, but it keeps the store trivially migratable and free of
/// transformable-attribute surprises, and the accessors below hide it.
@Model
final class Bean {

    /// Unit separator. Chosen because it cannot appear in a tag a human types.
    static let tagSeparator = "\u{1F}"

    // MARK: - Identity

    var id: UUID = UUID()
    var name: String = ""
    var roaster: String = ""
    var origin: String = ""
    var process: String = ""

    // MARK: - Roast

    var roastLevelRaw: String = RoastLevel.medium.rawValue
    var roastDate: Date?
    var purchaseDate: Date?
    var openDate: Date?

    // MARK: - Stock

    var weightG: Double = 0
    var remainingG: Double = 0
    var price: Double = 0
    var channel: String = ""

    // MARK: - Presentation

    var imagePath: String?
    var flavorTagsRaw: String = ""
    var notes: String = ""

    // MARK: - Lifecycle

    var statusRaw: String = BeanStatus.active.rawValue
    var createdAt: Date = Date()
    var updatedAt: Date = Date()

    // MARK: - Relationships

    @Relationship(deleteRule: .cascade, inverse: \Brew.bean)
    var brews: [Brew]? = []

    @Relationship(deleteRule: .cascade, inverse: \Tasting.bean)
    var tastings: [Tasting]? = []

    @Relationship(deleteRule: .cascade, inverse: \PhaseReminder.bean)
    var reminders: [PhaseReminder]? = []

    init(
        name: String = "",
        roaster: String = "",
        origin: String = "",
        process: String = "",
        roastLevel: RoastLevel = .medium,
        roastDate: Date? = nil,
        purchaseDate: Date? = nil,
        openDate: Date? = nil,
        weightG: Double = 0,
        remainingG: Double? = nil,
        price: Double = 0,
        channel: String = "",
        imagePath: String? = nil,
        flavorTags: [String] = [],
        notes: String = ""
    ) {
        self.id = UUID()
        self.name = name
        self.roaster = roaster
        self.origin = origin
        self.process = process
        self.roastLevelRaw = roastLevel.rawValue
        self.roastDate = roastDate
        self.purchaseDate = purchaseDate
        self.openDate = openDate
        self.weightG = weightG
        self.remainingG = remainingG ?? weightG
        self.price = price
        self.channel = channel
        self.imagePath = imagePath
        self.flavorTagsRaw = flavorTags.joined(separator: Self.tagSeparator)
        self.notes = notes
        self.statusRaw = BeanStatus.active.rawValue
        let now = Date()
        self.createdAt = now
        self.updatedAt = now
    }

    // MARK: - Typed accessors

    var roastLevel: RoastLevel {
        get { RoastLevel(rawValue: roastLevelRaw) ?? .medium }
        set { roastLevelRaw = newValue.rawValue }
    }

    var status: BeanStatus {
        get { BeanStatus(rawValue: statusRaw) ?? .active }
        set { statusRaw = newValue.rawValue }
    }

    var flavorTags: [String] {
        get {
            flavorTagsRaw
                .components(separatedBy: Self.tagSeparator)
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
        }
        set {
            flavorTagsRaw = newValue
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .joined(separator: Self.tagSeparator)
        }
    }

    // MARK: - Derived

    /// Brevs, newest first. Sorting here rather than in a `@Query` keeps the
    /// ordering consistent everywhere the list is shown.
    var brewsNewestFirst: [Brew] {
        (brews ?? []).sorted { $0.date > $1.date }
    }

    var tastingsNewestFirst: [Tasting] {
        (tastings ?? []).sorted { $0.date > $1.date }
    }

    /// Chronological (oldest first) — this is the order the flavour timeline reads in.
    var tastingsOldestFirst: [Tasting] {
        (tastings ?? []).sorted { $0.date < $1.date }
    }

    var latestBrew: Brew? { brewsNewestFirst.first }

    var latestScore: Int? {
        brewsNewestFirst.first(where: { $0.score > 0 })?.score
    }

    var brewsCount: Int { (brews ?? []).count }

    /// Days after roast for an arbitrary date, using the same arithmetic as the
    /// engine so a tasting's "Day N" always agrees with the phase card.
    func dayAfterRoast(on date: Date, calendar: Calendar = DateMath.calendar) -> Int? {
        guard let roastDate else { return nil }
        return DateMath.daysBetween(roastDate, date, calendar: calendar)
    }

    var currentDayAfterRoast: Int? { dayAfterRoast(on: Date()) }

    var isFinished: Bool {
        status == .finished || remainingG <= 0
    }

    /// What the engine actually needs. Passing a value type in keeps
    /// PhaseEngine pure and unit-testable without a SwiftData store.
    var snapshot: BeanSnapshot {
        BeanSnapshot(
            id: id,
            name: name,
            roaster: roaster,
            roastLevel: roastLevel,
            roastDate: roastDate,
            openDate: openDate,
            weightG: weightG,
            remainingG: remainingG,
            imagePath: imagePath,
            flavorTags: flavorTags,
            status: status,
            createdAt: createdAt
        )
    }

    func touch() { updatedAt = Date() }

    /// Called after a brew is recorded. Never lets remaining go negative and
    /// never lets it exceed the bag's weight (§32). Whether the bag counts as
    /// finished is the drinker's call, not ours — they may still have a dose
    /// stuck in the grinder.
    func consume(_ grams: Double) {
        remainingG = min(max(remainingG - grams, 0), max(weightG, 0))
        touch()
    }

    /// Consumption inputs for the estimator, oldest first.
    var brewSamples: [BrewSample] {
        (brews ?? []).map { BrewSample(date: $0.date, coffeeG: $0.coffeeG, waterG: $0.waterG) }
    }
}
