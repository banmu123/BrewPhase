import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

/**
 * 生成扩展图标（16/32/48/128）。
 *
 * 不引入 canvas / sharp：图案只有圆角方块、杯身、把手和两缕蒸汽，
 * 4×4 超采样 + 手写 PNG 编码足够，也避免为四个小图标增加原生依赖。
 */

const root = dirname(fileURLToPath(new URL('.', import.meta.url)))
const outDir = join(root, 'public', 'icons')

const SIZE = 128
const SS = 4
const INK = [48, 55, 47, 255]
const PAPER = [247, 248, 246, 255]
const CREAM = [185, 159, 134, 255]
const SAGE = [132, 151, 121, 255]

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const dx = x < x0 + r ? x0 + r - x : x > x1 - r ? x - (x1 - r) : 0
  const dy = y < y0 + r ? y0 + r - y : y > y1 - r ? y - (y1 - r) : 0
  return dx * dx + dy * dy <= r * r
}

function inCircle(x, y, cx, cy, r) {
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

function steam(x, y) {
  if (y < 18 || y > 44) return false
  const wobble = Math.sin((y - 18) / 5.5) * 3
  return Math.abs(x - (52 + wobble)) < 1.7 || Math.abs(x - (68 - wobble)) < 1.7
}

function sample(x, y) {
  if (!inRoundRect(x, y, 8, 8, 120, 120, 27)) return [0, 0, 0, 0]
  if (steam(x, y)) return SAGE

  const body = inRoundRect(x, y, 38, 46, 86, 94, 8)
  const handle = x > 84 && inCircle(x, y, 92, 70, 16) && !inCircle(x, y, 92, 70, 10)

  if (body || handle) {
    if (body && y < 60) return CREAM
    return PAPER
  }
  return INK
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4)
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = ((px + (sx + 0.5) / SS) / size) * SIZE
          const y = ((py + (sy + 0.5) / SS) / size) * SIZE
          const point = sample(x, y)
          r += point[0]
          g += point[1]
          b += point[2]
          a += point[3]
        }
      }
      const n = SS * SS
      const offset = (py * size + px) * 4
      pixels[offset] = Math.round(r / n)
      pixels[offset + 1] = Math.round(g / n)
      pixels[offset + 2] = Math.round(b / n)
      pixels[offset + 3] = Math.round(a / n)
    }
  }
  return pixels
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

function encodePng(size, pixels) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6

  const stride = size * 4 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0
    pixels.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4)
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

mkdirSync(outDir, { recursive: true })
for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(outDir, `icon${size}.png`), encodePng(size, render(size)))
  console.log(`[icons] icon${size}.png`)
}
