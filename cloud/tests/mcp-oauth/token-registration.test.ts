import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import {
  createMcpOAuthHarness,
  seedAuthorizeClient,
  type McpOAuthHarness,
} from "../helpers/mcp-oauth-app.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import { mcpAuthCodeHash } from "../../src/mcp-oauth/authorize-flow.js";
import {
  exchangeCode,
  obtainAuthCode,
  postToken,
  readTokenResponse,
  refreshToken,
  TEST_VERIFIER,
} from "../helpers/mcp-token.js";

/**
 * Token Endpoint × 注册约束（Phase 1.3.1-C3c-3B-3，设计 §8.4）。
 *
 * 三个信任阶段里的「已签发授权码」阶段：
 *
 * - **结构校验**：注册行存在 + `grant_types` 仍含 `authorization_code` →
 *   否则 `invalid_client`；
 * - **不回溯**：不查缓存 INVALID、不比对 `metadata_version`、不复查
 *   `redirect_uri` 是否还在注册集合（签发时刻已判定）；
 * - **refresh gating**：只有显式声明 `refresh_token` 的客户端才拿得到
 *   Refresh Token；未声明的兑换 `unauthorized_client`，且**拒绝发生在
 *   消费 / 轮换任何凭据之前**。
 */

const handle = await getTestDb();

let h: McpOAuthHarness;

beforeEach(async () => {
  await ensureDatabaseOrThrow();
  await resetDb(handle);
  resetRateLimiter();
  h = await createMcpOAuthHarness();
  await seedAuthorizeClient(handle);
});

afterAll(async () => {
  await closeTestDb();
});

async function codeConsumed(codeHash: string): Promise<boolean> {
  const rows = await handle.sql<{ consumed: string | null }[]>`
    select consumed_at::text as consumed from mcp_auth_codes where code_hash = ${codeHash}`;
  return rows[0]?.consumed != null;
}

async function grantRevoked(grantId: string): Promise<boolean> {
  const rows = await handle.sql<{ revoked: string | null }[]>`
    select revoked_at::text as revoked from mcp_grants where id = ${grantId}`;
  return rows[0]?.revoked != null;
}

async function refreshRowState(userId: string): Promise<Array<{ generation: number; consumed: string | null }>> {
  return handle.sql<{ generation: number; consumed: string | null }[]>`
    select t.generation, t.consumed_at::text as consumed
      from mcp_refresh_tokens t
      join mcp_sessions s on s.id = t.session_id
     where s.user_id = ${userId}
     order by t.generation`;
}

async function refreshTokenRowCount(userId: string): Promise<number> {
  const rows = await handle.sql<{ n: string }[]>`
    select count(*)::text as n
      from mcp_refresh_tokens t join mcp_sessions s on s.id = t.session_id
     where s.user_id = ${userId}`;
  return Number(rows[0]?.n ?? 0);
}

async function sessionRows(userId: string): Promise<number> {
  const rows = await handle.sql<{ n: string }[]>`
    select count(*)::text as n from mcp_sessions where user_id = ${userId}`;
  return Number(rows[0]?.n ?? 0);
}

async function setGrantTypes(clientId: string, types: string[]): Promise<void> {
  await handle.sql`
    update mcp_oauth_clients set grant_types = ${types} where client_id = ${clientId}`;
}

async function deleteClientRow(clientId: string): Promise<void> {
  await handle.sql`delete from mcp_oauth_clients where client_id = ${clientId}`;
}

async function setRedirectUris(clientId: string, uris: string[]): Promise<void> {
  await handle.sql`update mcp_oauth_clients set redirect_uris = ${uris} where client_id = ${clientId}`;
}

/** 标成 terminal INVALID（非 mismatch：不动 Grant / Session）。 */
async function markInvalid(clientId: string): Promise<void> {
  await handle.sql`
    update mcp_oauth_clients
       set metadata_cache_expires_at = '1970-01-01T00:00:00.000Z'::timestamptz,
           metadata_version = metadata_version + 1
     where client_id = ${clientId}`;
}

/** 授权码的哈希（断言「失败路径没消费凭据」用）。 */
async function hashOf(code: string): Promise<string> {
  return mcpAuthCodeHash(code);
}

// ---------------------------------------------------------------------------
// 授权码兑换：结构校验 vs 不回溯
// ---------------------------------------------------------------------------

describe("authorization_code 兑换：注册行结构校验（§8.4）", () => {
  it("注册客户端正常兑换（回归：有效 code → 200 + 双凭据）", async () => {
    const fixture = await obtainAuthCode(h);
    const res = await exchangeCode(h, fixture);
    expect(res.status).toBe(200);
    const body = await readTokenResponse(res);
    expect(body.refresh_token).toBeTruthy();
    expect(await sessionRows(fixture.userId)).toBe(1);
  });

  it("注册行缺失 → invalid_client，且授权码不被消费", async () => {
    const fixture = await obtainAuthCode(h);
    await deleteClientRow("test-client");

    const res = await exchangeCode(h, fixture);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client");

    // 失败发生在消费授权码之前：行仍在、未消费（可重试语义由客户端决定）。
    expect(await codeConsumed(await hashOf(fixture.code))).toBe(false);
    expect(await sessionRows(fixture.userId)).toBe(0);
  });

  it("grant_types 不再含 authorization_code → invalid_client，且授权码不被消费", async () => {
    const fixture = await obtainAuthCode(h);
    await setGrantTypes("test-client", ["refresh_token"]);

    const res = await exchangeCode(h, fixture);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client");
    expect(await codeConsumed(await hashOf(fixture.code))).toBe(false);
    expect(await sessionRows(fixture.userId)).toBe(0);
  });

  it("签发后 redirect_uri 被移出注册集合 → 仍按签发时刻策略兑换成功（不回溯）", async () => {
    const fixture = await obtainAuthCode(h);
    await setRedirectUris("test-client", ["https://elsewhere.example/cb"]);

    const res = await exchangeCode(h, fixture);
    expect(res.status).toBe(200);
    const body = await readTokenResponse(res);
    expect(body.access_token).toBeTruthy();
  });

  it("签发后非 mismatch terminal INVALID → 仍可兑换（不查缓存状态、不查版本）", async () => {
    const fixture = await obtainAuthCode(h);
    await markInvalid("test-client");

    const res = await exchangeCode(h, fixture);
    expect(res.status).toBe(200);
    expect((await readTokenResponse(res)).access_token).toBeTruthy();
    // Grant 未被撤销（terminal INVALID 不撤 Grant——§5.2）。
    const grants = await handle.sql<{ id: string }[]>`
      select id from mcp_grants where user_id = ${fixture.userId}`;
    expect(await grantRevoked(grants[0]!.id)).toBe(false);
  });

  it("mismatch 撤销 Grant 后兑换 → invalid_grant（授权码不被消费、不复活 Grant）", async () => {
    const fixture = await obtainAuthCode(h);
    // 模拟 mismatch 事务的结果：该 client 的 Grant 已撤（epoch 已 +1）。
    await handle.sql`
      update mcp_grants
         set revoked_at = now(), epoch = epoch + 1
       where client_id = 'test-client'`;

    const res = await exchangeCode(h, fixture);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");

    expect(await codeConsumed(await hashOf(fixture.code))).toBe(false);
    const grants = await handle.sql<{ id: string; epoch: number }[]>`
      select id, epoch from mcp_grants where user_id = ${fixture.userId}`;
    expect(await grantRevoked(grants[0]!.id)).toBe(true);
    expect(grants[0]?.epoch).toBe(2); // 没有被兑换路径重置 / 复活
    expect(await sessionRows(fixture.userId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// refresh_token gating（§8.4 / §12 #10）
// ---------------------------------------------------------------------------

describe("refresh_token 发放与兑换的 gating（§8.4）", () => {
  it("未声明 refresh_token 的客户端：不返回 refresh_token、库里也没有行", async () => {
    await seedAuthorizeClient(handle, {
      clientId: "code-only",
      grantTypes: ["authorization_code"],
    });
    const fixture = await obtainAuthCode(h, { clientId: "code-only" });
    const res = await exchangeCode(h, fixture);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.access_token).toBeTruthy();
    // 响应里**没有** refresh_token 字段（不是空串、不是 null）。
    expect("refresh_token" in body).toBe(false);

    // 数据库里同样没有创建：响应与库由同一个分支保证，禁止「库里有、响应没有」。
    expect(await refreshTokenRowCount(fixture.userId)).toBe(0);
    expect(await sessionRows(fixture.userId)).toBe(1); // Session 照常创建
  });

  it("声明了 refresh_token 的客户端：完整拿到双凭据（原流程不回退）", async () => {
    const fixture = await obtainAuthCode(h);
    const res = await exchangeCode(h, fixture);
    expect(res.status).toBe(200);
    const body = await readTokenResponse(res);
    expect(body.refresh_token).toBeTruthy();
    expect(await refreshTokenRowCount(fixture.userId)).toBe(1);
  });

  it("未声明 refresh_token → refresh 兑换返回 unauthorized_client，旧代零消费", async () => {
    // 先按「双凭据」客户端正常拿到一枚 refresh token。
    const fixture = await obtainAuthCode(h);
    const first = await readTokenResponse(await exchangeCode(h, fixture));
    expect(await refreshTokenRowCount(fixture.userId)).toBe(1);

    // 客户端注册信息随后收窄（文档刷新 / 运营调整）。
    await setGrantTypes("test-client", ["authorization_code"]);

    const res = await refreshToken(h, { refreshToken: first.refresh_token });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized_client");

    // 拒绝发生在轮换之前：旧代没有被消费，也没有下一代。
    const rows = await refreshRowState(fixture.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.consumed).toBeNull();
  });

  it("注册行缺失 → refresh 兑换 invalid_client，旧代零消费", async () => {
    const fixture = await obtainAuthCode(h);
    const first = await readTokenResponse(await exchangeCode(h, fixture));

    await deleteClientRow("test-client");

    const res = await refreshToken(h, { refreshToken: first.refresh_token });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client");

    const rows = await refreshRowState(fixture.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.consumed).toBeNull();
  });

  it("声明了 refresh_token → 轮换流程照常（旧代消费、新代签发）", async () => {
    const fixture = await obtainAuthCode(h);
    const first = await readTokenResponse(await exchangeCode(h, fixture));

    const res = await refreshToken(h, { refreshToken: first.refresh_token });
    expect(res.status).toBe(200);
    const second = await readTokenResponse(res);
    expect(second.refresh_token).not.toBe(first.refresh_token);

    const rows = await refreshRowState(fixture.userId);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.consumed).toBeTruthy(); // 旧代已消费
    expect(rows[1]?.consumed).toBeNull(); // 新代未消费
  });

  it("失败的 refresh 请求不会写入任何凭据（错误仍是 JSON，不含 token 片段）", async () => {
    const fixture = await obtainAuthCode(h);
    const first = await readTokenResponse(await exchangeCode(h, fixture));
    await setGrantTypes("test-client", ["authorization_code"]);

    const res = await postToken(h, {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: "test-client",
      resource: "https://gateway.example/mcp",
      scope: "unknown:scope",
    });
    // 注册 gating（unauthorized_client）先于 scope 校验命中。
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain(first.refresh_token);
    expect(text).not.toContain(first.access_token);
    expect(await refreshTokenRowCount(fixture.userId)).toBe(1); // 无新增
  });
});

// ---------------------------------------------------------------------------
// 授权码参数仍按原契约（回归锚点）
// ---------------------------------------------------------------------------

describe("兑换的既有结构校验不回退", () => {
  it("PKCE 不符 → invalid_grant（固定文案，与注册校验分开）", async () => {
    const fixture = await obtainAuthCode(h);
    const res = await exchangeCode(h, fixture, { code_verifier: "b".repeat(43) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
    expect(await codeConsumed(await hashOf(fixture.code))).toBe(false);
  });

  it("redirect_uri 兑换参数与签发值不逐字符相等 → invalid_grant", async () => {
    const fixture = await obtainAuthCode(h);
    const res = await exchangeCode(h, fixture, {
      redirect_uri: "https://client.example/callback/",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
  });

  it("同一枚 code 只能兑换一次（第二次 invalid_grant，凭据已消费）", async () => {
    const fixture = await obtainAuthCode(h);
    const first = await exchangeCode(h, fixture);
    expect(first.status).toBe(200);
    const second = await exchangeCode(h, fixture);
    expect(second.status).toBe(400);
    expect(await codeConsumed(await hashOf(fixture.code))).toBe(true);
  });

  it("TEST_VERIFIER 常量仍与 obtainAuthCode 的 challenge 对齐（防漂移）", async () => {
    expect(TEST_VERIFIER).toHaveLength(43);
    const fixture = await obtainAuthCode(h);
    expect(fixture.verifier).toBe(TEST_VERIFIER);
  });
});
