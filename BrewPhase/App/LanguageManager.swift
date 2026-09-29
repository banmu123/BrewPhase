import SwiftUI

/// The three choices in the language picker.
///
/// The interface language is a preference of this app, not of the device, so
/// switching it must take effect immediately — without a restart and without the
/// user going into Settings and changing the system language.
enum AppLanguage: String, CaseIterable, Identifiable, Sendable {
    /// Whatever the device is set to, narrowed to the two languages we ship.
    case system
    case simplifiedChinese = "zh-Hans"
    case english = "en"

    var id: String { rawValue }

    /// The `.lproj` code actually used to look strings up.
    ///
    /// "Follow System" resolves to one of the two shipped languages rather than
    /// to the raw system code, so a user whose device is in French gets English
    /// instead of a bundle that does not exist.
    var resolvedCode: String {
        switch self {
        case .system:
            let preferred = Locale.preferredLanguages.first?.lowercased() ?? "en"
            return preferred.hasPrefix("zh") ? "zh-Hans" : "en"
        case .simplifiedChinese: return "zh-Hans"
        case .english: return "en"
        }
    }

    var locale: Locale { Locale(identifier: resolvedCode) }

    /// Option names are written in their own language — `English`, `简体中文` —
    /// so a user can find their language whatever the interface currently says.
    /// Only "follow the system" is translated.
    var displayName: String {
        switch self {
        case .system: return L("跟随系统")
        case .simplifiedChinese: return "简体中文"
        case .english: return "English"
        }
    }
}

// MARK: - The bundle the app is currently speaking

/// Kept as a locked global rather than a property of `LanguageManager`.
///
/// `L()` is reached from non-main contexts too — notification scheduling and
/// export both build user-facing strings off the main actor — and reading a
/// `@MainActor` object from there would not compile.
private let languageLock = NSLock()
private var languageBundle: Bundle = .main
private var languageCode: String = AppLanguage.system.resolvedCode

func currentLocalizedBundle() -> Bundle {
    languageLock.lock()
    defer { languageLock.unlock() }
    return languageBundle
}

/// The locale the interface is being drawn in.
///
/// Dates are formatted with this rather than with `Locale.current`, so a user who
/// sets the app to English on a Chinese device gets `Sep 24`, not `9月24日`.
func currentLocaleCode() -> String {
    languageLock.lock()
    defer { languageLock.unlock() }
    return languageCode
}

func currentAppLocale() -> Locale { Locale(identifier: currentLocaleCode()) }

/// - Returns: the bundle the app should now use, best effort.
@discardableResult
private func adoptBundle(for language: AppLanguage) -> Bundle {
    let code = language.resolvedCode
    let resolved: Bundle
    if let path = Bundle.main.path(forResource: code, ofType: "lproj"),
       let found = Bundle(path: path) {
        resolved = found
    } else {
        // A language folder that failed to make it into the bundle must degrade
        // to the system default, never to blank labels.
        AppLog.lifecycle.error("no \(code, privacy: .public).lproj in the bundle; using the default")
        resolved = .main
    }

    languageLock.lock()
    languageBundle = resolved
    languageCode = code
    languageLock.unlock()
    return resolved
}

/// Looks a string up in the language the app is currently set to.
///
/// Why this has to exist: SwiftUI's `Text("…")` only localises literal keys that
/// are rendered as text. Anything the app builds outside a view — a formatted
/// date, a validation sentence, a phase's name, a notification body — never
/// passes through that channel and needs an explicit lookup. Views use both: the
/// literals go through `Text`, everything computed comes through here.
///
/// **The keys are the Chinese source sentences.** That is a deliberate choice
/// for this codebase: the product is written in Chinese first, and using the
/// readable sentence as its own key keeps the source legible and means no string
/// lives in two places. It does mean `zh-Hans.lproj` is an identity table and
/// `en.lproj` carries the real work — if a key is missing there, the user sees
/// the Chinese sentence rather than an empty label.
///
/// Placeholders are always `%@` with a `String` argument; `%lld` with an `Int`
/// is not portable across widths.
func L(_ key: String, _ arguments: CVarArg...) -> String {
    let format = currentLocalizedBundle().localizedString(forKey: key, value: nil, table: nil)
    guard !arguments.isEmpty else { return format }
    return String(format: format, arguments: arguments)
}

extension LocalizedStringKey {
    /// For text that is already in its final form — translated by `L()`, or read
    /// straight out of the database — being handed to a view that wants a key.
    /// The lookup misses and the text passes through unchanged, which is exactly
    /// what should happen: there is nothing left to translate.
    static func alreadyLocalized(_ resolved: String) -> LocalizedStringKey {
        LocalizedStringKey(resolved)
    }
}

// MARK: - Manager

@MainActor
final class LanguageManager: ObservableObject {

    static let shared = LanguageManager()
    static let storageKey = "BrewPhase.AppLanguage"

    @Published private(set) var current: AppLanguage

    private init() {
        let stored = UserDefaults.standard.string(forKey: Self.storageKey)
        let resolved = stored.flatMap(AppLanguage.init(rawValue:)) ?? .system
        current = resolved
        // Applied here rather than from `onAppear`: the first frame would
        // otherwise be drawn in the system language and then swap, which reads as
        // a flicker on every launch.
        adoptBundle(for: resolved)
    }

    func set(_ language: AppLanguage) {
        guard language != current else { return }
        current = language
        UserDefaults.standard.set(language.rawValue, forKey: Self.storageKey)
        adoptBundle(for: language)
    }

    /// Pins the language for a process with no interface — the unit tests, which
    /// assert against one language's copy.
    ///
    /// `nonisolated` on purpose: `setUp` is not main-actor isolated, and this
    /// touches only the locked globals and `UserDefaults`.
    nonisolated static func pinForTesting(_ language: AppLanguage) {
        UserDefaults.standard.set(language.rawValue, forKey: storageKey)
        adoptBundle(for: language)
    }
}
