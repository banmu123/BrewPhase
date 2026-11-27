import { describe, expect, it } from 'vitest'
import { formatBytes, formatProgressBytes } from '../../src/renderer/src/features/update/format'

/**
 * 进度文案的格式化：下载进度每几百毫秒变一次，格式要稳定、不跳位。
 */

describe('formatBytes', () => {
  it('空值与 0 都是 0 B', () => {
    expect(formatBytes(null)).toBe('0 B')
    expect(formatBytes(undefined)).toBe('0 B')
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })

  it('按 1024 进制换算，字节保持整数', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
  })

  it('MB 保留一位小数，三位数以上取整', () => {
    expect(formatBytes(1_572_864)).toBe('1.5 MB')
    expect(formatBytes(136_314_880)).toBe('130 MB')
    expect(formatBytes(1_073_741_824)).toBe('1 GB')
  })
})

describe('formatProgressBytes', () => {
  it('总大小已知时给出「已下载 / 总量」', () => {
    expect(formatProgressBytes(1_572_864, 4_194_304)).toBe('1.5 MB / 4 MB')
  })

  it('总大小未知时只显示已下载', () => {
    expect(formatProgressBytes(2048, null)).toBe('2 KB')
    expect(formatProgressBytes(0, 0)).toBe('0 B')
  })
})
