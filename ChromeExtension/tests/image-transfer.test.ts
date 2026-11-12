import { describe, expect, it } from 'vitest'
import { bytesToBase64, chunkBase64, sha256Hex } from '../src/lib/image-transfer'
import { IMAGE_CHUNK_BYTES } from '../src/shared/protocol'

describe('图片分块编码', () => {
  it('base64 编码与解码一致（含跨块边界）', () => {
    const bytes = new Uint8Array(IMAGE_CHUNK_BYTES + 1024)
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 251
    }

    const chunks = chunkBase64(bytes)
    expect(chunks.length).toBe(2)
    expect(chunks[0].length).toBeLessThanOrEqual(Math.ceil((IMAGE_CHUNK_BYTES * 4) / 3) + 4)

    const decoded = new Uint8Array(
      atob(chunks[0] + chunks[1])
        .split('')
        .map((char) => char.charCodeAt(0))
    )
    expect([...decoded]).toEqual([...bytes])
  })

  it('空输入不产生分块', () => {
    expect(chunkBase64(new Uint8Array(0))).toEqual([])
  })

  it('bytesToBase64 与 btoa 对小输入一致', () => {
    const bytes = new Uint8Array([104, 101, 108, 108, 111])
    expect(bytesToBase64(bytes)).toBe(btoa('hello'))
  })

  it('sha256 对标准测试向量返回正确摘要', async () => {
    // FIPS 180-4 的公开测试向量。
    expect(await sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    )
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })

  it('sha256 对不同输入产生不同摘要', async () => {
    const a = await sha256Hex(new Uint8Array([1, 2, 3]))
    const b = await sha256Hex(new Uint8Array([1, 2, 4]))
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})
