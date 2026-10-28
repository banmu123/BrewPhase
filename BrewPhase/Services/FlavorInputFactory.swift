import Foundation
import SwiftData

/// 把存下来的 `Bean` 行变成模型的输入。
///
/// 和 `InsightFactory` 同一个道理：**只有这一个地方**知道怎么把一条数据库记录翻译
/// 成模型要的东西。首页和详情页各自拼一遍的话，同一包豆子很快就会喂出两份不一样
/// 的输入，而预测结果不一样的时候没人说得清是谁算错了。
enum FlavorInputFactory {

    /// - Returns: nil 表示这包豆子放不进时间轴（没有烘焙日期），预测无从谈起。
    ///   `PhaseEngine` 对这种情况也是同样的态度：说「算不出来」，而不是编一个 Day 0。
    static func input(
        for bean: Bean,
        defaults: BrewDefaults = .current(),
        today: Date = Date(),
        calendar: Calendar = DateMath.calendar
    ) -> FlavorInput? {
        guard let roastDate = bean.roastDate else { return nil }

        let open = openDay(for: bean, roastDate: roastDate, calendar: calendar)
        let recipe = latestRecipe(for: bean, defaults: defaults)

        return FlavorInput(
            roastLevel: bean.roastLevel,
            // App 只有一整串产区文本（「埃塞俄比亚 · Guji」），国家和产区都从这
            // 一串里拆；拆不出来就各自整组留 0。合成一个字段的活儿在这里做，
            // 编码层只认两个独立字段。
            originCountryText: bean.origin,
            originRegionText: bean.origin,
            processText: bean.process,
            roasterText: bean.roaster,
            brewMethodText: recipe.method,
            openDayAfterRoast: open.day,
            openBasis: open.basis,
            doseG: recipe.doseG,
            waterTempC: recipe.waterTempC,
            waterWeightG: recipe.waterG,
            // 液重交给编码层按水量推算——参考示例里这两者是相等的。
            beverageWeightG: nil,
            brewTimeSeconds: recipe.brewTimeSeconds,
            // App 的研磨度是「22 格」这种自由文本，而模型的 1–10 是相对刻度、
            // 明令不可跨磨豆机比较。宁可留空让它走默认值，也不做一次假的换算。
            grindSizeTenScale: nil
        )
    }

    // MARK: - 重算判据

    /// 预测卡的重算判据：喂给模型的那份输入本身。
    ///
    /// 为什么是输入而不是「豆子 id + updatedAt + 冲煮次数」：那串代理既漏掉了
    /// 默认冲煮参数（改了粉量/水温卡片不会重算），又过分敏感（改一句备注也会
    /// 重算）。输入相等则曲线必然相同，不等则必须重算——判据和缓存键是同一个，
    /// 界面和预测器不可能各说各话。
    ///
    /// 注意「有最近一次冲煮」的情况：那时粉量、水量、水温、方式都来自记录，
    /// 默认参数不参与预测，因此改默认值**不该**触发重算——这一点由测试钉住。
    static func refreshToken(for bean: Bean, defaults: BrewDefaults) -> FlavorInput? {
        input(for: bean, defaults: defaults)
    }

    // MARK: - 开封日

    /// 开封日折算成「烘焙后第几天」，以及这个天数的来路。
    ///
    /// 三级降级，每一级都比上一级弱，但都比空着强：
    /// 1. 真实的开封日期；
    /// 2. 没有开封日期、但有冲煮记录——记过冲煮就说明开过袋，按**最早一次**记录
    ///    推算。协议 §4.1 允许用真实开封时间派生这两个特征，从冲煮记录推断是同一
    ///    件事的弱化版本，而且比「假设一直封着」明显更接近事实；
    /// 3. 都没有：按一直封着处理，并在诊断里说出来。
    static func openDay(
        for bean: Bean,
        roastDate: Date,
        calendar: Calendar = DateMath.calendar
    ) -> (day: Int?, basis: FlavorOpenBasis) {
        if let openDate = bean.openDate {
            // 开封日早于烘焙日是无意义的输入，按第 0 天算，不产生负数天数。
            return (max(0, DateMath.daysBetween(roastDate, openDate, calendar: calendar)), .openDate)
        }
        let earliestBrew = bean.brewsNewestFirst.last
        if let brewDate = earliestBrew?.date, brewDate >= roastDate {
            return (max(0, DateMath.daysBetween(roastDate, brewDate, calendar: calendar)), .firstBrew)
        }
        return (nil, .assumedSealed)
    }

    // MARK: - 冲煮参数

    /// 用最近一次冲煮的参数，没有就用设置里的默认值。
    ///
    /// 最近一次而不是平均：预测回答的是「这包豆子接下来该怎么喝」，最近一次冲煮
    /// 才是它现在的样子。
    private static func latestRecipe(
        for bean: Bean,
        defaults: BrewDefaults
    ) -> (method: String, doseG: Double?, waterG: Double?, waterTempC: Double?, brewTimeSeconds: Double?) {
        let brew = bean.latestBrew

        func positive(_ value: Double?) -> Double? {
            guard let value, value > 0 else { return nil }
            return value
        }

        let method = brew?.method.trimmed.isEmpty == false ? brew!.method : defaults.method
        let seconds = brew.flatMap { $0.timeSeconds > 0 ? Double($0.timeSeconds) : nil }

        return (
            method: method,
            doseG: positive(brew?.coffeeG) ?? defaults.doseG,
            waterG: positive(brew?.waterG) ?? defaults.waterG,
            waterTempC: positive(brew?.waterTemp) ?? defaults.waterTemp,
            brewTimeSeconds: seconds
        )
    }
}
