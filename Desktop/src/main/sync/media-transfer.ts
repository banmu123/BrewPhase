import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { ensureMediaDir, isSafeMediaName, mediaDir } from '../media/store'

/**
 * 媒体接收：清单比对 → 分块写入临时区 → 整文件 SHA-256 校验 → 原子落位。
 *
 * - 视频本体（mov/mp4/m4v）与图片同一路径接收；桌面端第一版不播放视频，
 *   但**完整保存**，不丢弃原始文件。
 * - 名字沿用 iOS 侧存储名（UUID + 扩展名），过 `isSafeMediaName` + 扩展名
 *   白名单双重校验，renderer 与远端都拿不到任意路径。
 * - 分块 256KB：请求体完整性由 HMAC（覆盖 body）保证；**独立 chunk 哈希未
 *   实现**，整文件哈希在 finalize 时流式校验（不整读进内存）；失败任务留
 *   在 .incoming 由下一次 finalize/清理覆盖。
 * - 同名分块写入互斥（内存锁）：并发 chunk 不会交错追加导致偏移错乱。
 */

const CHUNK_SIZE = 256 * 1024
const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'mov', 'mp4', 'm4v'])

export type MediaManifestEntry = {
  name: string
  sha256: string
  byteSize: number
  mediaType: 'image' | 'video' | 'preview'
  mimeType: string
}

export type MediaManifestCheck = {
  missing: MediaManifestEntry[]
  have: string[]
  rejected: Array<{ name: string; reason: string }>
}

function incomingDir(): string {
  return join(mediaDir(), '.incoming')
}

async function ensureIncoming(): Promise<void> {
  await fs.mkdir(incomingDir(), { recursive: true })
  await ensureMediaDir()
}

function validate(entry: MediaManifestEntry): string | null {
  if (!isSafeMediaName(entry.name)) return 'unsafe name'
  const extension = entry.name.split('.').pop()?.toLowerCase() ?? ''
  if (!ALLOWED_EXTENSIONS.has(extension)) return `extension .${extension} not allowed`
  if (!Number.isFinite(entry.byteSize) || entry.byteSize <= 0 || entry.byteSize > 2 * 1024 * 1024 * 1024) {
    return 'invalid byteSize'
  }
  if (!/^[a-f0-9]{64}$/.test(entry.sha256)) return 'invalid sha256'
  return null
}

/** 流式 SHA-256：大视频不整读进内存（§9）。 */
function fileSha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk: Buffer) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/** 比对清单：已有的（文件存在且哈希一致）不再传输。 */
export async function checkManifest(entries: MediaManifestEntry[]): Promise<MediaManifestCheck> {
  await ensureIncoming()
  const missing: MediaManifestEntry[] = []
  const have: string[] = []
  const rejected: Array<{ name: string; reason: string }> = []
  for (const entry of entries) {
    const problem = validate(entry)
    if (problem) {
      rejected.push({ name: entry.name, reason: problem })
      continue
    }
    const target = mediaFilePathSafe(entry.name)
    try {
      const stat = await fs.stat(target)
      if (stat.size === entry.byteSize && (await fileSha256(target)) === entry.sha256) {
        have.push(entry.name)
        continue
      }
      missing.push(entry)
    } catch {
      missing.push(entry)
    }
  }
  return { missing, have, rejected }
}

function mediaFilePathSafe(name: string): string {
  return join(mediaDir(), name)
}

function partPath(name: string): string {
  return join(incomingDir(), `${name}.part`)
}

/**
 * 追加一块。`offset` 必须与当前临时文件长度一致（断点续传由客户端按已收
 * 字节数续）。同名分块在进程内串行化，并发到达时按到达顺序生效。
 */
const chunkLocks = new Map<string, Promise<unknown>>()

export async function writeChunk(
  name: string,
  offset: number,
  chunk: Buffer
): Promise<{ ok: true; received: number } | { ok: false; reason: string }> {
  if (!isSafeMediaName(name)) return { ok: false, reason: 'unsafe name' }
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  if (!ALLOWED_EXTENSIONS.has(extension)) return { ok: false, reason: 'extension not allowed' }
  if (chunk.length === 0 || chunk.length > CHUNK_SIZE) {
    return { ok: false, reason: `chunk size must be 1..${CHUNK_SIZE}` }
  }
  const previous = chunkLocks.get(name) ?? Promise.resolve()
  const task = previous.then(() => appendChunk(name, offset, chunk), () => appendChunk(name, offset, chunk))
  chunkLocks.set(
    name,
    task.then(
      () => undefined,
      () => undefined
    )
  )
  return task
}

async function appendChunk(
  name: string,
  offset: number,
  chunk: Buffer
): Promise<{ ok: true; received: number } | { ok: false; reason: string }> {
  await ensureIncoming()
  const part = partPath(name)
  let current = 0
  try {
    const stat = await fs.stat(part)
    current = stat.size
  } catch {
    current = 0
  }
  if (offset !== current) {
    return { ok: false, reason: `offset mismatch: have ${current}, got ${offset}` }
  }
  await fs.appendFile(part, chunk)
  return { ok: true, received: offset + chunk.length }
}

/** 收到的字节数（断点续传的起点）。名字必须先过白名单。 */
export async function receivedBytes(name: string): Promise<number> {
  if (!isSafeMediaName(name)) return 0
  try {
    const stat = await fs.stat(partPath(name))
    return stat.size
  } catch {
    return 0
  }
}

/** 整文件校验并原子落位。失败时清理临时文件，绝不留半截文件在媒体目录。 */
export async function finalizeMedia(
  name: string,
  sha256: string,
  byteSize: number
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isSafeMediaName(name)) return { ok: false, reason: 'unsafe name' }
  const part = partPath(name)
  try {
    const stat = await fs.stat(part)
    if (stat.size !== byteSize) {
      await fs.rm(part, { force: true })
      return { ok: false, reason: `size mismatch: expected ${byteSize}, got ${stat.size}` }
    }
    const actual = await fileSha256(part)
    if (actual !== sha256) {
      await fs.rm(part, { force: true })
      return { ok: false, reason: 'sha256 mismatch' }
    }
    // 同一分区内 rename 是原子的；目标存在时直接覆盖（内容哈希一致才走到这）。
    await fs.rename(part, mediaFilePathSafe(name))
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
}

export { CHUNK_SIZE }
