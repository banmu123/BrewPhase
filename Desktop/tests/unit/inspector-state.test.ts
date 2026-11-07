import { describe, expect, it } from 'vitest'
import {
  createInspectorForm,
  editField,
  editTags,
  mergeInspectorItem,
  type InspectorSource
} from '../../src/renderer/src/features/records/inspector-state'

/**
 * RecordInspector 编辑态合并（§第四轮 二）。
 *
 * 关键场景：异步元数据抓取完成 → 列表重载 → 同一条记录的 title 从空变成
 * 真实标题。未被用户改过的输入框必须跟着更新；用户改过的必须原样保留。
 */

function source(overrides: Partial<InspectorSource> = {}): InspectorSource {
  return {
    id: 'record-1',
    title: '',
    note: '',
    urlString: 'https://github.com/banmu123/BrewPhase',
    tagIds: ['tag-a'],
    ...overrides
  }
}

describe('RecordInspector 自动补全与用户编辑优先级', () => {
  it('自动补全：未编辑的标题跟随 item 更新', () => {
    const form = createInspectorForm(source({ title: '' }))
    const merged = mergeInspectorItem(form, source({ title: 'banmu123/BrewPhase' }))
    expect(merged.title).toBe('banmu123/BrewPhase')
    expect(merged.titleDirty).toBe(false)
  })

  it('用户改过标题：异步补全不得覆盖', () => {
    let form = createInspectorForm(source({ title: '' }))
    form = editField(form, 'title', '我自己写的标题')
    const merged = mergeInspectorItem(form, source({ title: '自动补全的标题' }))
    expect(merged.title).toBe('我自己写的标题')
    expect(merged.titleDirty).toBe(true)
  })

  it('用户改过备注：异步更新不得覆盖', () => {
    let form = createInspectorForm(source())
    form = editField(form, 'note', '我的备注')
    const merged = mergeInspectorItem(form, source({ note: '抓取到的摘要' }))
    expect(merged.note).toBe('我的备注')
  })

  it('用户改过 URL：item.urlString 变化不覆盖输入（用户正在输入）', () => {
    let form = createInspectorForm(source())
    form = editField(form, 'urlString', 'https://www.youtube.com/watch?v=abc')
    const merged = mergeInspectorItem(form, source({ urlString: 'https://github.com/other/repo' }))
    expect(merged.urlString).toBe('https://www.youtube.com/watch?v=abc')
  })

  it('未改过 URL：保存后 item 的新 URL 会同步回输入框', () => {
    const form = createInspectorForm(source())
    const merged = mergeInspectorItem(form, source({ urlString: 'https://www.youtube.com/watch?v=abc' }))
    expect(merged.urlString).toBe('https://www.youtube.com/watch?v=abc')
  })

  it('切换记录：所有编辑状态与 dirty 标记重置', () => {
    let form = createInspectorForm(source())
    form = editField(form, 'title', '上一条的标题')
    form = editField(form, 'note', '上一条的备注')
    form = editTags(form, ['tag-b'])

    const merged = mergeInspectorItem(
      form,
      source({ id: 'record-2', title: '新记录', note: '新备注', urlString: '', tagIds: [] })
    )
    expect(merged.id).toBe('record-2')
    expect(merged.title).toBe('新记录')
    expect(merged.note).toBe('新备注')
    expect(merged.urlString).toBe('')
    expect(merged.tagIds).toEqual([])
    expect(merged.titleDirty).toBe(false)
    expect(merged.noteDirty).toBe(false)
    expect(merged.urlDirty).toBe(false)
    expect(merged.tagsDirty).toBe(false)
  })

  it('内容没变化：返回同一引用（不触发无意义重渲染）', () => {
    const form = createInspectorForm(source({ title: '固定标题' }))
    const merged = mergeInspectorItem(form, source({ title: '固定标题' }))
    expect(merged).toBe(form)
  })

  it('用户勾选的标签不被列表重载冲掉', () => {
    let form = createInspectorForm(source({ tagIds: ['tag-a'] }))
    form = editTags(form, ['tag-a', 'tag-b'])
    const merged = mergeInspectorItem(form, source({ tagIds: ['tag-a'] }))
    expect(merged.tagIds).toEqual(['tag-a', 'tag-b'])
  })

  it('用户没动过标签：item 的标签变化会同步', () => {
    const form = createInspectorForm(source({ tagIds: ['tag-a'] }))
    const merged = mergeInspectorItem(form, source({ tagIds: ['tag-a', 'tag-c'] }))
    expect(merged.tagIds).toEqual(['tag-a', 'tag-c'])
  })

  it('自动补全与用户编辑同时发生：只保留用户那一个字段', () => {
    let form = createInspectorForm(source({ title: '', note: '' }))
    form = editField(form, 'note', '用户备注')
    const merged = mergeInspectorItem(
      form,
      source({ title: '自动标题', note: '抓取摘要' })
    )
    expect(merged.title).toBe('自动标题')
    expect(merged.note).toBe('用户备注')
  })
})
