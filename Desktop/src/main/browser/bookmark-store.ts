import type { Db } from '../database/client'
import { readState, writeState } from '../database/client'
import {
  BOOKMARK_STORAGE_KEY,
  BOOKMARK_TREE_VERSION,
  bookmarkTreeSchema,
  type BookmarkNode,
  type BookmarkRoot,
  type BookmarkTree
} from '../../shared/contracts/bookmarks'

/**
 * BrewPhase 自己的书签库（**只进 local_state**）。
 *
 * 为什么不用业务表：书签是「这台电脑的浏览器配置」，不是需要跨端同步的咖啡
 * 数据。它不进 `change_log`、不进 `sync_meta`，也不会被同步服务读走；清空同步
 * 内容时同样不会碰它。存储形状是一棵保留文件夹层级与顺序的树，而不是扁平列表。
 *
 * 重复导入是**非破坏性合并**：
 * - 同一节点（Profile + Chrome id/guid）更新名称、地址与所在位置；
 * - Chrome 里删掉的书签不会从 BrewPhase 删掉；
 * - 其它 Profile、其它来源的节点原样保留。
 */

const EMPTY_TREE: BookmarkTree = {
  version: BOOKMARK_TREE_VERSION,
  updatedAt: 0,
  roots: []
}

export function readBookmarkTree(db: Db): BookmarkTree {
  const raw = readState(db, BOOKMARK_STORAGE_KEY)
  if (!raw) return EMPTY_TREE

  try {
    const parsed = bookmarkTreeSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) return EMPTY_TREE
    return parsed.data
  } catch {
    // 坏数据不阻塞使用：下一次导入会写入一份新的合法树。
    return EMPTY_TREE
  }
}

export function countBookmarks(nodes: readonly BookmarkNode[]): number {
  let total = 0
  for (const node of nodes) {
    if (node.kind === 'bookmark') total += 1
    else total += countBookmarks(node.children)
  }
  return total
}

export type BookmarkMergeResult = {
  added: number
  updated: number
  skipped: number
  total: number
}

/**
 * 把一次 Chrome 导入合并进本地书签库。
 *
 * 合并按节点 ID：`claimed` 是这次导入覆盖到的全部 ID，用来把「被移动的节点」
 * 从旧父节点摘掉，避免同一书签出现在两个文件夹；不在 `claimed` 里的旧节点
 * 一律保留（对应「Chrome 删除不级联」）。
 */
export function importChromeBookmarks(
  db: Db,
  input: {
    profileId: string
    profileName: string
    roots: BookmarkRoot[]
    skipped: number
  }
): BookmarkMergeResult {
  const tree = readBookmarkTree(db)
  const oldIndex = new Map<string, BookmarkNode>()
  for (const root of tree.roots) indexNodes(root.children, oldIndex)

  const claimed = new Set<string>()
  for (const root of input.roots) collectIDs(root.children, claimed)

  const counters = { added: 0, updated: 0 }
  const merged: BookmarkRoot[] = []
  const existingByID = new Map(tree.roots.map((root) => [root.id, root]))

  // 已有 root 保持原顺序；这次导入没有的 root（另一个 Profile）原样留下。
  for (const root of tree.roots) {
    const next = input.roots.find((candidate) => candidate.id === root.id)
    if (!next) {
      merged.push(root)
      continue
    }
    merged.push({
      ...root,
      title: next.title,
      sourceProfileName: next.sourceProfileName,
      children: mergeChildren(root.children, next.children, oldIndex, claimed, counters)
    })
  }

  for (const next of input.roots) {
    if (existingByID.has(next.id)) continue
    merged.push({
      ...next,
      children: mergeChildren([], next.children, oldIndex, claimed, counters)
    })
  }

  const result: BookmarkTree = {
    version: BOOKMARK_TREE_VERSION,
    updatedAt: Date.now(),
    roots: merged
  }
  writeState(db, BOOKMARK_STORAGE_KEY, JSON.stringify(result))

  return {
    added: counters.added,
    updated: counters.updated,
    skipped: input.skipped,
    total: merged.reduce((sum, root) => sum + countBookmarks(root.children), 0)
  }
}

function mergeChildren(
  existing: BookmarkNode[],
  incoming: BookmarkNode[],
  oldIndex: Map<string, BookmarkNode>,
  claimed: Set<string>,
  counters: { added: number; updated: number }
): BookmarkNode[] {
  const byID = new Map(existing.map((node) => [node.id, node]))
  const handled = new Set<string>()
  const result: BookmarkNode[] = []

  for (const node of incoming) {
    const current = byID.get(node.id)
    handled.add(node.id)

    if (node.kind === 'bookmark') {
      const previous = oldIndex.get(node.id)
      if (!previous) counters.added += 1
      else if (previous.kind !== 'bookmark' || previous.title !== node.title || previous.url !== node.url) {
        counters.updated += 1
      }
      result.push({ ...node })
      continue
    }

    if (current && current.kind !== 'folder') counters.updated += 1
    // 文件夹可能刚从别的父节点移过来：`current` 为空时用旧位置的内容做基准，
    // 这样 Chrome 里已删、但本地还留着的子项不会因为一次移动就丢。
    const previous = oldIndex.get(node.id)
    const baseChildren =
      current && current.kind === 'folder'
        ? current.children
        : previous && previous.kind === 'folder'
          ? previous.children
          : []
    result.push({
      ...node,
      children: mergeChildren(baseChildren, node.children, oldIndex, claimed, counters)
    })
  }

  for (const node of existing) {
    if (handled.has(node.id)) continue
    // 在本次导入的树里但不在这个父节点下：说明被移动到别处，不能保留副本。
    if (claimed.has(node.id)) continue
    result.push(node)
  }

  return result
}

function indexNodes(nodes: readonly BookmarkNode[], index: Map<string, BookmarkNode>): void {
  for (const node of nodes) {
    index.set(node.id, node)
    if (node.kind === 'folder') indexNodes(node.children, index)
  }
}

function collectIDs(nodes: readonly BookmarkNode[], ids: Set<string>): void {
  for (const node of nodes) {
    ids.add(node.id)
    if (node.kind === 'folder') collectIDs(node.children, ids)
  }
}
