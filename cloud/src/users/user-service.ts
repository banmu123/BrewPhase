import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { userIdentities, users } from "../db/schema.js";
import type { ProviderName } from "./identity-service.js";

/**
 * 用户服务：从已验证的第三方身份找到或创建 BrewPhase 用户。
 * 必须在数据库事务内调用，保证身份唯一约束下的并发正确性。
 *
 * 铁律：
 * - 身份锚点只有 (provider, provider_subject)；
 * - 相同邮箱绝不自动合并两个 BrewPhase 用户（并发冲突后的重读复用也只按
 *   provider + subject 定位，绝不按邮箱）；
 * - 本阶段没有「向已有用户追加身份」的流程，身份只在创建新用户时写入，
 *   因此「绑定身份必须经过现有用户身份验证」的不变性天然成立。
 *
 * 并发首次登录（I-5 整改）：两个流程同时给同一 (provider, subject) 建户时，
 * 后到方的 identity INSERT 会在唯一索引上阻塞到先到方事务结束，然后收到
 * PostgreSQL 23505。此时用 SAVEPOINT 回滚本次创建、按 (provider, subject)
 * 重读并复用先到方创建的 user —— 唯一约束仍是最终防线，冲突不外泄为 500。
 */

export interface UserProfile {
  id: string;
  status: string;
  displayName: string;
  avatarUrl: string | null;
  createdAt: Date;
}

export interface IncomingIdentity {
  provider: ProviderName;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string;
  avatarUrl: string | null;
}

export interface ResolvedUser {
  user: UserProfile;
  identity: { id: string; provider: string; providerSubject: string };
  created: boolean;
}

export async function findUserById(db: Database, userId: string): Promise<UserProfile | undefined> {
  const rows = await db
    .select({
      id: users.id,
      status: users.status,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0];
}

/** 读取 (provider, subject) 对应的身份 + 用户；不存在返回 undefined。 */
async function lookupIdentityWithUser(
  db: Database,
  provider: ProviderName,
  subject: string,
): Promise<ResolvedUser | undefined> {
  const identityRows = await db
    .select({ id: userIdentities.id, userId: userIdentities.userId })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.provider, provider),
        eq(userIdentities.providerSubject, subject),
      ),
    )
    .limit(1);
  const existing = identityRows[0];
  if (!existing) return undefined;

  const user = await findUserById(db, existing.userId);
  if (!user) {
    // 数据完整性破坏（identity 指向不存在的 user）：显式报错而不是静默重建
    throw new Error(`identity ${existing.id} references missing user`);
  }
  return {
    user,
    identity: { id: existing.id, provider, providerSubject: subject },
    created: false,
  };
}

/** 精确识别 (provider, provider_subject) 唯一索引冲突（PostgreSQL 23505）。 */
function isProviderSubjectUniqueViolation(err: unknown): boolean {
  // Drizzle 会把驱动错误包进 DrizzleQueryError（原始 pg 错误在 cause 链上），逐层解包；
  // postgres.js 的 pg 错误字段为 snake_case（constraint_name），兼容其他驱动的 constraint 字段
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const e = current as {
      code?: string;
      constraint?: string;
      constraint_name?: string;
      cause?: unknown;
    };
    const constraint = e.constraint_name ?? e.constraint;
    if (
      e.code === "23505" &&
      typeof constraint === "string" &&
      constraint.includes("provider_subject")
    ) {
      return true;
    }
    current = e.cause ?? null;
  }
  return false;
}

/**
 * 查找或创建 (provider, subject) 对应的用户。
 * - 已存在：返回同一用户（同一 Provider 再次登录命中同一身份）。
 * - 不存在：创建全新 users 行 + user_identities 行（即使邮箱与既有用户相同也不合并）。
 * - 并发创建同一身份：23505 冲突方回滚到 SAVEPOINT 后重读复用先到方的用户。
 */
export async function findOrCreateUserWithIdentity(
  db: Database,
  identity: IncomingIdentity,
): Promise<ResolvedUser> {
  // 快路径：身份已存在
  const existing = await lookupIdentityWithUser(db, identity.provider, identity.subject);
  if (existing) return existing;

  try {
    // 创建路径放在嵌套事务（当外层已有事务时即为 SAVEPOINT）：
    // 23505 只回滚创建本身，不会污染外层事务的后续语句
    return await db.transaction(async (tx) => {
      const insertedUsers = await tx
        .insert(users)
        .values({
          status: "active",
          displayName: identity.displayName,
          avatarUrl: identity.avatarUrl,
        })
        .returning({
          id: users.id,
          status: users.status,
          displayName: users.displayName,
          avatarUrl: users.avatarUrl,
          createdAt: users.createdAt,
        });
      const user = insertedUsers[0];
      if (!user) throw new Error("failed to insert user");

      const insertedIdentities = await tx
        .insert(userIdentities)
        .values({
          userId: user.id,
          provider: identity.provider,
          providerSubject: identity.subject,
          email: identity.email,
          emailVerified: identity.emailVerified,
        })
        .returning({ id: userIdentities.id });
      const identityRow = insertedIdentities[0];
      if (!identityRow) throw new Error("failed to insert identity");

      return {
        user,
        identity: {
          id: identityRow.id,
          provider: identity.provider,
          providerSubject: identity.subject,
        },
        created: true,
      };
    });
  } catch (err) {
    if (!isProviderSubjectUniqueViolation(err)) throw err;
    // 并发首次登录：唯一索引阻塞结束后胜者已提交，重读复用（仍按 provider+subject，不按邮箱）
    const winner = await lookupIdentityWithUser(db, identity.provider, identity.subject);
    if (!winner) throw err;
    return winner;
  }
}
