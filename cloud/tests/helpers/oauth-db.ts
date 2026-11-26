import type postgres from "postgres";

/**
 * MCP OAuth 数据层的测试原语（Phase 1.3.1-A）。
 *
 * 这些函数只用**裸 SQL**，不经过任何业务服务——本阶段的被测对象就是表结构本身，
 * 走服务会让「约束到底在不在库里」这个问题被应用代码掩盖。
 */

export const MCP_RESOURCE = "https://gateway.example/mcp";

/**
 * 时间参数一律走 ISO 字符串 + 显式 `::timestamptz`。
 *
 * **不要**把 JS `Date` 直接塞进这个句柄的裸 SQL：`createDb()` 里
 * `drizzle(sql)` 会改写该 postgres.js 实例的序列化表，之后 `Date` 参数会被
 * 当成 `bytea` 处理，报 `Buffer.from(Date)` 的 TypeError。
 * （生产代码里 `bumpGrantEpoch` 早就用 `.toISOString()::timestamptz` 绕开了同一个坑。）
 */
function ts(value: Date | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toISOString();
}

export async function seedUser(sql: postgres.Sql, name = "oauth-user"): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into users (display_name) values (${name}) returning id`;
  const id = rows[0]?.id;
  if (!id) throw new Error("user insert returned no row");
  return id;
}

export async function seedClient(
  sql: postgres.Sql,
  overrides: {
    clientId?: string;
    clientName?: string;
    redirectUris?: string[];
    registrationSource?: "pre_registered" | "cimd" | "dcr";
    /** 故意写非法值时用它绕过默认值，验证 CHECK 真的拦得住。 */
    grantTypes?: string[];
    tokenEndpointAuthMethod?: string;
  } = {},
): Promise<string> {
  const clientId = overrides.clientId ?? `client-${Math.random().toString(36).slice(2, 10)}`;
  const clientName = overrides.clientName ?? "Test Client";
  const redirectUris = overrides.redirectUris ?? ["https://client.example/callback"];
  const registrationSource = overrides.registrationSource ?? "pre_registered";

  // 两条插入路径是刻意的：**不给默认列传值**的这条才能验证数据库默认值
  // （把 'none' / 两个 grant 抄进 SQL 就等于测了自己的常量）。
  const rows = overrides.grantTypes || overrides.tokenEndpointAuthMethod
    ? await sql<{ client_id: string }[]>`
        insert into mcp_oauth_clients
          (client_id, client_name, redirect_uris, registration_source,
           grant_types, token_endpoint_auth_method)
        values (
          ${clientId}, ${clientName}, ${redirectUris}, ${registrationSource},
          ${overrides.grantTypes ?? ["authorization_code", "refresh_token"]},
          ${overrides.tokenEndpointAuthMethod ?? "none"}
        )
        returning client_id`
    : await sql<{ client_id: string }[]>`
        insert into mcp_oauth_clients
          (client_id, client_name, redirect_uris, registration_source)
        values (${clientId}, ${clientName}, ${redirectUris}, ${registrationSource})
        returning client_id`;

  const id = rows[0]?.client_id;
  if (!id) throw new Error("client insert returned no row");
  return id;
}

export async function seedGrant(
  sql: postgres.Sql,
  userId: string,
  overrides: {
    clientId?: string;
    clientName?: string;
    scopes?: string[];
    resource?: string;
  } = {},
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into mcp_grants (user_id, client_id, client_name, scopes, resource)
    values (
      ${userId},
      ${overrides.clientId ?? "chatgpt"},
      ${overrides.clientName ?? "ChatGPT"},
      ${overrides.scopes ?? ["records:read"]},
      ${overrides.resource ?? MCP_RESOURCE}
    )
    returning id`;
  const id = rows[0]?.id;
  if (!id) throw new Error("grant insert returned no row");
  return id;
}

export async function seedSession(
  sql: postgres.Sql,
  opts: {
    userId: string;
    grantId: string;
    clientId?: string;
    issuedScope?: string[];
    /** 默认 90 天后；测试绝对上限时可以传更近的时间点。 */
    absoluteExpiresAt?: Date;
    revokedAt?: Date | null;
    revokedReason?: string | null;
  },
): Promise<string> {
  const absolute =
    opts.absoluteExpiresAt ?? new Date(Date.now() + 90 * 24 * 3600_000);
  const rows = await sql<{ id: string }[]>`
    insert into mcp_sessions
      (user_id, grant_id, client_id, issued_scope, resource, absolute_expires_at,
       revoked_at, revoked_reason)
    values (
      ${opts.userId},
      ${opts.grantId},
      ${opts.clientId ?? "chatgpt"},
      ${opts.issuedScope ?? ["records:read"]},
      ${MCP_RESOURCE},
      ${ts(absolute)}::timestamptz,
      ${ts(opts.revokedAt)}::timestamptz,
      ${opts.revokedReason ?? null}
    )
    returning id`;
  const id = rows[0]?.id;
  if (!id) throw new Error("session insert returned no row");
  return id;
}

export async function seedRefreshToken(
  sql: postgres.Sql,
  opts: {
    sessionId: string;
    tokenHash?: string;
    generation?: number;
    /** 默认 30 天后。 */
    expiresAt?: Date;
    consumedAt?: Date | null;
    replacedBy?: string | null;
  },
): Promise<string> {
  const expires = opts.expiresAt ?? new Date(Date.now() + 30 * 24 * 3600_000);
  const rows = await sql<{ id: string }[]>`
    insert into mcp_refresh_tokens
      (session_id, token_hash, generation, expires_at, consumed_at, replaced_by)
    values (
      ${opts.sessionId},
      ${opts.tokenHash ?? `hash-${Math.random().toString(36).slice(2, 12)}`},
      ${opts.generation ?? 1},
      ${ts(expires)}::timestamptz,
      ${ts(opts.consumedAt)}::timestamptz,
      ${opts.replacedBy ?? null}
    )
    returning id`;
  const id = rows[0]?.id;
  if (!id) throw new Error("refresh token insert returned no row");
  return id;
}

export async function seedAuthRequest(
  sql: postgres.Sql,
  opts: {
    clientId: string;
    userId?: string | null;
    providerStateHash?: string | null;
    expiresAt?: Date;
  },
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into mcp_auth_requests
      (client_id, redirect_uri, scope, resource, code_challenge, csrf_hash,
       provider_state_hash, user_id, expires_at)
    values (
      ${opts.clientId},
      'https://client.example/callback',
      ${["records:read"]},
      ${MCP_RESOURCE},
      ${"a".repeat(43)},
      'csrf-hash',
      ${opts.providerStateHash ?? null},
      ${opts.userId ?? null},
      ${ts(opts.expiresAt ?? new Date(Date.now() + 600_000))}::timestamptz
    )
    returning id`;
  const id = rows[0]?.id;
  if (!id) throw new Error("auth request insert returned no row");
  return id;
}

export async function seedAuthCode(
  sql: postgres.Sql,
  opts: { userId: string; grantId: string; clientId?: string; expiresAt?: Date },
): Promise<string> {
  const codeHash = `code-${Math.random().toString(36).slice(2, 12)}`;
  await sql`
    insert into mcp_auth_codes
      (code_hash, user_id, client_id, grant_id, redirect_uri, code_challenge,
       scope, resource, expires_at)
    values (
      ${codeHash},
      ${opts.userId},
      ${opts.clientId ?? "chatgpt"},
      ${opts.grantId},
      'https://client.example/callback',
      ${"a".repeat(43)},
      ${["records:read"]},
      ${MCP_RESOURCE},
      ${ts(opts.expiresAt ?? new Date(Date.now() + 60_000))}::timestamptz
    )`;
  return codeHash;
}

/** 统计一张表的行数（断言「级联删干净了」用）。 */
export async function countRows(sql: postgres.Sql, table: string): Promise<number> {
  // 表名只来自测试里的常量列表；仍然做一次白名单校验，避免把动态标识符
  // 这条路走成习惯（`sql(table)` 会被当成参数，`from $1` 是语法错误）。
  const allowed = new Set([
    "users",
    "mcp_oauth_clients",
    "mcp_auth_requests",
    "mcp_auth_codes",
    "mcp_sessions",
    "mcp_refresh_tokens",
    "mcp_grants",
  ]);
  if (!allowed.has(table)) throw new Error(`countRows: unexpected table ${table}`);
  const rows = await sql.unsafe<{ count: string }[]>(
    `select count(*)::text as count from "${table}"`,
  );
  return Number(rows[0]?.count ?? "0");
}
