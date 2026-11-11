import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type DatabaseHandle } from '../../src/main/database/client'
import * as canvasRepo from '../../src/main/database/repositories/canvas'
import { SyncService } from '../../src/main/sync/sync-service'
import {
  applyBatch,
  canonical,
  fingerprint,
  localFingerprint,
  type ApplyResult,
  type SyncBatch,
  type SyncDeletion
} from '../../src/main/sync/snapshot-importer'
import { wipeSyncedData } from '../../src/main/sync/wipe'

/**
 * Canvas 单向同步边界（iOS → Desktop；Desktop 本地创作不回传 iOS）。
 *
 * 用真实 SQLite 文件（不是内存库）跑 `applyBatch` + 真实 repository：
 * 桌面端的拖动 / 改名 / 新建便签都走产品代码路径，才能证明「本地写入不推进
 * 基线、也不触发任何出站同步」。payload 的字段序与指纹算法严格照
 * `BrewPhase/Sync/SyncSnapshotBuilder.swift` 的 canvasBatches()/nodeBatches()，
 * 不是拿桌面端函数自己算出来的假数据。
 */
const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const IOS_DEVICE = 'ios-device-1'
const NOW = 1_760_000_000_000
const CANVAS_ID = '11111111-1111-4111-8111-111111111111'
const NODE_ID = '22222222-2222-4222-8222-222222222222'
const RECORD_ID = '33333333-3333-4333-8333-333333333333'
const CANVAS_NAME = 'iPhone 上的画布'
const CANVAS_NOTE = '在手机上建的'

type Row = Record<string, unknown>

type NodePayload = {
  canvasId: string
  recordId: string
  positionX: number
  positionY: number
  width: number
  height: number
  zIndex: number
  annotation: string
  createdAt: number
}

function nodePayload(overrides: Partial<NodePayload> = {}): NodePayload {
  return {
    canvasId: CANVAS_ID,
    recordId: RECORD_ID,
    positionX: 120,
    positionY: 80,
    width: 240,
    height: 180,
    zIndex: 1,
    annotation: '手机写的备注',
    createdAt: NOW,
    ...overrides
  }
}

/** 与 iOS `SyncFingerprint.canonical([canvasID, recordID, ...])` 同一字段序。 */
function nodeFingerprint(payload: NodePayload): string {
  return fingerprint(
    canonical([
      payload.canvasId,
      payload.recordId,
      payload.positionX,
      payload.positionY,
      payload.width,
      payload.height,
      payload.zIndex,
      payload.annotation
    ])
  )
}

function canvasFingerprint(): string {
  return fingerprint(canonical([CANVAS_NAME, CANVAS_NOTE, false]))
}

function iosBatch(node: NodePayload = nodePayload()): SyncBatch {
  return {
    operations: [
      {
        entityType: 'canvas',
        upserts: [
          {
            id: CANVAS_ID,
            fingerprint: canvasFingerprint(),
            payload: { name: CANVAS_NAME, note: CANVAS_NOTE, isSample: false, createdAt: NOW }
          }
        ],
        deletes: []
      },
      {
        entityType: 'canvasNode',
        upserts: [{ id: NODE_ID, fingerprint: nodeFingerprint(node), payload: { ...node } }],
        deletes: []
      }
    ]
  }
}

function deletionBatch(
  entityType: 'canvas' | 'canvasNode',
  id: string,
  expectedFingerprint?: string
): SyncBatch {
  const deletion: SyncDeletion = expectedFingerprint
    ? { id, expectedFingerprint }
    : { id }
  return { operations: [{ entityType, upserts: [], deletes: [deletion] }] }
}

let dir: string
let handle: DatabaseHandle

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bp-canvas-isolation-'))
  process.env.BREWPHASE_USER_DATA_DIR = dir
  handle = openDatabase(join(dir, 'brewphase.db'))
  // CanvasNode 通过外键引用 Records：模拟「iPhone 先同步记录，再同步画布节点」。
  handle.sqlite
    .prepare(
      `insert into records (id, carrier, title, note, url_string, provider, media_path,
        metadata_status, is_sample, created_at, updated_at)
       values (?, 'image', '手机拍的图', '', '', 'generic', '', 'idle', 0, ?, ?)`
    )
    .run(RECORD_ID, NOW, NOW)
})

afterEach(() => {
  handle.close()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.BREWPHASE_USER_DATA_DIR
})

function row(table: string, id: string): Row {
  return handle.sqlite.prepare(`select * from ${table} where id = ?`).get(id) as Row
}

function count(table: string): number {
  return Number(
    (handle.sqlite.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n
  )
}

function baseline(entityType: string, id: string): string | undefined {
  return (
    handle.sqlite
      .prepare('select fingerprint from sync_baseline where entity_type = ? and entity_id = ?')
      .get(entityType, id) as { fingerprint: string } | undefined
  )?.fingerprint
}

function conflictRows(): Row[] {
  return handle.sqlite.prepare('select * from sync_conflicts').all() as Row[]
}

function resultOf(result: ApplyResult, entityType: string): ApplyResult['results'][number] | undefined {
  return result.results.find((item) => item.entityType === entityType)
}

function importIos(node: NodePayload = nodePayload()): ApplyResult {
  return applyBatch(handle.sqlite, iosBatch(node), IOS_DEVICE)
}

describe('Canvas 同步隔离：iOS → Desktop 单向，Desktop 本地创作不回传', () => {
  it('A 首次导入：Canvas / CanvasNode 完整落库并建立基线，两端指纹一致', () => {
    const result = importIos()

    expect(result.appliedCount).toBe(2)
    expect(result.conflictCount).toBe(0)
    expect(result.failedItems).toHaveLength(0)
    expect(count('canvases')).toBe(1)
    expect(count('canvas_nodes')).toBe(1)

    const canvas = row('canvases', CANVAS_ID)
    expect(canvas.name).toBe(CANVAS_NAME)
    expect(canvas.note).toBe(CANVAS_NOTE)

    const node = row('canvas_nodes', NODE_ID)
    expect(node.canvas_id).toBe(CANVAS_ID)
    expect(node.record_id).toBe(RECORD_ID)
    expect(node.position_x).toBe(120)
    expect(node.position_y).toBe(80)
    expect(node.width).toBe(240)
    expect(node.height).toBe(180)
    expect(node.z_index).toBe(1)
    expect(node.annotation).toBe('手机写的备注')

    expect(baseline('canvas', CANVAS_ID)).toBe(canvasFingerprint())
    expect(baseline('canvasNode', NODE_ID)).toBe(nodeFingerprint(nodePayload()))
    // 关键：iOS 传来的指纹 === 桌面从本地行算出的指纹，基线才不会一开始就错位。
    expect(localFingerprint('canvas', canvas)).toBe(canvasFingerprint())
    expect(localFingerprint('canvasNode', node)).toBe(nodeFingerprint(nodePayload()))
  })

  it('B 桌面端拖动节点：本地数据变了，基线仍是 iOS 原指纹，没有出站同步', () => {
    importIos()
    const before = baseline('canvasNode', NODE_ID)
    const localFpBefore = localFingerprint('canvasNode', row('canvas_nodes', NODE_ID))

    // 真实桌面写入路径（Renderer 拖动松手时调用的 repository）。
    canvasRepo.moveNode(handle.db, handle.deviceId, NODE_ID, 999, 888)

    const node = row('canvas_nodes', NODE_ID)
    expect(node.position_x).toBe(999)
    expect(node.position_y).toBe(888)
    expect(localFingerprint('canvasNode', node)).not.toBe(localFpBefore)
    // 本地写入绝不能把基线推进到「旧的 iOS 指纹」或新的本地指纹。
    expect(baseline('canvasNode', NODE_ID)).toBe(before)
    expect(baseline('canvasNode', NODE_ID)).toBe(nodeFingerprint(nodePayload()))
    expect(baseline('canvasNode', NODE_ID)).not.toBe(localFingerprint('canvasNode', node))

    // 只落本地 change_log（标记本机设备），没有「发给 iPhone」的东西。
    const log = handle.sqlite
      .prepare(
        `select operation, device_id from change_log
         where entity_type = 'canvasNode' and entity_id = ? order by created_at desc limit 1`
      )
      .get(NODE_ID) as { operation: string; device_id: string } | undefined
    expect(log?.operation).toBe('update')
    expect(log?.device_id).toBe(handle.deviceId)
  })

  it('B（静态）主进程与 Canvas 写入路径不存在 Desktop → iOS 的同步调用', () => {
    const syncDir = join(DESKTOP_ROOT, 'src/main/sync')
    const outbound = [
      /\bfetch\s*\(/,
      /\baxios\b/,
      /https?\.request\s*\(/,
      /new\s+WebSocket\s*\(/,
      /net\.connect\s*\(/,
      /\bSyncManager\b/
    ]
    const files = readdirSync(syncDir).filter((file) => file.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const source = readFileSync(join(syncDir, file), 'utf8')
      for (const pattern of outbound) {
        expect(source, `${file} 不应含出站同步调用 ${pattern}`).not.toMatch(pattern)
      }
    }

    // 本地 Canvas 写入（Renderer / MCP）不得复用 iOS 同步入口。
    for (const relative of [
      'src/main/database/repositories/canvas.ts',
      'src/main/application/canvas/canvas-service.ts',
      'src/mcp/tools/canvas.ts',
      'src/main/mcp-bridge/request-router.ts'
    ]) {
      const source = readFileSync(join(DESKTOP_ROOT, relative), 'utf8')
      expect(source, relative).not.toMatch(/applyBatch\b|new SyncService\b|SyncServer\b/)
    }
  })

  it('C iOS 再次发送未修改的原始 payload：形成冲突，桌面位置保持不变', () => {
    importIos()
    canvasRepo.moveNode(handle.db, handle.deviceId, NODE_ID, 999, 888)

    const result = importIos()
    expect(result.conflictCount).toBe(1)
    expect(resultOf(result, 'canvasNode')?.status).toBe('conflict')
    expect(resultOf(result, 'canvasNode')?.reason).toBe('desktop has local changes')
    expect(row('canvas_nodes', NODE_ID).position_x).toBe(999)
    expect(row('canvas_nodes', NODE_ID).position_y).toBe(888)
    // 基线没有被冲突偷偷推进。
    expect(baseline('canvasNode', NODE_ID)).toBe(nodeFingerprint(nodePayload()))

    expect(conflictRows()).toHaveLength(1)
    expect(conflictRows()[0].entity_id).toBe(NODE_ID)
    expect(conflictRows()[0].remote_operation).toBe('upsert')
    expect(conflictRows()[0].remote_fingerprint).toBe(nodeFingerprint(nodePayload()))

    // 同一远端指纹重复推送：冲突去重复用，不随轮询膨胀。
    importIos()
    expect(conflictRows()).toHaveLength(1)
  })

  it('D 双方同时修改：产生冲突，只有显式「接受移动端版本」才覆盖桌面内容', () => {
    importIos()
    canvasRepo.setAnnotation(handle.db, handle.deviceId, NODE_ID, '桌面写的备注')

    const remote = nodePayload({ positionX: 777, annotation: '手机改的备注' })
    const result = importIos(remote)
    expect(result.conflictCount).toBe(1)
    expect(resultOf(result, 'canvasNode')?.reason).toBe('both sides changed')
    expect(row('canvas_nodes', NODE_ID).annotation).toBe('桌面写的备注')
    expect(row('canvas_nodes', NODE_ID).position_x).toBe(120)

    const conflicts = conflictRows()
    expect(conflicts).toHaveLength(1)
    expect(JSON.parse(String(conflicts[0].remote_payload)).annotation).toBe('手机改的备注')

    // 用户在设置页明确裁决之前，桌面内容不能被覆盖。
    const service = new SyncService(handle.sqlite, () => undefined)
    service.resolveConflict(String(conflicts[0].id), 'remote')

    expect(row('canvas_nodes', NODE_ID).annotation).toBe('手机改的备注')
    expect(row('canvas_nodes', NODE_ID).position_x).toBe(777)
    expect(baseline('canvasNode', NODE_ID)).toBe(nodeFingerprint(remote))
    expect(conflictRows()).toHaveLength(0)
  })

  it('D2 裁决「保留电脑版本」：基线不推进，同指纹重复推送收敛为 skipped', () => {
    importIos()
    canvasRepo.moveNode(handle.db, handle.deviceId, NODE_ID, 999, 888)
    importIos()

    const conflicts = conflictRows()
    expect(conflicts).toHaveLength(1)
    const service = new SyncService(handle.sqlite, () => undefined)
    service.resolveConflict(String(conflicts[0].id), 'local')

    expect(baseline('canvasNode', NODE_ID)).toBe(nodeFingerprint(nodePayload()))
    expect(row('canvas_nodes', NODE_ID).position_x).toBe(999)
    expect(count('sync_rejected')).toBe(1)

    const result = importIos()
    expect(result.conflictCount).toBe(0)
    expect(resultOf(result, 'canvasNode')?.status).toBe('skipped')
    expect(resultOf(result, 'canvasNode')?.reason).toBe('kept desktop version by resolution')
    expect(conflictRows()).toHaveLength(0)
  })

  it('E iOS 删除已被桌面修改的 CanvasNode：删除冲突，桌面数据保留', () => {
    importIos()
    canvasRepo.moveNode(handle.db, handle.deviceId, NODE_ID, 999, 888)
    const expected = nodeFingerprint(nodePayload())

    const result = applyBatch(
      handle.sqlite,
      deletionBatch('canvasNode', NODE_ID, expected),
      IOS_DEVICE
    )
    expect(result.conflictCount).toBe(1)
    expect(result.results[0].reason).toBe('desktop has local changes')
    expect(count('canvas_nodes')).toBe(1)
    expect(row('canvas_nodes', NODE_ID).position_x).toBe(999)
    expect(conflictRows()[0].remote_operation).toBe('delete')

    // 连基线都不给，同样不能绕过冲突直接删。
    const withoutBaseline = applyBatch(
      handle.sqlite,
      deletionBatch('canvasNode', NODE_ID),
      IOS_DEVICE
    )
    expect(withoutBaseline.results[0].status).toBe('conflict')
    expect(withoutBaseline.results[0].reason).toBe('delete without baseline fingerprint')
    expect(count('canvas_nodes')).toBe(1)
  })

  it('E2 iOS 删除已被桌面改名的 Canvas：同样受冲突保护', () => {
    importIos()
    canvasRepo.renameCanvas(handle.db, handle.deviceId, CANVAS_ID, 'Mac 改的名字')

    const result = applyBatch(
      handle.sqlite,
      deletionBatch('canvas', CANVAS_ID, canvasFingerprint()),
      IOS_DEVICE
    )
    expect(result.conflictCount).toBe(1)
    expect(count('canvases')).toBe(1)
    expect(row('canvases', CANVAS_ID).name).toBe('Mac 改的名字')
    // 级联删除没被触发：节点还在。
    expect(count('canvas_nodes')).toBe(1)
  })

  it('E3 对照：桌面没改过且基线正确时，iOS 删除仍然生效', () => {
    importIos()
    const result = applyBatch(
      handle.sqlite,
      deletionBatch('canvasNode', NODE_ID, nodeFingerprint(nodePayload())),
      IOS_DEVICE
    )
    expect(result.appliedCount).toBe(1)
    expect(result.conflictCount).toBe(0)
    expect(count('canvas_nodes')).toBe(0)
  })

  it('F 桌面独有画布 + 便签 + 笔迹不被下一次 iOS 同步抹掉', () => {
    const local = canvasRepo.createCanvas(handle.db, handle.deviceId, 'Mac 本地画布')
    canvasRepo.createNote(handle.db, handle.deviceId, {
      canvasId: local.id,
      positionX: 10,
      positionY: 20,
      title: '本地便签'
    })
    canvasRepo.saveStroke(handle.db, handle.deviceId, {
      id: '44444444-4444-4444-8444-444444444444',
      canvasID: local.id,
      toolType: 'pen',
      points: [1, 2, 3, 4],
      color: '#3b2b22',
      width: 2,
      opacity: 1,
      zIndex: 0,
      createdAt: NOW,
      updatedAt: NOW
    })

    const result = importIos()
    expect(result.appliedCount).toBe(2)
    expect(count('canvases')).toBe(2)
    expect(row('canvases', local.id).name).toBe('Mac 本地画布')
    expect(count('canvas_notes')).toBe(1)
    expect(count('canvas_strokes')).toBe(1)
    // 桌面独有实体没有基线：这是「desktop_local」的既有表达，不需要新字段。
    expect(baseline('canvas', local.id)).toBeUndefined()
  })

  it('F2 入站批次夹带 canvasNote / canvasStroke：一律拒绝，不写桌面库', () => {
    const local = canvasRepo.createCanvas(handle.db, handle.deviceId, 'Mac 本地画布')
    const strokeId = '55555555-5555-4555-8555-555555555555'
    canvasRepo.createNote(handle.db, handle.deviceId, {
      canvasId: local.id,
      positionX: 0,
      positionY: 0
    })
    canvasRepo.saveStroke(handle.db, handle.deviceId, {
      id: strokeId,
      canvasID: local.id,
      toolType: 'pen',
      points: [1, 2],
      color: '#3b2b22',
      width: 2,
      opacity: 1,
      zIndex: 0,
      createdAt: NOW,
      updatedAt: NOW
    })

    const fake: SyncBatch = {
      operations: [
        {
          entityType: 'canvasNote',
          upserts: [
            {
              id: '66666666-6666-4666-8666-666666666666',
              fingerprint: 'fake',
              payload: { canvasId: local.id, title: '手机塞进来的便签' }
            }
          ],
          deletes: []
        },
        { entityType: 'canvasStroke', upserts: [], deletes: [{ id: strokeId }] }
      ]
    }

    // failed 会打主进程排障日志，测试里静音，不影响断言。
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let result: ApplyResult
    try {
      result = applyBatch(handle.sqlite, fake, IOS_DEVICE)
    } finally {
      spy.mockRestore()
    }

    expect(result.failedItems).toHaveLength(2)
    expect(result.appliedCount).toBe(0)
    expect(count('canvas_notes')).toBe(1)
    expect(count('canvas_strokes')).toBe(1)
    expect(row('canvas_strokes', strokeId)).toBeTruthy()
    expect(
      handle.sqlite
        .prepare('select count(*) as n from canvas_notes where title = ?')
        .get('手机塞进来的便签')
    ).toEqual({ n: 0 })
  })

  it('G 只解除配对 / 关闭同步都保留本地 Canvas；显式清空才按既定范围删除', async () => {
    const local = canvasRepo.createCanvas(handle.db, handle.deviceId, 'Mac 本地画布')
    canvasRepo.createNote(handle.db, handle.deviceId, {
      canvasId: local.id,
      positionX: 5,
      positionY: 5
    })
    canvasRepo.saveStroke(handle.db, handle.deviceId, {
      id: '77777777-7777-4777-8777-777777777777',
      canvasID: local.id,
      toolType: 'pen',
      points: [1, 2],
      color: '#3b2b22',
      width: 2,
      opacity: 1,
      zIndex: 0,
      createdAt: NOW,
      updatedAt: NOW
    })
    importIos()
    expect(count('canvases')).toBe(2)

    const service = new SyncService(handle.sqlite, () => undefined)

    // 1) 只解除配对：不清理本地画布。
    service.revokeDevice('device-to-revoke')
    expect(count('canvases')).toBe(2)
    expect(row('canvases', local.id)).toBeTruthy()

    // 2) 普通关闭同步服务：同样不删任何画布内容。
    await service.disable()
    expect(count('canvases')).toBe(2)
    expect(count('canvas_notes')).toBe(1)
    expect(count('canvas_strokes')).toBe(1)

    // 3) 用户在确认弹窗里显式选「撤销并清空内容」：执行既有清空范围。
    const result = await wipeSyncedData(handle.sqlite)
    expect(result.canvases).toBe(2)
    expect(count('canvases')).toBe(0)
    expect(count('canvas_nodes')).toBe(0)
    expect(count('canvas_notes')).toBe(0)
    expect(count('canvas_strokes')).toBe(0)
    expect(count('sync_baseline')).toBe(0)
    expect(count('change_log')).toBe(0)
  })

  it('G2 清空不依赖外键级联：foreign_keys 关闭时便签与笔迹仍被清掉', async () => {
    const local = canvasRepo.createCanvas(handle.db, handle.deviceId, 'Mac 本地画布')
    canvasRepo.createNote(handle.db, handle.deviceId, {
      canvasId: local.id,
      positionX: 0,
      positionY: 0
    })
    canvasRepo.saveStroke(handle.db, handle.deviceId, {
      id: '88888888-8888-4888-8888-888888888888',
      canvasID: local.id,
      toolType: 'pen',
      points: [1, 2],
      color: '#3b2b22',
      width: 2,
      opacity: 1,
      zIndex: 0,
      createdAt: NOW,
      updatedAt: NOW
    })
    importIos()

    // 正常启动一定会开外键；这里刻意关掉，验证 wipe.ts 的显式删除清单是完整的，
    // 而不是只靠 cascade 侥幸清干净。
    handle.sqlite.pragma('foreign_keys = OFF')
    await wipeSyncedData(handle.sqlite)

    expect(count('canvases')).toBe(0)
    expect(count('canvas_nodes')).toBe(0)
    expect(count('canvas_notes')).toBe(0)
    expect(count('canvas_strokes')).toBe(0)
    expect(count('change_log')).toBe(0)
  })
})
