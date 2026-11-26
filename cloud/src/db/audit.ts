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
  | "mcp_provider_denied"
  // ---- MCP 用户同意与授权码（Phase 1.3.1-C2b）----
  //
  // 这四个事件回答的是「用户到底同意了哪些权限」。`scope` 是授权内容本身，
  // 可以记；**授权码、CSRF 明文、Provider State、任何 token 都不能记**。
  //
  // `mcp_grant_sync_failed` 单独一个事件：授权已经在数据库里成立，只是没
  // 同步到在线设备。把它混进 `mcp_consent_allowed` 的成功/失败里，会让
  // 「用户授权失败」与「设备暂时离线」看起来是同一件事。
  | "mcp_consent_allowed"
  | "mcp_consent_denied"
  | "mcp_consent_csrf_mismatch"
  /**
   * Consent GET / POST 因**四条件实时复核**失败被拒（设计 §8.3 / §15）。
   *
   * detail：`rid`、`clientId`、`stage`（`consent` = GET / `consent_submit` = POST）、
   * `condition`（1–4）。删行与本事件在**同一事务**提交——拒绝必须真正落库，
   * 不能只留在内存里（§8.5 边界二）。
   */
  | "mcp_consent_metadata_invalid"
  | "mcp_auth_code_issued"
  | "mcp_grant_sync_failed"
  // ---- CIMD 注册与元数据（Phase 1.3.1-C3c-3B-2）----
  //
  // 这组事件由 `cimd-registry` 写入。**审计映射必须走 `reason` 枚举**
  // （`auditEventForCimdFailure`），**禁止**通过匹配错误 detail 文本来决定
  // 事件名——detail 是给人看的、随时可能改写，枚举才是契约。
  | "mcp_cimd_registered"
  | "mcp_cimd_refreshed"
  | "mcp_cimd_fetch_transient"
  | "mcp_cimd_document_invalid"
  | "mcp_cimd_unsupported_client"
  | "mcp_cimd_unsupported_grant"
  | "mcp_cimd_http_invalid"
  | "mcp_cimd_ssrf_blocked"
  | "mcp_cimd_tls_failure"
  | "mcp_cimd_no_store_rejected"
  | "mcp_cimd_client_id_conflict"
  // mismatch 身份失效的**唯一**聚合审计（与撤销同事务提交，设计 §5.3）。
  | "mcp_client_id_mismatch";

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
