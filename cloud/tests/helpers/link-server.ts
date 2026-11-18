import { WebSocket } from "ws";
import { createApp } from "../../src/app.js";
import type { AppContext } from "../../src/context.js";
import {
  createLinkServer,
  type LinkLifecycleHooks,
  type LinkServer,
} from "../../src/link/index.js";
import type { ConnectionRegistry } from "../../src/link/connection-registry.js";
import { NonceStore } from "../../src/link/nonce-store.js";
import { startCloudServer, type CloudServer } from "../../src/server.js";
import { createLogger } from "../../src/logger.js";
import { createKeyRing } from "../../src/sessions/jwt.js";
import { createProviders } from "../../src/oauth/providers.js";
import { ensureDatabaseOrThrow, getTestDb, resetDb } from "./db.js";
import { makeTestEnv, type TestEnvOverrides } from "./env.js";
import { REMOTE_WS_SUBPROTOCOL } from "../../src/link/schemas.js";

/**
 * 真实 WSS 服务器的测试夹具。
 *
 * ## 为什么必须是**真**服务器
 *
 * Phase 1.1B 的教训：Mock Gateway 无条件回 101，于是「设备认证」在两侧都
 * 没实现，测试却全绿。这里刻意不提供任何 Mock —— `startCloudServer` 就是
 * 生产入口用的那个函数，客户端是真正的 `ws` 实现，握手是真的 HTTP Upgrade。
 *
 * 唯一被替换的是**时钟**与**端口**：
 * - 端口用 0（内核分配），避免测试之间抢端口；
 * - 时钟可注入，因为 golden fixture 的 `ts` 是固定值。
 */

export interface LinkHarness {
  ctx: AppContext;
  link: LinkServer;
  server: CloudServer;
  /** `ws://127.0.0.1:<port>/device-link` */
  url: string;
  close(): Promise<void>;
}

export async function createLinkHarness(
  options: TestEnvOverrides & {
    allowedHosts?: string[];
    heartbeatMs?: number;
    idleTimeoutMs?: number;
    helloTimeoutMs?: number;
    now?: () => number;
    logLevel?: "debug" | "info" | "warn" | "error";
    /** 是否清空业务表（默认 true）。模拟「Cloud 重启但数据库不变」时传 false。 */
    resetDb?: boolean;
    /** **仅并发测试使用**：在精确的 await 边界暂停握手。 */
    lifecycleHooks?: LinkLifecycleHooks;
    /** **仅并发测试使用**：包一层 registry（例如让 bind 变慢）。 */
    registry?: ConnectionRegistry;
  } = {},
): Promise<LinkHarness> {
  await ensureDatabaseOrThrow();
  const {
    allowedHosts,
    heartbeatMs,
    idleTimeoutMs,
    helloTimeoutMs,
    now,
    logLevel,
    resetDb: shouldReset = true,
    lifecycleHooks,
    registry: customRegistry,
    ...envOverrides
  } = options;

  const env = makeTestEnv(envOverrides);
  const db = await getTestDb();
  const ctx: AppContext = {
    env,
    db,
    providers: createProviders(env),
    logger: createLogger(logLevel ?? env.logLevel),
    keyRing: createKeyRing(env.jwtSigningKey, env.jwtSigningKeyPrevious),
  };
  if (shouldReset) await resetDb(db);

  const link = createLinkServer({
    ctx,
    // 空数组会关掉 Host 校验；测试要验证 Host 拒绝，所以默认给一个真名。
    // 注意比较时端口会被剥掉（见 normalizeHost），所以这里只写 hostname。
    allowedHosts: allowedHosts ?? ["127.0.0.1"],
    // Origin 白名单复用 CORS_ORIGINS（与生产入口同一条规则）。
    allowedOrigins: env.corsOrigins,
    nonces: new NonceStore(),
    heartbeatMs,
    idleTimeoutMs,
    helloTimeoutMs,
    now,
    lifecycleHooks,
    registry: customRegistry,
  });
  ctx.link = link;
  ctx.instanceId = link.instanceId;

  const app = createApp(ctx);
  const server = await startCloudServer({ app, ctx, link, port: 0, hostname: "127.0.0.1" });

  return {
    ctx,
    link,
    server,
    url: `ws://127.0.0.1:${server.port}/device-link`,
    close: async () => {
      await server.close();
    },
  };
}

export interface OpenOptions {
  token?: string | null;
  url?: string;
  protocols?: string[] | null;
  headers?: Record<string, string>;
  origin?: string;
  /** 不等待 open（用于测试「握手被 HTTP 拒绝」）。 */
  expectReject?: boolean;
}

export interface UpgradeRejection {
  status: number;
  body: string;
}

/**
 * 打开一条真实连接。
 *
 * 返回 `ok` 与拒绝结果二选一：ws 在 upgrade 被 HTTP 拒绝时会把 status code
 * 挂在 `error.message` 里（`Unexpected server response: 403`），而 close code
 * 只在**握手成功之后**才有意义。把两者收敛成一个返回类型，是为了让测试
 * 能明确断言「这是 upgrade 拒绝」还是「这是 close frame」——
 * 任务书要求这两者**不许混为一谈**。
 */
export async function connect(
  h: LinkHarness,
  options: OpenOptions = {},
): Promise<
  | { ok: true; ws: WebSocket; closeInfo: Promise<{ code: number; reason: string }>; next: (predicate?: (frame: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>> }
  | { ok: false; rejection: UpgradeRejection }
> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token !== null) {
    headers.authorization = `Bearer ${options.token ?? ""}`;
  }
  if (options.origin) headers.origin = options.origin;

  const protocols = options.protocols === null ? [] : (options.protocols ?? [REMOTE_WS_SUBPROTOCOL]);

  const ws = new WebSocket(options.url ?? h.url, protocols, { headers });

  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err) => reject(err));
      ws.once("unexpected-response", (_req, res) => reject(new Error(`unexpected-response:${res.statusCode}`)));
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ws.terminate();
    // ws 有两种上报形态：有 `unexpected-response` 监听器时走事件，
    // 否则把状态码拼进 error.message。两种都要能解析出来，
    // 否则「upgrade 被 403」会退化成「status 0」，断言看起来像连接失败。
    const matched = /Unexpected server response: (\d{3})/.exec(message) ?? /unexpected-response:(\d{3})/.exec(message);
    return {
      ok: false,
      rejection: { status: matched ? Number(matched[1]) : 0, body: message },
    };
  }

  const incoming: Record<string, unknown>[] = [];
  const waiters: Array<{ predicate: (frame: Record<string, unknown>) => boolean; resolve: (frame: Record<string, unknown>) => void }> = [];

  ws.on("message", (data: Buffer) => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
    } catch {
      return;
    }
    incoming.push(frame);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(frame)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    }
  });

  const closeInfo = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
  });

  return {
    ok: true,
    ws,
    closeInfo,
    next(predicate = () => true) {
      const existing = incoming.find(predicate);
      if (existing) {
        incoming.splice(incoming.indexOf(existing), 1);
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`timed out waiting for a frame; received ${JSON.stringify(incoming)}`));
        }, 5000);
        timer.unref?.();
        waiters.push({
          predicate,
          resolve: (frame) => {
            clearTimeout(timer);
            incoming.splice(incoming.indexOf(frame), 1);
            resolve(frame);
          },
        });
      });
    },
  };
}

/** 发送一帧并等待对端关闭，返回 close code。 */
export async function sendAndExpectClose(
  ws: WebSocket,
  closeInfo: Promise<{ code: number; reason: string }>,
  frame: unknown,
): Promise<{ code: number; reason: string }> {
  ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  return await closeInfo;
}

/** 等到路由表里出现该设备的连接（握手完成的观测点）。 */
export async function waitForConnection(h: LinkHarness, deviceId: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await h.link.registry.lookupByDevice(deviceId);
    if (info) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no registry entry for device ${deviceId} within ${timeoutMs}ms`);
}
