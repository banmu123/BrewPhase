package com.brewphase.android.data.local

import com.brewphase.android.core.DateMath
import com.brewphase.android.core.TagCodec
import com.brewphase.android.domain.engine.BeanStock
import com.brewphase.android.domain.engine.PhaseRuleData
import com.brewphase.android.domain.model.BeanSnapshot
import com.brewphase.android.domain.model.BeanStatus
import com.brewphase.android.domain.model.RoastLevel
import java.time.LocalDate

/** 实体 ↔ 领域模型的转换。只有这一层知道"库里存的是 millis"。 */

fun Long.toLocalDate(): LocalDate = DateMath.fromEpochMillis(this)

fun LocalDate.toEpochDayMillis(): Long = DateMath.startOfDayMillis(this)

fun BeanEntity.toSnapshot(): BeanSnapshot = BeanSnapshot(
    id = id,
    name = name,
    roaster = roaster,
    roastLevel = RoastLevel.fromRaw(roastLevelRaw),
    roastDate = roastDateMillis?.toLocalDate(),
    openDate = openDateMillis?.toLocalDate(),
    weightG = weightG,
    remainingG = remainingG,
    imagePath = imagePath,
    flavorTags = TagCodec.decode(flavorTagsRaw),
    status = BeanStatus.fromRaw(statusRaw),
    createdAtMillis = createdAtMillis,
    updatedAtMillis = updatedAtMillis,
    stockCountedAtMillis = stockCountedAtMillis,
    isSample = isSample,
)

fun BeanEntity.toStock(): BeanStock = BeanStock(
    weightG = weightG,
    remainingG = remainingG,
    status = BeanStatus.fromRaw(statusRaw),
    stockCountedAtMillis = stockCountedAtMillis,
)

fun PhaseRuleEntity.toData(): PhaseRuleData = PhaseRuleData(
    roastLevel = RoastLevel.fromRaw(roastLevelRaw),
    restMinDays = restMinDays,
    restMaxDays = restMaxDays,
    peakStartDay = peakStartDay,
    peakEndDay = peakEndDay,
    declineStartDay = declineStartDay,
    enabled = enabled,
)

fun PhaseRuleData.toEntity(): PhaseRuleEntity = PhaseRuleEntity(
    roastLevelRaw = roastLevel.raw,
    restMinDays = restMinDays,
    restMaxDays = restMaxDays,
    peakStartDay = peakStartDay,
    peakEndDay = peakEndDay,
    declineStartDay = declineStartDay,
    enabled = enabled,
)

/** 五档规则全部落库；已有行不覆盖（用户改过的值不能被默认值冲掉）。 */
suspend fun ensureDefaultRules(dao: PhaseRuleDao) {
    val existing = dao.listAll().map { it.roastLevelRaw }.toSet()
    com.brewphase.android.domain.engine.DefaultPhaseRules.all
        .filter { it.roastLevel.raw !in existing }
        .forEach { dao.upsert(it.toEntity()) }
}

/** 读规则书：库里有就用库里的，缺哪一档补哪一档的默认值。 */
suspend fun loadRuleBook(dao: PhaseRuleDao): Map<RoastLevel, PhaseRuleData> {
    val stored = dao.listAll().associate { RoastLevel.fromRaw(it.roastLevelRaw) to it.toData() }
    return RoastLevel.entries.associateWith { level ->
        stored[level] ?: com.brewphase.android.domain.engine.DefaultPhaseRules.data(level)
    }
}
