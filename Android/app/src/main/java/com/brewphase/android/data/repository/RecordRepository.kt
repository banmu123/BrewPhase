package com.brewphase.android.data.repository

import androidx.room.withTransaction
import com.brewphase.android.data.local.CanvasEntity
import com.brewphase.android.data.local.CanvasNodeEntity
import com.brewphase.android.data.local.CanvasNodeWithRecord
import com.brewphase.android.data.local.RecordEntity
import com.brewphase.android.data.local.RecordTagEntity
import com.brewphase.android.data.local.RecordTagLinkEntity
import com.brewphase.android.data.local.RecordTagWithCount
import com.brewphase.android.data.local.RecordWithTags
import com.brewphase.android.data.local.BrewPhaseDatabase
import com.brewphase.android.domain.engine.LinkResolver
import com.brewphase.android.domain.model.LinkContentKind
import com.brewphase.android.domain.model.LinkProvider
import com.brewphase.android.domain.model.RecordCarrier
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import java.util.UUID

data class RecordDraft(
    val carrier: RecordCarrier = RecordCarrier.Text,
    val title: String = "",
    val note: String = "",
    val urlString: String = "",
    val sourceName: String = "",
    val previewPath: String? = null,
    val mediaPath: String? = null,
)

/** 重复链接：同一条规范地址已经有一条记录。 */
class DuplicateRecordException(val existingId: String) : Exception("duplicate record")

/**
 * Records 的读写门面。
 *
 * 标签不是固定分类，而是用户自定义的多对多关系：删除标签只解除关系，
 * 绝不带走记录。
 */
class RecordRepository(private val db: BrewPhaseDatabase) {

    private val recordDao = db.recordDao()
    private val tagDao = db.recordTagDao()
    private val linkDao = db.recordTagLinkDao()

    fun observeRecords(): Flow<List<RecordWithTags>> = recordDao.observeAll()

    fun observeRecord(id: String): Flow<RecordWithTags?> = recordDao.observeById(id)

    fun observeTags(): Flow<List<RecordTagWithCount>> = tagDao.observeAllWithCount()

    suspend fun getRecord(id: String): RecordWithTags? = recordDao.getById(id)

    suspend fun saveRecord(
        draft: RecordDraft,
        existingId: String? = null,
        tagIds: List<String> = emptyList(),
    ): Result<String> = runCatching {
        val now = System.currentTimeMillis()
        val existing = existingId?.let { recordDao.getById(it)?.record }

        // 链接：识别出来的平台与内容 ID 是事实，写进记录；播放地址不落库。
        val match = if (draft.carrier == RecordCarrier.Link) {
            LinkResolver.match(draft.urlString)
        } else {
            null
        }

        if (draft.carrier == RecordCarrier.Link) {
            if (match == null) throw IllegalArgumentException("not a valid link")
            val duplicate = recordDao.findByCanonicalURL(match.canonicalURL)
            if (duplicate != null && duplicate.id != existingId) {
                throw DuplicateRecordException(duplicate.id)
            }
        }

        val entity = RecordEntity(
            id = existing?.id ?: UUID.randomUUID().toString(),
            carrierRaw = draft.carrier.raw,
            urlString = match?.originalURL ?: draft.urlString.trim(),
            sourceName = existing?.sourceName?.takeIf { it.isNotBlank() } ?: draft.sourceName.trim(),
            previewPath = draft.previewPath ?: existing?.previewPath,
            mediaPath = draft.mediaPath ?: existing?.mediaPath,
            canonicalURL = match?.canonicalURL ?: existing?.canonicalURL ?: "",
            providerRaw = match?.provider?.raw ?: existing?.providerRaw ?: LinkProvider.Generic.raw,
            contentKindRaw = match?.contentKind?.raw ?: existing?.contentKindRaw ?: LinkContentKind.Webpage.raw,
            platformContentID = match?.platformContentID ?: existing?.platformContentID ?: "",
            linkPage = match?.page ?: existing?.linkPage ?: 1,
            authorName = existing?.authorName ?: "",
            summary = existing?.summary ?: "",
            thumbnailURLString = existing?.thumbnailURLString ?: "",
            metadataStatusRaw = existing?.metadataStatusRaw ?: "idle",
            repositoryStars = existing?.repositoryStars ?: 0,
            repositoryForks = existing?.repositoryForks ?: 0,
            repositoryIssues = existing?.repositoryIssues ?: 0,
            repositoryLanguage = existing?.repositoryLanguage ?: "",
            repositoryLicense = existing?.repositoryLicense ?: "",
            title = draft.title.trim(),
            note = draft.note.trim(),
            createdAtMillis = existing?.createdAtMillis ?: now,
            updatedAtMillis = now,
            isSample = existing?.isSample ?: false,
        )

        db.withTransaction {
            recordDao.upsert(entity)
            // 标签关系整体替换：先清后插，语义是"这条记录现在挂这些标签"。
            linkDao.deleteByRecord(entity.id)
            tagIds.distinct().forEach { tagId ->
                linkDao.insert(RecordTagLinkEntity(recordId = entity.id, tagId = tagId))
            }
        }
        entity.id
    }

    suspend fun deleteRecord(id: String): Result<Unit> = runCatching {
        // 外键 CASCADE 会带走标签关系与画布节点；原始媒体文件由 MediaStore 清理。
        recordDao.deleteById(id)
    }

    /** 所有被记录引用的媒体文件名。清理孤儿文件时用它做白名单。 */
    suspend fun allMediaNames(): Set<String> =
        recordDao.listAll().flatMap { listOfNotNull(it.mediaPath, it.previewPath) }.toSet()

    /** 按规范地址查重；没有则返回 null。 */
    suspend fun findDuplicateLink(rawURL: String): RecordEntity? {
        val match = LinkResolver.match(rawURL) ?: return null
        return recordDao.findByCanonicalURL(match.canonicalURL)
    }

    // MARK: - 标签

    suspend fun createTag(name: String): Result<String> = runCatching {
        val trimmed = name.trim()
        require(trimmed.isNotEmpty()) { "tag name empty" }
        tagDao.findByName(trimmed)?.let { throw DuplicateRecordException(it.id) }
        val now = System.currentTimeMillis()
        val entity = RecordTagEntity(
            id = UUID.randomUUID().toString(),
            name = trimmed,
            createdAtMillis = now,
            updatedAtMillis = now,
        )
        tagDao.upsert(entity)
        entity.id
    }

    suspend fun renameTag(id: String, name: String): Result<Unit> = runCatching {
        val trimmed = name.trim()
        require(trimmed.isNotEmpty()) { "tag name empty" }
        val existing = tagDao.getById(id) ?: return@runCatching
        tagDao.findByName(trimmed)?.let {
            if (it.id != id) throw DuplicateRecordException(it.id)
        }
        tagDao.upsert(existing.copy(name = trimmed, updatedAtMillis = System.currentTimeMillis()))
    }

    suspend fun deleteTag(id: String): Result<Unit> = runCatching {
        tagDao.deleteById(id)
    }

    /**
     * 六个建议标签只在「一条记录都没有、一个标签都没有」时播种。
     *
     * 用户主动删光标签之后，下次启动不该又被塞回来——那是把用户的决定当成没发生。
     */
    suspend fun seedSuggestedTagsIfPristine() {
        if (tagDao.count() > 0 || recordDao.count() > 0) return
        val now = System.currentTimeMillis()
        SUGGESTED_TAGS.forEachIndexed { index, name ->
            tagDao.upsert(
                RecordTagEntity(
                    id = UUID.randomUUID().toString(),
                    name = name,
                    createdAtMillis = now + index,
                    updatedAtMillis = now + index,
                ),
            )
        }
    }

    companion object {
        val SUGGESTED_TAGS = listOf("到访", "视频", "文章", "开发", "随记", "人生")
    }
}

/** 画布上的一屏内容：节点 + 它引用的记录。 */
data class CanvasNodeView(
    val node: CanvasNodeEntity,
    val record: RecordEntity?,
)

data class CanvasDraft(
    val name: String = "",
    val note: String = "",
)

/**
 * Canvas：画布与摆放。
 *
 * 节点只保存「放在哪、多大、第几层、这块画布上写了什么」，**不复制记录内容**。
 * 所以删节点永远不碰记录，删画布也不碰记录；反过来删记录会带走它的所有节点，
 * 因为一个指向不存在记录的卡片没有意义。
 */
class CanvasRepository(private val db: BrewPhaseDatabase) {

    private val canvasDao = db.canvasDao()
    private val nodeDao = db.canvasNodeDao()
    private val recordDao = db.recordDao()

    fun observeCanvases(): Flow<List<CanvasEntity>> = canvasDao.observeAll()

    fun observeCanvas(id: String): Flow<CanvasEntity?> = canvasDao.observeById(id)

    fun observeNodes(canvasId: String): Flow<List<CanvasNodeView>> =
        nodeDao.observeNodesWithRecord(canvasId).map { list ->
            list.map { CanvasNodeView(it.node, it.record) }
        }

    suspend fun saveCanvas(draft: CanvasDraft, existingId: String? = null): Result<String> = runCatching {
        val now = System.currentTimeMillis()
        val existing = existingId?.let { canvasDao.getById(it) }
        val entity = existing?.copy(
            name = draft.name.trim(),
            note = draft.note.trim(),
            updatedAtMillis = now,
        ) ?: CanvasEntity(
            id = UUID.randomUUID().toString(),
            name = draft.name.trim(),
            note = draft.note.trim(),
            createdAtMillis = now,
            updatedAtMillis = now,
            isSample = false,
        )
        canvasDao.upsert(entity)
        entity.id
    }

    suspend fun deleteCanvas(id: String): Result<Unit> = runCatching {
        // 节点由外键 CASCADE 清掉；原始记录一律保留。
        canvasDao.deleteById(id)
    }

    /** 把一条记录放进画布。同一块画布上同一条记录只允许一个节点。 */
    suspend fun addRecord(
        canvasId: String,
        recordId: String,
        positionX: Double,
        positionY: Double,
        width: Double = 220.0,
        height: Double = 180.0,
    ): Result<String> = runCatching {
        nodeDao.find(canvasId, recordId)?.let { throw DuplicateRecordException(it.id) }
        recordDao.getById(recordId) ?: throw IllegalStateException("record not found")
        val now = System.currentTimeMillis()
        val z = (nodeDao.maxZIndex(canvasId) ?: 0) + 1
        val entity = CanvasNodeEntity(
            id = UUID.randomUUID().toString(),
            canvasId = canvasId,
            recordId = recordId,
            positionX = positionX,
            positionY = positionY,
            width = width,
            height = height,
            zIndex = z,
            annotation = "",
            createdAtMillis = now,
            updatedAtMillis = now,
        )
        nodeDao.upsert(entity)
        entity.id
    }

    /** 拖动：写成**世界坐标**，不是屏幕坐标。 */
    suspend fun moveNode(nodeId: String, x: Double, y: Double): Result<Unit> = runCatching {
        val node = nodeDao.getById(nodeId) ?: return@runCatching
        nodeDao.upsert(node.copy(positionX = x, positionY = y, updatedAtMillis = System.currentTimeMillis()))
    }

    suspend fun updateAnnotation(nodeId: String, annotation: String): Result<Unit> = runCatching {
        val node = nodeDao.getById(nodeId) ?: return@runCatching
        nodeDao.upsert(node.copy(annotation = annotation.trim(), updatedAtMillis = System.currentTimeMillis()))
    }

    suspend fun bringToFront(nodeId: String): Result<Unit> = runCatching {
        val node = nodeDao.getById(nodeId) ?: return@runCatching
        val z = (nodeDao.maxZIndex(node.canvasId) ?: 0) + 1
        nodeDao.upsert(node.copy(zIndex = z, updatedAtMillis = System.currentTimeMillis()))
    }

    /** 从画布移除节点：只删摆放关系，记录本身不动。 */
    suspend fun removeNode(nodeId: String): Result<Unit> = runCatching {
        nodeDao.deleteById(nodeId)
    }

    suspend fun listNodes(canvasId: String): List<CanvasNodeEntity> = nodeDao.listByCanvas(canvasId)
}
