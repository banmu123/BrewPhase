import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecordService } from '../../src/main/application/records/record-service'
import type { ChromeImageMetadata } from '../../src/shared/contracts/chrome-bridge'

const mocks = vi.hoisted(() => ({
  importImageBuffer: vi.fn(),
  removeImageFiles: vi.fn(),
  createImageFromChrome: vi.fn()
}))

vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 2, height: 2 })
    })
  }
}))

vi.mock('../../src/main/media/store', () => ({
  importImageBuffer: mocks.importImageBuffer,
  removeImageFiles: mocks.removeImageFiles
}))

const { ChromeImageError, ChromeImageReceiver } = await import(
  '../../src/main/integrations/chrome/chrome-image-receiver'
)

const META: ChromeImageMetadata = {
  title: '截图',
  sourceUrl: 'https://example.com/article',
  selectedText: '选中的原文',
  note: '我的备注'
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)])

describe('ChromeImageReceiver', () => {
  let dir = ''
  let receiver: InstanceType<typeof ChromeImageReceiver>
  let records: Pick<RecordService, 'createImageFromChrome'>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bp-chrome-image-'))
    mocks.importImageBuffer.mockReset().mockResolvedValue({
      fileName: 'a.jpg',
      previewName: 'a_thumb.jpg',
      width: 2,
      height: 2,
      byteSize: JPEG.length,
      sha256: 'x'
    })
    mocks.removeImageFiles.mockReset().mockResolvedValue(undefined)
    mocks.createImageFromChrome.mockReset().mockReturnValue({ id: 'record-1' })
    records = { createImageFromChrome: mocks.createImageFromChrome }
    receiver = new ChromeImageReceiver(dir, records as unknown as RecordService)
  })

  afterEach(async () => {
    await receiver.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  function beginPayload(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      transferId: randomUUID(),
      mimeType: 'image/jpeg' as const,
      byteSize: JPEG.length,
      width: 2,
      height: 2,
      sha256: createHash('sha256').update(JPEG).digest('hex'),
      chunkCount: 2,
      metadata: META,
      ...overrides
    }
  }

  async function sendImage(payload: ReturnType<typeof beginPayload>): Promise<{ recordId: string }> {
    await receiver.begin(payload)
    const half = Math.ceil(JPEG.length / 2)
    await receiver.chunk({
      transferId: payload.transferId,
      index: 0,
      data: JPEG.subarray(0, half).toString('base64')
    })
    await receiver.chunk({
      transferId: payload.transferId,
      index: 1,
      data: JPEG.subarray(half).toString('base64')
    })
    return receiver.commit({ transferId: payload.transferId })
  }

  it('分块传完后创建 image record，并删除临时文件', async () => {
    const payload = beginPayload()
    const result = await sendImage(payload)

    expect(result.recordId).toBe('record-1')
    expect(mocks.importImageBuffer).toHaveBeenCalled()
    expect(mocks.createImageFromChrome).toHaveBeenCalledWith(
      expect.objectContaining({
        title: META.title,
        sourceUrl: META.sourceUrl,
        selectedText: META.selectedText,
        note: META.note
      })
    )
    expect(existsSync(join(dir, 'chrome-transfers', `${payload.transferId}.part`))).toBe(false)
  })

  it('分块乱序被拒绝', async () => {
    const payload = beginPayload()
    await receiver.begin(payload)
    await expect(
      receiver.chunk({ transferId: payload.transferId, index: 1, data: JPEG.toString('base64') })
    ).rejects.toBeInstanceOf(ChromeImageError)
    expect(mocks.createImageFromChrome).not.toHaveBeenCalled()
  })

  it('SHA-256 不匹配被拒绝，且不写 Record', async () => {
    const payload = beginPayload({ sha256: 'a'.repeat(64) })
    await expect(sendImage(payload)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(mocks.createImageFromChrome).not.toHaveBeenCalled()
    expect(existsSync(join(dir, 'chrome-transfers', `${payload.transferId}.part`))).toBe(false)
  })

  it('提交不完整传输被拒绝', async () => {
    const payload = beginPayload()
    await receiver.begin(payload)
    await receiver.chunk({
      transferId: payload.transferId,
      index: 0,
      data: JPEG.subarray(0, 10).toString('base64')
    })
    await expect(receiver.commit({ transferId: payload.transferId })).rejects.toMatchObject({
      code: 'INVALID_REQUEST'
    })
  })

  it('Record 创建失败时回滚媒体文件', async () => {
    mocks.createImageFromChrome.mockImplementation(() => {
      throw new Error('db is locked')
    })
    const payload = beginPayload()

    await expect(sendImage(payload)).rejects.toMatchObject({ code: 'SAVE_FAILED' })
    expect(mocks.removeImageFiles).toHaveBeenCalledWith('a.jpg', 'a_thumb.jpg')
  })

  it('重复 BEGIN 会重置旧传输', async () => {
    const payload = beginPayload()
    await receiver.begin(payload)
    await receiver.chunk({
      transferId: payload.transferId,
      index: 0,
      data: JPEG.subarray(0, 10).toString('base64')
    })
    await receiver.begin(payload)
    // 重置后必须从 index 0 重新开始
    await expect(
      receiver.chunk({ transferId: payload.transferId, index: 1, data: JPEG.toString('base64') })
    ).rejects.toBeInstanceOf(ChromeImageError)
  })
})
