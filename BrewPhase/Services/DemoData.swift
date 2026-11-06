import Foundation
import SwiftData
import UIKit

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
    ///
    /// 三类都看：用户可能只把示例豆删掉了，记录与画布还在；只数豆子会让开关
    /// 显示「关」，而点开记录页仍然能看到示例内容。
    static func hasInstalled(context: ModelContext) -> Bool {
        let beans = (try? context.fetchCount(
            FetchDescriptor<Bean>(predicate: #Predicate { $0.isSample })
        )) ?? 0
        if beans > 0 { return true }
        let records = (try? context.fetchCount(
            FetchDescriptor<Record>(predicate: #Predicate { $0.isSample })
        )) ?? 0
        if records > 0 { return true }
        let canvases = (try? context.fetchCount(
            FetchDescriptor<Canvas>(predicate: #Predicate { $0.isSample })
        )) ?? 0
        return canvases > 0
    }

    /// 库里所有带示例标记的豆子。
    ///
    /// 单独暴露出来，是为了让调用方在**删除之前**拿到它们——系统里的待送达
    /// 提醒只认豆子 ID，删完再查就查不到该清谁了。
    static func sampleBeans(context: ModelContext) -> [Bean] {
        (try? context.fetch(
            FetchDescriptor<Bean>(predicate: #Predicate { $0.isSample })
        )) ?? []
    }

    /// 删除全部示例数据：只碰带 `isSample` 标记的豆子、记录与画布，它们的
    /// 冲煮、风味与提醒随级联一起走；真实记录不带标记，永远不受影响。
    ///
    /// - Returns: true when something was actually deleted.
    @discardableResult
    static func removeInstalled(context: ModelContext) -> Bool {
        let samples = sampleBeans(context: context)
        let records = (try? context.fetch(
            FetchDescriptor<Record>(predicate: #Predicate { $0.isSample })
        )) ?? []
        let canvases = (try? context.fetch(
            FetchDescriptor<Canvas>(predicate: #Predicate { $0.isSample })
        )) ?? []
        guard !samples.isEmpty || !records.isEmpty || !canvases.isEmpty else { return false }

        // 媒体文件的名先收好：落库成功之后才删盘，顺序与 RecordsView.delete 一致。
        var imageFiles: [String] = []
        var videoFiles: [String] = []
        for record in records {
            if record.carrier == .video, let media = record.mediaPath {
                videoFiles.append(media)
            } else if let media = record.mediaPath {
                imageFiles.append(media)
            }
            if let preview = record.previewPath { imageFiles.append(preview) }
        }

        for bean in samples { context.delete(bean) }
        for record in records { context.delete(record) }
        for canvas in canvases { context.delete(canvas) }
        do {
            try context.save()
            for file in imageFiles { ImageStore.shared.delete(file) }
            for file in videoFiles { MediaStore.shared.delete(file) }
            AppLog.store.info(
                "sample data removed: \(samples.count) bean(s), \(records.count) record(s), \(canvases.count) canvas(es)"
            )
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

        installSampleRecords(context: context, today: today)

        do {
            try context.save()
        } catch {
            // 演示数据只在调试启动时安装；失败就说清楚，回滚掉一半的插入，
            // 免得界面拿到一堆没落库的对象。
            AppLog.store.error("demo data save failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
        }
    }

    // MARK: - 示例记录与画布
    //
    // 链接这几条用的是**真实存在的内容**（GitHub 上的开源仓库、B 站官方 MV、
    // YouTube 上的 Blender 短片、X 上第一条推文），元数据在安装时静态写好，
    // 不联网。这样列表里能同时看到视频卡、仓库卡、帖子卡与普通网页卡；
    // 点进 B 站那条还能真的把官方播放器拉起来。
    // 图片与视频示例在安装时**本机生成**（两色渐变 + 一行留白），带
    // `isSample`，随「示例数据」开关与记录一起删（`removeInstalled` 会
    // 连媒体文件一起清）。它们存在的唯一理由：两列瀑布流的原始比例、
    // 横竖混排与翻页，只有真的图片才看得出问题。数量 ≥ 两页（20 条），
    // 滚动到底就能验证分页。

    static func installSampleRecords(context: ModelContext, today: Date = Date()) {
        func day(_ offset: Int) -> Date { DateMath.add(days: -offset, to: today) }

        let allTags = (try? context.fetch(FetchDescriptor<RecordTag>())) ?? []
        func tag(_ name: String) -> RecordTag? {
            let localized = L(name)
            return allTags.first { $0.name == localized || $0.name == name }
                ?? allTags.first { $0.name.caseInsensitiveCompare(localized) == .orderedSame }
        }
        func tags(_ names: [String]) -> [RecordTag] { names.compactMap { tag($0) } }

        /// 一条链接示例：平台身份走真正的识别器，元数据按平台实际情况写死。
        func link(_ urlString: String,
                  title: String,
                  summary: String,
                  author: String,
                  note: String,
                  thumbnail: String = "",
                  stars: Int = 0,
                  forks: Int = 0,
                  issues: Int = 0,
                  language: String = "",
                  license: String = "",
                  createdAt: Date) -> Record {
            let record = Record(carrier: .link, title: title, note: L(note),
                                urlString: urlString, createdAt: createdAt, isSample: true)
            if let url = URL(string: urlString) {
                record.adopt(LinkResolver.match(url))
            }
            record.summary = summary
            record.authorName = author
            record.sourceName = record.provider.displayName.isEmpty
                ? (record.linkHost ?? "")
                : record.provider.displayName
            record.thumbnailURLString = thumbnail
            record.repositoryStars = stars
            record.repositoryForks = forks
            record.repositoryIssues = issues
            record.repositoryLanguage = language
            record.repositoryLicense = license
            // 示例数据不联网下载封面，只记录地址：第一次打开详情页时补一次，
            // 之后卡片和详情用的都是本地缓存。
            record.metadataStatus = .partial
            return record
        }

        /// 生成一张两色渐变的示例图，存进 ImageStore，返回文件名。
        /// 尺寸故意横竖不一：瀑布流的原始比例要拿真的比例验证。
        func sampleImage(_ colors: [UIColor], width: CGFloat, height: CGFloat) -> String? {
            let format = UIGraphicsImageRendererFormat.default()
            format.scale = 1
            let image = UIGraphicsImageRenderer(size: CGSize(width: width, height: height),
                                                format: format).image { _ in
                guard let context = UIGraphicsGetCurrentContext(),
                      let gradient = CGGradient(
                        colorsSpace: CGColorSpaceCreateDeviceRGB(),
                        colors: colors.map(\.cgColor) as CFArray,
                        locations: [0, 1]) else { return }
                context.drawLinearGradient(gradient,
                                           start: .zero,
                                           end: CGPoint(x: width, y: height),
                                           options: [])
            }
            return try? ImageStore.shared.save(image)
        }

        func image(_ note: String, _ colors: [UIColor], width: CGFloat, height: CGFloat,
                   createdAt: Date) -> Record {
            Record(carrier: .image, note: L(note),
                   mediaPath: sampleImage(colors, width: width, height: height),
                   createdAt: createdAt, isSample: true)
        }

        let records: [Record] = [
            link("https://github.com/NiftyTreeStudios/Bean-Juice",
                 title: "NiftyTreeStudios/Bean-Juice",
                 summary: "A simple app for coffee brewing recipes.",
                 author: "NiftyTreeStudios",
                 note: "本地优先的做法值得借鉴：数据先落在自己的机器上。",
                 thumbnail: "https://avatars.githubusercontent.com/u/29564181?v=4",
                 stars: 30, forks: 7, issues: 22,
                 language: "Swift", license: "MIT",
                 createdAt: day(3)),

            link("https://standartmag.com",
                 title: "Standart",
                 summary: "",
                 author: "",
                 note: "关于「浅烘是不是一种审美霸权」的讨论。读完还是觉得：好喝比正确重要。",
                 createdAt: day(6)),

            link("https://www.youtube.com/watch?v=jNQXAC9IVRw",
                 title: "Me at the zoo",
                 summary: "The first video on YouTube.",
                 author: "jawed",
                 note: "互联网上的第一条视频。",
                 thumbnail: "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg",
                 createdAt: day(9)),

            link("https://www.bilibili.com/video/BV1GJ411x7h7",
                 title: "【官方 MV】Never Gonna Give You Up - Rick Astley", // i18n:data
                 summary: "",
                 author: "Rick Astley",
                 note: "十年前的老歌，画质修得真好。",
                 thumbnail: "https://i0.hdslb.com/bfs/archive/5242750857121e05146d5d5b13a47a2a6dd36e98.jpg",
                 createdAt: day(11)),

            link("https://x.com/jack/status/20",
                 title: "",
                 summary: "just setting up my twttr",
                 author: "jack",
                 note: "互联网上的第一条推文。",
                 createdAt: day(14)),

            Record(carrier: .text,
                   title: L("％Arabica 武康路店"),
                   note: L("午后坐了一小时。吧台只有两个位置，看咖啡师做浓缩，比喝本身更有意思。"),
                   createdAt: day(17), isSample: true),

            Record(carrier: .text,
                   note: L("每包豆都有自己的脾气：有的要高温，有的要等。人也是。"),
                   createdAt: day(20), isSample: true),

            Record(carrier: .text,
                   title: L("换城市之后"),
                   note: L("咖啡变成了少数几件每天都会做的事之一。它不解决问题，但它让一天有个开头。"),
                   createdAt: day(24), isSample: true),

            Record(carrier: .text,
                   title: L("Onibus Coffee 中目黑"),
                   note: L("二楼靠窗，能看到电车经过。点了一杯浅烘的肯尼亚，凉下来之后更像红茶。"),
                   createdAt: day(28), isSample: true),

            image(L(" Saturday 手冲"), [UIColor(red: 0.72, green: 0.60, blue: 0.45, alpha: 1),
                                      UIColor(red: 0.42, green: 0.32, blue: 0.24, alpha: 1)],
                  width: 900, height: 700, createdAt: day(31)),

            Record(carrier: .video,
                   title: L("一杯手冲的时间"),
                   note: L("封面是示例生成的；视频本体不在示例里，详情页会如实说。"),
                   previewPath: sampleImage([UIColor(red: 0.55, green: 0.52, blue: 0.48, alpha: 1),
                                             UIColor(red: 0.25, green: 0.23, blue: 0.21, alpha: 1)],
                                            width: 1280, height: 720),
                   createdAt: day(33), isSample: true),

            image(L("浅烘第一天"), [UIColor(red: 0.87, green: 0.80, blue: 0.68, alpha: 1),
                                   UIColor(red: 0.62, green: 0.48, blue: 0.33, alpha: 1)],
                  width: 700, height: 1000, createdAt: day(35)),

            Record(carrier: .text,
                   note: L("磨豆机的刻度又移了半格。记录这种小事，靠的是愿意每天记，不是记得完美。"),
                   createdAt: day(38), isSample: true),

            image(L("豆仓角落"), [UIColor(red: 0.34, green: 0.38, blue: 0.33, alpha: 1),
                                 UIColor(red: 0.16, green: 0.18, blue: 0.16, alpha: 1)],
                  width: 800, height: 800, createdAt: day(41)),

            link("https://github.com/banmu123/BrewPing",
                 title: "banmu123/BrewPing",
                 summary: "Cross-platform CLI remote control.",
                 author: "banmu123",
                 note: "另一个仓库，桌面端走它。",
                 stars: 12, language: "Swift",
                 createdAt: day(44)),

            Record(carrier: .text,
                   title: L("周一的店"),
                   note: L("隔壁新开的店用了同一支豆子，做出来的却是另一种味道。手法重要，水也重要。"),
                   createdAt: day(47), isSample: true),

            image(L("滤杯与秤"), [UIColor(red: 0.78, green: 0.74, blue: 0.70, alpha: 1),
                                 UIColor(red: 0.36, green: 0.34, blue: 0.32, alpha: 1)],
                  width: 1000, height: 750, createdAt: day(50)),

            Record(carrier: .text,
                   note: L("今天什么也没记，只喝了咖啡。这也是记录的一部分。"),
                   createdAt: day(53), isSample: true),

            Record(carrier: .text,
                   title: L("老豆子的最后一杯"),
                   note: L("尾段有点空，但干净。喝完这一包，豆仓又空出一格。"),
                   createdAt: day(56), isSample: true),
        ]

        let tagAssignments: [[String]] = [
            ["开发"],
            ["文章"],
            ["视频"],
            ["视频"],
            ["随记"],
            ["到访"],
            ["随记"],
            ["人生"],
            ["到访"],
        ]
        for (index, record) in records.enumerated() {
            // 两张表**不必等长**：Phase 2 给示例数据补了十条记录，没有同步
            // 扩标签表，`tagAssignments[index]` 直接越界、示例数据安装即崩
            // （AskRetrievalTests 抓到的就是这条）。多出来的记录不贴标签，
            // 而不是硬套别人用过的标签。
            record.tags = index < tagAssignments.count ? tags(tagAssignments[index]) : []
            context.insert(record)
        }

        let canvases: [Canvas] = [
            Canvas(name: L("我的咖啡探索"),
                   note: L("从第一包手冲豆开始，把喝过的味道串成一条线。"),
                   createdAt: day(18), isSample: true),
            Canvas(name: L("我想建立怎样的生活？"),
                   note: L("慢一点，少一点，把一件事做完。"),
                   createdAt: day(30), isSample: true),
        ]
        for canvas in canvases { context.insert(canvas) }
    }
}
