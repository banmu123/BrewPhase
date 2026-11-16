import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * BrewPhase Cloud 数据模型（身份与会话，业务数据永远不进云端）。
 *
 * 约定：
 * - 只存哈希：refresh token / oauth code / 双 State / nonce / IP 一律不存明文。
 * - 身份锚点 = (provider, provider_subject)，相同邮箱绝不自动合并用户。
 * - oauth_codes.transaction_id 是弱引用（无外键）：事务在签发授权码后即删除，
 *   级联外键会连带删掉授权码，因此这里故意不加 FK。
 */

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // active | suspended | deleted
    status: text("status").notNull().default("active"),
    displayName: text("display_name").notNull().default(""),
    avatarUrl: text("avatar_url"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [check("users_status_check", sql`${t.status} in ('active', 'suspended', 'deleted')`)],
);

export const userIdentities = pgTable(
  "user_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // 'google' | 'github'
    provider: text("provider").notNull(),
    // Google OIDC sub / GitHub 数字用户 ID（字符串化）
    providerSubject: text("provider_subject").notNull(),
    // GitHub 邮箱可能隐藏，允许为空；邮箱不是身份锚点
    email: text("email"),
    emailVerified: boolean("email_verified").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("user_identities_provider_subject_uq").on(t.provider, t.providerSubject),
    index("user_identities_user_idx").on(t.userId),
    check("user_identities_provider_check", sql`${t.provider} in ('google', 'github')`),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // SHA-256(pepper 域分隔) 后的 refresh token，明文永不落库
    refreshTokenHash: text("refresh_token_hash").notNull().unique(),
    // rotation 族：同一次登录派生的所有 refresh token 共享；复用旧 token → 撤销整族
    tokenFamily: uuid("token_family").notNull(),
    // 设备管理预留（本阶段不实现），允许为空
    deviceId: uuid("device_id"),
    deviceName: text("device_name").notNull().default(""),
    userAgent: text("user_agent").notNull().default(""),
    ipHash: text("ip_hash").notNull().default(""),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    // rotation 链指针（无外键，历史会话允许独立清理）
    replacedBy: uuid("replaced_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("auth_sessions_family_idx").on(t.tokenFamily),
    index("auth_sessions_user_idx").on(t.userId),
    index("auth_sessions_expires_idx").on(t.expiresAt),
  ],
);

export const oauthTransactions = pgTable(
  "oauth_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // 'google' | 'github'
    provider: text("provider").notNull(),
    // Client State（Desktop 生成）只存哈希；明文经 provider state 参数透传回来
    clientStateHash: text("client_state_hash").notNull(),
    // Provider State（Cloud 生成）只存哈希；与 Client State 完全独立
    providerStateHash: text("provider_state_hash").notNull().unique(),
    codeChallenge: text("code_challenge").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    // Google OIDC nonce（只存哈希）；GitHub 流程为空串
    nonceHash: text("nonce_hash").notNull().default(""),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("oauth_transactions_expires_idx").on(t.expiresAt),
    check("oauth_transactions_provider_check", sql`${t.provider} in ('google', 'github')`),
  ],
);

export const oauthCodes = pgTable("oauth_codes", {
  // 一次性授权码只存 SHA-256，60 秒有效，消费即焚
  codeHash: text("code_hash").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  transactionId: uuid("transaction_id").notNull(),
  // 绑定发起 authorize 时的 PKCE challenge 与 redirect_uri
  codeChallenge: text("code_challenge").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const authEvents = pgTable(
  "auth_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // login_success | login_failed | refresh_success | refresh_reuse_detected |
    // refresh_grace_reuse | logout | session_revoked
    eventType: text("event_type").notNull(),
    userId: uuid("user_id"),
    provider: text("provider"),
    sessionId: uuid("session_id"),
    // IP 只存 pepper 哈希，不做明文留存
    ipHash: text("ip_hash").notNull().default(""),
    detail: jsonb("detail").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("auth_events_type_time_idx").on(t.eventType, t.createdAt),
    index("auth_events_user_idx").on(t.userId),
  ],
);
