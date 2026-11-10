package com.brewphase.android.feature.records

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.brewphase.android.app.AppContainer
import com.brewphase.android.data.local.RecordTagWithCount
import com.brewphase.android.data.local.RecordWithTags
import com.brewphase.android.data.local.displayTitle
import com.brewphase.android.data.repository.RecordRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class RecordsUiState(
    val records: List<RecordWithTags> = emptyList(),
    val tags: List<RecordTagWithCount> = emptyList(),
    val selectedTagId: String? = null,
    val query: String = "",
    val loading: Boolean = true,
)

/**
 * 记录库的状态。
 *
 * 搜索是常驻的：它不是一个需要点开的页面，而是列表的一部分。过滤放在内存里做，
 * 因为这个库是"一个人的记录"，不是十万行的后台表——换来的是一次输入立刻出结果。
 */
class RecordsViewModel(private val repository: RecordRepository) : ViewModel() {

    private val query = MutableStateFlow("")
    private val selectedTag = MutableStateFlow<String?>(null)

    val state: StateFlow<RecordsUiState> = combine(
        repository.observeRecords(),
        repository.observeTags(),
        query,
        selectedTag,
    ) { records, tags, q, tagId ->
        val trimmed = q.trim()
        val filtered = records.filter { item ->
            val byTag = tagId == null || item.tags.any { it.id == tagId }
            if (!byTag) return@filter false
            if (trimmed.isEmpty()) return@filter true
            val haystack = buildString {
                append(item.record.displayTitle()).append(' ')
                append(item.record.note).append(' ')
                append(item.record.summary).append(' ')
                append(item.record.sourceName).append(' ')
                append(item.tags.joinToString(" ") { it.name })
            }
            haystack.contains(trimmed, ignoreCase = true)
        }
        RecordsUiState(
            records = filtered,
            tags = tags,
            selectedTagId = tagId,
            query = q,
            loading = false,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), RecordsUiState())

    fun setQuery(value: String) {
        query.value = value
    }

    fun selectTag(id: String?) {
        selectedTag.value = id
    }

    fun ensureSuggestedTags() = viewModelScope.launch {
        repository.seedSuggestedTagsIfPristine()
    }

    fun delete(recordId: String, onDone: () -> Unit = {}) = viewModelScope.launch {
        repository.deleteRecord(recordId)
        onDone()
    }

    fun createTag(name: String) = viewModelScope.launch {
        repository.createTag(name)
    }

    fun deleteTag(id: String) = viewModelScope.launch {
        repository.deleteTag(id)
    }

    companion object {
        fun factory(container: AppContainer) = viewModelFactory {
            initializer { RecordsViewModel(container.recordRepository) }
        }
    }
}
