import type { Db } from '../database/client'
import type {
  BookmarkImportResult,
  BookmarkNode,
  BookmarkPreview,
  BookmarkPreviewRoot,
  BookmarkTree,
  ChromeDetection
} from '../../shared/contracts/bookmarks'
import { detectChrome, readChromeBookmarks } from './chrome-bookmarks'
import { countBookmarks, importChromeBookmarks, readBookmarkTree } from './bookmark-store'

/**
 * 书签导入的**唯一主进程入口**，IPC 只转交到这里。
 *
 * 三件事分开：检测（只读目录）、预览（解析但不写库）、导入（解析 + 合并写库）。
 * 预览与导入都重新读一次文件，不复用上一次检测的结果——用户可能在这之间
 * 改过 Chrome 的书签，也可能中途关掉了 Chrome。
 */
export class BookmarkService {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  detect(): ChromeDetection {
    return detectChrome()
  }

  tree(): BookmarkTree {
    return readBookmarkTree(this.db)
  }

  preview(profileId: string): BookmarkPreview {
    const read = readChromeBookmarks(profileId)
    if (!read.ok) return { ok: false, reason: read.reason }

    const roots: BookmarkPreviewRoot[] = read.parsed.roots.map((root) => ({
      kind: root.kind,
      bookmarks: countBookmarks(root.children),
      folders: countFolders(root.children)
    }))

    return {
      ok: true,
      profileId,
      profileName: read.profileName,
      roots,
      bookmarks: read.parsed.bookmarks,
      folders: read.parsed.folders,
      skipped: read.parsed.skipped
    }
  }

  import(profileId: string): BookmarkImportResult {
    const read = readChromeBookmarks(profileId)
    if (!read.ok) return { ok: false, reason: read.reason }

    const merged = importChromeBookmarks(this.db, {
      profileId,
      profileName: read.profileName,
      roots: read.parsed.roots,
      skipped: read.parsed.skipped
    })

    return { ok: true, ...merged }
  }
}

function countFolders(nodes: readonly BookmarkNode[]): number {
  let total = 0
  for (const node of nodes) {
    if (node.kind !== 'folder') continue
    total += 1 + countFolders(node.children)
  }
  return total
}
