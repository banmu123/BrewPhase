import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { cp, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { z } from 'zod'

/**
 * 业务数据目录（数据库 + 媒体）的位置管理。
 *
 * 与 Electron 的 `userData` 分开：
 * - `userData` 继续放缓存、Local Storage、MCP/Chrome 的本地端点与配置；
 * - 这里只决定 `brewphase.db` 与 `media/` 放在哪。
 *
 * 这样切换位置不会把 Chromium 缓存一起搬走，也不会丢掉语言等界面偏好。
 * 配置文件 `data-location.json` 固定留在默认 userData 里——它必须能在
 * 读取「用户选的数据目录」之前被找到。
 */

export const DATA_LOCATION_CONFIG = 'data-location.json'
export const DATA_LOCATION_VERSION = 1

const dataLocationFileSchema = z.object({
  version: z.literal(DATA_LOCATION_VERSION),
  dataDir: z.string().min(1)
})

export type DataLocationStatus = {
  /** 当前实际使用的数据目录。 */
  dataDir: string
  /** 不配置时使用的默认目录（打包版是 userData）。 */
  defaultDir: string
  isCustom: boolean
  configPath: string
  lastError: string | null
}

/** 媒体目录也跟随业务数据目录；`BREWPHASE_USER_DATA_DIR` 仍可整体覆盖（测试/便携）。 */
let activeDataDirValue: string | null = null

export function setActiveDataDir(dir: string): void {
  activeDataDirValue = dir
}

export function activeDataDir(): string {
  const override = process.env.BREWPHASE_USER_DATA_DIR
  if (override) return override
  // 启动时一定会先 set；这里只是测试/异常路径的兜底，避免返回 undefined。
  return activeDataDirValue ?? process.cwd()
}

export function dataLocationConfigPath(userDataDir: string): string {
  return join(userDataDir, DATA_LOCATION_CONFIG)
}

/**
 * 启动时解析数据目录。
 *
 * 配置损坏 / 目录被删 / 不是目录：回退默认并记一条错误，绝不让应用起不来。
 * 迁移目标允许暂时为空，所以这里不要求目录里已经有 `brewphase.db`。
 */
export function resolveDataLocation(userDataDir: string): DataLocationStatus {
  const defaultDir = userDataDir
  const configPath = dataLocationConfigPath(userDataDir)

  if (!existsSync(configPath)) {
    return { dataDir: defaultDir, defaultDir, isCustom: false, configPath, lastError: null }
  }

  try {
    const parsed = dataLocationFileSchema.safeParse(JSON.parse(readFileSync(configPath, 'utf8')))
    if (!parsed.success) {
      return {
        dataDir: defaultDir,
        defaultDir,
        isCustom: false,
        configPath,
        lastError: 'data-location.json is invalid'
      }
    }
    const target = parsed.data.dataDir
    if (!isAbsolute(target) || !existsSync(target) || !statSync(target).isDirectory()) {
      return {
        dataDir: defaultDir,
        defaultDir,
        isCustom: false,
        configPath,
        lastError: 'configured data directory is missing'
      }
    }
    return {
      dataDir: resolve(target),
      defaultDir,
      isCustom: resolve(target) !== resolve(defaultDir),
      configPath,
      lastError: null
    }
  } catch (error) {
    return {
      dataDir: defaultDir,
      defaultDir,
      isCustom: false,
      configPath,
      lastError: error instanceof Error ? error.message : 'could not read data location'
    }
  }
}

export async function writeDataLocation(userDataDir: string, dataDir: string): Promise<void> {
  const configPath = dataLocationConfigPath(userDataDir)
  const body = `${JSON.stringify({ version: DATA_LOCATION_VERSION, dataDir: resolve(dataDir) }, null, 2)}\n`
  const tmp = `${configPath}.tmp-${process.pid}`
  await writeFile(tmp, body, { mode: 0o600 })
  await rename(tmp, configPath)
}

export async function clearDataLocation(userDataDir: string): Promise<void> {
  await rm(dataLocationConfigPath(userDataDir), { force: true })
}

// MARK: - 目标目录校验

const SYSTEM_PREFIXES =
  process.platform === 'win32'
    ? [
        'C:\\Windows',
        'C:\\Program Files',
        'C:\\Program Files (x86)',
        'C:\\ProgramData',
        'C:\\$Recycle.Bin'
      ]
    : ['/System', '/usr', '/etc', '/bin', '/sbin', '/var', '/private', '/dev', '/proc']

export type DataTargetCheck = { ok: true } | { ok: false; reason: string }

/**
 * 目标目录必须是：绝对路径、不等于当前目录、不在应用安装目录 / 系统目录内，
 * 且不存在或为空——迁移永远不覆盖已有数据。
 */
export function validateDataTarget(target: string, currentDir: string, appPath: string): DataTargetCheck {
  if (!isAbsolute(target)) return { ok: false, reason: 'please choose an absolute folder path' }

  const resolved = resolve(target)
  if (resolved === resolve(currentDir)) {
    return { ok: false, reason: 'this is already the current data folder' }
  }

  const normalized = resolved.endsWith(sep) ? resolved : `${resolved}${sep}`
  const appRoot = resolve(appPath).endsWith(sep) ? resolve(appPath) : `${resolve(appPath)}${sep}`
  if (normalized.startsWith(appRoot)) {
    return { ok: false, reason: 'the app folder cannot hold user data' }
  }

  const system = SYSTEM_PREFIXES.find((prefix) => {
    const withSep = prefix.endsWith(sep) ? prefix : `${prefix}${sep}`
    return normalized.toLowerCase().startsWith(withSep.toLowerCase())
  })
  if (system) return { ok: false, reason: 'system folders cannot hold user data' }

  if (existsSync(resolved)) {
    try {
      if (!statSync(resolved).isDirectory()) return { ok: false, reason: 'please choose a folder, not a file' }
      if (readdirSync(resolved).length > 0) {
        return { ok: false, reason: 'please choose an empty folder' }
      }
    } catch {
      return { ok: false, reason: 'cannot read the selected folder' }
    }
  }

  return { ok: true }
}

// MARK: - 迁移

export type DataMigrationResult =
  | { ok: true; dataDir: string; copiedFiles: number }
  | { ok: false; reason: string }

/**
 * 复制数据库与媒体到新目录。
 *
 * 只**复制**、不删除源数据：迁移出问题时用户还能回到原目录。
 * 调用方负责在复制前关闭数据库，保证 `brewphase.db` 是一致的快照。
 */
export async function migrateDataDirectory(from: string, to: string): Promise<DataMigrationResult> {
  const target = resolve(to)
  const createdTarget = !existsSync(target)

  try {
    await mkdir(target, { recursive: true })

    const databaseFiles = ['brewphase.db', 'brewphase.db-wal', 'brewphase.db-shm']
    let copiedFiles = 0
    let hasDatabase = false
    for (const name of databaseFiles) {
      const source = join(from, name)
      if (!existsSync(source)) continue
      await cp(source, join(target, name))
      copiedFiles += 1
      if (name === 'brewphase.db') hasDatabase = true
    }

    if (!hasDatabase) {
      throw new Error('no brewphase.db found in the current data folder')
    }

    const mediaSource = join(from, 'media')
    if (existsSync(mediaSource)) {
      const info = await stat(mediaSource)
      if (info.isDirectory()) {
        await cp(mediaSource, join(target, 'media'), { recursive: true })
        copiedFiles += 1
      }
    }

    return { ok: true, dataDir: target, copiedFiles }
  } catch (error) {
    // 只清理由本次迁移创建的目标目录；用户自己的空目录保留。
    await rm(join(target, 'media'), { recursive: true, force: true }).catch(() => undefined)
    for (const name of ['brewphase.db', 'brewphase.db-wal', 'brewphase.db-shm']) {
      await rm(join(target, name), { force: true }).catch(() => undefined)
    }
    if (createdTarget) await rm(target, { recursive: true, force: true }).catch(() => undefined)
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'could not copy the data folder'
    }
  }
}

/** 供测试与状态展示：数据库文件是否存在。 */
export function databaseExists(dir: string): boolean {
  return existsSync(join(dir, 'brewphase.db'))
}
