import Foundation

/// The slice of a `Bean` the decision layer needs.
///
/// Everything upstream of the UI takes one of these instead of a `@Model`, which
/// is what lets the whole engine be tested with three lines of setup and no
/// database.
struct BeanSnapshot: Equatable, Sendable, Identifiable {
    var id: UUID
    var name: String
    var roaster: String
    var roastLevel: RoastLevel
    var roastDate: Date?
    /// When the bag was opened. Feeds the phase: coffee sealed in its wrapper
    /// ages more slowly than coffee in an open bag (see `PhaseEngine`).
    var openDate: Date?
    var weightG: Double
    var remainingG: Double
    var imagePath: String?
    var flavorTags: [String]
    var status: BeanStatus
    var createdAt: Date

    init(
        id: UUID = UUID(),
        name: String = "",
        roaster: String = "",
        roastLevel: RoastLevel = .medium,
        roastDate: Date? = nil,
        openDate: Date? = nil,
        weightG: Double = 0,
        remainingG: Double = 0,
        imagePath: String? = nil,
        flavorTags: [String] = [],
        status: BeanStatus = .active,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.name = name
        self.roaster = roaster
        self.roastLevel = roastLevel
        self.roastDate = roastDate
        self.openDate = openDate
        self.weightG = weightG
        self.remainingG = remainingG
        self.imagePath = imagePath
        self.flavorTags = flavorTags
        self.status = status
        self.createdAt = createdAt
    }
}

/// One brew's contribution to the consumption estimate.
struct BrewSample: Equatable, Sendable {
    var date: Date
    var coffeeG: Double
    var waterG: Double

    init(date: Date, coffeeG: Double, waterG: Double = 0) {
        self.date = date
        self.coffeeG = coffeeG
        self.waterG = waterG
    }
}
