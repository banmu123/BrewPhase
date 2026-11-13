import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * 配置文件的备份与原子写入。
 *
 * 顺序永远是：备份 → 写临时文件 → rename 覆盖 → 回读校验。
 * 任何一步失败都要把原文件恢复回去，不能留下一个"写了一半"的配置——
 * Agent 读到半截 JSON 会直接崩，而用户并不知道是我们改坏的。
 */

/** `mcp.json.brewphase.bak.1731500000000`，与配置文件同目录。 */
export function backupPathFor(configPath: string, now: number = Date.now()): string {
  return `${configPath}.brewphase.bak.${now}`
}

/**
 * 复制一份备份；文件不存在时返回 null（首次创建不需要备份）。
 * 同一份原始文件在一次写入里只备份一次——调用方负责不要重复调用。
 */
export function createBackup(configPath: string, now: number = Date.now()): string | null {
  if (!existsSync(configPath)) return null
  const target = backupPathFor(configPath, now)
  copyFileSync(configPath, target)
  return target
}

/** 回滚：把备份写回原位。失败时抛出，由调用方转成"严重错误"。 */
export function restoreBackup(backupPath: string, configPath: string): void {
  copyFileSync(backupPath, configPath)
}

export type AtomicWriteResult = { verifiedContent: string }

/**
 * 原子写入并回读校验。
 *
 * - 先写同目录下的临时文件，再 rename 覆盖：rename 在同一文件系统内是原子的，
 *   Agent 不会读到写了一半的内容；
 * - POSIX 下把权限收到 0600：配置文件里有 Token，不该对其他本地用户可读；
 * - 写完立刻回读，内容不一致就抛错，让上层走回滚。
 */
export function atomicWrite(configPath: string, content: string): AtomicWriteResult {
  const dir = dirname(configPath)
  const temp = join(dir, `.brewphase-tmp-${randomBytes(6).toString('hex')}`)

  try {
    writeFileSync(temp, content, { encoding: 'utf-8', mode: 0o600 })
    renameSync(temp, configPath)
  } catch (error) {
    // 临时文件不能留在用户目录里
    try {
      rmSync(temp, { force: true })
    } catch {
      // 清理失败不掩盖原始错误
    }
    throw error
  }

  if (process.platform !== 'win32') {
    try {
      chmodSync(configPath, 0o600)
    } catch {
      // 权限收紧失败不算致命：文件已经写对了，只是可能过宽。
    }
  }

  const verifiedContent = readFileSync(configPath, 'utf-8')
  if (verifiedContent !== content) {
    throw new Error('config verification failed: written content differs from source')
  }
  return { verifiedContent }
}
