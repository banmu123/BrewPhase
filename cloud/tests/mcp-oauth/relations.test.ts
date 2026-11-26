import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import {
  MCP_RESOURCE,
  countRows,
  seedAuthCode,
  seedAuthRequest,
  seedClient,
  seedGrant,
  seedRefreshToken,
  seedSession,
  seedUser,
} from "../helpers/oauth-db.js";

/**
 * Phase 1.3.1-A：关系与删除策略。
 *
 * 本组的存在理由：「撤销」与「删除」在 OAuth 里是两件完全不同的事。
 * 混起来的后果分别是——撤不掉（旧 token 还能用）或删过头（审计记录消失）。
 */

const handle = await getTestDb();
const sql = handle.sql;

beforeEach(async () => {
  await ensureDatabaseOrThrow();
  await resetDb(handle);
});

afterAll(async () => {
  await closeTestDb();
});

describe("用户删除", () => {
  it("连带清掉该用户的授权请求、授权码、会话与全部 refresh 代", async () => {
    const userId = await seedUser(sql);
    const clientId = await seedClient(sql);
    const grantId = await seedGrant(sql, userId, { clientId });
    const sessionId = await seedSession(sql, { userId, grantId, clientId });
    await seedRefreshToken(sql, { sessionId, generation: 1 });
    await seedAuthRequest(sql, { clientId, userId });
    await seedAuthCode(sql, { userId, grantId, clientId });

    await sql`delete from users where id = ${userId}`;

    expect(await countRows(sql, "mcp_auth_requests")).toBe(0);
    expect(await countRows(sql, "mcp_auth_codes")).toBe(0);
    expect(await countRows(sql, "mcp_sessions")).toBe(0);
    expect(await countRows(sql, "mcp_refresh_tokens")).toBe(0);
    // client 是注册信息，不属于某个用户。
    expect(await countRows(sql, "mcp_oauth_clients")).toBe(1);
  });

  it("未登录的授权请求（user_id 为空）不会被用户删除牵连", async () => {
    const clientId = await seedClient(sql);
    const anonymous = await seedAuthRequest(sql, { clientId, userId: null });

    const userId = await seedUser(sql);
    await seedGrant(sql, userId);
    await sql`delete from users where id = ${userId}`;

    const rows = await sql<{ id: string }[]>`select id from mcp_auth_requests`;
    expect(rows.map((r) => r.id)).toEqual([anonymous]);
  });
});

describe("Grant：撤销 ≠ 删除", () => {
  it("删除 grant 会级联删掉它的会话、授权码与 refresh 代，但不碰别的 grant", async () => {
    const userId = await seedUser(sql);
    const clientId = await seedClient(sql);
    // 两条 grant 必须落在不同的 (user, client, resource) 上——`mcp_grants` 的
    // 唯一索引正是这个三元组，用同一个 clientId 造两条会直接撞它。
    const doomed = await seedGrant(sql, userId, { clientId, clientName: "Doomed" });
    const keeper = await seedGrant(sql, userId, { clientId: "claude", clientName: "Keeper" });

    const doomedSession = await seedSession(sql, { userId, grantId: doomed, clientId });
    await seedRefreshToken(sql, { sessionId: doomedSession, generation: 1 });
    await seedAuthCode(sql, { userId, grantId: doomed, clientId });
    const keeperSession = await seedSession(sql, { userId, grantId: keeper, clientId });
    await seedRefreshToken(sql, { sessionId: keeperSession, generation: 1 });

    await sql`delete from mcp_grants where id = ${doomed}`;

    expect(await countRows(sql, "mcp_sessions")).toBe(1);
    expect(await countRows(sql, "mcp_auth_codes")).toBe(0);
    expect(await countRows(sql, "mcp_refresh_tokens")).toBe(1);

    const left = await sql<{ grant_id: string }[]>`select grant_id from mcp_sessions`;
    expect(left[0]?.grant_id).toBe(keeper);
  });

  it("撤销 grant（UPDATE revoked_at）不删除任何会话——撤销靠的是标记", async () => {
    const userId = await seedUser(sql);
    const clientId = await seedClient(sql);
    const grantId = await seedGrant(sql, userId, { clientId });
    const sessionId = await seedSession(sql, { userId, grantId, clientId });
    await seedRefreshToken(sql, { sessionId, generation: 1 });

    await sql`update mcp_grants set revoked_at = now() where id = ${grantId}`;

    // 三张表一行都不少：撤销是可审计的状态，不是删数据。
    expect(await countRows(sql, "mcp_sessions")).toBe(1);
    expect(await countRows(sql, "mcp_refresh_tokens")).toBe(1);

    // 应用层随之撤销会话（未来 1.3.1-B 的撤销事务），行仍然保留。
    await sql`
      update mcp_sessions
         set revoked_at = now(), revoked_reason = 'grant_revoked'
       where grant_id = ${grantId} and revoked_at is null`;
    const rows = await sql<{ revoked_at: Date | null; revoked_reason: string | null }[]>`
      select revoked_at, revoked_reason from mcp_sessions where id = ${sessionId}`;
    expect(rows[0]?.revoked_at).not.toBeNull();
    expect(rows[0]?.revoked_reason).toBe("grant_revoked");
    expect(await countRows(sql, "mcp_sessions")).toBe(1);
  });

  it("同一个 grant 可以有多条会话（多客户端实例 / 多次授权）", async () => {
    const userId = await seedUser(sql);
    const clientId = await seedClient(sql);
    const grantId = await seedGrant(sql, userId, { clientId });

    const sessions = [
      await seedSession(sql, { userId, grantId, clientId }),
      await seedSession(sql, { userId, grantId, clientId }),
      await seedSession(sql, { userId, grantId, clientId }),
    ];
    expect(new Set(sessions).size).toBe(3);
    expect(await countRows(sql, "mcp_sessions")).toBe(3);

    // 按 grant 找全部会话：这正是「撤销 grant 时连带撤会话」要走的查询。
    const rows = await sql<{ count: string }[]>`
      select count(*)::text as count from mcp_sessions where grant_id = ${grantId}`;
    expect(rows[0]?.count).toBe("3");
  });
});

describe("Client 删除：不影响已有的授权数据", () => {
  it("删除 client 行不会带走会话、授权码或授权请求", async () => {
    const userId = await seedUser(sql);
    const clientId = await seedClient(sql);
    const grantId = await seedGrant(sql, userId, { clientId });
    const sessionId = await seedSession(sql, { userId, grantId, clientId });
    await seedRefreshToken(sql, { sessionId, generation: 1 });
    await seedAuthCode(sql, { userId, grantId, clientId });
    await seedAuthRequest(sql, { clientId, userId });

    await sql`delete from mcp_oauth_clients where client_id = ${clientId}`;

    // 若这里出现 0，说明有人给 client_id 加了 CASCADE——那会把「客户端下线」
    // 变成「用户授权历史消失」，是明确不接受的级联。
    expect(await countRows(sql, "mcp_sessions")).toBe(1);
    expect(await countRows(sql, "mcp_auth_codes")).toBe(1);
    expect(await countRows(sql, "mcp_auth_requests")).toBe(1);
    expect(await countRows(sql, "mcp_grants")).toBe(1);
  });

  it("client 行不存在时，其它表仍可写入（没有外键是有意的）", async () => {
    const userId = await seedUser(sql);
    // 完全没建 client 行。
    const grantId = await seedGrant(sql, userId, { clientId: "not-registered" });
    const sessionId = await seedSession(sql, {
      userId,
      grantId,
      clientId: "not-registered",
    });
    await seedRefreshToken(sql, { sessionId, generation: 1 });
    expect(await countRows(sql, "mcp_sessions")).toBe(1);
  });
});

describe("孤儿数据被外键拒绝", () => {
  it("授权码指向不存在的 grant", async () => {
    const userId = await seedUser(sql);
    await expect(
      sql`insert into mcp_auth_codes
            (code_hash, user_id, client_id, grant_id, redirect_uri, code_challenge,
             scope, resource, expires_at)
          values ('orphan-code', ${userId}, 'c', gen_random_uuid(), 'https://c.example/cb',
                  ${"a".repeat(43)}, ${["records:read"]},
                  ${MCP_RESOURCE}, now() + interval '60 seconds')`,
    ).rejects.toThrow(/mcp_auth_codes_grant_id_mcp_grants_id_fk/);
  });

  it("会话指向不存在的 grant", async () => {
    const userId = await seedUser(sql);
    await expect(
      sql`insert into mcp_sessions
            (user_id, grant_id, client_id, issued_scope, resource, absolute_expires_at)
          values (${userId}, gen_random_uuid(), 'c', ${["records:read"]},
                  ${MCP_RESOURCE}, now() + interval '90 days')`,
    ).rejects.toThrow(/mcp_sessions_grant_id_mcp_grants_id_fk/);
  });

  it("授权请求指向不存在的用户", async () => {
    const clientId = await seedClient(sql);
    await expect(
      seedAuthRequest(sql, { clientId, userId: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toThrow(/mcp_auth_requests_user_id_users_id_fk/);
  });
});
