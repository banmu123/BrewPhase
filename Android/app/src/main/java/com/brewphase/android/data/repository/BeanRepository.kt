package com.brewphase.android.data.repository

import androidx.room.withTransaction
import com.brewphase.android.core.TagCodec
import com.brewphase.android.data.local.BeanDao
import com.brewphase.android.data.local.BeanEntity
import com.brewphase.android.data.local.BrewEntity
import com.brewphase.android.data.local.BrewPhaseDatabase
import com.brewphase.android.data.local.TastingEntity
import com.brewphase.android.data.local.ensureDefaultRules
import com.brewphase.android.data.local.loadRuleBook
import com.brewphase.android.data.local.toEpochDayMillis
import com.brewphase.android.data.local.toEntity
import com.brewphase.android.data.local.toLocalDate
import com.brewphase.android.data.local.toRecord
import com.brewphase.android.data.local.toSnapshot
import com.brewphase.android.data.local.toStock
import com.brewphase.android.data.local.toData
import com.brewphase.android.domain.engine.BeanIssue
import com.brewphase.android.domain.engine.BrewIssue
import com.brewphase.android.domain.engine.BrewMath
import com.brewphase.android.domain.engine.BrewRecipe
import com.brewphase.android.domain.engine.DefaultPhaseRules
import com.brewphase.android.domain.engine.PhaseRuleData
import com.brewphase.android.domain.engine.StockLedger
import com.brewphase.android.domain.model.BeanSnapshot
import com.brewphase.android.domain.model.BeanStatus
import com.brewphase.android.domain.model.RoastLevel
import com.brewphase.android.domain.model.TastingSource
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import java.time.LocalDate
import java.util.UUID

/** 校验失败时把"哪几条不通过"带出去，界面负责翻成人话。 */
class BeanValidationException(val issues: List<BeanIssue>) : Exception("bean validation failed")

class BrewValidationException(val issues: List<BrewIssue>) : Exception("brew validation failed")

data class BeanDraft(
    val name: String = "",
    val roaster: String = "",
    val origin: String = "",
    val process: String = "",
    val roastLevel: RoastLevel = RoastLevel.Medium,
    val roastDate: LocalDate? = null,
    val purchaseDate: LocalDate? = null,
    val openDate: LocalDate? = null,
    val weightG: Double = 0.0,
    /** null = 没填。新建时按"整袋未动"处理，编辑时保留原值。 */
    val remainingG: Double? = null,
    val price: Double = 0.0,
    val channel: String = "",
    val imagePath: String? = null,
    val flavorTags: List<String> = emptyList(),
    val notes: String = "",
)

/** 编辑器要的完整字段；`BeanSnapshot` 只带引擎需要的那些，不够编辑用。 */
data class BeanEditable(
    val id: String,
    val name: String,
    val roaster: String,
    val origin: String,
    val process: String,
    val roastLevel: RoastLevel,
    val roastDate: LocalDate?,
    val purchaseDate: LocalDate?,
    val openDate: LocalDate?,
    val weightG: Double,
    val remainingG: Double,
    val price: Double,
    val channel: String,
    val imagePath: String?,
    val flavorTags: List<String>,
    val notes: String,
)

data class BrewDraft(
    val dateMillis: Long = System.currentTimeMillis(),
    val recipe: BrewRecipe = BrewRecipe(),
    val timeText: String = "",
    val score: Int = 0,
    val acidity: Int = 0,
    val sweetness: Int = 0,
    val bitterness: Int = 0,
    val body: Int = 0,
    val aftertaste: Int = 0,
    val flavorTags: List<String> = emptyList(),
    val notes: String = "",
) {
    val resolvedRecipe: BrewRecipe
        get() = recipe.copy(timeSeconds = BrewMath.parseTime(timeText) ?: recipe.timeSeconds)
}

data class BrewSaveOutcome(
    val brewId: String,
    val deductedG: Double,
    val remainingAfterG: Double,
    val wasEdit: Boolean,
)

/**
 * 豆仓的读写门面。UI 只跟它打交道，不碰 DAO。
 */
class BeanRepository(private val db: BrewPhaseDatabase) {

    private val beanDao: BeanDao = db.beanDao()
    private val ruleDao = db.phaseRuleDao()

    fun observeBeans(): Flow<List<BeanSnapshot>> =
        beanDao.observeAll().map { list -> list.map { it.toSnapshot() } }

    fun observeActiveBeans(): Flow<List<BeanSnapshot>> =
        beanDao.observeActive().map { list -> list.map { it.toSnapshot() } }

    fun observeBean(id: String): Flow<BeanSnapshot?> =
        beanDao.observeById(id).map { it?.toSnapshot() }

    suspend fun beanForEdit(id: String): BeanEditable? {
        val e = beanDao.getById(id) ?: return null
        return BeanEditable(
            id = e.id,
            name = e.name,
            roaster = e.roaster,
            origin = e.origin,
            process = e.process,
            roastLevel = RoastLevel.fromRaw(e.roastLevelRaw),
            roastDate = e.roastDateMillis?.toLocalDate(),
            purchaseDate = e.purchaseDateMillis?.toLocalDate(),
            openDate = e.openDateMillis?.toLocalDate(),
            weightG = e.weightG,
            remainingG = e.remainingG,
            price = e.price,
            channel = e.channel,
            imagePath = e.imagePath,
            flavorTags = TagCodec.decode(e.flavorTagsRaw),
            notes = e.notes,
        )
    }

    fun observeRuleBook(): Flow<Map<RoastLevel, PhaseRuleData>> =
        ruleDao.observeAll().map { rows ->
            val stored = rows.associate { RoastLevel.fromRaw(it.roastLevelRaw) to it.toData() }
            RoastLevel.entries.associateWith { level ->
                stored[level] ?: DefaultPhaseRules.data(level)
            }
        }

    suspend fun ruleBook(): Map<RoastLevel, PhaseRuleData> {
        ensureDefaultRules(ruleDao)
        return loadRuleBook(ruleDao)
    }

    suspend fun saveBean(draft: BeanDraft, existingId: String? = null): Result<String> = runCatching {
        val existing = existingId?.let { beanDao.getById(it) }
        // 没填剩余量：新建按"整袋未动"，编辑保留原值——不能把用户的余量清零。
        val baseRemaining = draft.remainingG ?: existing?.remainingG ?: draft.weightG
        val check = BrewMath.validateBean(
            name = draft.name,
            roastDate = draft.roastDate,
            weightG = draft.weightG,
            remainingG = baseRemaining,
        )
        if (!check.validation.canSave) throw BeanValidationException(check.validation.blocking)

        val now = System.currentTimeMillis()
        val entity = existing?.copy(
            name = draft.name.trim(),
            roaster = draft.roaster.trim(),
            origin = draft.origin.trim(),
            process = draft.process.trim(),
            roastLevelRaw = draft.roastLevel.raw,
            roastDateMillis = draft.roastDate?.toEpochDayMillis(),
            purchaseDateMillis = draft.purchaseDate?.toEpochDayMillis(),
            openDateMillis = draft.openDate?.toEpochDayMillis(),
            weightG = check.weightG,
            remainingG = check.remainingG,
            price = draft.price,
            channel = draft.channel.trim(),
            imagePath = draft.imagePath,
            flavorTagsRaw = TagCodec.encode(draft.flavorTags),
            notes = draft.notes.trim(),
            updatedAtMillis = now,
        ) ?: BeanEntity(
            id = UUID.randomUUID().toString(),
            name = draft.name.trim(),
            roaster = draft.roaster.trim(),
            origin = draft.origin.trim(),
            process = draft.process.trim(),
            roastLevelRaw = draft.roastLevel.raw,
            roastDateMillis = draft.roastDate?.toEpochDayMillis(),
            purchaseDateMillis = draft.purchaseDate?.toEpochDayMillis(),
            openDateMillis = draft.openDate?.toEpochDayMillis(),
            weightG = check.weightG,
            remainingG = check.remainingG,
            price = draft.price,
            channel = draft.channel.trim(),
            imagePath = draft.imagePath,
            flavorTagsRaw = TagCodec.encode(draft.flavorTags),
            notes = draft.notes.trim(),
            statusRaw = BeanStatus.Active.raw,
            createdAtMillis = now,
            updatedAtMillis = now,
            stockCountedAtMillis = null,
            isSample = false,
        )
        beanDao.upsert(entity)
        entity.id
    }

    suspend fun deleteBean(id: String): Result<Unit> = runCatching {
        val bean = beanDao.getById(id) ?: return@runCatching
        beanDao.delete(bean)
    }

    /** 人工盘点：记下时刻，之后更早的冲煮不再参与自动退粉。 */
    suspend fun setRemaining(id: String, grams: Double): Result<Unit> = runCatching {
        val bean = beanDao.getById(id) ?: return@runCatching
        val next = bean.toStock().setRemaining(grams, System.currentTimeMillis())
        beanDao.updateStock(
            id = id,
            weightG = next.weightG,
            remainingG = next.remainingG,
            statusRaw = next.status.raw,
            stockCountedAtMillis = next.stockCountedAtMillis,
            updatedAtMillis = System.currentTimeMillis(),
        )
    }

    /** 标记喝完：**只改状态**，库存与历史一律不动。 */
    suspend fun markFinished(id: String): Result<Unit> = runCatching {
        val bean = beanDao.getById(id) ?: return@runCatching
        beanDao.updateStock(
            id = id,
            weightG = bean.weightG,
            remainingG = bean.remainingG,
            statusRaw = BeanStatus.Finished.raw,
            stockCountedAtMillis = bean.stockCountedAtMillis,
            updatedAtMillis = System.currentTimeMillis(),
        )
    }

    suspend fun restoreToActive(id: String): Result<Unit> = runCatching {
        val bean = beanDao.getById(id) ?: return@runCatching
        beanDao.updateStock(
            id = id,
            weightG = bean.weightG,
            remainingG = bean.remainingG,
            statusRaw = BeanStatus.Active.raw,
            stockCountedAtMillis = bean.stockCountedAtMillis,
            updatedAtMillis = System.currentTimeMillis(),
        )
    }

    // MARK: - 品鉴

    fun observeTastings(beanId: String) =
        db.tastingDao().observeByBean(beanId).map { list -> list.map { it.toRecord() } }

    /**
     * 手写品鉴。冲煮镜像走 `BrewRepository.saveBrew`，这里只处理 manual：
     * 镜像必须由冲煮那一条写入路径生成，否则同一杯会留下两条风味节点。
     */
    suspend fun saveTasting(
        beanId: String,
        dateMillis: Long,
        score: Int,
        flavorTags: List<String>,
        notes: String,
        existingId: String? = null,
    ): Result<String> = runCatching {
        val existing = existingId?.let { db.tastingDao().getById(it) }
        val bean = beanDao.getById(beanId) ?: throw IllegalStateException("bean not found")
        val day = bean.roastDateMillis?.let {
            com.brewphase.android.core.DateMath.daysBetween(
                it.toLocalDate(),
                com.brewphase.android.core.DateMath.fromEpochMillis(dateMillis),
            )
        } ?: 0
        val entity = existing?.copy(
            dateMillis = dateMillis,
            dayAfterRoast = day,
            flavorTagsRaw = TagCodec.encode(flavorTags),
            score = score,
            notes = notes.trim(),
        ) ?: TastingEntity(
            id = UUID.randomUUID().toString(),
            beanId = beanId,
            dateMillis = dateMillis,
            dayAfterRoast = day,
            flavorTagsRaw = TagCodec.encode(flavorTags),
            score = score,
            notes = notes.trim(),
            sourceRaw = TastingSource.Manual.raw,
            brewId = null,
            createdAtMillis = System.currentTimeMillis(),
        )
        db.tastingDao().upsert(entity)
        entity.id
    }

    suspend fun deleteTasting(id: String): Result<Unit> = runCatching {
        db.tastingDao().deleteById(id)
    }

    /** 只删带 isSample 标记的数据；真实记录一律不动。 */
    suspend fun clearSampleData(): Result<Unit> = runCatching {
        beanDao.deleteSamples()
        db.recordDao().deleteSamples()
        db.canvasDao().deleteSamples()
    }

    suspend fun saveRule(rule: PhaseRuleData): Result<Unit> = runCatching {
        ruleDao.upsert(rule.normalized().toEntity())
    }

    suspend fun resetRules(): Result<Unit> = runCatching {
        ruleDao.deleteAll()
        ensureDefaultRules(ruleDao)
    }
}

/**
 * 冲煮的**唯一写入路径**。
 *
 * 写一次冲煮要同时做完四件事：校验、扣库存、维护风味时间线上的镜像、记账
 * （`stockDeductedG`）。任何一件漏掉，数据就会悄悄不一致——库存扣了但时间线没长，
 * 或者改了粉量而镜像还写着旧值。所以全部收在一个 Room 事务里：失败就整体回滚。
 */
class BrewRepository(private val db: BrewPhaseDatabase) {

    private val beanDao = db.beanDao()
    private val brewDao = db.brewDao()
    private val tastingDao = db.tastingDao()

    fun observeBrews(beanId: String) = brewDao.observeByBean(beanId).map { list -> list.map { it.toRecord() } }

    fun observeBrew(brewId: String) = brewDao.observeById(brewId).map { it?.toRecord() }

    /** 全部冲煮，新到旧。首页要按豆子分组显示"最近一杯"，一次取全比 N+1 查询划算。 */
    fun observeAllBrews() = brewDao.observeAll().map { list -> list.map { it.toRecord() } }

    suspend fun saveBrew(beanId: String, draft: BrewDraft, existingId: String? = null): Result<BrewSaveOutcome> =
        runCatching {
            val resolved = draft.resolvedRecipe
            val validation = BrewMath.validate(resolved)
            if (!validation.canSave) throw BrewValidationException(validation.blocking)

            db.withTransaction {
                val bean = beanDao.getById(beanId) ?: throw IllegalStateException("bean not found")
                val now = System.currentTimeMillis()
                val existing = existingId?.let { brewDao.getById(it) }

                val deducted: Double
                val savedId: String
                if (existing != null) {
                    // **先**读实扣量再写字段：旧记录没有 stockDeductedG 时兜底是
                    // coffeeG，而写入会把 coffeeG 改成新粉量——顺序反了差额永远是 0。
                    val previousApplied = existing.stockDeductedG ?: existing.coffeeG
                    val countedAt = bean.stockCountedAtMillis
                    val settled = countedAt != null && existing.createdAtMillis < countedAt
                    val edit = StockLedger.onBrewEdited(
                        bean = bean.toStock(),
                        previousApplied = previousApplied,
                        newCoffeeG = resolved.coffeeG,
                        settled = settled,
                    )
                    applyBeanStock(bean.id, edit.bean, now)

                    val updated = existing.copy(
                        dateMillis = draft.dateMillis,
                        method = resolved.method.trim(),
                        grinder = resolved.grinder.trim(),
                        grindSize = resolved.grindSize.trim(),
                        waterTemp = resolved.waterTemp,
                        coffeeG = resolved.coffeeG,
                        waterG = resolved.waterG,
                        timeSeconds = resolved.timeSeconds,
                        score = BrewMath.clampScore(draft.score),
                        acidity = draft.acidity,
                        sweetness = draft.sweetness,
                        bitterness = draft.bitterness,
                        body = draft.body,
                        aftertaste = draft.aftertaste,
                        flavorTagsRaw = TagCodec.encode(draft.flavorTags),
                        notes = draft.notes.trim(),
                        stockDeductedG = edit.deductedG,
                    )
                    brewDao.upsert(updated)
                    syncMirror(updated, bean)
                    deducted = edit.deductedG
                    savedId = updated.id
                } else {
                    val created = StockLedger.onBrewCreated(bean.toStock(), resolved.coffeeG)
                    applyBeanStock(bean.id, created.bean, now)

                    val entity = BrewEntity(
                        id = UUID.randomUUID().toString(),
                        beanId = bean.id,
                        dateMillis = draft.dateMillis,
                        method = resolved.method.trim(),
                        grinder = resolved.grinder.trim(),
                        grindSize = resolved.grindSize.trim(),
                        waterTemp = resolved.waterTemp,
                        coffeeG = resolved.coffeeG,
                        waterG = resolved.waterG,
                        timeSeconds = resolved.timeSeconds,
                        score = BrewMath.clampScore(draft.score),
                        acidity = draft.acidity,
                        sweetness = draft.sweetness,
                        bitterness = draft.bitterness,
                        body = draft.body,
                        aftertaste = draft.aftertaste,
                        flavorTagsRaw = TagCodec.encode(draft.flavorTags),
                        notes = draft.notes.trim(),
                        createdAtMillis = now,
                        stockDeductedG = created.deductedG,
                    )
                    brewDao.upsert(entity)
                    syncMirror(entity, bean)
                    deducted = created.deductedG
                    savedId = entity.id
                }

                val remaining = beanDao.getById(bean.id)?.remainingG ?: 0.0
                BrewSaveOutcome(
                    brewId = savedId,
                    deductedG = deducted,
                    remainingAfterG = remaining,
                    wasEdit = existing != null,
                )
            }
        }

    /** 删除一次冲煮：退还**当时实际扣掉的粉**，并精确带走它的镜像。 */
    suspend fun deleteBrew(brewId: String): Result<Unit> = runCatching {
        db.withTransaction {
            val brew = brewDao.getById(brewId) ?: return@withTransaction
            val bean = beanDao.getById(brew.beanId)
            if (bean != null) {
                val countedAt = bean.stockCountedAtMillis
                val settled = countedAt != null && brew.createdAtMillis < countedAt
                val next = StockLedger.onBrewDeleted(
                    bean = bean.toStock(),
                    applied = brew.stockDeductedG ?: brew.coffeeG,
                    settled = settled,
                )
                applyBeanStock(bean.id, next, System.currentTimeMillis())
            }
            tastingDao.deleteByBrewId(brewId)
            brewDao.deleteById(brewId)
        }
    }

    private suspend fun applyBeanStock(beanId: String, stock: com.brewphase.android.domain.engine.BeanStock, now: Long) {
        beanDao.updateStock(
            id = beanId,
            weightG = stock.weightG,
            remainingG = stock.remainingG,
            statusRaw = stock.status.raw,
            stockCountedAtMillis = stock.stockCountedAtMillis,
            updatedAtMillis = now,
        )
    }

    /**
     * 让风味时间线上那条镜像跟上这次冲煮，或者在它不再有话可说时移除。
     * 镜像的 `id` 稳定复用，不会因为多存几次就长出好几条重复节点。
     */
    private suspend fun syncMirror(brew: BrewEntity, bean: BeanEntity) {
        val existing = tastingDao.getByBrewId(brew.id)
        val material = brew.score > 0 ||
            TagCodec.decode(brew.flavorTagsRaw).isNotEmpty() ||
            brew.notes.isNotBlank()

        if (!material) {
            existing?.let { tastingDao.deleteById(it.id) }
            return
        }

        val day = bean.roastDateMillis?.let {
            com.brewphase.android.core.DateMath.daysBetween(
                it.toLocalDate(),
                com.brewphase.android.core.DateMath.fromEpochMillis(brew.dateMillis),
            )
        } ?: 0

        val entity = existing?.copy(
            dateMillis = brew.dateMillis,
            dayAfterRoast = day,
            flavorTagsRaw = brew.flavorTagsRaw,
            score = brew.score,
            notes = brew.notes,
        ) ?: TastingEntity(
            id = UUID.randomUUID().toString(),
            beanId = bean.id,
            dateMillis = brew.dateMillis,
            dayAfterRoast = day,
            flavorTagsRaw = brew.flavorTagsRaw,
            score = brew.score,
            notes = brew.notes,
            sourceRaw = TastingSource.Brew.raw,
            brewId = brew.id,
            createdAtMillis = System.currentTimeMillis(),
        )
        tastingDao.upsert(entity)
    }
}
