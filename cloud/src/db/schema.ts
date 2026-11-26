import { sql } from "drizzle-orm";
import {
  bigint,
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
    /**
     * **单条 grant 自身**的版本（协议 §6.5 的 `grants[].epoch`）。
     *
     * 与 `mcp_devices.grant_epoch` 是两个不同字段，**绝不能混用**：
     *
     * | 字段 | 层级 | 何时 +1 | 谁读 |
     * |---|---|---|---|
     * | `mcp_devices.grant_epoch` | 设备级 | 该设备的授权上下文**每次**变化 | `grant_update` 的新旧门槛 |
     * | `mcp_grants.epoch` | 单 grant | **该 grant 自己**的 scope 变化 | 准入时判断「`req` 引用的版本是否仍是当前」 |
     *
     * 默认 1 而不是 0：0 在协议里没有定义语义（Desktop 的 schema 允许 0，
     * 但那只表示「客户端接受」）。从 1 起算，让「这是第几个版本」在
     * 排障时可直接读——0 会被误认为「未初始化」。
     */
    epoch: integer("epoch").notNull().default(1),
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
    // epoch 从 1 起算。约束放在库里而不是只放应用层：这是协议语义
    // （「版本号」），不是一个可以被任意写入的计数器。
    check("mcp_grants_epoch_check", sql`${t.epoch} >= 1`),
  ],
);

// ---------------------------------------------------------------------------
// MCP OAuth（Phase 1.3.1-A，migration 0003）
//
// 这五张表只承载**授权**，不承载**执行**：工具调用能不能做，仍由
// `mcp_grants` + Desktop 的 `grant_ctx` 决定（安全 §2.2）。
//
// 一条贯穿五张表的纪律：**`client_id` 一律不建外键**。理由见
// `mcpOauthClients` 上方的长注释——这不是遗漏，是刻意与 `mcp_grants` 对齐。
// ---------------------------------------------------------------------------

/**
 * 一个已注册的 MCP 客户端（预注册 / CIMD / DCR 三种来源）。
 *
 * **为什么 `clientId` 在其它三张表里没有外键**（Phase 1.3.1-A 的决定）：
 *
 * 1. `mcp_grants.client_id` 本来就没有外键，而它才是**授权的权威记录**。
 *    在新表上建外键会造出「grant 不受约束、session 受约束」的不一致。
 * 2. 这张表是**注册缓存**，不是归属主体：CIMD 的元数据会重新抓取、
 *    预注册项可以下线、DCR 项可以清理，而已经发生的授权不该因此消失。
 * 3. 加 `ON DELETE CASCADE` 会在删除 client 时连带删掉授权码与会话——正是
 *    「为了方便而扩大级联」的典型；加 `ON DELETE RESTRICT` 又会让
 *    「客户端下线」必须先手工按顺序清理，且无法处理历史 grant。
 *
 * 需要的完整性是「session 的 client_id 与它的 grant 一致」，那是一条**跨列**
 * 不变量（要复合外键指向 `mcp_grants(user_id, client_id, resource)`），
 * 代价远大于收益，由应用层在同一次写入里保证。
 */
export const mcpOauthClients = pgTable(
  "mcp_oauth_clients",
  {
    /** 预注册 id / CIMD 的 client metadata URL / DCR 生成的 id。 */
    clientId: text("client_id").primaryKey(),
    /** 同意页展示用。规范要求同意页显示发起方名称。 */
    clientName: text("client_name").notNull(),
    clientUri: text("client_uri"),
    /** 只用于 `<img referrerpolicy="no-referrer">`；**从不抓取**（SSRF）。 */
    logoUri: text("logo_uri"),
    /** 完整 URI 列表，授权请求按**精确字符串**匹配其中一个。 */
    redirectUris: text("redirect_uris").array().notNull(),
    grantTypes: text("grant_types")
      .array()
      .notNull()
      .default(sql`ARRAY['authorization_code', 'refresh_token']::text[]`),
    /** 只支持公共客户端：有 client_secret 就意味着要管密钥轮换与泄露响应。 */
    tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull().default("none"),
    /** pre_registered | cimd | dcr */
    registrationSource: text("registration_source").notNull(),
    /** CIMD 元数据的抓取时刻（预注册项为 NULL）。 */
    metadataFetchedAt: timestamp("metadata_fetched_at", { withTimezone: true, mode: "date" }),
    /** CIMD 缓存到期；到期后必须重新抓取，而不是永久信任首次结果。 */
    metadataCacheExpiresAt: timestamp("metadata_cache_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    /**
     * **唯一 CAS 令牌**（R2，设计 §8.1 / §8.2）：任何改变元数据状态的 UPDATE
     * （成功刷新 / terminal INVALID / mismatch）都必须 `metadata_version + 1`，
     * 并以 `WHERE metadata_version = $旧值` 作为条件——0 行即「别人先写了」，
     * 本次结果一律丢弃。
     *
     * **`mode: "number"`**：SQL 类型是 `BIGINT`，但这是一个从 1 起、每次 +1 的
     * 计数器，永不会接近 `Number.MAX_SAFE_INTEGER`。用 JS `number` 而不是
     * `bigint` 是为了与项目里其它计数（`epoch`、`generation`）保持同一运行时
     * 类型——避免「有的地方是 number、有的地方是 bigint」导致的隐式转换与
     * `===` 比较踩坑。Drizzle 的 `mode: "number"` 在读回时做 `Number(value)`，
     * 因此无论驱动返回字符串还是数字都得到 JS number。
     *
     * **不再是 `metadata_fetched_at`**：R1 用时间戳当令牌，而 terminal INVALID
     * 不推进它，留下「迟到成功复活 INVALID」的窗口（R2 实测 P1）。整数版本
     * 无精度、无时钟回拨耦合。
     */
    metadataVersion: bigint("metadata_version", { mode: "number" }).notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "mcp_oauth_clients_source_check",
      sql`${t.registrationSource} in ('pre_registered', 'cimd', 'dcr')`,
    ),
    check("mcp_oauth_clients_auth_method_check", sql`${t.tokenEndpointAuthMethod} = 'none'`),
    // 用 `cardinality` 而不是设计稿里的 `array_length`：后者对空数组返回 NULL，
    // 而 CHECK 遇到 NULL 视为通过——空 `redirect_uris` 会被静默放行。
    check(
      "mcp_oauth_clients_redirect_uris_check",
      sql`cardinality(${t.redirectUris}) between 1 and 5`,
    ),
    // 只允许本服务实现的两个 grant：写了 `client_credentials` 的注册项
    // 不该能落库，否则「注册成功但永远换不到 token」要等到联调才发现。
    check(
      "mcp_oauth_clients_grant_types_check",
      sql`${t.grantTypes} <@ ARRAY['authorization_code', 'refresh_token']::text[]`,
    ),
    // 版本不得为非正数。**这个 CHECK 只保证 `>= 1`，并不保证单调递增**
    // （把 5 改成 3 仍满足 CHECK）。单调性由应用层的版本 CAS 保证——每条
    // `mcp_oauth_clients` 的 UPDATE 都必须 `metadata_version = metadata_version + 1`
    // 且 WHERE 同时限定 `client_id` 与旧版本（设计 §8.1）。
    check("mcp_oauth_clients_metadata_version_check", sql`${t.metadataVersion} >= 1`),
  ],
);

/**
 * 一次浏览器授权请求的短期状态（10 分钟）。
 *
 * 它是 1.3.0 设计里完全缺失的那块：没有它，「用户登录完成后回到哪个授权请求」
 * 无处可放。`id` 就是 `rid`，出现在 `Location` 与同意页表单里。
 *
 * `state` / `code_challenge` **不存哈希**：它们是客户端的东西，不是我们的凭据。
 * `state` 必须逐字节原样回传，存哈希就还不了。
 */
export const mcpAuthRequests = pgTable(
  "mcp_auth_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: text("client_id").notNull(),
    /** 已与注册值精确匹配过的完整 URI。 */
    redirectUri: text("redirect_uri").notNull(),
    /** 客户端**请求**的 scope；用户只能在此子集内收窄。 */
    scope: text("scope").array().notNull(),
    /** 必须逐字符等于 `MCP_RESOURCE`。 */
    resource: text("resource").notNull(),
    /** 客户端 `state`，原样回传；缺失时为 NULL（不是 `''`，避免与空串混淆）。 */
    state: text("state"),
    codeChallenge: text("code_challenge").notNull(),
    codeChallengeMethod: text("code_challenge_method").notNull().default("S256"),
    /** `sha256("mcp-csrf"‖csrf)`；明文只在渲染的 HTML 里。 */
    csrfHash: text("csrf_hash").notNull(),
    /** `sha256("mcp-browser"‖sid)`；NULL = 尚未绑定（TOFU 首次绑定）。 */
    browserBindingHash: text("browser_binding_hash"),
    /** NULL = 还没登录。登录与否是这一列，不是 Cookie。 */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    /** google | github；NULL = 未选。 */
    provider: text("provider"),
    /** Provider State 的哈希；回调按此反查。回调前为 NULL，因此唯一索引允许多行 NULL。 */
    providerStateHash: text("provider_state_hash"),
    /** Google OIDC nonce 哈希；GitHub 流程为空串。 */
    nonceHash: text("nonce_hash").notNull().default(""),
    /** 一次性 Provider 回调的消费时刻。非空即「这个 PR 已经用掉」。 */
    providerConsumedAt: timestamp("provider_consumed_at", { withTimezone: true, mode: "date" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("mcp_auth_requests_provider_state_uq").on(t.providerStateHash),
    index("mcp_auth_requests_expires_idx").on(t.expiresAt),
    index("mcp_auth_requests_user_idx").on(t.userId),
    check(
      "mcp_auth_requests_provider_check",
      sql`${t.provider} is null or ${t.provider} in ('google', 'github')`,
    ),
    // 只接受 S256：`plain` 等于没有 PKCE（verifier 会随 code 一起泄露）。
    check("mcp_auth_requests_pkce_method_check", sql`${t.codeChallengeMethod} = 'S256'`),
  ],
);

/**
 * MCP 专用授权码（60 秒，一次性）。
 *
 * 与 Desktop 登录的 `oauth_codes` **不共用**：那张表没有 `grant_id` /
 * `scope` / `resource`，三者都是 MCP 授权语义的必需项。
 */
export const mcpAuthCodes = pgTable(
  "mcp_auth_codes",
  {
    /** `sha256("mcp-code"‖code)`；明文只在 302 的 `Location` 里出现一次。 */
    codeHash: text("code_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    /** 同意时 upsert 出的 grant；删 grant 连带删未兑换的码。 */
    grantId: uuid("grant_id")
      .notNull()
      .references(() => mcpGrants.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    /** **用户实际勾选**的子集，可能少于请求的 scope。 */
    scope: text("scope").array().notNull(),
    resource: text("resource").notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // sweep 扫过期码；grant_id 索引给级联删除用（PG 不为外键自动建索引）。
    index("mcp_auth_codes_expires_idx").on(t.expiresAt),
    index("mcp_auth_codes_grant_idx").on(t.grantId),
  ],
);

/**
 * 一次 MCP 授权的**长期身份**（OAuth 会话）。
 *
 * `id` 就是 JWT 的 `sid`：**授权时生成一次，之后永远不变**。这条是
 * 「正常刷新」与「授权被收回」能够区分的唯一依据（设计 §9.6）：
 *
 * - 正常 refresh 只写 `mcp_refresh_tokens`，`sid` 不变 → 旧 Access Token
 *   仍可用到自己 `exp`；
 * - 会话撤销 → `sid` 查不到 → 旧 Access Token 立即失效。
 *
 * `created_at` 与 `absolute_expires_at` 都是**不可变列**：后者只能在 INSERT
 * 时算一次（`created_at + 90d`）。任何 `UPDATE ... SET absolute_expires_at`
 * 都会让「90 天绝对上限」变成「每次刷新续 90 天」。
 */
export const mcpSessions = pgTable(
  "mcp_sessions",
  {
    /** = JWT `sid`。 */
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => mcpGrants.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    /** 本次授权实际授予的 scope（step-up 时更新为 union）。 */
    issuedScope: text("issued_scope").array().notNull(),
    resource: text("resource").notNull(),
    /** **不可变**：90 天的起点。 */
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    /** **不可变** `= created_at + 90d`。 */
    absoluteExpiresAt: timestamp("absolute_expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    /** user_revoke | grant_revoked | refresh_reuse | client_revoke */
    revokedReason: text("revoked_reason"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    ipHash: text("ip_hash").notNull().default(""),
    userAgent: text("user_agent").notNull().default(""),
  },
  (t) => [
    index("mcp_sessions_user_idx").on(t.userId),
    // 「撤销 grant 时找出它的全部 session」是撤销路径的唯一查询。
    index("mcp_sessions_grant_idx").on(t.grantId),
    // 过期判定与清理扫描。
    index("mcp_sessions_absolute_expires_idx").on(t.absoluteExpiresAt),
    check(
      "mcp_sessions_revoked_reason_check",
      sql`${t.revokedReason} is null or ${t.revokedReason} in ('user_revoke', 'grant_revoked', 'refresh_reuse', 'client_revoke', 'client_id_mismatch')`,
    ),
    // 绝对上限必须晚于起点。反过来的行意味着「出生即过期」，
    // 那不该是数据，而该是插入代码里的 bug。
    check("mcp_sessions_absolute_expiry_check", sql`${t.absoluteExpiresAt} > ${t.createdAt}`),
  ],
);

/**
 * 某一代 Refresh Token 凭据。
 *
 * **Session 即族根**：不设 `token_family` 列。`auth_sessions` 需要它是因为
 * 一次登录会派生出多条并行会话；这里一次授权只有一条 Session，
 * family 恒等于 `session_id`，多一列只多一处可能不一致。
 *
 * **关键不变量（数据库强制）**：同一个 `session_id` 最多只能有一条
 * `consumed_at IS NULL` 的行。没有它，并发刷新可以各自「找到当前这代」
 * 并各自签出新 token，于是同一会话同时存在两个有效 refresh token——
 * 重放检测随即失去意义。这条不能只靠应用代码。
 */
export const mcpRefreshTokens = pgTable(
  "mcp_refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 族根。删 Session 即删全部代凭据。 */
    sessionId: uuid("session_id")
      .notNull()
      .references(() => mcpSessions.id, { onDelete: "cascade" }),
    /** `sha256("mcp-refresh"‖token)`；明文不落库。 */
    tokenHash: text("token_hash").notNull().unique(),
    /** 1, 2, 3…；只用于排障与顺序断言，不参与鉴权。 */
    generation: integer("generation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    /** `= min(created_at + 30d, session.absolute_expires_at)`。 */
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    /** 被轮换掉的时刻；NULL = 当前这代。旧行**保留**用于重放检测。 */
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
    /** 下一代的 id。**无外键**：历史链允许独立清理（与 `auth_sessions.replaced_by` 同理）。 */
    replacedBy: uuid("replaced_by"),
    ipHash: text("ip_hash").notNull().default(""),
    userAgent: text("user_agent").notNull().default(""),
  },
  (t) => [
    uniqueIndex("mcp_refresh_tokens_session_generation_uq").on(t.sessionId, t.generation),
    // 「每个会话最多一条有效凭据」——部分唯一索引，是本模型的核心约束。
    uniqueIndex("mcp_refresh_tokens_session_active_uq")
      .on(t.sessionId)
      .where(sql`${t.consumedAt} is null`),
    index("mcp_refresh_tokens_expires_idx").on(t.expiresAt),
    check("mcp_refresh_tokens_generation_check", sql`${t.generation} >= 1`),
    check("mcp_refresh_tokens_expiry_check", sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);
