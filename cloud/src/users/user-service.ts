import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { userIdentities, users } from "../db/schema.js";
import type { ProviderName } from "./identity-service.js";

/**
 * 用户服务：从已验证的第三方身份找到或创建 BrewPhase 用户。
 * 必须在数据库事务内调用，保证身份唯一约束下的并发正确性。
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

/**
 * 查找或创建（provider, subject) 对应的用户。
 * - 已存在：返回同一用户（同一 Provider 再次登录命中同一身份）。
 * - 不存在：创建全新 users 行 + user_identities 行（即使邮箱与既有用户相同也不合并）。
 */
export async function findOrCreateUserWithIdentity(
  db: Database,
  identity: IncomingIdentity,
): Promise<ResolvedUser> {
  const existingIdentityRows = await db
    .select({ id: userIdentities.id, userId: userIdentities.userId })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.provider, identity.provider),
        eq(userIdentities.providerSubject, identity.subject),
      ),
    )
    .limit(1);

  const existingIdentity = existingIdentityRows[0];
  if (existingIdentity) {
    const user = await findUserById(db, existingIdentity.userId);
    if (!user) {
      // 数据完整性破坏（identity 指向不存在的 user）：显式报错而不是静默重建
      throw new Error(`identity ${existingIdentity.id} references missing user`);
    }
    return {
      user,
      identity: {
        id: existingIdentity.id,
        provider: identity.provider,
        providerSubject: identity.subject,
      },
      created: false,
    };
  }

  const insertedUsers = await db
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

  const insertedIdentities = await db
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
    identity: { id: identityRow.id, provider: identity.provider, providerSubject: identity.subject },
    created: true,
  };
}
