import { app } from 'electron'
import { appendFileSync, mkdirSync, statSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 主进程文件日志（tee）：console 输出原样保留，同时追加到
 * `<userData>/logs/main.log`。
 *
 * 用途：**为「应用打不开 / 界面卡死」这类无法现场复现的问题留证据**——
 * bootstrap 各阶段的打点都会落盘，用户回报时看日志最后停在哪一段即可定位。
 *
 * 简单 rotate：超过 5MB 改名为 main.old.log（只保留一代），避免无限增长。
 * 同步 appendFileSync：日志量小（每行 <200B），阻塞可忽略；不做异步队列——
 * 恰恰需要「崩溃前最后一行一定写进去了」。
 */

const MAX_LOG_BYTES = 5 * 1024 * 1024

let logFile: string | null = null

function timestamp(): string {
  return new Date().toISOString()
}

function rotateIfNeeded(): void {
  if (!logFile) return
  try {
    if (existsSync(logFile) && statSync(logFile).size > MAX_LOG_BYTES) {
      renameSync(logFile, logFile.replace(/main\.log$/, 'main.old.log'))
    }
  } catch {
    // rotate 失败不影响主流程
  }
}

export function startFileLogging(): void {
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    logFile = join(dir, 'main.log')
    rotateIfNeeded()
    write(`--- app start (${app.getVersion()}, ${process.platform}) ---`)
  } catch (error) {
    console.error('[logging] start failed', error)
    logFile = null
  }
}

/** 追加一行到日志文件（带时间戳）；失败静默——日志不能反过来影响应用。 */
export function write(line: string): void {
  if (!logFile) return
  try {
    appendFileSync(logFile, `[${timestamp()}] ${line}\n`, 'utf8')
  } catch {
    // 磁盘满 / 权限问题：放弃写入
  }
}

/** 包装 console：原样输出到 stdout/stderr（保留调试通道），同时落盘。 */
export function teeConsole(): void {
  const originalLog = console.log.bind(console)
  const originalError = console.error.bind(console)
  console.log = (...args: unknown[]): void => {
    originalLog(...args)
    write(
      args
        .map((item) => (typeof item === 'string' ? item : JSON.stringify(item) ?? String(item)))
        .join(' ')
    )
  }
  console.error = (...args: unknown[]): void => {
    originalError(...args)
    write(
      `[error] ${args
        .map((item) =>
          typeof item === 'string'
            ? item
            : item instanceof Error
              ? `${item.message}\n${item.stack ?? ''}`
              : JSON.stringify(item) ?? String(item)
        )
        .join(' ')}`
    )
  }
}
