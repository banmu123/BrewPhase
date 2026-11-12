import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeImage } from 'electron'
import {
  CHROME_IMAGE_MAX_BYTES,
  CHROME_IMAGE_MAX_CHUNK_BYTES,
  CHROME_IMAGE_MAX_CHUNKS,
  CHROME_IMAGE_MAX_DIMENSION,
  type ChromeImageBegin,
  type ChromeImageChunk,
  type ChromeImageCommit,
  type ChromeImageMetadata
} from '../../../shared/contracts/chrome-bridge'
import type { RecordService } from '../../application/records/record-service'
import { importImageBuffer, removeImageFiles } from '../../media/store'

/**
 * Chrome 图片的分块接收。
 *
 * - 每个传输先用 `IMAGE_BEGIN` 建临时文件，`IMAGE_CHUNK` 有序追加，
 *   `IMAGE_COMMIT` 时校验块数、字节数、SHA-256 与真实图片格式；
 * - 临时文件只在 `<dataDir>/chrome-transfers/` 里，文件名来自服务端生成的
 *   UUID，不接受客户端路径；
 * - 校验通过后复用 `media/store.importImageBuffer`（与手动导入同一套缩放/
 *   缩略图逻辑），再创建 image Record；
 * - Record 创建失败会删除刚生成的媒体文件；任何失败都会清理临时文件；
 * - 超过 10 分钟未完成的传输在下次请求时清掉。
 */

const TRANSFER_TTL_MS = 10 * 60_000

export type ChromeImageErrorCode = 'INVALID_REQUEST' | 'SAVE_FAILED' | 'INTERNAL_ERROR'

export class ChromeImageError extends Error {
  constructor(
    readonly code: ChromeImageErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ChromeImageError'
  }
}

type Transfer = {
  transferId: string
  filePath: string
  mimeType: 'image/jpeg' | 'image/png'
  byteSize: number
  width: number
  height: number
  sha256: string
  chunkCount: number
  nextIndex: number
  receivedBytes: number
  metadata: ChromeImageMetadata
  createdAt: number
}

export class ChromeImageReceiver {
  private readonly transfers = new Map<string, Transfer>()
  private readonly dir: string

  constructor(
    dataDir: string,
    private readonly records: RecordService
  ) {
    this.dir = join(dataDir, 'chrome-transfers')
  }

  async begin(payload: ChromeImageBegin): Promise<void> {
    this.prune()
    if (this.transfers.has(payload.transferId)) {
      // 重发 BEGIN：重置这次传输，避免半截文件参与后续校验。
      await this.drop(payload.transferId)
    }

    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const filePath = join(this.dir, `${payload.transferId}.part`)
    await writeFile(filePath, Buffer.alloc(0), { mode: 0o600 })

    this.transfers.set(payload.transferId, {
      transferId: payload.transferId,
      filePath,
      mimeType: payload.mimeType,
      byteSize: payload.byteSize,
      width: payload.width,
      height: payload.height,
      sha256: payload.sha256,
      chunkCount: payload.chunkCount,
      nextIndex: 0,
      receivedBytes: 0,
      metadata: payload.metadata,
      createdAt: Date.now()
    })
  }

  async chunk(payload: ChromeImageChunk): Promise<void> {
    const transfer = this.require(payload.transferId)
    if (payload.index !== transfer.nextIndex) {
      throw new ChromeImageError('INVALID_REQUEST', 'image chunks are out of order')
    }

    let bytes: Buffer
    try {
      bytes = Buffer.from(payload.data, 'base64')
    } catch {
      throw new ChromeImageError('INVALID_REQUEST', 'chunk is not valid base64')
    }
    if (bytes.byteLength === 0 || bytes.byteLength > CHROME_IMAGE_MAX_CHUNK_BYTES) {
      throw new ChromeImageError('INVALID_REQUEST', 'chunk size is out of range')
    }
    if (transfer.receivedBytes + bytes.byteLength > transfer.byteSize) {
      throw new ChromeImageError('INVALID_REQUEST', 'image exceeds the declared size')
    }

    await appendFile(transfer.filePath, bytes)
    transfer.nextIndex += 1
    transfer.receivedBytes += bytes.byteLength
  }

  async commit(payload: ChromeImageCommit): Promise<{ recordId: string }> {
    const transfer = this.require(payload.transferId)

    if (transfer.nextIndex !== transfer.chunkCount || transfer.receivedBytes !== transfer.byteSize) {
      throw new ChromeImageError('INVALID_REQUEST', 'image transfer is incomplete')
    }

    try {
      const buffer = await readFile(transfer.filePath)
      if (buffer.byteLength !== transfer.byteSize) {
        throw new ChromeImageError('INVALID_REQUEST', 'image size does not match')
      }

      const digest = createHash('sha256').update(buffer).digest('hex')
      if (digest !== transfer.sha256) {
        throw new ChromeImageError('INVALID_REQUEST', 'image checksum does not match')
      }
      if (!hasValidSignature(buffer, transfer.mimeType)) {
        throw new ChromeImageError('INVALID_REQUEST', 'image data does not match its mime type')
      }

      const decoded = nativeImage.createFromBuffer(buffer)
      if (decoded.isEmpty()) {
        throw new ChromeImageError('INVALID_REQUEST', 'image cannot be decoded')
      }
      const size = decoded.getSize()
      if (
        size.width <= 0 ||
        size.height <= 0 ||
        size.width > CHROME_IMAGE_MAX_DIMENSION ||
        size.height > CHROME_IMAGE_MAX_DIMENSION
      ) {
        throw new ChromeImageError('INVALID_REQUEST', 'image dimensions are out of range')
      }

      const media = await importImageBuffer(buffer)
      try {
        const record = this.records.createImageFromChrome({
          media,
          title: transfer.metadata.title,
          sourceUrl: transfer.metadata.sourceUrl,
          selectedText: transfer.metadata.selectedText,
          note: transfer.metadata.note
        })
        return { recordId: record.id }
      } catch (error) {
        // 记录没写成：把刚写入 media 的展示图/缩略图删掉，不留孤儿。
        await removeImageFiles(media.fileName, media.previewName)
        throw new ChromeImageError(
          'SAVE_FAILED',
          error instanceof Error ? error.message : 'could not create the image record'
        )
      }
    } finally {
      await this.drop(transfer.transferId)
    }
  }

  /** 删除一个传输的临时文件与内存状态。 */
  async drop(transferId: string): Promise<void> {
    const transfer = this.transfers.get(transferId)
    if (!transfer) return
    this.transfers.delete(transferId)
    await rm(transfer.filePath, { force: true }).catch(() => undefined)
  }

  /** 应用退出时清理所有未完成传输与目录。 */
  async dispose(): Promise<void> {
    for (const transferId of [...this.transfers.keys()]) {
      await this.drop(transferId)
    }
    await rm(this.dir, { recursive: true, force: true }).catch(() => undefined)
  }

  private require(transferId: string): Transfer {
    const transfer = this.transfers.get(transferId)
    if (!transfer) {
      throw new ChromeImageError('INVALID_REQUEST', 'unknown image transfer')
    }
    return transfer
  }

  private prune(): void {
    const now = Date.now()
    for (const [transferId, transfer] of this.transfers) {
      if (now - transfer.createdAt > TRANSFER_TTL_MS) {
        void this.drop(transferId)
      }
    }
  }
}

/** JPEG / PNG 文件签名；拒绝「扩展说是图片，实际是别的东西」。 */
function hasValidSignature(buffer: Buffer, mimeType: string): boolean {
  if (buffer.byteLength < 12) return false
  if (mimeType === 'image/jpeg') {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  }
  if (mimeType === 'image/png') {
    return buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  }
  return false
}

/** 供测试引用，避免把常量散落在断言里。 */
export const CHROME_IMAGE_LIMITS = {
  maxBytes: CHROME_IMAGE_MAX_BYTES,
  maxChunkBytes: CHROME_IMAGE_MAX_CHUNK_BYTES,
  maxChunks: CHROME_IMAGE_MAX_CHUNKS,
  maxDimension: CHROME_IMAGE_MAX_DIMENSION
} as const

export function imageTransferExists(dir: string, transferId: string): boolean {
  return existsSync(join(dir, 'chrome-transfers', `${transferId}.part`))
}
