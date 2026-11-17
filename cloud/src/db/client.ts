import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Database = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  sql: postgres.Sql;
  ping(): Promise<void>;
  close(): Promise<void>;
}

/** 创建数据库连接池。失败（连接不可达）由调用方在启动时 fail-fast。 */
export function createDb(databaseUrl: string): DbHandle {
  // max: 10 足够单实例账号服务；idle_timeout 防止部署环境断连堆积
  const sql = postgres(databaseUrl, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false,
  });
  const db = drizzle(sql, { schema });
  return {
    db,
    sql,
    ping: async () => {
      await sql`select 1`;
    },
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

/** 执行 Drizzle 迁移（可重复执行，由 journal 保证幂等）。 */
export async function runMigrations(db: Database, migrationsFolder: string): Promise<void> {
  await migrate(db, { migrationsFolder });
}
