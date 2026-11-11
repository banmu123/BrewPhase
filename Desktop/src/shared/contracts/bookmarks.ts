import { z } from 'zod'

/**
 * Chrome 书签导入的共享契约。
 *
 * 三条边界：
 * 1. **只读**：Chrome 的 `Local State` / `Bookmarks` 只读不写，BrewPhase 的
 *    书签是另一份数据，二者不共享存储、不共享 Session；
 * 2. **不进同步**：书签只写 `local_state`（`browser.bookmarks.v1`），没有新的
 *    SQLite 业务表、不写 `change_log`、不上传；
 * 3. **渲染层看不到路径**：IPC 只接受 Chrome 的 Profile 目录名（白名单校验），
 *    User Data 的位置由主进程自己解析，渲染层拿不到任何文件系统入口。
 */

export const BOOKMARK_TREE_VERSION = 1
/** `local_state` 里的键。带版本号，结构变更时可以并存而不是原地猜。 */
export const BOOKMARK_STORAGE_KEY = 'browser.bookmarks.v1'

export const BOOKMARK_ROOT_KINDS = ['bookmark_bar', 'other', 'synced'] as const
export type BookmarkRootKind = (typeof BOOKMARK_ROOT_KINDS)[number]

/** Chrome Profile 目录名只可能是 Default / Profile N；这也是路径白名单。 */
export const CHROME_PROFILE_ID_PATTERN = /^(?:Default|Profile [0-9]{1,3})$/

export type BookmarkItem = {
  kind: 'bookmark'
  /** 稳定 ID：`chrome:<profile>:g:<guid>` / `:i:<chrome id>` / `:h:<hash>`。 */
  id: string
  title: string
  url: string
  /** 能正确换算时才写入（Chrome 的 date_added 是 1601 起的微秒）。 */
  createdAt?: number
  sourceProfile: string
  sourceProfileName: string
  /** Chrome 原始节点 ID，便于排查；不参与界面展示。 */
  chromeId?: string
  guid?: string
}

export type BookmarkFolder = {
  kind: 'folder'
  id: string
  title: string
  children: BookmarkNode[]
  createdAt?: number
  sourceProfile: string
  sourceProfileName: string
  chromeId?: string
  guid?: string
}

export type BookmarkNode = BookmarkItem | BookmarkFolder

export type BookmarkRoot = {
  kind: BookmarkRootKind
  id: string
  /** Chrome 里的原始名称（书签栏 / 其他书签 / 移动设备书签）。界面按 kind 翻译。 */
  title: string
  sourceProfile: string
  sourceProfileName: string
  children: BookmarkNode[]
}

export type BookmarkTree = {
  version: number
  updatedAt: number
  roots: BookmarkRoot[]
}

const bookmarkItemSchema: z.ZodType<BookmarkItem> = z.object({
  kind: z.literal('bookmark'),
  id: z.string().min(1).max(200),
  title: z.string().max(1_024),
  url: z.string().max(8_192),
  createdAt: z.number().int().nonnegative().optional(),
  sourceProfile: z.string().min(1).max(64),
  sourceProfileName: z.string().max(256),
  chromeId: z.string().max(64).optional(),
  guid: z.string().max(64).optional()
})

const bookmarkFolderSchema: z.ZodType<BookmarkFolder> = z.lazy(() =>
  z.object({
    kind: z.literal('folder'),
    id: z.string().min(1).max(200),
    title: z.string().max(1_024),
    // 深递归的 Chrome 书签树：Zod 本身没有深度上限，这里靠数据结构自身收敛。
    children: z.array(bookmarkNodeSchema).max(20_000),
    createdAt: z.number().int().nonnegative().optional(),
    sourceProfile: z.string().min(1).max(64),
    sourceProfileName: z.string().max(256),
    chromeId: z.string().max(64).optional(),
    guid: z.string().max(64).optional()
  })
)

const bookmarkNodeSchema: z.ZodType<BookmarkNode> = z.lazy(() =>
  z.union([bookmarkItemSchema, bookmarkFolderSchema])
)

const bookmarkRootSchema: z.ZodType<BookmarkRoot> = z.object({
  kind: z.enum(BOOKMARK_ROOT_KINDS),
  id: z.string().min(1).max(200),
  title: z.string().max(1_024),
  sourceProfile: z.string().min(1).max(64),
  sourceProfileName: z.string().max(256),
  children: z.array(bookmarkNodeSchema).max(20_000)
})

export const bookmarkTreeSchema: z.ZodType<BookmarkTree> = z.object({
  version: z.number().int().positive(),
  updatedAt: z.number().int().nonnegative(),
  roots: z.array(bookmarkRootSchema).max(64)
})

// MARK: - Chrome 检测

export type ChromeProfile = {
  /** 目录名：Default / Profile 1 / Profile 2… */
  id: string
  /** `Local State` 里的可读名称；缺失时用目录名。 */
  name: string
  /** 该 Profile 下是否存在 Bookmarks 文件。 */
  bookmarksAvailable: boolean
}

export type ChromeDetection = {
  found: boolean
  profiles: ChromeProfile[]
  /** `found = false` 时的原因；界面据此给出不同文案。 */
  reason: 'not-installed' | 'no-profiles' | null
}

// MARK: - 预览与导入

export type BookmarkPreviewRoot = {
  kind: BookmarkRootKind
  bookmarks: number
  folders: number
}

export type BookmarkPreviewFailure =
  | 'profile-not-found'
  | 'bookmarks-missing'
  | 'unreadable'
  | 'corrupt'

export type BookmarkPreview =
  | {
      ok: true
      profileId: string
      profileName: string
      roots: BookmarkPreviewRoot[]
      bookmarks: number
      folders: number
      /** 因协议不安全或结构不认识而跳过的条目数。 */
      skipped: number
    }
  | { ok: false; reason: BookmarkPreviewFailure }

export type BookmarkImportResult =
  | {
      ok: true
      /** 新增书签数（文件夹不计入）。 */
      added: number
      /** 名称或地址发生变化的书签数。 */
      updated: number
      /** 解析阶段跳过的条目数。 */
      skipped: number
      /** 导入后这棵书签树里的书签总数。 */
      total: number
    }
  | { ok: false; reason: BookmarkPreviewFailure }

/**
 * IPC 只接受 Profile 目录名，不接受路径。
 * 正则同时挡住 `..`、绝对路径和分隔符。
 */
export const chromeProfileRequestSchema = z.object({
  profileId: z.string().min(1).max(64).regex(CHROME_PROFILE_ID_PATTERN)
})
