import { authEvents } from "./schema.js";
import type { Database } from "./client.js";

/**
 * 安全事件审计。纪律：
 * - 只记录事件类型与最小化上下文；
 * - 绝不记录明文 Token、OAuth Code、Client Secret 或完整第三方资料；
 * - IP 以 pepper 哈希形式进入 ip_hash，不做明文留存。
 */

export type AuthEventType =
  | "login_success"
  | "login_failed"
  | "refresh_success"
  | "refresh_reuse_detected"
  | "refresh_grace_reuse"
  | "logout"
  | "session_revoked"
  // ---- MCP OAuth（Phase 1.3.1-B）----
  //
  // 与上面那组**分开命名**而不是复用：`refresh_success` 在报表里是
  // 「Desktop 登录活跃度」，混入 MCP 的刷新会让那条曲线失去意义；
  // 而 `session_revoked` 用的是 `auth_sessions` 的 id 空间，与
  // `mcp_sessions.id` 完全不同域，共用一个名字等于让排障者去错表里找。
  //
  // `auth_events.event_type` 是 text 且没有 CHECK，加取值不需要迁移
  // （设计 §10.6：审计复用这张表，只加 event_type 取值，不加列）。
  | "mcp_session_created"
  | "mcp_refresh_success"
  | "mcp_refresh_grace_reuse"
  | "mcp_refresh_reuse_detected"
  | "mcp_session_revoked"
  // ---- MCP 浏览器授权（Phase 1.3.1-C2a）----
  //
  // 这几个事件只记 `rid` / `client_id` / `provider` 与非敏感计数。
  // **绝不**记 Provider State、Nonce、授权码或任何明文凭据：那张表会被
  // 长期保留，而这些东西的有效期只有几分钟——写进去只会变成长期泄露面。
  | "mcp_authorize_started"
  | "mcp_login_provider_started"
  | "mcp_browser_binding_mismatch"
  | "mcp_provider_callback_succeeded"
  | "mcp_provider_callback_failed"
  | "mcp_provider_denied";

export interface AuthEventInput {
  eventType: AuthEventType;
  userId?: string | undefined;
  provider?: "google" | "github" | undefined;
  sessionId?: string | undefined;
  ipHash?: string | undefined;
  detail?: Record<string, unknown>;
}

export async function recordAuthEvent(db: Database, input: AuthEventInput): Promise<void> {
  await db.insert(authEvents).values({
    eventType: input.eventType,
    userId: input.userId ?? null,
    provider: input.provider ?? null,
    sessionId: input.sessionId ?? null,
    ipHash: input.ipHash ?? "",
    detail: input.detail ?? {},
  });
}
