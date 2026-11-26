import { defineConfig } from "drizzle-kit";

// drizzle-kit 生成迁移只需要 schema，不需要真实数据库连接。
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  strict: true,
  verbose: true,
});
