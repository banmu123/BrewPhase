package com.brewphase.android.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration

/**
 * 本地数据库。
 *
 * 迁移政策（与 iOS 一致，且更严格）：**没有破坏性迁移**。
 * 数据库打不开时不能悄悄换成内存库继续接受写入——那等于把用户的数据扔掉还
 * 假装一切正常。`Room.databaseBuilder` 里因此没有
 * `fallbackToDestructiveMigration()`；升级路径只能是一条条写出来的
 * [MIGRATIONS]。房间 schema 导出在 `app/schemas/`，每个版本都要留在版本库里。
 */
@Database(
    entities = [
        BeanEntity::class,
        BrewEntity::class,
        TastingEntity::class,
        PhaseRuleEntity::class,
        PhaseReminderEntity::class,
        RecordEntity::class,
        RecordTagEntity::class,
        RecordTagLinkEntity::class,
        CanvasEntity::class,
        CanvasNodeEntity::class,
        NotificationStateEntity::class,
    ],
    version = BrewPhaseDatabase.VERSION,
    exportSchema = true,
)
abstract class BrewPhaseDatabase : RoomDatabase() {

    abstract fun beanDao(): BeanDao
    abstract fun brewDao(): BrewDao
    abstract fun tastingDao(): TastingDao
    abstract fun phaseRuleDao(): PhaseRuleDao
    abstract fun phaseReminderDao(): PhaseReminderDao
    abstract fun recordDao(): RecordDao
    abstract fun recordTagDao(): RecordTagDao
    abstract fun recordTagLinkDao(): RecordTagLinkDao
    abstract fun canvasDao(): CanvasDao
    abstract fun canvasNodeDao(): CanvasNodeDao
    abstract fun notificationStateDao(): NotificationStateDao

    companion object {
        const val VERSION = 1
        const val NAME = "brewphase.db"

        /**
         * 逐版本迁移。v1 是首个版本，因此为空；加 v2 时必须在这里补一条
         * `Migration(1, 2)`，并同时更新 [VERSION] 与 `app/schemas` 里的导出。
         */
        private val MIGRATIONS: Array<Migration> = arrayOf()

        fun build(context: Context): BrewPhaseDatabase =
            Room.databaseBuilder(context.applicationContext, BrewPhaseDatabase::class.java, NAME)
                .addMigrations(*MIGRATIONS)
                .build()
    }
}
