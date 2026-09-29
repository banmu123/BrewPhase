import Foundation

/// Screens the app can be asked to open straight from a launch argument.
///
/// This exists so the UI can be inspected on a simulator without a UI-test
/// harness: `simctl launch` cannot tap, and hand-driving the app to reach the
/// detail page or an editor is the slowest possible way to find a layout bug.
///
/// It is inert in normal use — nothing reads it unless the process was launched
/// with `-BrewPhaseScreen`, which only `Tools/run.sh` ever passes. The sibling
/// app uses the same trick for the same reason.
enum DebugScreen: String, CaseIterable, Identifiable {
    case beanDetail
    case beanEditor
    case brewEditor
    case tasting
    /// The flavour timeline on its own, because on the detail page it sits below
    /// the fold and cannot be reached without scrolling.
    case tastingTimeline
    case rules
    case export
    /// The language row, which sits below the fold on the More screen and so
    /// cannot be screenshotted in place.
    case language

    var id: String { rawValue }
}

enum DebugLaunch {

    private static func value(for flag: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: flag), args.indices.contains(index + 1) else { return nil }
        let value = args[index + 1]
        return value.hasPrefix("-") ? nil : value
    }

    /// `-BrewPhaseScreen beanDetail`
    static var screen: DebugScreen? {
        guard let raw = value(for: "-BrewPhaseScreen") else { return nil }
        return DebugScreen(rawValue: raw)
    }

    /// `-BrewPhaseTab brews`
    static var tab: AppTab? {
        switch value(for: "-BrewPhaseTab") {
        case "cellar": return .cellar
        case "brews": return .brews
        case "more": return .more
        default: return nil
        }
    }
}
