import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { oauthCodes } from "../db/schema.js";
import { sha256Hex, verifyPkce } from "../security/crypto.js";
import { invalidGrant } from "../security/errors.js";
import { createSession, type SessionMeta } from "../sessions/session-service.js";

/**
 * Desktop 授权码交接：POST /oauth/token 的核心逻辑。
 *
 * 一次性授权码的消费是原子的：
 * - SELECT ... FOR UPDATE 锁行后逐项校验（存在 / 未过期 / 未消费 /
 *   redirect_uri 完全一致 / PKCE S256 verifier 匹配）；
 * - 任何一项失败都立即删除授权码（防穷举重试）并返回 invalid_grant；
 * - 校验全部通过后用条件 UPDATE（consumed_at IS NULL）标记消费，
 *   并发竞争时只有一个请求能拿到行，其余得到「已消费」。
 */

export interface TokenExchangeInput {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface TokenExchangeOptions {
  pepper: string;
  sessionTtlSeconds: number;
}

export interface TokenExchangeResult {
  userId: string;
  sessionId: string;
  refreshToken: string;
}

/** 事务内的校验失败信号：先回滚事务，再在事务外烧毁授权码（防穷举重试）。 */
class CodeRejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export async function exchangeAuthorizationCode(
  db: Database,
  options: TokenExchangeOptions,
  input: TokenExchangeInput,
  meta: SessionMeta,
): Promise<TokenExchangeResult> {
  const codeHash = sha256Hex(input.code);

  let outcome: { userId: string; sessionId: string; refreshToken: string };
  try {
    outcome = await db.transaction(async (tx) => {
      const locked = await tx
        .select()
        .from(oauthCodes)
        .where(eq(oauthCodes.codeHash, codeHash))
        .for("update")
        .limit(1);
      const row = locked[0];
      const now = new Date();

      if (!row) {
        throw new CodeRejected("Invalid authorization code");
      }
      if (row.expiresAt.getTime() <= now.getTime()) {
        throw new CodeRejected("Authorization code expired");
      }
      if (row.consumedAt) {
        throw new CodeRejected("Authorization code already consumed");
      }
      if (row.redirectUri !== input.redirectUri) {
        throw new CodeRejected("redirect_uri does not match the authorization request");
      }
      if (!verifyPkce(input.codeVerifier, row.codeChallenge)) {
        throw new CodeRejected("PKCE code_verifier verification failed");
      }

      // 原子消费：并发竞争时只有一个请求能更新成功
      const consumed = await tx
        .update(oauthCodes)
        .set({ consumedAt: now })
        .where(eq(oauthCodes.codeHash, codeHash))
        .returning({ codeHash: oauthCodes.codeHash });
      if (consumed.length === 0) {
        throw new CodeRejected("Authorization code already consumed");
      }

      return await createSession(
        tx,
        { pepper: options.pepper, ttlSeconds: options.sessionTtlSeconds },
        row.userId,
        meta,
      );
    });
  } catch (err) {
    if (err instanceof CodeRejected) {
      // 事务已回滚；在事务外销毁授权码，任何后续尝试都无法重试
      await db.delete(oauthCodes).where(eq(oauthCodes.codeHash, codeHash));
      throw invalidGrant(err.reason);
    }
    throw err;
  }

  return {
    userId: outcome.userId,
    sessionId: outcome.sessionId,
    refreshToken: outcome.refreshToken,
  };
}
