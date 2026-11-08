import type { Database } from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { WipeResult } from '../../shared/contracts'
import { mediaFilePath } from '../media/store'

/**
 * 清空「同步实体」：记录、标签、画布，以及这些记录引用的媒体文件。
 *
 * **边界是产品决定，不是实现细节**：豆子 / 冲煮 / 品鉴 / 阶段规则只属于这台
 * Mac，手机配对与否都不该动它们。所以这里不做「恢复出厂」，只撤掉从手机
 * 同步过来的那部分内容。
 *
 * 与删除单条记录一样，数据与状态必须一起走：基线、冲突、拒绝记录、变更流水
 * 里凡是属于这些实体的行，留着只会让下一次同步对着不存在的数据做裁决。
 */

/** 同步侧的实体类型（与 SyncService 的 TABLE_FOR_CONFLICT 保持同一套名字）。 */
const SYNC_ENTITY_TYPES = ['record', 'recordTag', 'recordTagLink', 'canvas', 'canvasNode'] as const

const inClause = (values: readonly string[]): string => values.map(() => '?').join(', ')

export async function wipeSyncedData(sqlite: Database): Promise<WipeResult> {
  // 文件名必须在删库之前取：records 删完就不知道要清哪些文件了。
  const mediaNames = collectMediaNames(sqlite)

  const counts = sqlite.transaction(() => {
    const count = (table: string): number =>
      Number((sqlite.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n)

    const snapshot = {
      records: count('records'),
      tags: count('record_tags'),
      canvases: count('canvases')
    }

    // 1) 同步状态先清：冲突/拒绝/基线都是对着旧数据的裁决结果。
    sqlite.prepare('delete from sync_conflicts').run()
    sqlite.prepare('delete from sync_rejected').run()
    sqlite
      .prepare(`delete from sync_baseline where entity_type in (${inClause(SYNC_ENTITY_TYPES)})`)
      .run(...SYNC_ENTITY_TYPES)
    sqlite
      .prepare(`delete from change_log where entity_type in (${inClause(SYNC_ENTITY_TYPES)})`)
      .run(...SYNC_ENTITY_TYPES)

    // 2) 数据：显式按依赖顺序删，不依赖 foreign_keys pragma 当前是否开着。
    sqlite.prepare('delete from record_metadata').run()
    sqlite.prepare('delete from record_tag_links').run()
    sqlite.prepare('delete from record_tags').run()
    sqlite.prepare('delete from canvas_nodes').run()
    sqlite.prepare('delete from canvas_strokes').run()
    sqlite.prepare('delete from canvases').run()
    sqlite.prepare('delete from records').run()

    return snapshot
  })()

  const mediaFiles = await deleteMediaFiles(mediaNames)
  return { ...counts, mediaFiles }
}

/** 记录引用的展示图与封面（含缩略图的后缀变体）。 */
function collectMediaNames(sqlite: Database): string[] {
  const rows = sqlite
    .prepare('select media_path, preview_path from records')
    .all() as Array<{ media_path: string | null; preview_path: string | null }>
  const names = new Set<string>()
  for (const row of rows) {
    for (const value of [row.media_path, row.preview_path]) {
      const name = (value ?? '').trim()
      if (name) names.add(name)
    }
  }
  return [...names]
}

/**
 * 删文件失败不影响清空结果：库已经清了，留下几个孤儿文件比让整个操作失败好。
 * 缩略图是 `<base>_thumb.jpg`（见 media/store.ts），主文件删了它也没人引用。
 */
async function deleteMediaFiles(names: string[]): Promise<number> {
  let deleted = 0
  for (const name of names) {
    const candidates = [name]
    const parsed = path.parse(name)
    if (!parsed.name.endsWith('_thumb')) candidates.push(`${parsed.name}_thumb${parsed.ext}`)

    for (const candidate of candidates) {
      try {
        await fs.unlink(mediaFilePath(candidate))
        deleted += 1
      } catch {
        // 不存在 / 名字不合法：两种都只是「没有这个文件」，忽略。
      }
    }
  }
  return deleted
}
