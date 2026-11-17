import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { recordAuthEvent } from "../db/audit.js";
import { authSessions, users } from "../db/schema.js";
import { invalidToken } from "../security/errors.js";
import {
  REFRESH_REUSE_GRACE_MS,
  generateRefreshToken,
  refreshTokenHash,
} from "./refresh-token.js";

/**
 * 会话服务：Refresh Token Rotation + Token Family 重放检测。
 *
 * 全部状态变更在数据库事务 + SELECT ... FOR UPDATE 行锁内完成，保证：
 * - 同一个 refresh token 不可能成功刷新两次；
 * - 并发刷新同一个 token：恰好一个成功，另一个得到「已被轮换」错误，
 *   且不触发整族撤销（宽限窗口内）；
 * - 宽限窗口外的旧 token 重放 → 撤销整个 token family。
 */

export interface SessionMeta {
  userAgent: string;
  ipHash: string;
  deviceId?: string | undefined;
  deviceName?: string | undefined;
}

export interface CreatedSession {
  sessionId: string;
  refreshToken: string;
  userId: string;
}

export async function createSession(
  db: Database,
  options: { pepper: string; ttlSeconds: number },
  userId: string,
  meta: SessionMeta,
): Promise<CreatedSession> {
  const refreshToken = generateRefreshToken();
  const family = crypto.randomUUID();
  const now = new Date();
  const inserted = await db
    .insert(authSessions)
    .values({
      userId,
      refreshTokenHash: refreshTokenHash(options.pepper, refreshToken),
      tokenFamily: family,
      deviceId: meta.deviceId ?? null,
      deviceName: meta.deviceName ?? "",
      userAgent: meta.userAgent,
      ipHash: meta.ipHash,
      expiresAt: new Date(now.getTime() + options.ttlSeconds * 1000),
    })
    .returning({ id: authSessions.id });
  const row = inserted[0];
  if (!row) throw new Error("failed to create session");
  return { sessionId: row.id, refreshToken, userId };
}

async function revokeFamily(
  db: Database,
  family: string,
): Promise<{ revokedCount: number; sessionIds: string[] }> {
  const rows = await db
    .update(authSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(authSessions.tokenFamily, family), isNull(authSessions.revokedAt)))
    .returning({ id: authSessions.id });
  return { revokedCount: rows.length, sessionIds: rows.map((r) => r.id) };
}

export interface RotatedSession {
  userId: string;
  sessionId: string;
  refreshToken: string;
}

/**
 * 事务内的拒绝信号：事务正常提交（已落库的撤销保持生效），
 * 事件审计与错误抛出在事务外完成，避免被回滚吞掉。
 */
type RotationOutcome =
  | { kind: "rotated"; userId: string; sessionId: string; refreshToken: string; family: string; replacedSessionId: string; ipHash: string }
  | { kind: "grace_reuse"; userId: string; sessionId: string; family: string; sinceRevokeMs: number; ipHash: string }
  | { kind: "reuse_detected"; userId: string; sessionId: string; family: string; revokedCount: number; ipHash: string }
  | { kind: "inactive"; userId: string };

/**
 * 用旧 refresh token 换新 refresh token（rotation）。
 * 抛出的 AppError 携带安全语义，由路由层统一转成 401。
 */
export async function rotateRefreshToken(
  db: Database,
  options: { pepper: string; ttlSeconds: number },
  rawToken: string,
  meta: SessionMeta,
): Promise<RotatedSession> {
  const hash = refreshTokenHash(options.pepper, rawToken);

  const outcome: RotationOutcome = await db.transaction(async (tx) => {
    const locked = await tx
      .select()
      .from(authSessions)
      .where(eq(authSessions.refreshTokenHash, hash))
      .for("update")
      .limit(1);
    const old = locked[0];
    if (!old) {
      throw invalidToken("Unknown refresh token");
    }

    const now = new Date();

    if (old.revokedAt) {
      const sinceRevokeMs = now.getTime() - old.revokedAt.getTime();
      const isRecentRotation = old.replacedBy !== null && sinceRevokeMs <= REFRESH_REUSE_GRACE_MS;
      if (isRecentRotation) {
        // 并发重试：拒绝但不撤销整族（正常客户端不应被踢下线）
        return {
          kind: "grace_reuse",
          userId: old.userId,
          sessionId: old.id,
          family: old.tokenFamily,
          sinceRevokeMs,
          ipHash: meta.ipHash,
        };
      }
      // 宽限窗口外的重放：判定为 token 被盗用，撤销整个 family（随事务提交持久化）
      const revoked = await revokeFamily(tx, old.tokenFamily);
      return {
        kind: "reuse_detected",
        userId: old.userId,
        sessionId: old.id,
        family: old.tokenFamily,
        revokedCount: revoked.revokedCount,
        ipHash: meta.ipHash,
      };
    }

    if (old.expiresAt.getTime() <= now.getTime()) {
      throw invalidToken("Refresh token expired");
    }

    const userRows = await tx
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, old.userId))
      .limit(1);
    const user = userRows[0];
    if (!user || user.status !== "active") {
      throw invalidToken("Account is not active");
    }

    const refreshToken = generateRefreshToken();
    const inserted = await tx
      .insert(authSessions)
      .values({
        userId: old.userId,
        refreshTokenHash: refreshTokenHash(options.pepper, refreshToken),
        tokenFamily: old.tokenFamily,
        deviceId: old.deviceId,
        deviceName: old.deviceName,
        userAgent: meta.userAgent,
        ipHash: meta.ipHash,
        expiresAt: new Date(now.getTime() + options.ttlSeconds * 1000),
      })
      .returning({ id: authSessions.id });
    const created = inserted[0];
    if (!created) throw new Error("failed to rotate session");

    await tx
      .update(authSessions)
      .set({ revokedAt: now, replacedBy: created.id, lastUsedAt: now })
      .where(eq(authSessions.id, old.id));

    return {
      kind: "rotated",
      userId: old.userId,
      sessionId: created.id,
      refreshToken,
      family: old.tokenFamily,
      replacedSessionId: old.id,
      ipHash: meta.ipHash,
    };
  });

  // 事务已提交，审计事件在事务外写入（不会被回滚）
  if (outcome.kind === "grace_reuse") {
    await recordAuthEvent(db, {
      eventType: "refresh_grace_reuse",
      userId: outcome.userId,
      sessionId: outcome.sessionId,
      ipHash: outcome.ipHash,
      detail: { family: outcome.family, sinceRevokeMs: outcome.sinceRevokeMs },
    });
    throw invalidToken("Refresh token already rotated by a concurrent request");
  }
  if (outcome.kind === "reuse_detected") {
    await recordAuthEvent(db, {
      eventType: "refresh_reuse_detected",
      userId: outcome.userId,
      sessionId: outcome.sessionId,
      ipHash: outcome.ipHash,
      detail: { family: outcome.family, revokedCount: outcome.revokedCount },
    });
    await recordAuthEvent(db, {
      eventType: "session_revoked",
      userId: outcome.userId,
      sessionId: outcome.sessionId,
      ipHash: outcome.ipHash,
      detail: {
        family: outcome.family,
        revokedCount: outcome.revokedCount,
        reason: "reuse_detected",
      },
    });
    throw invalidToken("Refresh token reuse detected; session family revoked");
  }

  await recordAuthEvent(db, {
    eventType: "refresh_success",
    userId: outcome.userId,
    sessionId: outcome.sessionId,
    ipHash: outcome.ipHash,
    detail: { family: outcome.family, replacedSessionId: outcome.replacedSessionId },
  });

  return {
    userId: outcome.userId,
    sessionId: outcome.sessionId,
    refreshToken: outcome.refreshToken,
  };
}

export interface LogoutResult {
  found: boolean;
  revokedCount: number;
}

/** 退出登录：撤销该 refresh token 所属的整个 token family。未知 token 幂等返回。 */
export async function logoutByRefreshToken(
  db: Database,
  options: { pepper: string },
  rawToken: string,
  meta: SessionMeta,
): Promise<LogoutResult> {
  const hash = refreshTokenHash(options.pepper, rawToken);
  return await db.transaction(async (tx) => {
    const locked = await tx
      .select()
      .from(authSessions)
      .where(eq(authSessions.refreshTokenHash, hash))
      .for("update")
      .limit(1);
    const row = locked[0];
    if (!row) return { found: false, revokedCount: 0 };

    if (row.revokedAt) {
      // 已经失效（例如已被轮换或撤销）：幂等成功，不重复审计
      return { found: true, revokedCount: 0 };
    }

    const revoked = await revokeFamily(tx, row.tokenFamily);
    await recordAuthEvent(tx, {
      eventType: "logout",
      userId: row.userId,
      sessionId: row.id,
      ipHash: meta.ipHash,
      detail: { family: row.tokenFamily, revokedCount: revoked.revokedCount },
    });
    await recordAuthEvent(tx, {
      eventType: "session_revoked",
      userId: row.userId,
      sessionId: row.id,
      ipHash: meta.ipHash,
      detail: { family: row.tokenFamily, revokedCount: revoked.revokedCount, reason: "logout" },
    });
    return { found: true, revokedCount: revoked.revokedCount };
  });
}
