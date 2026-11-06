import XCTest
@testable import BrewPhase

/// `MasonryColumnPlanner` 的契约测试（Records 两列瀑布流的前置算法）。
///
/// 这些测试验证的是**行为**而不是实现：列归属、累计高度、相对顺序、
/// 稳定性与确定性。手算的贪心轨迹（间距 12）贯穿多组用例：
///
///     A200 → 左；B300 → 右；C150 → 左(362)；D400 → 右(712)
///     追加 E100 → 左(474)；F250 → 左(736)
///
/// 累计高度一律带 0.001 精度断言——增量维护与精确重建允许浮点末位差异，
/// 不允许可见偏差。
final class MasonryColumnPlannerTests: XCTestCase {

    private let spacing: CGFloat = 12

    private func makePlanner() -> MasonryColumnPlanner {
        MasonryColumnPlanner(interItemSpacing: spacing)
    }

    /// 手算轨迹的前四条（见类注释）。
    private func canonicalBatch() -> (a: MasonryLayoutItem, b: MasonryLayoutItem,
                                      c: MasonryLayoutItem, d: MasonryLayoutItem) {
        (MasonryLayoutItem(id: UUID(), height: 200),
         MasonryLayoutItem(id: UUID(), height: 300),
         MasonryLayoutItem(id: UUID(), height: 150),
         MasonryLayoutItem(id: UUID(), height: 400))
    }

    /// 状态一致性：任意操作序列之后，每列的累计高度必须等于「列内实际
    /// 条目直算」的 sum + 间距 × (条数 − 1)——增量维护不允许漂移。
    private func assertTotalsMatchEntries(_ planner: MasonryColumnPlanner,
                                          _ message: String = "",
                                          file: StaticString = #filePath,
                                          line: UInt = #line) {
        for column in [MasonryColumn.left, .right] {
            let entries = planner.items(in: column)
            let direct = entries.map(\.height).reduce(0, +)
                + spacing * CGFloat(max(0, entries.count - 1))
            XCTAssertEqual(planner.totalHeight(of: column), direct,
                           accuracy: 0.001, "\(column) \(message)",
                           file: file, line: line)
        }
    }

    // MARK: - 基础分配

    func testEmptyInputYieldsTwoEmptyColumns() {
        var planner = makePlanner()
        planner.rebuild(with: [])
        XCTAssertTrue(planner.isEmpty)
        XCTAssertEqual(planner.recordCount, 0)
        XCTAssertEqual(planner.totalHeight(of: .left), 0)
        XCTAssertEqual(planner.totalHeight(of: .right), 0)
        XCTAssertTrue(planner.items(in: .left).isEmpty)
        XCTAssertTrue(planner.items(in: .right).isEmpty)
    }

    func testFirstRecordGoesToTheLeftColumn() {
        var planner = makePlanner()
        let a = MasonryLayoutItem(id: UUID(), height: 200)
        planner.rebuild(with: [a])
        XCTAssertEqual(planner.column(of: a.id), .left)
        XCTAssertEqual(planner.items(in: .left).map(\.id), [a.id])
        XCTAssertEqual(planner.totalHeight(of: .left), 200, accuracy: 0.001)
        XCTAssertEqual(planner.totalHeight(of: .right), 0)
    }

    /// 任务书里的场景：左 520 / 右 360 → 下一条去右列。
    func testSecondRecordGoesToTheShorterColumn() {
        var planner = makePlanner()
        let a = MasonryLayoutItem(id: UUID(), height: 520)
        let b = MasonryLayoutItem(id: UUID(), height: 300)
        planner.rebuild(with: [a, b])
        XCTAssertEqual(planner.column(of: a.id), .left)
        XCTAssertEqual(planner.column(of: b.id), .right)
        XCTAssertEqual(planner.totalHeight(of: .left), 520, accuracy: 0.001)
        XCTAssertEqual(planner.totalHeight(of: .right), 300, accuracy: 0.001)
    }

    func testMultipleRecordsFollowTheShortestColumnTrace() {
        var planner = makePlanner()
        let (a, b, c, d) = canonicalBatch()
        planner.rebuild(with: [a, b, c, d])

        XCTAssertEqual(planner.items(in: .left).map(\.id), [a.id, c.id])
        XCTAssertEqual(planner.items(in: .right).map(\.id), [b.id, d.id])
        XCTAssertEqual(planner.totalHeight(of: .left), 362, accuracy: 0.001)
        XCTAssertEqual(planner.totalHeight(of: .right), 712, accuracy: 0.001)
        assertTotalsMatchEntries(planner)
    }

    /// 平局第一规则：累计高度相同 → 条数少的列胜出。
    /// 左列一条 100；右列 40 + 12 + 48 = 100 但两条——下一条进左列。
    func testATieGoesToTheColumnWithFewerRecords() {
        var planner = makePlanner()
        let a = MasonryLayoutItem(id: UUID(), height: 100)
        let b = MasonryLayoutItem(id: UUID(), height: 40)
        let c = MasonryLayoutItem(id: UUID(), height: 48)
        let d = MasonryLayoutItem(id: UUID(), height: 30)
        planner.rebuild(with: [a, b, c, d])
        XCTAssertEqual(planner.column(of: d.id), .left, "高度打平时条数少的左列胜出")
        XCTAssertEqual(planner.totalHeight(of: .left), 142, accuracy: 0.001) // 100 + 12 + 30：d 落进左列
        XCTAssertEqual(planner.totalHeight(of: .right), 100, accuracy: 0.001)
    }

    /// 平局第二规则：高度与条数都相同 → 固定左列（首条记录因此进左列）。
    func testAFullTieGoesToTheLeftColumn() {
        var planner = makePlanner()
        let a = MasonryLayoutItem(id: UUID(), height: 100)
        let b = MasonryLayoutItem(id: UUID(), height: 100)
        let c = MasonryLayoutItem(id: UUID(), height: 80)
        planner.rebuild(with: [a, b, c])
        XCTAssertEqual(planner.column(of: a.id), .left)
        XCTAssertEqual(planner.column(of: b.id), .right)
        XCTAssertEqual(planner.column(of: c.id), .left, "完全打平固定进左列")
    }

    func testIdenticalInputsProduceIdenticalLayouts() {
        let items = (0..<12).map {
            MasonryLayoutItem(id: UUID(), height: CGFloat(90 + ($0 * 37) % 240))
        }
        var first = makePlanner()
        first.rebuild(with: items)
        var second = makePlanner()
        second.rebuild(with: items)
        XCTAssertEqual(first, second, "相同输入必须得到完全相同的布局")
        XCTAssertEqual(first.items(in: .left).map(\.id), second.items(in: .left).map(\.id))
        XCTAssertEqual(first.items(in: .right).map(\.id), second.items(in: .right).map(\.id))
    }

    // MARK: - 顺序与身份

    func testEveryRecordAppearsExactlyOnce() {
        var planner = makePlanner()
        let items = (0..<9).map { _ in MasonryLayoutItem(id: UUID(), height: 120) }
        planner.rebuild(with: items)
        XCTAssertEqual(planner.recordCount, 9)
        let all = planner.items(in: .left) + planner.items(in: .right)
        XCTAssertEqual(all.count, 9)
        XCTAssertEqual(Set(all.map(\.id)).count, 9, "id 不得在两列之间或列内重复")
    }

    func testColumnOrderPreservesTheInputOrder() {
        var planner = makePlanner()
        let (a, b, c, d) = canonicalBatch()
        let e = MasonryLayoutItem(id: UUID(), height: 100)
        let f = MasonryLayoutItem(id: UUID(), height: 250)
        planner.rebuild(with: [a, b, c, d])
        planner.append([e, f])
        XCTAssertEqual(planner.items(in: .left).map(\.id), [a.id, c.id, e.id, f.id],
                       "列内相对顺序必须与输入一致")
    }

    /// 等高记录按平局规则交替落列（L,R,L,R…）；身份只看 UUID，
    /// 不依赖输入数组的下标。
    func testEqualHeightsAlternateAndAreIdentifiedByID() {
        var planner = makePlanner()
        let ids = (0..<5).map { _ in UUID() }
        planner.rebuild(with: ids.map { MasonryLayoutItem(id: $0, height: 180) })
        XCTAssertEqual(planner.items(in: .left).map(\.id), [ids[0], ids[2], ids[4]])
        XCTAssertEqual(planner.items(in: .right).map(\.id), [ids[1], ids[3]])
    }

    func testDuplicateIDsInBuildKeepOnlyTheFirstOccurrence() {
        var planner = makePlanner()
        let id = UUID()
        planner.rebuild(with: [MasonryLayoutItem(id: id, height: 200),
                               MasonryLayoutItem(id: id, height: 999)])
        XCTAssertEqual(planner.recordCount, 1)
        XCTAssertEqual(planner.height(of: id), 200, "重复 id 保留第一次出现")
        XCTAssertEqual(planner.totalHeight(of: .left), 200, accuracy: 0.001)
        XCTAssertEqual(planner.totalHeight(of: .right), 0)
    }

    func testAppendingAnExistingIDIsIgnoredWithoutStateDamage() {
        var planner = makePlanner()
        let a = MasonryLayoutItem(id: UUID(), height: 200)
        let b = MasonryLayoutItem(id: UUID(), height: 300)
        planner.rebuild(with: [a, b])

        let newcomer = MasonryLayoutItem(id: UUID(), height: 100)
        planner.append([MasonryLayoutItem(id: a.id, height: 999), newcomer])

        XCTAssertEqual(planner.height(of: a.id), 200, "已存在的 id 不改高度")
        XCTAssertEqual(planner.column(of: a.id), .left, "已存在的 id 不换列")
        XCTAssertEqual(planner.column(of: newcomer.id), .left, "L200 < R300 → 左")
        XCTAssertEqual(planner.recordCount, 3)
        assertTotalsMatchEntries(planner)
    }

    // MARK: - 分页追加

    func testAppendKeepsFirstBatchAssignmentsAndContinuesByHeight() {
        var planner = makePlanner()
        let (a, b, c, d) = canonicalBatch()
        planner.rebuild(with: [a, b, c, d])
        let firstBatchLeft = planner.items(in: .left).map(\.id)
        let firstBatchRight = planner.items(in: .right).map(\.id)

        let e = MasonryLayoutItem(id: UUID(), height: 100)
        let f = MasonryLayoutItem(id: UUID(), height: 250)
        planner.append([e, f])

        // 第一批的归属与顺序原样保留。
        XCTAssertEqual(Array(planner.items(in: .left).map(\.id).prefix(2)), firstBatchLeft)
        XCTAssertEqual(planner.items(in: .right).map(\.id), firstBatchRight)
        // L362 < R712 → E 进左；L474 < R712 → F 也进左。
        XCTAssertEqual(planner.items(in: .left).map(\.id), firstBatchLeft + [e.id, f.id])
        XCTAssertEqual(planner.totalHeight(of: .left), 736, accuracy: 0.001)
        assertTotalsMatchEntries(planner)
    }

    /// 连续追加多批：既有前缀永不改变、总量始终与条目直算一致。
    func testSeveralBatchesInARowStayConsistent() {
        var planner = makePlanner()
        var leftPrefix: [UUID] = []
        var rightPrefix: [UUID] = []

        let first = (0..<4).map { MasonryLayoutItem(id: UUID(), height: CGFloat(140 + $0 * 80)) }
        planner.rebuild(with: first)
        leftPrefix = planner.items(in: .left).map(\.id)
        rightPrefix = planner.items(in: .right).map(\.id)

        for batch in 0..<2 {
            let items = (0..<4).map { _ in MasonryLayoutItem(id: UUID(), height: CGFloat(110 + batch * 90)) }
            planner.append(items)

            XCTAssertEqual(Array(planner.items(in: .left).map(\.id).prefix(leftPrefix.count)),
                           leftPrefix, "第 \(batch + 2) 批不得改变既有左列归属")
            XCTAssertEqual(Array(planner.items(in: .right).map(\.id).prefix(rightPrefix.count)),
                           rightPrefix, "第 \(batch + 2) 批不得改变既有右列归属")
            assertTotalsMatchEntries(planner, "第 \(batch + 2) 批之后")
        }
        XCTAssertEqual(planner.recordCount, 12)
    }

    func testAppendingAnEmptyBatchChangesNothing() {
        var planner = makePlanner()
        planner.rebuild(with: [MasonryLayoutItem(id: UUID(), height: 180)])
        let snapshot = planner
        planner.append([])
        XCTAssertEqual(planner, snapshot, "空批次不得改变快照")
    }

    // MARK: - 测高修正

    func testHeightUpdateKeepsTheColumnAndCorrectsTheTotal() {
        var planner = makePlanner()
        let (a, b, c, d) = canonicalBatch()
        planner.rebuild(with: [a, b, c, d])

        planner.updateHeight(of: a.id, to: 700)
        XCTAssertEqual(planner.column(of: a.id), .left, "测高修正不得换列")
        XCTAssertEqual(planner.height(of: a.id), 700)
        XCTAssertEqual(planner.totalHeight(of: .left), 862, accuracy: 0.001) // 362 + 500
        assertTotalsMatchEntries(planner)
    }

    /// 后续追加使用修正后的累计——没有修正时这条会进左列。
    func testFutureAssignmentsUseTheCorrectedHeight() {
        var planner = makePlanner()
        let (a, b, c, d) = canonicalBatch()
        planner.rebuild(with: [a, b, c, d])
        planner.updateHeight(of: a.id, to: 700) // 左 362 → 862

        let h = MasonryLayoutItem(id: UUID(), height: 140)
        planner.append([h])
        XCTAssertEqual(planner.column(of: h.id), .right,
                       "L862 > R712，新记录必须去右列——决策被修正值驱动")
    }

    func testRepeatedHeightUpdatesDoNotDoubleCount() {
        var planner = makePlanner()
        let a = MasonryLayoutItem(id: UUID(), height: 200)
        let b = MasonryLayoutItem(id: UUID(), height: 300)
        planner.rebuild(with: [a, b])

        planner.updateHeight(of: a.id, to: 500)
        planner.updateHeight(of: a.id, to: 500) // 同值再更一次
        XCTAssertEqual(planner.totalHeight(of: .left), 500, accuracy: 0.001)

        planner.updateHeight(of: a.id, to: 120)
        XCTAssertEqual(planner.totalHeight(of: .left), 120, accuracy: 0.001)

        planner.updateHeight(of: UUID(), to: 99) // 不存在的 id：空操作
        XCTAssertEqual(planner.totalHeight(of: .left), 120, accuracy: 0.001)
        XCTAssertEqual(planner.recordCount, 2)
    }

    // MARK: - 删除

    /// 手算轨迹延伸：rebuild 后追加 E100、F250 → 左 [A,C,E,F]=736，右 [B,D]=712。
    private func plannerWithSixRecords() -> (MasonryColumnPlanner,
                                             a: MasonryLayoutItem, b: MasonryLayoutItem,
                                             c: MasonryLayoutItem, d: MasonryLayoutItem,
                                             e: MasonryLayoutItem, f: MasonryLayoutItem) {
        var planner = makePlanner()
        let (a, b, c, d) = canonicalBatch()
        let e = MasonryLayoutItem(id: UUID(), height: 100)
        let f = MasonryLayoutItem(id: UUID(), height: 250)
        planner.rebuild(with: [a, b, c, d])
        planner.append([e, f])
        return (planner, a, b, c, d, e, f)
    }

    func testRemovingFromTheLeftKeepsOtherAssignments() {
        let (base, a, b, c, d, e, f) = plannerWithSixRecords()
        var planner = base
        planner.remove(id: c.id)
        XCTAssertNil(planner.column(of: c.id))
        XCTAssertEqual(planner.items(in: .left).map(\.id), [a.id, e.id, f.id],
                       "其余记录归属与顺序不变")
        XCTAssertEqual(planner.items(in: .right).map(\.id), [b.id, d.id])
        XCTAssertEqual(planner.totalHeight(of: .left), 574, accuracy: 0.001) // 736 − 150 − 12
        assertTotalsMatchEntries(planner)
    }

    func testRemovingFromTheRightCorrectsItsTotal() {
        let (base, a, b, c, d, e, f) = plannerWithSixRecords()
        var planner = base
        planner.remove(id: b.id)
        XCTAssertEqual(planner.items(in: .right).map(\.id), [d.id])
        XCTAssertEqual(planner.totalHeight(of: .right), 400, accuracy: 0.001)
        XCTAssertEqual(planner.totalHeight(of: .left), 736, accuracy: 0.001, "左列不受影响")
        XCTAssertEqual(planner.recordCount, 5)
    }

    func testRemovingTheOnlyRecordZeroesTheColumn() {
        var planner = makePlanner()
        let a = MasonryLayoutItem(id: UUID(), height: 180)
        planner.rebuild(with: [a])
        planner.remove(id: a.id)
        XCTAssertEqual(planner.totalHeight(of: .left), 0, "归零必须精确，不带浮点漂移")
        XCTAssertEqual(planner.totalHeight(of: .right), 0)
        XCTAssertTrue(planner.isEmpty)
        XCTAssertEqual(planner.recordCount, 0)
    }

    func testRemovingAnUnknownIDChangesNothing() {
        var planner = makePlanner()
        let (plannerBefore, a, _, _, _, _, _) = plannerWithSixRecords()
        planner = plannerBefore
        let snapshot = planner
        planner.remove(id: UUID())
        XCTAssertEqual(planner, snapshot)
        XCTAssertEqual(planner.column(of: a.id), .left)
    }

    func testAppendingAfterRemovalStillWorks() {
        let (base, a, b, c, d, e, f) = plannerWithSixRecords()
        var planner = base
        planner.remove(id: c.id) // 左 [A,E,F]=736−150−12=574，右 [B,D]=712

        let g = MasonryLayoutItem(id: UUID(), height: 150)
        planner.append([g])
        XCTAssertEqual(planner.column(of: g.id), .left, "L574 < R712 → 左")
        XCTAssertEqual(planner.items(in: .left).map(\.id), [a.id, e.id, f.id, g.id])
        XCTAssertEqual(planner.totalHeight(of: .left), 736, accuracy: 0.001)
        XCTAssertEqual(planner.column(of: d.id), .right)
        assertTotalsMatchEntries(planner)
    }

    /// 删除按 id 而不是下标：删掉左列头部，其余记录的归属不受影响。
    func testRemovalIsByIdentityNotByIndex() {
        var planner = makePlanner()
        let (a, b, c, d) = canonicalBatch()
        planner.rebuild(with: [a, b, c, d])
        planner.remove(id: a.id)
        XCTAssertEqual(planner.column(of: c.id), .left)
        XCTAssertEqual(planner.column(of: b.id), .right)
        XCTAssertEqual(planner.column(of: d.id), .right)
        XCTAssertEqual(planner.items(in: .left).map(\.id), [c.id])
    }

    // MARK: - 重建

    func testRebuildReplacesTheResultSet() {
        var planner = makePlanner()
        let (a, b, c, d) = canonicalBatch()
        planner.rebuild(with: [a, b, c, d])

        let news = (0..<3).map { _ in MasonryLayoutItem(id: UUID(), height: 160) }
        planner.rebuild(with: news)

        for old in [a, b, c, d] {
            XCTAssertNil(planner.column(of: old.id), "重建后旧结果不得残留")
        }
        XCTAssertEqual(planner.recordCount, 3)
        XCTAssertEqual(Set((planner.items(in: .left) + planner.items(in: .right)).map(\.id)),
                       Set(news.map(\.id)))
        assertTotalsMatchEntries(planner)
    }

    /// 宽度变化 → 调用方按新宽度重算高度后重建：同样的 id 可以得到不同的列。
    func testRebuildWithNewWidthHeightsRethinksTheLayout() {
        var planner = makePlanner()
        let ids = (0..<3).map { _ in UUID() }

        // 窄屏：A500 → 左；B100 → 右；C100 → 右（L500 > R100）。
        planner.rebuild(with: [
            MasonryLayoutItem(id: ids[0], height: 500),
            MasonryLayoutItem(id: ids[1], height: 100),
            MasonryLayoutItem(id: ids[2], height: 100),
        ])
        XCTAssertEqual(planner.column(of: ids[2]), .right)

        // 宽屏：同一批 id，卡片变矮 → C 翻到左列。
        planner.rebuild(with: [
            MasonryLayoutItem(id: ids[0], height: 100),
            MasonryLayoutItem(id: ids[1], height: 500),
            MasonryLayoutItem(id: ids[2], height: 100),
        ])
        XCTAssertEqual(planner.column(of: ids[2]), .left, "新宽度下的布局由新高度决定")
        assertTotalsMatchEntries(planner)
    }

    // MARK: - 防御处理

    /// NaN / ±∞ / 负数 → 0：内容不丢（记录仍然出现），状态不被污染。
    func testInvalidHeightsAreSanitizedInsteadOfPoisoningTheLayout() {
        let nan = MasonryLayoutItem(id: UUID(), height: .nan)
        let inf = MasonryLayoutItem(id: UUID(), height: .infinity)
        let negative = MasonryLayoutItem(id: UUID(), height: -80)
        XCTAssertEqual(nan.height, 0)
        XCTAssertEqual(inf.height, 0)
        XCTAssertEqual(negative.height, 0)

        var planner = makePlanner()
        planner.rebuild(with: [nan, inf, negative])
        XCTAssertEqual(planner.recordCount, 3, "无效高度的记录仍然要出现")
        for column in [MasonryColumn.left, .right] {
            XCTAssertFalse(planner.totalHeight(of: column).isNaN)
            XCTAssertFalse(planner.totalHeight(of: column).isInfinite)
        }
        // 全 0 高度：等高平局规则照常工作（L,R,L 交替），累计保持可用。
        XCTAssertEqual(planner.items(in: .left).map(\.id), [nan.id, negative.id])
        XCTAssertEqual(planner.items(in: .right).map(\.id), [inf.id])
        assertTotalsMatchEntries(planner)
    }

    func testZeroHeightIsValidAndTieRulesStillWork() {
        var planner = makePlanner()
        let a = MasonryLayoutItem(id: UUID(), height: 0)
        let b = MasonryLayoutItem(id: UUID(), height: 0)
        planner.rebuild(with: [a, b])
        XCTAssertEqual(planner.totalHeight(of: .left), 0)
        XCTAssertEqual(planner.totalHeight(of: .right), 0)

        let c = MasonryLayoutItem(id: UUID(), height: 0)
        planner.append([c])
        XCTAssertEqual(planner.column(of: c.id), .left, "全 0 打平 → 条数规则 → 左列")
        assertTotalsMatchEntries(planner)
    }

    func testExtremeHeightsClampToTheCeilingWithoutOverflow() {
        let huge = MasonryLayoutItem(id: UUID(), height: .greatestFiniteMagnitude)
        XCTAssertEqual(huge.height, MasonryLayoutItem.heightCeiling)

        var planner = makePlanner()
        planner.rebuild(with: [huge, MasonryLayoutItem(id: UUID(), height: .greatestFiniteMagnitude)])
        for column in [MasonryColumn.left, .right] {
            XCTAssertEqual(planner.totalHeight(of: column),
                           MasonryLayoutItem.heightCeiling, accuracy: 0.001)
            XCTAssertFalse(planner.totalHeight(of: column).isInfinite,
                           "两条极端高度相加不得把累计冲成无穷")
        }
        XCTAssertEqual(planner.recordCount, 2)
    }

    /// 负间距同样防御：退成 0，不产生「越加越矮」的列。
    func testNegativeSpacingIsClampedToZero() {
        let planner = MasonryColumnPlanner(interItemSpacing: -6)
        var mutable = planner
        mutable.rebuild(with: [MasonryLayoutItem(id: UUID(), height: 100),
                               MasonryLayoutItem(id: UUID(), height: 100)])
        XCTAssertEqual(mutable.totalHeight(of: .left), 100, accuracy: 0.001)
        XCTAssertEqual(mutable.totalHeight(of: .right), 100, accuracy: 0.001)
    }
}
