package com.brewphase.android.data.local

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * Room 实体与 iOS SwiftData 模型的字段映射。
 *
 * 三条贯穿全表的约定：
 * 1. **主键就是 iOS 的业务 UUID 字符串**，同步时原样保留，绝不重新生成。
 * 2. 时间一律 `Long`（epoch milliseconds），与同步协议一致，不用秒。
 * 3. 枚举存 `*Raw` 字符串，未知值有回退的余地——和 iOS 存 rawValue 同理。
 *
 * 字段清单的依据是 `BrewPhase/Models` 下的 Swift 模型文件，逐字段见
 * `docs/DATA_MODEL_MAPPING.md`。
 */

@Entity(
    tableName = "beans",
    indices = [Index("statusRaw"), Index("isSample")],
)
data class BeanEntity(
    @PrimaryKey val id: String,
    val name: String,
    val roaster: String,
    val origin: String,
    val process: String,
    val roastLevelRaw: String,
    /** 烘焙日当天 00:00 的 epoch millis；null 表示没填。 */
    val roastDateMillis: Long?,
    val purchaseDateMillis: Long?,
    val openDateMillis: Long?,
    val weightG: Double,
    val remainingG: Double,
    val price: Double,
    val channel: String,
    val imagePath: String?,
    /** iOS 用 U+001F 连接；保持同一编码，跨端备份才能互通。 */
    val flavorTagsRaw: String,
    val notes: String,
    val statusRaw: String,
    val createdAtMillis: Long,
    val updatedAtMillis: Long,
    /** 最近一次人工盘点的时刻；早于它的冲煮不再参与自动退粉。 */
    val stockCountedAtMillis: Long?,
    val isSample: Boolean,
)

@Entity(
    tableName = "brews",
    foreignKeys = [
        ForeignKey(
            entity = BeanEntity::class,
            parentColumns = ["id"],
            childColumns = ["beanId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index("beanId"), Index("dateMillis")],
)
data class BrewEntity(
    @PrimaryKey val id: String,
    val beanId: String,
    val dateMillis: Long,
    val method: String,
    val grinder: String,
    val grindSize: String,
    val waterTemp: Double,
    val coffeeG: Double,
    val waterG: Double,
    val timeSeconds: Int,
    val score: Int,
    val acidity: Int,
    val sweetness: Int,
    val bitterness: Int,
    val body: Int,
    val aftertaste: Int,
    val flavorTagsRaw: String,
    val notes: String,
    val createdAtMillis: Long,
    /** 当时**实际**扣掉的克数；null = 旧记录，删除时按 coffeeG 退。 */
    val stockDeductedG: Double?,
)

@Entity(
    tableName = "tastings",
    foreignKeys = [
        ForeignKey(
            entity = BeanEntity::class,
            parentColumns = ["id"],
            childColumns = ["beanId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index("beanId"), Index("brewId"), Index("dateMillis")],
)
data class TastingEntity(
    @PrimaryKey val id: String,
    val beanId: String,
    val dateMillis: Long,
    /** 创建时冻结的"烘焙后第几天"，只在豆子已不在时兜底。 */
    val dayAfterRoast: Int,
    val flavorTagsRaw: String,
    val score: Int,
    val notes: String,
    val sourceRaw: String,
    /** 冲煮镜像指向的那条冲煮；手动记录为 null。 */
    val brewId: String?,
    val createdAtMillis: Long,
)

/**
 * 阶段规则。主键是烘焙度而不是 UUID——同一档规则在 iOS、Desktop、Android 上
 * 必须是同一条，拿数据库 UUID 对齐会在第二台设备上直接分叉。
 */
@Entity(tableName = "phase_rules")
data class PhaseRuleEntity(
    @PrimaryKey val roastLevelRaw: String,
    val restMinDays: Int,
    val restMaxDays: Int,
    val peakStartDay: Int,
    val peakEndDay: Int,
    val declineStartDay: Int,
    val enabled: Boolean,
)

/**
 * 提醒。跨端只同步"意图"（什么时候该提醒哪包豆），通知 ID 由每台设备自己生成。
 */
@Entity(
    tableName = "phase_reminders",
    foreignKeys = [
        ForeignKey(
            entity = BeanEntity::class,
            parentColumns = ["id"],
            childColumns = ["beanId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index("beanId"), Index("kindRaw")],
)
data class PhaseReminderEntity(
    @PrimaryKey val id: String,
    val beanId: String,
    val kindRaw: String,
    val scheduledAtMillis: Long,
    val enabled: Boolean,
    val lastFiredAtMillis: Long?,
)

@Entity(
    tableName = "records",
    indices = [Index("carrierRaw"), Index("createdAtMillis"), Index("isSample"), Index("canonicalURL")],
)
data class RecordEntity(
    @PrimaryKey val id: String,
    val carrierRaw: String,
    val urlString: String,
    val sourceName: String,
    val previewPath: String?,
    val mediaPath: String?,
    val canonicalURL: String,
    val providerRaw: String,
    val contentKindRaw: String,
    val platformContentID: String,
    val linkPage: Int,
    val authorName: String,
    val summary: String,
    val thumbnailURLString: String,
    val metadataStatusRaw: String,
    val repositoryStars: Int,
    val repositoryForks: Int,
    val repositoryIssues: Int,
    val repositoryLanguage: String,
    val repositoryLicense: String,
    val title: String,
    val note: String,
    val createdAtMillis: Long,
    val updatedAtMillis: Long,
    val isSample: Boolean,
)

@Entity(tableName = "record_tags", indices = [Index(value = ["name"], unique = true)])
data class RecordTagEntity(
    @PrimaryKey val id: String,
    val name: String,
    val createdAtMillis: Long,
    val updatedAtMillis: Long,
)

/**
 * 记录与标签的多对多。
 *
 * 复合主键 `(recordId, tagId)` 就是协议里的确定性标识 `recordId:tagId`：
 * 同步时不需要额外找一个代理 ID，也就不会在两台设备上各生一个。
 */
@Entity(
    tableName = "record_tag_links",
    primaryKeys = ["recordId", "tagId"],
    foreignKeys = [
        ForeignKey(
            entity = RecordEntity::class,
            parentColumns = ["id"],
            childColumns = ["recordId"],
            onDelete = ForeignKey.CASCADE,
        ),
        ForeignKey(
            entity = RecordTagEntity::class,
            parentColumns = ["id"],
            childColumns = ["tagId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index("tagId")],
)
data class RecordTagLinkEntity(
    val recordId: String,
    val tagId: String,
)

@Entity(tableName = "canvases", indices = [Index("isSample")])
data class CanvasEntity(
    @PrimaryKey val id: String,
    val name: String,
    val note: String,
    val createdAtMillis: Long,
    val updatedAtMillis: Long,
    val isSample: Boolean,
)

/**
 * 画布节点：只是**摆放**，不复制记录内容。
 *
 * 坐标是世界坐标，不是屏幕坐标——换手机、换缩放后节点必须还在原地。
 * `(canvasId, recordId)` 唯一：同一条记录在同一块画布上只该有一个位置。
 */
@Entity(
    tableName = "canvas_nodes",
    foreignKeys = [
        ForeignKey(
            entity = CanvasEntity::class,
            parentColumns = ["id"],
            childColumns = ["canvasId"],
            onDelete = ForeignKey.CASCADE,
        ),
        ForeignKey(
            entity = RecordEntity::class,
            parentColumns = ["id"],
            childColumns = ["recordId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index(value = ["canvasId", "recordId"], unique = true), Index("recordId")],
)
data class CanvasNodeEntity(
    @PrimaryKey val id: String,
    val canvasId: String,
    val recordId: String,
    val positionX: Double,
    val positionY: Double,
    val width: Double,
    val height: Double,
    val zIndex: Int,
    val annotation: String,
    val createdAtMillis: Long,
    val updatedAtMillis: Long,
)

/** 通知渠道与调度用的本地记录，不参与同步。 */
@Entity(tableName = "notification_state")
data class NotificationStateEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "kindRaw") val kindRaw: String,
    val beanId: String,
    val androidNotificationId: Int,
    val scheduledAtMillis: Long,
)
