import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../../src/main/database/client'
import { openDatabase } from '../../src/main/database/client'
import { applyBatch, canonical, fingerprint, type SyncBatch } from '../../src/main/sync/snapshot-importer'
import {
  applyResolvedMetadata,
  getRecord,
  pendingMetadataJobs,
  prepareLocalMetadata
} from '../../src/main/database/repositories/records'
import { resolveRecordMetadata } from '../../src/main/metadata'
import { ResolveQueue } from '../../src/main/metadata/resolve-queue'
import type { TextFetcher } from '../../src/main/metadata/metadata-normalizer'

/**
 * 同步 → 本地元数据补全的生命周期（Phase 3.2），真实 SQLite。
 *
 * 覆盖：首次同步新链接自动进队列、URL 变化重建任务、同 URL 不重复抓、
 * link→text 清理、抓取失败不影响同步、抓取期间删除/改 URL 的竞态、
 * 应用重启后恢复 pending。
 */

const RECORD_ID = 'd0d0d0d0-1111-4111-8111-000000000001'
const URL = 'https://github.com/banmu123/BrewPhase'
const NEXT_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

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
      { entityType: 'record', upserts: [{ id, fingerprint: recordFingerprint(payload), payload: payload as never }], deletes: [] }
    ]
  }
}

/** 固定响应的抓取器：GitHub 仓库 API 成功，其余失败。 */
function githubFetcher(): TextFetcher {
  return async (url: string) => {
    if (url.includes('api.github.com/repos/')) {
      return {
        url,
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          full_name: 'banmu123/BrewPhase',
          description: 'Personal coffee studio',
          language: 'Swift',
          stargazers_count: 12,
          forks_count: 3,
          license: { spdx_id: 'MIT' },
          owner: { login: 'banmu123' }
        })
      }
    }
    throw new Error(`no route for ${url}`)
  }
}

let dir: string
let handle: DatabaseHandle
let queue: ResolveQueue
let fetchCount: number
let fetchImpl: TextFetcher

/** 与 index.ts 的调度逻辑一致：准备派生行 → 需要时入队。 */
function schedule(id: string): { urlString: string; needsFetch: boolean } | null {
  const prepared = prepareLocalMetadata(handle.db, id)
  if (prepared?.needsFetch) {
    queue.enqueue({ recordId: id, urlString: prepared.urlString })
  }
  return prepared
}

function metaRow(id = RECORD_ID): Record<string, unknown> | undefined {
  return handle.sqlite.prepare('select * from record_metadata where record_id = ?').get(id) as
    | Record<string, unknown>
    | undefined
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'brewphase-queue-'))
  handle = openDatabase(join(dir, 'test.db'))
  fetchCount = 0
  fetchImpl = githubFetcher()
  queue = new ResolveQueue({
    concurrency: 2,
    run: async (job) => {
      fetchCount += 1
      // 每轮转发到当前 fetchImpl，便于用例中途替换抓取行为
      const fetcher: TextFetcher = (url, opts) => fetchImpl(url, opts)
      await resolveRecordMetadata(handle.db, handle.deviceId, job.recordId, false, job.urlString, fetcher)
    }
  })
})

afterEach(() => {
  handle.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('同步后自动补全（Phase 3.2）', () => {
  it('首次同步的新 link：建 pending → 队列抓取 → ok，且不写同步列', async () => {
    expect(applyBatch(handle.sqlite, batch(recordPayload()), 'dev1').appliedCount).toBe(1)

    const prepared = schedule(RECORD_ID)
    expect(prepared).toEqual({ urlString: URL, needsFetch: true })
    expect(metaRow()?.status).toBe('pending')

    await queue.drain()

    const item = getRecord(handle.db, RECORD_ID)!
    expect(item.metadata?.status).toBe('ok')
    expect(item.metadata?.title).toBe('banmu123/BrewPhase')
    expect(item.metadata?.repositoryStars).toBe(12)
    expect(fetchCount).toBe(1)

    // 同步列一个都没被写
    const row = handle.sqlite.prepare('select * from records where id = ?').get(RECORD_ID) as Record<string, unknown>
    expect(row.summary).toBe('')
    expect(row.author_name).toBe('')
    expect(row.metadata_status).toBe('resolved')
  })

  it('iOS 只改备注：同 URL 的元数据保留，不重复抓取', async () => {
    applyBatch(handle.sqlite, batch(recordPayload()), 'dev1')
    schedule(RECORD_ID)
    await queue.drain()
    expect(fetchCount).toBe(1)

    const outcome = applyBatch(handle.sqlite, batch(recordPayload({ note: '手机上新写的备注' })), 'dev1')
    expect(outcome.appliedCount).toBe(1)

    const prepared = schedule(RECORD_ID)
    expect(prepared?.needsFetch).toBe(false)
    await queue.drain()
    expect(fetchCount).toBe(1)
    expect(getRecord(handle.db, RECORD_ID)?.metadata?.repositoryStars).toBe(12)
    expect(getRecord(handle.db, RECORD_ID)?.note).toBe('手机上新写的备注')
  })

  it('iOS 改 URL：旧元数据作废，新 URL 重新进 pending 并抓取', async () => {
    applyBatch(handle.sqlite, batch(recordPayload()), 'dev1')
    schedule(RECORD_ID)
    await queue.drain()

    applyBatch(
      handle.sqlite,
      batch(recordPayload({ urlString: NEXT_URL, canonicalURL: NEXT_URL, provider: 'youtube', platformContentID: 'dQw4w9WgXcQ' })),
      'dev1'
    )
    // importer 的 reconcile 已经删掉旧行
    expect(metaRow()).toBeUndefined()

    const prepared = schedule(RECORD_ID)
    expect(prepared).toEqual({ urlString: NEXT_URL, needsFetch: true })
    await queue.drain()
    // 新 URL 是 YouTube：抓取器没有对应路由 → 失败，但记录本身不受影响
    expect(getRecord(handle.db, RECORD_ID)?.metadata?.status).toBe('failed')
    expect(fetchCount).toBe(2)
  })

  it('iOS 把 link 改成 text：派生元数据整行删除，不排任务', async () => {
    applyBatch(handle.sqlite, batch(recordPayload()), 'dev1')
    schedule(RECORD_ID)
    await queue.drain()

    const asText = recordPayload({ carrier: 'text', note: '变成纯文字' })
    applyBatch(handle.sqlite, batch(asText), 'dev1')

    expect(metaRow()).toBeUndefined()
    expect(schedule(RECORD_ID)).toBeNull()
    await queue.drain()
    expect(fetchCount).toBe(1)
  })

  it('抓取失败不影响同步结果，状态收敛到 failed 且不自动重试', async () => {
    fetchImpl = async () => {
      throw new Error('unexpected status 500')
    }
    // 先同步：模拟「同一批里元数据抓取失败，但 applyBatch 早已成功」
    expect(applyBatch(handle.sqlite, batch(recordPayload()), 'dev1').appliedCount).toBe(1)
    schedule(RECORD_ID)
    await queue.drain()

    expect(getRecord(handle.db, RECORD_ID)?.metadata?.status).toBe('failed')
    // 再同步一次（skipped）：不会自动重试
    expect(applyBatch(handle.sqlite, batch(recordPayload()), 'dev1').skippedCount).toBe(1)
    expect(schedule(RECORD_ID)?.needsFetch).toBe(false)
    expect(fetchCount).toBe(1)
  })

  it('抓取期间记录被删除：结果丢弃，不留孤儿派生行', async () => {
    applyBatch(handle.sqlite, batch(recordPayload()), 'dev1')
    schedule(RECORD_ID)
    // 任务还没跑完就删记录
    handle.sqlite.prepare('delete from records where id = ?').run(RECORD_ID)
    await queue.drain()

    expect(metaRow()).toBeUndefined()
    expect(getRecord(handle.db, RECORD_ID)).toBeNull()
  })

  it('抓取期间 URL 被改：旧结果不写入新链接', async () => {
    applyBatch(handle.sqlite, batch(recordPayload()), 'dev1')
    schedule(RECORD_ID)
    // 队列已开始（并发 2 同步启动），此时把记录 URL 改掉
    handle.sqlite
      .prepare(`update records set url_string = ?, provider = 'youtube' where id = ?`)
      .run(NEXT_URL, RECORD_ID)
    await queue.drain()

    const item = getRecord(handle.db, RECORD_ID)!
    expect(item.urlString).toBe(NEXT_URL)
    // GitHub 的结果被 expectedUrl 挡掉，不会挂到 YouTube 链接上
    expect(item.metadata?.repositoryStars ?? null).toBeNull()
    expect(item.metadata?.thumbnailUrl ?? null).toBeNull()
  })

  it('应用重启后能恢复 pending 任务', async () => {
    applyBatch(handle.sqlite, batch(recordPayload()), 'dev1')
    // 模拟「入队后应用被关掉」：行留在 pending，队列没跑
    prepareLocalMetadata(handle.db, RECORD_ID)
    expect(metaRow()?.status).toBe('pending')

    const jobs = pendingMetadataJobs(handle.db)
    expect(jobs).toEqual([{ recordId: RECORD_ID, urlString: URL }])

    for (const job of jobs) queue.enqueue(job)
    await queue.drain()

    expect(getRecord(handle.db, RECORD_ID)?.metadata?.status).toBe('ok')
    expect(fetchCount).toBe(1)
    expect(pendingMetadataJobs(handle.db)).toEqual([])
  })

  it('刷新成功后再同步同样内容：不产生假冲突', async () => {
    applyBatch(handle.sqlite, batch(recordPayload()), 'dev1')
    schedule(RECORD_ID)
    await queue.drain()

    const again = applyBatch(handle.sqlite, batch(recordPayload()), 'dev1')
    expect(again.conflictCount).toBe(0)
    expect(again.skippedCount).toBe(1)
  })

  it('手动刷新（force）会跳过缓存重新抓取', async () => {
    applyBatch(handle.sqlite, batch(recordPayload()), 'dev1')
    schedule(RECORD_ID)
    await queue.drain()
    expect(fetchCount).toBe(1)

    await resolveRecordMetadata(handle.db, handle.deviceId, RECORD_ID, true, URL, fetchImpl)
    expect(fetchCount).toBe(1) // 这里的 fetchCount 只统计队列执行体
    expect(getRecord(handle.db, RECORD_ID)?.metadata?.status).toBe('ok')
  })
})

describe('同步结果不影响其它实体', () => {
  it('抓取失败不会写 change_log、不会改 fingerprint 基线', async () => {
    fetchImpl = async () => {
      throw new Error('boom')
    }
    applyBatch(handle.sqlite, batch(recordPayload()), 'dev1')
    const before = handle.sqlite
      .prepare("select fingerprint from sync_baseline where entity_type = 'record' and entity_id = ?")
      .get(RECORD_ID) as { fingerprint: string }
    const logsBefore = (handle.sqlite.prepare('select count(*) n from change_log').get() as { n: number }).n

    schedule(RECORD_ID)
    await queue.drain()

    const after = handle.sqlite
      .prepare("select fingerprint from sync_baseline where entity_type = 'record' and entity_id = ?")
      .get(RECORD_ID) as { fingerprint: string }
    const logsAfter = (handle.sqlite.prepare('select count(*) n from change_log').get() as { n: number }).n
    expect(after.fingerprint).toBe(before.fingerprint)
    expect(logsAfter).toBe(logsBefore)
  })
})
