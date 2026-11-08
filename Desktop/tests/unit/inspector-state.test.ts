import { describe, expect, it } from 'vitest'
import {
  createInspectorForm,
  editField,
  editTags,
  markInspectorFieldsSaved,
  mergeInspectorItem,
  snapshotInspector,
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

describe('保存成功后清除 dirty（§第五轮 一）', () => {
  /** 走一遍「编辑 → 提交 → 保存成功」的完整纯函数流程。 */
  function saveSucceed(form: ReturnType<typeof createInspectorForm>) {
    const submitted = snapshotInspector(form)
    return markInspectorFieldsSaved(form, submitted)
  }

  it('修改标题并保存 → titleDirty 清除', () => {
    let form = createInspectorForm(source({ title: '' }))
    form = editField(form, 'title', '我的标题')
    const saved = saveSucceed(form)
    expect(saved.titleDirty).toBe(false)
    expect(saved.title).toBe('我的标题')
  })

  it('修改备注并保存 → noteDirty 清除', () => {
    let form = createInspectorForm(source())
    form = editField(form, 'note', '我的备注')
    expect(saveSucceed(form).noteDirty).toBe(false)
  })

  it('修改标签并保存 → tagsDirty 清除', () => {
    let form = createInspectorForm(source({ tagIds: ['tag-a'] }))
    form = editTags(form, ['tag-a', 'tag-b'])
    const saved = saveSucceed(form)
    expect(saved.tagsDirty).toBe(false)
    expect(saved.tagIds).toEqual(['tag-a', 'tag-b'])
  })

  it('保存成功后，同一条记录的外部更新能同步进来', () => {
    let form = createInspectorForm(source({ title: '' }))
    form = editField(form, 'title', '我写的标题')
    // 保存前：外部更新被 dirty 挡住（这是原本就对的保护）
    expect(mergeInspectorItem(form, source({ title: '自动标题' })).title).toBe('我写的标题')
    // 保存后：dirty 已清，外部更新可以进来了
    const saved = saveSucceed(form)
    expect(mergeInspectorItem(saved, source({ title: 'iOS 同步来的新标题' })).title).toBe('iOS 同步来的新标题')
  })

  it('四个字段互不牵连：只清了改过的那些', () => {
    let form = createInspectorForm(source({ title: '原标题', note: '原备注' }))
    form = editField(form, 'title', '新标题')
    const saved = saveSucceed(form)
    expect(saved.titleDirty).toBe(false)
    expect(saved.noteDirty).toBe(false)
    expect(saved.note).toBe('原备注')
  })

  it('保存请求期间又输入 → 新输入与 dirty 都保留', () => {
    let form = createInspectorForm(source({ title: '' }))
    form = editField(form, 'title', '第一次输入')
    const submitted = snapshotInspector(form) // 请求发出
    form = editField(form, 'title', '请求期间又改了') // 用户继续输入
    const afterSave = markInspectorFieldsSaved(form, submitted)
    expect(afterSave.title).toBe('请求期间又改了')
    expect(afterSave.titleDirty).toBe(true)
    // 外部更新仍然不得覆盖这段未保存的输入
    expect(mergeInspectorItem(afterSave, source({ title: '自动标题' })).title).toBe('请求期间又改了')
  })

  it('只有被再次改动的字段保留 dirty，其余字段正常清除', () => {
    let form = createInspectorForm(source({ title: '', note: '' }))
    form = editField(form, 'title', '标题')
    form = editField(form, 'note', '备注')
    const submitted = snapshotInspector(form)
    form = editField(form, 'note', '备注（请求期间又改）')
    const afterSave = markInspectorFieldsSaved(form, submitted)
    expect(afterSave.titleDirty).toBe(false)
    expect(afterSave.noteDirty).toBe(true)
  })

  it('保存失败（不调用本函数）→ dirty 与输入原样保留', () => {
    let form = createInspectorForm(source({ title: '原标题' }))
    form = editField(form, 'title', '用户输入')
    // 保存抛错：组件不会调用 markInspectorFieldsSaved
    const afterFailure = mergeInspectorItem(form, source({ title: '原标题' }))
    expect(afterFailure.title).toBe('用户输入')
    expect(afterFailure.titleDirty).toBe(true)
  })

  it('记录已切换 → 不去动另一条记录的编辑态', () => {
    const form = createInspectorForm(source({ id: 'record-1' }))
    const submitted = snapshotInspector(form)
    const other = createInspectorForm(source({ id: 'record-2', title: '别的记录' }))
    expect(markInspectorFieldsSaved(other, submitted)).toBe(other)
  })

  it('没有变化时返回同一引用（不触发多余重渲染）', () => {
    const form = createInspectorForm(source())
    const saved = markInspectorFieldsSaved(form, snapshotInspector(form))
    expect(saved).toBe(form)
  })
})
