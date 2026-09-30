import Foundation

/// Roast level. Five cases rather than the four rows of the default rule table,
/// because "中深烘" and "深烘" are different beans to a drinker even though the
/// default window for both is the same. Each case gets its own editable rule.
enum RoastLevel: String, Codable, CaseIterable, Identifiable, Hashable, Sendable {
    case light
    case medium
    case mediumDark
    case dark
    case espressoBlend

    var id: String { rawValue }

    var label: String {
        switch self {
        case .light: return L("浅烘")
        case .medium: return L("中烘")
        case .mediumDark: return L("中深烘")
        case .dark: return L("深烘")
        case .espressoBlend: return L("意式拼配")
        }
    }

    /// Order used in pickers: lightest first, blends last.
    var sortOrder: Int {
        switch self {
        case .light: return 0
        case .medium: return 1
        case .mediumDark: return 2
        case .dark: return 3
        case .espressoBlend: return 4
        }
    }

    static var pickerOrder: [RoastLevel] {
        allCases.sorted { $0.sortOrder < $1.sortOrder }
    }
}

/// A bag's lifecycle. `finished` keeps the bag and its history around after the
/// coffee is gone, so past brews and tastings stay readable.
enum BeanStatus: String, Codable, CaseIterable, Identifiable, Sendable {
    case active
    case finished

    var id: String { rawValue }

    var label: String {
        switch self {
        case .active: return L("在喝")
        case .finished: return L("已喝完")
        }
    }
}
