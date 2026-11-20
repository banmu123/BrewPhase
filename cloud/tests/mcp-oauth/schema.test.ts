import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeTestDb,
  ensureDatabaseOrThrow,
  getTestDb,
  resetDb,
} from "../helpers/db.js";
import { MCP_RESOURCE, seedClient, seedGrant, seedSession, seedUser } from "../helpers/oauth-db.js";

/**
 * Phase 1.3.1-A：五张 MCP OAuth 表的结构。
 *
 * 这一组只问「库里到底有没有这条约束」，不碰任何业务代码——本阶段就是要让
 * 结构本身可验收。每一条断言都对应设计 §10 的一行。
 */

const OAUTH_TABLES = [
  "mcp_oauth_clients",
  "mcp_auth_requests",
  "mcp_auth_codes",
  "mcp_sessions",
  "mcp_refresh_tokens",
];

const handle = await getTestDb();
const sql = handle.sql;

beforeEach(async () => {
  await ensureDatabaseOrThrow();
  await resetDb(handle);
});

afterAll(async () => {
  await closeTestDb();
});

async function columnsOf(table: string) {
  return sql<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]>`
    select column_name, data_type, is_nullable, column_default
      from information_schema.columns
     where table_schema = 'public' and table_name = ${table}
     order by column_name`;
}

async function checkDefs(table: string): Promise<Map<string, string>> {
  const rows = await sql<{ conname: string; def: string }[]>`
    select conname, pg_get_constraintdef(oid) as def
      from pg_constraint
     where conrelid = ${table}::regclass and contype = 'c'`;
  return new Map(rows.map((r) => [r.conname, r.def]));
}

async function indexDefs(table: string): Promise<Map<string, string>> {
  const rows = await sql<{ indexname: string; indexdef: string }[]>`
    select indexname, indexdef from pg_indexes
     where schemaname = 'public' and tablename = ${table}`;
  return new Map(rows.map((r) => [r.indexname, r.indexdef]));
}

describe("五张表与主键", () => {
  it("五张表都存在", async () => {
    const rows = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
       where table_schema = 'public' and table_name = any(${OAUTH_TABLES})
       order by table_name`;
    expect(rows.map((r) => r.table_name)).toEqual([...OAUTH_TABLES].sort());
  });

  it("主键是契约里写死的那一列", async () => {
    const rows = await sql<{ table_name: string; column_name: string }[]>`
      select tc.table_name, kcu.column_name
        from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu
          on kcu.constraint_name = tc.constraint_name
         and kcu.table_schema = tc.table_schema
       where tc.constraint_type = 'PRIMARY KEY'
         and tc.table_schema = 'public'
         and tc.table_name = any(${OAUTH_TABLES})`;
    const byTable = new Map(rows.map((r) => [r.table_name, r.column_name]));
    expect(Object.fromEntries(byTable)).toEqual({
      mcp_oauth_clients: "client_id",
      mcp_auth_requests: "id",
      mcp_auth_codes: "code_hash",
      mcp_sessions: "id",
      mcp_refresh_tokens: "id",
    });
  });

  it("mcp_sessions 不含 1.3.0 那版的可变凭据列", async () => {
    const names = (await columnsOf("mcp_sessions")).map((c) => c.column_name);
    // 这四个列一旦回到 mcp_sessions，就说明「Session 与 Refresh 混表」回来了：
    // refresh_token_hash 全局唯一 + 每轮 UPDATE 同一行 = 90 天任意续命。
    for (const forbidden of ["refresh_token_hash", "token_family", "replaced_by", "expires_at"]) {
      expect(names, `mcp_sessions 不应有 ${forbidden}`).not.toContain(forbidden);
    }
    // 留下的都是身份相关或不可变列。
    expect(names).toEqual(
      expect.arrayContaining([
        "id",
        "user_id",
        "grant_id",
        "client_id",
        "issued_scope",
        "resource",
        "created_at",
        "absolute_expires_at",
        "revoked_at",
        "revoked_reason",
        "last_used_at",
        "ip_hash",
        "user_agent",
      ]),
    );
  });

  it("mcp_refresh_tokens 不维护绝对有效期（那是 Session 的不可变属性）", async () => {
    const names = (await columnsOf("mcp_refresh_tokens")).map((c) => c.column_name);
    expect(names).not.toContain("absolute_expires_at");
    expect(names).toEqual(
      expect.arrayContaining([
        "id",
        "session_id",
        "token_hash",
        "generation",
        "created_at",
        "expires_at",
        "consumed_at",
        "replaced_by",
        "ip_hash",
        "user_agent",
      ]),
    );
  });
});

describe("外键与删除策略", () => {
  it("正好 6 条外键，全部 ON DELETE CASCADE", async () => {
    const rows = await sql<{
      table_name: string;
      column_name: string;
      ref_table: string;
      delete_rule: string;
    }[]>`
      select tc.table_name, kcu.column_name, ccu.table_name as ref_table, rc.delete_rule
        from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu
          on kcu.constraint_name = tc.constraint_name
         and kcu.table_schema = tc.table_schema
        join information_schema.constraint_column_usage ccu
          on ccu.constraint_name = tc.constraint_name
         and ccu.constraint_schema = tc.constraint_schema
        join information_schema.referential_constraints rc
          on rc.constraint_name = tc.constraint_name
         and rc.constraint_schema = tc.constraint_schema
       where tc.constraint_type = 'FOREIGN KEY'
         and tc.table_schema = 'public'
         and tc.table_name = any(${OAUTH_TABLES})
       order by tc.table_name, kcu.column_name`;

    const actual = rows.map(
      (r) => `${r.table_name}.${r.column_name}->${r.ref_table}|${r.delete_rule}`,
    );
    expect(actual).toEqual([
      "mcp_auth_codes.grant_id->mcp_grants|CASCADE",
      "mcp_auth_codes.user_id->users|CASCADE",
      "mcp_auth_requests.user_id->users|CASCADE",
      "mcp_refresh_tokens.session_id->mcp_sessions|CASCADE",
      "mcp_sessions.grant_id->mcp_grants|CASCADE",
      "mcp_sessions.user_id->users|CASCADE",
    ]);
  });

  it("client_id 上一条外键都没有（与 mcp_grants 保持一致）", async () => {
    for (const table of ["mcp_auth_requests", "mcp_auth_codes", "mcp_sessions"]) {
      const rows = await sql<{ constraint_name: string }[]>`
        select tc.constraint_name
          from information_schema.table_constraints tc
          join information_schema.key_column_usage kcu
            on kcu.constraint_name = tc.constraint_name
           and kcu.table_schema = tc.table_schema
         where tc.constraint_type = 'FOREIGN KEY'
           and tc.table_schema = 'public'
           and tc.table_name = ${table}
           and kcu.column_name = 'client_id'`;
      expect(rows, `${table}.client_id 不应有外键`).toHaveLength(0);
    }

    // 同一份数据里 mcp_grants.client_id 也没有外键：两处必须一致，
    // 否则「grant 不受约束、session 受约束」会让人误以为 client 行是必需的。
    const grantsFk = await sql<{ constraint_name: string }[]>`
      select tc.constraint_name
        from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu
          on kcu.constraint_name = tc.constraint_name
         and kcu.table_schema = tc.table_schema
       where tc.constraint_type = 'FOREIGN KEY'
         and tc.table_schema = 'public'
         and tc.table_name = 'mcp_grants'
         and kcu.column_name = 'client_id'`;
    expect(grantsFk).toHaveLength(0);
  });
});

describe("唯一约束与索引", () => {
  it("provider_state_hash 唯一（多行 NULL 允许）", async () => {
    const clientId = await seedClient(sql);
    // 两行都没有 provider_state_hash：唯一索引允许多个 NULL。
    await sql`
      insert into mcp_auth_requests
        (client_id, redirect_uri, scope, resource, code_challenge, csrf_hash, expires_at)
      values (${clientId}, 'https://c.example/cb', ${["records:read"]},
              ${MCP_RESOURCE}, ${"a".repeat(43)}, 'h1', now() + interval '10 minutes')`;
    await sql`
      insert into mcp_auth_requests
        (client_id, redirect_uri, scope, resource, code_challenge, csrf_hash, expires_at)
      values (${clientId}, 'https://c.example/cb', ${["records:read"]},
              ${MCP_RESOURCE}, ${"a".repeat(43)}, 'h2', now() + interval '10 minutes')`;

    await sql`
      insert into mcp_auth_requests
        (client_id, redirect_uri, scope, resource, code_challenge, csrf_hash,
         provider_state_hash, expires_at)
      values (${clientId}, 'https://c.example/cb', ${["records:read"]},
              ${MCP_RESOURCE}, ${"a".repeat(43)}, 'h3', 'PR-hash', now() + interval '10 minutes')`;

    await expect(
      sql`insert into mcp_auth_requests
            (client_id, redirect_uri, scope, resource, code_challenge, csrf_hash,
             provider_state_hash, expires_at)
          values (${clientId}, 'https://c.example/cb', ${["records:read"]},
                  ${MCP_RESOURCE}, ${"a".repeat(43)}, 'h4', 'PR-hash', now() + interval '10 minutes')`,
    ).rejects.toThrow(/mcp_auth_requests_provider_state_uq/);
  });

  it("refresh token：token_hash 唯一、(session_id, generation) 唯一", async () => {
    const userId = await seedUser(sql);
    const grantId = await seedGrant(sql, userId);
    const sessionId = await seedSession(sql, { userId, grantId });

    await sql`
      insert into mcp_refresh_tokens (session_id, token_hash, generation, expires_at)
      values (${sessionId}, 'hash-a', 1, now() + interval '30 days')`;

    // generation 重复
    await expect(
      sql`insert into mcp_refresh_tokens (session_id, token_hash, generation, expires_at)
          values (${sessionId}, 'hash-b', 1, now() + interval '30 days')`,
    ).rejects.toThrow(/mcp_refresh_tokens_session_generation_uq/);

    // token_hash 重复（即使是另一个 session）
    const other = await seedSession(sql, { userId, grantId });
    await expect(
      sql`insert into mcp_refresh_tokens (session_id, token_hash, generation, expires_at)
          values (${other}, 'hash-a', 1, now() + interval '30 days')`,
    ).rejects.toThrow(/mcp_refresh_tokens_token_hash_unique/);
  });

  it("部分唯一索引：UNIQUE(session_id) WHERE consumed_at IS NULL", async () => {
    const defs = await indexDefs("mcp_refresh_tokens");
    const partial = defs.get("mcp_refresh_tokens_session_active_uq");
    expect(partial, "缺少部分唯一索引").toBeTruthy();
    expect(partial).toContain("UNIQUE INDEX");
    expect(partial).toContain("(session_id)");
    // 谓词必须是「未消费」这一条，别写成别的条件（写成 consumed_at IS NOT NULL
    // 就会变成「历史行只能有一条」，与模型完全相反）。
    expect(partial).toMatch(/WHERE .*consumed_at IS NULL/);
  });

  it("查询索引齐全（撤销、过期扫描、级联删除）", async () => {
    const expectations: Array<[string, RegExp]> = [
      ["mcp_auth_requests", /\(expires_at\)/],
      ["mcp_auth_requests", /\(user_id\)/],
      ["mcp_auth_codes", /\(expires_at\)/],
      ["mcp_auth_codes", /\(grant_id\)/],
      ["mcp_sessions", /\(user_id\)/],
      ["mcp_sessions", /\(grant_id\)/],
      ["mcp_sessions", /\(absolute_expires_at\)/],
      ["mcp_refresh_tokens", /\(expires_at\)/],
    ];
    for (const [table, pattern] of expectations) {
      const defs = await indexDefs(table);
      const hit = [...defs.values()].some((def) => pattern.test(def) && def.includes("btree"));
      expect(hit, `${table} 缺少匹配 ${pattern} 的索引`).toBe(true);
    }
  });
});

describe("CHECK 约束", () => {
  it("四张有 CHECK 的表都带了预期的约束名", async () => {
    const expected: Record<string, string[]> = {
      mcp_oauth_clients: [
        "mcp_oauth_clients_source_check",
        "mcp_oauth_clients_auth_method_check",
        "mcp_oauth_clients_redirect_uris_check",
        "mcp_oauth_clients_grant_types_check",
      ],
      mcp_auth_requests: [
        "mcp_auth_requests_provider_check",
        "mcp_auth_requests_pkce_method_check",
      ],
      mcp_sessions: ["mcp_sessions_revoked_reason_check", "mcp_sessions_absolute_expiry_check"],
      mcp_refresh_tokens: [
        "mcp_refresh_tokens_generation_check",
        "mcp_refresh_tokens_expiry_check",
      ],
    };
    for (const [table, names] of Object.entries(expected)) {
      const defs = await checkDefs(table);
      for (const name of names) {
        expect(defs.has(name), `${table} 缺少 ${name}`).toBe(true);
      }
    }
  });

  it("redirect_uris 的数量约束用 cardinality —— 空数组也必须被拒", async () => {
    const defs = await checkDefs("mcp_oauth_clients");
    const def = defs.get("mcp_oauth_clients_redirect_uris_check") ?? "";
    // array_length('{}', 1) 返回 NULL，CHECK 遇 NULL 视为通过 —— 用它会放行空数组。
    expect(def).toContain("cardinality");
    expect(def).not.toContain("array_length");

    await expect(
      sql`insert into mcp_oauth_clients
            (client_id, client_name, redirect_uris, registration_source)
          values ('empty', 'Empty', ${[]}, 'pre_registered')`,
    ).rejects.toThrow(/mcp_oauth_clients_redirect_uris_check/);

    const six = ["https://a/cb", "https://b/cb", "https://c/cb", "https://d/cb", "https://e/cb", "https://f/cb"];
    await expect(
      sql`insert into mcp_oauth_clients
            (client_id, client_name, redirect_uris, registration_source)
          values ('six', 'Six', ${six}, 'pre_registered')`,
    ).rejects.toThrow(/mcp_oauth_clients_redirect_uris_check/);
  });

  it("clients 的域约束真的拦得住非法值", async () => {
    // registration_source
    await expect(
      sql`insert into mcp_oauth_clients (client_id, client_name, redirect_uris, registration_source)
          values ('bad-source', 'X', ${["https://a/cb"]}, 'bogus')`,
    ).rejects.toThrow(/mcp_oauth_clients_source_check/);

    // token_endpoint_auth_method：只允许公共客户端
    await expect(
      sql`insert into mcp_oauth_clients
            (client_id, client_name, redirect_uris, registration_source, token_endpoint_auth_method)
          values ('confidential', 'X', ${["https://a/cb"]}, 'pre_registered', 'client_secret_basic')`,
    ).rejects.toThrow(/mcp_oauth_clients_auth_method_check/);

    // grant_types：不允许未实现的 grant
    await expect(
      sql`insert into mcp_oauth_clients
            (client_id, client_name, redirect_uris, registration_source, grant_types)
          values ('cc', 'X', ${["https://a/cb"]}, 'pre_registered',
                  ${["client_credentials"]})`,
    ).rejects.toThrow(/mcp_oauth_clients_grant_types_check/);

    // 合法的三种来源都能落库
    for (const source of ["pre_registered", "cimd", "dcr"] as const) {
      await seedClient(sql, { registrationSource: source });
    }
  });

  it("auth_requests：只接受 S256，provider 只允许两家", async () => {
    const clientId = await seedClient(sql);
    await expect(
      sql`insert into mcp_auth_requests
            (client_id, redirect_uri, scope, resource, code_challenge, code_challenge_method,
             csrf_hash, expires_at)
          values (${clientId}, 'https://c.example/cb', ${["records:read"]},
                  ${MCP_RESOURCE}, ${"a".repeat(43)}, 'plain', 'h', now() + interval '10 minutes')`,
    ).rejects.toThrow(/mcp_auth_requests_pkce_method_check/);

    await expect(
      sql`insert into mcp_auth_requests
            (client_id, redirect_uri, scope, resource, code_challenge, csrf_hash, provider, expires_at)
          values (${clientId}, 'https://c.example/cb', ${["records:read"]},
                  ${MCP_RESOURCE}, ${"a".repeat(43)}, 'h', 'okta', now() + interval '10 minutes')`,
    ).rejects.toThrow(/mcp_auth_requests_provider_check/);
  });

  it("sessions：revoked_reason 只能是五个已知原因，且绝对期限必须晚于起点", async () => {
    const userId = await seedUser(sql);
    const grantId = await seedGrant(sql, userId);

    await expect(
      sql`insert into mcp_sessions
            (user_id, grant_id, client_id, issued_scope, resource, absolute_expires_at, revoked_reason)
          values (${userId}, ${grantId}, 'chatgpt', ${["records:read"]},
                  ${MCP_RESOURCE}, now() + interval '90 days', 'because')`,
    ).rejects.toThrow(/mcp_sessions_revoked_reason_check/);

    await expect(
      sql`insert into mcp_sessions
            (user_id, grant_id, client_id, issued_scope, resource, absolute_expires_at)
          values (${userId}, ${grantId}, 'chatgpt', ${["records:read"]},
                  ${MCP_RESOURCE}, now() - interval '1 day')`,
    ).rejects.toThrow(/mcp_sessions_absolute_expiry_check/);

    // 五个已知原因都能写（`client_id_mismatch` 由迁移 0004 加入，C3c-3A §5.3）。
    for (const reason of [
      "user_revoke",
      "grant_revoked",
      "refresh_reuse",
      "client_revoke",
      "client_id_mismatch",
    ]) {
      await seedSession(sql, { userId, grantId, revokedAt: new Date(), revokedReason: reason });
    }
  });

  it("refresh tokens：generation >= 1，expires_at 必须晚于 created_at", async () => {
    const userId = await seedUser(sql);
    const grantId = await seedGrant(sql, userId);
    const sessionId = await seedSession(sql, { userId, grantId });

    for (const bad of [0, -1]) {
      await expect(
        sql`insert into mcp_refresh_tokens (session_id, token_hash, generation, expires_at)
            values (${sessionId}, ${`g${bad}`}, ${bad}, now() + interval '30 days')`,
      ).rejects.toThrow(/mcp_refresh_tokens_generation_check/);
    }

    await expect(
      sql`insert into mcp_refresh_tokens (session_id, token_hash, generation, created_at, expires_at)
          values (${sessionId}, 'equal', 2, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).rejects.toThrow(/mcp_refresh_tokens_expiry_check/);
  });
});

describe("默认值与可空性（用真实插入验证，不比对 DDL 文本）", () => {
  it("client 的 grant_types 默认是两个 grant，auth_method 默认 none", async () => {
    const clientId = await seedClient(sql, { clientId: "defaults" });
    const rows = await sql<{ grant_types: string[]; token_endpoint_auth_method: string }[]>`
      select grant_types, token_endpoint_auth_method
        from mcp_oauth_clients where client_id = ${clientId}`;
    expect(rows[0]?.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(rows[0]?.token_endpoint_auth_method).toBe("none");
  });

  it("auth_request 的 code_challenge_method 默认 S256、nonce_hash 默认空串", async () => {
    const clientId = await seedClient(sql);
    const inserted = await sql<{ id: string }[]>`
      insert into mcp_auth_requests
        (client_id, redirect_uri, scope, resource, code_challenge, csrf_hash, expires_at)
      values (${clientId}, 'https://c.example/cb', ${["records:read"]},
              ${MCP_RESOURCE}, ${"a".repeat(43)}, 'h', now() + interval '10 minutes')
      returning id`;
    const id = inserted[0]?.id;
    if (!id) throw new Error("auth request insert returned no row");
    const rows = await sql<{
      code_challenge_method: string;
      nonce_hash: string;
      state: string | null;
      user_id: string | null;
      browser_binding_hash: string | null;
    }[]>`
      select code_challenge_method, nonce_hash, state, user_id, browser_binding_hash
        from mcp_auth_requests where id = ${id}`;
    expect(rows[0]?.code_challenge_method).toBe("S256");
    expect(rows[0]?.nonce_hash).toBe("");
    // 三处「尚未发生」必须是 NULL，不是 ''：'' 会让「还没登录」看起来像
    // 「登录成了空用户」，也会让唯一索引把多行当成同一个值。
    expect(rows[0]?.state).toBeNull();
    expect(rows[0]?.user_id).toBeNull();
    expect(rows[0]?.browser_binding_hash).toBeNull();
  });

  it("session 的审计列默认空串，且 user_id / grant_id / absolute_expires_at 非空", async () => {
    const userId = await seedUser(sql);
    const grantId = await seedGrant(sql, userId);
    const sessionId = await seedSession(sql, { userId, grantId });
    const rows = await sql<{ ip_hash: string; user_agent: string }[]>`
      select ip_hash, user_agent from mcp_sessions where id = ${sessionId}`;
    expect(rows[0]).toEqual({ ip_hash: "", user_agent: "" });
  });
});
