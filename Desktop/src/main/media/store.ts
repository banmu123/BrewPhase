import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { dialog, nativeImage } from 'electron'
import type { ImportImageResult } from '../../shared/contracts'
import { activeDataDir } from '../data-location'

/**
 * 媒体文件只由主进程碰。
 *
 * Renderer 拿到的是**文件名**（`<uuid>.jpg`），显示时走 `bpmedia://media/<name>`
 * 自定义协议，由主进程校验名字、读文件、返回字节。这样 renderer 既不需要
 * `file://` 权限，也不可能拼出 `../../` 去读用户目录之外的东西。
 */

export const MEDIA_SCHEME = 'bpmedia'
export const MEDIA_HOST = 'media'

/** 单张图片上限：40MB，超过就拒绝——画布不需要原图，也不需要用户等。 */
const MAX_IMAGE_BYTES = 40 * 1024 * 1024
const DISPLAY_MAX_EDGE = 2_048
const PREVIEW_MAX_EDGE = 480

export function mediaDir(): string {
  // 测试与便携场景可整体覆盖；正常运行时跟随用户选择的数据目录。
  const override = process.env.BREWPHASE_USER_DATA_DIR
  if (override) return path.join(override, 'media')
  return path.join(activeDataDir(), 'media')
}

export async function ensureMediaDir(): Promise<void> {
  await fs.mkdir(mediaDir(), { recursive: true })
}

/** 只接受我们自己生成的两种名字，任何路径分隔符都视为攻击。 */
export function isSafeMediaName(name: string): boolean {
  return /^[A-Za-z0-9_-]{8,64}(_thumb)?\.(jpg|png|webp|mov|mp4|m4v)$/.test(name)
}

export function mediaFilePath(name: string): string {
  if (!isSafeMediaName(name)) throw new Error('unsafe media name')
  return path.join(mediaDir(), name)
}

/**
 * 让用户选一张图，复制进 media 目录并生成展示图与缩略图。
 *
 * - 原文件不动（用户可能还想在 Finder 里用它）；
 * - 展示图最长边 2048、缩略图 480，都是 JPEG——画布不需要 12MP 原图；
 * - 返回 SHA-256，用于之后局域网传输的块校验。
 */
export async function importImageFromDialog(): Promise<ImportImageResult | null> {
  const result = await dialog.showOpenDialog({
    title: '选择图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
  })
  if (result.canceled || result.filePaths.length === 0) return null

  const sourcePath = result.filePaths[0]
  const stat = await fs.stat(sourcePath)
  if (!stat.isFile()) throw new Error('不是文件')
  if (stat.size > MAX_IMAGE_BYTES) throw new Error('图片超过 40MB')

  return importImageBuffer(await fs.readFile(sourcePath))
}

/**
 * 从内存字节导入一张图片（Chrome 截图 / 右键图片共用）。
 *
 * 与文件导入走同一套校验、缩放与缩略图逻辑：不产生第二套媒体格式。
 */
export async function importImageBuffer(original: Buffer): Promise<ImportImageResult> {
  if (original.byteLength > MAX_IMAGE_BYTES) throw new Error('图片超过 40MB')

  const sha256 = createHash('sha256').update(original).digest('hex')
  const image = nativeImage.createFromBuffer(original)
  if (image.isEmpty()) throw new Error('无法读取这张图片')

  const size = image.getSize()
  const base = randomUUID()
  const fileName = `${base}.jpg`
  const previewName = `${base}_thumb.jpg`

  const display = resizeToFit(image, DISPLAY_MAX_EDGE)
  const preview = resizeToFit(image, PREVIEW_MAX_EDGE)

  await ensureMediaDir()
  await fs.writeFile(mediaFilePath(fileName), display.toJPEG(86))
  await fs.writeFile(mediaFilePath(previewName), preview.toJPEG(78))

  return {
    fileName,
    previewName,
    width: size.width,
    height: size.height,
    byteSize: original.byteLength,
    sha256
  }
}

/** Records 写入失败时回滚已生成的媒体文件，避免孤儿文件。 */
export async function removeImageFiles(fileName: string, previewName: string | null): Promise<void> {
  await fs.rm(mediaFilePath(fileName), { force: true }).catch(() => undefined)
  if (previewName) await fs.rm(mediaFilePath(previewName), { force: true }).catch(() => undefined)
}

function resizeToFit(image: Electron.NativeImage, maxEdge: number): Electron.NativeImage {
  const { width, height } = image.getSize()
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return image
  const ratio = maxEdge / longest
  return image.resize({ width: Math.round(width * ratio), height: Math.round(height * ratio), quality: 'good' })
}
