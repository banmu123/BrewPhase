import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import { createMcpOAuthHarness, seedAuthorizeClient, type McpOAuthHarness } from "../helpers/mcp-oauth-app.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import {
  decodeJwtPayload,
  exchangeCode,
  obtainAuthCode,
  readTokenResponse,
  refreshRows,
  refreshToken,
  type TokenResponse,
} from "../helpers/mcp-token.js";
import { rotateMcpRefreshToken } from "../../src/mcp-oauth/sessions.js";

/**
 * `POST /mcp/oauth/token` 的 `refresh_token` 分支（Phase 1.3.1-C3a）。
 *
 * ## 这一组真正在防的两件事
 *
 * 1. **错误客户端消费别人的 Refresh Token**：绑定校验必须在**改动任何状态
 *    之前**，否则一个 client_id 写错的请求就能把合法客户端的凭据吃掉。
 * 2. **依靠重放把别人的会话撤掉**：宽限外重放会撤销整条 Session。如果绑定
 *    校验排在重放判定之后，错误客户端反而拿到了一个破坏性原语。
 */

const handle = await getTestDb();
let h: McpOAuthHarness;
let tokens: TokenResponse;
let userId: string;
let sessionId: string;

beforeEach(async () => {
  await ensureDatabaseOrThrow();
  await resetDb(handle);
  resetRateLimiter();
  h = await createMcpOAuthHarness();
  await seedAuthorizeClient(handle);

  const fixture = await obtainAuthCode(h);
  userId = fixture.userId;
  tokens = await readTokenResponse(await exchangeCode(h, fixture));
  const rows = await handle.sql<{ id: string }[]>`select id from mcp_sessions`;
  sessionId = rows[0]!.id;
});

afterAll(async () => {
  await closeTestDb();
});

async function sessionRow() {
  const rows = await handle.sql<{
    id: string;
    issued_scope: string[];
    absolute_expires_at: string;
    revoked_at: string | null;
  }[]>`select id, issued_scope, absolute_expires_at::text, revoked_at::text from mcp_sessions`;
  return rows[0]!;
}

describe("正常刷新", () => {
  it("返回新的 access / refresh，token_type 与 expires_in 正确", async () => {
    const res = await refreshToken(h, { refreshToken: tokens.refresh_token });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const next = await readTokenResponse(res);
    expect(next.token_type).toBe("Bearer");
    expect(next.expires_in).toBe(h.env.accessTokenTtlSeconds);
    expect(next.access_token).not.toBe(tokens.access_token);
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(next.scope).toBe("records:read coffee:read");
  });

  it("generation 递增，旧代被消费并指向新代", async () => {
    await refreshToken(h, { refreshToken: tokens.refresh_token });
    const rows = await refreshRows(handle, userId);

    expect(rows.map((row) => row.generation)).toEqual([1, 2]);
    expect(rows[0]!.consumed_at).not.toBeNull();
    expect(rows[1]!.consumed_at).toBeNull();
  });

  it("Session ID 与绝对期限都不变（不可续命）", async () => {
    const before = await sessionRow();
    const next = await readTokenResponse(await refreshToken(h, { refreshToken: tokens.refresh_token }));
    const after = await sessionRow();

    expect(decodeJwtPayload(next.access_token).sid).toBe(before.id);
    expect(before.id).toBe(sessionId);
    // `absolute_expires_at` 是不可变列：刷新只推 `last_used_at`。
    expect(after.absolute_expires_at).toBe(before.absolute_expires_at);
    expect(after.issued_scope).toEqual(["records:read", "coffee:read"]);
  });

  it("连续刷新三代，sid 始终不变", async () => {
    let current = tokens.refresh_token;
    for (let i = 0; i < 3; i += 1) {
      const next = await readTokenResponse(await refreshToken(h, { refreshToken: current }));
      expect(decodeJwtPayload(next.access_token).sid).toBe(sessionId);
      current = next.refresh_token;
    }
    const rows = await refreshRows(handle, userId);
    expect(rows.map((row) => row.generation)).toEqual([1, 2, 3, 4]);
  });
});

describe("旧 Token 与重放", () => {
  it("旧 Refresh Token 立刻再用 → invalid_grant，但**不撤会话**（30 秒宽限）", async () => {
    await refreshToken(h, { refreshToken: tokens.refresh_token });

    const res = await refreshToken(h, { refreshToken: tokens.refresh_token });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
    // 宽限内视为「响应丢了、客户端立即重试」：不能撤销。
    expect((await sessionRow()).revoked_at).toBeNull();
  });

  it("宽限内重放可以继续用新一代正常刷新", async () => {
    const second = await readTokenResponse(await refreshToken(h, { refreshToken: tokens.refresh_token }));
    await refreshToken(h, { refreshToken: tokens.refresh_token }); // 宽限内重放，被拒
    const third = await refreshToken(h, { refreshToken: second.refresh_token });
    expect(third.status).toBe(200);
  });

  it("宽限外重放 → invalid_grant 且撤销整个 Session（服务层可注入时钟）", async () => {
    // 路由层用真实时钟，跨不过 30 秒；这条语义在服务层用注入时钟验证。
    const now = new Date();
    const rotated = await rotateMcpRefreshToken(
      { db: handle.db, pepper: h.env.sessionTokenPepper!, now: () => now },
      { refreshToken: tokens.refresh_token },
    );
    expect(rotated.generation).toBe(2);

    const later = new Date(now.getTime() + 31_000);
    await expect(
      rotateMcpRefreshToken(
        { db: handle.db, pepper: h.env.sessionTokenPepper!, now: () => later },
        { refreshToken: tokens.refresh_token },
      ),
    ).rejects.toMatchObject({ code: "invalid_grant" });

    expect((await sessionRow()).revoked_at).not.toBeNull();
    // 新一代也随之失效（Session 撤销即整族作废）。
    await expect(
      rotateMcpRefreshToken(
        { db: handle.db, pepper: h.env.sessionTokenPepper!, now: () => later },
        { refreshToken: rotated.refreshToken },
      ),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });
});

describe("并发刷新", () => {
  it("两个并发刷新只有一个成功，且只产生一条新一代", async () => {
    const [first, second] = await Promise.all([
      refreshToken(h, { refreshToken: tokens.refresh_token }),
      refreshToken(h, { refreshToken: tokens.refresh_token }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 400]);

    const rows = await refreshRows(handle, userId);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.generation === 2)).toHaveLength(1);
    // 失败的那条没有撤销会话（宽限内）。
    expect((await sessionRow()).revoked_at).toBeNull();
  });
});

describe("状态与绑定", () => {
  it("Grant 已撤销 → invalid_grant", async () => {
    await handle.sql`update mcp_grants set revoked_at = now() where user_id = ${userId}`;
    const res = await refreshToken(h, { refreshToken: tokens.refresh_token });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("用户不活跃 → invalid_grant", async () => {
    await handle.sql`update users set status = 'suspended' where id = ${userId}`;
    const res = await refreshToken(h, { refreshToken: tokens.refresh_token });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("Session 已撤销 → invalid_grant", async () => {
    await handle.sql`update mcp_sessions set revoked_at = now(), revoked_reason = 'user_revoke'`;
    const res = await refreshToken(h, { refreshToken: tokens.refresh_token });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("Session 绝对期限已到 → invalid_grant", async () => {
    // CHECK 要求 `absolute_expires_at > created_at`，所以两个时间点一起前移
    // （模拟一条「90 天前创建、昨天到期」的真实 Session）。
    await handle.sql`
      update mcp_sessions
         set created_at = now() - interval '91 days',
             absolute_expires_at = now() - interval '1 day'`;
    const res = await refreshToken(h, { refreshToken: tokens.refresh_token });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("client_id 不匹配 → 401 invalid_client，且**不消费**真正的 Token", async () => {
    const wrong = await refreshToken(h, {
      refreshToken: tokens.refresh_token,
      clientId: "another-client",
    });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { error: string }).error).toBe("invalid_client");

    // 真正的客户端仍然可以正常刷新——这是「没被消费」最硬的证据。
    const real = await refreshToken(h, { refreshToken: tokens.refresh_token });
    expect(real.status).toBe(200);
    const rows = await refreshRows(handle, userId);
    expect(rows.filter((row) => row.consumed_at === null)).toHaveLength(1);
  });

  it("client_id 不匹配的重放不会撤销合法 Session", async () => {
    await refreshToken(h, { refreshToken: tokens.refresh_token });
    // 旧代已经用掉；错误客户端在这时拿旧代来重放，绝不能触发撤销。
    const wrong = await refreshToken(h, {
      refreshToken: tokens.refresh_token,
      clientId: "another-client",
    });
    expect(wrong.status).toBe(401);
    expect((await sessionRow()).revoked_at).toBeNull();
  });

  it("resource 与 Session 不一致 → invalid_grant（服务层绑定判据）", async () => {
    await expect(
      rotateMcpRefreshToken(
        { db: handle.db, pepper: h.env.sessionTokenPepper!, now: () => new Date() },
        {
          refreshToken: tokens.refresh_token,
          clientId: "test-client",
          resource: "https://other.example/mcp",
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_grant" });

    // 没有被消费。
    const rows = await refreshRows(handle, userId);
    expect(rows[0]!.consumed_at).toBeNull();
  });
});

describe("scope 收窄", () => {
  it("请求 scope 超过已授权 → 400 invalid_scope，且不消费旧代", async () => {
    const res = await refreshToken(h, {
      refreshToken: tokens.refresh_token,
      scope: "records:read canvas:read",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_scope");

    const rows = await refreshRows(handle, userId);
    expect(rows[0]!.consumed_at).toBeNull();
    // 用正确的 scope 仍然能刷新。
    expect((await refreshToken(h, { refreshToken: tokens.refresh_token })).status).toBe(200);
  });

  it("请求 scope 是单值子集 → 新 token 的 scope 就是它", async () => {
    const next = await readTokenResponse(
      await refreshToken(h, { refreshToken: tokens.refresh_token, scope: "coffee:read" }),
    );
    expect(next.scope).toBe("coffee:read");
    expect(decodeJwtPayload(next.access_token).scope).toBe("coffee:read");
    // Session 的 issued_scope 不变：收窄只作用于这一枚 token。
    expect((await sessionRow()).issued_scope).toEqual(["records:read", "coffee:read"]);
  });

  it("未知 scope → 400 invalid_scope（路由层拦）", async () => {
    const res = await refreshToken(h, {
      refreshToken: tokens.refresh_token,
      scope: "records:write",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_scope");
  });

  it("Grant 收窄后，刷新返回的 token scope 同步收窄", async () => {
    await handle.sql`update mcp_grants set scopes = array['records:read'] where user_id = ${userId}`;

    const next = await readTokenResponse(await refreshToken(h, { refreshToken: tokens.refresh_token }));
    expect(next.scope).toBe("records:read");
    expect(decodeJwtPayload(next.access_token).scope).toBe("records:read");
    // Session 的历史快照不动，交集的收窄发生在签发时。
    expect((await sessionRow()).issued_scope).toEqual(["records:read", "coffee:read"]);
  });

  it("Grant 收窄到与 Session 完全不相交 → invalid_grant，且不消费旧代", async () => {
    await handle.sql`update mcp_grants set scopes = array['tags:read'] where user_id = ${userId}`;

    const res = await refreshToken(h, { refreshToken: tokens.refresh_token });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
    const rows = await refreshRows(handle, userId);
    expect(rows[0]!.consumed_at).toBeNull();
  });
});
