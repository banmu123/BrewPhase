import type { Hono } from "hono";
import type { DbHandle } from "./db/client.js";
import type { Env } from "./env.js";
import type { JwtKeyRing, AccessClaims } from "./sessions/jwt.js";
import type { Logger } from "./logger.js";
import type { ProviderMap } from "./oauth/providers.js";

export type AppHono = Hono<{ Variables: { authClaims: AccessClaims } }>;

/**
 * 应用级依赖：由 app.ts 装配，路由层只依赖这个接口（便于测试注入）。
 *
 * `link` 与 `instanceId` 都是**可选**的：
 *
 * - `link` 只在真正的 Gateway 进程里存在（测试与纯 HTTP 场景不需要）。
 *   设备暂停/撤销的「清理连接」这一步由它提供；为 `undefined` 时路由层
 *   跳过清理——那正是「只跑 HTTP 的测试」想要的语义（没有连接可清）。
 * - `instanceId` 每次启动生成，`/ready` 用它暴露「我是不是另一台实例」。
 */
export interface AppContext {
  env: Env;
  db: DbHandle;
  providers: ProviderMap;
  logger: Logger;
  keyRing: JwtKeyRing;
  link?: LinkControl;
  instanceId?: string;
}

/**
 * 路由层需要的**唯一**连接控制面。
 *
 * 刻意只暴露两个方法：`disconnectDevice`（suspend / revoke 之后清连接）
 * 与 `connectionCount`（`/ready`）。路由层不该看到 `bind` / `lookup` /
 * 心跳——那些属于连接层，混进来就会长出「HTTP 路由直接操作 socket」的代码。
 */
export interface LinkControl {
  readonly instanceId: string;
  connectionCount(): number;
  disconnectDevice(deviceId: string, reason: "suspended" | "revoked"): Promise<void>;
}
