package com.brewphase.android

import android.app.Application
import com.brewphase.android.app.AppContainer

class BrewPhaseApplication : Application() {

    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        container.reminderScheduler.ensureChannel()
    }
}
