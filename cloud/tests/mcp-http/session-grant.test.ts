import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import { signMcpAccessToken } from "../../src/mcp-oauth/tokens.js";
import {
  createMcpHttpHarness,
  jsonBody,
  modernEnvelope,
  modernRequest,
  obtainMcpBearer,
  type McpHttpHarness,
} from "../helpers/mcp-http.js";

/**
 * C. Session / Grant 实时回查（Phase 1.3.2，设计 §8.3 / 任务书 §5.2–§5.3）。
 *
 * 全部真实 PostgreSQL：Bearer 走完整 OAuth 流程拿真 token，撤销 / 收窄 /
 * 归属不符都在真表上做，断言「下一次请求立即失败」——**没有进程缓存**。
 *
 * 回查链（每跳都核对归属）：`sub(JWT) → sid(JWT) → mcp_sessions → grant_id →
 * mcp_grants`。Session 层失败 → 401（设计 §9.5：sid 查不到就是 401）；
 * Grant 层失败 → 403（§8.5：grant 回查失败即 403）。
 */

const handle = await getTestDb();

let h: McpHttpHarness;

beforeEach(async () => {
  await ensureDatabaseOrThrow();
  await resetDb(handle);
  h = await createMcpHttpHarness();
});

afterAll(async () => {
  await closeTestDb();
});

function discover(token: string): Request {
  return modernRequest(
    { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: modernEnvelope() } },
    { token },
  );
}

async function expectStatus(token: string, status: number): Promise<Response> {
  const res = await h.app.request(discover(token));
  expect(res.status, `expected ${status} for token`).toBe(status);
  return res;
}

async function sessionIdOf(userId: string): Promise<string> {
  const rows = await handle.sql<{ id: string }[]>`
    select id from mcp_sessions where user_id = ${userId} order by created_at desc limit 1`;
  const id = rows[0]?.id;
  if (!id) throw new Error("no mcp_sessions row for user");
  return id;
}

describe("Session 实时回查（sid 层，失败 → 401）", () => {
  it("Session 行不存在（伪造但签名有效的 sid）→ 401", async () => {
    const bearer = await obtainMcpBearer(h, { scope: "records:read" });
    const forged = await signMcpAccessToken(
      h.ctx.keyRing,
      { userId: bearer.userId, sessionId: "00000000-0000-4000-8000-000000000000", clientId: bearer.clientId, scope: ["records:read"] },
      { issuer: h.env.baseUrl, resource: "https://gateway.example/mcp", ttlSeconds: 900 },
    );
    // 签名 / iss / aud / exp 全对——只有「sid 查不到」不成立 → 401（不是 200）。
    const res = await expectStatus(forged, 401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://gateway.example/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("Session 已撤销 → 下一次请求立即 401（不等 token 过期）", async () => {
    const bearer = await obtainMcpBearer(h, { scope: "records:read" });
    expect((await h.app.request(discover(bearer.accessToken))).status).toBe(200);

    await handle.sql`
      update mcp_sessions set revoked_at = now(), revoked_reason = 'user_revoke'
       where user_id = ${bearer.userId}`;

    await expectStatus(bearer.accessToken, 401);
  });

  it("Session 已过 absolute_expires_at → 401", async () => {
    const bearer = await obtainMcpBearer(h, { scope: "records:read" });
    // CHECK：absolute_expires_at > created_at —— 两个一起回拨。
    await handle.sql`
      update mcp_sessions
         set created_at = now() - interval '100 days',
             absolute_expires_at = now() - interval '1 day'
       where user_id = ${bearer.userId}`;
    await expectStatus(bearer.accessToken, 401);
  });

  it("sub ≠ Session.user_id → 401（拿别人的 sid 也过不去）", async () => {
    const bearer = await obtainMcpBearer(h, { scope: "records:read" });
    const sid = await sessionIdOf(bearer.userId);
    const forged = await signMcpAccessToken(
      h.ctx.keyRing,
      { userId: "someone-else", sessionId: sid, clientId: bearer.clientId, scope: ["records:read"] },
      { issuer: h.env.baseUrl, resource: "https://gateway.example/mcp", ttlSeconds: 900 },
    );
    await expectStatus(forged, 401);
  });

  it("token 的 client_id ≠ Session.client_id → 401", async () => {
    const bearer = await obtainMcpBearer(h, { scope: "records:read" });
    const sid = await sessionIdOf(bearer.userId);
    const forged = await signMcpAccessToken(
      h.ctx.keyRing,
      { userId: bearer.userId, sessionId: sid, clientId: "another-client", scope: ["records:read"] },
      { issuer: h.env.baseUrl, resource: "https://gateway.example/mcp", ttlSeconds: 900 },
    );
    await expectStatus(forged, 401);
  });

  it("删除 Grant → Session 随 FK 级联消失 → 401（fail-closed）", async () => {
    const bearer = await obtainMcpBearer(h, { scope: "records:read" });
    // `mcp_sessions.grant_id` 是 FK(ON DELETE CASCADE)：「grant 没了但 session
    // 还在」在库里结构上不可达；删除 grant 会让 session 一起消失 → 401。
    // 代码里 grant 缺失仍按 403 fail-closed（见 authorize.ts），由下面的
    // 撤销 / 归属用例覆盖 403 桶。
    await handle.sql`
      delete from mcp_grants where user_id = ${bearer.userId}`;
    await expectStatus(bearer.accessToken, 401);
    const sessions = await handle.sql<{ n: string }[]>`
      select count(*)::text as n from mcp_sessions where user_id = ${bearer.userId}`;
    expect(Number(sessions[0]?.n ?? 0)).toBe(0);
  });
});

describe("Grant 实时回查（grant 层，失败 → 403）", () => {
  it("Grant 被撤销 → 下一次请求立即 403，且不进入任何工具处理", async () => {
    const bearer = await obtainMcpBearer(h, { scope: "records:read" });
    expect((await h.app.request(discover(bearer.accessToken))).status).toBe(200);
    const callsBefore = h.link.calls.length;

    await handle.sql`
      update mcp_grants set revoked_at = now() where user_id = ${bearer.userId}`;

    const res = await expectStatus(bearer.accessToken, 403);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(h.link.calls.length).toBe(callsBefore); // 撤销后不进入派发
    // 403 不是 JSON-RPC 协议错误：没有 JSON-RPC 体（只有 challenge 头）。
    expect(res.headers.get("content-type")).toBeNull();
    expect((await res.text()).length).toBe(0);
  });

  it("Grant 属于另一个用户 → 403（A 的 token 读不到 B 的 grant）", async () => {
    const bearer = await obtainMcpBearer(h, { scope: "records:read" });
    // 把 A 的 session 指到 B 的 grant（跨用户），token 的 sub 仍是 A。
    const other = await handle.sql<{ id: string }[]>`
      insert into users (display_name) values ('other-c-user') returning id`;
    const otherUserId = other[0]!.id;
    const otherGrant = await handle.sql<{ id: string }[]>`
      insert into mcp_grants (user_id, client_id, client_name, scopes, resource, epoch)
      values (${otherUserId}, 'test-client', 'Other', array['records:read'],
              ${"https://gateway.example/mcp"}, 1)
      returning id`;
    await handle.sql`
      update mcp_sessions set grant_id = ${otherGrant[0]!.id} where user_id = ${bearer.userId}`;

    await expectStatus(bearer.accessToken, 403);
  });

  it("Grant 被收窄 → 下一次请求立即反映（tools/list 变小、缺的调用 403）", async () => {
    const bearer = await obtainMcpBearer(h, { scope: "records:read coffee:read" });
    const listAll = await h.app.request(
      modernRequest(
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: modernEnvelope() } },
        { token: bearer.accessToken },
      ),
    );
    const before = (
      (await jsonBody(listAll)).result as { tools: Array<{ name: string }> }
    ).tools;
    expect(before).toHaveLength(5); // records(2) + coffee(3)

    await handle.sql`
      update mcp_grants set scopes = array['records:read'] where user_id = ${bearer.userId}`;

    // 旧 token 的 scope 快照还在——但 grant 收窄立即生效（三交集取最小）。
    const listAfter = await h.app.request(
      modernRequest(
        { jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: modernEnvelope() } },
        { token: bearer.accessToken },
      ),
    );
    const after = (
      (await jsonBody(listAfter)).result as { tools: Array<{ name: string }> }
    ).tools;
    expect(after.map((t) => t.name).sort()).toEqual(["get_record", "search_records"]);

    const call = await h.app.request(
      modernRequest(
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "list_beans", arguments: {}, _meta: modernEnvelope() },
        },
        { token: bearer.accessToken, mcpName: "list_beans" },
      ),
    );
    expect(call.status).toBe(403);
    expect((call.headers.get("www-authenticate") ?? "")).toContain('scope="coffee:read"');
    expect(h.link.calls).toHaveLength(0);
  });

  it("两个用户隔离：A 的 token 只以 A 的身份派发，B 的会话互不影响", async () => {
    const a = await obtainMcpBearer(h, { scope: "records:read" });
    // 第二个用户：github 身份（不同 mock subject → 不同 user），完整流程取 token。
    const b = await obtainMcpBearer(h, { scope: "records:read", provider: "github" });
    const bToken = b.accessToken;

    expect(b.userId).not.toBe(a.userId);

    // 各自的 token 各派发各的身份。
    await h.app.request(
      modernRequest(
        {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "search_records", arguments: {}, _meta: modernEnvelope() },
        },
        { token: a.accessToken, mcpName: "search_records" },
      ),
    );
    await h.app.request(
      modernRequest(
        {
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: { name: "search_records", arguments: {}, _meta: modernEnvelope() },
        },
        { token: bToken, mcpName: "search_records" },
      ),
    );
    expect(h.link.calls).toHaveLength(2);
    expect(h.link.calls[0]?.userId).toBe(a.userId);
    expect(h.link.calls[1]?.userId).toBe(b.userId);
    expect(h.link.calls[0]?.userId).not.toBe(h.link.calls[1]?.userId);

    // A 的 session 撤销不影响 B。
    await handle.sql`
      update mcp_sessions set revoked_at = now(), revoked_reason = 'user_revoke'
       where user_id = ${a.userId}`;
    await expectStatus(a.accessToken, 401);
    expect((await h.app.request(discover(bToken))).status).toBe(200);
  });
});
