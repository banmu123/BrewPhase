/**
 * RecordInspector 的**编辑态合并**（纯函数，可单测）。
 *
 * 背景：元数据是异步补全的。抓取完成后 Records 列表会重新加载，同一条记录的
 * `title` 从空变成「拿到了的真实标题」；而 Inspector 的本地 state 只在
 * `item.id` 变化时才重置——于是输入框还空着，用户随便改个别处再保存，
 * 就把自动补全的标题覆盖成空字符串。
 *
 * 规则（用户永远赢）：
 * - 记录切换（`item.id` 变化）→ 全部字段重置、dirty 清零；
 * - 同一条记录 → **未被用户改过的字段**跟随 `item` 同步；改过的字段一律保留
 *   用户当前输入（异步结果不得覆盖）；
 * - 保存成功 → 只清除「本次提交的那个值仍然没变」的字段 dirty（见
 *   `markInspectorFieldsSaved`）：既让后续外部更新能进来，又不会把保存期间
 *   用户刚敲进去的新内容当成已保存；
 * - 内容没变化时返回原对象引用，避免每次列表刷新都触发一次重渲染。
 */

export type InspectorSource = {
  id: string
  title: string
  note: string
  urlString: string
  tagIds: string[]
}

export type InspectorForm = InspectorSource & {
  /** 用户是否手动改过该字段：改过就不再被异步元数据覆盖 */
  titleDirty: boolean
  noteDirty: boolean
  urlDirty: boolean
  tagsDirty: boolean
}

export function createInspectorForm(item: InspectorSource): InspectorForm {
  return {
    id: item.id,
    title: item.title,
    note: item.note,
    urlString: item.urlString,
    tagIds: [...item.tagIds],
    titleDirty: false,
    noteDirty: false,
    urlDirty: false,
    tagsDirty: false
  }
}

function sameIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

export function mergeInspectorItem(form: InspectorForm, item: InspectorSource): InspectorForm {
  if (item.id !== form.id) return createInspectorForm(item)

  const next: InspectorForm = {
    ...form,
    title: form.titleDirty ? form.title : item.title,
    note: form.noteDirty ? form.note : item.note,
    urlString: form.urlDirty ? form.urlString : item.urlString,
    tagIds: form.tagsDirty ? form.tagIds : item.tagIds
  }
  const unchanged =
    next.title === form.title &&
    next.note === form.note &&
    next.urlString === form.urlString &&
    sameIds(next.tagIds, form.tagIds)
  return unchanged ? form : next
}

/** 用户改字段：一并把对应 dirty 标记置位。 */
export function editField<K extends 'title' | 'note' | 'urlString'>(
  form: InspectorForm,
  field: K,
  value: string
): InspectorForm {
  const flag = field === 'title' ? 'titleDirty' : field === 'note' ? 'noteDirty' : 'urlDirty'
  return { ...form, [field]: value, [flag]: true }
}

export function editTags(form: InspectorForm, tagIds: string[]): InspectorForm {
  return { ...form, tagIds, tagsDirty: true }
}

/** 保存请求发出时的字段快照：用来判断「请求期间用户有没有又改过」。 */
export type InspectorSnapshot = InspectorSource

export function snapshotInspector(form: InspectorForm): InspectorSnapshot {
  return {
    id: form.id,
    title: form.title,
    note: form.note,
    urlString: form.urlString,
    tagIds: [...form.tagIds]
  }
}

/**
 * 保存**成功**后调用：清除本次提交且之后没再被改动的字段 dirty 标记。
 *
 * - 只清 `dirty = true` 且「当前值 == 提交时的值」的字段：请求期间用户又敲了
 *   新内容（当前值 != 快照）时，那个字段必须继续保持 dirty，否则随后的
 *   `mergeInspectorItem` 会用库里的旧值把它冲掉；
 * - 记录已经切换（id 不同）→ 原样返回，别去动另一条记录的编辑态；
 * - 保存失败**不要调用**本函数：dirty 与用户输入原样保留，重试仍然成立。
 */
export function markInspectorFieldsSaved(
  form: InspectorForm,
  submitted: InspectorSnapshot
): InspectorForm {
  if (form.id !== submitted.id) return form

  const next: InspectorForm = {
    ...form,
    titleDirty: form.title === submitted.title ? false : form.titleDirty,
    noteDirty: form.note === submitted.note ? false : form.noteDirty,
    urlDirty: form.urlString === submitted.urlString ? false : form.urlDirty,
    tagsDirty: sameIds(form.tagIds, submitted.tagIds) ? false : form.tagsDirty
  }
  const unchanged =
    next.titleDirty === form.titleDirty &&
    next.noteDirty === form.noteDirty &&
    next.urlDirty === form.urlDirty &&
    next.tagsDirty === form.tagsDirty
  return unchanged ? form : next
}
