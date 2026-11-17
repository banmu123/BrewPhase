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
  | "session_revoked";

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
