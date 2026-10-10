import Foundation

/// 引导页上的一步。纯值：标题与说明在构建时就地走 `L()`，目标值由配方算出，
/// 视图只负责摆出来——没有任何一个目标数字写死在 SwiftUI 里。
struct BrewStep: Equatable, Sendable, Identifiable {

    /// 稳定标识（"pourOver.bloom"），测试与列表 diff 用它。
    let id: String
    /// 这一步做什么（一句短标题）。
    let title: String
    /// 具体怎么做。可以为空——标题已经说清的步骤不再重复。
    let detail: String
    /// 目标重量（克）。秤上的累计读数：粉量、注水累计、奶量……
    let targetG: Double?
    /// 目标温度。
    let targetTemp: Double?
    /// 这一步的建议用时（秒）。冷萃的浸泡也用它，但那种步不提供计时器。
    let targetSeconds: Int?
    /// 是否提供计时器。称粉、布粉这类「做完就过」的步骤没有表可开。
    let usesTimer: Bool

    init(
        id: String,
        title: String,
        detail: String = "",
        targetG: Double? = nil,
        targetTemp: Double? = nil,
        targetSeconds: Int? = nil,
        usesTimer: Bool = false
    ) {
        self.id = id
        self.title = title
        self.detail = detail
        self.targetG = targetG
        self.targetTemp = targetTemp
        self.targetSeconds = targetSeconds
        self.usesTimer = usesTimer
    }

    /// 「目标 45g」这种小标签。没有目标时为 nil，视图就少摆一块。
    /// 超过一小时的目标按小时说（冷萃的浸泡），`720:00` 不像人话。
    var targetChipText: String? {
        if let targetG { return L("目标 %@", Fmt.gramsShort(targetG)) }
        if let targetTemp { return L("目标 %@", BrewParameter.temperature.formatted(targetTemp)) }
        guard let targetSeconds else { return nil }
        if targetSeconds >= 3600 {
            return L("约 %@ 小时", String(Int((Double(targetSeconds) / 3600).rounded())))
        }
        return L("约 %@", BrewMath.formatTime(targetSeconds))
    }
}

/// 把一份配方翻译成一步一步的操作。
///
/// 纯函数：步骤的目标值全部由 `DrinkRecipePlan` 算出（改了配方，步骤就变），
/// 六种饮品各走各的分支——不同的饮品不该只是名字不同、下面却是同一份流程。
enum BrewStepBuilder {

    static func steps(for plan: DrinkRecipePlan) -> [BrewStep] {
        switch plan.drink {
        case .pourOver: return pourOver(plan)
        case .espresso: return espresso(plan)
        case .americano: return americano(plan)
        case .latte: return latte(plan)
        case .cappuccino: return cappuccino(plan)
        case .coldBrew: return coldBrew(plan)
        }
    }

    // MARK: - 手冲

    /// 闷蒸水量：粉量的三倍（15g → 45g），至少 30g。
    static func bloomWater(coffeeG: Double) -> Double {
        max((coffeeG * 3).rounded(), 30)
    }

    private static func pourOver(_ plan: DrinkRecipePlan) -> [BrewStep] {
        let bloom = bloomWater(coffeeG: plan.coffeeG)
        let rest = max(plan.waterG - bloom, 0)
        // 闷蒸之后分两段：第一段到总量六成上下，第二段补满并等待滤干。
        let firstSegment = bloom + (rest * 0.55).rounded()
        var steps: [BrewStep] = [
            BrewStep(
                id: "pourOver.heat",
                title: L("烧水备器"),
                detail: L("烧一壶水到 %@，备好滤杯、滤纸、电子秤和手冲壶。",
                          BrewParameter.temperature.formatted(plan.waterTemp)),
                targetTemp: plan.waterTemp
            ),
            BrewStep(
                id: "pourOver.dose",
                title: L("称取咖啡粉"),
                detail: L("按配方称 %@ 咖啡粉，研磨度按你的器具调整。",
                          Fmt.gramsShort(plan.coffeeG)),
                targetG: plan.coffeeG
            ),
            BrewStep(
                id: "pourOver.rinse",
                title: L("润湿滤纸，温杯"),
                detail: L("滤纸放进滤杯，用热水冲湿，倒掉润洗水。")
            ),
            BrewStep(
                id: "pourOver.addGrounds",
                title: L("倒粉，轻晃铺平"),
                detail: L("咖啡粉倒进滤杯，轻晃让粉面平整，放到秤上归零。")
            ),
            BrewStep(
                id: "pourOver.bloom",
                title: L("闷蒸"),
                detail: L("从中心向外绕圈注水至 %@，等 %@ 让粉层排气。",
                          Fmt.gramsShort(bloom), BrewMath.formatTime(30)),
                targetG: bloom, targetSeconds: 30, usesTimer: true
            ),
            BrewStep(
                id: "pourOver.firstPour",
                title: L("第一段注水"),
                detail: L("缓慢绕圈注水至 %@，水流别冲到滤纸。",
                          Fmt.gramsShort(firstSegment)),
                targetG: firstSegment, usesTimer: true
            ),
            BrewStep(
                id: "pourOver.secondPour",
                title: L("第二段注水"),
                detail: L("继续注水至 %@，注完轻轻晃一下滤杯，让粉层落平。",
                          Fmt.gramsShort(plan.waterG)),
                targetG: plan.waterG, usesTimer: true
            ),
            BrewStep(
                id: "pourOver.drawDown",
                title: L("等待滤干"),
                detail: L("等液面降到粉层下方，全程大约 %@。",
                          BrewMath.formatTime(plan.totalSeconds)),
                targetSeconds: 30, usesTimer: true
            ),
        ]
        steps.append(finale("pourOver.serve", L("移开滤杯，摇匀分享壶")))
        return steps
    }

    // MARK: - 意式浓缩（拿铁/卡布/美式共享前段）

    private static func espressoBase(_ plan: DrinkRecipePlan, idPrefix: String) -> [BrewStep] {
        [
            BrewStep(
                id: "\(idPrefix).dose",
                title: L("称取咖啡粉"),
                detail: L("称 %@ 咖啡粉倒进粉碗。", Fmt.gramsShort(plan.coffeeG)),
                targetG: plan.coffeeG
            ),
            BrewStep(
                id: "\(idPrefix).distribute",
                title: L("布粉与压粉"),
                detail: L("布粉器转两圈，压粉器水平压实，力道稳就够。")
            ),
            BrewStep(
                id: "\(idPrefix).lockIn",
                title: L("上手柄，预热"),
                detail: L("手柄扣上冲煮头，先放几秒水预热。")
            ),
            BrewStep(
                id: "\(idPrefix).extract",
                title: L("萃取浓缩"),
                detail: L("接到电子秤上启动萃取，目标 %@ 浓缩液，用时约 25–35 秒。",
                          Fmt.gramsShort(plan.espressoYieldG)),
                targetG: plan.espressoYieldG, targetSeconds: 30, usesTimer: true
            ),
        ]
    }

    private static func espresso(_ plan: DrinkRecipePlan) -> [BrewStep] {
        var steps = espressoBase(plan, idPrefix: "espresso")
        steps.append(finale("espresso.serve",
                            L("到目标重量就停手，轻晃杯子让油脂均匀")))
        return steps
    }

    // MARK: - 美式

    private static func americano(_ plan: DrinkRecipePlan) -> [BrewStep] {
        var steps = espressoBase(plan, idPrefix: "americano")
        steps.append(BrewStep(
            id: "americano.water",
            title: L("量取水"),
            detail: L("量 %@ 热水倒进杯子；做冰美式就换冰水加冰块。",
                      Fmt.gramsShort(plan.addedWaterG)),
            targetG: plan.addedWaterG
        ))
        steps.append(BrewStep(
            id: "americano.combine",
            title: L("混合"),
            detail: L("把浓缩倒进水里，轻轻搅匀。")
        ))
        steps.append(finale("americano.serve", L("尝一口，太浓就再补点水")))
        return steps
    }

    // MARK: - 拿铁

    private static func latte(_ plan: DrinkRecipePlan) -> [BrewStep] {
        var steps = espressoBase(plan, idPrefix: "latte")
        steps.append(BrewStep(
            id: "latte.milk",
            title: L("称量牛奶"),
            detail: L("冷藏牛奶 %@，倒进拉花缸。", Fmt.gramsShort(plan.milkG)),
            targetG: plan.milkG
        ))
        steps.append(BrewStep(
            id: "latte.steam",
            title: L("打发牛奶"),
            detail: L("蒸汽棒先补气再加热，打出细滑的奶泡，目标 %@。",
                      BrewParameter.temperature.formatted(65)),
            targetTemp: 65, targetSeconds: 10, usesTimer: true
        ))
        steps.append(BrewStep(
            id: "latte.combine",
            title: L("融合"),
            detail: L("浓缩倒进温好的杯子，牛奶从高处细流注入融合。")
        ))
        steps.append(finale("latte.serve", L("趁热喝，奶咖放久了奶泡会塌")))
        return steps
    }

    // MARK: - 卡布奇诺

    private static func cappuccino(_ plan: DrinkRecipePlan) -> [BrewStep] {
        var steps = espressoBase(plan, idPrefix: "cappuccino")
        steps.append(BrewStep(
            id: "cappuccino.milk",
            title: L("称量牛奶"),
            detail: L("牛奶 %@——比拿铁少，因为奶泡要占掉一层。",
                      Fmt.gramsShort(plan.milkG)),
            targetG: plan.milkG
        ))
        steps.append(BrewStep(
            id: "cappuccino.foam",
            title: L("打发奶泡"),
            detail: L("多打进一些空气，做出更厚更结实的奶泡层，目标 %@。",
                      BrewParameter.temperature.formatted(60)),
            targetTemp: 60, targetSeconds: 12, usesTimer: true
        ))
        steps.append(BrewStep(
            id: "cappuccino.combine",
            title: L("融合与覆盖"),
            detail: L("牛奶先倒进浓缩，最后用勺子把奶泡铺到表面。")
        ))
        steps.append(finale("cappuccino.serve", L("撒点可可粉就是另一杯了——这杯先原味喝")))
        return steps
    }

    // MARK: - 冷萃

    private static func coldBrew(_ plan: DrinkRecipePlan) -> [BrewStep] {
        [
            BrewStep(
                id: "coldBrew.dose",
                title: L("称取咖啡粉"),
                detail: L("粗研磨，%@ 咖啡粉倒进容器。", Fmt.gramsShort(plan.coffeeG)),
                targetG: plan.coffeeG
            ),
            BrewStep(
                id: "coldBrew.water",
                title: L("加入冷水"),
                detail: L("注水 %@，边倒边搅拌，让粉全部浸湿。",
                          Fmt.gramsShort(plan.waterG)),
                targetG: plan.waterG
            ),
            BrewStep(
                id: "coldBrew.chill",
                title: L("盖好，放进冰箱"),
                detail: L("盖紧盖子冷藏，别放在门边——温度要稳。")
            ),
            BrewStep(
                id: "coldBrew.steep",
                title: L("浸泡"),
                detail: L("冷藏浸泡 %@。这一步交给时间，不用计时器，到点再来。",
                          steepText(plan.totalSeconds)),
                targetSeconds: plan.totalSeconds
            ),
            BrewStep(
                id: "coldBrew.filter",
                title: L("过滤装瓶"),
                detail: L("用滤纸或细筛滤掉残渣，装瓶冷藏，三天内喝完。")
            ),
        ]
    }

    /// 冷萃的浸泡时长按「小时」说——`12:00:00` 不像人话。
    private static func steepText(_ seconds: Int) -> String {
        let hours = Double(seconds) / 3600
        if hours >= 1, hours == hours.rounded() {
            return L("%@ 小时", String(Int(hours)))
        }
        return BrewMath.formatTime(seconds)
    }

    // MARK: - 收尾

    /// 每种饮品各有一句收尾，让最后一步也不只是「完成」两个字。
    private static func finale(_ id: String, _ detail: String) -> BrewStep {
        BrewStep(id: id, title: L("完成"), detail: detail)
    }
}
