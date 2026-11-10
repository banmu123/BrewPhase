package com.brewphase.android.data.local

import androidx.room.Dao
import androidx.room.Delete
import androidx.room.Embedded
import androidx.room.Insert
import androidx.room.Junction
import androidx.room.Query
import androidx.room.Relation
import androidx.room.Transaction
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

/** 一条记录 + 它的标签。标签是多对多，且只解除关系、不带走记录。 */
data class RecordWithTags(
    @Embedded val record: RecordEntity,
    @Relation(
        parentColumn = "id",
        entityColumn = "id",
        associateBy = Junction(
            value = RecordTagLinkEntity::class,
            parentColumn = "recordId",
            entityColumn = "tagId",
        ),
    )
    val tags: List<RecordTagEntity>,
)

data class RecordTagWithCount(
    val id: String,
    val name: String,
    val createdAtMillis: Long,
    val updatedAtMillis: Long,
    val recordCount: Int,
)

@Dao
interface BeanDao {
    @Query("SELECT * FROM beans ORDER BY createdAtMillis DESC")
    fun observeAll(): Flow<List<BeanEntity>>

    @Query("SELECT * FROM beans WHERE statusRaw = 'active' ORDER BY createdAtMillis DESC")
    fun observeActive(): Flow<List<BeanEntity>>

    @Query("SELECT * FROM beans WHERE id = :id")
    fun observeById(id: String): Flow<BeanEntity?>

    @Query("SELECT * FROM beans WHERE id = :id")
    suspend fun getById(id: String): BeanEntity?

    @Query("SELECT * FROM beans ORDER BY createdAtMillis DESC")
    suspend fun getAll(): List<BeanEntity>

    @Upsert
    suspend fun upsert(bean: BeanEntity)

    @Query(
        """
        UPDATE beans SET weightG = :weightG, remainingG = :remainingG,
            statusRaw = :statusRaw, stockCountedAtMillis = :stockCountedAtMillis,
            updatedAtMillis = :updatedAtMillis
        WHERE id = :id
        """,
    )
    suspend fun updateStock(
        id: String,
        weightG: Double,
        remainingG: Double,
        statusRaw: String,
        stockCountedAtMillis: Long?,
        updatedAtMillis: Long,
    )

    @Delete
    suspend fun delete(bean: BeanEntity)

    @Query("DELETE FROM beans WHERE isSample = 1")
    suspend fun deleteSamples()

    @Query("SELECT COUNT(*) FROM beans")
    suspend fun count(): Int
}

@Dao
interface BrewDao {
    @Query("SELECT * FROM brews WHERE beanId = :beanId ORDER BY dateMillis DESC")
    fun observeByBean(beanId: String): Flow<List<BrewEntity>>

    @Query("SELECT * FROM brews WHERE beanId = :beanId ORDER BY dateMillis DESC")
    suspend fun listByBean(beanId: String): List<BrewEntity>

    @Query("SELECT * FROM brews ORDER BY dateMillis DESC")
    suspend fun listAll(): List<BrewEntity>

    @Query("SELECT * FROM brews ORDER BY dateMillis DESC")
    fun observeAll(): Flow<List<BrewEntity>>

    @Query("SELECT * FROM brews ORDER BY dateMillis DESC LIMIT 1")
    suspend fun latest(): BrewEntity?

    @Query("SELECT * FROM brews WHERE id = :id")
    suspend fun getById(id: String): BrewEntity?

    @Query("SELECT * FROM brews WHERE id = :id")
    fun observeById(id: String): Flow<BrewEntity?>

    @Upsert
    suspend fun upsert(brew: BrewEntity)

    @Query("DELETE FROM brews WHERE id = :id")
    suspend fun deleteById(id: String)

    @Query("UPDATE brews SET stockDeductedG = :deductedG WHERE id = :id")
    suspend fun updateStockDeducted(id: String, deductedG: Double?)

    @Query("SELECT COUNT(*) FROM brews")
    suspend fun count(): Int
}

@Dao
interface TastingDao {
    @Query("SELECT * FROM tastings WHERE beanId = :beanId ORDER BY dateMillis ASC")
    fun observeByBean(beanId: String): Flow<List<TastingEntity>>

    @Query("SELECT * FROM tastings WHERE beanId = :beanId ORDER BY dateMillis ASC")
    suspend fun listByBean(beanId: String): List<TastingEntity>

    @Query("SELECT * FROM tastings WHERE brewId = :brewId LIMIT 1")
    suspend fun getByBrewId(brewId: String): TastingEntity?

    @Query("SELECT * FROM tastings WHERE id = :id")
    suspend fun getById(id: String): TastingEntity?

    @Upsert
    suspend fun upsert(tasting: TastingEntity)

    @Query("DELETE FROM tastings WHERE id = :id")
    suspend fun deleteById(id: String)

    @Query("DELETE FROM tastings WHERE brewId = :brewId")
    suspend fun deleteByBrewId(brewId: String)

    @Query("SELECT * FROM tastings")
    suspend fun listAll(): List<TastingEntity>
}

@Dao
interface PhaseRuleDao {
    @Query("SELECT * FROM phase_rules")
    fun observeAll(): Flow<List<PhaseRuleEntity>>

    @Query("SELECT * FROM phase_rules")
    suspend fun listAll(): List<PhaseRuleEntity>

    @Query("SELECT * FROM phase_rules WHERE roastLevelRaw = :roastLevel")
    suspend fun get(roastLevel: String): PhaseRuleEntity?

    @Upsert
    suspend fun upsert(rule: PhaseRuleEntity)

    @Query("DELETE FROM phase_rules")
    suspend fun deleteAll()
}

@Dao
interface PhaseReminderDao {
    @Query("SELECT * FROM phase_reminders WHERE beanId = :beanId")
    fun observeByBean(beanId: String): Flow<List<PhaseReminderEntity>>

    @Query("SELECT * FROM phase_reminders")
    suspend fun listAll(): List<PhaseReminderEntity>

    @Upsert
    suspend fun upsert(reminder: PhaseReminderEntity)

    @Query("DELETE FROM phase_reminders WHERE beanId = :beanId")
    suspend fun deleteByBean(beanId: String)

    @Query("DELETE FROM phase_reminders")
    suspend fun deleteAll()
}

@Dao
interface RecordDao {
    @Transaction
    @Query("SELECT * FROM records ORDER BY createdAtMillis DESC")
    fun observeAll(): Flow<List<RecordWithTags>>

    @Transaction
    @Query("SELECT * FROM records WHERE id = :id")
    fun observeById(id: String): Flow<RecordWithTags?>

    @Transaction
    @Query("SELECT * FROM records WHERE id = :id")
    suspend fun getById(id: String): RecordWithTags?

    @Query("SELECT * FROM records ORDER BY createdAtMillis DESC")
    suspend fun listAll(): List<RecordEntity>

    @Query("SELECT * FROM records WHERE canonicalURL = :canonical AND carrierRaw = 'link' LIMIT 1")
    suspend fun findByCanonicalURL(canonical: String): RecordEntity?

    @Query("SELECT * FROM records ORDER BY createdAtMillis DESC LIMIT 1")
    suspend fun latest(): RecordEntity?

    @Upsert
    suspend fun upsert(record: RecordEntity)

    @Query("DELETE FROM records WHERE id = :id")
    suspend fun deleteById(id: String)

    @Query("DELETE FROM records WHERE isSample = 1")
    suspend fun deleteSamples()

    @Query("SELECT COUNT(*) FROM records")
    suspend fun count(): Int

    @Transaction
    @Query(
        """
        SELECT DISTINCT records.* FROM records
        INNER JOIN record_tag_links ON record_tag_links.recordId = records.id
        WHERE record_tag_links.tagId = :tagId
        ORDER BY records.createdAtMillis DESC
        """,
    )
    fun observeByTag(tagId: String): Flow<List<RecordWithTags>>
}

@Dao
interface RecordTagDao {
    @Query("SELECT * FROM record_tags ORDER BY createdAtMillis ASC")
    fun observeAll(): Flow<List<RecordTagEntity>>

    @Query(
        """
        SELECT t.id AS id, t.name AS name, t.createdAtMillis AS createdAtMillis,
               t.updatedAtMillis AS updatedAtMillis,
               COUNT(l.recordId) AS recordCount
        FROM record_tags t
        LEFT JOIN record_tag_links l ON l.tagId = t.id
        GROUP BY t.id
        ORDER BY t.createdAtMillis ASC
        """,
    )
    fun observeAllWithCount(): Flow<List<RecordTagWithCount>>

    @Query("SELECT * FROM record_tags ORDER BY createdAtMillis ASC")
    suspend fun listAll(): List<RecordTagEntity>

    @Query("SELECT * FROM record_tags WHERE id = :id")
    suspend fun getById(id: String): RecordTagEntity?

    @Query("SELECT * FROM record_tags WHERE name = :name LIMIT 1")
    suspend fun findByName(name: String): RecordTagEntity?

    @Upsert
    suspend fun upsert(tag: RecordTagEntity)

    @Query("DELETE FROM record_tags WHERE id = :id")
    suspend fun deleteById(id: String)

    @Query("SELECT COUNT(*) FROM record_tags")
    suspend fun count(): Int
}

@Dao
interface RecordTagLinkDao {
    @Insert(onConflict = androidx.room.OnConflictStrategy.IGNORE)
    suspend fun insert(link: RecordTagLinkEntity)

    @Query("DELETE FROM record_tag_links WHERE recordId = :recordId")
    suspend fun deleteByRecord(recordId: String)

    @Query("DELETE FROM record_tag_links WHERE tagId = :tagId AND recordId = :recordId")
    suspend fun delete(recordId: String, tagId: String)

    @Query("SELECT COUNT(*) FROM record_tag_links WHERE tagId = :tagId")
    suspend fun countForTag(tagId: String): Int
}

@Dao
interface CanvasDao {
    @Query("SELECT * FROM canvases ORDER BY updatedAtMillis DESC")
    fun observeAll(): Flow<List<CanvasEntity>>

    @Query("SELECT * FROM canvases ORDER BY updatedAtMillis DESC")
    suspend fun listAll(): List<CanvasEntity>

    @Query("SELECT * FROM canvases WHERE id = :id")
    fun observeById(id: String): Flow<CanvasEntity?>

    @Query("SELECT * FROM canvases WHERE id = :id")
    suspend fun getById(id: String): CanvasEntity?

    @Upsert
    suspend fun upsert(canvas: CanvasEntity)

    @Query("DELETE FROM canvases WHERE id = :id")
    suspend fun deleteById(id: String)

    @Query("DELETE FROM canvases WHERE isSample = 1")
    suspend fun deleteSamples()
}

/** 画布节点 + 它引用的那条记录。节点只存摆放关系，内容永远从 Record 读。 */
data class CanvasNodeWithRecord(
    @Embedded val node: CanvasNodeEntity,
    @Relation(parentColumn = "recordId", entityColumn = "id")
    val record: RecordEntity?,
)

@Dao
interface CanvasNodeDao {
    @Query("SELECT * FROM canvas_nodes WHERE canvasId = :canvasId ORDER BY zIndex ASC, createdAtMillis ASC")
    fun observeByCanvas(canvasId: String): Flow<List<CanvasNodeEntity>>

    @Transaction
    @Query("SELECT * FROM canvas_nodes WHERE canvasId = :canvasId ORDER BY zIndex ASC, createdAtMillis ASC")
    fun observeNodesWithRecord(canvasId: String): Flow<List<CanvasNodeWithRecord>>

    @Query("SELECT * FROM canvas_nodes WHERE canvasId = :canvasId ORDER BY zIndex ASC, createdAtMillis ASC")
    suspend fun listByCanvas(canvasId: String): List<CanvasNodeEntity>

    @Query("SELECT * FROM canvas_nodes WHERE canvasId = :canvasId AND recordId = :recordId LIMIT 1")
    suspend fun find(canvasId: String, recordId: String): CanvasNodeEntity?

    @Query("SELECT * FROM canvas_nodes WHERE id = :id")
    suspend fun getById(id: String): CanvasNodeEntity?

    @Query("SELECT MAX(zIndex) FROM canvas_nodes WHERE canvasId = :canvasId")
    suspend fun maxZIndex(canvasId: String): Int?

    @Upsert
    suspend fun upsert(node: CanvasNodeEntity)

    @Query("DELETE FROM canvas_nodes WHERE id = :id")
    suspend fun deleteById(id: String)

    @Query("DELETE FROM canvas_nodes WHERE canvasId = :canvasId AND recordId = :recordId")
    suspend fun deleteByRecord(canvasId: String, recordId: String)

    @Query("DELETE FROM canvas_nodes WHERE recordId = :recordId")
    suspend fun deleteByRecordId(recordId: String)

    @Query("SELECT * FROM canvas_nodes")
    suspend fun listAll(): List<CanvasNodeEntity>
}

@Dao
interface NotificationStateDao {
    @Query("SELECT * FROM notification_state")
    suspend fun listAll(): List<NotificationStateEntity>

    @Upsert
    suspend fun upsert(state: NotificationStateEntity)

    @Query("DELETE FROM notification_state WHERE beanId = :beanId")
    suspend fun deleteByBean(beanId: String)

    @Query("DELETE FROM notification_state")
    suspend fun deleteAll()
}
