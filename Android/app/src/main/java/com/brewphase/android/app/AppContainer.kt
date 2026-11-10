package com.brewphase.android.app

import android.content.Context
import com.brewphase.android.data.local.BrewPhaseDatabase
import com.brewphase.android.data.media.MediaStore
import com.brewphase.android.data.repository.BeanRepository
import com.brewphase.android.data.repository.BrewRepository
import com.brewphase.android.data.repository.CanvasRepository
import com.brewphase.android.data.repository.RecordRepository
import com.brewphase.android.data.repository.SettingsRepository
import com.brewphase.android.notifications.ReminderScheduler

/**
 * 手写依赖容器：这个规模的应用不需要一个 DI 框架来承担它的启动成本。
 *
 * 生命周期与 Application 一致；Activity / ViewModel 只拿这里产出的单例。
 */
class AppContainer(context: Context) {

    val database: BrewPhaseDatabase = BrewPhaseDatabase.build(context)

    val beanRepository = BeanRepository(database)
    val brewRepository = BrewRepository(database)
    val recordRepository = RecordRepository(database)
    val canvasRepository = CanvasRepository(database)
    val settingsRepository = SettingsRepository(context)

    val mediaStore = MediaStore(context)
    val reminderScheduler = ReminderScheduler(context, database)
}
