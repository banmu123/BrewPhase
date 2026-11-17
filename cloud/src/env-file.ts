import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 加载本地 `.env`（存在才加载）。
 *
 * 为什么需要它：`pnpm dev` 与 `pnpm db:migrate` 都是普通 Node 进程，而 README 让
 * 用户 `cp .env.example .env`。没有这一步，写进 `.env` 的配置永远进不了
 * `process.env`——`DATABASE_URL` 直接校验失败，本地根本起不来。
 *
 * 纪律：
 * - **进程环境优先**：`process.loadEnvFile` 不覆盖已存在的变量，容器 / CI / shell
 *   注入的值始终胜出，`.env` 只做兜底；
 * - **生产不读**：镜像已排除该文件，这里再显式跳过，避免「开发配置被带进生产」
 *   （生产配置必须由部署环境显式注入，缺什么就按 env 校验直接拒绝启动）；
 * - **永不打印内容**：文件里有 Client Secret 与数据库口令，只允许报告「加载了哪个
 *   路径」，且由调用方决定是否记录。
 */
export function loadLocalEnvFile(path = ".env"): string | null {
  if (process.env.NODE_ENV === "production") return null;
  const file = resolve(path);
  if (!existsSync(file)) return null;
  process.loadEnvFile(file);
  return file;
}
