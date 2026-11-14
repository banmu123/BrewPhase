import { eq, and } from 'drizzle-orm'
import type { Db } from '../client'
import { roundtablePanels } from '../schema'

/**
 * 圆桌自由布局的持久化（Phase 4.2 workspace，migration 11）。
 *
 * 坐标是**工作区局部坐标**（相对圆桌工作区左上角，不是屏幕绝对坐标）——
 * 恢复时按工作区尺寸 clamp 适配，换显示器 / 调窗口都不会把面板丢出可达范围。
 * tabId 是唯一身份；圆桌关闭布局保留，标签关闭时由视图管理器清行。
 */

export type RoundtablePanelRow = {
  roundtableId: string
  tabId: string
  /** 面板对应的网页地址（重启后幽灵面板「重新打开」用）。 */
  url: string
  x: number
  y: number
  width: number
  height: number
  zIndex: number
  updatedAt: number
}

export function selectRoundtablePanels(db: Db, roundtableId: string): RoundtablePanelRow[] {
  const rows = db
    .select()
    .from(roundtablePanels)
    .where(eq(roundtablePanels.roundtableId, roundtableId))
    .all()
  return rows.map((row) => ({
    roundtableId: row.roundtableId,
    tabId: row.tabId,
    url: row.url,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    zIndex: row.zIndex,
    updatedAt: row.updatedAt
  }))
}

export function upsertRoundtablePanel(db: Db, panel: RoundtablePanelRow): void {
  db.insert(roundtablePanels)
    .values({
      roundtableId: panel.roundtableId,
      tabId: panel.tabId,
      url: panel.url,
      x: Math.round(panel.x),
      y: Math.round(panel.y),
      width: Math.round(panel.width),
      height: Math.round(panel.height),
      zIndex: panel.zIndex,
      updatedAt: panel.updatedAt
    })
    .onConflictDoUpdate({
      target: [roundtablePanels.roundtableId, roundtablePanels.tabId],
      set: {
        url: panel.url,
        x: Math.round(panel.x),
        y: Math.round(panel.y),
        width: Math.round(panel.width),
        height: Math.round(panel.height),
        zIndex: panel.zIndex,
        updatedAt: panel.updatedAt
      }
    })
    .run()
}

export function deleteRoundtablePanel(db: Db, roundtableId: string, tabId: string): boolean {
  const result = db
    .delete(roundtablePanels)
    .where(and(eq(roundtablePanels.roundtableId, roundtableId), eq(roundtablePanels.tabId, tabId)))
    .run()
  return result.changes > 0
}
