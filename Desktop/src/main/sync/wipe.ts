import type { Database } from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { WipeResult } from '../../shared/contracts'
import { mediaFilePath } from '../media/store'

/**
 * 清空「同步内容」：记录、标签、画布、媒体文件，以及**全部咖啡数据**
 * （豆子 / 冲煮 / 品鉴，连带每支豆子的阶段提醒）。
 *
 * 2026-11-09 起咖啡并入清空（产品决定）：咖啡本来就会从 iPhone 同步过来，
 * 「解除配对并清空」如果留着它们，用户会以为清空失败了。代价是 Mac 上
 * 自己录入的咖啡也会被删——所以两端 UI 都必须把这一点写进确认文案，
 * 不允许只说「清空同步内容」。
 *
 * **桌面本地创作同样在清空范围内**（2026-11-11 明确）：Mac 上自己新建的
 * 画布、便签、笔迹，以及在桌面调整过的节点位置都会随画布一起删除。这是
 * 既有的清空边界，本次不改变；但确认文案必须点名，不能只用「画布」概括。
 * 「只撤销授权」与「关闭同步服务」都不调用本函数，本地画布保持原样。
 *
 * 阶段规则（phase_rules）是全局配置而不是数据，保留：删了只会被
 * `seedPhaseRulesIfEmpty` 用默认值填回来。
 *
 * 与删除单条记录一样，数据与状态必须一起走：基线、冲突、拒绝记录、变更流水
 * 里凡是属于这些实体的行，留着只会让下一次同步对着不存在的数据做裁决。
 */

/** 清空涉及的实体类型（与 snapshot-importer 的 TABLE_FOR_ENTITY 保持同一套名字）。 */
const SYNC_ENTITY_TYPES = [
  'record',
  'recordTag',
  'recordTagLink',
  'canvas',
  'canvasNode',
  // 便签/笔迹只在 Desktop 本地创作，但它们会经 recordChange 写 change_log /
  // sync_meta；清空范围既然包含画布，这些指向已删实体的流水也必须一起清掉。
  'canvasNote',
  'canvasStroke',
  'bean',
  'brew',
  'tasting',
  'phaseReminder'
] as const

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
      canvases: count('canvases'),
      beans: count('beans'),
      brews: count('brews'),
      tastings: count('tastings')
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
    //    咖啡侧同样按依赖删：品鉴 → 冲煮 → 提醒 → 豆子。
    //    便签与笔迹是桌面本地创作，也在清空范围内（与确认文案一致）：显式删
    //    canvas_notes，避免只靠外键级联、pragma 一关就留下孤儿便签。
    sqlite.prepare('delete from record_metadata').run()
    sqlite.prepare('delete from record_tag_links').run()
    sqlite.prepare('delete from record_tags').run()
    sqlite.prepare('delete from canvas_nodes').run()
    sqlite.prepare('delete from canvas_notes').run()
    sqlite.prepare('delete from canvas_strokes').run()
    sqlite.prepare('delete from canvases').run()
    sqlite.prepare('delete from records').run()
    sqlite.prepare('delete from tastings').run()
    sqlite.prepare('delete from brews').run()
    sqlite.prepare('delete from phase_reminders').run()
    sqlite.prepare('delete from beans').run()

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
