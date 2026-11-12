import {
  IMAGE_CHUNK_BYTES,
  IMAGE_MAX_BYTES,
  internalError,
  newRequestId,
  type ChromeCompanionResponse,
  type ImageMetadata,
  type PopupMessage
} from '../shared/protocol'

/**
 * 截图 → 压缩 → 分块 → 交给 Service Worker 转发。
 *
 * 只在用户主动点击截图/保存时执行；不产生后台任务，也不把图片存进
 * chrome.storage（草稿只在下单次编辑期间放 session storage）。
 */

export type PreparedImage = {
  dataUrl: string
  mimeType: 'image/jpeg'
  byteSize: number
  width: number
  height: number
  sha256: string
  chunkCount: number
  chunks: string[]
}

export async function prepareImage(
  dataUrl: string,
  maxEdge = 2_000,
  quality = 0.86
): Promise<PreparedImage> {
  const source = await (await fetch(dataUrl)).blob()
  const bitmap = await createImageBitmap(source)

  const ratio = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * ratio))
  const height = Math.max(1, Math.round(bitmap.height * ratio))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('canvas is not available')
  context.drawImage(bitmap, 0, 0, width, height)

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error('could not encode the image'))),
      'image/jpeg',
      quality
    )
  })
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (bytes.byteLength > IMAGE_MAX_BYTES) throw new Error('image is too large')

  const chunks = chunkBase64(bytes)
  return {
    dataUrl: canvas.toDataURL('image/jpeg', quality),
    mimeType: 'image/jpeg',
    byteSize: bytes.byteLength,
    width,
    height,
    sha256: await sha256Hex(bytes),
    chunkCount: chunks.length,
    chunks
  }
}

/** 逐块请求 Service Worker；任何一块失败都立即停止并返回真实错误。 */
export async function sendImage(
  prepared: PreparedImage,
  metadata: ImageMetadata
): Promise<ChromeCompanionResponse> {
  const transferId = crypto.randomUUID()

  const begin = await ask({
    source: 'brewphase-popup',
    type: 'IMAGE_BEGIN',
    payload: {
      transferId,
      mimeType: prepared.mimeType,
      byteSize: prepared.byteSize,
      width: prepared.width,
      height: prepared.height,
      sha256: prepared.sha256,
      chunkCount: prepared.chunkCount,
      metadata
    }
  })
  if (!begin) return internalError(newRequestId(), 'no response from the service worker')
  if (!begin.success) return begin

  for (let index = 0; index < prepared.chunks.length; index += 1) {
    const response = await ask({
      source: 'brewphase-popup',
      type: 'IMAGE_CHUNK',
      payload: { transferId, index, data: prepared.chunks[index] }
    })
    if (!response) return internalError(newRequestId(), 'image chunk did not reach the service worker')
    if (!response.success) return response
  }

  return (
    (await ask({
      source: 'brewphase-popup',
      type: 'IMAGE_COMMIT',
      payload: { transferId }
    })) ?? internalError(newRequestId(), 'image commit did not reach the service worker')
  )
}

async function ask(message: PopupMessage): Promise<ChromeCompanionResponse | null> {
  try {
    return (await chrome.runtime.sendMessage(message)) as ChromeCompanionResponse
  } catch {
    return null
  }
}

export function chunkBase64(bytes: Uint8Array, chunkSize = IMAGE_CHUNK_BYTES): string[] {
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    chunks.push(bytesToBase64(bytes.subarray(offset, offset + chunkSize)))
  }
  return chunks
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let index = 0; index < bytes.byteLength; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step))
  }
  return btoa(binary)
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // `new Uint8Array(bytes)` 复制进独立的 ArrayBuffer，满足 BufferSource 的类型约束。
  const buffer = new Uint8Array(bytes).buffer as ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
