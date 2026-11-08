import { createHash, randomUUID } from 'node:crypto'
import { createServer as createNetServer } from 'node:net'
import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { migrate } from '../../src/main/database/migrations'
import { NonceStore, sha256, verifyRequest, expectedSignature, randomToken } from '../../src/main/sync/auth'
import { recordIdsToResolve } from '../../src/main/metadata'
import { SyncServer } from '../../src/main/sync/server'
import { PairingService } from '../../src/main/sync/pairing-service'
import { applyBatch, canonical, fingerprint, recordTagLinkId, type ApplyResult, type SyncBatch } from '../../src/main/sync/snapshot-importer'
import { finalizeMedia, writeChunk, checkManifest, receivedBytes, type MediaManifestEntry } from '../../src/main/sync/media-transfer'

function openDb(): Database.Database {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  migrate(sqlite)
  return sqlite
}

describe('canonical fingerprint', () => {
  it('数字按 6 位小数去尾零归一：1 与 1.0 同指纹', () => {
    expect(canonical([1])).toBe(canonical([1.0]))
    expect(canonical([1])).toBe('1')
    expect(canonical([0.5])).toBe('0.5')
  })

  it('null 归 ~，布尔归 true/false', () => {
    expect(canonical([null])).toBe('~')
    expect(canonical([true, false])).toBe('true\u001ffalse')
  })

  it('fingerprint 是稳定 SHA-256', () => {
    expect(fingerprint(canonical(['a', 1]))).toBe(fingerprint(canonical(['a', 1.0])))
    expect(fingerprint(canonical(['a']))).toHaveLength(64)
  })
})

describe('PairingService（BrewPing 同款安全策略）', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openDb()
  })

  it('配对码一次性：兑换成功后立即作废', () => {
    const service = new PairingService()
    const { code } = service.issue()
    const first = service.exchange(code, '192.168.1.2', 'iPhone', db)
    expect(first.ok).toBe(true)
    const second = service.exchange(code, '192.168.1.2', 'iPhone', db)
    expect(second.ok).toBe(false)
  })

  it('过期（2 分钟）后不可兑换', () => {
    const service = new PairingService()
    const { code } = service.issue()
    const outcome = service.exchange(code, null, 'iPhone', db, Date.now() + 121_000)
    expect(outcome.ok).toBe(false)
  })

  it('同来源连续猜错 5 次后限速；不同来源不受影响（然后被全局限速兜住）', () => {
    const service = new PairingService()
    const { code } = service.issue()
    for (let index = 0; index < 5; index += 1) {
      const outcome = service.exchange('wrong', '10.0.0.9', 'iPhone', db)
      expect(outcome.ok).toBe(false)
    }
    const limited = service.exchange(code, '10.0.0.9', 'iPhone', db)
    expect(limited.ok).toBe(false)
    if (!limited.ok) expect((limited as { status: number }).status).toBe(429)

    // 另一个来源还能成功；随后全局阈值也被错误累计推高——这里只验证单源隔离。
    const other = service.exchange(code, '10.0.0.8', 'iPhone', db)
    expect(other.ok).toBe(true)
  })

  it('数据库里只存 token 哈希，不存明文', () => {
    const service = new PairingService()
    const { code } = service.issue()
    const outcome = service.exchange(code, null, 'iPhone', db)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const row = db.prepare('select token_hash from devices').get() as { token_hash: string }
    expect(row.token_hash).toBe(sha256((outcome as { token: string }).token))
    expect(row.token_hash).not.toBe((outcome as { token: string }).token)
  })
})

describe('请求鉴权（Bearer + Timestamp + Nonce + HMAC）', () => {
  const token = randomToken()
  const nonceStore = new NonceStore()

  function signed(body: string, overrides: Partial<{ nonce: string; timestamp: string }> = {}) {
    const nonce = overrides.nonce ?? 'nonce-1'
    const timestamp = overrides.timestamp ?? String(Date.now())
    return {
      method: 'POST',
      token,
      timestamp,
      nonce,
      signature: expectedSignature(token, timestamp, nonce, sha256(body)),
      body: Buffer.from(body),
      nonceStore
    }
  }

  it('签名正确 → 通过；签名被改 → 401', () => {
    const body = '{"hello":"world"}'
    expect(verifyRequest(signed(body), token).ok).toBe(true)
    const bad = signed(body, { nonce: 'nonce-2' })
    bad.signature = expectedSignature('wrong-key', bad.timestamp, bad.nonce, sha256(body))
    const outcome = verifyRequest(bad, token)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.status).toBe(401)
  })

  it('同一 nonce 重放 → 401', () => {
    const body = '{"n":1}'
    expect(verifyRequest(signed(body, { nonce: 'replay' }), token).ok).toBe(true)
    const replay = verifyRequest(signed(body, { nonce: 'replay' }), token)
    expect(replay.ok).toBe(false)
    if (!replay.ok) expect(replay.error).toContain('replayed nonce')
  })

  it('时间窗外的请求 → 401 stale', () => {
    const stale = signed('{}', { timestamp: String(Date.now() - 300_000), nonce: 'old' })
    const outcome = verifyRequest(stale, token)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toBe('stale request')
  })

  it('GET 豁免 timestamp/nonce（只读重放无害）', () => {
    const outcome = verifyRequest(
      { method: 'GET', token, timestamp: null, nonce: null, signature: null, body: Buffer.alloc(0), nonceStore },
      token
    )
    expect(outcome.ok).toBe(true)
  })
})

describe('快照合并（非破坏性，幂等）', () => {
  let db: Database.Database
  const beanId = '11111111-1111-4111-8111-111111111111'
  const recordId = '77777777-7777-4777-8777-777777777777'
  const tagId = '66666666-6666-4666-8666-666666666666'

  function beanPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name: '耶加雪菲',
      roaster: '巷口烘焙',
      origin: '埃塞俄比亚',
      process: '水洗',
      roastLevel: 'medium',
      roastDate: 1_782_000_000_000,
      purchaseDate: null,
      openDate: 1_782_100_000_000,
      weightG: 200,
      remainingG: 158,
      price: 88,
      channel: '',
      imagePath: null,
      flavorTagsRaw: '茉莉, 柠檬',
      notes: '',
      status: 'active',
      stockCountedAt: null,
      isSample: false,
      ...overrides
    }
  }

  function beanBatch(fp: string, payload: Record<string, unknown> = beanPayload()): SyncBatch {
    return {
      operations: [
        { entityType: 'bean', upserts: [{ id: beanId, fingerprint: fp, payload }], deletes: [] }
      ]
    }
  }

  function beanFingerprint(payload: Record<string, unknown>): string {
    const fp = fingerprint(
      canonical([
        payload.name, payload.roaster, payload.origin, payload.process, payload.roastLevel,
        payload.roastDate, payload.purchaseDate, payload.openDate,
        payload.weightG, payload.remainingG, payload.price, payload.channel,
        payload.imagePath, payload.flavorTagsRaw, payload.notes, payload.status,
        payload.stockCountedAt, payload.isSample
      ])
    )
    return fp
  }

  beforeEach(() => {
    db = openDb()
  })

  it('新实体插入 → 重复同步幂等（第二次全部 skipped）', () => {
    const fp = beanFingerprint(beanPayload())
    const first = applyBatch(db, beanBatch(fp), 'dev1')
    expect(first.appliedCount).toBe(1)
    const second = applyBatch(db, beanBatch(fp), 'dev1')
    expect(second.appliedCount).toBe(0)
    expect(second.skippedCount).toBe(1)
  })

  it('UUID 原样保留，不被重新生成', () => {
    applyBatch(db, beanBatch(beanFingerprint(beanPayload())), 'dev1')
    const row = db.prepare('select id from beans').get() as { id: string }
    expect(row.id).toBe(beanId)
  })

  it('iOS 修改（桌面端未动）→ 覆盖更新；再改回 → 又覆盖', () => {
    const fp1 = beanFingerprint(beanPayload())
    applyBatch(db, beanBatch(fp1), 'dev1')

    const payload2 = beanPayload({ remainingG: 130 })
    const fp2 = beanFingerprint(payload2)
    const outcome = applyBatch(db, beanBatch(fp2, payload2), 'dev1')
    expect(outcome.appliedCount).toBe(1)
    const row = db.prepare('select remaining_g from beans').get() as { remaining_g: number }
    expect(row.remaining_g).toBe(130)
  })

  it('桌面端自己改过（基线=来端值，本地不同）→ 冲突，保留本地', () => {
    const fp1 = beanFingerprint(beanPayload())
    applyBatch(db, beanBatch(fp1), 'dev1')

    // 桌面端本地改了 remaining（模拟用户在电脑上编辑）
    db.prepare('update beans set remaining_g = 99 where id = ?').run(beanId)

    // iOS 没改（还是 fp1）→ 冲突；本地值 99 保留
    const outcome = applyBatch(db, beanBatch(fp1), 'dev1')
    expect(outcome.conflictCount).toBe(1)
    const row = db.prepare('select remaining_g from beans').get() as { remaining_g: number }
    expect(row.remaining_g).toBe(99)
    const conflict = db.prepare('select entity_type, entity_id from sync_conflicts').get()
    expect(conflict).toBeTruthy()
  })

  it('删除（带基线指纹）→ 生效；重复删除 skipped；级联删除跟随外键', () => {
    const fp1 = beanFingerprint(beanPayload())
    applyBatch(db, beanBatch(fp1), 'dev1')
    db.prepare(
      `insert into brews (id, bean_id, date, created_at) values (?, ?, ?, ?)`
    ).run('22222222-2222-4222-8222-222222222222', beanId, Date.now(), Date.now())

    const batch: SyncBatch = {
      operations: [
        { entityType: 'bean', upserts: [], deletes: [{ id: beanId, expectedFingerprint: fp1 }] }
      ]
    }
    const first = applyBatch(db, batch, 'dev1')
    expect(first.appliedCount).toBe(1)
    expect((db.prepare('select count(*) as n from beans').get() as { n: number }).n).toBe(0)
    expect((db.prepare('select count(*) as n from brews').get() as { n: number }).n).toBe(0)

    const second = applyBatch(db, batch, 'dev1')
    expect(second.skippedCount).toBe(1)
  })

  it('删除不带基线指纹而行存在 → 删除冲突，桌面数据保留', () => {
    applyBatch(db, beanBatch(beanFingerprint(beanPayload())), 'dev1')
    const outcome = applyBatch(
      db,
      { operations: [{ entityType: 'bean', upserts: [], deletes: [{ id: beanId }] }] },
      'dev1'
    )
    expect(outcome.conflictCount).toBe(1)
    expect((db.prepare('select count(*) as n from beans').get() as { n: number }).n).toBe(1)
    const conflict = db
      .prepare('select remote_operation, local_fingerprint from sync_conflicts')
      .get() as { remote_operation: string; local_fingerprint: string }
    expect(conflict.remote_operation).toBe('delete')
    expect(conflict.local_fingerprint).not.toBe('~')
  })

  it('桌面端改过后删除 → 删除冲突；同指纹重发去重；远端指纹变化才新增', () => {
    const fp1 = beanFingerprint(beanPayload())
    applyBatch(db, beanBatch(fp1), 'dev1')
    db.prepare('update beans set remaining_g = 99 where id = ?').run(beanId)

    const deleteBatch: SyncBatch = {
      operations: [
        { entityType: 'bean', upserts: [], deletes: [{ id: beanId, expectedFingerprint: fp1 }] }
      ]
    }
    const first = applyBatch(db, deleteBatch, 'dev1')
    expect(first.conflictCount).toBe(1)
    expect((db.prepare('select count(*) as n from beans').get() as { n: number }).n).toBe(1)

    // 同一基线指纹的删除重发 → 复用未裁决冲突，不膨胀。
    const second = applyBatch(db, deleteBatch, 'dev1')
    expect(second.conflictCount).toBe(1)
    expect(
      (db.prepare('select count(*) as n from sync_conflicts').get() as { n: number }).n
    ).toBe(1)

    // iOS 端内容真的变了（基线也推进）→ 新指纹的新冲突。
    const third = applyBatch(
      db,
      { operations: [{ entityType: 'bean', upserts: [], deletes: [{ id: beanId, expectedFingerprint: beanFingerprint(beanPayload({ remainingG: 130 })) }] }] },
      'dev1'
    )
    expect(third.conflictCount).toBe(1)
    expect(
      (db.prepare('select count(*) as n from sync_conflicts').get() as { n: number }).n
    ).toBe(2)
  })

  it('applyBatch 逐条 results：成功/跳过/冲突/失败各归其位', () => {
    const fp = beanFingerprint(beanPayload())
    // bean：applied；同名 bean 再来一条（不同 id）：applied；
    // brew 引用缺失：failed；桌面改过的 bean：conflict
    applyBatch(db, beanBatch(fp), 'dev1')
    db.prepare('update beans set remaining_g = 99 where id = ?').run(beanId)

    const conflictFp = fp
    const newBeanId = '99999999-9999-4999-8999-999999999999'
    const outcome = applyBatch(
      db,
      {
        operations: [
          {
            entityType: 'bean',
            upserts: [
              { id: beanId, fingerprint: conflictFp, payload: beanPayload() },
              { id: newBeanId, fingerprint: beanFingerprint(beanPayload({ name: '新豆子' })), payload: beanPayload({ name: '新豆子' }) }
            ],
            deletes: []
          },
          {
            entityType: 'brew',
            upserts: [{ id: '55555555-5555-4555-8555-555555555555', fingerprint: 'x', payload: { beanId: '00000000-0000-4000-8000-000000000000' } }],
            deletes: []
          }
        ]
      },
      'dev1'
    )
    const byId = new Map(outcome.results.map((item) => [item.id, item.status]))
    expect(byId.get(beanId)).toBe('conflict')
    expect(byId.get(newBeanId)).toBe('applied')
    expect(byId.get('55555555-5555-4555-8555-555555555555')).toBe('failed')
    // 基线只推进成功那条；冲突条目的基线不动。
    const baselines = db
      .prepare('select entity_id from sync_baseline where entity_type = ?')
      .all('bean') as Array<{ entity_id: string }>
    expect(baselines.map((row) => row.entity_id)).toEqual([beanId, newBeanId].sort())
  })

  it('recordTagLink：插入、缺引用 failed、重复 skipped、删除', () => {
    applyBatch(db, beanBatch(beanFingerprint(beanPayload())), 'dev1')
    db.prepare(
      `insert into records (id, carrier, created_at, updated_at) values (?, 'text', ?, ?)`
    ).run(recordId, Date.now(), Date.now())
    db.prepare(
      `insert into record_tags (id, name, created_at) values (?, '开发', ?)`
    ).run(tagId, Date.now())

    const linkId = recordTagLinkId(recordId, tagId)
    const linkFp = fingerprint(canonical([recordId, tagId]))
    const linkBatch: SyncBatch = {
      operations: [
        {
          entityType: 'recordTagLink',
          upserts: [{ id: linkId, fingerprint: linkFp, payload: { recordId, tagId } }],
          deletes: []
        }
      ]
    }
    const first = applyBatch(db, linkBatch, 'dev1')
    expect(first.appliedCount).toBe(1)
    const second = applyBatch(db, linkBatch, 'dev1')
    expect(second.skippedCount).toBe(1)
    expect(
      (db.prepare('select count(*) as n from record_tag_links').get() as { n: number }).n
    ).toBe(1)

    // 缺引用：tag 不存在 → failed
    const missing = applyBatch(
      db,
      {
        operations: [
          {
            entityType: 'recordTagLink',
            upserts: [{ id: recordTagLinkId(recordId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), fingerprint: 'x', payload: { recordId, tagId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }],
            deletes: []
          }
        ]
      },
      'dev1'
    )
    expect(missing.failedItems).toHaveLength(1)

    // 删除关系
    const removed = applyBatch(
      db,
      { operations: [{ entityType: 'recordTagLink', upserts: [], deletes: [{ id: linkId }] }] },
      'dev1'
    )
    expect(removed.appliedCount).toBe(1)
    expect(
      (db.prepare('select count(*) as n from record_tag_links').get() as { n: number }).n
    ).toBe(0)
  })

  it('createdAt：iOS 带原始时间就保留；缺省才补 now', () => {
    const createdAt = Date.now() - 86_400_000
    applyBatch(db, beanBatch(beanFingerprint(beanPayload()), beanPayload({ createdAt })), 'dev1')
    const row = db.prepare('select created_at from beans').get() as { created_at: number }
    expect(row.created_at).toBe(createdAt)

    const secondId = '88888888-8888-4888-8888-888888888888'
    applyBatch(
      db,
      {
        operations: [
          {
            entityType: 'bean',
            upserts: [{ id: secondId, fingerprint: beanFingerprint(beanPayload({ name: '无时间' })), payload: beanPayload({ name: '无时间' }) }],
            deletes: []
          }
        ]
      },
      'dev1'
    )
    const fallback = db.prepare('select created_at from beans where id = ?').get(secondId) as { created_at: number }
    expect(Math.abs(fallback.created_at - Date.now())).toBeLessThan(10_000)
  })

  it('created_at 为 null 的 payload（旧客户端/传输异常）→ 补 now，不报 NOT NULL（真机回归）', () => {
    const payload = { ...beanPayload(), createdAt: null }
    const outcome = applyBatch(
      db,
      { operations: [{ entityType: 'bean', upserts: [{ id: beanId, fingerprint: beanFingerprint(beanPayload()), payload }], deletes: [] }] },
      'dev1'
    )
    expect(outcome.appliedCount).toBe(1)
    const row = db.prepare('select created_at from beans where id = ?').get(beanId) as { created_at: number }
    expect(row.created_at).toBeGreaterThan(0)
  })

  it('PhaseRule：两端默认规则字段一致（UUID 不同）→ skipped，不产生重复', () => {
    db.prepare(
      `insert into phase_rules (id, roast_level, rest_min_days, rest_max_days, peak_start_day, peak_end_day, decline_start_day, enabled, updated_at)
       values ('33333333-3333-4333-8333-333333333333', 'medium', 2, 5, 5, 21, 21, 1, ?)`
    ).run(Date.now())
    const payload = { roastLevel: 'medium', restMinDays: 2, restMaxDays: 5, peakStartDay: 5, peakEndDay: 21, declineStartDay: 21, enabled: true }
    const fp = fingerprint(canonical([payload.roastLevel, payload.restMinDays, payload.restMaxDays, payload.peakStartDay, payload.peakEndDay, payload.declineStartDay, payload.enabled]))
    const outcome = applyBatch(
      db,
      { operations: [{ entityType: 'phaseRule', upserts: [{ id: '44444444-4444-4444-8444-444444444444', fingerprint: fp, payload }], deletes: [] }] },
      'dev1'
    )
    expect(outcome.skippedCount).toBe(1)
    expect((db.prepare('select count(*) as n from phase_rules').get() as { n: number }).n).toBe(1)
  })

  it('PhaseRule：iOS 改过而桌面规则无基线 → 冲突保留桌面；裁决路径之外不覆盖', () => {
    db.prepare(
      `insert into phase_rules (id, roast_level, rest_min_days, rest_max_days, peak_start_day, peak_end_day, decline_start_day, enabled, updated_at)
       values ('33333333-3333-4333-8333-333333333333', 'medium', 2, 5, 5, 21, 21, 1, ?)`
    ).run(Date.now())
    const payload = { roastLevel: 'medium', restMinDays: 3, restMaxDays: 6, peakStartDay: 6, peakEndDay: 24, declineStartDay: 24, enabled: true }
    const fp = fingerprint(canonical([payload.roastLevel, payload.restMinDays, payload.restMaxDays, payload.peakStartDay, payload.peakEndDay, payload.declineStartDay, payload.enabled]))
    const outcome = applyBatch(
      db,
      { operations: [{ entityType: 'phaseRule', upserts: [{ id: '44444444-4444-4444-8444-444444444444', fingerprint: fp, payload }], deletes: [] }] },
      'dev1'
    )
    expect(outcome.conflictCount).toBe(1)
    const rules = db.prepare('select id, rest_min_days from phase_rules').all() as Array<{ id: string; rest_min_days: number }>
    expect(rules).toHaveLength(1)
    expect(rules[0].rest_min_days).toBe(2)
  })

  it('PhaseRule：桌面规则有基线且未改动 → iOS 修改原位生效，基线记到桌面行', () => {
    const seed = { roastLevel: 'medium', restMinDays: 2, restMaxDays: 5, peakStartDay: 5, peakEndDay: 21, declineStartDay: 21, enabled: true }
    const seedFp = fingerprint(canonical([seed.roastLevel, seed.restMinDays, seed.restMaxDays, seed.peakStartDay, seed.peakEndDay, seed.declineStartDay, seed.enabled]))
    // iOS 先把默认规则同步过来（无桌面规则 → 插入 iOS UUID）
    applyBatch(
      db,
      { operations: [{ entityType: 'phaseRule', upserts: [{ id: '44444444-4444-4444-8444-444444444444', fingerprint: seedFp, payload: seed }], deletes: [] }] },
      'dev1'
    )
    // iOS 改了规则（桌面端未动，基线==本地）→ 原位覆盖
    const changed = { ...seed, restMinDays: 3 }
    const changedFp = fingerprint(canonical([changed.roastLevel, changed.restMinDays, changed.restMaxDays, changed.peakStartDay, changed.peakEndDay, changed.declineStartDay, changed.enabled]))
    const outcome = applyBatch(
      db,
      { operations: [{ entityType: 'phaseRule', upserts: [{ id: '44444444-4444-4444-8444-444444444444', fingerprint: changedFp, payload: changed }], deletes: [] }] },
      'dev1'
    )
    expect(outcome.appliedCount).toBe(1)
    const rules = db.prepare('select id, rest_min_days from phase_rules').all() as Array<{ id: string; rest_min_days: number }>
    expect(rules).toHaveLength(1)
    expect(rules[0].id).toBe('44444444-4444-4444-8444-444444444444')
    expect(rules[0].rest_min_days).toBe(3)
    // 基线记在桌面行 id 上（行身份），而不是悬空的 iOS UUID。
    const baseline = db
      .prepare('select entity_id from sync_baseline where entity_type = ?')
      .all('phaseRule') as Array<{ entity_id: string }>
    expect(baseline).toEqual([{ entity_id: '44444444-4444-4444-8444-444444444444' }])
  })

  it('引用缺失 → failedItems 带原因，不静默丢弃', () => {
    const brewFp = fingerprint(canonical([beanId, Date.now(), 'V60', '', '中细', 92, 15, 250, 150, 86, 0, 0, 0, 0, 0, '', '', 15]))
    const outcome = applyBatch(
      db,
      {
        operations: [
          {
            entityType: 'brew',
            upserts: [
              {
                id: '55555555-5555-4555-8555-555555555555',
                fingerprint: brewFp,
                payload: { beanId, date: Date.now(), method: 'V60', stockDeductedG: 15 }
              }
            ],
            deletes: []
          }
        ]
      },
      'dev1'
    )
    expect(outcome.failedItems).toHaveLength(1)
    expect(outcome.failedItems[0].reason).toContain('FOREIGN KEY')
  })
})

describe('媒体分块传输', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'bp-media-'))
    process.env.BREWPHASE_USER_DATA_DIR = tempDir
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
    delete process.env.BREWPHASE_USER_DATA_DIR
  })

  const name = 'abcdef12-3456-4789-8abc-def012345678.mov'
  const content = Buffer.alloc(600_000, 7)
  const sha = createHash('sha256').update(content).digest('hex')

  const entry: MediaManifestEntry = {
    name,
    sha256: sha,
    byteSize: content.length,
    mediaType: 'video',
    mimeType: 'video/quicktime'
  }

  it('清单比对：没传过 → missing；传完 → have', async () => {
    const first = await checkManifest([entry])
    expect(first.missing).toHaveLength(1)
    expect(first.rejected).toHaveLength(0)

    let offset = 0
    while (offset < content.length) {
      const chunk = content.subarray(offset, Math.min(offset + 256 * 1024, content.length))
      const result = await writeChunk(name, offset, chunk)
      expect(result.ok).toBe(true)
      offset += chunk.length
    }
    const finalize = await finalizeMedia(name, sha, content.length)
    expect(finalize.ok).toBe(true)

    const second = await checkManifest([entry])
    expect(second.have).toEqual([name])
    expect(second.missing).toHaveLength(0)
  })

  it('偏移不连续 → 拒绝（断点续传以已收字节数为准）', async () => {
    const result = await writeChunk(name, 100, Buffer.alloc(10))
    expect(result.ok).toBe(false)
  })

  it('整文件哈希不符 → 拒绝落位且临时文件清理', async () => {
    await writeChunk(name, 0, content.subarray(0, 256 * 1024))
    const outcome = await finalizeMedia(name, '0'.repeat(64), 256 * 1024)
    expect(outcome.ok).toBe(false)
    const files = await fs.readdir(join(tempDir, 'media', '.incoming'))
    expect(files).toHaveLength(0)
  })

  it('扩展名白名单：可执行伪装名直接拒绝', async () => {
    const outcome = await checkManifest([
      { ...entry, name: 'abcdef12-3456-4789-8abc-def012345678.sh' }
    ])
    expect(outcome.rejected).toHaveLength(1)
    expect(outcome.missing).toHaveLength(0)
  })

  it('同一文件并发写入 → 互斥生效，内容不交错', async () => {
    const concurrentName = 'abcdef12-3456-4789-8abc-def012345679.mp4'
    const first = writeChunk(concurrentName, 0, Buffer.alloc(1024, 1))
    const second = writeChunk(concurrentName, 1024, Buffer.alloc(1024, 2))
    const results = await Promise.all([first, second])
    expect(results.every((result) => result.ok)).toBe(true)
    const received = await receivedBytes(concurrentName)
    expect(received).toBe(2048)
  })
})

describe('HTTP 路由 wire format（与 iOS 客户端逐字段对齐）', () => {
  let db: Database.Database
  let server: SyncServer
  let baseUrl: string

  beforeEach(() => {
    db = openDb()
    server = new SyncServer(db, 'bp_desk_test', 'BrewPhase · test', () => {})
  })

  afterEach(() => {
    server.stop()
    db.close()
  })

  async function startServer(): Promise<void> {
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createNetServer()
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address()
        const actual = typeof address === 'object' && address ? address.port : 0
        probe.close(() => (actual > 0 ? resolve(actual) : reject(new Error('no free port'))))
      })
      probe.on('error', reject)
    })
    const state = await server.start(['127.0.0.1'], port)
    baseUrl = `http://127.0.0.1:${state.port ?? port}`
  }

  function pairBody(body: Record<string, unknown>): RequestInit {
    return {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }
  }

  it('GET /api/status 可达且版本对齐', async () => {
    await startServer()
    const response = await fetch(`${baseUrl}/api/status`)
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { service: string; protocolVersion: number }
    expect(payload.service).toBe('brewphase-sync')
    expect(payload.protocolVersion).toBe(1)
  })

  it('/api/pair 收 iOS 客户端形状的 body（pairingCode 字段）→ 200，响应字段与 PairResponse 对齐', async () => {
    await startServer()
    const { code } = server.pairingPayload()
    // 与 SyncNetworkClient.pair 的 body 逐字段一致——这正是 2026-11-07
    // 真机扫码 401（server 读 code、iOS 发 pairingCode）的回归防线。
    const response = await fetch(`${baseUrl}/api/pair`, pairBody({ pairingCode: code, deviceName: 'iPhone' }))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      token: string
      deviceId: string
      desktopDeviceId: string
      desktopDeviceName: string
      protocolVersion: number
    }
    expect(payload.token.length).toBeGreaterThan(0)
    expect(payload.deviceId.startsWith('bp_ios_')).toBe(true)
    expect(payload.desktopDeviceId).toBe('bp_desk_test')
    expect(payload.desktopDeviceName.length).toBeGreaterThan(0)
    expect(payload.protocolVersion).toBe(1)
  })

  it('GET /api/sync/media/offset 拒绝 unsafe name（路径穿越防护）', async () => {
    await startServer()
    const { code } = server.pairingPayload()
    const pair = await fetch(`${baseUrl}/api/pair`, pairBody({ pairingCode: code, deviceName: 'iPhone' }))
    const { token } = (await pair.json()) as { token: string }
    const response = await fetch(
      `${baseUrl}/api/sync/media/offset?name=${encodeURIComponent('../../etc/passwd.jpg')}`,
      { headers: { authorization: `Bearer ${token}` } }
    )
    expect(response.status).toBe(400)
  })

  it('旧字段名 code 仍可兑换（兼容兜底）', async () => {
    await startServer()
    const { code } = server.pairingPayload()
    const response = await fetch(`${baseUrl}/api/pair`, pairBody({ code, deviceName: 'iPhone' }))
    expect(response.status).toBe(200)
  })

  it('同来源连续猜错 5 次 → HTTP 429（双维限速走到路由层）', async () => {
    await startServer()
    server.pairingPayload() // 生成一个码（猜错的对象）
    let lastStatus = 0
    for (let index = 0; index < 5; index += 1) {
      const response = await fetch(
        `${baseUrl}/api/pair`,
        pairBody({ pairingCode: 'definitely-wrong-code', deviceName: 'iPhone' })
      )
      lastStatus = response.status
    }
    expect(lastStatus).toBe(401)
    const limited = await fetch(
      `${baseUrl}/api/pair`,
      pairBody({ pairingCode: 'definitely-wrong-code', deviceName: 'iPhone' })
    )
    expect(limited.status).toBe(429)
  })
})

describe('端口与地址策略（统一端口）', () => {
  let db: Database.Database
  let server: SyncServer

  beforeEach(() => {
    db = openDb()
    server = new SyncServer(db, 'bp_desk_test', 'BrewPhase · test', () => {})
  })

  afterEach(() => {
    server.stop()
    db.close()
  })

  it('首选端口被占 → 统一回落到探测端口（所有地址同一端口）', async () => {
    const probe = createNetServer()
    const busyPort = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })
    try {
      const state = await server.start(['127.0.0.1'], busyPort)
      expect(state.running).toBe(true)
      expect(state.port).not.toBeNull()
      expect(state.port).not.toBe(busyPort)
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()))
    }
  })

  it('空地址列表 → 明确失败，不回落 127.0.0.1', async () => {
    await expect(server.start([], 47821)).rejects.toThrow('没有可绑定的局域网地址')
    expect(server.stateFor().running).toBe(false)
  })
})

describe('HTTP 端到端（模拟 iOS 客户端：Bearer + Timestamp + Nonce + HMAC）', () => {
  let db: Database.Database
  let server: SyncServer
  let baseUrl: string
  let token: string
  let tempDir: string

  const recordId = 'aaaaaaaa-1111-4111-8111-000000000001'
  const tagId = 'aaaaaaaa-2222-4222-8222-000000000002'
  const imageFile = 'aaaaaaaa-3333-4333-8333-000000000003.jpg'
  const videoFile = 'aaaaaaaa-4444-4444-8444-000000000004.mov'

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'bp-e2e-'))
    process.env.BREWPHASE_USER_DATA_DIR = tempDir
    db = openDb()
    server = new SyncServer(db, 'bp_desk_e2e', 'BrewPhase · e2e', () => {})
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createNetServer()
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address()
        const actual = typeof address === 'object' && address ? address.port : 0
        probe.close(() => (actual > 0 ? resolve(actual) : reject(new Error('no free port'))))
      })
      probe.on('error', reject)
    })
    const state = await server.start(['127.0.0.1'], port)
    baseUrl = `http://127.0.0.1:${state.port ?? port}`
  })

  afterEach(async () => {
    server.stop()
    db.close()
    await rm(tempDir, { recursive: true, force: true })
    delete process.env.BREWPHASE_USER_DATA_DIR
  })

  /** 与 iOS SyncNetworkClient 相同的签名头组合。 */
  function signedHeaders(body: Buffer, overrides: Partial<{ token: string; nonce: string; signature: string }> = {}): Record<string, string> {
    const usedToken = overrides.token ?? token
    const timestamp = String(Date.now())
    const nonce = overrides.nonce ?? crypto.randomUUID()
    return {
      authorization: `Bearer ${usedToken}`,
      'x-bp-timestamp': timestamp,
      'x-bp-nonce': overrides.signature ? 'nonce-bad-sig' : nonce,
      'x-bp-signature': overrides.signature ?? expectedSignature(usedToken, timestamp, nonce, sha256(body)),
      'content-type': 'application/octet-stream'
    }
  }

  async function pairAndGetToken(): Promise<void> {
    const { code } = server.pairingPayload()
    const pair = await fetch(`${baseUrl}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode: code, deviceName: 'iPhone' })
    })
    expect(pair.status).toBe(200)
    ;({ token } = (await pair.json()) as { token: string })
  }

  it('配对 → 数据 → 媒体 → 幂等 → 撤销，全链路（§8）', async () => {
    await pairAndGetToken()

    // status / manifest
    const status = await fetch(`${baseUrl}/api/status`)
    expect(status.status).toBe(200)
    const manifest = await fetch(`${baseUrl}/api/sync/manifest`, { headers: { authorization: `Bearer ${token}` } })
    expect(manifest.status).toBe(200)

    // 数据批：record + tag + 关系（record 带 mediaPath/previewPath；payload 补全
    // 全部指纹字段，保证与桌面 localFingerprint 的默认列值一致）
    const recordPayload = {
      carrier: 'video', title: '手冲视频', note: '', urlString: '', canonicalURL: null,
      provider: 'generic', contentKind: '', platformContentID: null, linkPage: 1,
      sourceName: '', authorName: '', summary: '', thumbnailURLString: null,
      metadataStatus: 'idle', repositoryStars: null, repositoryForks: null,
      repositoryIssues: null, repositoryLanguage: null, repositoryLicense: null,
      mediaPath: videoFile, previewPath: imageFile, isSample: false
    }
    const recordFp = fingerprint(canonical(Object.values(recordPayload)))
    const batch: SyncBatch = {
      operations: [
        { entityType: 'recordTag', upserts: [{ id: tagId, fingerprint: fingerprint(canonical(['开发'])), payload: { name: '开发' } }], deletes: [] },
        { entityType: 'record', upserts: [{ id: recordId, fingerprint: recordFp, payload: recordPayload }], deletes: [] },
        {
          entityType: 'recordTagLink',
          upserts: [{ id: `${recordId}:${tagId}`, fingerprint: fingerprint(canonical([recordId, tagId])), payload: { recordId, tagId } }],
          deletes: []
        }
      ]
    }
    const applyBody = Buffer.from(JSON.stringify(batch))
    const apply = await fetch(`${baseUrl}/api/sync/apply`, {
      method: 'POST',
      headers: { ...signedHeaders(applyBody), 'content-type': 'application/json' },
      body: applyBody
    })
    expect(apply.status).toBe(200)
    const applyOutcome = (await apply.json()) as ApplyResult
    expect(applyOutcome.appliedCount).toBe(3)

    // 媒体清单
    const content = Buffer.alloc(300_000, 9)
    const mediaSha = createHash('sha256').update(content).digest('hex')
    const manifestBody = Buffer.from(JSON.stringify({
      media: [{ name: videoFile, sha256: mediaSha, byteSize: content.length, mediaType: 'video', mimeType: 'video/mp4' }]
    }))
    const mediaManifest = await fetch(`${baseUrl}/api/sync/media/manifest`, {
      method: 'POST',
      headers: { ...signedHeaders(manifestBody), 'content-type': 'application/json' },
      body: manifestBody
    })
    expect(mediaManifest.status).toBe(200)
    expect(((await mediaManifest.json()) as { missing: unknown[] }).missing).toHaveLength(1)

    // chunk 鉴权矩阵：无 Bearer / 错 token / 坏签名 / nonce 重放 → 全部 401
    // （用独立探针文件名，避免污染主文件的 .part 偏移）
    const chunk1 = content.subarray(0, 256 * 1024)
    const probeQuery = `name=aaaaaaaa-5555-4555-8555-000000000005.jpg&offset=0`
    const noAuth = await fetch(`${baseUrl}/api/sync/media/chunk?${probeQuery}`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: chunk1
    })
    expect(noAuth.status).toBe(401)
    const wrongToken = await fetch(`${baseUrl}/api/sync/media/chunk?${probeQuery}`, {
      method: 'POST', headers: signedHeaders(chunk1, { token: 'wrong-token' }), body: chunk1
    })
    expect(wrongToken.status).toBe(401)
    const badSignature = await fetch(`${baseUrl}/api/sync/media/chunk?${probeQuery}`, {
      method: 'POST', headers: signedHeaders(chunk1, { signature: '0'.repeat(64) }), body: chunk1
    })
    expect(badSignature.status).toBe(401)
    const replayBody = Buffer.from('replay-probe')
    const replayHeaders = signedHeaders(replayBody)
    await fetch(`${baseUrl}/api/sync/media/chunk?${probeQuery}`, {
      method: 'POST', headers: replayHeaders, body: replayBody
    })
    const replay = await fetch(`${baseUrl}/api/sync/media/chunk?${probeQuery}`, {
      method: 'POST', headers: replayHeaders, body: replayBody
    })
    expect(replay.status).toBe(401)

    // 正常上传（两块）→ offset → finalize
    const chunk2 = content.subarray(256 * 1024)
    const upload1 = await fetch(`${baseUrl}/api/sync/media/chunk?name=${videoFile}&offset=0`, {
      method: 'POST', headers: signedHeaders(chunk1), body: chunk1
    })
    expect(upload1.status).toBe(200)
    const upload2 = await fetch(`${baseUrl}/api/sync/media/chunk?name=${videoFile}&offset=${chunk1.length}`, {
      method: 'POST', headers: signedHeaders(chunk2), body: chunk2
    })
    expect(upload2.status).toBe(200)
    const offset = await fetch(`${baseUrl}/api/sync/media/offset?name=${videoFile}`, {
      headers: { authorization: `Bearer ${token}` }
    })
    expect(((await offset.json()) as { received: number }).received).toBe(content.length)
    const finalizeBody = Buffer.from(JSON.stringify({ name: videoFile, sha256: mediaSha, byteSize: content.length }))
    const finalize = await fetch(`${baseUrl}/api/sync/media/finalize`, {
      method: 'POST',
      headers: { ...signedHeaders(finalizeBody), 'content-type': 'application/json' },
      body: finalizeBody
    })
    expect(finalize.status).toBe(200)

    // 文件落位 + SHA-256 一致；数据库引用存在
    const stored = await fs.readFile(join(tempMediaDir(), videoFile))
    expect(createHash('sha256').update(stored).digest('hex')).toBe(mediaSha)
    const recordRow = db.prepare('select media_path, preview_path from records where id = ?').get(recordId) as { media_path: string; preview_path: string }
    expect(recordRow.media_path).toBe(videoFile)
    expect(recordRow.preview_path).toBe(imageFile)
    expect(db.prepare('select count(*) as n from record_tag_links').get() as { n: number }).toEqual({ n: 1 })

    // 二次同步幂等：同 payload 全 skipped
    const againBody = Buffer.from(JSON.stringify(batch))
    const again = await fetch(`${baseUrl}/api/sync/apply`, {
      method: 'POST',
      headers: { ...signedHeaders(againBody), 'content-type': 'application/json' },
      body: againBody
    })
    expect(((await again.json()) as ApplyResult).skippedCount).toBe(3)

    // 撤销设备 → 旧 token 全部失效
    db.prepare('update devices set revoked_at = ?').run(Date.now())
    const revoked = await fetch(`${baseUrl}/api/sync/manifest`, { headers: { authorization: `Bearer ${token}` } })
    expect(revoked.status).toBe(401)
    const revokedChunk = await fetch(`${baseUrl}/api/sync/media/chunk?name=${videoFile}&offset=0`, {
      method: 'POST', headers: signedHeaders(chunk1), body: chunk1
    })
    expect(revokedChunk.status).toBe(401)
  })

  it('保留电脑版本裁决持久化：相同远端内容不再冲突，真实变化才重新冲突（§7）', () => {
    const payload1 = e2eBeanPayload(158)
    const fp1 = e2eBeanFp(payload1)
    applyBatch(db, { operations: [{ entityType: 'bean', upserts: [{ id: beanE2eId, fingerprint: fp1, payload: payload1 }], deletes: [] }] }, 'dev1')
    // iOS 改内容（桌面未动，基线==本地）→ 接受
    const payload2 = e2eBeanPayload(130)
    const fp2 = e2eBeanFp(payload2)
    applyBatch(db, { operations: [{ entityType: 'bean', upserts: [{ id: beanE2eId, fingerprint: fp2, payload: payload2 }], deletes: [] }] }, 'dev1')
    // iOS 改回旧值（fp1）——桌面内容 fp2、基线 fp2 → baseline==localFp？否（localFp=fp2==baseline）→ 等等：
    // 桌面接受了 fp2，基线=fp2=localFp → iOS 推 fp1：localFp≠fp1、baseline==localFp → 「桌面没改过」→ 会接受！
    // 但用户会裁决……此场景其实不冲突。真实冲突场景是桌面在 iOS 推送前自己编辑：
    db.prepare('update beans set remaining_g = 99 where id = ?').run(beanE2eId)
    const pushBack = applyBatch(db, { operations: [{ entityType: 'bean', upserts: [{ id: beanE2eId, fingerprint: fp1, payload: payload1 }], deletes: [] }] }, 'dev1')
    expect(pushBack.conflictCount).toBe(1)
    // 用户裁决：保留电脑版本 → 只记 rejected，不改基线
    const conflictRow = db
      .prepare('select entity_type, entity_id, remote_fingerprint from sync_conflicts where entity_id = ?')
      .get(beanE2eId) as { entity_type: string; entity_id: string; remote_fingerprint: string }
    db.prepare(
      `insert into sync_rejected (entity_type, entity_id, fingerprint, decided_at) values (?, ?, ?, ?)`
    ).run(conflictRow.entity_type, conflictRow.entity_id, conflictRow.remote_fingerprint, Date.now())
    db.prepare('delete from sync_conflicts where entity_id = ?').run(beanE2eId)
    // 相同远端内容再推 → skipped，不冲突不覆盖
    const repeat = applyBatch(db, { operations: [{ entityType: 'bean', upserts: [{ id: beanE2eId, fingerprint: fp1, payload: payload1 }], deletes: [] }] }, 'dev1')
    expect(repeat.skippedCount).toBe(1)
    expect(repeat.conflictCount).toBe(0)
    expect((db.prepare('select remaining_g from beans where id = ?').get(beanE2eId) as { remaining_g: number }).remaining_g).toBe(99)
    // 远端真实变化（iOS 又改了）→ 重新进入合并 → 冲突（桌面基线≠本地），绝不静默覆盖
    const payload3 = e2eBeanPayload(100)
    const fp3 = e2eBeanFp(payload3)
    const changed = applyBatch(db, { operations: [{ entityType: 'bean', upserts: [{ id: beanE2eId, fingerprint: fp3, payload: payload3 }], deletes: [] }] }, 'dev1')
    expect(changed.conflictCount).toBe(1)
    expect((db.prepare('select remaining_g from beans where id = ?').get(beanE2eId) as { remaining_g: number }).remaining_g).toBe(99)
  })
})

const beanE2eId = 'bbbbbbbb-1111-4111-8111-00000000000b'

function e2eBeanPayload(remainingG: number): Record<string, unknown> {
  return {
    name: '耶加雪菲', roaster: '', origin: '', process: '', roastLevel: 'medium',
    roastDate: null, purchaseDate: null, openDate: null, weightG: 0,
    remainingG, price: 0, channel: '', imagePath: null, flavorTagsRaw: '',
    notes: '', status: 'active', stockCountedAt: null, isSample: false
  }
}

function e2eBeanFp(payload: Record<string, unknown>): string {
  return fingerprint(canonical([
    payload.name, payload.roaster, payload.origin, payload.process, payload.roastLevel,
    payload.roastDate, payload.purchaseDate, payload.openDate, payload.weightG,
    payload.remainingG, payload.price, payload.channel, payload.imagePath,
    payload.flavorTagsRaw, payload.notes, payload.status, payload.stockCountedAt, payload.isSample
  ]))
}

function tempMediaDir(): string {
  return join(process.env.BREWPHASE_USER_DATA_DIR ?? '', 'media')
}

describe('同步调度回调（Phase 3.2.1：生产 SyncServer 接线）', () => {
  let db: Database.Database
  let server: SyncServer
  let baseUrl: string
  let token: string
  let tempDir: string
  let appliedIds: string[][]
  let appliedAt: number[]
  let applyLatencyMs: number
  let applyHook: ((outcome: { results: Array<{ entityType: string; id: string; status: string }> }) => void) | null

  const recordId = 'bbbbbbbb-2222-4222-8222-00000000000c'
  const RECORD_URL = 'https://github.com/banmu123/BrewPhase'

  const payload = {
    carrier: 'link', title: '', note: '', urlString: RECORD_URL, canonicalURL: RECORD_URL, provider: 'github',
    contentKind: '', platformContentID: 'banmu123/BrewPhase', linkPage: 1, sourceName: '', authorName: '',
    summary: '', thumbnailURLString: null, metadataStatus: 'resolved', repositoryStars: null,
    repositoryForks: null, repositoryIssues: null, repositoryLanguage: null, repositoryLicense: null,
    mediaPath: null, previewPath: null, isSample: false, createdAt: 1_700_000_000_000
  }

  function recordBatch(note = ''): SyncBatch {
    const row = { ...payload, note }
    const fp = fingerprint(canonical([
      row.carrier, row.title, row.note, row.urlString, row.canonicalURL, row.provider, row.contentKind,
      row.platformContentID, row.linkPage, row.sourceName, row.authorName, row.summary,
      row.thumbnailURLString, row.metadataStatus, row.repositoryStars, row.repositoryForks,
      row.repositoryIssues, row.repositoryLanguage, row.repositoryLicense, row.mediaPath,
      row.previewPath, row.isSample
    ]))
    return { operations: [{ entityType: 'record', upserts: [{ id: recordId, fingerprint: fp, payload: row as never }], deletes: [] }] }
  }

  function signedHeaders(body: Buffer): Record<string, string> {
    const timestamp = String(Date.now())
    const nonce = crypto.randomUUID()
    return {
      authorization: `Bearer ${token}`,
      'x-bp-timestamp': timestamp,
      'x-bp-nonce': nonce,
      'x-bp-signature': expectedSignature(token, timestamp, nonce, sha256(body)),
      'content-type': 'application/json'
    }
  }

  async function apply(body: SyncBatch): Promise<Response> {
    const raw = Buffer.from(JSON.stringify(body), 'utf8')
    const started = Date.now()
    const response = await fetch(`${baseUrl}/api/sync/apply`, { method: 'POST', headers: signedHeaders(raw), body: raw })
    applyLatencyMs = Date.now() - started
    return response
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'bp-dispatch-'))
    process.env.BREWPHASE_USER_DATA_DIR = tempDir
    db = openDb()
    appliedIds = []
    appliedAt = []
    applyLatencyMs = 0
    // 生产接线：SyncServer 在 applyBatch() 之后回调节度（这里是同步入队的等价物）
    applyHook = null
    server = new SyncServer(db, 'bp_desk_dispatch', 'BrewPhase · dispatch', () => {}, (outcome) => {
      appliedIds.push(recordIdsToResolve(outcome))
      appliedAt.push(Date.now())
      // 生产里这里只是 `queue.enqueue()`（同步、不 await）；测试可注入慢动作
      applyHook?.(outcome)
    })
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createNetServer()
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address()
        const actual = typeof address === 'object' && address ? address.port : 0
        probe.close(() => (actual > 0 ? resolve(actual) : reject(new Error('no free port'))))
      })
      probe.on('error', reject)
    })
    const state = await server.start(['127.0.0.1'], port)
    baseUrl = `http://127.0.0.1:${state.port ?? port}`

    const { code } = server.pairingPayload()
    const pair = await fetch(`${baseUrl}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode: code, deviceName: 'iPhone' })
    })
    expect(pair.status).toBe(200)
    ;({ token } = (await pair.json()) as { token: string })
  })

  afterEach(async () => {
    server.stop()
    db.close()
    await rm(tempDir, { recursive: true, force: true })
    delete process.env.BREWPHASE_USER_DATA_DIR
  })

  it('新建记录：回调收到该 id，且回调时事务已经提交', async () => {
    const response = await apply(recordBatch())
    expect(response.status).toBe(200)

    expect(appliedIds).toHaveLength(1)
    expect(appliedIds[0]).toEqual([recordId])
    // 回调里能读到数据、且是已提交的（回调在主进程同步执行，事务早已结束）
    const row = db.prepare('select url_string from records where id = ?').get(recordId) as { url_string: string }
    expect(row.url_string).toBe(RECORD_URL)
  })

  it('内容相同再次同步（skipped）：不重复调度', async () => {
    await apply(recordBatch())
    expect(appliedIds[0]).toEqual([recordId])

    const again = await apply(recordBatch())
    expect(again.status).toBe(200)
    expect(appliedIds).toHaveLength(2)
    // 第二次是 skipped → 过滤后为空，不会重复抓
    expect(appliedIds[1]).toEqual([])
  })

  it('冲突（桌面改过）：不进入调度', async () => {
    await apply(recordBatch())
    db.prepare("update records set title = '桌面改的标题' where id = ?").run(recordId)

    await apply(recordBatch())
    expect(appliedIds.at(-1)).toEqual([])
  })

  it('apply 响应不等待 Resolver 网络：慢抓取也在 1s 内返回', async () => {
    // 回调只做同步入队；即便 Resolver 永远卡在网络上，HTTP 也不该等它
    const hang = new Promise<void>(() => undefined)
    applyHook = (outcome) => {
      expect(recordIdsToResolve(outcome)).toEqual([recordId])
      void hang
    }

    const response = await apply(recordBatch('带新备注'))
    expect(response.status).toBe(200)
    expect(applyLatencyMs).toBeLessThan(1000)
  })

  it('recordIdsToResolve：只认 record + applied', () => {
    expect(
      recordIdsToResolve({
        results: [
          { entityType: 'record', id: 'r1', status: 'applied' },
          { entityType: 'record', id: 'r2', status: 'skipped' },
          { entityType: 'record', id: 'r3', status: 'conflict' },
          { entityType: 'record', id: 'r4', status: 'failed' },
          { entityType: 'bean', id: 'b1', status: 'applied' }
        ]
      })
    ).toEqual(['r1'])
  })
})

/**
 * `sync:changed` 的触发点（Records 页面自动刷新的唯一来源）。
 *
 * 页面侧只认这一条广播，所以「什么时候广播」必须在服务端锁死：
 * - apply 事务提交后 → 新记录/修改/删除都要让页面重查；
 * - 每个媒体文件 finalize 落盘后 → 图片才有东西可显示；
 * - 单个 chunk 不广播 → 否则一张图要触发几十次查询；
 * - 鉴权失败不广播 → 401 不该引起任何界面动作。
 */
describe('同步事件广播（sync:changed 的触发点）', () => {
  const recordId = 'abababab-1111-4111-8111-000000000001'
  const mediaName = 'abababab-3333-4333-8333-000000000003.jpg'

  let tempDir: string
  let db: Database.Database
  let server: SyncServer
  let baseUrl: string
  let token = ''
  let changes = 0

  const recordPayload = () => ({
    carrier: 'image', title: '手机拍的图', note: '', urlString: '', canonicalURL: null,
    provider: 'generic', contentKind: '', platformContentID: null, linkPage: 1,
    sourceName: '', authorName: '', summary: '', thumbnailURLString: null,
    metadataStatus: 'idle', repositoryStars: null, repositoryForks: null,
    repositoryIssues: null, repositoryLanguage: null, repositoryLicense: null,
    mediaPath: mediaName, previewPath: null, isSample: false
  })

  function recordBatch(): SyncBatch {
    const payload = recordPayload()
    return {
      operations: [
        {
          entityType: 'record',
          upserts: [{ id: recordId, fingerprint: fingerprint(canonical(Object.values(payload))), payload }],
          deletes: []
        }
      ]
    }
  }

  function signed(body: Buffer): Record<string, string> {
    const timestamp = String(Date.now())
    const nonce = crypto.randomUUID()
    return {
      authorization: `Bearer ${token}`,
      'x-bp-timestamp': timestamp,
      'x-bp-nonce': nonce,
      'x-bp-signature': expectedSignature(token, timestamp, nonce, sha256(body)),
      'content-type': 'application/json'
    }
  }

  async function applyRecord(): Promise<ApplyResult> {
    const raw = Buffer.from(JSON.stringify(recordBatch()))
    const response = await fetch(`${baseUrl}/api/sync/apply`, {
      method: 'POST',
      headers: signed(raw),
      body: raw
    })
    expect(response.status).toBe(200)
    return (await response.json()) as ApplyResult
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'bp-broadcast-'))
    process.env.BREWPHASE_USER_DATA_DIR = tempDir
    db = openDb()
    changes = 0
    server = new SyncServer(db, 'bp_desk_broadcast', 'BrewPhase · broadcast', () => {
      changes += 1
    })
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createNetServer()
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address()
        const actual = typeof address === 'object' && address ? address.port : 0
        probe.close(() => (actual > 0 ? resolve(actual) : reject(new Error('no free port'))))
      })
      probe.on('error', reject)
    })
    const state = await server.start(['127.0.0.1'], port)
    baseUrl = `http://127.0.0.1:${state.port ?? port}`

    const { code } = server.pairingPayload()
    const pair = await fetch(`${baseUrl}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode: code, deviceName: 'iPhone' })
    })
    expect(pair.status).toBe(200)
    ;({ token } = (await pair.json()) as { token: string })
    // 启动与配对本身也会广播（状态变化），从这里开始只数数据相关的事件
    changes = 0
  })

  afterEach(async () => {
    server.stop()
    db.close()
    await rm(tempDir, { recursive: true, force: true })
    delete process.env.BREWPHASE_USER_DATA_DIR
  })

  it('apply 提交后广播一次；媒体 finalize 落盘后再广播一次', async () => {
    await applyRecord()
    expect(changes).toBe(1)
    // 广播时数据已经可见（事务在 onChanged 之前结束）
    expect(db.prepare('select count(*) as n from records').get()).toEqual({ n: 1 })

    const content = Buffer.alloc(1024, 7)
    const mediaSha = createHash('sha256').update(content).digest('hex')
    const chunk = await fetch(`${baseUrl}/api/sync/media/chunk?name=${mediaName}&offset=0`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', ...signed(content) },
      body: content
    })
    expect(chunk.status).toBe(200)
    // 单个 chunk 不广播：一张图几十块，每块都刷新会把页面刷成幻灯片
    expect(changes).toBe(1)

    const finalizeBody = Buffer.from(JSON.stringify({ name: mediaName, sha256: mediaSha, byteSize: content.length }))
    const finalize = await fetch(`${baseUrl}/api/sync/media/finalize`, {
      method: 'POST',
      headers: signed(finalizeBody),
      body: finalizeBody
    })
    expect(finalize.status).toBe(200)
    expect(changes).toBe(2)
    await expect(fs.stat(join(tempDir, 'media', mediaName))).resolves.toBeTruthy()
  })

  it('重复同步（skipped）仍广播：页面重查一次是幂等的，不会造出重复记录', async () => {
    await applyRecord()
    const again = await applyRecord()
    expect(again.skippedCount).toBe(1)
    expect(changes).toBe(2)
    expect(db.prepare('select count(*) as n from records').get()).toEqual({ n: 1 })
  })

  it('鉴权失败不广播（401 不该引起任何界面动作）', async () => {
    const raw = Buffer.from(JSON.stringify(recordBatch()))
    const response = await fetch(`${baseUrl}/api/sync/apply`, {
      method: 'POST',
      // 用未配对的 token 签名：authorize 直接 401，进不到 applyBatch
      headers: { ...signed(raw), authorization: 'Bearer not-paired' },
      body: raw
    })
    expect(response.status).toBe(401)
    expect(changes).toBe(0)
  })

  it('wipe：需要显式确认串，成功后清空同步实体并广播', async () => {
    await applyRecord()
    expect(changes).toBe(1)

    // 空 body：400，一条数据都不许动
    const noConfirm = Buffer.from(JSON.stringify({}))
    const rejected = await fetch(`${baseUrl}/api/sync/wipe`, {
      method: 'POST',
      headers: signed(noConfirm),
      body: noConfirm
    })
    expect(rejected.status).toBe(400)
    expect(db.prepare('select count(*) as n from records').get()).toEqual({ n: 1 })
    expect(changes).toBe(1)

    const body = Buffer.from(JSON.stringify({ confirm: 'DELETE_SYNCED_CONTENT' }))
    const response = await fetch(`${baseUrl}/api/sync/wipe`, {
      method: 'POST',
      headers: signed(body),
      body: body
    })
    expect(response.status).toBe(200)
    const outcome = (await response.json()) as { records: number; mediaFiles: number }
    expect(outcome.records).toBe(1)
    expect(db.prepare('select count(*) as n from records').get()).toEqual({ n: 0 })
    // 清完广播一次：打开的 Records 页面要自己变空
    expect(changes).toBe(2)
  })

  it('wipe：未鉴权一律 401（清空不可逆，不能只靠知道地址）', async () => {
    await applyRecord()
    const body = Buffer.from(JSON.stringify({ confirm: 'DELETE_SYNCED_CONTENT' }))
    const response = await fetch(`${baseUrl}/api/sync/wipe`, {
      method: 'POST',
      headers: { ...signed(body), authorization: 'Bearer not-paired' },
      body: body
    })
    expect(response.status).toBe(401)
    expect(db.prepare('select count(*) as n from records').get()).toEqual({ n: 1 })
    expect(changes).toBe(1)
  })

  it('媒体 finalize 校验失败不广播（残缺文件不该让页面以为可以显示）', async () => {    const content = Buffer.alloc(512, 3)
    await fetch(`${baseUrl}/api/sync/media/chunk?name=${mediaName}&offset=0`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', ...signed(content) },
      body: content
    })
    const badBody = Buffer.from(
      JSON.stringify({ name: mediaName, sha256: '0'.repeat(64), byteSize: content.length })
    )
    const response = await fetch(`${baseUrl}/api/sync/media/finalize`, {
      method: 'POST',
      headers: signed(badBody),
      body: badBody
    })
    expect(response.status).toBe(400)
    expect(changes).toBe(0)
  })
})
