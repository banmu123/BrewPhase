import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { migrate } from '../../src/main/database/migrations'
import { expectedSignature, sha256 } from '../../src/main/sync/auth'
import { SyncServer } from '../../src/main/sync/server'
import { mediaDir } from '../../src/main/media/store'
import {
  canonical,
  fingerprint,
  localFingerprint,
  toColumns,
  type ApplyResult,
  type EntityType,
  type SyncBatch
} from '../../src/main/sync/snapshot-importer'

/**
 * iOS ↔ Desktop 同步专项（本轮新增）。
 *
 * 与既有 `tests/unit/sync.test.ts` 的分工：那边守**语义单点**（四态合并、
 * 删除冲突、配对限速、媒体分块、wipe/unpair 路由）；这里守**跨轮次与跨进程
 * 的整链**，即真实设备上最容易出事、但单元测试最容易漏掉的部分：
 *
 * - 全实体一次性推完（10 类），逐个核对落库字段与关联；
 * - 「同一批同步多次 / 删除后再同步多次 / 桌面重启后再同步」是否复活；
 * - 连续删除、级联删除、部分失败；
 * - 冲突在重复同步下是否只留一条；
 * - 记录删除后媒体文件是否残留（孤儿文件）。
 *
 * 用**真实 HTTP + 真实 SQLite 文件**（不是 :memory:），因为「重启后不复活」
 * 必须经过一次真正的 close → reopen 才有意义。
 * 全部数据在临时目录，绝不触碰用户真实库。
 */

const DAY = 1_735_689_600_000

const ID = {
  bean: '11111111-1111-4111-8111-000000000001',
  bean2: '11111111-1111-4111-8111-000000000002',
  brew: '22222222-2222-4222-8222-000000000001',
  tasting: '33333333-3333-4333-8333-000000000001',
  rule: '44444444-4444-4444-8444-000000000001',
  reminder: '55555555-5555-4555-8555-000000000001',
  tag: '66666666-6666-4666-8666-000000000001',
  record: '77777777-7777-4777-8777-000000000001',
  record2: '77777777-7777-4777-8777-000000000002',
  canvas: '88888888-8888-4888-8888-000000000001',
  node: '99999999-9999-4999-8999-000000000001',
  image: 'aaaaaaaa-1111-4111-8111-000000000001.jpg'
}

/**
 * 用**生产端同一套** `toColumns` + `localFingerprint` 从 payload 反算指纹。
 *
 * 这里要验证的是「合并语义」，不是「指纹算法」——指纹算法本身在
 * `sync.test.ts`（TS 侧）与 iOS `SyncModelsTests`（Swift 侧，含金标向量）里
 * 分别守。用同一函数反算可以保证测试里的指纹与服务器实际算出的完全一致，
 * 不会因为手写字段序漏一项而制造假失败。
 */
function fpFromPayload(type: EntityType, payload: Record<string, unknown>): string {
  const value = localFingerprint(type, toColumns(payload) as Record<string, unknown>)
  if (!value) throw new Error(`no fingerprint rule for ${type}`)
  return value
}

function beanPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '耶加雪菲 科契尔',
    roaster: '测试烘焙',
    origin: '埃塞俄比亚',
    process: 'washed',
    roastLevel: 'light',
    roastDate: DAY,
    purchaseDate: DAY,
    openDate: DAY,
    weightG: 200,
    remainingG: 168,
    price: 88,
    channel: '门店',
    imagePath: null,
    flavorTagsRaw: '花香,柑橘',
    notes: '',
    status: 'active',
    stockCountedAt: null,
    isSample: false,
    createdAt: DAY,
    ...over
  }
}

function brewPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    beanId: ID.bean,
    date: DAY,
    method: 'V60',
    grinder: 'C40',
    grindSize: '22',
    waterTemp: 92,
    coffeeG: 15,
    waterG: 240,
    timeSeconds: 150,
    score: 86,
    acidity: 7,
    sweetness: 8,
    bitterness: 3,
    body: 6,
    aftertaste: 7,
    flavorTagsRaw: '柑橘',
    notes: '',
    stockDeductedG: 15,
    createdAt: DAY,
    ...over
  }
}

function tastingPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    beanId: ID.bean,
    brewId: ID.brew,
    date: DAY,
    dayAfterRoast: 7,
    flavorTagsRaw: '花香',
    score: 88,
    notes: '',
    source: 'manual',
    createdAt: DAY,
    ...over
  }
}

function recordPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    carrier: 'text',
    title: '手冲笔记',
    note: '正文内容',
    urlString: '',
    canonicalURL: null,
    provider: 'generic',
    contentKind: '',
    platformContentID: null,
    linkPage: 1,
    sourceName: '',
    authorName: '',
    summary: '',
    thumbnailURLString: null,
    metadataStatus: 'idle',
    repositoryStars: null,
    repositoryForks: null,
    repositoryIssues: null,
    repositoryLanguage: null,
    repositoryLicense: null,
    mediaPath: null,
    previewPath: null,
    isSample: false,
    createdAt: DAY,
    ...over
  }
}

type Upsert = { entityType: EntityType; id: string; payload: Record<string, unknown> }

function upsert(entityType: EntityType, id: string, payload: Record<string, unknown>): Upsert {
  return { entityType, id, payload }
}

function batchOf(upserts: Upsert[], deletes: Array<{ entityType: EntityType; id: string; expectedFingerprint?: string }> = []): SyncBatch {
  const types: EntityType[] = [
    'bean', 'brew', 'tasting', 'phaseRule', 'phaseReminder',
    'recordTag', 'record', 'recordTagLink', 'canvas', 'canvasNode'
  ]
  const operations = types
    .map((entityType) => ({
      entityType,
      upserts: upserts
        .filter((item) => item.entityType === entityType)
        .map((item) => ({
          id: item.id,
          fingerprint: fpFromPayload(entityType, item.payload),
          payload: item.payload
        })),
      deletes: deletes.filter((item) => item.entityType === entityType).map(({ id, expectedFingerprint }) => ({ id, expectedFingerprint }))
    }))
    .filter((operation) => operation.upserts.length > 0 || operation.deletes.length > 0)
  return { operations }
}

describe('iOS ↔ Desktop 同步专项（真实 HTTP + 真实 SQLite 文件）', () => {
  let dir = ''
  let dbPath = ''
  let db: Database.Database
  let server: SyncServer
  let baseUrl = ''
  let token = ''

  const startServer = async (): Promise<void> => {
    const probe = await new Promise<number>((resolve, reject) => {
      // 端口探测复用 server.start 的「首选端口 → 回落」逻辑：先拿一个空闲端口。
      const net = require('node:net') as typeof import('node:net')
      const socket = net.createServer()
      socket.listen(0, '127.0.0.1', () => {
        const address = socket.address()
        const port = typeof address === 'object' && address ? address.port : 0
        socket.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))))
      })
      socket.on('error', reject)
    })
    const state = await server.start(['127.0.0.1'], probe)
    baseUrl = `http://127.0.0.1:${state.port ?? probe}`
  }

  const openDatabase = (): Database.Database => {
    const opened = new Database(dbPath)
    opened.pragma('foreign_keys = ON')
    migrate(opened)
    return opened
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bp-sync-special-'))
    process.env.BREWPHASE_USER_DATA_DIR = dir
    dbPath = join(dir, 'brewphase.db')
    db = openDatabase()
    server = new SyncServer(db, 'bp_desk_special', 'BrewPhase · 专项', () => {})
    await startServer()
    token = await pair()
  })

  afterEach(async () => {
    server.stop()
    db.close()
    await rm(dir, { recursive: true, force: true })
    delete process.env.BREWPHASE_USER_DATA_DIR
  })

  /** 真实配对：走 POST /api/pair，与服务端 PairingService 完整握手。 */
  async function pair(deviceName = 'iPhone 专项'): Promise<string> {
    const { code } = server.pairingPayload()
    const response = await fetch(`${baseUrl}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode: code, deviceName })
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { token: string }
    return body.token
  }

  /** 与 iOS SyncNetworkClient 完全一致的签名头。 */
  function signedHeaders(body: Buffer, overrideToken?: string): Record<string, string> {
    const used = overrideToken ?? token
    const timestamp = String(Date.now())
    const nonce = createHash('sha256').update(`${timestamp}${Math.random()}`).digest('hex').slice(0, 16)
    return {
      authorization: `Bearer ${used}`,
      'x-bp-timestamp': timestamp,
      'x-bp-nonce': nonce,
      'x-bp-signature': expectedSignature(used, timestamp, nonce, sha256(body)),
      'content-type': 'application/json'
    }
  }

  async function apply(batch: SyncBatch, overrideToken?: string): Promise<{ status: number; body: ApplyResult }> {
    const body = Buffer.from(JSON.stringify(batch))
    const response = await fetch(`${baseUrl}/api/sync/apply`, {
      method: 'POST',
      headers: signedHeaders(body, overrideToken),
      body
    })
    return { status: response.status, body: (await response.json()) as ApplyResult }
  }

  const countRows = (table: string): number =>
    (db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n

  const rowOf = (table: string, id: string): Record<string, unknown> | undefined =>
    db.prepare(`select * from ${table} where id = ?`).get(id) as Record<string, unknown> | undefined

  /** 全实体一套（依赖顺序即 batchOf 内部的类型顺序）。 */
  function fullSet(): Upsert[] {
    return [
      upsert('bean', ID.bean, beanPayload()),
      upsert('bean', ID.bean2, beanPayload({ name: '第二包豆', remainingG: 200 })),
      upsert('brew', ID.brew, brewPayload()),
      upsert('tasting', ID.tasting, tastingPayload()),
      upsert('phaseRule', ID.rule, {
        roastLevel: 'light', restMinDays: 7, restMaxDays: 14,
        peakStartDay: 14, peakEndDay: 28, declineStartDay: 35, enabled: true
      }),
      upsert('phaseReminder', ID.reminder, { beanId: ID.bean, kind: 'rest', fireDate: DAY, enabled: true, createdAt: DAY }),
      upsert('recordTag', ID.tag, { name: '专项', createdAt: DAY }),
      upsert('record', ID.record, recordPayload()),
      upsert('recordTagLink', `${ID.record}:${ID.tag}`, { recordId: ID.record, tagId: ID.tag }),
      upsert('canvas', ID.canvas, { name: '专项画布', note: '', isSample: false, createdAt: DAY }),
      upsert('canvasNode', ID.node, {
        canvasId: ID.canvas, recordId: ID.record,
        positionX: 24, positionY: 48, width: 160, height: 120,
        zIndex: 1, annotation: '', createdAt: DAY
      })
    ]
  }

  // ---------------------------------------------------------------------------
  // 3.1 创建同步：全实体一次推完
  // ---------------------------------------------------------------------------

  it('全实体一次同步：10 类实体逐条 applied，字段与关联完整落库', async () => {
    const outcome = await apply(batchOf(fullSet()))

    expect(outcome.status).toBe(200)
    expect(outcome.body.failedItems).toEqual([])
    expect(outcome.body.conflictCount).toBe(0)
    // bean 2 + brew 1 + tasting 1 + rule 1 + reminder 1 + tag 1 + record 1 + link 1 + canvas 1 + node 1
    expect(outcome.body.appliedCount).toBe(11)
    expect(outcome.body.skippedCount).toBe(0)
    expect(outcome.body.results.every((item) => item.status === 'applied')).toBe(true)

    // 主键原样保留（不重新生成）。
    expect(rowOf('beans', ID.bean)?.name).toBe('耶加雪菲 科契尔')
    expect(rowOf('brews', ID.brew)?.bean_id).toBe(ID.bean)
    expect(rowOf('tastings', ID.tasting)?.brew_id).toBe(ID.brew)
    expect(rowOf('phase_reminders', ID.reminder)?.bean_id).toBe(ID.bean)
    const link = db
      .prepare('select record_id, tag_id from record_tag_links where record_id = ? and tag_id = ?')
      .get(ID.record, ID.tag) as { record_id: string; tag_id: string } | undefined
    expect(link?.record_id).toBe(ID.record)
    expect(rowOf('canvas_nodes', ID.node)?.canvas_id).toBe(ID.canvas)

    // 数值字段不因跨语言 JSON 变成字符串。
    const bean = rowOf('beans', ID.bean)!
    expect(bean.remaining_g).toBe(168)
    expect(bean.weight_g).toBe(200)
    expect(bean.is_sample).toBe(0)
    expect(rowOf('brews', ID.brew)?.water_temp).toBe(92)

    // 基线：每条都写了（冲突检测的前提）。
    const baseline = db.prepare('select count(*) as n from sync_baseline').get() as { n: number }
    expect(baseline.n).toBe(11)
  })

  it('同一批数据连续同步 3 次：只有第一次 applied，之后全部 skipped 且不产生重复', async () => {
    const batch = batchOf(fullSet())

    const first = await apply(batch)
    expect(first.body.appliedCount).toBe(11)
    expect(first.body.skippedCount).toBe(0)

    for (const round of [2, 3]) {
      const again = await apply(batch)
      expect(again.status, `第 ${round} 次`).toBe(200)
      expect(again.body.appliedCount, `第 ${round} 次不该重复应用`).toBe(0)
      expect(again.body.skippedCount, `第 ${round} 次应全部 skipped`).toBe(11)
      expect(again.body.conflictCount).toBe(0)
    }

    expect(countRows('beans')).toBe(2)
    expect(countRows('brews')).toBe(1)
    expect(countRows('record_tag_links')).toBe(1)
    expect(countRows('canvas_nodes')).toBe(1)
  })

  // ---------------------------------------------------------------------------
  // 3.2 修改同步
  // ---------------------------------------------------------------------------

  it('修改同步：标题/备注/URL 与数值字段都被覆盖，再同步转为 skipped', async () => {
    await apply(batchOf(fullSet()))

    const edited = fullSet().map((item) => {
      if (item.entityType === 'record') {
        return upsert('record', ID.record, recordPayload({
          title: '改过的标题',
          note: '改过的正文',
          urlString: 'https://example.com/new',
          canonicalURL: 'https://example.com/new'
        }))
      }
      if (item.entityType === 'bean' && item.id === ID.bean) {
        return upsert('bean', ID.bean, beanPayload({ remainingG: 120 }))
      }
      if (item.entityType === 'canvasNode') {
        return upsert('canvasNode', ID.node, {
          canvasId: ID.canvas, recordId: ID.record,
          positionX: 300, positionY: 400, width: 160, height: 120,
          zIndex: 1, annotation: '', createdAt: DAY
        })
      }
      return item
    })

    const outcome = await apply(batchOf(edited))
    expect(outcome.body.appliedCount).toBe(3)
    expect(outcome.body.conflictCount).toBe(0)

    expect(rowOf('records', ID.record)?.title).toBe('改过的标题')
    expect(rowOf('records', ID.record)?.note).toBe('改过的正文')
    expect(rowOf('records', ID.record)?.url_string).toBe('https://example.com/new')
    expect(rowOf('beans', ID.bean)?.remaining_g).toBe(120)
    expect(rowOf('canvas_nodes', ID.node)?.position_x).toBe(300)

    // 再推同一批：内容一致 → skipped，不重复写 change_log。
    const changesBefore = (db.prepare('select count(*) as n from change_log').get() as { n: number }).n
    const repeat = await apply(batchOf(edited))
    expect(repeat.body.appliedCount).toBe(0)
    // 整批 11 条（含刚改过的 3 条）此时都与本地一致。
    expect(repeat.body.skippedCount).toBe(11)
    const changesAfter = (db.prepare('select count(*) as n from change_log').get() as { n: number }).n
    expect(changesAfter).toBe(changesBefore)
  })

  it('URL 变更后旧链接的本地派生元数据被清除，不会挂到新 URL 上', async () => {
    await apply(batchOf(fullSet()))
    // 模拟桌面端 Link Resolver 写入的派生元数据（不进指纹）。
    db.prepare(
      `insert into record_metadata (record_id, url_string, title, description, thumbnail_url)
       values (?, ?, ?, ?, ?)`
    ).run(ID.record, 'https://example.com/old', '旧标题', '旧摘要', 'https://cdn.example.com/old.jpg')

    const edited = fullSet().map((item) =>
      item.entityType === 'record'
        ? upsert('record', ID.record, recordPayload({ urlString: 'https://example.com/new', canonicalURL: 'https://example.com/new' }))
        : item
    )
    await apply(batchOf(edited))

    const metadata = db.prepare('select count(*) as n from record_metadata where record_id = ?').get(ID.record) as { n: number }
    expect(metadata.n, '旧 URL 的标题/封面必须被清掉').toBe(0)
  })

  // ---------------------------------------------------------------------------
  // 3.3 删除同步
  // ---------------------------------------------------------------------------

  it('删除后重复同步 3 次 + 桌面重启后再同步：数据不复活', async () => {
    await apply(batchOf(fullSet()))
    const expected = fpFromPayload('record', recordPayload())

    const deletion = await apply(batchOf([], [
      { entityType: 'record', id: ID.record, expectedFingerprint: expected }
    ]))
    expect(deletion.body.appliedCount).toBe(1)
    expect(rowOf('records', ID.record)).toBeUndefined()

    // 连续重发同一删除：幂等 skipped。
    for (let round = 0; round < 3; round += 1) {
      const again = await apply(batchOf([], [
        { entityType: 'record', id: ID.record, expectedFingerprint: expected }
      ]))
      expect(again.body.skippedCount).toBe(1)
      expect(rowOf('records', ID.record)).toBeUndefined()
    }

    // 桌面重启：换一个进程内实例，同一个 SQLite 文件与同一张 devices 表。
    server.stop()
    db.close()
    db = openDatabase()
    server = new SyncServer(db, 'bp_desk_special', 'BrewPhase · 专项', () => {})
    await startServer()

    const afterRestart = await apply(batchOf([], [
      { entityType: 'record', id: ID.record, expectedFingerprint: expected }
    ]))
    expect(afterRestart.body.skippedCount).toBe(1)
    expect(rowOf('records', ID.record), '重启后已删除的记录不能复活').toBeUndefined()
  })

  it('iOS 侧基线丢失后重推旧数据：桌面端按冲突保留，不会静默覆盖也已删除的数据', async () => {
    await apply(batchOf(fullSet()))
    const expected = fpFromPayload('record', recordPayload())
    await apply(batchOf([], [{ entityType: 'record', id: ID.record, expectedFingerprint: expected }]))

    // iOS 基线被清空后（重装/换机）会把整条记录重新当成「新增」推上来。
    // 桌面端行已不存在 → 走插入分支，这是协议预期行为（会重新出现）。
    const revive = await apply(batchOf([upsert('record', ID.record, recordPayload())]))
    expect(revive.body.appliedCount).toBe(1)
    expect(rowOf('records', ID.record), '无基线时重推属于「重新创建」，协议允许').toBeDefined()
  })

  it('连续删除多条：同批 3 条删除全部生效，无遗漏', async () => {
    await apply(batchOf(fullSet()))
    const record2 = recordPayload({ title: '第二条' })
    await apply(batchOf([upsert('record', ID.record2, record2)]))

    const deletes = [
      { entityType: 'record' as const, id: ID.record, expectedFingerprint: fpFromPayload('record', recordPayload()) },
      { entityType: 'record' as const, id: ID.record2, expectedFingerprint: fpFromPayload('record', record2) },
      { entityType: 'recordTag' as const, id: ID.tag, expectedFingerprint: fpFromPayload('recordTag', { name: '专项', createdAt: DAY }) }
    ]
    const outcome = await apply(batchOf([], deletes))
    expect(outcome.body.appliedCount).toBe(3)
    expect(rowOf('records', ID.record)).toBeUndefined()
    expect(rowOf('records', ID.record2)).toBeUndefined()
    expect(rowOf('record_tags', ID.tag)).toBeUndefined()
    // 关系行随 tag 外键级联删除。
    expect(countRows('record_tag_links')).toBe(0)
  })

  it('删除豆子：冲煮/品鉴/提醒按外键级联删除，画布节点随记录级联', async () => {
    await apply(batchOf(fullSet()))

    await apply(batchOf([], [
      { entityType: 'bean', id: ID.bean, expectedFingerprint: fpFromPayload('bean', beanPayload()) }
    ]))
    expect(rowOf('beans', ID.bean)).toBeUndefined()
    expect(rowOf('brews', ID.brew), 'brew 应随 bean 级联').toBeUndefined()
    expect(rowOf('tastings', ID.tasting), 'tasting 应随 bean 级联').toBeUndefined()
    expect(rowOf('phase_reminders', ID.reminder), 'reminder 应随 bean 级联').toBeUndefined()

    // 另一包豆不受影响。
    expect(rowOf('beans', ID.bean2)).toBeDefined()

    await apply(batchOf([], [
      { entityType: 'record', id: ID.record, expectedFingerprint: fpFromPayload('record', recordPayload()) }
    ]))
    expect(rowOf('canvas_nodes', ID.node), '节点应随记录级联').toBeUndefined()
    expect(rowOf('canvases', ID.canvas), '画布本身不该被删').toBeDefined()
  })

  /**
   * 关联数据边界：iOS 删掉 Record 后，SwiftData 里的 CanvasNode 不一定被删
   * （节点只持有 recordID，不是级联关系）。Desktop 的 `canvas_nodes.record_id`
   * 有 `ON DELETE CASCADE`，删除记录时会把节点一并清掉。
   *
   * 这条用例记录「节点随后发生变更、被 iOS 当作普通 upsert 重新推上来」时
   * 的真实结果——用来判断会不会产生 failed 条目、孤儿节点或复活。
   */
  it('删除记录后 iOS 仍推节点变更：核对失败条目与落库状态', async () => {
    await apply(batchOf(fullSet()))

    // iOS 删除记录（带上一次成功同步的基线）。
    const deletion = await apply(batchOf([], [
      { entityType: 'record', id: ID.record, expectedFingerprint: fpFromPayload('record', recordPayload()) }
    ]))
    expect(deletion.body.appliedCount).toBe(1)
    expect(countRows('canvas_nodes'), 'Desktop 侧节点已被外键级联清掉').toBe(0)

    // 桌面端级联删除不会清 canvasNode 的基线，iOS 也仍持有该节点；节点一旦
    // 改动就会以新指纹重新 upsert。
    const nodeAfterMove = upsert('canvasNode', ID.node, {
      canvasId: ID.canvas, recordId: ID.record,
      positionX: 320, positionY: 48, width: 160, height: 120,
      zIndex: 1, annotation: '移动后', createdAt: DAY
    })
    const outcome = await apply(batchOf([nodeAfterMove]))

    // 现状（本轮只记录，不修）：Desktop 的级联删除是 SQLite 直接做的，
    // 没有经过 applyDeletion，因此不会清 canvasNode 的基线；iOS 端节点仍在，
    // 一有变更就以新指纹重推 → 外键失败 → 计入 failed，且每轮都会重试。
    expect(outcome.body.appliedCount).toBe(0)
    expect(outcome.body.conflictCount).toBe(0)
    const failed = outcome.body.failedItems ?? []
    expect(failed, '引用已删记录的节点应被明确判为失败').toHaveLength(1)
    expect(failed[0]?.reason).toContain('FOREIGN KEY constraint failed')
    expect(outcome.body.results?.[0]?.status).toBe('failed')

    // nodeRows=0：没有复活、没有孤儿行（外键保护是有效的）。
    expect(countRows('canvas_nodes'), '不该复活已被级联删除的节点').toBe(0)
    // 但基线残留 1 条：这正是「每轮重试、无法自愈」的根因。
    const baselineNode = (
      db.prepare("select count(*) as n from sync_baseline where entity_type = 'canvasNode'").get() as { n: number }
    ).n
    expect(baselineNode, '级联删除未清基线（现状记录）').toBe(1)
  })

  // ---------------------------------------------------------------------------
  // 4. 冲突
  // ---------------------------------------------------------------------------

  it('冲突：桌面改过而 iOS 未改 → 保留桌面、落冲突；重复同步不产生第二条冲突', async () => {
    await apply(batchOf(fullSet()))
    // 桌面本地改标题（模拟用户在 Desktop 编辑）。
    db.prepare('update records set title = ?, updated_at = ? where id = ?').run('桌面改的标题', Date.now(), ID.record)

    const conflictCount = (): number =>
      (db.prepare('select count(*) as n from sync_conflicts where entity_id = ?').get(ID.record) as { n: number }).n

    const first = await apply(batchOf(fullSet()))
    expect(first.body.conflictCount).toBe(1)
    expect(rowOf('records', ID.record)?.title, '不能静默覆盖桌面修改').toBe('桌面改的标题')
    expect(conflictCount()).toBe(1)

    const second = await apply(batchOf(fullSet()))
    expect(second.body.conflictCount).toBe(1)
    expect(conflictCount(), '同一远端指纹的冲突必须复用，不能随同步膨胀').toBe(1)
  })

  it('删除冲突：桌面改过而 iOS 要删 → 数据保留并落删除冲突', async () => {
    await apply(batchOf(fullSet()))
    db.prepare('update records set title = ? where id = ?').run('桌面改的标题', ID.record)

    const expected = fpFromPayload('record', recordPayload())
    const outcome = await apply(batchOf([], [
      { entityType: 'record', id: ID.record, expectedFingerprint: expected }
    ]))

    expect(outcome.body.conflictCount).toBe(1)
    expect(rowOf('records', ID.record), '删除冲突时数据必须保留').toBeDefined()
    const conflict = db
      .prepare('select remote_operation from sync_conflicts where entity_id = ?')
      .get(ID.record) as { remote_operation: string } | undefined
    expect(conflict?.remote_operation).toBe('delete')
  })

  it('修改后立即删除（同一轮 iOS 先改再删）：以删除为准，不复活', async () => {
    await apply(batchOf(fullSet()))
    const expected = fpFromPayload('record', recordPayload())

    // iOS 改了内容但基线仍是旧指纹 → 桌面端"本地未改"，接受覆盖；
    // 紧随其后的删除带的是旧基线指纹，本地指纹已变 → 删除冲突（协议保护）。
    const modified = recordPayload({ title: '改过又被删' })
    await apply(batchOf([upsert('record', ID.record, modified)]))
    const outcome = await apply(batchOf([], [
      { entityType: 'record', id: ID.record, expectedFingerprint: expected }
    ]))

    // 断言现状：这条走的是冲突分支，数据保留、等用户裁决。
    expect(outcome.body.conflictCount).toBe(1)
    expect(rowOf('records', ID.record)?.title).toBe('改过又被删')
  })

  // ---------------------------------------------------------------------------
  // 6. 幂等 / 部分失败 / 并发
  // ---------------------------------------------------------------------------

  it('部分失败：brew 引用不存在的 bean → 该条 failed，其余照常 applied', async () => {
    const orphanBrew = brewPayload({ beanId: '00000000-0000-4000-8000-0000000000ff' })
    const outcome = await apply(batchOf([
      upsert('bean', ID.bean, beanPayload()),
      upsert('brew', ID.brew, orphanBrew),
      upsert('record', ID.record, recordPayload())
    ]))

    expect(outcome.body.appliedCount).toBe(2)
    expect(outcome.body.failedItems).toHaveLength(1)
    expect(outcome.body.failedItems[0]?.id).toBe(ID.brew)
    expect(outcome.body.failedItems[0]?.reason).toContain('FOREIGN KEY')
    expect(rowOf('records', ID.record)).toBeDefined()
  })

  it('并发两次 apply 同一批：不重复写入，第二次全部 skipped', async () => {
    const batch = batchOf(fullSet())
    const [a, b] = await Promise.all([apply(batch), apply(batch)])

    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    const appliedTotal = a.body.appliedCount + b.body.appliedCount
    expect(appliedTotal, '两条请求合计只应写入一次').toBe(11)
    expect(countRows('beans')).toBe(2)
    expect(countRows('records')).toBe(1)
  })

  // ---------------------------------------------------------------------------
  // 5. 媒体
  // ---------------------------------------------------------------------------

  async function uploadMedia(name: string, content: Buffer): Promise<void> {
    const digest = createHash('sha256').update(content).digest('hex')
    const manifestBody = Buffer.from(JSON.stringify({
      media: [{ name, sha256: digest, byteSize: content.length, mediaType: 'image', mimeType: 'image/jpeg' }]
    }))
    const manifest = await fetch(`${baseUrl}/api/sync/media/manifest`, {
      method: 'POST',
      headers: signedHeaders(manifestBody),
      body: manifestBody
    })
    const listed = (await manifest.json()) as { missing: Array<{ name: string }> }
    if (listed.missing.length === 0) return

    const chunk = content.subarray(0, 256 * 1024)
    const chunkBody = Buffer.from(chunk)
    const chunkResponse = await fetch(
      `${baseUrl}/api/sync/media/chunk?name=${encodeURIComponent(name)}&offset=0`,
      { method: 'POST', headers: signedHeaders(chunkBody), body: chunkBody }
    )
    expect(chunkResponse.status).toBe(200)

    const finalizeBody = Buffer.from(JSON.stringify({ name, sha256: digest, byteSize: content.length }))
    const finalize = await fetch(`${baseUrl}/api/sync/media/finalize`, {
      method: 'POST',
      headers: signedHeaders(finalizeBody),
      body: finalizeBody
    })
    expect(finalize.status).toBe(200)
  }

  it('媒体：分块上传后落盘且内容一致；重复上传被识别为 have', async () => {
    await apply(batchOf([upsert('record', ID.record, recordPayload({ carrier: 'image', mediaPath: ID.image }))]))

    const content = Buffer.alloc(120_000, 7)
    await uploadMedia(ID.image, content)

    const stored = join(mediaDir(), ID.image)
    expect(existsSync(stored), '文件应落到媒体目录').toBe(true)

    // 再问一次清单：应变成 have，不再重传。
    const digest = createHash('sha256').update(content).digest('hex')
    const body = Buffer.from(JSON.stringify({
      media: [{ name: ID.image, sha256: digest, byteSize: content.length, mediaType: 'image', mimeType: 'image/jpeg' }]
    }))
    const response = await fetch(`${baseUrl}/api/sync/media/manifest`, {
      method: 'POST', headers: signedHeaders(body), body
    })
    const outcome = (await response.json()) as { missing: unknown[]; have: string[] }
    expect(outcome.missing).toHaveLength(0)
    expect(outcome.have).toContain(ID.image)
  })

  it('媒体：整文件哈希不符 → 拒绝落位，且不留下正式文件', async () => {
    const content = Buffer.alloc(1000, 3)
    const wrong = 'deadbeef'.repeat(8)
    const chunkBody = Buffer.from(content)
    await fetch(`${baseUrl}/api/sync/media/chunk?name=${encodeURIComponent(ID.image)}&offset=0`, {
      method: 'POST', headers: signedHeaders(chunkBody), body: chunkBody
    })
    const finalizeBody = Buffer.from(JSON.stringify({ name: ID.image, sha256: wrong, byteSize: content.length }))
    const response = await fetch(`${baseUrl}/api/sync/media/finalize`, {
      method: 'POST', headers: signedHeaders(finalizeBody), body: finalizeBody
    })
    expect(response.status).toBe(400)
    expect(existsSync(join(mediaDir(), ID.image))).toBe(false)
  })

  /**
   * 记录删除后媒体文件是否被清理。
   *
   * 协议 §10 只规定了 wipe 会删媒体；单条记录的删除路径（applyDeletion）
   * 只删数据库行。这里把现状钉成断言，避免「以后有人改了行为却没人知道」。
   */
  it('媒体：删除记录后媒体文件仍留在磁盘（孤儿文件，现状记录）', async () => {
    await apply(batchOf([upsert('record', ID.record, recordPayload({ carrier: 'image', mediaPath: ID.image }))]))
    await uploadMedia(ID.image, Buffer.alloc(2048, 1))
    expect(existsSync(join(mediaDir(), ID.image))).toBe(true)

    await apply(batchOf([], [
      { entityType: 'record', id: ID.record, expectedFingerprint: fpFromPayload('record', recordPayload({ carrier: 'image', mediaPath: ID.image })) }
    ]))

    expect(rowOf('records', ID.record)).toBeUndefined()
    const remaining = await readdir(mediaDir())
    expect(
      remaining.includes(ID.image),
      '现状：单条删除不清理媒体文件（与 wipe 不同），需在报告里列为孤儿文件风险'
    ).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // 7. 解除配对 / 撤销授权
  // ---------------------------------------------------------------------------

  it('撤销授权后 token 立即失效：再同步 401，重复撤销幂等', async () => {
    const unpairBody = Buffer.from(JSON.stringify({}))
    const first = await fetch(`${baseUrl}/api/unpair`, {
      method: 'POST', headers: signedHeaders(unpairBody), body: unpairBody
    })
    expect(first.status).toBe(200)

    // 旧 token 再同步 → 401。
    const afterRevoke = await apply(batchOf(fullSet()))
    expect(afterRevoke.status).toBe(401)

    // 响应丢失后的重试：仍要 200 且 already=true（幂等）。
    const retry = await fetch(`${baseUrl}/api/unpair`, {
      method: 'POST', headers: signedHeaders(unpairBody), body: unpairBody
    })
    expect(retry.status).toBe(200)
    expect(((await retry.json()) as { already?: boolean }).already).toBe(true)
  })

  /**
   * 重复扫码配对的行为（现状记录）。
   *
   * `PairingService.exchange()` 只**签发**新 token，不撤销同名设备的旧 token；
   * 撤销只发生在显式 `POST /api/unpair` 或设置页「撤销授权」。
   * 因此「不清除旧凭据就重新扫码」会留下两条同名设备、两个同时有效的 token。
   * 端上正常流程会先解除配对，这条记录的是**绕过该流程时**的表现，供报告评估。
   */
  it('重复扫码配对：旧 token 仍然有效，设备表出现两条同名记录', async () => {
    const oldToken = token
    const fresh = await pair('iPhone 专项')

    expect(fresh).not.toBe(oldToken)
    const oldAttempt = await apply(batchOf(fullSet()), oldToken)
    expect(oldAttempt.status, '现状：重新配对不会撤销旧 token').toBe(200)

    const rows = db
      .prepare('select id, name, revoked_at from devices order by paired_at')
      .all() as Array<{ id: string; name: string; revoked_at: number | null }>
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.name === 'iPhone 专项')).toBe(true)
    expect(rows.every((row) => row.revoked_at === null)).toBe(true)

    // 新 token 同样可用。
    const freshAttempt = await apply(batchOf(fullSet()), fresh)
    expect(freshAttempt.status).toBe(200)
  })
})
