import Foundation

/// The shipped flavour vocabulary (§15) plus the gear list the editors offer as
/// suggestions. Both are hints, never constraints: every one of these fields can
/// hold anything the user types.
enum FlavorLibrary {

    struct Group: Identifiable, Equatable, Sendable {
        let id: String
        let title: String
        /// Canonical tag values — what gets written into the record.
        let tags: [String]
    }

    /// The shipped vocabulary.
    ///
    /// A built-in tag is *stored* under its English name, following the same
    /// convention as `BeanPhase.rawValue` and `RoastLevel.rawValue`: a stable
    /// identifier that does not shift when the interface language does. What the
    /// user reads is translated from it, so the same tag can be picked in Chinese
    /// and in English and still be one tag — which matters because the editor
    /// marks a tag as selected by comparing values.
    ///
    /// Computed rather than stored: a `let` would freeze the translations at
    /// first use and keep showing the old language after the user switches.
    static var groups: [Group] {
        [
            Group(id: "floral", title: L("花香"),
                  tags: ["Jasmine", "Rose", "Orange Blossom"]),
            Group(id: "fruit", title: L("水果"),
                  tags: ["Mandarin", "Grape", "Blueberry", "Strawberry", "Peach"]),
            Group(id: "sweet", title: L("甜感"),
                  tags: ["Honey", "Caramel", "Brown Sugar", "Chocolate"]),
        ]
    }

    static var allTags: [String] { groups.flatMap(\.tags) }

    static func isBuiltIn(_ tag: String) -> Bool {
        allTags.contains(tag)
    }

    /// What to print for a tag: the translation of a built-in, or the words the
    /// user typed for a tag of their own.
    static func displayName(for tag: String) -> String {
        guard let source = sourceText[tag] else { return tag }
        return L(source)
    }

    /// `Jasmine · Mandarin · Honey` — the form the cards and rows use.
    ///
    /// Every place that prints a tag goes through here rather than joining the
    /// stored values directly, because a stored built-in is an English id and
    /// printing it straight would put "Jasmine" on a Chinese screen.
    static func displayList(_ tags: [String], limit: Int? = nil) -> String {
        let shown = limit.map { Array(tags.prefix($0)) } ?? tags
        return shown.map(displayName(for:)).joined(separator: " · ")
    }

    /// Canonical tag → the Chinese sentence used as its lookup key.
    private static let sourceText: [String: String] = [
        "Jasmine": "茉莉",
        "Rose": "玫瑰",
        "Orange Blossom": "橙花",
        "Mandarin": "柑橘",
        "Grape": "葡萄",
        "Blueberry": "蓝莓",
        "Strawberry": "草莓",
        "Peach": "桃",
        "Honey": "蜂蜜",
        "Caramel": "焦糖",
        "Brown Sugar": "红糖",
        "Chocolate": "巧克力",
    ]
}

/// Suggested gear and parameters. Tapping one fills the field; typing something
/// else is equally fine.
///
/// Unlike the flavour vocabulary these are *not* canonical keys: the field they
/// fill is free text, so what the user taps is exactly what gets stored. A brew
/// recorded as "爱乐压" keeps that name after the interface is switched to
/// English, the same as if it had been typed by hand.
///
/// Computed for the same reason as `FlavorLibrary.groups` — a stored array would
/// not notice a language change.
enum BrewCatalog {

    static var methods: [String] {
        ["V60", L("爱乐压"), L("聪明杯"), L("法压壶"), L("意式浓缩"), L("美式"),
         L("拿铁"), L("卡布奇诺"), L("摩卡壶"), L("冷萃")]
    }

    static var grinders: [String] {
        [L("司令官 C40"), "1Zpresso K-Ultra", L("泰摩 栗子"), "Baratza Encore", "Eureka Mignon"]
    }

    static let temperatures: [Double] = [86, 88, 90, 92, 93, 94, 96]

    static let dosePresets: [Double] = [12, 15, 18, 20]

    static let waterPresets: [Double] = [180, 200, 240, 300]
}

/// Keys for the small amount of state that belongs in `UserDefaults` rather than
/// in the store: brew defaults and which reminders are on.
///
/// These are preferences about the app, not records about coffee, so they stay
/// out of the database and out of the export's way. They are read directly by
/// `@AppStorage` in the settings screens, which keeps the settings UI reactive
/// without a second source of truth.
enum PrefKey {
    static let defaultMethod = "brewphase.defaults.method"
    static let defaultDoseG = "brewphase.defaults.doseG"
    static let defaultWaterG = "brewphase.defaults.waterG"
    static let defaultWaterTemp = "brewphase.defaults.waterTemp"

    /// One key per reminder kind, holding "is this kind switched on".
    static func reminderEnabled(_ kind: ReminderKind) -> String {
        "brewphase.reminder.\(kind.rawValue).enabled"
    }

    static let seededPhaseRules = "brewphase.seeded.phaseRules"
    static let askedForNotifications = "brewphase.notifications.asked"

    /// 轻引导（规格 §十七）：第一次记完一杯后，在结果页提一句「参数会自动带上」，
    /// 只提一次。不用卡片、不用页 — 一行字就够了。
    static let didShowPrefillHint = "brewphase.onboarding.prefillHint"

    /// 实验性的预计风味窗口。默认开着，但要知道这是合成数据训练的模型，
    /// 用户得有一个地方能把它关掉。
    static let experimentalFlavorPrediction = "brewphase.flavor.prediction.enabled"

    // MARK: 本地问答（RAG）

    /// 总开关。关掉之后索引也不再维护。
    static let askEnabled = "brewphase.rag.enabled"
    /// 用哪一种 embedding 后端（`EmbeddingBackend.rawValue`）。
    static let askEmbeddingBackend = "brewphase.rag.embeddingBackend"
    /// 优先用哪一种回答引擎（`AnswerEngine.rawValue`）。
    static let askAnswerEngine = "brewphase.rag.answerEngine"
    /// 优先取多少条资料进上下文。
    static let askPassageLimit = "brewphase.rag.passageLimit"

    /// Ollama 的地址与模型名。放在同一组里，方便设置页一次性读写。
    static let ollamaBaseURL = "brewphase.rag.ollama.baseURL"
    static let ollamaEmbeddingModel = "brewphase.rag.ollama.embeddingModel"
    static let ollamaChatModel = "brewphase.rag.ollama.chatModel"
}

/// The default recipe a new brew starts from (§18).
struct BrewDefaults: Equatable, Sendable {
    var method: String
    var doseG: Double
    var waterG: Double
    var waterTemp: Double

    static let standard = BrewDefaults(method: "V60", doseG: 15, waterG: 240, waterTemp: 92)

    /// Reads whatever the user has set, falling back to the shipped values.
    static func current(from defaults: UserDefaults = .standard) -> BrewDefaults {
        let fallback = BrewDefaults.standard
        return BrewDefaults(
            method: defaults.string(forKey: PrefKey.defaultMethod) ?? fallback.method,
            doseG: defaults.object(forKey: PrefKey.defaultDoseG) as? Double ?? fallback.doseG,
            waterG: defaults.object(forKey: PrefKey.defaultWaterG) as? Double ?? fallback.waterG,
            waterTemp: defaults.object(forKey: PrefKey.defaultWaterTemp) as? Double ?? fallback.waterTemp
        )
    }

    var asRecipe: BrewRecipe {
        BrewRecipe(method: method, grinder: "", grindSize: "",
                   waterTemp: waterTemp, coffeeG: doseG, waterG: waterG, timeSeconds: 0)
    }
}

extension ReminderPreferences {
    /// Reads the per-kind switches the settings screen writes.
    ///
    /// 默认值与设置页同一处定义（`ReminderKind.recommendedByDefault`）：
    /// 推荐提醒默认开，其余默认关——没动过开关的用户不该被五路提醒轰炸。
    static func current(from defaults: UserDefaults = .standard) -> ReminderPreferences {
        var disabled = Set<ReminderKind>()
        for kind in ReminderKind.allCases
        where !defaults.bool(forKey: PrefKey.reminderEnabled(kind), default: kind.recommendedByDefault) {
            disabled.insert(kind)
        }
        return ReminderPreferences(disabled: disabled)
    }
}

extension UserDefaults {
    /// `bool(forKey:)` cannot express "default true", which every reminder
    /// switch needs.
    func bool(forKey key: String, default fallback: Bool) -> Bool {
        object(forKey: key) == nil ? fallback : bool(forKey: key)
    }
}

