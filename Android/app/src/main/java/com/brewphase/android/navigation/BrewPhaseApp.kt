package com.brewphase.android.navigation

import androidx.compose.foundation.layout.padding
import androidx.compose.ui.unit.dp
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Coffee
import androidx.compose.material.icons.outlined.GridView
import androidx.compose.material.icons.outlined.Layers
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.brewphase.android.R
import com.brewphase.android.app.AppContainer
import com.brewphase.android.domain.model.RecordCarrier
import com.brewphase.android.feature.bean.BeanDetailScreen
import com.brewphase.android.feature.bean.BeanEditorScreen
import com.brewphase.android.feature.brew.BrewEditorScreen
import com.brewphase.android.feature.canvas.CanvasListScreen
import com.brewphase.android.feature.canvas.CanvasWorkspaceScreen
import com.brewphase.android.feature.coffee.CoffeeScreen
import com.brewphase.android.feature.insights.InsightsScreen
import com.brewphase.android.feature.records.RecordDetailScreen
import com.brewphase.android.feature.records.RecordEditorScreen
import com.brewphase.android.feature.records.RecordsScreen
import com.brewphase.android.feature.settings.SettingsScreen
import com.brewphase.android.ui.theme.BpColors

private data class TabSpec(val labelRes: Int, val icon: ImageVector)

/**
 * 三个一级入口：咖啡 / 记录 / 画布。设置、洞察、问答都是二级页面，不占 Tab。
 */
@Composable
fun BrewPhaseApp(container: AppContainer) {
    val nav = rememberNavController()

    NavHost(navController = nav, startDestination = "home") {
        composable("home") { HomeTabs(container, nav) }

        composable(
            route = "bean/{beanId}",
            arguments = listOf(navArgument("beanId") { type = NavType.StringType }),
        ) { entry ->
            val beanId = entry.arguments?.getString("beanId").orEmpty()
            BeanDetailScreen(
                container = container,
                beanId = beanId,
                onBack = { nav.popBackStack() },
                onEdit = { nav.navigate("beanEditor?beanId=$it") },
                onLogBrew = { nav.navigate("brew/$it?quick=true") },
                onDeleted = { nav.popBackStack() },
                onAsk = { nav.navigate("ask?beanId=$it") },
            )
        }

        composable(
            route = "beanEditor?beanId={beanId}",
            arguments = listOf(
                navArgument("beanId") {
                    type = NavType.StringType
                    nullable = true
                    defaultValue = null
                },
            ),
        ) { entry ->
            BeanEditorScreen(
                container = container,
                beanId = entry.arguments?.getString("beanId"),
                onBack = { nav.popBackStack() },
                onSaved = { nav.popBackStack() },
            )
        }

        composable(
            route = "brew/{beanId}?brewId={brewId}&quick={quick}",
            arguments = listOf(
                navArgument("beanId") { type = NavType.StringType },
                navArgument("brewId") {
                    type = NavType.StringType
                    nullable = true
                    defaultValue = null
                },
                navArgument("quick") {
                    type = NavType.BoolType
                    defaultValue = false
                },
            ),
        ) { entry ->
            BrewEditorScreen(
                container = container,
                beanId = entry.arguments?.getString("beanId").orEmpty(),
                brewId = entry.arguments?.getString("brewId"),
                quick = entry.arguments?.getBoolean("quick") ?: false,
                onBack = { nav.popBackStack() },
                onSaved = { nav.popBackStack() },
            )
        }

        composable(
            route = "record/{recordId}",
            arguments = listOf(navArgument("recordId") { type = NavType.StringType }),
        ) { entry ->
            RecordDetailScreen(
                container = container,
                recordId = entry.arguments?.getString("recordId").orEmpty(),
                onBack = { nav.popBackStack() },
                onEdit = {
                    nav.navigate("recordEditor?recordId=${entry.arguments?.getString("recordId")}")
                },
                onDeleted = { nav.popBackStack() },
            )
        }

        composable(
            route = "recordEditor?recordId={recordId}&carrier={carrier}",
            arguments = listOf(
                navArgument("recordId") {
                    type = NavType.StringType
                    nullable = true
                    defaultValue = null
                },
                navArgument("carrier") {
                    type = NavType.StringType
                    nullable = true
                    defaultValue = null
                },
            ),
        ) { entry ->
            val carrier = entry.arguments?.getString("carrier")?.let { raw ->
                RecordCarrier.entries.firstOrNull { it.raw == raw }
            }
            RecordEditorScreen(
                container = container,
                recordId = entry.arguments?.getString("recordId"),
                carrier = carrier,
                onBack = { nav.popBackStack() },
                onSaved = { id ->
                    nav.popBackStack()
                    nav.navigate("record/$id") { launchSingleTop = true }
                },
            )
        }

        composable(
            route = "canvas/{canvasId}",
            arguments = listOf(navArgument("canvasId") { type = NavType.StringType }),
        ) { entry ->
            CanvasWorkspaceScreen(
                container = container,
                canvasId = entry.arguments?.getString("canvasId").orEmpty(),
                onBack = { nav.popBackStack() },
                onOpenRecord = { nav.navigate("record/$it") },
            )
        }

        composable("settings") {
            SettingsScreen(container = container, onBack = { nav.popBackStack() })
        }

        composable("insights") {
            InsightsScreen(container = container, onBack = { nav.popBackStack() })
        }

        composable(
            route = "ask?beanId={beanId}",
            arguments = listOf(
                navArgument("beanId") {
                    type = NavType.StringType
                    nullable = true
                    defaultValue = null
                },
            ),
        ) { entry ->
            com.brewphase.android.feature.ask.AskScreen(
                container = container,
                beanId = entry.arguments?.getString("beanId"),
                onBack = { nav.popBackStack() },
            )
        }
    }
}

@Composable
private fun HomeTabs(container: AppContainer, nav: NavHostController) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    val tabs = listOf(
        TabSpec(R.string.tab_coffee, Icons.Outlined.Coffee),
        TabSpec(R.string.tab_records, Icons.Outlined.GridView),
        TabSpec(R.string.tab_canvas, Icons.Outlined.Layers),
    )

    Scaffold(
        containerColor = BpColors.Paper,
        bottomBar = {
            NavigationBar(containerColor = BpColors.Card, tonalElevation = 0.dp) {
                tabs.forEachIndexed { index, spec ->
                    NavigationBarItem(
                        selected = tab == index,
                        onClick = { tab = index },
                        icon = { Icon(spec.icon, contentDescription = stringResource(spec.labelRes)) },
                        label = { Text(stringResource(spec.labelRes)) },
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = BpColors.Espresso,
                            selectedTextColor = BpColors.Espresso,
                            unselectedIconColor = BpColors.InkFaint,
                            unselectedTextColor = BpColors.InkFaint,
                            indicatorColor = BpColors.Well,
                        ),
                    )
                }
            }
        },
    ) { padding ->
        androidx.compose.foundation.layout.Box(Modifier.padding(padding)) {
            when (tab) {
                0 -> CoffeeScreen(
                    container = container,
                    onOpenBean = { nav.navigate("bean/$it") },
                    onAddBean = { nav.navigate("beanEditor") },
                    onOpenInsights = { nav.navigate("insights") },
                    onOpenSettings = { nav.navigate("settings") },
                )
                1 -> RecordsScreen(
                    container = container,
                    onOpenRecord = { nav.navigate("record/$it") },
                    onAddRecord = { carrier ->
                        nav.navigate("recordEditor?carrier=${carrier?.raw ?: ""}")
                    },
                    onOpenSettings = { nav.navigate("settings") },
                )
                else -> CanvasListScreen(
                    container = container,
                    onOpenCanvas = { nav.navigate("canvas/$it") },
                )
            }
        }
    }
}
