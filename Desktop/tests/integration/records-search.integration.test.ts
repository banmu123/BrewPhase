import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RecordDraft, RecordItem } from '@shared/contracts'
import type { DatabaseHandle } from '../../src/main/database/client'
import { openDatabase } from '../../src/main/database/client'
import {
  applyResolvedMetadata,
  createRecord,
  createTag,
  listRecords,
  updateRecord
} from '../../src/main/database/repositories/records'
import type { ResolvedLinkMetadata } from '../../src/main/metadata/metadata-normalizer'

/**
 * Records 搜索接入本地派生元数据（Phase 3.2）。
 *
 * 规则：`record_metadata` 参与搜索，但**只有当它的 url_string 与记录当前 URL
 * 一致**时才算数；用 EXISTS 而不是 JOIN，所以不会出现重复行、分页也不会错位。
 */

const URL = 'https://github.com/banmu123/BrewPhase'

let dir: string
let handle: DatabaseHandle

function draft(overrides: Partial<RecordDraft> = {}): RecordDraft {
  return {
    carrier: 'link',
    title: '',
    note: '',
    urlString: URL,
    canonicalURL: URL,
    platformContentID: 'banmu123/BrewPhase',
    provider: 'github',
    sourceName: '',
    authorName: '',
    summary: '',
    mediaPath: null,
    previewPath: null,
    tagIds: [],
    ...overrides
  }
}

function makeRecord(overrides: Partial<RecordDraft> = {}): RecordItem {
  return createRecord(handle.db, handle.deviceId, draft(overrides))
}

function metadata(overrides: Partial<ResolvedLinkMetadata> = {}): ResolvedLinkMetadata {
  return {
    provider: 'github',
    contentId: 'banmu123/BrewPhase',
    canonicalUrl: URL,
    title: 'banmu123/BrewPhase',
    description: 'Personal coffee studio',
    thumbnailUrl: 'https://opengraph.githubassets.com/1/banmu123/BrewPhase',
    sourceName: 'GitHub',
    authorName: 'fixture-author',
    repositoryLanguage: 'Swift',
    repositoryStars: 12,
    repositoryForks: 3,
    repositoryLicense: 'MIT',
    status: 'success',
    ...overrides
  }
}

function search(text: string, extra: { carrier?: RecordItem['carrier'] | null; tagId?: string | null; limit?: number; offset?: number } = {}) {
  return listRecords(handle.db, {
    search: text,
    carrier: extra.carrier ?? null,
    tagId: extra.tagId ?? null,
    limit: extra.limit ?? 50,
    offset: extra.offset ?? 0
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'brewphase-search-'))
  handle = openDatabase(join(dir, 'test.db'))
})

afterEach(() => {
  handle.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('本地派生元数据参与搜索', () => {
  it('自动抓取的标题能被搜到（records.title 仍然是空）', () => {
    const record = makeRecord()
    applyResolvedMetadata(handle.db, record.id, URL, metadata())
    const hits = search('banmu123/BrewPhase')
    expect(hits.map((item) => item.id)).toEqual([record.id])
    // 命中不改变用户数据：记录标题依旧为空，展示靠 metadata
    expect(hits[0].title).toBe('')
    expect(hits[0].metadata?.title).toBe('banmu123/BrewPhase')
  })

  it('自动抓取的描述能被搜到', () => {
    const record = makeRecord()
    applyResolvedMetadata(handle.db, record.id, URL, metadata())
    expect(search('coffee studio').map((item) => item.id)).toEqual([record.id])
  })

  it('自动抓取的作者能被搜到', () => {
    const record = makeRecord()
    applyResolvedMetadata(handle.db, record.id, URL, metadata())
    expect(search('fixture-author').map((item) => item.id)).toEqual([record.id])
  })

  it('URL 改变后，旧 URL 的派生元数据不能继续命中', () => {
    const record = makeRecord({ urlString: 'https://example.com/a', canonicalURL: 'https://example.com/a' })
    // 直接塞一条「URL 不匹配」的残留元数据（模拟历史脏数据 / 旧 URL 未清干净）
    handle.sqlite
      .prepare(
        `insert or replace into record_metadata (record_id, url_string, title, description, status)
         values (?, 'https://old.example.com/x', '旧链接的旧标题', '旧链接的旧摘要', 'ok')`
      )
      .run(record.id)

    expect(search('旧链接的旧标题')).toEqual([])
    expect(search('旧链接的旧摘要')).toEqual([])
  })

  it('记录自己的标题/备注/URL 搜索仍然有效', () => {
    const byTitle = makeRecord({ title: '我的标题', urlString: 'https://example.com/t', canonicalURL: null })
    const byNote = makeRecord({ note: '备注里的关键词', urlString: 'https://example.com/n', canonicalURL: null })
    const byUrl = makeRecord({ urlString: 'https://example.com/target-page', canonicalURL: null })

    expect(search('我的标题').map((item) => item.id)).toEqual([byTitle.id])
    expect(search('关键词').map((item) => item.id)).toEqual([byNote.id])
    expect(search('target-page').map((item) => item.id)).toEqual([byUrl.id])
  })

  it('标签与载体筛选可以和搜索组合', () => {
    const tag = createTag(handle.db, handle.deviceId, '咖啡')
    const tagged = makeRecord({ title: '带标签的链接', tagIds: [tag.id] })
    makeRecord({ title: '没标签的链接', urlString: 'https://example.com/b', canonicalURL: null })
    makeRecord({ carrier: 'text', title: '带标签的文字', note: '', tagIds: [tag.id] })

    expect(search('带标签', { tagId: tag.id, carrier: 'link' }).map((item) => item.id)).toEqual([tagged.id])
    expect(search('带标签', { carrier: 'text' })).toHaveLength(1)
    expect(search('带标签', { tagId: tag.id })).toHaveLength(2)
  })

  it('分页不会重复或遗漏（EXISTS 不产生笛卡尔积）', () => {
    const ids = new Set<string>()
    for (let index = 0; index < 5; index += 1) {
      const record = makeRecord({
        urlString: `https://example.com/p${index}`,
        canonicalURL: `https://example.com/p${index}`,
        title: `分页记录 ${index}`
      })
      // 每条都带一条派生元数据，确保 EXISTS 子查询每条都命中
      applyResolvedMetadata(handle.db, record.id, record.urlString, metadata({
        title: `分页记录 ${index}`,
        canonicalUrl: record.urlString
      }))
      ids.add(record.id)
    }

    const first = search('分页记录', { limit: 2, offset: 0 })
    const second = search('分页记录', { limit: 2, offset: 2 })
    const third = search('分页记录', { limit: 2, offset: 4 })
    expect([...first, ...second, ...third]).toHaveLength(5)
    const seen = new Set([...first, ...second, ...third].map((item) => item.id))
    expect(seen.size).toBe(5)
    for (const id of seen) expect(ids.has(id)).toBe(true)
  })

  it('搜索派生元数据不写 change_log、不影响记录本身', () => {
    const record = makeRecord()
    applyResolvedMetadata(handle.db, record.id, URL, metadata())
    const before = (handle.sqlite.prepare('select count(*) n from change_log').get() as { n: number }).n
    search('coffee studio')
    const after = (handle.sqlite.prepare('select count(*) n from change_log').get() as { n: number }).n
    expect(after).toBe(before)
    // 记录行没有被搜索改动
    const row = handle.sqlite.prepare('select title, summary from records where id = ?').get(record.id) as {
      title: string
      summary: string
    }
    expect(row.title).toBe('')
    expect(row.summary).toBe('')
  })

  it('用户把 URL 改成新链接后，旧标题立刻搜不到（元数据已作废）', () => {
    const record = makeRecord()
    applyResolvedMetadata(handle.db, record.id, URL, metadata())
    expect(search('coffee studio')).toHaveLength(1)

    updateRecord(handle.db, handle.deviceId, record.id, draft({
      urlString: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      canonicalURL: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      platformContentID: 'dQw4w9WgXcQ',
      provider: 'youtube'
    }))
    expect(search('coffee studio')).toEqual([])
  })
})
