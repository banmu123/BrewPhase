import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app, dialog, nativeImage } from 'electron'
import type { ImportImageResult } from '../../shared/contracts'

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
  return path.join(app.getPath('userData'), 'media')
}

export async function ensureMediaDir(): Promise<void> {
  await fs.mkdir(mediaDir(), { recursive: true })
}

/** 只接受我们自己生成的两种名字，任何路径分隔符都视为攻击。 */
export function isSafeMediaName(name: string): boolean {
  return /^[A-Za-z0-9_-]{8,64}(_thumb)?\.(jpg|png|webp)$/.test(name)
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

  const original = await fs.readFile(sourcePath)
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
    byteSize: stat.size,
    sha256
  }
}

function resizeToFit(image: Electron.NativeImage, maxEdge: number): Electron.NativeImage {
  const { width, height } = image.getSize()
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return image
  const ratio = maxEdge / longest
  return image.resize({ width: Math.round(width * ratio), height: Math.round(height * ratio), quality: 'good' })
}
