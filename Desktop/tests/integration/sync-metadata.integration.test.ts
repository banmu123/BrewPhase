import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RecordDraft } from '@shared/contracts'
import type { DatabaseHandle } from '../../src/main/database/client'
import { openDatabase } from '../../src/main/database/client'
import { applyBatch, canonical, fingerprint, type SyncBatch } from '../../src/main/sync/snapshot-importer'
import {
  applyResolvedMetadata,
  createRecord,
  createTag,
  getRecord,
  updateRecord
} from '../../src/main/database/repositories/records'
import type { ResolvedLinkMetadata } from '../../src/main/metadata/metadata-normalizer'

/**
 * Resolver × Sync 数据一致性（Phase 3.1）——真实 SQLite + 真实 `applyBatch()`。
 *
 * 修复前的问题：Desktop 自动补全把 source_name / author_name / summary /
 * thumbnail_url_string / metadata_status / repository_* / canonical_url /
 * platform_content_id 写进 records，这些列都参与 record 指纹 → 下一次相同
 * 内容的 iOS 推送被判成「桌面端自己改过」→ 假冲突；iOS 删除也变成假删除冲突。
 *
 * 修复后：Desktop 的抓取结果只落 `record_metadata`（不进指纹），records 的
 * 这些列只由 iOS 同步或桌面用户编辑写入。六个场景逐一验证。
 */

const RECORD_ID = 'c0c0c0c0-1111-4111-8111-000000000001'
const URL = 'https://github.com/banmu123/BrewPhase'

type Payload = Record<string, string | number | boolean | null>

function recordPayload(overrides: Payload = {}): Payload {
  return {
    carrier: 'link',
    title: '',
    note: '',
    urlString: URL,
    canonicalURL: URL,
    provider: 'github',
    contentKind: '',
    platformContentID: 'banmu123/BrewPhase',
    linkPage: 1,
    sourceName: '',
    authorName: '',
    summary: '',
    thumbnailURLString: null,
    metadataStatus: 'resolved',
    repositoryStars: null,
    repositoryForks: null,
    repositoryIssues: null,
    repositoryLanguage: null,
    repositoryLicense: null,
    mediaPath: null,
    previewPath: null,
    isSample: false,
    createdAt: 1_700_000_000_000,
    ...overrides
  }
}

/** 与 snapshot-importer 的 record 字段序逐项对齐。 */
function recordFingerprint(p: Payload): string {
  return fingerprint(
    canonical([
      p.carrier, p.title, p.note, p.urlString, p.canonicalURL, p.provider, p.contentKind,
      p.platformContentID, p.linkPage, p.sourceName, p.authorName, p.summary,
      p.thumbnailURLString, p.metadataStatus, p.repositoryStars, p.repositoryForks,
      p.repositoryIssues, p.repositoryLanguage, p.repositoryLicense, p.mediaPath,
      p.previewPath, p.isSample
    ])
  )
}

function batch(payload: Payload, id = RECORD_ID): SyncBatch {
  return {
    operations: [
      {
        entityType: 'record',
        upserts: [{ id, fingerprint: recordFingerprint(payload), payload: payload as never }],
        deletes: []
      }
    ]
  }
}

function deleteBatch(expectedFingerprint: string, id = RECORD_ID): SyncBatch {
  return { operations: [{ entityType: 'record', upserts: [], deletes: [{ id, expectedFingerprint }] }] }
}

function resolvedSuccess(): ResolvedLinkMetadata {
  return {
    provider: 'github',
    contentId: 'banmu123/BrewPhase',
    canonicalUrl: URL,
    title: 'banmu123/BrewPhase',
    description: 'Personal coffee studio',
    thumbnailUrl: 'https://opengraph.githubassets.com/1/banmu123/BrewPhase',
    sourceName: 'GitHub',
    authorName: 'banmu123',
    repositoryLanguage: 'Swift',
    repositoryStars: 12,
    repositoryForks: 3,
    repositoryLicense: 'MIT',
    status: 'success'
  }
}

function resolvedFailure(): ResolvedLinkMetadata {
  return {
    provider: 'github',
    contentId: null,
    canonicalUrl: URL,
    title: null,
    description: null,
    thumbnailUrl: null,
    sourceName: null,
    authorName: null,
    repositoryLanguage: null,
    repositoryStars: null,
    repositoryForks: null,
    repositoryLicense: null,
    status: 'failed',
    errorMessage: 'unexpected status 403'
  }
}

let dir: string
let handle: DatabaseHandle

function rawRecord(id = RECORD_ID): Record<string, unknown> {
  return handle.sqlite.prepare('select * from records where id = ?').get(id) as Record<string, unknown>
}

function metaRow(id = RECORD_ID): Record<string, unknown> | undefined {
  return handle.sqlite.prepare('select * from record_metadata where record_id = ?').get(id) as
    | Record<string, unknown>
    | undefined
}

function draftFrom(id = RECORD_ID, overrides: Partial<RecordDraft> = {}): RecordDraft {
  const item = getRecord(handle.db, id)!
  return {
    carrier: item.carrier,
    title: item.title,
    note: item.note,
    urlString: item.urlString,
    canonicalURL: item.canonicalURL,
    platformContentID: item.platformContentID,
    provider: item.provider,
    sourceName: item.sourceName,
    authorName: item.authorName,
    summary: item.summary,
    mediaPath: item.mediaPath,
    previewPath: item.previewPath,
    tagIds: item.tagIds,
    ...overrides
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'brewphase-sync-meta-'))
  handle = openDatabase(join(dir, 'test.db'))
})

afterEach(() => {
  handle.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('场景 1：首次同步后自动补全，再推同样内容', () => {
  it('不产生冲突、返回 skipped，Desktop 抓到的元数据仍在', () => {
    const first = applyBatch(handle.sqlite, batch(recordPayload()), 'dev1')
    expect(first.appliedCount).toBe(1)

    const afterResolve = applyResolvedMetadata(handle.db, handle.deviceId, RECORD_ID, URL, resolvedSuccess())
    expect(afterResolve?.metadata?.title).toBe('banmu123/BrewPhase')
    expect(afterResolve?.metadata?.repositoryStars).toBe(12)

    const again = applyBatch(handle.sqlite, batch(recordPayload()), 'dev1')
    expect(again.conflictCount).toBe(0)
    expect(again.skippedCount).toBe(1)
    expect(getRecord(handle.db, RECORD_ID)?.metadata?.title).toBe('banmu123/BrewPhase')
  })

  it('Resolver 不写 records 的同步列（这是假冲突的根因）', () => {
    applyBatch(handle.sqlite, batch(recordPayload()), 'dev1')
    applyResolvedMetadata(handle.db, handle.deviceId, RECORD_ID, URL, resolvedSuccess())

    const row = rawRecord()
    expect(row.summary).toBe('')
    expect(row.author_name).toBe('')
    expect(row.source_name).toBe('')
    expect(row.thumbnail_url_string).toBeNull()
    expect(row.repository_stars).toBeNull()
    expect(row.metadata_status).toBe('resolved')
  })
})

describe('场景 2：元数据刷新失败', () => {
  it('不假冲突、已保存元数据不丢、状态保留', () => {
    applyBatch(handle.sqlite, batch(recordPayload()), 'dev1')
    applyResolvedMetadata(handle.db, handle.deviceId, RECORD_ID, URL, resolvedSuccess())
    const failed = applyResolvedMetadata(handle.db, handle.deviceId, RECORD_ID, URL, resolvedFailure())

    expect(failed?.metadata?.status).toBe('ok')
    expect(failed?.metadata?.thumbnailUrl).toBe('https://opengraph.githubassets.com/1/banmu123/BrewPhase')
    expect(failed?.metadata?.repositoryStars).toBe(12)

    const again = applyBatch(handle.sqlite, batch(recordPayload()), 'dev1')
    expect(again.conflictCount).toBe(0)
    expect(again.skippedCount).toBe(1)
    expect(getRecord(handle.db, RECORD_ID)?.metadata?.status).toBe('ok')
  })
})

describe('场景 3：iOS 修改用户字段', () => {
  it('正确接收 iOS 的新备注，本地派生元数据不被清空，基线更新', () => {
    applyBatch(handle.sqlite, batch(recordPayload()), 'dev1')
    applyResolvedMetadata(handle.db, handle.deviceId, RECORD_ID, URL, resolvedSuccess())

    const edited = recordPayload({ note: 'iOS 上写的新备注', title: 'my note' })
    const outcome = applyBatch(handle.sqlite, batch(edited), 'dev1')
    expect(outcome.appliedCount).toBe(1)
    expect(outcome.conflictCount).toBe(0)

    const item = getRecord(handle.db, RECORD_ID)!
    expect(item.note).toBe('iOS 上写的新备注')
    expect(item.title).toBe('my note')
    expect(item.metadata?.title).toBe('banmu123/BrewPhase')
    expect(item.metadata?.repositoryStars).toBe(12)
  })

  it('iOS 改了 URL → 旧本地元数据整行作废', () => {
    applyBatch(handle.sqlite, batch(recordPayload()), 'dev1')
    applyResolvedMetadata(handle.db, handle.deviceId, RECORD_ID, URL, resolvedSuccess())

    const nextUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    applyBatch(
      handle.sqlite,
      batch(
        recordPayload({
          urlString: nextUrl,
          canonicalURL: nextUrl,
          provider: 'youtube',
          platformContentID: 'dQw4w9WgXcQ'
        })
      ),
      'dev1'
    )
    expect(metaRow()).toBeUndefined()
    expect(getRecord(handle.db, RECORD_ID)?.metadata).toBeNull()
  })
})

describe('场景 4：iOS 删除记录', () => {
  it('只有本地派生元数据变化时，删除按正常协议执行（不制造假冲突）', () => {
    applyBatch(handle.sqlite, batch(recordPayload()), 'dev1')
    applyResolvedMetadata(handle.db, handle.deviceId, RECORD_ID, URL, resolvedSuccess())

    const iosFingerprint = recordFingerprint(recordPayload())
    const outcome = applyBatch(handle.sqlite, deleteBatch(iosFingerprint), 'dev1')
    expect(outcome.appliedCount).toBe(1)
    expect(outcome.conflictCount).toBe(0)
    expect(getRecord(handle.db, RECORD_ID)).toBeNull()
    // 级联：派生元数据跟着记录一起消失
    expect(metaRow()).toBeUndefined()
  })

  it('桌面用户真的改过记录 → 仍然保留删除冲突保护', () => {
    applyBatch(handle.sqlite, batch(recordPayload()), 'dev1')
    applyResolvedMetadata(handle.db, handle.deviceId, RECORD_ID, URL, resolvedSuccess())
    updateRecord(handle.db, handle.deviceId, RECORD_ID, draftFrom(RECORD_ID, { note: '桌面用户写的备注' }))

    const iosFingerprint = recordFingerprint(recordPayload())
    const outcome = applyBatch(handle.sqlite, deleteBatch(iosFingerprint), 'dev1')
    expect(outcome.conflictCount).toBe(1)
    expect(outcome.appliedCount).toBe(0)
    expect(getRecord(handle.db, RECORD_ID)?.note).toBe('桌面用户写的备注')
  })
})

describe('场景 5：Desktop 用户主动修改', () => {
  it('用户改标题 → iOS 再推原内容必须走冲突，不能静默覆盖', () => {
    applyBatch(handle.sqlite, batch(recordPayload()), 'dev1')
    applyResolvedMetadata(handle.db, handle.deviceId, RECORD_ID, URL, resolvedSuccess())
    updateRecord(handle.db, handle.deviceId, RECORD_ID, draftFrom(RECORD_ID, { title: '我的标题' }))

    const outcome = applyBatch(handle.sqlite, batch(recordPayload()), 'dev1')
    expect(outcome.conflictCount).toBe(1)
    expect(getRecord(handle.db, RECORD_ID)?.title).toBe('我的标题')
    // 冲突不影响本地派生元数据
    expect(getRecord(handle.db, RECORD_ID)?.metadata?.title).toBe('banmu123/BrewPhase')
  })
})

describe('场景 6：重复同步与幂等', () => {
  it('连推三次：不重复插入、不重复冲突、元数据与标签关系保持', () => {
    const tag = createTag(handle.db, handle.deviceId, '咖啡')
    applyBatch(handle.sqlite, batch(recordPayload()), 'dev1')
    updateRecord(handle.db, handle.deviceId, RECORD_ID, draftFrom(RECORD_ID, { tagIds: [tag.id] }))
    // 用户改过标签后再同步会冲突？——不会：tagIds 不在 record 指纹里（关系表独立）
    applyResolvedMetadata(handle.db, handle.deviceId, RECORD_ID, URL, resolvedSuccess())

    for (let round = 0; round < 3; round += 1) {
      const outcome = applyBatch(handle.sqlite, batch(recordPayload()), 'dev1')
      expect(outcome.appliedCount).toBe(0)
      expect(outcome.conflictCount).toBe(0)
      expect(outcome.skippedCount).toBe(1)
    }

    const count = handle.sqlite.prepare('select count(*) as n from records').get() as { n: number }
    expect(count.n).toBe(1)
    expect(getRecord(handle.db, RECORD_ID)?.tagIds).toEqual([tag.id])
    expect(getRecord(handle.db, RECORD_ID)?.metadata?.title).toBe('banmu123/BrewPhase')
    const links = handle.sqlite.prepare('select count(*) as n from record_tag_links').get() as { n: number }
    expect(links.n).toBe(1)
  })

  it('桌面新建的链接记录：初始 pending 落独立表，records 的同步列保持干净', () => {
    const created = createRecord(handle.db, handle.deviceId, {
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
      tagIds: []
    } as RecordDraft)
    expect(created.metadataStatus).toBe('pending')
    expect(created.metadata?.status).toBe('pending')
    const row = rawRecord(created.id)
    expect(row.metadata_status).toBe('idle')
    expect(row.summary).toBe('')
  })
})
