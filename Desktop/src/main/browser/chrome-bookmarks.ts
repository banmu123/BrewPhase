import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  BOOKMARK_ROOT_KINDS,
  CHROME_PROFILE_ID_PATTERN,
  type BookmarkNode,
  type BookmarkPreviewFailure,
  type BookmarkRoot,
  type BookmarkRootKind,
  type ChromeDetection,
  type ChromeProfile
} from '../../shared/contracts/bookmarks'

/**
 * Chrome 书签的**只读**读取与解析。
 *
 * 这个模块只做两件事：找到 Chrome 的 User Data 目录，把 `Bookmarks` 里的
 * 原始 JSON 转成 BrewPhase 的书签树。它不写任何 Chrome 文件、不读 Cookie /
 * 密码 / 历史，也不把数据发到网络。
 *
 * 解析是纯函数（`parseChromeBookmarks`），文件 IO 在 `readChromeBookmarks`
 * 外面一层，测试可以用固定 JSON 直接验解析规则，不依赖本机装没装 Chrome。
 */

/** Chrome 的 `date_added` 是 1601-01-01 起的微秒。 */
const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000

type RawNode = {
  type?: string
  name?: string
  url?: string
  id?: string
  guid?: string
  date_added?: string
  children?: RawNode[]
}

export type ParsedChromeBookmarks = {
  roots: BookmarkRoot[]
  bookmarks: number
  folders: number
  skipped: number
}

export type ChromeBookmarkRead =
  | { ok: true; profileName: string; parsed: ParsedChromeBookmarks }
  | { ok: false; reason: BookmarkPreviewFailure }

/**
 * User Data 目录。`BREWPHASE_CHROME_USER_DATA_DIR` 只用于测试/验收：
 * 渲染层**不能**传路径，IPC 的入参只有 Profile 目录名。
 */
export function chromeUserDataDir(): string | null {
  const override = process.env.BREWPHASE_CHROME_USER_DATA_DIR?.trim()
  if (override) return existsSync(override) ? override : null

  const candidates: string[] = []
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA?.trim()
    if (localAppData) candidates.push(join(localAppData, 'Google', 'Chrome', 'User Data'))
  } else if (process.platform === 'darwin') {
    candidates.push(join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome'))
  } else {
    candidates.push(join(homedir(), '.config', 'google-chrome'))
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

/**
 * 检测 Chrome 与可用 Profile。
 *
 * 优先读 `Local State` 的 `profile.info_cache`（能拿到用户自己起的名字）；
 * 文件缺失或结构异常时降级为扫描目录里的 `Default` / `Profile N`，名称退回
 * 目录名——不因为一个损坏的 JSON 就把整个导入功能判死。
 */
export function detectChrome(): ChromeDetection {
  const root = chromeUserDataDir()
  if (!root) return { found: false, profiles: [], reason: 'not-installed' }

  const named = readProfileInfoCache(root)
  const ids = named.size > 0 ? [...named.keys()] : scanProfileDirs(root)
  const profiles: ChromeProfile[] = ids
    .filter((id) => CHROME_PROFILE_ID_PATTERN.test(id))
    .sort(compareProfileIds)
    .map((id) => ({
      id,
      name: named.get(id) ?? id,
      bookmarksAvailable: existsSync(join(root, id, 'Bookmarks'))
    }))

  if (profiles.length === 0) return { found: false, profiles: [], reason: 'no-profiles' }
  return { found: true, profiles, reason: null }
}

/** 读取并解析某个 Profile 的 Bookmarks。文件只读，失败按类型返回，不抛异常。 */
export function readChromeBookmarks(profileId: string): ChromeBookmarkRead {
  // 双重校验：调用方已过 Zod，这里再挡一次路径穿越。
  if (!CHROME_PROFILE_ID_PATTERN.test(profileId)) return { ok: false, reason: 'profile-not-found' }

  const root = chromeUserDataDir()
  if (!root) return { ok: false, reason: 'profile-not-found' }

  const profileDir = join(root, profileId)
  if (!existsSync(profileDir)) return { ok: false, reason: 'profile-not-found' }

  const profileName = readProfileInfoCache(root).get(profileId) ?? profileId
  const file = join(profileDir, 'Bookmarks')
  if (!existsSync(file)) return { ok: false, reason: 'bookmarks-missing' }

  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    // Chrome 正在写、文件被占用、权限不足都归到这里：提示用户关掉 Chrome 重试。
    return { ok: false, reason: 'unreadable' }
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'corrupt' }
  }

  const parsed = parseChromeBookmarks(json, profileId, profileName)
  if (!parsed) return { ok: false, reason: 'corrupt' }
  return { ok: true, profileName, parsed }
}

/**
 * 原始 JSON → BrewPhase 书签树。
 *
 * 保留：名称、URL、文件夹层级与顺序、空文件夹、Chrome 原始 id/guid、创建时间。
 * 跳过：非 http/https 地址（`javascript:`、`file:`、`chrome:` 等）。
 * 返回 `null` 表示结构不可用（没有 roots 或类型完全不对）。
 */
export function parseChromeBookmarks(
  json: unknown,
  profileId: string,
  profileName: string
): ParsedChromeBookmarks | null {
  if (!json || typeof json !== 'object') return null
  const rootsRaw = (json as { roots?: unknown }).roots
  if (!rootsRaw || typeof rootsRaw !== 'object') return null

  const stats = { bookmarks: 0, folders: 0, skipped: 0 }
  const seen = new Map<string, number>()
  const roots: BookmarkRoot[] = []

  for (const kind of BOOKMARK_ROOT_KINDS) {
    const raw = (rootsRaw as Record<string, unknown>)[kind]
    if (!raw || typeof raw !== 'object') continue
    const node = raw as RawNode
    roots.push({
      kind,
      id: rootId(profileId, kind),
      title: typeof node.name === 'string' && node.name ? node.name : kind,
      sourceProfile: profileId,
      sourceProfileName: profileName,
      children: walk(node.children, profileId, profileName, stats, seen)
    })
  }

  if (roots.length === 0) return null
  return { roots, bookmarks: stats.bookmarks, folders: stats.folders, skipped: stats.skipped }
}

function walk(
  nodes: RawNode[] | undefined,
  profileId: string,
  profileName: string,
  stats: { bookmarks: number; folders: number; skipped: number },
  seen: Map<string, number>
): BookmarkNode[] {
  if (!Array.isArray(nodes)) return []
  const result: BookmarkNode[] = []

  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue
    const title = typeof node.name === 'string' ? node.name : ''

    if (node.type === 'url') {
      const url = safeHTTPURL(node.url)
      if (!url) {
        // 协议不安全或地址无法解析：不导入，但要让用户看到「跳过 N 条」。
        stats.skipped += 1
        continue
      }
      stats.bookmarks += 1
      result.push({
        kind: 'bookmark',
        id: nodeID(profileId, node, title, url, seen),
        title,
        url,
        createdAt: chromeTime(node.date_added),
        sourceProfile: profileId,
        sourceProfileName: profileName,
        chromeId: node.id,
        guid: node.guid
      })
      continue
    }

    if (node.type === 'folder') {
      stats.folders += 1
      result.push({
        kind: 'folder',
        id: nodeID(profileId, node, title, '', seen),
        title,
        children: walk(node.children, profileId, profileName, stats, seen),
        createdAt: chromeTime(node.date_added),
        sourceProfile: profileId,
        sourceProfileName: profileName,
        chromeId: node.id,
        guid: node.guid
      })
      continue
    }

    // 未知节点类型：Chrome 以后可能新增，忽略而不是判整份文件损坏。
  }

  return result
}

/**
 * 稳定节点 ID。
 *
 * 新一代 Chrome 都有 `guid`，老版本只有数字 `id`；两者都缺失时（很旧的
 * 导出文件）用「标题 + 地址」的哈希兜底，同名同址的重复书签加序号区分。
 * Profile 前缀保证同一份 BrewPhase 书签库里多个 Profile 不会互相覆盖。
 */
function nodeID(
  profileId: string,
  raw: RawNode,
  title: string,
  url: string,
  seen: Map<string, number>
): string {
  if (typeof raw.guid === 'string' && raw.guid) return `chrome:${profileId}:g:${raw.guid}`
  if (typeof raw.id === 'string' && raw.id) return `chrome:${profileId}:i:${raw.id}`

  const digest = createHash('sha1').update(`${title}\u0000${url}`).digest('hex').slice(0, 16)
  const base = `chrome:${profileId}:h:${digest}`
  const count = (seen.get(base) ?? 0) + 1
  seen.set(base, count)
  return count === 1 ? base : `${base}:${count}`
}

function rootId(profileId: string, kind: BookmarkRootKind): string {
  return `chrome:${profileId}:root:${kind}`
}

function safeHTTPURL(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.toString()
  } catch {
    return null
  }
}

function chromeTime(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const micros = Number(value)
  if (!Number.isFinite(micros) || micros <= 0) return undefined
  const ms = Math.round(micros / 1000) - CHROME_EPOCH_OFFSET_MS
  return ms > 0 ? ms : undefined
}

function readProfileInfoCache(root: string): Map<string, string> {
  const result = new Map<string, string>()
  const file = join(root, 'Local State')
  if (!existsSync(file)) return result

  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      profile?: { info_cache?: Record<string, unknown> }
    }
    const cache = raw.profile?.info_cache
    if (!cache || typeof cache !== 'object') return result

    for (const [id, value] of Object.entries(cache)) {
      if (!CHROME_PROFILE_ID_PATTERN.test(id)) continue
      const name =
        value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string'
          ? (value as { name: string }).name.trim()
          : ''
      result.set(id, name || id)
    }
  } catch {
    // Local State 损坏：调用方会退回目录扫描。
  }
  return result
}

function scanProfileDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && CHROME_PROFILE_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/** Default 排最前，其余按 Profile 数字升序。 */
function compareProfileIds(a: string, b: string): number {
  if (a === b) return 0
  if (a === 'Default') return -1
  if (b === 'Default') return 1
  const na = Number(a.replace('Profile ', ''))
  const nb = Number(b.replace('Profile ', ''))
  return na - nb
}
