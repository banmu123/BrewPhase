import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from './migrations'
import { localState, schema } from './schema'

export type Db = BetterSQLite3Database<typeof schema>

export type DatabaseHandle = {
  sqlite: Database.Database
  db: Db
  /** 本机设备 id：写 change log 时标记「这条是谁改的」。 */
  deviceId: string
  close: () => void
}

/**
 * 打开本地库。
 *
 * 只做三件事：给 SQLite 设正确的 pragma（外键必须开，否则级联删除是假的）、
 * 跑迁移、确保有 deviceId。**不做任何「打不开就重建」的兜底**——那会把用户的
 * 数据当成可以随手丢弃的缓存（iOS 端同一个决定，见 BrewPhaseApp）。
 */
export function openDatabase(file: string): DatabaseHandle {
  const sqlite = new Database(file)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('synchronous = NORMAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')
  sqlite.pragma('temp_store = MEMORY')

  migrate(sqlite)
  const db = drizzle(sqlite, { schema })

  let deviceId = readState(db, 'deviceId')
  if (!deviceId) {
    deviceId = randomUUID()
    db.insert(localState).values({ key: 'deviceId', value: deviceId }).run()
  }

  return { sqlite, db, deviceId, close: () => sqlite.close() }
}

export function readState(db: Db, key: string): string | null {
  const row = db.select().from(localState).where(eq(localState.key, key)).get()
  return row?.value ?? null
}

export function writeState(db: Db, key: string, value: string): void {
  db.insert(localState)
    .values({ key, value })
    .onConflictDoUpdate({ target: localState.key, set: { value } })
    .run()
}
