import CoreML
import Foundation

/// 今天相对预计窗口的位置。
///
/// 刻意和 `BeanPhase` 分开：那一个是 App 按自己的窗口规则算出来的**结论**，
/// 这一个只是模型对同一天的**估计**。两者不一致是正常的，也正是把它们分开放的
/// 原因——界面可以让它们并排出现，但绝不能让其中一个悄悄冒充另一个。
enum FlavorWindowStatus: Equatable, Sendable {
    case resting
    case inWindow
    case past
}

/// 一条 30 天的预计风味曲线，连同它的来历。
struct FlavorCurve: Equatable, Sendable {

    /// 逐天分数，下标 0 是第 1 天。
    var scores: [Double]
    var firstDay: Int = 1
    var peakDay: Int
    var peakScore: Double
    var windowStart: Int
    var windowEnd: Int
    var diagnostics: FlavorDiagnostics
    /// 加在模型原始输出上的修正量。0 表示模型的原始输出就是最终分。
    ///
    /// 之所以要把它带在结果里而不是留在预测器内部：这是一个「模型和它的基线对
    /// 不上」的事实，测试要能断言它，将来模型重新导出之后也要能一眼看出该把它
    /// 去掉（详见 flavor_mapping.json → outputCorrection）。
    var outputOffset: Double = 0

    var days: [Int] { Array(firstDay..<(firstDay + scores.count)) }

    var peakWindow: ClosedRange<Int> { windowStart...windowEnd }

    func score(onDay day: Int) -> Double? {
        let index = day - firstDay
        guard scores.indices.contains(index) else { return nil }
        return scores[index]
    }

    func status(onDay day: Int) -> FlavorWindowStatus {
        if day < windowStart { return .resting }
        if day <= windowEnd { return .inWindow }
        return .past
    }

    /// 曲线上的最高分。数值特征缺失时模型可能给出一条平线，界面得能说清楚。
    var hasShape: Bool { (scores.max() ?? 0) - (scores.min() ?? 0) > 0.05 }
}

/// 端侧推理。整个 App 只有这一个入口。
///
/// 三件事值得说明：
///
/// * **模型找不到就返回 nil**，不崩、不抛给界面。这是实验性功能，它算不出来的时候
///   应该整张卡片消失，而不是让详情页挂掉。
/// * **结果缓存**。30 天 = 30 次预测，单次毫秒级，但详情页的 `body` 会被反复求值，
///   每次重算就是白白烧电。缓存的键就是输入本身，输入没变曲线必然一样。
/// * **CPU**。小树模型，CPU 又快又确定；让 Core ML 去挑 ANE 只会引入首次加载的
///   抖动，对一条 30 点的曲线没有好处。
final class FlavorWindowPredictor: @unchecked Sendable {

    static let shared = FlavorWindowPredictor()

    /// 为什么算不出来。界面要把「模型缺失」和「资料不够」分清楚，这两件事的
    /// 处理方式不一样。
    enum Availability: Equatable, Sendable {
        case ready
        case schemaMissing
        case modelMissing
        case failed(String)

        var isReady: Bool { self == .ready }
    }

    /// 模型输出特征名。协议里写的是 `target`，但仍然从模型自己的描述里读一次：
    /// 万一将来换了转换脚本，这里不该变成一个静默的 0。
    private static let fallbackOutputName = "target"

    private let lock = NSLock()
    private var model: MLModel?
    private var outputName: String = fallbackOutputName
    private var availability: Availability = .ready
    private var didAttemptLoad = false
    private var cache: [FlavorInput: FlavorCurve] = [:]

    private init() {}

    // MARK: - 对外

    var currentAvailability: Availability {
        lock.lock(); defer { lock.unlock() }
        return availability
    }

    /// 30 天的预计曲线。算不出来返回 nil。
    func curve(for input: FlavorInput) -> FlavorCurve? {
        lock.lock(); defer { lock.unlock() }

        if let cached = cache[input] { return cached }
        guard let schema = FlavorModelResources.schema,
              let mapping = FlavorModelResources.mapping,
              let index = FlavorModelResources.aliasIndex
        else {
            availability = .schemaMissing
            return nil
        }
        guard let model = loadedModel() else { return nil }

        var scores: [Double] = []
        var diagnostics: FlavorDiagnostics?
        for day in FlavorFeatureBuilder.curveDays {
            let encoded = FlavorFeatureBuilder.build(
                input: input, dayAfterRoast: day,
                schema: schema, mapping: mapping, index: index
            )
            // 逐天的诊断只在「哪些资料缺」上不同，取第一天的即可——缺的是同一批。
            if diagnostics == nil { diagnostics = encoded.diagnostics }

            guard let raw = predict(model, features: schema.featureNames, values: encoded.values) else {
                availability = .failed("prediction returned no value")
                return nil
            }
            scores.append(raw + mapping.outputOffset)
        }

        guard let curve = Self.makeCurve(
            scores: scores,
            diagnostics: diagnostics ?? FlavorDiagnostics(),
            outputOffset: mapping.outputOffset
        ) else {
            availability = .failed("prediction returned nothing usable")
            return nil
        }

        availability = .ready
        // 小缓存：豆仓里同时要看的包数远小于这个数，超出就整体丢掉重建。
        if cache.count >= 64 { cache.removeAll(keepingCapacity: true) }
        cache[input] = curve
        return curve
    }

    /// 预加载，供「设置」页在打开开关时提前把模型捂热。
    func warmUp() {
        lock.lock(); defer { lock.unlock() }
        _ = loadedModel()
    }

    // MARK: - 曲线的三个数字

    /// 峰值日、峰值分、最佳窗口。
    ///
    /// 和 `predict.py → predict_curve` 逐行对应：窗口 = 分数 ≥ 峰值 − 0.25 的
    /// **最前与最后**一天。这里取首尾而不是「连续区间」，是为了和有符号的参考实现
    /// 完全一致；曲线是单峰的，两者本来就重合，这一点由测试钉住。
    static func makeCurve(
        scores: [Double],
        diagnostics: FlavorDiagnostics,
        outputOffset: Double = 0
    ) -> FlavorCurve? {
        guard let peakIndex = scores.indices.max(by: { scores[$0] < scores[$1] }) else { return nil }
        let peakScore = scores[peakIndex]
        let inWindow = scores.indices
            .filter { scores[$0] >= peakScore - FlavorFeatureBuilder.windowTolerance }
            .map { $0 + 1 }
        guard let windowStart = inWindow.first, let windowEnd = inWindow.last else { return nil }

        return FlavorCurve(
            scores: scores,
            peakDay: peakIndex + 1,
            peakScore: peakScore,
            windowStart: windowStart,
            windowEnd: windowEnd,
            diagnostics: diagnostics,
            outputOffset: outputOffset
        )
    }

    // MARK: - 模型

    private func loadedModel() -> MLModel? {
        if let model { return model }
        guard !didAttemptLoad else { return nil }
        didAttemptLoad = true

        let configuration = MLModelConfiguration()
        configuration.computeUnits = .cpuOnly

        do {
            // Xcode 会把 .mlpackage 编译成 .mlmodelc 放进 Bundle，所以先找编好的。
            if let url = FlavorModelResources.resourceURL(
                named: FlavorModelResources.modelName, extensions: ["mlmodelc"]
            ) {
                model = try MLModel(contentsOf: url, configuration: configuration)
            } else if let url = FlavorModelResources.resourceURL(
                named: FlavorModelResources.modelName, extensions: ["mlpackage"]
            ) {
                // 没编过就自己编一次。协议里的示例代码只会找 .mlpackage，端上
                // 那是找不到的——这条分支正是为了兜住那种情况。
                let compiled = try MLModel.compileModel(at: url)
                model = try MLModel(contentsOf: compiled, configuration: configuration)
            } else {
                availability = .modelMissing
                AppLog.flavor.error("brewphase_xgb model not found in the bundle")
                return nil
            }

            if let name = model?.modelDescription.outputDescriptionsByName.keys.first {
                outputName = name
            }
            availability = .ready
            AppLog.flavor.info("flavor model loaded, output \(self.outputName, privacy: .public)")
            return model
        } catch {
            availability = .failed(String(describing: error))
            AppLog.flavor.error("flavor model failed to load: \(String(describing: error), privacy: .public)")
            return nil
        }
    }

    private func predict(_ model: MLModel, features: [String], values: [Double]) -> Double? {
        guard features.count == values.count else { return nil }
        let dictionary = Dictionary(uniqueKeysWithValues: zip(features, values.map { $0 as NSNumber }))
        do {
            let provider = try MLDictionaryFeatureProvider(dictionary: dictionary)
            let output = try model.prediction(from: provider)
            return output.featureValue(for: outputName)?.doubleValue
        } catch {
            AppLog.flavor.error("flavor prediction failed: \(String(describing: error), privacy: .public)")
            return nil
        }
    }
}
