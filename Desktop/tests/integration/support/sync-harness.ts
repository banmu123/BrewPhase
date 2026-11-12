import { writeFileSync, mkdtempSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

import { migrate } from '../../../src/main/database/migrations'
import { SyncServer } from '../../../src/main/sync/server'

/**
 * 跨端联调夹具：起一个**真实**的 Desktop 同步服务（真实 SQLite 文件 + 真实
 * HTTP 路由 + 真实鉴权），把配对凭据写进 iOS 模拟器 App 容器的 Documents，
 * 由 `SyncCrossEndTests` 读取后驱动真实的 `SyncManager`。
 *
 * 这样跑的是「Swift 构建快照 → 真 HTTP → 真 SQLite」整条链路，而不是两端各自
 * 拿 mock 互相印证。配对码是一次性高熵值、无法预置，所以这里由夹具侧完成
 * `/api/pair`（与 iOS 客户端同一个接口），把结果当作「扫码成功后的凭据」
 * 交给测试——二维码扫描本身不在本夹具覆盖范围（见报告「无法执行」一节）。
 *
 * 用法：npx tsx sync-harness.ts <输出 JSON 路径> [端口]
 * 就绪后打印 `HARNESS_READY`，收到 SIGTERM/SIGINT 时打印数据库摘要并退出。
 */

const outputPath = process.argv[2]
const preferredPort = Number(process.argv[3] ?? '47821')
if (!outputPath) {
  console.error('usage: sync-harness.ts <output.json> [port]')
  process.exit(2)
}

const dataDir = mkdtempSync(join(tmpdir(), 'bp-cross-end-'))
const dbPath = join(dataDir, 'brewphase.db')
const sqlite = new Database(dbPath)
sqlite.pragma('foreign_keys = ON')
migrate(sqlite)

const server = new SyncServer(sqlite, 'bp_desk_cross', 'BrewPhase · 跨端', () => {})

async function main(): Promise<void> {
  const state = await server.start(['127.0.0.1'], preferredPort)
  const port = state.port ?? preferredPort

  // 与 iOS 客户端完全相同的配对请求。
  const { code } = server.pairingPayload()
  const response = await fetch(`http://127.0.0.1:${port}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingCode: code, deviceName: 'iPhone 跨端联调' })
  })
  if (response.status !== 200) throw new Error(`pair failed: ${response.status}`)
  const paired = (await response.json()) as { token: string; deviceId: string }

  const payload = {
    host: '127.0.0.1',
    port,
    token: paired.token,
    deviceId: paired.deviceId,
    dbPath
  }
  const json = JSON.stringify(payload, null, 2)
  writeFileSync(outputPath, json, 'utf8')

  /*
   * `xcodebuild test-without-building` 每次都会重装 App，容器 UUID 会变。
   * 事前把凭据拷一次会漏掉新容器，所以持续广播到所有模拟器 App 容器的
   * Documents；只写 `sync-harness.json` 这一个夹具文件，不动其他数据。
   */
  const devicesRoot = join(homedir(), 'Library/Developer/CoreSimulator/Devices')
  const broadcast = (): void => {
    if (!existsSync(devicesRoot)) return
    for (const device of readdirSync(devicesRoot)) {
      const appRoot = join(devicesRoot, device, 'data/Containers/Data/Application')
      if (!existsSync(appRoot)) continue
      for (const app of readdirSync(appRoot)) {
        const documents = join(appRoot, app, 'Documents')
        try {
          if (!existsSync(documents)) mkdirSync(documents, { recursive: true })
          writeFileSync(join(documents, 'sync-harness.json'), json, 'utf8')
        } catch {
          // 容器正在被系统创建/删除：下一轮再试。
        }
      }
    }
  }
  broadcast()
  const broadcaster = setInterval(broadcast, 200)

  console.log(`HARNESS_READY ${JSON.stringify({ port, dbPath })}`)

  const summary = (): void => {
    const tables = ['beans', 'brews', 'tastings', 'records', 'record_tags', 'record_tag_links', 'canvases', 'canvas_nodes']
    const counts: Record<string, number> = {}
    for (const table of tables) {
      counts[table] = (sqlite.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n
    }
    const baseline = (sqlite.prepare('select count(*) as n from sync_baseline').get() as { n: number }).n
    const conflicts = (sqlite.prepare('select count(*) as n from sync_conflicts').get() as { n: number }).n
    console.log(`HARNESS_SUMMARY ${JSON.stringify({ counts, baseline, conflicts, dbPath })}`)
  }
  const shutdown = (): void => {
    clearInterval(broadcaster)
    summary()
    server.stop()
    sqlite.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((error) => {
  console.error('HARNESS_FAILED', error)
  process.exit(1)
})

// 保持进程存活（服务器句柄已足够，这里只是显式标注意图）。
setInterval(() => {}, 1 << 30)
