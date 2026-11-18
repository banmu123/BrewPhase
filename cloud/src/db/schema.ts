import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
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

// ---------------------------------------------------------------------------
// Remote MCP：设备与授权（Phase 1.2A）
//
// 两条纪律贯穿这两张表：
// 1. **只存哈希**：confirm_code / claim_secret / device_token 全部只存 SHA-256，
//    明文只在校验或响应的那一刻存在。数据库泄露推不出任何可用凭证。
// 2. **设备与 grant 正交**：两表之间**没有外键、没有级联**。grant 属于 user，
//    设备只是「一台能执行它的机器」。撤销设备不撤 grant，撤销 grant 不删设备
//    （安全运维 §4.1 规则 2）。
// ---------------------------------------------------------------------------

/**
 * 一台已注册的远程设备。
 *
 * 状态机（安全运维 §4.0 S2，合法边只有这五条）：
 *
 * ```
 * pending   → active | revoked
 * active    → suspended | revoked
 * suspended → active | revoked
 * revoked   → （终态，不可恢复）
 * ```
 *
 * **没有 `active → pending`**：重新注册总是新建一行（新 `device_id`），
 * 不复用旧行——否则「已撤销设备复活」与审计历史都会被混淆。
 */
export const mcpDevices = pgTable(
  "mcp_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull().default(""),
    platform: text("platform").notNull().default(""),
    /**
     * 裸 32 字节 Ed25519 公钥的 base64url（43 字符）。
     *
     * **不是 SPKI DER**：DER 是 Desktop 本地格式（44 字节，含 12 字节固定头）。
     * 存裸公钥让「长度必须是 32」这条判据在数据库层就能表达，也省去每次
     * 握手时剥壳。重建公钥在 Cloud 侧拼固定头完成。
     */
    publicKey: text("public_key").notNull(),
    // pending | active | suspended | revoked
    status: text("status").notNull().default("pending"),
    /** SHA-256(confirm_code)。6 位数字，穷举空间只有 10^6，所以必须配次数上限。 */
    confirmCodeHash: text("confirm_code_hash").notNull(),
    /**
     * 已失败的确认码尝试次数。
     *
     * 为什么需要一列而不是靠 auth_events 计数：`pending` 行的有效期只有 300 秒，
     * 在这段时间里必须能**原子地**「+1 并判断是否越线」，否则并发尝试可以
     * 各自读到 4 而都放行第 5 次。
     */
    confirmAttempts: integer("confirm_attempts").notNull().default(0),
    /** SHA-256(claim_secret)。一次性领取的凭据，领取后行内仍保留（供审计对账）。 */
    claimSecretHash: text("claim_secret_hash").notNull(),
    /**
     * `pending` 的有效期（注册后 300 秒）。
     *
     * 注意语义：**它只约束「确认 + 领取」这段窗口**，不是设备寿命。
     * 一个已经领到 token 的 `active` 设备不受它影响——用 expires_at 判断
     * 「设备是否过期」会把所有正常设备在 5 分钟后判死。
     */
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    /** SHA-256(device_token)，明文永不落库。 */
    tokenHash: text("token_hash"),
    /** 一次性领取的时间点。非空即「已领取」，重复领取必须拒绝且不补发。 */
    tokenIssuedAt: timestamp("token_issued_at", { withTimezone: true, mode: "date" }),
    /** device_token 自身的到期时间（30 天）。与 pending 的 expires_at 是两回事。 */
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true, mode: "date" }),
    keyRotatedAt: timestamp("key_rotated_at", { withTimezone: true, mode: "date" }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }),
    /**
     * 设备级授权上下文代数（协议 §6.5 的 `grant_epoch`）。
     *
     * 每次该设备的 grant 快照变化都 +1；Desktop 用它丢弃重复/乱序的
     * `grant_update`。默认 0 是**契约值**，不是「未初始化」。
     */
    grantEpoch: integer("grant_epoch").notNull().default(0),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("mcp_devices_user_idx").on(t.userId),
    // token 哈希唯一：同一明文 token 不可能属于两台设备。
    // Postgres 的唯一索引允许多个 NULL，未领取的设备（token_hash IS NULL）不受影响。
    uniqueIndex("mcp_devices_token_hash_uq").on(t.tokenHash),
    check(
      "mcp_devices_status_check",
      sql`${t.status} in ('pending', 'active', 'suspended', 'revoked')`,
    ),
    check("mcp_devices_grant_epoch_check", sql`${t.grantEpoch} >= 0`),
    check("mcp_devices_confirm_attempts_check", sql`${t.confirmAttempts} >= 0`),
  ],
);

/**
 * 一个 MCP Client 在某用户处的授权（安全 §2.2）。
 *
 * Phase 1.2A 只建表与管理侧最小读取；**OAuth 授权流程属 Phase 1.3**，
 * 所以这里没有 `mcp_oauth_clients` / `mcp_auth_codes`。
 *
 * 为什么现在就要建：Phase 1.2B 的「转发前校验 `grant.user_id == device.user_id`」
 * （ST-1，发布阻断项）必须读它。推迟到 1.3 会让 1.2B 无法完成那条阻断项。
 *
 * **与 `mcp_devices` 没有任何外键**：这是刻意的（见文件头纪律 2）。
 */
export const mcpGrants = pgTable(
  "mcp_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    /** 授权页展示用的人类可读名。 */
    clientName: text("client_name").notNull(),
    /** 远程只读子集；元素取值由 `REMOTE_SCOPES` 约束（应用层校验，不建 CHECK）。 */
    scopes: text("scopes").array().notNull(),
    /** RFC 8707 resource indicator：绑定 Gateway URL，token 不能挪到别处用。 */
    resource: text("resource").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    // 「同一用户 + 同一 client + 同一 resource 只有一条」：撤销后再授权是
    // UPDATE 同一行的 revoked_at，不新增行——否则历史会散成多条。
    uniqueIndex("mcp_grants_user_client_resource_uq").on(t.userId, t.clientId, t.resource),
    index("mcp_grants_user_idx").on(t.userId),
  ],
);
