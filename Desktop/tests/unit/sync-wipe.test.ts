import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../src/main/database/migrations'
import { wipeSyncedData } from '../../src/main/sync/wipe'

/**
 * 清空同步实体的边界（撤销配对时用）。
 *
 * 这个函数会真删数据，所以测试的重点不是「删掉了」，而是**删对了范围**：
 * 记录 / 标签 / 画布 / 笔迹 / 媒体 / 同步状态必须走；
 * 豆子 / 冲煮 / 品鉴必须留——它们是这台 Mac 自己的数据，
 * 手机的配对关系没有任何理由动它们。
 */
describe('wipeSyncedData', () => {
  const MEDIA_NAME = 'wipetest-1111-4111-8111-000000000001.jpg'
  const NOW = 1_760_000_000_000

  let tempDir: string
  let db: Database.Database

  function count(table: string): number {
    return Number((db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n)
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'bp-wipe-'))
    // mediaDir() 优先读这个变量，避免在测试里碰 electron 的 app.getPath
    process.env.BREWPHASE_USER_DATA_DIR = tempDir
    mkdirSync(join(tempDir, 'media'), { recursive: true })

    db = new Database(join(tempDir, 'brewphase.db'))
    db.pragma('foreign_keys = ON')
    migrate(db)

    // 咖啡数据（必须留下）
    db.prepare('insert into beans (id, name, created_at, updated_at) values (?,?,?,?)')
      .run('bean-1', '耶加雪菲', NOW, NOW)
    db.prepare('insert into brews (id, bean_id, date, created_at) values (?,?,?,?)')
      .run('brew-1', 'bean-1', NOW, NOW)

    // 同步实体（必须清掉）
    db.prepare(
      `insert into records (id, carrier, title, note, url_string, provider, media_path,
        metadata_status, is_sample, created_at, updated_at)
       values (?, 'image', '手机拍的图', '', '', 'generic', ?, 'idle', 0, ?, ?)`
    ).run('record-1', MEDIA_NAME, NOW, NOW)
    db.prepare('insert into record_tags (id, name, created_at) values (?,?,?)').run('tag-1', '开发', NOW)
    db.prepare('insert into record_tag_links (record_id, tag_id) values (?,?)').run('record-1', 'tag-1')
    db.prepare('insert into canvases (id, name, created_at, updated_at) values (?,?,?,?)')
      .run('canvas-1', '画布', NOW, NOW)
    db.prepare(
      'insert into canvas_nodes (id, canvas_id, record_id, created_at, updated_at) values (?,?,?,?,?)'
    ).run('node-1', 'canvas-1', 'record-1', NOW, NOW)
    db.prepare(
      'insert into canvas_strokes (id, canvas_id, created_at, updated_at) values (?,?,?,?)'
    ).run('stroke-1', 'canvas-1', NOW, NOW)
    db.prepare(
      `insert into record_metadata (record_id, url_string, provider, status, fetched_at)
       values (?,?,?,?,?)`
    ).run('record-1', 'https://example.com', 'generic', 'ok', NOW)

    // 同步状态（必须清掉同步实体那部分，咖啡那部分留下）
    db.prepare(
      'insert into sync_baseline (entity_type, entity_id, fingerprint, synced_at) values (?,?,?,?)'
    ).run('record', 'record-1', 'fp-record', NOW)
    db.prepare(
      'insert into sync_baseline (entity_type, entity_id, fingerprint, synced_at) values (?,?,?,?)'
    ).run('bean', 'bean-1', 'fp-bean', NOW)
    db.prepare(
      `insert into sync_conflicts (id, entity_type, entity_id, local_fingerprint,
        remote_fingerprint, remote_payload, created_at) values (?,?,?,?,?,?,?)`
    ).run('conflict-1', 'record', 'record-1', 'a', 'b', '{}', NOW)
    db.prepare(
      'insert into change_log (entity_type, entity_id, operation, revision, device_id, created_at) values (?,?,?,?,?,?)'
    ).run('record', 'record-1', 'upsert', 1, 'dev', NOW)
    db.prepare(
      'insert into change_log (entity_type, entity_id, operation, revision, device_id, created_at) values (?,?,?,?,?,?)'
    ).run('bean', 'bean-1', 'upsert', 1, 'dev', NOW)

    // 媒体文件：主文件 + 缩略图
    writeFileSync(join(tempDir, 'media', MEDIA_NAME), Buffer.from([1, 2, 3]))
    writeFileSync(join(tempDir, 'media', 'wipetest-1111-4111-8111-000000000001_thumb.jpg'), Buffer.from([4]))
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
    delete process.env.BREWPHASE_USER_DATA_DIR
  })

  it('清掉同步实体，保留咖啡数据', async () => {
    const result = await wipeSyncedData(db)

    expect(result).toEqual({ records: 1, tags: 1, canvases: 1, mediaFiles: 2 })

    for (const table of [
      'records',
      'record_tags',
      'record_tag_links',
      'record_metadata',
      'canvases',
      'canvas_nodes',
      'canvas_strokes',
      'sync_conflicts'
    ]) {
      expect(count(table), `${table} 应该被清空`).toBe(0)
    }

    // 咖啡数据一条都不能少
    expect(count('beans')).toBe(1)
    expect(count('brews')).toBe(1)

    // 同步状态只清同步实体那部分
    const baselines = db.prepare('select entity_type from sync_baseline').all() as Array<{ entity_type: string }>
    expect(baselines.map((row) => row.entity_type)).toEqual(['bean'])
    const changes = db.prepare('select entity_type from change_log').all() as Array<{ entity_type: string }>
    expect(changes.map((row) => row.entity_type)).toEqual(['bean'])
  })

  it('媒体文件跟着走（主文件与缩略图）', async () => {
    await wipeSyncedData(db)
    expect(existsSync(join(tempDir, 'media', MEDIA_NAME))).toBe(false)
    expect(existsSync(join(tempDir, 'media', 'wipetest-1111-4111-8111-000000000001_thumb.jpg'))).toBe(false)
  })

  it('空库重复清空是幂等的', async () => {
    await wipeSyncedData(db)
    const second = await wipeSyncedData(db)
    expect(second).toEqual({ records: 0, tags: 0, canvases: 0, mediaFiles: 0 })
    expect(count('beans')).toBe(1)
  })
})
