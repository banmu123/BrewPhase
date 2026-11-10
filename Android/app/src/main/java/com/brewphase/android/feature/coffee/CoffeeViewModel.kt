package com.brewphase.android.feature.coffee

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.brewphase.android.app.AppContainer
import com.brewphase.android.core.DateMath
import com.brewphase.android.data.repository.BeanRepository
import com.brewphase.android.data.repository.BrewRepository
import com.brewphase.android.domain.engine.PhaseEngine
import com.brewphase.android.domain.engine.PhaseReading
import com.brewphase.android.domain.model.BeanSnapshot
import com.brewphase.android.domain.model.BeanStatus
import com.brewphase.android.domain.model.BrewRecord
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn

data class CoffeeBeanItem(
    val bean: BeanSnapshot,
    val reading: PhaseReading,
    val latestBrew: BrewRecord?,
    val brewsCount: Int,
)

data class CoffeeUiState(
    val active: List<CoffeeBeanItem> = emptyList(),
    val finished: List<CoffeeBeanItem> = emptyList(),
    val loading: Boolean = true,
)

/**
 * 豆仓首页的状态。
 *
 * 排序不是"按创建时间倒序"，而是按**这包豆现在有多该被喝**：黄金期与衰减期在前，
 * 养豆中的在后；同一阶段里烘焙得越早越靠前。库存归零或标记喝完的归到"已喝完"，
 * 但永远不隐藏——历史仍然要能被翻到。
 */
class CoffeeViewModel(
    beanRepository: BeanRepository,
    brewRepository: BrewRepository,
) : ViewModel() {

    val state: StateFlow<CoffeeUiState> = combine(
        beanRepository.observeBeans(),
        beanRepository.observeRuleBook(),
        brewRepository.observeAllBrews(),
    ) { beans, rules, brews ->
        val today = DateMath.today()
        val byBean = brews.groupBy { it.beanId }

        val items = beans.map { bean ->
            CoffeeBeanItem(
                bean = bean,
                reading = PhaseEngine.reading(bean, rules[bean.roastLevel], today),
                latestBrew = byBean[bean.id]?.maxByOrNull { it.dateMillis },
                brewsCount = byBean[bean.id]?.size ?: 0,
            )
        }

        val active = items
            .filter { it.bean.status == BeanStatus.Active && it.bean.remainingG > 0 }
            .sortedWith(
                compareByDescending<CoffeeBeanItem> { it.reading.phase.order }
                    .thenBy { it.bean.roastDate ?: java.time.LocalDate.MAX },
            )

        val finished = items
            .filterNot { it.bean.status == BeanStatus.Active && it.bean.remainingG > 0 }
            .sortedByDescending { it.bean.updatedAtMillis }

        CoffeeUiState(active = active, finished = finished, loading = false)
    }.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5_000),
        initialValue = CoffeeUiState(),
    )

    companion object {
        fun factory(container: AppContainer) = viewModelFactory {
            initializer { CoffeeViewModel(container.beanRepository, container.brewRepository) }
        }
    }
}
