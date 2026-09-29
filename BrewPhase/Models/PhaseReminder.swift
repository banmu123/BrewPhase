import Foundation
import SwiftData

/// A reminder the app has *planned* for a bag.
///
/// Rows are persisted for two reasons: so the same reminder is never scheduled
/// twice (§10, §39), and so the export contains something meaningful about
/// reminders. The system notification itself is the source of truth for
/// delivery; this is a record of intent.
@Model
final class PhaseReminder {

    var id: UUID = UUID()
    var kindRaw: String = ReminderKind.windowOpens.rawValue
    var fireDate: Date = Date()
    var enabled: Bool = true
    /// The `UNNotificationRequest` identifier. Kept explicit so cancel/replace is
    /// exact rather than a guess.
    var identifier: String = ""
    var createdAt: Date = Date()
    var bean: Bean?

    init(kind: ReminderKind, fireDate: Date, identifier: String, enabled: Bool = true, bean: Bean? = nil) {
        self.id = UUID()
        self.kindRaw = kind.rawValue
        self.fireDate = fireDate
        self.identifier = identifier
        self.enabled = enabled
        self.bean = bean
        self.createdAt = Date()
    }

    var kind: ReminderKind {
        get { ReminderKind(rawValue: kindRaw) ?? .windowOpens }
        set { kindRaw = newValue.rawValue }
    }
}
