import Foundation

/// The wire format of a backup (§34).
///
/// Deliberately flat and boring: plain `Codable` structs with no references to
/// SwiftData, so a backup written by this version can be read by any future one,
/// and can be checked by a test without a database.
struct ExportBundle: Codable, Equatable {
    var app: String
    var formatVersion: Int
    var appVersion: String
    var exportedAt: Date
    /// Carried in the file itself so a backup is self-describing: anyone opening
    /// the JSON later can see that these windows were estimates, not facts.
    var disclaimer: String
    var beans: [BeanDTO]
    var brews: [BrewDTO]
    var tastings: [TastingDTO]
    var reminders: [ReminderDTO]
    var phaseRules: [PhaseRuleDTO]

    static let currentFormatVersion = 1

    static let empty = ExportBundle(
        app: "BrewPhase",
        formatVersion: currentFormatVersion,
        appVersion: "1.0",
        exportedAt: Date(),
        disclaimer: DefaultPhaseRules.disclaimer,
        beans: [], brews: [], tastings: [], reminders: [], phaseRules: []
    )

    var totalRecords: Int {
        beans.count + brews.count + tastings.count + reminders.count + phaseRules.count
    }
}

struct BeanDTO: Codable, Equatable {
    var id: UUID
    var name: String
    var roaster: String
    var origin: String
    var process: String
    var roastLevel: String
    var roastDate: Date?
    var purchaseDate: Date?
    var openDate: Date?
    var weightG: Double
    var remainingG: Double
    var price: Double
    var channel: String
    var imagePath: String?
    var flavorTags: [String]
    var notes: String
    var status: String
    var createdAt: Date
    var updatedAt: Date

    // Derived at export time. These are the two columns that make a CSV of beans
    // immediately readable without a spreadsheet formula.
    var dayAfterRoast: Int?
    var phaseAtExport: String
}

struct BrewDTO: Codable, Equatable {
    var id: UUID
    var beanID: UUID
    var beanName: String
    var date: Date
    var dayAfterRoast: Int?
    var method: String
    var grinder: String
    var grindSize: String
    var waterTemp: Double
    var coffeeG: Double
    var waterG: Double
    /// Derived rather than stored, so it can never contradict the dose and water.
    var ratio: Double
    var timeSeconds: Int
    var score: Int
    var acidity: Int
    var sweetness: Int
    var bitterness: Int
    var body: Int
    var aftertaste: Int
    var flavorNotes: [String]
    var notes: String
}

struct TastingDTO: Codable, Equatable {
    var id: UUID
    var beanID: UUID
    var beanName: String
    var date: Date
    var dayAfterRoast: Int
    var flavor: [String]
    var score: Int
    var notes: String
    var source: String
}

struct ReminderDTO: Codable, Equatable {
    var id: UUID
    var beanID: UUID?
    var beanName: String
    var type: String
    var fireDate: Date
    var enabled: Bool
    var identifier: String
}

struct PhaseRuleDTO: Codable, Equatable {
    var roastLevel: String
    var restMinDays: Int
    var restMaxDays: Int
    var peakStartDay: Int
    var peakEndDay: Int
    var declineStartDay: Int
    var enabled: Bool
    var isDefault: Bool
}
