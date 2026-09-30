import Foundation
import OSLog

/// One subsystem for the whole app, so a single `log stream` predicate sees
/// everything that matters during a run. Matches the sibling app's convention.
enum AppLog {
    static let subsystem = "com.brewphase.ios"

    static let lifecycle = Logger(subsystem: subsystem, category: "lifecycle")
    static let store = Logger(subsystem: subsystem, category: "store")
    static let phase = Logger(subsystem: subsystem, category: "phase")
    static let notifications = Logger(subsystem: subsystem, category: "notifications")
    static let images = Logger(subsystem: subsystem, category: "images")
    static let export = Logger(subsystem: subsystem, category: "export")
    static let flavor = Logger(subsystem: subsystem, category: "flavor")
    /// 本地 RAG：索引、检索、以及每一次问答走了哪条路径。
    static let rag = Logger(subsystem: subsystem, category: "rag")
}
