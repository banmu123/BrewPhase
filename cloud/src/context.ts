import type { Hono } from "hono";
import type { DbHandle } from "./db/client.js";
import type { Env } from "./env.js";
import type { JwtKeyRing, AccessClaims } from "./sessions/jwt.js";
import type { Logger } from "./logger.js";
import type { ProviderMap } from "./oauth/providers.js";

export type AppHono = Hono<{ Variables: { authClaims: AccessClaims } }>;

/** 应用级依赖：由 app.ts 装配，路由层只依赖这个接口（便于测试注入）。 */
export interface AppContext {
  env: Env;
  db: DbHandle;
  providers: ProviderMap;
  logger: Logger;
  keyRing: JwtKeyRing;
}
