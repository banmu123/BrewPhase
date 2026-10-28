import Foundation
import SwiftData

/// 恢复完成后的通知协调。
///
/// 单独抽出来，是为了把「读取恢复结果」与「动系统通知」这两步排成不可颠倒的顺序：
/// **只有在新上下文里成功读到恢复后的豆子与规则之后，才允许清理旧通知。**
/// 读不到就停下——宁可让旧通知多留一会儿（下次启动会兜底），也不能先清空
/// 再发现排不回来，让用户所有提醒一起失效。
///
/// 这一层不抛错：数据库恢复成功是既成事实，通知同步失败不能反过来让调用方
/// 报告「恢复没有完成，原有数据保持不动」。调用方据 `Outcome` 分别提示。
@MainActor
enum PostRestoreSync {

    enum Outcome: Equatable {
        /// 已按恢复后的数据重排。
        case reconciled
        /// 读不到恢复后的数据：系统通知保持原样，等下次启动自愈。
        case dataUnavailable
    }

    typealias Loader = (ModelContext) throws -> (beans: [Bean], rules: [PhaseRule])

    /// 读取恢复后的数据并协调通知。`load` 可注入，用于验证「读失败不动通知」。
    static func reconcile(
        container: ModelContainer,
        manager: NotificationManager = .shared,
        load: Loader = { context in
            (try context.fetch(FetchDescriptor<Bean>()),
             try context.fetch(FetchDescriptor<PhaseRule>()))
        }
    ) async -> Outcome {
        // 用全新上下文：主上下文此刻可能还没把替换后的数据合并进来，
        // 拿旧豆子去重排会把该排的提醒清掉却不补回来。
        let context = ModelContext(container)

        let beans: [Bean]
        let rules: [PhaseRule]
        do {
            (beans, rules) = try load(context)
        } catch {
            AppLog.notifications.error(
                "post-restore load failed, pending notifications left untouched: \(error.localizedDescription, privacy: .public)"
            )
            return .dataUnavailable
        }

        await manager.reconcileAfterRestore(
            beans: beans,
            book: PhaseRuleBook.make(stored: rules),
            context: context
        )
        return .reconciled
    }
}
