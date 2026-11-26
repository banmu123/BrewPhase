import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { mcpDevices, mcpGrants } from "../db/schema.js";
import type { ConnectionInfo } from "./connection-registry.js";
import {
  filterScopes,
  isRemoteTool,
  isRetryableRemoteError,
  scopeForTool,
  type RemoteErrorCode,
} from "./schemas.js";

/**
 * 派发前的**准入判定**（协议 §6.2 的 Cloud 侧对应物，安全运维 §4.1.1）。
 *
 * ## 它只做一件事：把「这次派发合法吗」变成一次数据库读取
 *
 * 刻意**不**碰 socket、不碰 registry 的写操作、不碰计数器。原因很实际：
 * 这三样东西都有状态，而状态让「检查」与「执行」之间出现窗口。这里只回答
 * 是/否，窗口留给调用方在**最后一次**检查时压缩到一行 `send`。
 *
 * ## 三个身份必须一致（ST-1）
 *
 * ```
 * 认证用户（JWT sub / 本次调用的 userId）
 *     ==  mcp_grants.user_id
 *     ==  mcp_devices.user_id
 * ```
 *
 * **不能只查一半。** 只查 grant → 「B 的 token + A 的 grant」会通过；
 * 只查 device → 任何人的 grant 都能借 B 的设备读 B 的数据。两张表是**独立**
 * 的两张表（没有外键相连），它们的归属关系只能逐次核对。
 *
 * ## 为什么每次都要重读数据库
 *
 * 以下五样都**不能**作为授权依据，因为它们都是某个更早时刻的快照：
 *
 * | 不能信的东西 | 失效方式 |
 * |---|---|
 * | JWT 里的旧授权快照 | 撤销后 token 仍然有效直到过期 |
 * | `hello_ok.grants` | 那是一次握手的快照，之后可能已撤销 |
 * | `ConnectionRegistry` 里的连接状态 | 它只说明「socket 还在」，不说明「授权还在」 |
 * | Desktop 自报的 `serviceable` | 被限流方自报的状态 |
 * | `req` 帧里的任何字段 | 请求帧里没有身份字段，正是为了不让它成为第二个来源 |
 *
 * 一次派发多两次索引查询，换的是「撤销在下一个请求就生效」。这笔账在任何
 * 规模下都是划算的——只读工具的最大风险就是「撤销后还能读」。
 */

/** Gateway 对外声明的 resource（RFC 8707）。Phase 1.3 的 OAuth 会复用同一个值。 */
export function gatewayResource(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/mcp`;
}

export type DispatchRejection = {
  code: RemoteErrorCode;
  message: string;
  retryable: boolean;
  /**
   * 是否属于**安全事件**（跨用户、已撤销、凭证过期）。
   *
   * 分开的理由：安全事件要进审计并可能触发告警；而 `SCOPE_DENIED` 是
   * 一次正常的授权范围不足，记成安全事件会让真正的异常淹没在噪音里。
   */
  security: boolean;
};

export type DispatchAdmission =
  | {
      ok: true;
      grant: { id: string; userId: string; clientId: string; epoch: number };
      device: { id: string; userId: string };
    }
  | { ok: false; rejection: DispatchRejection };

export type DispatchGuardInput = {
  /** 认证用户（**只能**来自已验证的 MCP JWT `sub`，绝不从请求体读）。 */
  userId: string;
  /** 授权上下文里的 grant id（**只能**来自已认证的授权上下文）。 */
  grantId: string;
  tool: string;
  /** 本次服务对外声明的 resource，用来拒绝「为别的服务签发的授权」。 */
  expectedResource: string;
  /** 已经由 registry 解析出的目标连接（调用方负责 `lookupByUser`）。 */
  connection: Pick<ConnectionInfo, "userId" | "deviceId" | "connectionId" | "rotating">;
  now: Date;
};

const reject = (
  code: RemoteErrorCode,
  message: string,
  security = false,
): DispatchAdmission => ({
  ok: false,
  rejection: { code, message, retryable: isRetryableRemoteError(code), security },
});

export async function admitDispatch(
  db: Database,
  input: DispatchGuardInput,
): Promise<DispatchAdmission> {
  // ---- 1. 连接必须属于这个用户 ----
  //
  // 调用方用 `lookupByUser(userId)` 拿到连接，所以这条在正常路径上恒真。
  // 仍然显式判一次：`lookupByUser` 的语义将来可能变（Phase 1.4 多连接），
  // 而这条判断是「连接不能跨用户借用」的唯一结构保证。
  if (input.connection.userId !== input.userId) {
    return reject("USER_MISMATCH", "connection does not belong to this user", true);
  }

  // ---- 2. rotating 的连接不能派发（ST-3 的另一半）----
  //
  // 放在数据库查询**之前**：这条判据不需要任何 IO，而且它对应的是「凭据已经
  // 换了」——连查库都不该为一条注定被拒的请求花钱。
  if (input.connection.rotating) {
    return reject("DEVICE_UNAUTHORIZED", "device credentials were rotated", true);
  }

  // ---- 3. grant：存在、归属、未撤销、resource 匹配 ----
  const grantRows = await db
    .select({
      id: mcpGrants.id,
      userId: mcpGrants.userId,
      clientId: mcpGrants.clientId,
      scopes: mcpGrants.scopes,
      resource: mcpGrants.resource,
      epoch: mcpGrants.epoch,
      revokedAt: mcpGrants.revokedAt,
    })
    .from(mcpGrants)
    .where(eq(mcpGrants.id, input.grantId));

  const grant = grantRows[0];
  if (!grant) {
    // 不区分「不存在」与「不是你的」：后者会变成一个 grant id 的存在性探针。
    return reject("GRANT_CONTEXT_INVALID", "grant reference is not valid");
  }
  if (grant.userId !== input.userId) {
    // ST-1：A 的 grant + B 的身份。这是最需要留痕的一类，因为它只有两种来源：
    // Cloud 自己的路由 bug，或者有人在伪造调用参数。
    return reject("USER_MISMATCH", "grant does not belong to this user", true);
  }
  if (grant.revokedAt !== null) {
    return reject("GRANT_REVOKED", "this grant has been revoked");
  }
  if (grant.resource !== input.expectedResource) {
    // resource 绑定的意义就在这里：为 staging 签发的授权不能拿到 prod 上花。
    return reject("GRANT_CONTEXT_INVALID", "grant resource does not match this service", true);
  }

  // ---- 4. 工具白名单与 scope ----
  if (!isRemoteTool(input.tool)) {
    return reject("TOOL_NOT_ALLOWED", `tool ${input.tool} is not in the remote surface`);
  }
  const required = scopeForTool(input.tool);
  const scopes = filterScopes(grant.scopes);
  if (required === null || !scopes.includes(required)) {
    return reject("SCOPE_DENIED", `grant does not include ${required ?? "the required scope"}`);
  }

  // ---- 5. 设备：存在、归属、状态、token 寿命 ----
  const deviceRows = await db
    .select({
      id: mcpDevices.id,
      userId: mcpDevices.userId,
      status: mcpDevices.status,
      tokenExpiresAt: mcpDevices.tokenExpiresAt,
    })
    .from(mcpDevices)
    .where(eq(mcpDevices.id, input.connection.deviceId));

  const device = deviceRows[0];
  if (!device) {
    return reject("DEVICE_UNAUTHORIZED", "device no longer exists", true);
  }
  if (device.userId !== input.userId) {
    return reject("USER_MISMATCH", "device does not belong to this user", true);
  }
  if (device.status === "revoked") {
    return reject("DEVICE_REVOKED", "device has been revoked", true);
  }
  if (device.status === "suspended") {
    return reject("DEVICE_SUSPENDED", "device is suspended");
  }
  if (device.status !== "active") {
    // pending：还没完成确认。它本来不该有连接，但状态可能在这一刻被改。
    return reject("DEVICE_UNAUTHORIZED", "device is not active", true);
  }
  // **`token_expires_at`**，不是 `expires_at`（后者是 pending 注册窗口）。
  if (device.tokenExpiresAt === null || device.tokenExpiresAt.getTime() <= input.now.getTime()) {
    return reject("DEVICE_UNAUTHORIZED", "device credential has expired", true);
  }

  return {
    ok: true,
    grant: { id: grant.id, userId: grant.userId, clientId: grant.clientId, epoch: grant.epoch },
    device: { id: device.id, userId: device.userId },
  };
}
