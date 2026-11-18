import type { Context } from "hono";
import type { AppContext, AppHono } from "../context.js";
import type { AccessClaims } from "../sessions/jwt.js";
import { createRequireAuth } from "../routes/auth.js";
import { parseOr400, readStringFields } from "../routes/body.js";
import { invalidRequest } from "../security/errors.js";
import { rateLimit } from "../security/rate-limit.js";
import { claimCredentials } from "./claim.js";
import {
  confirmDevice,
  getDevice,
  listDevices,
  registerDevice,
  resumeDevice,
  revokeDevice,
  suspendDevice,
} from "./service.js";
import { claimCredentialsSchema, confirmDeviceSchema, registerDeviceSchema } from "./schemas.js";

/**
 * Remote MCP 设备管理路由（协议 §3.2–§3.5）。
 *
 * ## 这个文件的三个纪律
 *
 * 1. **只从 `authClaims.userId` 取用户身份**。请求体里的任何 `user_id` 都当
 *    不存在——没有一处代码读它。
 * 2. **不记录请求体**。`claim_secret` / `confirm_code` 就在 body 里，
 *    而 app.ts 的请求日志本来就只记 method/path/status/duration。
 * 3. **错误响应不回显任何秘密**。`errors.ts` 里这些错误的 description 都是
 *    固定文案，且 `claim_mismatch` 不区分「格式不对」与「值不对」。
 */

/**
 * 领取端点的限流额度。
 *
 * Desktop 的轮询是 1 秒一次、最长 300 秒，所以这个端点**必须**能承受
 * 每分钟 60 次以上的合法流量。用 auth 的 30/分钟会让一次正常注册在
 * 第 31 秒被自己限流打断——那不是安全，是 bug。
 *
 * 取 `maxAuth × 10`（默认 300/分钟 ≈ 5 次/秒）：既覆盖 1 秒轮询 + 重试，
 * 又不至于让一个 IP 无限刷。`claim_secret` 是 256 bit，暴力猜测不可行，
 * 这里的限流目的是防资源滥用，不是防猜解。
 */
function claimQuota(maxAuth: number): number {
  return Math.max(120, maxAuth * 10);
}

export function routeMcpDevices(app: AppHono, ctx: AppContext): void {
  const requireAuth = createRequireAuth(ctx);
  const deviceLimiter = rateLimit({
    name: "mcp-devices",
    max: ctx.env.rateLimit.maxAuth,
    windowMs: ctx.env.rateLimit.windowMs,
    trustProxy: ctx.env.trustProxy,
    trustedHops: ctx.env.trustProxyHops,
    maxBuckets: ctx.env.rateLimit.maxBuckets,
  });
  const claimLimiter = rateLimit({
    name: "mcp-devices-claim",
    max: claimQuota(ctx.env.rateLimit.maxAuth),
    windowMs: ctx.env.rateLimit.windowMs,
    trustProxy: ctx.env.trustProxy,
    trustedHops: ctx.env.trustProxyHops,
    maxBuckets: ctx.env.rateLimit.maxBuckets,
  });

  /** 用户身份**只**来自已验证的 JWT；请求体里的 user_id 从不被读取。 */
  const userIdOf = (c: Context<{ Variables: { authClaims: AccessClaims } }>): string =>
    c.get("authClaims").userId;

  /**
   * 取路径里的设备 id。
   *
   * `c.req.param()` 的静态类型是 `string | undefined`（Hono 不知道路由一定带
   * `:id`）。这里显式收口而不是用 `!`：万一将来有人把路由改成不带参数，
   * 得到一条明确的 400，而不是把 `undefined` 拼进 SQL 条件里。
   */
  const deviceIdOf = (c: Context<{ Variables: { authClaims: AccessClaims } }>): string => {
    const id = c.req.param("id");
    if (!id) throw invalidRequest("device id is required");
    return id;
  };

  /** 注册：创建 pending 设备并返回**唯一一次**明文确认码与 claim_secret。 */
  app.post("/mcp-devices/register", deviceLimiter, requireAuth, async (c) => {
    const userId = userIdOf(c);
    const input = parseOr400(registerDeviceSchema, await readStringFields(c));
    const result = await registerDevice(ctx.db.db, {
      userId,
      name: input.name,
      platform: input.platform,
      publicKey: input.public_key,
    });
    return c.json({
      device_id: result.deviceId,
      confirm_code: result.confirmCode,
      claim_secret: result.claimSecret,
      expires_in: result.expiresIn,
    });
  });

  /** 确认：`pending → active`。已 active 幂等返回 200。 */
  app.post("/mcp-devices/:id/confirm", deviceLimiter, requireAuth, async (c) => {
    const userId = userIdOf(c);
    const deviceId = deviceIdOf(c);
    const input = parseOr400(confirmDeviceSchema, await readStringFields(c));
    const result = await confirmDevice(ctx.db.db, {
      userId,
      deviceId,
      confirmCode: input.confirm_code,
    });
    return c.json({ device_id: deviceId, status: result.status });
  });

  /**
   * 一次性领取 device_token。
   *
   * `claim_secret` **只从请求体读**——这里没有 `c.req.query(...)`，
   * 所以「把凭证放进 URL」在这条路径上根本无法表达。
   *
   * 202 = 用户还没确认，请继续轮询（Desktop 侧按可重试处理）。
   */
  app.post("/mcp-devices/:id/credentials", claimLimiter, requireAuth, async (c) => {
    const userId = userIdOf(c);
    const deviceId = deviceIdOf(c);
    const input = parseOr400(claimCredentialsSchema, await readStringFields(c));
    const outcome = await claimCredentials(ctx.db.db, {
      userId,
      deviceId,
      claimSecret: input.claim_secret,
    });
    if (outcome === null) {
      return c.json({ status: "pending", retry_after_ms: 1000 }, 202);
    }
    return c.json({
      device_token: outcome.deviceToken,
      expires_at: outcome.expiresAt.getTime(),
    });
  });

  /** 列表：只返回当前用户的设备，DTO 白名单字段。 */
  app.get("/mcp-devices", requireAuth, async (c) => {
    const userId = userIdOf(c);
    return c.json({ devices: await listDevices(ctx.db.db, userId) });
  });

  /** 详情：别人的设备一律 404（与「不存在」不可区分）。 */
  app.get("/mcp-devices/:id", requireAuth, async (c) => {
    const userId = userIdOf(c);
    return c.json(await getDevice(ctx.db.db, { userId, deviceId: deviceIdOf(c) }));
  });

  /** 暂停：`active → suspended`。 */
  app.post("/mcp-devices/:id/suspend", deviceLimiter, requireAuth, async (c) => {
    const userId = userIdOf(c);
    return c.json(await suspendDevice(ctx.db.db, { userId, deviceId: deviceIdOf(c) }));
  });

  /** 恢复：`suspended → active`。撤销后不可恢复。 */
  app.post("/mcp-devices/:id/resume", deviceLimiter, requireAuth, async (c) => {
    const userId = userIdOf(c);
    return c.json(await resumeDevice(ctx.db.db, { userId, deviceId: deviceIdOf(c) }));
  });

  /**
   * 撤销：任意状态 → `revoked`（终态）。
   *
   * **不删行**：设备行是审计历史。**不删 grant**：grant 属于用户
   * （安全运维 §4.1 规则 2）。WSS 连接清理在 Phase 1.2B。
   */
  app.delete("/mcp-devices/:id", requireAuth, async (c) => {
    const userId = userIdOf(c);
    return c.json(await revokeDevice(ctx.db.db, { userId, deviceId: deviceIdOf(c) }));
  });
}
