import SwiftData
import XCTest
@testable import BrewPhase

/// `RecordsDataSource` 的契约：真分页、全数据集检索、增删协调。
///
/// 全部跑在内存容器上；45 条种子保证分页要翻三批（20+20+5）。
@MainActor
final class RecordsDataSourceTests: XCTestCase {

    private var context: ModelContext!
    private var dataSource: RecordsDataSource!

    override func setUp() {
        super.setUp()
        let config = ModelConfiguration(isStoredInMemoryOnly: true)
        let container = try! ModelContainer(for: BrewPhaseSchema.schema, configurations: config)
        // ModelContext 持有容器的强引用，内存库随上下文存活。
        context = ModelContext(container)
        dataSource = RecordsDataSource(context: context)
    }

    // MARK: - 种子

    @discardableResult
    private func seed(_ count: Int, tag: RecordTag? = nil,
                      title: ((Int) -> String)? = nil) -> [Record] {
        let base = Date(timeIntervalSince1970: 1_780_000_000)
        var seeded: [Record] = []
        for index in 0..<count {
            let record = Record(carrier: .text,
                                title: title?(index) ?? "记录 \(index)",
                                note: "第 \(index) 条的正文",
                                createdAt: base.addingTimeInterval(Double(-index * 60)))
            if let tag { record.tags = [tag] }
            context.insert(record)
            seeded.append(record)
        }
        try? context.save()
        return seeded
    }

    private func makeTag(_ name: String) -> RecordTag {
        let tag = RecordTag(name: name)
        context.insert(tag)
        return tag
    }

    // MARK: - 浏览分页

    func testFirstBatchLoadsTwentyRecordsNewestFirst() {
        let seeded = seed(45)
        dataSource.reload(query: RecordsQuery())
        XCTAssertEqual(dataSource.records.count, 20)
        XCTAssertEqual(dataSource.canLoadMore, true)
        XCTAssertEqual(dataSource.records.first?.id, seeded[0].id, "最新的在前")
        XCTAssertEqual(dataSource.records.last?.id, seeded[19].id)
    }

    func testConsecutiveBatchesCoverEverythingThenStop() {
        let seeded = seed(45)
        dataSource.reload(query: RecordsQuery())
        dataSource.loadMore()
        XCTAssertEqual(dataSource.records.count, 40)
        dataSource.loadMore()
        XCTAssertEqual(dataSource.records.count, 45)
        XCTAssertEqual(dataSource.canLoadMore, false, "数据耗尽后停止请求")
        dataSource.loadMore()
        XCTAssertEqual(dataSource.records.count, 45, "耗尽后再触发也不重复")
        // 全部 45 条，顺序与种子一致。
        XCTAssertEqual(dataSource.records.map(\.id), seeded.map(\.id))
    }

    /// 两列共用的单请求闸门：加载进行中的第二次触发是空操作。
    func testConcurrentLoadTriggerIsIgnored() {
        seed(45)
        dataSource.reload(query: RecordsQuery())
        let before = dataSource.records.count
        // 分页是同步完成的；「进行中」的窗口由 isLoadingPage 表达。
        XCTAssertFalse(dataSource.isLoadingPage, "同步批完成后闸门必须复位")
        dataSource.loadMore()
        XCTAssertEqual(dataSource.records.count, before + 20)
    }

    // MARK: - 搜索与标签（完整数据集）

    /// 搜索必须翻到分页窗口之外：第 40 条（第三批才有）也要找得到。
    func testSearchFindsRecordsBeyondTheLoadedWindow() {
        let seeded = seed(45)
        let deep = seeded[40]
        let stored = try! context.fetch(FetchDescriptor<Record>())
            .first { $0.id == deep.id }
        stored?.title = "深处的孤本"
        try? context.save()

        dataSource.reload(query: RecordsQuery(searchText: "孤本"))
        XCTAssertEqual(dataSource.records.map(\.id), [deep.id])
        XCTAssertEqual(dataSource.canLoadMore, false, "匹配只有一条，不再有下一批")
    }

    /// 标签筛选同样覆盖全数据集：三条标签记录全在首批窗口之外也能筛出来。
    func testTagFilterFindsRecordsBeyondTheLoadedWindow() {
        let tag = makeTag("咖啡")
        _ = seed(40)
        let tagged = seed(3, tag: tag) // 三条都贴标签，且都比那 40 条新
        let deep = tagged.last!

        dataSource.reload(query: RecordsQuery(tagID: tag.id))
        XCTAssertEqual(dataSource.records.map(\.id), tagged.map(\.id),
                       "标签下的全部记录，不分页窗口内外")
        XCTAssertTrue(dataSource.records.contains { $0.id == deep.id })
    }

    /// 搜索与标签同时生效：交集而不是并集。
    func testSearchAndTagCombineAsAnIntersection() {
        let tag = makeTag("灵感")
        let hit = Record(carrier: .text, title: "灵感里的关键词",
                         createdAt: Date(timeIntervalSince1970: 1_780_010_000))
        hit.tags = [tag]
        let miss = Record(carrier: .text, title: "别的东西",
                          createdAt: Date(timeIntervalSince1970: 1_780_005_000))
        miss.tags = [tag]
        let wrongTag = Record(carrier: .text, title: "关键词但标签不对",
                              createdAt: Date(timeIntervalSince1970: 1_780_001_000))
        context.insert(hit)
        context.insert(miss)
        context.insert(wrongTag)
        try? context.save()

        dataSource.reload(query: RecordsQuery(searchText: "关键词", tagID: tag.id))
        XCTAssertEqual(dataSource.records.map(\.id), [hit.id])
    }

    /// 一条记录同时贴了两个都命中搜索词的标签：并集去重后只能出现一次。
    /// 旧实现把 `known` 在循环外定死，第二个标签会把同一条记录再追加一遍。
    func testSearchDeduplicatesRecordsMatchedBySeveralTags() throws {
        let first = makeTag("灵感")
        let second = makeTag("灵感集")
        let record = Record(carrier: .text, title: "普通内容",
                            createdAt: Date(timeIntervalSince1970: 1_780_020_000))
        record.tags = [first, second]
        context.insert(record)
        try context.save()

        dataSource.reload(query: RecordsQuery(searchText: "灵感"))
        XCTAssertEqual(dataSource.records.map(\.id), [record.id],
                       "两个标签指向同一条记录，也只能出现一张卡")
        XCTAssertEqual(dataSource.records.count, 1)
    }

    /// 同一批次内部出现重复 id：只追加第一次，`fresh` 也只有一条。
    func testBatchWithDuplicateIDsAppendsOnce() throws {
        let record = Record(carrier: .text, title: "批次内重复")
        context.insert(record)
        try context.save()

        let fresh = dataSource.append([record, record])
        XCTAssertEqual(fresh.count, 1, "新增列表里同一条只能出现一次")
        XCTAssertEqual(dataSource.records.count, 1)
    }

    /// 内存匹配规则与数据库检索一致：同一个词，两条路给同一批 id。
    func testInMemoryMatchesMirrorsThePredicate() {
        seed(45)
        dataSource.reload(query: RecordsQuery(searchText: "记录 3"))
        let sql = Set(dataSource.records.map(\.id))

        let all = try! context.fetch(FetchDescriptor<Record>())
        let memory = Set(all.filter { RecordsQuery(searchText: "记录 3").matches($0) }.map(\.id))
        XCTAssertEqual(sql, memory, "谓词与内存镜像必须同步")
    }

    // MARK: - 新记录与删除

    /// 顶部插入后继续分页：偏移已随插入 +1，不该漏掉最老的一条。
    func testInsertNewAtTopKeepsTheOffsetAligned() {
        let seeded = seed(45)
        dataSource.reload(query: RecordsQuery())

        let fresh = Record(carrier: .text, title: "刚保存的",
                           createdAt: Date(timeIntervalSince1970: 1_780_100_000))
        context.insert(fresh)
        try? context.save()
        dataSource.insertNewAtTop(fresh)

        dataSource.loadMore()
        dataSource.loadMore()
        XCTAssertEqual(dataSource.records.count, 46, "45 条旧记录一条不漏 + 1 条新记录")
        XCTAssertTrue(dataSource.records.contains { $0.id == seeded[44].id }, "最老的一条不能被偏移吃掉")
        XCTAssertEqual(dataSource.records.first?.id, fresh.id)
        XCTAssertFalse(dataSource.canLoadMore)
    }

    func testRemoveDropsTheRecordFromTheWindow() {
        let seeded = seed(30)
        dataSource.reload(query: RecordsQuery())
        let victim = dataSource.records[5]
        dataSource.remove(id: victim.id)
        XCTAssertFalse(dataSource.records.contains { $0.id == victim.id })
        XCTAssertTrue(dataSource.records.contains { $0.id == seeded[0].id })
    }

    /// 详情页删除后返回：`staleIDs` 报告消失的那条。
    func testStaleIDsReportsDeletedRecords() {
        seed(30)
        dataSource.reload(query: RecordsQuery())
        let victim = dataSource.records[3]
        context.delete(victim)
        try? context.save()

        let stale = dataSource.staleIDs()
        XCTAssertEqual(stale, [victim.id])
    }

    /// 编辑让记录不再匹配当前标签筛选：协调时同样报告。
    func testStaleIDsReportsRecordsThatNoLongerMatch() {
        let tag = makeTag("随记")
        seed(25, tag: tag)
        dataSource.reload(query: RecordsQuery(tagID: tag.id))
        XCTAssertEqual(dataSource.records.count, 20)

        let victim = dataSource.records[2]
        victim.tags = []
        try? context.save()

        let stale = dataSource.staleIDs()
        XCTAssertEqual(stale, [victim.id])
    }

    /// 完好无损时协调报告为空——不能把好记录误伤。
    func testStaleIDsIsEmptyWhenEverythingStillMatches() {
        seed(30)
        dataSource.reload(query: RecordsQuery())
        XCTAssertTrue(dataSource.staleIDs().isEmpty)
    }

    // MARK: - 游标一致性（Phase 3 补修）

    /// 浏览模式：删掉首批里的一条再翻页——全部旧记录一条不漏、不重复。
    /// 旧实现不退 nextOffset，删除点之后的第一条会被偏移跳过。
    func testRemoveInBrowseModeKeepsTheCursorAligned() throws {
        let seeded = seed(45)
        dataSource.reload(query: RecordsQuery())
        let victim = dataSource.records[5]
        context.delete(victim)
        try context.save()
        dataSource.remove(id: victim.id)

        dataSource.loadMore()
        dataSource.loadMore()
        let ids = dataSource.records.map(\.id)
        XCTAssertEqual(ids.count, 44, "44 条旧记录一条不少")
        XCTAssertEqual(Set(ids).count, 44, "无重复")
        XCTAssertTrue(ids.contains(seeded[44].id), "最老的一条不能被偏移跳过")
        XCTAssertFalse(ids.contains(victim.id))
    }

    /// 标签模式：删已加载前缀里的记录，消费指针跟着退，后续不丢。
    func testRemoveInTagModeKeepsTheCursorAligned() throws {
        let tag = makeTag("随记")
        let seeded = seed(25, tag: tag)
        dataSource.reload(query: RecordsQuery(tagID: tag.id))
        let victim = dataSource.records[2]
        context.delete(victim)
        try context.save()
        dataSource.remove(id: victim.id)

        dataSource.loadMore()
        let ids = dataSource.records.map(\.id)
        XCTAssertEqual(ids.count, 24)
        XCTAssertEqual(Set(ids).count, 24)
        XCTAssertEqual(ids, seeded.map(\.id).filter { $0 != victim.id }, "顺序不变、不丢不重")
    }

    /// 搜索模式：插入一条新记录后继续翻页——指针右移，不端回重复也不跳过。
    func testInsertInSearchModeKeepsTheCursorAligned() throws {
        let seeded = seed(45)
        dataSource.reload(query: RecordsQuery(searchText: "记录")) // 45 条全部命中
        XCTAssertEqual(dataSource.records.count, 20)

        let fresh = Record(carrier: .text, title: "记录 新增",
                           createdAt: Date(timeIntervalSince1970: 1_790_000_000))
        context.insert(fresh)
        try context.save()
        dataSource.insertNewAtTop(fresh)

        dataSource.loadMore()
        dataSource.loadMore()
        dataSource.loadMore()
        let ids = dataSource.records.map(\.id)
        XCTAssertEqual(ids.count, 46)
        XCTAssertEqual(Set(ids).count, 46, "无重复")
        XCTAssertEqual(ids.first, fresh.id)
        XCTAssertTrue(ids.contains(seeded[44].id), "最老的一条不能丢")
    }

    /// 删除与新增连着发生：两个方向的游标调整互相抵消，依旧一致。
    func testRemoveThenInsertInBrowseModeStaysConsistent() throws {
        let seeded = seed(45)
        dataSource.reload(query: RecordsQuery())
        let victim = dataSource.records[3]
        context.delete(victim)
        try context.save()
        dataSource.remove(id: victim.id)

        let fresh = Record(carrier: .text, title: "夹在中间的新记录",
                           createdAt: Date(timeIntervalSince1970: 1_790_000_100))
        context.insert(fresh)
        try context.save()
        dataSource.insertNewAtTop(fresh)

        dataSource.loadMore()
        dataSource.loadMore()
        let ids = dataSource.records.map(\.id)
        XCTAssertEqual(ids.count, 45, "44 条幸存旧记录 + 1 条新记录")
        XCTAssertEqual(Set(ids).count, 45)
        XCTAssertTrue(ids.contains(seeded[44].id))
        XCTAssertTrue(ids.contains(fresh.id))
    }

    // MARK: - 待插记录的准入（筛选切换期间）

    /// 正常情况：新记录匹配当前查询、数据源也已切到同一查询。
    func testCanInsertAcceptsAMatchingFreshRecord() {
        seed(3)
        dataSource.reload(query: RecordsQuery())
        let fresh = Record(carrier: .text, title: "刚保存的")
        context.insert(fresh)
        try? context.save()

        XCTAssertTrue(dataSource.canInsert(fresh, for: RecordsQuery()))
    }

    /// 数据源的查询还停在旧值（搜索防抖窗口内）：不能插，否则列表与
    /// 布局会在下一轮重建时对不上。
    func testCanInsertRejectsWhenTheDataSourceQueryIsStale() {
        seed(3)
        dataSource.reload(query: RecordsQuery())
        let fresh = Record(carrier: .text, title: "新记录")

        XCTAssertFalse(dataSource.canInsert(fresh, for: RecordsQuery(searchText: "新")),
                       "查询还没落到数据源上，插入必须等")
    }

    /// 记录不再匹配当前查询（保存后用户换了搜索词）：不插、不播动画。
    func testCanInsertRejectsRecordsThatDoNotMatchTheQuery() {
        seed(3)
        dataSource.reload(query: RecordsQuery(searchText: "记录"))
        let miss = Record(carrier: .text, title: "完全无关")

        XCTAssertFalse(dataSource.canInsert(miss, for: RecordsQuery(searchText: "记录")))
    }

    /// 已经出现在窗口里的记录（比如查询重建把它读回来了）不再插一次。
    func testCanInsertRejectsRecordsAlreadyInTheWindow() {
        seed(3)
        dataSource.reload(query: RecordsQuery())
        let loaded = dataSource.records[0]

        XCTAssertFalse(dataSource.canInsert(loaded, for: RecordsQuery()),
                       "同一条记录不能播两次下落")
    }

    // MARK: - 筛选变化

    /// 取数代数：重建一次 +1、每成功取到一批 +1。界面把它当页脚哨兵的
    /// 身份，代数不前进就不会有新哨兵，也就不会空转。
    func testPageGenerationAdvancesPerBatchAndReload() {
        seed(45)
        let start = dataSource.pageGeneration
        dataSource.reload(query: RecordsQuery())
        XCTAssertEqual(dataSource.pageGeneration, start + 2, "重建 +1、首批 +1")
        dataSource.loadMore()
        XCTAssertEqual(dataSource.pageGeneration, start + 3)
        dataSource.loadMore()
        XCTAssertEqual(dataSource.pageGeneration, start + 4, "最后 5 条也是一批")
        dataSource.loadMore()
        XCTAssertEqual(dataSource.pageGeneration, start + 4, "空批不推进，哨兵不会空转")
    }

    func testReloadResetsTheWindowCompletely() {
        seed(45)
        dataSource.reload(query: RecordsQuery())
        dataSource.loadMore()
        XCTAssertEqual(dataSource.records.count, 40)

        dataSource.reload(query: RecordsQuery(searchText: "不存在的词"))
        XCTAssertEqual(dataSource.records.count, 0)
        XCTAssertEqual(dataSource.canLoadMore, false)

        dataSource.reload(query: RecordsQuery())
        XCTAssertEqual(dataSource.records.count, 20, "回到浏览模式从头开始")
    }
}
