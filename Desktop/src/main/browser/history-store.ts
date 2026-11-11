import type { Db } from '../database/client'
import { readState, writeState } from '../database/client'
import {
  BROWSER_RECENT_LIMIT,
  browserBoundsSchema,
  browserVisitSchema,
  type BrowserBounds,
  type BrowserState,
  type BrowserVisit
} from '../../shared/contracts/browser'
import { normalizeBrowserURL } from '../../shared/browser-url'

/**
 * 浏览器本地状态（**只进 local_state，不进业务库、不进同步**）。
 *
 * 这里存的三样东西都不是用户内容：浮窗长在哪、上次看了哪一页、最近看过哪几页。
 * Cookie / LocalStorage / 登录态由 Chromium 的 `persist:brewphase-browser`
 * 分区自己落盘，应用层**不读、不导出、不上传**。
 */
const LAYOUT_KEY = 'browser.layout'
const RECENT_KEY = 'browser.recent'

export function readBrowserLayout(db: Db): BrowserBounds | null {
  const raw = readState(db, LAYOUT_KEY)
  if (!raw) return null
  try {
    const parsed = browserBoundsSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function writeBrowserLayout(db: Db, bounds: BrowserBounds): void {
  writeState(db, LAYOUT_KEY, JSON.stringify(bounds))
}

export function readBrowserRecent(db: Db): BrowserVisit[] {
  const raw = readState(db, RECENT_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const visits: BrowserVisit[] = []
    for (const item of parsed) {
      const visit = browserVisitSchema.safeParse(item)
      if (visit.success) visits.push(visit.data)
    }
    return visits.slice(0, BROWSER_RECENT_LIMIT)
  } catch {
    return []
  }
}

/**
 * 记一条访问：同一地址提到最前（不产生重复条目），最多留 8 条。
 * 标题留空是允许的——很多页面在 `did-navigate` 时还没有 title，后续
 * `page-title-updated` 会补一次（见 BrowserManager）。
 */
export function recordBrowserVisit(db: Db, url: string, title: string): BrowserVisit[] {
  const normalized = normalizeBrowserURL(url)
  if (!normalized) return readBrowserRecent(db)

  const existing = readBrowserRecent(db).filter((visit) => visit.url !== normalized)
  const next: BrowserVisit[] = [
    { url: normalized, title: title.trim(), visitedAt: Date.now() },
    ...existing
  ].slice(0, BROWSER_RECENT_LIMIT)
  writeState(db, RECENT_KEY, JSON.stringify(next))
  return next
}

/** 只更新某条访问的标题（页面 title 晚于导航到达时用）。 */
export function retitleBrowserVisit(db: Db, url: string, title: string): BrowserVisit[] {
  const normalized = normalizeBrowserURL(url)
  if (!normalized || !title.trim()) return readBrowserRecent(db)
  const recent = readBrowserRecent(db)
  const index = recent.findIndex((visit) => visit.url === normalized)
  if (index === -1) return recent
  const current = recent[index]!
  if (current.title === title.trim()) return recent
  recent[index] = { ...current, title: title.trim() }
  writeState(db, RECENT_KEY, JSON.stringify(recent))
  return recent
}

export function readBrowserLastVisit(db: Db): BrowserVisit | null {
  return readBrowserRecent(db)[0] ?? null
}
