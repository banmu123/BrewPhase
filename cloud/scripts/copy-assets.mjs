// 构建后把 Drizzle 迁移 SQL 复制进 dist，保证生产镜像内迁移文件与编译产物同构。
import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "src", "db", "migrations");
const dest = join(root, "dist", "db", "migrations");

if (!existsSync(src)) {
  console.error("[copy-assets] missing src/db/migrations — run `pnpm db:generate` first");
  process.exit(1);
}

cpSync(src, dest, { recursive: true });
console.log("[copy-assets] copied src/db/migrations -> dist/db/migrations");
