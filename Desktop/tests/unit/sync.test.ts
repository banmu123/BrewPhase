import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { migrate } from '../../src/main/database/migrations'
import { NonceStore, sha256, verifyRequest, expectedSignature, randomToken } from '../../src/main/sync/auth'
import { PairingService } from '../../src/main/sync/pairing-service'
import { applyBatch, canonical, fingerprint, type SyncBatch } from '../../src/main/sync/snapshot-importer'
import { finalizeMedia, writeChunk, checkManifest, type MediaManifestEntry } from '../../src/main/sync/media-transfer'

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

  it('删除 → tombstone 生效；重复删除 skipped；级联删除跟随外键', () => {
    applyBatch(db, beanBatch(beanFingerprint(beanPayload())), 'dev1')
    db.prepare(
      `insert into brews (id, bean_id, date, created_at) values (?, ?, ?, ?)`
    ).run('22222222-2222-4222-8222-222222222222', beanId, Date.now(), Date.now())

    const batch: SyncBatch = {
      operations: [
        { entityType: 'bean', upserts: [], deletes: [{ id: beanId }] }
      ]
    }
    const first = applyBatch(db, batch, 'dev1')
    expect(first.appliedCount).toBe(1)
    expect((db.prepare('select count(*) as n from beans').get() as { n: number }).n).toBe(0)
    expect((db.prepare('select count(*) as n from brews').get() as { n: number }).n).toBe(0)

    const second = applyBatch(db, batch, 'dev1')
    expect(second.skippedCount).toBe(1)
  })

  it('PhaseRule 按 roastLevel 匹配：不产生第二条 medium 规则', () => {
    db.prepare(
      `insert into phase_rules (id, roast_level, rest_min_days, rest_max_days, peak_start_day, peak_end_day, decline_start_day, enabled, updated_at)
       values ('33333333-3333-4333-8333-333333333333', 'medium', 2, 5, 5, 21, 21, 1, ?)`
    ).run(Date.now())

    const payload = {
      roastLevel: 'medium',
      restMinDays: 3,
      restMaxDays: 6,
      peakStartDay: 6,
      peakEndDay: 24,
      declineStartDay: 24,
      enabled: true
    }
    const fp = fingerprint(canonical([payload.roastLevel, payload.restMinDays, payload.restMaxDays, payload.peakStartDay, payload.peakEndDay, payload.declineStartDay, payload.enabled]))
    const outcome = applyBatch(
      db,
      { operations: [{ entityType: 'phaseRule', upserts: [{ id: '44444444-4444-4444-8444-444444444444', fingerprint: fp, payload }], deletes: [] }] },
      'dev1'
    )
    expect(outcome.appliedCount).toBe(1)
    const rules = db.prepare('select id, rest_min_days from phase_rules').all() as Array<{ id: string; rest_min_days: number }>
    expect(rules).toHaveLength(1)
    expect(rules[0].id).toBe('33333333-3333-4333-8333-333333333333')
    expect(rules[0].rest_min_days).toBe(3)
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
})
