import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearDataLocation,
  databaseExists,
  migrateDataDirectory,
  resolveDataLocation,
  validateDataTarget,
  writeDataLocation
} from '../../src/main/data-location'

/**
 * 数据目录：配置优先级、目标校验与迁移的边界。
 *
 * 迁移只复制不删除；目标必须为空；配置损坏时应用仍要能启动（回退默认）。
 */

describe('数据目录解析与校验', () => {
  let root = ''
  let userData = ''
  let appPath = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bp-data-location-'))
    userData = join(root, 'user-data')
    appPath = join(root, 'app')
    mkdirSync(userData)
    mkdirSync(appPath)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('没有配置时使用默认目录（userData）', () => {
    const status = resolveDataLocation(userData)
    expect(status.dataDir).toBe(userData)
    expect(status.defaultDir).toBe(userData)
    expect(status.isCustom).toBe(false)
    expect(status.lastError).toBeNull()
  })

  it('配置指向存在的目录时成为自定义目录', async () => {
    const custom = join(root, 'custom')
    mkdirSync(custom)
    await writeDataLocation(userData, custom)

    const status = resolveDataLocation(userData)
    expect(status.dataDir).toBe(custom)
    expect(status.isCustom).toBe(true)
    expect(status.lastError).toBeNull()
  })

  it('配置损坏或目录消失时回退默认并记录错误', async () => {
    writeFileSync(join(userData, 'data-location.json'), '{not json', 'utf8')
    const broken = resolveDataLocation(userData)
    expect(broken.dataDir).toBe(userData)
    expect(broken.isCustom).toBe(false)
    expect(broken.lastError).toBeTruthy()

    const missing = join(root, 'gone')
    writeFileSync(
      join(userData, 'data-location.json'),
      JSON.stringify({ version: 1, dataDir: missing }),
      'utf8'
    )
    const gone = resolveDataLocation(userData)
    expect(gone.dataDir).toBe(userData)
    expect(gone.lastError).toBeTruthy()
  })

  it('clearDataLocation 删除配置后回到默认', async () => {
    const custom = join(root, 'custom')
    mkdirSync(custom)
    await writeDataLocation(userData, custom)
    expect(resolveDataLocation(userData).isCustom).toBe(true)

    await clearDataLocation(userData)
    expect(resolveDataLocation(userData).dataDir).toBe(userData)
  })

  it('拒绝相对路径、当前目录、非空目录、应用目录与系统目录', () => {
    const current = join(root, 'current')
    mkdirSync(current)

    expect(validateDataTarget('relative/path', current, appPath).ok).toBe(false)
    expect(validateDataTarget(current, current, appPath).ok).toBe(false)

    const nonEmpty = join(root, 'full')
    mkdirSync(nonEmpty)
    writeFileSync(join(nonEmpty, 'notes.txt'), 'x')
    expect(validateDataTarget(nonEmpty, current, appPath).ok).toBe(false)

    expect(validateDataTarget(join(appPath, 'data'), current, appPath).ok).toBe(false)

    const system = process.platform === 'win32' ? 'C:\\Windows\\bp-data' : '/etc/bp-data'
    expect(validateDataTarget(system, current, appPath).ok).toBe(false)

    const empty = join(root, 'empty')
    mkdirSync(empty)
    expect(validateDataTarget(empty, current, appPath).ok).toBe(true)
  })
})

describe('数据迁移', () => {
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bp-data-migrate-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('复制 db / wal / media，且保留源目录', async () => {
    const from = join(root, 'from')
    mkdirSync(join(from, 'media'), { recursive: true })
    writeFileSync(join(from, 'brewphase.db'), 'database-bytes')
    writeFileSync(join(from, 'brewphase.db-wal'), 'wal-bytes')
    writeFileSync(join(from, 'media', 'photo.jpg'), 'image-bytes')

    const to = join(root, 'to')
    const result = await migrateDataDirectory(from, to)

    expect(result.ok).toBe(true)
    expect(databaseExists(to)).toBe(true)
    expect(existsSync(join(to, 'brewphase.db-wal'))).toBe(true)
    expect(existsSync(join(to, 'media', 'photo.jpg'))).toBe(true)
    // 只复制，不删源
    expect(existsSync(join(from, 'brewphase.db'))).toBe(true)
    expect(existsSync(join(from, 'media', 'photo.jpg'))).toBe(true)
  })

  it('源目录没有 brewphase.db 时失败，并清掉本次复制到目标的文件', async () => {
    const from = join(root, 'no-db')
    mkdirSync(join(from, 'media'), { recursive: true })
    writeFileSync(join(from, 'media', 'photo.jpg'), 'image-bytes')

    const target = join(root, 'target')
    mkdirSync(target)
    const result = await migrateDataDirectory(from, target)

    expect(result.ok).toBe(false)
    expect(databaseExists(target)).toBe(false)
    expect(existsSync(join(target, 'media'))).toBe(false)
  })

  it('目标不存在时自动创建', async () => {
    const from = join(root, 'from')
    mkdirSync(from)
    writeFileSync(join(from, 'brewphase.db'), 'db')

    const to = join(root, 'nested', 'data')
    const result = await migrateDataDirectory(from, to)

    expect(result.ok).toBe(true)
    expect(databaseExists(to)).toBe(true)
  })
})
