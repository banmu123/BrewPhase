import XCTest
@testable import BrewPhase

/// 三空间首页的两条契约：堆叠几何与选卡规则。
///
/// 这一页的视觉结论不靠截图断言（截图只证明「这一次长这样」），而是把这些
/// 能算出来的东西钉住：三列必须同构、Coffee 不许比别的空间多一张、空空间
/// 也占同样的一格。
final class WorkspaceHomeTests: XCTestCase {

    override func setUp() {
        super.setUp()
        LanguageManager.pinForTesting(.simplifiedChinese)
    }

    // MARK: - 堆叠几何

    func testVisibleCountTreatsEverySpaceTheSame() {
        // 空空间也画一张（空态卡），否则三列的起点会不齐。
        XCTAssertEqual(WorkspaceStackLayout.visibleCount(itemCount: 0), 1)
        XCTAssertEqual(WorkspaceStackLayout.visibleCount(itemCount: 1), 1)
        XCTAssertEqual(WorkspaceStackLayout.visibleCount(itemCount: 2), 2)
        XCTAssertEqual(WorkspaceStackLayout.visibleCount(itemCount: 3), 3)
        // 第四张之后不再往列里塞：堆叠是视觉，不是列表。
        XCTAssertEqual(WorkspaceStackLayout.visibleCount(itemCount: 9), 3)
        XCTAssertEqual(WorkspaceStackLayout.visibleLimit, 3)
    }

    func testDeeperCardsDropLowerAndShiftRight() {
        // 后卡必须比前卡更低、更偏右：这是「叠放」与「并排」的全部区别。
        XCTAssertLessThan(WorkspaceStackLayout.drop(depth: 0), WorkspaceStackLayout.drop(depth: 1))
        XCTAssertLessThan(WorkspaceStackLayout.drop(depth: 1), WorkspaceStackLayout.drop(depth: 2))
        XCTAssertLessThan(WorkspaceStackLayout.shift(depth: 0), WorkspaceStackLayout.shift(depth: 1))

        XCTAssertEqual(WorkspaceStackLayout.drop(depth: 0), 0)
        XCTAssertEqual(WorkspaceStackLayout.shift(depth: 0), 0)
    }

    func testBackCardsKeepFullWidthSoTheirEdgeActuallyShows() {
        // 回归护栏：后卡曾经靠「两侧各内收 4pt」做台阶，但卡片按宽高比定高，
        // 内收 4pt 会让它比前卡矮 2×4÷0.62 ≈ 13pt，而它只下探 7pt——
        // 后卡整张躲进前卡背后，堆叠看起来只有一张卡。现在宽度不变、只错位。
        XCTAssertEqual(WorkspaceStackLayout.shift(depth: 0), 0)
        XCTAssertGreaterThan(WorkspaceStackLayout.shift(depth: 1), 0)
        // 台阶要够一条看得见的边。
        XCTAssertGreaterThanOrEqual(WorkspaceStackLayout.drop(depth: 1), 3)
    }

    func testStackReservesTheHeightItUses() {
        // 错位是视觉，不该让下一段内容替它买单：底部的让位必须等于最深那层
        // 的下探量。
        for count in 0...5 {
            let deepest = WorkspaceStackLayout.visibleCount(itemCount: count) - 1
            XCTAssertEqual(WorkspaceStackLayout.stackBottomPadding(itemCount: count),
                           WorkspaceStackLayout.drop(depth: deepest))
        }
    }

    func testDeeperCardsFadeButNeverDisappear() {
        // 后卡只是退后，不是消失：透明度必须仍然可读。
        XCTAssertEqual(WorkspaceStackLayout.opacity(depth: 0), 1)
        XCTAssertGreaterThan(WorkspaceStackLayout.opacity(depth: 1), 0.8)
        XCTAssertGreaterThan(WorkspaceStackLayout.opacity(depth: 2), 0.7)
        XCTAssertGreaterThan(WorkspaceStackLayout.opacity(depth: 9),
                             WorkspaceStackLayout.opacity(depth: 2) - 0.001)
    }

    // MARK: - 选卡规则

    func testEverySpaceIsCappedAtTheSameNumberOfCards() {
        let beans = (0..<6).map { index in
            WorkspaceCard(bean: bean("豆 \(index)", at: Double(index)))
        }
        let records = (0..<6).map { index in
            WorkspaceCard(record: Record(carrier: .text,
                                         title: "记录 \(index)",
                                         createdAt: Date(timeIntervalSince1970: Double(index))))
        }

        XCTAssertEqual(WorkspaceHomeFeed.cards(from: beans).count, WorkspaceHomeFeed.cardLimit)
        XCTAssertEqual(WorkspaceHomeFeed.cards(from: records).count, WorkspaceHomeFeed.cardLimit)
        XCTAssertEqual(WorkspaceHomeFeed.cardLimit, WorkspaceStackLayout.visibleLimit)
    }

    func testNewestWinsWithinTheSameKind() {
        let older = WorkspaceCard(bean: bean("旧", at: 10))
        let newer = WorkspaceCard(bean: bean("新", at: 20))

        // 同一种内容里，时间最新的排在最前（第一轮「每类一张」取的就是它）。
        let picked = WorkspaceHomeFeed.cards(from: [older, newer])
        XCTAssertEqual(picked.first?.title, "新")
        // 名额还有，第二张按时间补齐——同一种内容只是不重复占第一轮。
        XCTAssertEqual(picked.map(\.title), ["新", "旧"])
    }

    func testCoffeeShowsOneOfEachKindBeforeDoublingUp() {
        // 一包豆、一杯冲煮、一次风味：三张都要有。首页的 Coffee 列因此是
        // 「这个空间里有什么」，不是「三包豆」。
        let bean = bean("耶加", at: 30)
        let brew = Brew(date: Date(timeIntervalSince1970: 20), method: "V60", coffeeG: 15, waterG: 240, bean: bean)
        let tasting = Tasting(date: Date(timeIntervalSince1970: 10), score: 4, bean: bean)

        let picked = WorkspaceHomeFeed.cards(
            from: [WorkspaceCard(bean: bean),
                   WorkspaceCard(brew: brew),
                   WorkspaceCard(tasting: tasting)]
        )

        XCTAssertEqual(picked.count, 3)
        XCTAssertEqual(picked.first?.kind, .bean)
        XCTAssertTrue(picked.contains { $0.kind == .brew })
        XCTAssertTrue(picked.contains { $0.kind == .tasting })
    }

    func testRecordsDoNotGetFilledUpByOneCarrier() {
        // 三条链接 + 一张图片：先各来一个载体，再按时间补。否则 Records 列
        // 会被「最新那三条链接」占满，看不出这个空间还能装什么。
        let links = (0..<3).map { index in
            WorkspaceCard(record: Record(carrier: .link,
                                         title: "链接 \(index)",
                                         createdAt: Date(timeIntervalSince1970: Double(30 - index))))
        }
        let image = WorkspaceCard(record: Record(carrier: .image,
                                                 title: "照片",
                                                 createdAt: Date(timeIntervalSince1970: 1)))

        let picked = WorkspaceHomeFeed.cards(from: links + [image])

        XCTAssertEqual(picked.count, 3)
        XCTAssertTrue(picked.contains { $0.kind == .record(.image) })
        XCTAssertEqual(picked.filter { $0.kind == .record(.link) }.count, 2)
    }

    func testEmptyFeedProducesNoCards() {
        // 选卡本身不造空态卡——空态由视图决定（一张同尺寸的占位卡）。
        XCTAssertTrue(WorkspaceHomeFeed.cards(from: []).isEmpty)
    }

    func testOrderingIsStableForEqualTimestamps() {
        // 同一时刻的两张卡不能每次刷新都换位置，否则首页会自己抖。
        let first = WorkspaceCard(bean: bean("A", at: 100))
        let second = WorkspaceCard(bean: bean("B", at: 100))

        let forward = WorkspaceHomeFeed.cards(from: [first, second]).map(\.title)
        let backward = WorkspaceHomeFeed.cards(from: [second, first]).map(\.title)
        XCTAssertEqual(forward, backward)
    }

    // MARK: - 投影不改数据

    func testCardProjectsButNeverMutatesTheRecord() {
        let record = Record(carrier: .text, title: "原文标题", note: "正文")
        let card = WorkspaceCard(record: record)

        XCTAssertEqual(card.title, "原文标题")
        XCTAssertEqual(card.target, .record(record.id))
        XCTAssertEqual(record.title, "原文标题")
        XCTAssertEqual(record.note, "正文")
    }

    func testCanvasCardCarriesIdentityAndTimestamp() {
        let canvas = Canvas(name: "想法", note: "说明", createdAt: Date(timeIntervalSince1970: 5))
        let card = WorkspaceCard(canvas: canvas)

        XCTAssertEqual(card.title, "想法")
        XCTAssertEqual(card.target, .canvas(canvas.id))
        XCTAssertEqual(card.timestamp, canvas.createdAt)
        // 画布封面不是图片文件：首页要用节点分布画，不能编一个文件名。
        XCTAssertNil(card.imagePath)
    }

    func testUntitledRecordFallsBackToAReadableLabel() {
        let record = Record(carrier: .text)
        XCTAssertEqual(WorkspaceCard(record: record).title, L("未命名记录"))
    }

    // MARK: - 空态

    func testEmptyCardTakesASpaceSlotButOpensNothing() {
        let empty = WorkspaceCard.empty(for: .canvas)
        XCTAssertEqual(empty.kind, .empty)
        XCTAssertEqual(empty.title, L("还没有画布"))
        XCTAssertEqual(empty.target, .none)
        // 空态卡与内容卡同尺寸：堆叠几何由 `visibleCount` 统一给出。
        XCTAssertEqual(WorkspaceStackLayout.visibleCount(itemCount: 1), 1)
    }

    // MARK: - 问候

    func testGreetingCoversEveryHourWithoutGaps() {
        XCTAssertEqual(WorkspaceGreeting.at(hour: 5), .morning)
        XCTAssertEqual(WorkspaceGreeting.at(hour: 11), .morning)
        XCTAssertEqual(WorkspaceGreeting.at(hour: 12), .afternoon)
        XCTAssertEqual(WorkspaceGreeting.at(hour: 17), .afternoon)
        XCTAssertEqual(WorkspaceGreeting.at(hour: 18), .evening)
        XCTAssertEqual(WorkspaceGreeting.at(hour: 23), .evening)
        // 凌晨归到晚上，不给自己造第四个称呼。
        XCTAssertEqual(WorkspaceGreeting.at(hour: 0), .evening)
        XCTAssertEqual(WorkspaceGreeting.at(hour: 4), .evening)
    }

    func testEverySpaceHasItsOwnAccentAndEmptyLine() {
        // 三个空间的辅助色必须互不相同（否则「认得出」这件事没发生），
        // 空态文案也必须各说各的。
        XCTAssertNotEqual(AppTab.coffee.accent, AppTab.records.accent)
        XCTAssertNotEqual(AppTab.records.accent, AppTab.canvas.accent)
        XCTAssertNotEqual(AppTab.coffee.accent, AppTab.canvas.accent)

        let emptyTitles = AppTab.allCases.map(\.emptyTitle)
        XCTAssertEqual(Set(emptyTitles).count, AppTab.allCases.count)
    }

    // MARK: - 一级导航

    func testRouteComparesSpacesNotJustKind() {
        // 换空间要真的换页；同一页重复点击不该重建视图树。
        XCTAssertEqual(AppRoute.home, .home)
        XCTAssertEqual(AppRoute.space(.coffee), .space(.coffee))
        XCTAssertNotEqual(AppRoute.space(.coffee), .space(.records))
        XCTAssertNotEqual(AppRoute.space(.coffee), .home)
    }

    func testAllThreeSpacesStillExistAsTopLevelDestinations() {
        // 删掉 Tab Bar 不等于删掉空间：三个都还在，且顺序固定。
        XCTAssertEqual(AppTab.allCases, [.coffee, .records, .canvas])
    }

    // MARK: - 构造夹具

    /// `Bean` 的 `createdAt` 由 init 写成「现在」；要一条可控的时间线就事后改。
    private func bean(_ name: String, at seconds: TimeInterval) -> Bean {
        let bean = Bean(name: name)
        bean.createdAt = Date(timeIntervalSince1970: seconds)
        return bean
    }
}
