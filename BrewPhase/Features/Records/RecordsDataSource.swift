import Foundation
import SwiftData

/// 一次生效中的筛选条件：搜索词与标签各占一位，可以同时生效。
///
/// `matches` 是谓词的**内存镜像**：新记录保存后要不要进当前列表（§八）、
/// 详情页返回后已有记录还匹不匹配（协调），都靠它判定。两边规则必须
/// 同步改——改一处不改另一处，搜索结果就会出现「SQL 说有、内存说没有」。
struct RecordsQuery: Equatable, Sendable {
    var searchText: String = ""
    var tagID: UUID?

    var isActive: Bool {
        !searchText.trimmed.isEmpty || tagID != nil
    }

    /// 内存版匹配规则（与 `RecordsDataSource.predicate(for:)` 同一套语义）。
    /// 搜索覆盖：标题、备注、来源、作者、网页摘要、网址（含域名）、标签名。
    func matches(_ record: Record) -> Bool {
        if let tagID, !(record.tags ?? []).contains(where: { $0.id == tagID }) {
            return false
        }
        let keyword = searchText.trimmed.lowercased()
        guard !keyword.isEmpty else { return true }
        return record.title.lowercased().contains(keyword)
            || record.note.lowercased().contains(keyword)
            || record.sourceName.lowercased().contains(keyword)
            || record.authorName.lowercased().contains(keyword)
            || record.summary.lowercased().contains(keyword)
            || record.urlString.lowercased().contains(keyword)
            || (record.tags ?? []).contains { $0.name.lowercased().contains(keyword) }
    }
}

/// Records 的数据读取层：真分页 + 全数据集检索。
///
/// 替代旧的「`@Query` 全量拉取 + 内存筛选」：浏览模式按批从数据库取
/// （`fetchLimit` / `fetchOffset`，每批 20 条），只有用户点搜索或标签时
/// 才做全数据集检索——那是用户显式要求「找遍所有记录」的时刻。
///
/// 三种模式的取数策略：
///
/// - **浏览**（无筛选）：数据库偏移分页。删除会使偏移错位，靠 id 去重兜住
///   重复；极小概率跳过一条，下次筛选变化重建时自然修复。
/// - **搜索**：字段谓词全量取回 + 标签名匹配的记录并集，内存去重排序后
///   仍按批交给界面——搜索必须覆盖全部数据，这是任务书的硬要求。
/// - **标签**：该标签的关联记录（数量受使用量约束）内存排序分批。
///
/// 所有变更操作（增/删/协调）都保持「已加载记录的相对位置不变」——
/// 列归属由 Planner 管理，这里只负责把对的记录按对的顺序递上去。
@MainActor
@Observable
final class RecordsDataSource {

    static let pageSize = 20

    /// 已加载窗口，按创建时间倒序。卡片渲染与 Planner 分派的唯一数据源。
    private(set) var records: [Record] = []
    /// 是否还有更早的记录可取。
    private(set) var canLoadMore = true
    /// 单请求保护：一次取数只允许一个请求在飞（页脚哨兵与人工重试共用）。
    private(set) var isLoadingPage = false
    /// 上一批加载失败（数据库错误）。界面据此给出轻量重试入口。
    private(set) var lastLoadFailed = false
    /// 取数代数：每次重建查询、每成功取到一批都 +1。
    ///
    /// 界面把它当作页脚哨兵的 `id`——一个代数只存在一个哨兵，哨兵自己
    /// 只允许触发一次，于是「同一批最多一次自动请求」是结构保证，而不是
    /// 靠共享布尔位在两条列之间互相谦让。
    private(set) var pageGeneration = 0

    private(set) var query = RecordsQuery()

    private let context: ModelContext
    /// 搜索 / 标签模式下的完整结果池；nil 表示浏览模式（走数据库偏移）。
    private var pendingResults: [Record]?
    private var servedInPending = 0

    init(context: ModelContext) {
        self.context = context
    }

    // MARK: - 读取

    /// 按当前条件取下一批，返回**真正新进窗口**的记录（已去重）——
    /// 调用方拿它给 Planner 做 `append`。同一时间只允许一个请求在飞。
    @discardableResult
    func loadMore() -> [Record] {
        guard canLoadMore, !isLoadingPage else { return [] }
        isLoadingPage = true
        lastLoadFailed = false
        defer { isLoadingPage = false }

        do {
            let batch: [Record]
            if let pending = pendingResults {
                let slice = Array(pending.dropFirst(servedInPending).prefix(Self.pageSize))
                servedInPending += slice.count
                batch = slice
            } else {
                var descriptor = FetchDescriptor<Record>(
                    predicate: Self.predicate(for: query),
                    sortBy: [SortDescriptor(\.createdAt, order: .reverse),
                             SortDescriptor(\.id)])
                descriptor.fetchLimit = Self.pageSize
                descriptor.fetchOffset = nextOffset
                batch = try context.fetch(descriptor)
                nextOffset += batch.count
            }
            let fresh = append(batch)
            // 取不满一批 = 数据耗尽。
            canLoadMore = batch.count == Self.pageSize
            if !fresh.isEmpty { pageGeneration += 1 }
            return fresh
        } catch {
            AppLog.store.error("records page failed: \(error.localizedDescription, privacy: .public)")
            lastLoadFailed = true // 数据还在，界面给重试入口即可
            return []
        }
    }

    /// 忽略已加载的 id 后追加。去重用 `Record.id`，不用下标。
    /// 集合必须随追加**同步增长**：同一批里出现两次的 id 若只看批次开始时的
    /// 快照，就会被追加两遍、渲染成两张同 id 的卡片。
    /// 非 private：`RecordsDataSourceTests` 直接喂「一批里同一个 id 出现两次」，
    /// 这是分页取数里最难从数据库复现的一种输入。
    func append(_ batch: [Record]) -> [Record] {
        var known = Set(records.map(\.id))
        var fresh: [Record] = []
        for record in batch {
            guard known.insert(record.id).inserted else { continue }
            records.append(record)
            fresh.append(record)
        }
        return fresh
    }

    /// 一条已加载的记录。
    func record(with id: UUID) -> Record? {
        records.first { $0.id == id }
    }

    /// 一条排队待插的记录，**现在**还能不能进列表。
    ///
    /// 三个条件缺一不可：
    /// 1. 数据源的查询就是界面此刻的查询——筛选正在切换时，旧记录不能趁
    ///    防抖窗口插进来（`dataSource.query` 落后于 `currentQuery`）；
    /// 2. 记录仍然匹配当前查询（保存后用户可能改了搜索词或标签）；
    /// 3. 列表里还没有它（查询重建可能已经把它一起读进来了，不能再播一次）。
    func canInsert(_ record: Record, for query: RecordsQuery) -> Bool {
        self.query == query
            && query.matches(record)
            && self.record(with: record.id) == nil
    }

    // MARK: - 筛选变化（重建）

    /// 搜索词 / 标签变化：重置分页、清空旧布局的数据面，从最新符合条件
    /// 的记录重新开始。Planner 的 `rebuild` 由调用方配合完成——两者必须
    /// 同一步完成，不能只清一边。
    func reload(query newQuery: RecordsQuery) {
        query = newQuery
        records = []
        canLoadMore = true
        isLoadingPage = false
        lastLoadFailed = false
        servedInPending = 0
        nextOffset = 0
        pageGeneration += 1

        if query.tagID != nil {
            // 标签的关联记录数量有限，直接从关系里取全集。
            let tag = fetchTag(id: query.tagID)
            let candidates = (tag?.records ?? []).sorted { lhs, rhs in
                if lhs.createdAt != rhs.createdAt { return lhs.createdAt > rhs.createdAt }
                return lhs.id.uuidString < rhs.id.uuidString
            }
            pendingResults = candidates.filter { query.matches($0) }
        } else if !query.searchText.trimmed.isEmpty {
            pendingResults = fetchSearchResults()
        } else {
            pendingResults = nil
        }
        loadMore()
    }

    /// 全数据集搜索：字段谓词取回 + 标签名命中的记录并集，按时间倒序。
    private func fetchSearchResults() -> [Record] {
        let keyword = query.searchText.trimmed
        let descriptor = FetchDescriptor<Record>(
            predicate: Self.fieldPredicate(keyword),
            sortBy: [SortDescriptor(\.createdAt, order: .reverse),
                     SortDescriptor(\.id)])
        var results = (try? context.fetch(descriptor)) ?? []

        // 标签名命中的记录大多不满足字段谓词，单独取来并集。
        var tagDescriptor = FetchDescriptor<RecordTag>(
            predicate: #Predicate { $0.name.localizedStandardContains(keyword) })
        tagDescriptor.fetchLimit = 100
        let matchedTags = (try? context.fetch(tagDescriptor)) ?? []
        // 同一条记录可能贴在多个命中标签上：集合必须跟着 `results` 一起长，
        // 不能只在并集开始前拍一张快照。
        var known = Set(results.map(\.id))
        for tag in matchedTags {
            for record in tag.records ?? [] {
                guard known.insert(record.id).inserted else { continue }
                results.append(record)
            }
        }
        return results
            .filter { query.matches($0) }
            .sorted { lhs, rhs in
                if lhs.createdAt != rhs.createdAt { return lhs.createdAt > rhs.createdAt }
                return lhs.id.uuidString < rhs.id.uuidString
            }
    }

    private func fetchTag(id: UUID?) -> RecordTag? {
        guard let id else { return nil }
        var descriptor = FetchDescriptor<RecordTag>(
            predicate: #Predicate { $0.id == id })
        descriptor.fetchLimit = 1
        return (try? context.fetch(descriptor))?.first
    }

    // MARK: - 新记录（顶部插入）

    /// 一条刚保存的记录。调用方已用 `query.matches` 确认它匹配当前筛选。
    ///
    /// 游标必须跟着走，否则下一批会漏边界：
    /// - 浏览模式 `nextOffset + 1`——数据库在游标之前多了一条。
    /// - 搜索 / 标签模式 `servedInPending + 1`——插入在已消费前缀的最前面，
    ///   消费指针要跟着右移，下一批才不会把刚消费的最后一条重新端上来。
    func insertNewAtTop(_ record: Record) {
        records.insert(record, at: 0)
        switch pendingResults {
        case .some(var pending):
            pending.insert(record, at: 0)
            pendingResults = pending
            servedInPending += 1
        case nil:
            nextOffset += 1
        }
    }

    // MARK: - 删除与协调

    /// 一条已加载的记录被删除（列表长按或详情页）。
    ///
    /// 游标必须跟着退，否则下一批会跳过边界记录：
    /// - 浏览模式删除已计入 `nextOffset` 的记录 → 偏移 -1。
    /// - 搜索 / 标签模式：删的是**已消费前缀**里的记录 → 消费指针 -1；
    ///   删的是尚未消费的部分 → 指针不动（它还没被端上去）。
    func remove(id: UUID) {
        let wasLoaded = records.contains { $0.id == id }
        records.removeAll { $0.id == id }
        guard let pending = pendingResults else {
            if wasLoaded { nextOffset = max(0, nextOffset - 1) }
            return
        }
        let index = pending.firstIndex { $0.id == id }
        var updated = pending
        updated.removeAll { $0.id == id }
        pendingResults = updated
        if let index, index < servedInPending {
            servedInPending = max(0, servedInPending - 1)
        }
    }

    /// 从详情页返回、sheet 收起后的核对：找出已被删除或不再匹配当前筛选
    /// 的已加载记录，交给调用方去移除（Planner 同步 `remove`）。
    /// **不**在这里补拉新记录——避免返回列表时底部悄悄长出内容。
    func staleIDs() -> [UUID] {
        let ids = records.map(\.id)
        guard !ids.isEmpty else { return [] }
        var descriptor = FetchDescriptor<Record>(
            predicate: #Predicate { ids.contains($0.id) })
        descriptor.fetchLimit = max(ids.count, 1)
        let survivors = (try? context.fetch(descriptor)) ?? []
        let survivorIDs = Set(survivors.map(\.id))
        // 数据库还在、但编辑后不再匹配当前筛选的，同样算过期。
        let unmatched = Set(survivors.filter { !query.matches($0) }.map(\.id))
        return ids.filter { !survivorIDs.contains($0) || unmatched.contains($0) }
    }

    // MARK: - 谓词

    /// 浏览模式的数据库谓词：无筛选时全量，搜索时按字段匹配。
    /// 标签名匹配不做进谓词——关系上的嵌套闭包依赖存储的翻译能力，
    /// 搜索模式本来就是全量取回，内存并集更稳。
    private static func predicate(for query: RecordsQuery) -> Predicate<Record>? {
        let keyword = query.searchText.trimmed
        guard !keyword.isEmpty else { return nil }
        return fieldPredicate(keyword)
    }

    private static func fieldPredicate(_ keyword: String) -> Predicate<Record> {
        #Predicate<Record> { record in
            record.title.localizedStandardContains(keyword)
                || record.note.localizedStandardContains(keyword)
                || record.sourceName.localizedStandardContains(keyword)
                || record.authorName.localizedStandardContains(keyword)
                || record.summary.localizedStandardContains(keyword)
                || record.urlString.localizedStandardContains(keyword)
        }
    }

    // MARK: - 游标

    private var nextOffset = 0
}
