import Foundation
import SwiftData

/**
 * 数据落库后的自动推送。
 *
 * SwiftData 没有变更回调，但它建立在 Core Data 上：每次 `context.save()`
 *（包括系统自动保存）都会发出 `NSManagedObjectContextDidSave`。在这里
 * 一处收口，所有实体（咖啡、记录、画布、标签）的改动都被覆盖——比在每个
 * 视图的 save 后各埋一次可靠得多，新视图也不会漏。
 *
 * 这条依赖由 `SyncAutoPushTests.testSwiftDataSaveFiresDidSaveNotification`
 * 守护：如果哪天通知不再发出，测试先红，而不是「自动同步悄悄失效」。
 *
 * 通知不区分是哪个上下文存的：未配对时 `scheduleAutoSync` 自己会返回，
 * 测试宿主里的保存也不会真的发出同步请求。
 */
@MainActor
enum SyncAutoPush {
    private static var observer: NSObjectProtocol?
    private static var installedContext: ModelContext?

    /// 在 App 拿到容器后调用一次；重复调用是安全的（不叠加观察者）。
    static func install(container: ModelContainer) {
        guard observer == nil else { return }
        let context = container.mainContext
        installedContext = context
        observer = NotificationCenter.default.addObserver(
            forName: .NSManagedObjectContextDidSave,
            object: nil,
            queue: .main
        ) { _ in
            SyncManager.shared.scheduleAutoSync(context: context)
        }
    }
}
