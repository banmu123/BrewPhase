import Database from 'better-sqlite3'
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { migrations } from '../../src/main/database/migrations'

/**
 * Studio Home 的 E2E 种子数据。
 *
 * 只写**测试临时目录**里的库与媒体目录（调用方用 BREWPHASE_USER_DATA_DIR
 * 指过去），绝不碰真实库。全部字段都是真实记录字段——没有「假卡片」：
 * 卡片是组件按记录数据渲染出来的。
 *
 * 图片用本文件里的极简 PNG 编码器生成（纯 zlib，不引入依赖）：
 * 渐变底 + 一点条纹，让截图里的卡面能区分不同记录。
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let c = -1
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([length, typeBuf, data, crc])
}

/** 生成一张对角渐变 PNG（RGB，无 alpha）：只给视觉验收当「真实图片」。 */
export function gradientPng(
  width: number,
  height: number,
  from: [number, number, number],
  to: [number, number, number]
): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  let p = 0
  for (let y = 0; y < height; y += 1) {
    raw[p] = 0 // 每行 filter=none
    p += 1
    for (let x = 0; x < width; x += 1) {
      const t = (x / width + y / height) / 2
      // 确定性细条纹：让卡面看起来像照片而不是纯色块（不用随机数）。
      const shade = 0.92 + 0.08 * Math.sin(x * 0.07 + y * 0.045)
      for (let c = 0; c < 3; c += 1) {
        raw[p] = Math.max(0, Math.min(255, Math.round((from[c] + (to[c] - from[c]) * t) * shade)))
        p += 1
      }
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** 建空库：只跑迁移，不写任何业务数据（空状态验收用）。 */
export function seedEmptyDatabase(appData: string): void {
  mkdirSync(appData, { recursive: true })
  const db = new Database(join(appData, 'brewphase.db'))
  for (const migration of migrations) db.exec(migration.sql)
  db.pragma(`user_version = ${migrations.length}`)
  db.close()
  mkdirSync(join(appData, 'media'), { recursive: true })
}

const PNG_SWATCHES: Array<{ name: string; from: [number, number, number]; to: [number, number, number] }> = [
  { name: 'studioshot1', from: [214, 196, 168], to: [124, 104, 82] }, // 晨光手冲
  { name: 'studioshot2', from: [168, 180, 156], to: [74, 88, 70] }, // 周末 espresso
  { name: 'studioshot3', from: [232, 224, 208], to: [156, 130, 104] }, // 拉花
  { name: 'beanpack1', from: [226, 210, 186], to: [150, 118, 92] }, // 豆袋包装
  { name: 'beanpack2', from: [206, 198, 176], to: [116, 108, 86] }
]

function writeSwatches(mediaDir: string): void {
  mkdirSync(mediaDir, { recursive: true })
  for (const swatch of PNG_SWATCHES) {
    const png = gradientPng(480, 360, swatch.from, swatch.to)
    writeFileSync(join(mediaDir, `${swatch.name}.png`), png)
    writeFileSync(join(mediaDir, `${swatch.name}_thumb.png`), png)
  }
}

/** 种子 ID：固定值，断言与截图都可复现。 */
export const SEED = {
  beans: ['aaaaaaaa-1111-4111-8111-000000000001', 'aaaaaaaa-1111-4111-8111-000000000002', 'aaaaaaaa-1111-4111-8111-000000000003'],
  records: {
    image1: 'bbbbbbbb-1111-4111-8111-000000000001',
    link1: 'bbbbbbbb-1111-4111-8111-000000000002',
    text1: 'bbbbbbbb-1111-4111-8111-000000000003',
    link2: 'bbbbbbbb-1111-4111-8111-000000000004',
    image2: 'bbbbbbbb-1111-4111-8111-000000000005',
    text2: 'bbbbbbbb-1111-4111-8111-000000000006',
    video1: 'bbbbbbbb-1111-4111-8111-000000000007'
  },
  canvases: ['cccccccc-1111-4111-8111-000000000001', 'cccccccc-1111-4111-8111-000000000002']
} as const

export const SEED_TEXT_NOTE =
  '水温 92 度、15 克粉、1:16。酸质明亮，尾段稍薄，下次把研磨调细半格。'

/**
 * 三个空间都有真实数据的库：3 包豆子、7 条记录（两条图片、两条链接、
 * 两条文字、一条视频）、2 块画布（带节点）。
 *
 * 排序按 createdAt 递增写入，最新的是视频记录 —— 首页 Deck 第一张就是它。
 */
export function seedStudioDatabase(appData: string): void {
  mkdirSync(appData, { recursive: true })
  const mediaDir = join(appData, 'media')
  writeSwatches(mediaDir)

  const db = new Database(join(appData, 'brewphase.db'))
  for (const migration of migrations) db.exec(migration.sql)
  db.pragma(`user_version = ${migrations.length}`)

  const base = 1_790_000_000_000
  const insertBean = db.prepare(
    `insert into beans (id, name, roaster, origin, process, roast_level, roast_date, purchase_date,
      weight_g, remaining_g, price, channel, image_path, flavor_tags_raw, notes, status, is_sample,
      created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)`
  )
  const beanRows: Array<[string, string, string, string, string, number, number, number, string | null]> = [
    [SEED.beans[0], '耶加雪菲 日晒', '启程咖啡', '埃塞俄比亚 耶加雪菲', '日晒', 200, 168, 12, 'beanpack1.png'],
    [SEED.beans[1], '哥伦比亚 粉波旁', 'Origen Lab', '哥伦比亚 慧兰', '水洗', 250, 233, 8, 'beanpack2.png'],
    [SEED.beans[2], '危地马拉 薇薇特南果', '本地小批次', '危地马拉', '水洗', 200, 196, 2, null]
  ]
  beanRows.forEach((row, index) => {
    insertBean.run(
      row[0],
      row[1],
      row[2],
      row[3],
      row[4],
      'medium',
      base - 6 * 86_400_000,
      base - 5 * 86_400_000,
      row[5],
      row[6],
      row[7],
      '',
      row[8],
      '',
      '',
      base + index * 1000,
      base + index * 1000
    )
  })

  const insertRecord = db.prepare(
    `insert into records (id, carrier, title, note, url_string, canonical_url, provider,
      platform_content_id, source_name, author_name, summary, media_path, preview_path,
      thumbnail_url_string, metadata_status, repository_stars, repository_forks,
      repository_issues, repository_language, repository_license, is_sample, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?, ?, ?, ?, 0, ?, ?)`
  )
  type SeedRecord = {
    id: string
    carrier: string
    title: string
    note?: string
    url?: string
    canonical?: string | null
    provider?: string
    contentId?: string | null
    source?: string
    author?: string
    summary?: string
    media?: string | null
    preview?: string | null
    thumbnail?: string | null
    stars?: number | null
    forks?: number | null
    language?: string | null
    license?: string | null
    offset: number
  }
  // createdAt 递增写入：首页 Deck 取最新 5 条，所以要保证这 5 条里
  // 四种载体都出现（视频 / 带封面链接 / 文字 ×2 / 图片）。
  const recordRows: SeedRecord[] = [
    {
      id: SEED.records.image1,
      carrier: 'image',
      title: '晨光里的手冲',
      media: 'studioshot1.png',
      preview: 'studioshot1_thumb.png',
      summary: '六点半的光刚好斜进来。',
      offset: 4
    },
    {
      id: SEED.records.link1,
      carrier: 'link',
      title: 'Slow Coffee: A Field Guide',
      url: 'https://blog.example.com/slow-coffee',
      canonical: 'https://blog.example.com/slow-coffee',
      source: 'blog.example.com',
      summary: 'A calm walk through pour-over variables.',
      thumbnail: 'https://cdn.mock.test/slow-coffee.png',
      offset: 8
    },
    {
      id: SEED.records.text1,
      carrier: 'text',
      title: '',
      note: SEED_TEXT_NOTE,
      offset: 5
    },
    {
      id: SEED.records.link2,
      carrier: 'link',
      title: 'The Physics of Filter Coffee',
      url: 'https://example.org/physics-of-filter-coffee',
      canonical: 'https://example.org/physics-of-filter-coffee',
      source: '',
      summary: 'Why the bed depth matters more than the pour.',
      offset: 3
    },
    {
      id: SEED.records.image2,
      carrier: 'image',
      title: '周末的 Espresso',
      media: 'studioshot2.png',
      preview: 'studioshot2_thumb.png',
      offset: 6
    },
    {
      id: SEED.records.text2,
      carrier: 'text',
      title: '',
      summary: '把豆子分装成每包 15 克，早上就不用再称。',
      offset: 7
    },
    {
      id: SEED.records.video1,
      carrier: 'video',
      title: '拉花练习：第三次',
      preview: 'studioshot3_thumb.png',
      summary: '奶泡还是偏厚，明天把进气时间缩短。',
      offset: 9
    }
  ]
  for (const row of recordRows) {
    insertRecord.run(
      row.id,
      row.carrier,
      row.title,
      row.note ?? '',
      row.url ?? '',
      row.canonical ?? null,
      row.provider ?? 'generic',
      row.contentId ?? null,
      row.source ?? '',
      row.author ?? '',
      row.summary ?? '',
      row.media ?? null,
      row.preview ?? null,
      row.thumbnail ?? null,
      row.stars ?? null,
      row.forks ?? null,
      null,
      row.language ?? null,
      row.license ?? null,
      base + row.offset * 60_000,
      base + row.offset * 60_000
    )
  }

  const insertCanvas = db.prepare(
    'insert into canvases (id, name, note, is_sample, created_at, updated_at) values (?, ?, ?, 0, ?, ?)'
  )
  insertCanvas.run(SEED.canvases[0], '风味轮草稿', '', base, base + 5_000)
  insertCanvas.run(SEED.canvases[1], '萃取参数实验', '', base, base + 9_000)

  const insertNode = db.prepare(
    `insert into canvas_nodes (id, canvas_id, record_id, position_x, position_y, width, height,
      z_index, annotation, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`
  )
  const nodes: Array<[string, string, string, number, number, number, number, number]> = [
    [SEED.canvases[0], SEED.records.image1, 'dddddddd-1111-4111-8111-000000000001', 0, 0, 260, 200, 0],
    [SEED.canvases[0], SEED.records.text1, 'dddddddd-1111-4111-8111-000000000002', 300, 30, 240, 180, 1],
    [SEED.canvases[0], SEED.records.link1, 'dddddddd-1111-4111-8111-000000000003', 90, 250, 260, 200, 2],
    [SEED.canvases[1], SEED.records.image2, 'dddddddd-1111-4111-8111-000000000004', 0, 0, 240, 190, 0],
    [SEED.canvases[1], SEED.records.video1, 'dddddddd-1111-4111-8111-000000000005', 260, 60, 240, 190, 1]
  ]
  for (const node of nodes) {
    insertNode.run(node[2], node[0], node[1], node[3], node[4], node[5], node[6], node[7], base, base)
  }

  db.close()
}
