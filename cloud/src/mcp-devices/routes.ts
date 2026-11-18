import type { Context } from "hono";
import type { AppContext, AppHono } from "../context.js";
import type { AccessClaims } from "../sessions/jwt.js";
import { createRequireAuth, authenticateUser } from "../routes/auth.js";
import { parseOr400, readJsonObject, readStringFields } from "../routes/body.js";
import { deviceUnauthorized, invalidRequest } from "../security/errors.js";
import { rateLimit } from "../security/rate-limit.js";
import { claimCredentials } from "./claim.js";
import { DEVICE_TOKEN_PATTERN } from "./device-token.js";
import { rotateDevice } from "./rotate.js";
import {
  confirmDevice,
  getDevice,
  listDevices,
  registerDevice,
  resumeDevice,
  revokeDevice,
  suspendDevice,
  suspendDeviceWithToken,
} from "./service.js";
import {
  claimCredentialsSchema,
  confirmDeviceSchema,
  registerDeviceSchema,
  rotateDeviceSchema,
} from "./schemas.js";

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

/**
 * 设备状态变更后的连接清理（协议 §11.2 第 ② 步）。
 *
 * ## 为什么这里必须吞掉异常
 *
 * 调用点在**持久化之后**：DB 里已经是 `suspended` / `revoked` 了。此时
 * 清理失败（registry 内部错误、socket 已消失、甚至 link 层整个不存在）
 * 都不能让 HTTP 响应变成 5xx——客户端会重试，而重试拿到的是「状态已经是
 * 目标值」的幂等成功。两种结果自相矛盾，只会让排障变难。
 *
 * 而且**撤销不依赖清理成功**：真正的安全边界是「每次转发前查设备状态」，
 * 清理只是让在线连接尽快断开。清理失败时那条连接会在下一次心跳超时
 * （≤60s）或下一个请求被拒时收敛——永远不会变成「撤销后还能继续用」。
 */
async function cleanupConnection(
  ctx: AppContext,
  deviceId: string,
  reason: "suspended" | "revoked",
): Promise<void> {
  if (!ctx.link) return;
  try {
    await ctx.link.disconnectDevice(deviceId, reason);
  } catch (err) {
    ctx.logger.warn("link_cleanup_failed", {
      deviceId: deviceId.slice(0, 8),
      reason,
      error: err instanceof Error ? err.name : String(err),
    });
  }
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

  /**
   * 取 `Authorization: Bearer` 的原始值，**不做任何校验**。
   *
   * 只有 `suspend` 用它做「这条凭据属于哪个域」的分流：形态匹配
   * `bp_dev_*` 就按设备凭据处理，否则交给用户 JWT 校验器。
   * 分流本身不是鉴权——两条分支各自完整校验，形态判断只是路由。
   */
  const bearerOf = (c: Context<{ Variables: { authClaims: AccessClaims } }>): string => {
    const header = c.req.header("authorization");
    if (!header || !header.startsWith("Bearer ")) return "";
    return header.slice("Bearer ".length).trim();
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

  /**
   * 暂停：`active → suspended`。
   *
   * 协议 §3.5 明确这条接受**两种**凭据：
   *
   * | 凭据 | 能做什么 | 边界 |
   * |---|---|---|
   * | 用户 Bearer | 暂停**自己名下任意**设备 | 归属靠 `user_id` 过滤，别人的设备一律 404 |
   * | device_token | 只能暂停**它自己那台** | 归属靠「token 反查到的行 id == 路径 id」 |
   *
   * 为什么需要第二种：Desktop 关远程开关时，用户 access token 可能刚好过期。
   * 如果关开关必须等重新登录，Cloud 上就会留下一台「看着在线、实际用户已经关了」
   * 的设备——正是安全运维 §4.0 里 S1/S2 不一致最难解释的那种状态。
   *
   * 顺序（安全运维 §4.1）：**先持久化，后清连接**。清理失败不回滚已写入的
   * `suspended`——反过来的话，一次网络抖动就能让「暂停」静默失效。
   */
  app.post("/mcp-devices/:id/suspend", deviceLimiter, async (c) => {
    const deviceId = deviceIdOf(c);
    const bearer = bearerOf(c);
    const summary = DEVICE_TOKEN_PATTERN.test(bearer)
      ? await suspendDeviceWithToken(ctx.db.db, { deviceToken: bearer, deviceId })
      : await suspendDevice(ctx.db.db, { userId: (await authenticateUser(ctx, c)).userId, deviceId });
    // **持久化之后**才清连接。清理失败只记日志，绝不把 200 变成 500：
    // DB 里已经是 suspended 了，回 5xx 会让客户端重试并看到一个「已暂停」
    // 的成功，反而更困惑。
    await cleanupConnection(ctx, deviceId, "suspended");
    return c.json(summary);
  });

  /**
   * 恢复：`suspended → active`。撤销后不可恢复（协议 §3.5）。
   */
  app.post("/mcp-devices/:id/resume", deviceLimiter, requireAuth, async (c) => {
    const userId = userIdOf(c);
    return c.json(await resumeDevice(ctx.db.db, { userId, deviceId: deviceIdOf(c) }));
  });

  /**
   * 轮换凭据（协议 §3.5 / 生命周期 §11.6）。
   *
   * 只认 `Authorization: Bearer bp_dev_…` —— **不接受用户 Bearer**。
   * 理由：轮换的意义是「证明我还持有旧私钥」，而用户 Bearer 证明不了这一点
   * （它可能在浏览器里、在另一个进程里）。只拿用户 Bearer 就能换钥匙，
   * 等于把设备身份降级成账号密码。
   *
   * 顺序（不可交换）：
   *
   * ```
   * rotateDevice(...)             ← 事务提交：新公钥 + 新 token 落库
   * ctx.link.rotateConnection()   ← 旧连接退场（标记 rotating → 停路由 → bye → 4010）
   * 返回新 device_token
   * ```
   *
   * 为什么清理失败仍然回 200：凭据已经换完，回 5xx 会让客户端以为失败并
   * 重试，而重试必然 401（旧 token 已失效）——最后卡在一个说不清的状态里。
   * 清理失败的真实后果很轻：那条旧连接会在下一次心跳超时（≤60s）收敛，
   * 而它已经**不再可路由**（`lookup` 对 rotating 返回 null）。
   */
  app.post("/mcp-devices/:id/rotate", deviceLimiter, async (c) => {
    const deviceId = deviceIdOf(c);
    const bearer = bearerOf(c);
    // 形态不符 → 401，且**不查库**：这里与握手第 1 步同一套判据，
    // 目的是廉价地挡掉「拿错凭据域」（用户 access token / `bp_mcp_*`）。
    if (!DEVICE_TOKEN_PATTERN.test(bearer)) throw deviceUnauthorized();

    // 用 readJsonObject 而不是 readStringFields：`ts` 是数字，后者会把它丢掉。
    const input = parseOr400(rotateDeviceSchema, await readJsonObject(c));
    const rotated = await rotateDevice(ctx.db.db, {
      deviceId,
      deviceToken: bearer,
      newPublicKey: input.new_public_key,
      ts: input.ts,
      sig: input.sig,
    });

    // 数据库已经提交。从这里开始，旧 token 与旧公钥都失效了。
    if (ctx.link) {
      try {
        await ctx.link.rotateConnection(deviceId);
      } catch (err) {
        ctx.logger.warn("link_rotate_cleanup_failed", {
          deviceId: deviceId.slice(0, 8),
          error: err instanceof Error ? err.name : String(err),
        });
      }
    }

    // 新 token 明文**只在这一次响应里**出现。
    return c.json({
      device_token: rotated.deviceToken,
      expires_at: rotated.expiresAt.getTime(),
    });
  });

  /**
   * 撤销：任意状态 → `revoked`（终态）。
   *
   * **不删行**：设备行是审计历史。**不删 grant**：grant 属于用户
   * （安全运维 §4.1 规则 2）。连接清理（`bye` + close 4003）在这里，
   * 但**必须排在持久化之后**。
   */
  app.delete("/mcp-devices/:id", requireAuth, async (c) => {
    const userId = userIdOf(c);
    const deviceId = deviceIdOf(c);
    const summary = await revokeDevice(ctx.db.db, { userId, deviceId });
    await cleanupConnection(ctx, deviceId, "revoked");
    return c.json(summary);
  });
}
