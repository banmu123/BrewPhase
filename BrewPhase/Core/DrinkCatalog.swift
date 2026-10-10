import Foundation

/// 「想喝什么」——饮品类型，不是器具。
///
/// 拿铁是一种饮品，意式咖啡机是做它的主要器具；两者的区别写进类型里，
/// 这样引导页可以先问「喝什么」，再落到「用什么冲」。`Brew.method` 仍然记录
/// 器具/做法的自由文本（历史与统计的口径不变），饮品只是预填它的那只手。
enum DrinkType: String, CaseIterable, Sendable, Identifiable {

    case pourOver
    case espresso
    case americano
    case latte
    case cappuccino
    case coldBrew

    var id: String { rawValue }

    /// 卡片上的名字。意式浓缩沿用 `BrewCatalog` 里已有的键，两种界面说同一个词。
    var name: String {
        switch self {
        case .pourOver: return L("手冲咖啡")
        case .espresso: return L("意式浓缩")
        case .americano: return L("美式咖啡")
        case .latte: return L("拿铁")
        case .cappuccino: return L("卡布奇诺")
        case .coldBrew: return L("冷萃咖啡")
        }
    }

    /// 一句话说明这张卡片是给谁的。
    var blurb: String {
        switch self {
        case .pourOver: return L("滤杯手冲，风味最清晰")
        case .espresso: return L("浓缩咖啡液，奶咖的底")
        case .americano: return L("浓缩加热水，干净直接")
        case .latte: return L("浓缩加牛奶，柔顺顺口")
        case .cappuccino: return L("奶泡更厚，咖啡感更强")
        case .coldBrew: return L("冷水浸泡，圆润低酸")
        }
    }

    var symbolName: String {
        switch self {
        case .pourOver: return "drop.circle"
        case .espresso: return "cup.and.saucer.fill"
        case .americano: return "takeoutbag.and.cup.and.straw.fill"
        case .latte: return "carton.fill"
        case .cappuccino: return "cloud.fill"
        case .coldBrew: return "snowflake"
        }
    }

    /// 诊断与统计用的家族。与 `brew_method_rules.json` 的分类一致。
    var family: MethodFamily {
        switch self {
        case .pourOver: return .filter
        case .espresso, .americano, .latte, .cappuccino: return .espresso
        case .coldBrew: return .cold
        }
    }

    /// 写进 `Brew.method` 的默认做法。全部命中既有的家族别名表，
    /// 所以历史统计、诊断基线不需要任何迁移。
    var defaultMethod: String {
        switch self {
        case .pourOver: return "V60"
        case .espresso: return L("意式浓缩")
        case .americano: return L("美式")
        case .latte: return L("拿铁")
        case .cappuccino: return L("卡布奇诺")
        case .coldBrew: return L("冷萃")
        }
    }

    /// 器具/做法的候选 chips。手冲给滤杯清单，意式系给饮品名（写进记录的
    /// 就是它，诊断按它归到意式家族），其余照旧可以自由输入。
    var methodOptions: [String] {
        switch self {
        case .pourOver: return ["V60", L("爱乐压"), L("聪明杯"), L("法压壶"), L("折纸"), L("Chemex")]
        case .espresso, .americano, .latte, .cappuccino:
            return [L("意式浓缩"), L("美式"), L("拿铁"), L("卡布奇诺")]
        case .coldBrew: return [L("冷萃")]
        }
    }

    /// 需要浓缩咖啡液。
    var usesEspressoYield: Bool {
        switch self {
        case .pourOver, .coldBrew: return false
        case .espresso, .americano, .latte, .cappuccino: return true
        }
    }

    /// 需要牛奶。
    var usesMilk: Bool { self == .latte || self == .cappuccino }

    /// 萃取后还要加水。
    var usesAddedWater: Bool { self == .americano }

    /// 卡片上的时间预期——说清楚冷萃不是三分钟的活。
    var estimateText: String {
        switch self {
        case .pourOver: return L("约 3 分钟")
        case .espresso: return L("约 2 分钟")
        case .americano: return L("约 3 分钟")
        case .latte: return L("约 5 分钟")
        case .cappuccino: return L("约 5 分钟")
        case .coldBrew: return L("冷藏约 12 小时")
        }
    }
}

/// 一次引导冲煮的完整配方：所有数字都是**目标值**，可编辑，会变成步骤里的
/// 提示，也会在记录时被拿去和实际值对照。
///
/// 只有饮品目录真正需要的字段；研磨度、磨豆机这类个人器具参数留给记录页。
struct DrinkRecipePlan: Equatable, Sendable {

    var drink: DrinkType
    var method: String
    /// 咖啡粉量。
    var coffeeG: Double
    /// 冲煮用水：手冲注水、冷萃水量。意式系保持 0——浓缩液和牛奶各有各的字段。
    var waterG: Double
    /// 水温。冷萃用冷水，保持 0（不适用）。
    var waterTemp: Double
    /// 浓缩咖啡液目标重量。
    var espressoYieldG: Double
    /// 牛奶用量。
    var milkG: Double
    /// 美式额外加入的水。
    var addedWaterG: Double
    /// 建议用时（秒）：手冲的总时长、意式的萃取时长、冷萃的浸泡时长。
    /// 步骤提示由它算，记录页也拿它预填时间。
    var totalSeconds: Int

    /// 各饮品的入门参考值。只是容易上手的起点，不是标准答案——卡片和配方页
    /// 都会说明这一点，所有数字用户都能改。
    static func `default`(for drink: DrinkType) -> DrinkRecipePlan {
        switch drink {
        case .pourOver:
            return DrinkRecipePlan(
                drink: drink, method: drink.defaultMethod,
                coffeeG: 15, waterG: 240, waterTemp: 92,
                espressoYieldG: 0, milkG: 0, addedWaterG: 0,
                totalSeconds: 165
            )
        case .espresso:
            return DrinkRecipePlan(
                drink: drink, method: drink.defaultMethod,
                coffeeG: 18, waterG: 0, waterTemp: 93,
                espressoYieldG: 36, milkG: 0, addedWaterG: 0,
                totalSeconds: 30
            )
        case .americano:
            return DrinkRecipePlan(
                drink: drink, method: drink.defaultMethod,
                coffeeG: 18, waterG: 0, waterTemp: 93,
                espressoYieldG: 36, milkG: 0, addedWaterG: 120,
                totalSeconds: 30
            )
        case .latte:
            return DrinkRecipePlan(
                drink: drink, method: drink.defaultMethod,
                coffeeG: 18, waterG: 0, waterTemp: 93,
                espressoYieldG: 36, milkG: 170, addedWaterG: 0,
                totalSeconds: 30
            )
        case .cappuccino:
            return DrinkRecipePlan(
                drink: drink, method: drink.defaultMethod,
                coffeeG: 18, waterG: 0, waterTemp: 93,
                espressoYieldG: 36, milkG: 120, addedWaterG: 0,
                totalSeconds: 30
            )
        case .coldBrew:
            return DrinkRecipePlan(
                drink: drink, method: drink.defaultMethod,
                coffeeG: 20, waterG: 200, waterTemp: 0,
                espressoYieldG: 0, milkG: 0, addedWaterG: 0,
                totalSeconds: 12 * 3600
            )
        }
    }

    /// 换饮品时的规则：**不要**把另一种饮品的参数带过去。每种饮品从自己的
    /// 默认值开始，用户已经改过的粉量除外——粉量是唯一跨饮品仍然说得通的数字
    ///（同一包豆，磨一样的粗细），其余字段全部回到该饮品的默认。
    static func forDrink(_ drink: DrinkType, keepingDoseFrom previous: DrinkRecipePlan?) -> DrinkRecipePlan {
        var plan = DrinkRecipePlan.default(for: drink)
        if let previous, previous.coffeeG > 0 {
            plan.coffeeG = previous.coffeeG
        }
        return plan
    }

    /// 写进 `BrewRecipe` 的部分（记录与差异比较都用它）。
    func asRecipe(grinder: String = "", grindSize: String = "") -> BrewRecipe {
        BrewRecipe(
            method: method,
            grinder: grinder,
            grindSize: grindSize,
            waterTemp: waterTemp,
            coffeeG: coffeeG,
            waterG: waterG,
            timeSeconds: 0,
            espressoYieldG: espressoYieldG,
            milkG: milkG,
            addedWaterG: addedWaterG
        )
    }

    /// 配方页与记录页的「本次配方目标」行。只列这个饮品真的有的数字。
    var summaryLines: [String] {
        var lines: [String] = []
        lines.append(L("咖啡粉 %@", Fmt.gramsShort(coffeeG)))
        if waterG > 0 { lines.append(L("水 %@", Fmt.gramsShort(waterG))) }
        if espressoYieldG > 0 { lines.append(L("浓缩液 %@", Fmt.gramsShort(espressoYieldG))) }
        if milkG > 0 { lines.append(L("牛奶 %@", Fmt.gramsShort(milkG))) }
        if addedWaterG > 0 { lines.append(L("加水 %@", Fmt.gramsShort(addedWaterG))) }
        if waterTemp > 0 { lines.append(L("水温 %@", BrewParameter.temperature.formatted(waterTemp))) }
        return lines
    }
}
