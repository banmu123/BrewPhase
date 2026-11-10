package com.brewphase.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.brewphase.android.navigation.BrewPhaseApp
import com.brewphase.android.ui.theme.BrewPhaseTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val container = (application as BrewPhaseApplication).container
        setContent {
            BrewPhaseTheme {
                BrewPhaseApp(container = container)
            }
        }
    }
}
