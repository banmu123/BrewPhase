import Foundation
import SwiftData

/// 把库里的记录喂给诊断引擎。
///
/// 这一层薄得几乎不像一层，但它挡掉了一个真实的错误：**刚刚记下的那一杯不能给自己
/// 当基线**。界面（豆子详情、快记结果）都用同一个入口，所以「参考记录里有没有混进
/// 这一杯」只有一个答案。
///
/// 另一件事是范围：参考记录同时给「这包豆」和「全库」两份——诊断的第三层回退
/// （同一冲法、别的豆子）需要后者。
@MainActor
enum BrewDiagnosisService {

    /// 诊断一包豆子的某一杯。`brew` 为空时取最近记的那一杯。
    ///
    /// - Returns: 这包豆还没有任何记录时返回 nil——没有可诊断的对象。
    static func diagnose(
        bean: Bean,
        brew: Brew? = nil,
        allBrews: [Brew],
        languageCode: String
    ) -> BrewDiagnosis? {
        guard let target = brew ?? bean.brewsNewestFirst.first else { return nil }

        let beanHistory = bean.brewsNewestFirst
            .filter { $0.id != target.id }
            .map(BrewObservation.init(brew:))
        let globalHistory = allBrews
            .filter { $0.id != target.id }
            .map(BrewObservation.init(brew:))

        return BrewDiagnosticEngine.diagnose(
            current: BrewObservation(brew: target),
            beanHistory: beanHistory,
            allHistory: globalHistory,
            languageCode: languageCode
        )
    }
}
