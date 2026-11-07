import type { Config } from 'drizzle-kit'

/**
 * 迁移是手写 SQL + `user_version`（见 src/main/database/migrations.ts）。
 * 这份配置只用来在开发期生成/比对 schema 差异，不参与应用启动。
 */
export default {
  dialect: 'sqlite',
  schema: './src/main/database/schema.ts',
  out: './drizzle'
} satisfies Config
