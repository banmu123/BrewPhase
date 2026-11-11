import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../src/main/database/migrations'
import { schema } from '../../src/main/database/schema'
import { readState, type Db } from '../../src/main/database/client'
import type { BookmarkFolder, BookmarkItem, BookmarkNode, BookmarkRoot } from '../../src/shared/contracts/bookmarks'
import {
  countBookmarks,
  importChromeBookmarks,
  readBookmarkTree
} from '../../src/main/browser/bookmark-store'
import { BOOKMARK_STORAGE_KEY } from '../../src/shared/contracts/bookmarks'

/**
 * 本地书签库的合并语义。
 *
 * 重点不是「写进去了」，而是三条不能破的边界：
 * 1. 重复导入不重复生成；
 * 2. Chrome 里删掉的书签不会把本地删掉；
 * 3. 书签只在 `local_state` 里，不进同步日志（change_log / sync_meta）。
 */
describe('bookmark-store', () => {
  let dir = ''
  let sqlite: Database.Database
  let db: Db

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bp-bookmarks-'))
    sqlite = new Database(join(dir, 'brewphase.db'))
    sqlite.pragma('foreign_keys = ON')
    migrate(sqlite)
    db = drizzle(sqlite, { schema })
  })

  afterEach(() => {
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('首次导入写入 local_state，并统计新增书签', () => {
    const result = importChromeBookmarks(db, {
      profileId: 'Default',
      profileName: '个人',
      roots: [root([bookmark('a', 'A', 'https://a.example/'), bookmark('b', 'B', 'https://b.example/')])],
      skipped: 2
    })

    expect(result).toEqual({ added: 2, updated: 0, skipped: 2, total: 2 })
    expect(readState(db, BOOKMARK_STORAGE_KEY)).toBeTruthy()
    expect(readBookmarkTree(db).roots[0]?.children).toHaveLength(2)
  })

  it('重复导入同一份数据不会重复生成', () => {
    const payload = {
      profileId: 'Default',
      profileName: '个人',
      roots: [root([bookmark('a', 'A', 'https://a.example/')])],
      skipped: 0
    }

    importChromeBookmarks(db, payload)
    const second = importChromeBookmarks(db, payload)

    expect(second).toEqual({ added: 0, updated: 0, skipped: 0, total: 1 })
    expect(readBookmarkTree(db).roots[0]?.children).toHaveLength(1)
  })

  it('名称或地址变化计入 updated，并原地更新', () => {
    importChromeBookmarks(db, {
      profileId: 'Default',
      profileName: '个人',
      roots: [root([bookmark('a', '旧名字', 'https://a.example/')])],
      skipped: 0
    })

    const result = importChromeBookmarks(db, {
      profileId: 'Default',
      profileName: '个人',
      roots: [root([bookmark('a', '新名字', 'https://a.example/new')])],
      skipped: 0
    })

    expect(result).toEqual({ added: 0, updated: 1, skipped: 0, total: 1 })
    const item = readBookmarkTree(db).roots[0]?.children[0]
    expect(item?.kind).toBe('bookmark')
    if (item?.kind === 'bookmark') {
      expect(item.title).toBe('新名字')
      expect(item.url).toBe('https://a.example/new')
    }
  })

  it('Chrome 里删掉的书签不会从本地删掉', () => {
    importChromeBookmarks(db, {
      profileId: 'Default',
      profileName: '个人',
      roots: [root([bookmark('a', 'A', 'https://a.example/'), bookmark('b', 'B', 'https://b.example/')])],
      skipped: 0
    })

    const result = importChromeBookmarks(db, {
      profileId: 'Default',
      profileName: '个人',
      roots: [root([bookmark('a', 'A', 'https://a.example/')])],
      skipped: 0
    })

    expect(result.total).toBe(2)
    expect(readBookmarkTree(db).roots[0]?.children.map((node) => node.title)).toEqual(['A', 'B'])
  })

  it('把书签移到另一个文件夹不会留下副本', () => {
    const inTools = root([folder('f1', '工具', [bookmark('a', 'A', 'https://a.example/')])])
    importChromeBookmarks(db, { profileId: 'Default', profileName: '个人', roots: [inTools], skipped: 0 })

    const moved = root([
      folder('f1', '工具', []),
      folder('f2', '稍后读', [bookmark('a', 'A', 'https://a.example/')])
    ])
    const result = importChromeBookmarks(db, { profileId: 'Default', profileName: '个人', roots: [moved], skipped: 0 })

    expect(result.total).toBe(1)
    expect(countBookmarks(readBookmarkTree(db).roots[0]?.children ?? [])).toBe(1)
    const tools = readBookmarkTree(db).roots[0]?.children[0]
    expect(tools?.kind === 'folder' ? tools.children : []).toEqual([])
  })

  it('移动文件夹时，Chrome 里已删的旧子项仍然保留', () => {
    importChromeBookmarks(db, {
      profileId: 'Default',
      profileName: '个人',
      roots: [root([folder('f1', '工具', [bookmark('a', 'A', 'https://a.example/'), bookmark('b', 'B', 'https://b.example/')])])],
      skipped: 0
    })

    // 整个文件夹换到「稍后读」下面，同时 Chrome 只保留 A——B 不该跟着消失。
    importChromeBookmarks(db, {
      profileId: 'Default',
      profileName: '个人',
      roots: [root([folder('f2', '稍后读', [folder('f1', '工具', [bookmark('a', 'A', 'https://a.example/')])])])],
      skipped: 0
    })

    const moved = readBookmarkTree(db).roots[0]?.children[0]
    expect(moved?.kind).toBe('folder')
    if (moved?.kind === 'folder') {
      expect(moved.title).toBe('稍后读')
      const tools = moved.children[0]
      expect(tools?.kind).toBe('folder')
      if (tools?.kind === 'folder') {
        expect(tools.children.map((node) => node.title)).toEqual(['A', 'B'])
      }
    }
  })

  it('空文件夹保留，且重复导入仍然是空文件夹', () => {
    const payload = {
      profileId: 'Default',
      profileName: '个人',
      roots: [root([folder('f1', '空文件夹', [])])],
      skipped: 0
    }
    importChromeBookmarks(db, payload)
    importChromeBookmarks(db, payload)

    const node = readBookmarkTree(db).roots[0]?.children[0]
    expect(node?.kind).toBe('folder')
    if (node?.kind === 'folder') expect(node.children).toEqual([])
  })

  it('不写 change_log / sync_meta（书签不参与设备同步）', () => {
    importChromeBookmarks(db, {
      profileId: 'Default',
      profileName: '个人',
      roots: [root([bookmark('a', 'A', 'https://a.example/')])],
      skipped: 0
    })

    expect(Number((sqlite.prepare('select count(*) as n from change_log').get() as { n: number }).n)).toBe(0)
    expect(Number((sqlite.prepare('select count(*) as n from sync_meta').get() as { n: number }).n)).toBe(0)
  })

  it('坏掉的存储返回空树，不阻塞下一次导入', () => {
    sqlite
      .prepare('insert into local_state (key, value) values (?, ?) on conflict(key) do update set value = excluded.value')
      .run(BOOKMARK_STORAGE_KEY, '{ broken')

    expect(readBookmarkTree(db).roots).toEqual([])
    const result = importChromeBookmarks(db, {
      profileId: 'Default',
      profileName: '个人',
      roots: [root([bookmark('a', 'A', 'https://a.example/')])],
      skipped: 0
    })
    expect(result.total).toBe(1)
  })
})

function bookmark(guid: string, title: string, url: string): BookmarkItem {
  return {
    kind: 'bookmark',
    id: `chrome:Default:g:${guid}`,
    title,
    url,
    sourceProfile: 'Default',
    sourceProfileName: '个人',
    guid
  }
}

function folder(guid: string, title: string, children: BookmarkNode[]): BookmarkFolder {
  return {
    kind: 'folder',
    id: `chrome:Default:g:${guid}`,
    title,
    children,
    sourceProfile: 'Default',
    sourceProfileName: '个人',
    guid
  }
}

function root(children: BookmarkNode[]): BookmarkRoot {
  return {
    kind: 'bookmark_bar',
    id: 'chrome:Default:root:bookmark_bar',
    title: '书签栏',
    sourceProfile: 'Default',
    sourceProfileName: '个人',
    children
  }
}
