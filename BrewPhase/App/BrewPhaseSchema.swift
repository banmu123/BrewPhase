import SwiftData

/// 本地数据库的实体清单与迁移策略。
///
/// 这里**刻意不分 `VersionedSchema`**：SwiftData 的轻量迁移已经覆盖了本仓库
/// 出现过的两类变更——「加实体」（`EmbeddingRecord`）与「加可选属性」
/// （`Bean.stockCountedAt`、`Brew.stockDeductedG`）。分版本会把每个模型类型
/// 都塞进嵌套命名空间，改动面远大于收益，而真正的保护来自下面这条约定与
/// 恢复页的导出出口，不来自版本号本身。
///
/// 允许的变更：
/// * 新增实体；
/// * 新增**可选**属性，或带默认值的新属性（旧行读出来是 nil / 默认值）。
///
/// 需要 `SchemaMigrationPlan` 的破坏性变更（改类型、改名、删字段）在实施前
/// 必须先确认两件事：旧数据能原样打开，或者用户能先把原始数据库导出去
/// （见 `StoreRecovery` 与 `PersistenceRecoveryView`）。
///
/// 清单只此一处：App 与测试用同一个 Schema 开容器，避免两边实体集合漂移
/// ——曾经有一份测试只列了五张表，`EmbeddingRecord` 的写入路径在测试里
/// 根本没有被打开过。
enum BrewPhaseSchema {

    static let modelTypes: [any PersistentModel.Type] = [
        Bean.self,
        Brew.self,
        Tasting.self,
        PhaseReminder.self,
        PhaseRule.self,
        // 本地问答用的向量索引。它是**派生数据**：全部内容都能从上面几张表重算，
        // 所以清掉它不丢信息，只是下次提问要多花一次建索引的时间。
        EmbeddingRecord.self,
        // 个人咖啡馆的两块新内容：记录与画布。与咖啡完全独立——它们没有外键，
        // 不参与阶段/推荐/提醒的任何计算，加进来只是多了两张表。
        Record.self,
        Canvas.self,
        // 用户自定义的标签，与记录多对多。它不是「记录的分类」：删一个标签
        // 只解除关联，记录一条都不会少。
        RecordTag.self,
    ]

    static let schema = Schema(modelTypes)
}
