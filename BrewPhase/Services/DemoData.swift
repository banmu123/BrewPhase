import Foundation
import SwiftData

/// Sample coffee, for looking at the app rather than using it.
///
/// Installed only when the app is launched with `-BrewPhaseDemo yes` *and* the
/// store is empty, so it can never overwrite real records. It exists so the UI,
/// the phase engine and the ranking can be inspected on a simulator with a
/// realistic cellar in front of them.
enum DemoData {

    static let launchArgument = "-BrewPhaseDemo"

    static var isRequested: Bool {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: launchArgument) else { return false }
        // `simctl launch ... -BrewPhaseDemo yes` passes a value; a bare flag counts too.
        let next = args.indices.contains(index + 1) ? args[index + 1] : "yes"
        return next != "no" && next != "false" && next != "0"
    }

    /// - Returns: true when sample data was installed.
    @discardableResult
    static func installIfRequested(context: ModelContext, today: Date = Date()) -> Bool {
        guard isRequested else { return false }
        let existing = (try? context.fetchCount(FetchDescriptor<Bean>())) ?? 0
        guard existing == 0 else {
            AppLog.store.info("demo data skipped: store already has \(existing) bean(s)")
            return false
        }
        install(context: context, today: today)
        AppLog.store.info("demo data installed")
        return true
    }

    /// 库里是否已有示例数据（「更多 → 数据 → 示例数据」开关的数据真相）。
    static func hasInstalled(context: ModelContext) -> Bool {
        let count = (try? context.fetchCount(
            FetchDescriptor<Bean>(predicate: #Predicate { $0.isSample })
        )) ?? 0
        return count > 0
    }

    /// 删除全部示例数据：只碰带 `isSample` 标记的豆子，它们的冲煮、风味与
    /// 提醒随级联一起走；真实记录不带标记，永远不受影响。
    ///
    /// - Returns: true when something was actually deleted.
    @discardableResult
    static func removeInstalled(context: ModelContext) -> Bool {
        let samples = (try? context.fetch(
            FetchDescriptor<Bean>(predicate: #Predicate { $0.isSample })
        )) ?? []
        guard !samples.isEmpty else { return false }
        for bean in samples {
            context.delete(bean)
        }
        do {
            try context.save()
            AppLog.store.info("sample data removed: \(samples.count) bean(s)")
            return true
        } catch {
            AppLog.store.error("sample data removal failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
            return false
        }
    }

    /// Six bags chosen so that every phase is represented at least once — one
    /// just roasted, one opening, two in their window, one past it and still
    /// nearly full — plus the awkward case: a bag with no roast date at all.
    static func install(context: ModelContext, today: Date = Date()) {
        func day(_ offset: Int) -> Date {
            DateMath.add(days: -offset, to: today)
        }
        func brewDay(_ offset: Int, hour: Int = 8) -> Date {
            DateMath.calendar.date(bySettingHour: hour, minute: 30, second: 0,
                                   of: DateMath.add(days: -offset, to: today)) ?? today
        }

        // 1 — the headline bag: light roast, mid-window, nearly finished.
        let guji = Bean(
            name: "Ethiopia Guji",
            roaster: L("启程咖啡"),
            origin: L("埃塞俄比亚 · Guji"),
            process: L("水洗"),
            roastLevel: .light,
            roastDate: day(16),
            purchaseDate: day(12),
            openDate: day(10),
            weightG: 200,
            remainingG: 86,
            price: 138,
            channel: L("线下门店"),
            flavorTags: ["Jasmine", "Mandarin", "Honey"],
            notes: L("手冲首选，V60 闷蒸 30 秒。")
        )
        context.insert(guji)
        let gujiBrews: [(Int, Double, Double, Double, Int, Int, [String], String)] = [
            (13, 18, 300, 93, 155, 4, ["Mandarin"], "刚开袋，酸质冲一点"),
            (9,  18, 300, 92, 150, 5, ["Jasmine", "Mandarin"], "花香出来了，很干净"),
            (4,  18, 300, 92, 148, 5, ["Honey", "Mandarin"], "目前最平衡的一杯"),
        ]
        for (offset, dose, water, temp, seconds, score, tags, note) in gujiBrews {
            let brew = Brew(date: brewDay(offset), method: "V60", grinder: L("司令官 C40"),
                            grindSize: L("22 格"), waterTemp: temp, coffeeG: dose, waterG: water,
                            timeSeconds: seconds, score: score,
                            acidity: score - 1, sweetness: score,
                            flavorTags: tags, notes: L(note), bean: guji)
            context.insert(brew)
            // `brewID` 不能省：`Tasting.source == .brew` 是在说「这条是某次冲煮的
            // 附笔」，而不带着是哪一次的话，这个说法就没法兑现——删掉那次冲煮时
            // 这条风味记录不会被一起带走，检索也会把它当成一件独立发生过的事。
            // `Brew.makeTasting()` 一直是这么做的，这两条手工数据漏了。
            let tasting = Tasting(date: brewDay(offset), dayAfterRoast: 16 - offset,
                                  flavorTags: tags, score: score, notes: L(note),
                                  source: .brew, brewID: brew.id, bean: guji)
            context.insert(tasting)
        }

        // 1.5 — 一杯「不太满意」的最近记录。
        //
        // 刻意让最新那一杯比前面三次短（2:08 对 2:28–2:35）、酸高甜低、口感偏薄：
        // 这样豆子详情页上的「本次表现 / 下一杯建议」和「问一问」里的诊断都真的
        // 有东西可说（可能萃取不足 → 磨细一档），而不是只能看到「没有明显异常」。
        // 演示数据要能示范功能，否则第一次打开 App 的人根本不知道它做得到这件事。
        let roughCup = Brew(
            date: brewDay(0), method: "V60", grinder: L("司令官 C40"),
            grindSize: L("22 格"), waterTemp: 92, coffeeG: 18, waterG: 300,
            timeSeconds: 128, score: 3,
            acidity: 5, sweetness: 2, bitterness: 2, body: 2,
            flavorTags: ["Mandarin"], notes: L("有点酸，尾段薄"), bean: guji
        )
        context.insert(roughCup)
        context.insert(Tasting(
            date: brewDay(0), dayAfterRoast: 16, flavorTags: ["Mandarin"],
            score: 3, notes: L("有点酸，尾段薄"),
            source: .brew, brewID: roughCup.id, bean: guji
        ))

        // 1.7 — 一条手动风味记录。时间线上两种来源都要有例子：冲煮带出的和
        // 吧台随手记的，来源标识才看得出差别。
        context.insert(Tasting(
            date: brewDay(6), dayAfterRoast: 10, flavorTags: ["Jasmine"],
            score: 4, notes: L("闻着比喝着更香"), source: .manual, bean: guji
        ))

        // 2 — just out of the exhaust window, so the vocabulary's middle state is
        // on screen too: for a light roast the Opening days are 3–6.
        let colombia = Bean(
            name: "Colombia Pink Bourbon",
            roaster: "M2M",
            origin: L("哥伦比亚 · 慧兰"),
            process: L("厌氧日晒"),
            roastLevel: .light,
            roastDate: day(5),
            purchaseDate: day(5),
            weightG: 250,
            remainingG: 124,
            price: 158,
            channel: L("网店"),
            flavorTags: ["Strawberry", "Rose"],
            notes: L("闻起来发酵感很足。")
        )
        context.insert(colombia)

        // 3 — still resting. Should never be today's suggestion.
        let kenya = Bean(
            name: "Kenya AA",
            roaster: L("有容"),
            origin: L("肯尼亚 · Nyeri"),
            process: L("水洗"),
            roastLevel: .light,
            roastDate: day(2),
            purchaseDate: day(1),
            weightG: 250,
            remainingG: 200,
            price: 128,
            flavorTags: ["Grape", "Brown Sugar"],
            notes: L("先放着养一养。")
        )
        context.insert(kenya)

        // 4 — past its window and still 80% full: the case the priority engine
        // exists for.
        let brazil = Bean(
            name: "Brazil Cerrado",
            roaster: L("启程咖啡"),
            origin: L("巴西 · Cerrado"),
            process: L("半日晒"),
            roastLevel: .mediumDark,
            roastDate: day(30),
            purchaseDate: day(28),
            openDate: day(25),
            weightG: 250,
            remainingG: 210,
            price: 98,
            flavorTags: ["Chocolate", "Caramel"],
            notes: L("深一点，做奶咖不错。")
        )
        context.insert(brazil)
        let brazilBrew = Brew(date: brewDay(12), method: L("意式浓缩"), grinder: "Eureka Mignon",
                              grindSize: "3.2", waterTemp: 93, coffeeG: 18, waterG: 36,
                              timeSeconds: 28, score: 2, bitterness: 4, notes: L("有点苦了"),
                              bean: brazil)
        context.insert(brazilBrew)
        context.insert(Tasting(date: brewDay(12), dayAfterRoast: 18, flavorTags: ["Chocolate"],
                               score: 2, notes: L("入口有点闷"), source: .brew,
                               brewID: brazilBrew.id, bean: brazil))

        // 5 — an espresso blend, which has a different window entirely.
        let house = Bean(
            name: "House Espresso",
            roaster: L("启程咖啡"),
            origin: L("拼配"),
            process: L("拼配"),
            roastLevel: .espressoBlend,
            roastDate: day(9),
            purchaseDate: day(9),
            openDate: day(6),
            weightG: 1000,
            remainingG: 380,
            price: 268,
            flavorTags: ["Caramel", "Chocolate"],
            notes: L("每天一杯奶咖的主力。")
        )
        context.insert(house)

        // 6 — the awkward record: no roast date, so the app has to say "I can't
        // tell yet" instead of guessing.
        let geisha = Bean(
            name: "Panama Geisha",
            roaster: L("朋友送的"),
            origin: L("巴拿马 · Boquete"),
            process: L("水洗"),
            roastLevel: .light,
            roastDate: nil,
            weightG: 100,
            remainingG: 100,
            notes: L("袋子上的烘焙日期磨掉了，等确认一下。")
        )
        context.insert(geisha)

        // 7 — 一包已经喝完的豆子。首页的「已喝完」分组、以及「恢复到在喝」
        // 这条路，只有袋子上真的挂着 finished 状态才看得见。刻意留下 40g：
        // 恢复只恢复状态、不凭空造库存，「保留当前剩余量」得有一个能看见的例子。
        let finished = Bean(
            name: "Rwanda Nyungwe",
            roaster: L("启程咖啡"),
            origin: L("卢旺达 · Nyungwe"),
            process: L("水洗"),
            roastLevel: .medium,
            roastDate: day(52),
            purchaseDate: day(50),
            openDate: day(46),
            weightG: 200,
            remainingG: 40,
            price: 118,
            flavorTags: ["Black Tea"],
            notes: L("味道淡了，收进柜子当纪念。")
        )
        context.insert(finished)
        finished.markFinished()

        // 示例标记：这些豆子全部来自「示例数据」，关闭设置里的开关时可整批
        // 移除（冲煮、风味与提醒随级联一起走）。真实记录不带标记，永远不受
        // 该开关影响——这是「关闭即清空示例」与「误删真实数据」之间的分界线。
        for bean in [guji, colombia, kenya, brazil, house, geisha, finished] {
            bean.isSample = true
        }

        do {
            try context.save()
        } catch {
            // 演示数据只在调试启动时安装；失败就说清楚，回滚掉一半的插入，
            // 免得界面拿到一堆没落库的对象。
            AppLog.store.error("demo data save failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
        }
    }
}
