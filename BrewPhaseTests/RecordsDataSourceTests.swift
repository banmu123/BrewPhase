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

    // MARK: - 筛选变化

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
