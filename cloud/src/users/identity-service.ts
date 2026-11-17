import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { userIdentities } from "../db/schema.js";

/**
 * 身份服务：第三方身份 ↔ BrewPhase 用户的唯一映射。
 *
 * 铁律：
 * - 身份锚点只有 (provider, provider_subject)；
 * - 相同邮箱绝不自动合并两个 BrewPhase 用户；
 * - 本阶段没有「向已有用户追加身份」的流程，身份只在创建新用户时写入，
 *   因此「绑定身份必须经过现有用户身份验证」的不变性天然成立。
 */

export type ProviderName = "google" | "github";

export interface IdentityRow {
  id: string;
  userId: string;
  provider: string;
  providerSubject: string;
  email: string | null;
  emailVerified: boolean;
}

export async function findIdentity(
  db: Database,
  provider: ProviderName,
  providerSubject: string,
): Promise<IdentityRow | undefined> {
  const rows = await db
    .select({
      id: userIdentities.id,
      userId: userIdentities.userId,
      provider: userIdentities.provider,
      providerSubject: userIdentities.providerSubject,
      email: userIdentities.email,
      emailVerified: userIdentities.emailVerified,
    })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.provider, provider),
        eq(userIdentities.providerSubject, providerSubject),
      ),
    )
    .limit(1);
  return rows[0];
}

export interface IdentityListEntry {
  provider: string;
  email: string | null;
  emailVerified: boolean;
  createdAt: Date;
}

export async function listIdentities(db: Database, userId: string): Promise<IdentityListEntry[]> {
  const rows = await db
    .select({
      provider: userIdentities.provider,
      email: userIdentities.email,
      emailVerified: userIdentities.emailVerified,
      createdAt: userIdentities.createdAt,
    })
    .from(userIdentities)
    .where(eq(userIdentities.userId, userId));
  return rows;
}
