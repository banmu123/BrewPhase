import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import { createMcpOAuthHarness, seedAuthorizeClient, type McpOAuthHarness } from "../helpers/mcp-oauth-app.js";
import {
  grantsOf,
  parseConsentPage,
  startConsentFlow,
  submitConsent,
  tableCount,
} from "../helpers/mcp-consent.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import { seedUser } from "../helpers/oauth-db.js";

/**
 * Consent 对 `mcp_grants` 的影响（Phase 1.3.1-C2b）。
 *
 * ## 这一组真正在防的三件事
 *
 * 1. **重复 Grant**：同一 (user, client, resource) 永远只有一行。多一行就意味
 *    着「撤销了一条，另一条还在」，用户点一次撤销不会生效。
 * 2. **epoch 乱涨/不涨**：scope 没变却涨版本 → Desktop 每次都要重装上下文
 *    （一次 revoke + install 往返，期间该 grant 不可派发）；scope 变了却不涨
 *    → `req` 引用的版本校验失效，旧权限会在新授权之后继续被使用。
 * 3. **Step-up 吃掉旧权限**：重新授权时如果只按提交的勾选覆盖，用户会静默
 *    失去上一次明确授予的 scope——而页面还把那些项显示成「已授予」。
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

async function flow(scope: string, overrides: { clientId?: string } = {}) {
  return startConsentFlow(h, {
    query: new URLSearchParams({
      response_type: "code",
      client_id: overrides.clientId ?? "test-client",
      redirect_uri: "https://client.example/callback",
      scope,
      state: "s",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      resource: "https://gateway.example/mcp",
    }).toString(),
  });
}

async function approve(
  session: { rid: string; cookie: string; csrf: string },
  scopes: readonly string[],
) {
  return submitConsent(h, {
    rid: session.rid,
    cookie: session.cookie,
    csrf: session.csrf,
    decision: "allow",
    scopes,
  });
}

describe("首次授权与重复授权", () => {
  it("新用户首次授权：一条 grant，epoch 1，scope 是勾选值", async () => {
    const first = await flow("records:read coffee:read");
    const res = await approve(first, ["records:read", "coffee:read"]);
    expect(res.status).toBe(302);

    const grants = await grantsOf(handle.sql, first.userId);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.scopes).toEqual(["records:read", "coffee:read"]);
    expect(grants[0]!.epoch).toBe(1);
    expect(grants[0]!.revoked_at).toBeNull();
    expect(grants[0]!.client_id).toBe("test-client");
  });

  it("同一用户重复授权同一 client、scope 不变 → 不新增行，epoch 不变", async () => {
    const first = await flow("records:read");
    await approve(first, ["records:read"]);
    const before = (await grantsOf(handle.sql, first.userId))[0]!;

    const second = await flow("records:read");
    await approve(second, ["records:read"]);
    const after = (await grantsOf(handle.sql, first.userId))[0]!;

    expect(await grantsOf(handle.sql, first.userId)).toHaveLength(1);
    expect(after.id).toBe(before.id);
    expect(after.epoch).toBe(before.epoch);
  });

  it("scope 改变 → 同一行更新，epoch +1", async () => {
    const first = await flow("records:read");
    await approve(first, ["records:read"]);

    const second = await flow("records:read coffee:read");
    await approve(second, ["records:read", "coffee:read"]);

    const grants = await grantsOf(handle.sql, first.userId);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.scopes).toEqual(["records:read", "coffee:read"]);
    expect(grants[0]!.epoch).toBe(2);
  });

  it("已撤销的 grant 再次授权 → 同一行复活，revoked_at 清空，epoch +1", async () => {
    const first = await flow("records:read");
    await approve(first, ["records:read"]);

    await handle.sql`update mcp_grants set revoked_at = now() where user_id = ${first.userId}`;

    const second = await flow("records:read");
    await approve(second, ["records:read"]);

    const grants = await grantsOf(handle.sql, first.userId);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.revoked_at).toBeNull();
    expect(grants[0]!.epoch).toBe(2);
  });

  it("撤销后以更窄的 scope 重新授权 → 复活并按新 scope 覆盖", async () => {
    const first = await flow("records:read coffee:read");
    await approve(first, ["records:read", "coffee:read"]);
    await handle.sql`update mcp_grants set revoked_at = now() where user_id = ${first.userId}`;

    const second = await flow("records:read");
    await approve(second, ["records:read"]);

    const grants = await grantsOf(handle.sql, first.userId);
    expect(grants[0]!.scopes).toEqual(["records:read"]);
    expect(grants[0]!.revoked_at).toBeNull();
    expect(grants[0]!.epoch).toBe(2);
  });
});

describe("隔离", () => {
  it("不影响同一用户的另一个 client", async () => {
    const mine = await flow("records:read");
    await approve(mine, ["records:read"]);

    await seedAuthorizeClient(handle, { clientId: "other-client", clientName: "Other" });
    await handle.sql`
      insert into mcp_grants (user_id, client_id, client_name, scopes, resource, epoch)
      values (${mine.userId}, 'other-client', 'Other',
              array['coffee:read'], 'https://gateway.example/mcp', 5)`;

    // 同一个用户（Mock Provider 身份固定）再批一个 coffee:read。
    const second = await flow("coffee:read");
    await approve(second, ["coffee:read"]);

    const rows = await handle.sql<{ client_id: string; scopes: string[]; epoch: number }[]>`
      select client_id, scopes, epoch from mcp_grants where user_id = ${mine.userId} order by client_id`;
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.client_id === "other-client")).toMatchObject({
      scopes: ["coffee:read"],
      epoch: 5,
    });
  });

  it("不影响另一个用户对同一 client 的授权", async () => {
    const mine = await flow("records:read");
    await approve(mine, ["records:read"]);

    const otherUser = await seedUser(handle.sql, "someone-else");
    await handle.sql`
      insert into mcp_grants (user_id, client_id, client_name, scopes, resource, epoch)
      values (${otherUser}, 'test-client', 'Test Client',
              array['coffee:read'], 'https://gateway.example/mcp', 9)`;

    const second = await flow("records:read coffee:read");
    await approve(second, ["records:read", "coffee:read"]);

    const rows = await handle.sql<{ user_id: string; scopes: string[]; epoch: number }[]>`
      select user_id, scopes, epoch from mcp_grants order by user_id`;
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.user_id === otherUser)).toMatchObject({
      scopes: ["coffee:read"],
      epoch: 9,
    });
  });

  it("不影响同一 (user, client) 但不同 resource 的授权", async () => {
    const mine = await flow("records:read");
    await handle.sql`
      insert into mcp_grants (user_id, client_id, client_name, scopes, resource, epoch)
      values (${mine.userId}, 'test-client', 'Test Client',
              array['coffee:read'], 'https://other.example/mcp', 7)`;

    await approve(mine, ["records:read"]);

    const rows = await handle.sql<{ resource: string; scopes: string[]; epoch: number }[]>`
      select resource, scopes, epoch from mcp_grants where user_id = ${mine.userId} order by resource`;
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.resource === "https://other.example/mcp")).toMatchObject({
      scopes: ["coffee:read"],
      epoch: 7,
    });
  });
});

describe("Step-up", () => {
  it("已有 scope 显示为已勾选且不可取消，新增项可勾选", async () => {
    const first = await flow("records:read");
    await approve(first, ["records:read"]);

    const second = await flow("records:read coffee:read");
    const page = parseConsentPage(second.html);

    const records = page.scopes.find((scope) => scope.value === "records:read")!;
    const coffee = page.scopes.find((scope) => scope.value === "coffee:read")!;
    expect(records.checked).toBe(true);
    expect(records.disabled).toBe(true);
    expect(coffee.checked).toBe(true);
    expect(coffee.disabled).toBe(false);
  });

  it("只提交新增项 → 最终 scope 是已有 ∪ 新增（不丢旧权限）", async () => {
    const first = await flow("records:read");
    await approve(first, ["records:read"]);

    const second = await flow("records:read coffee:read");
    // 页面里 disabled 的复选框不会被浏览器提交，所以这里只有 coffee:read。
    const res = await approve(second, ["coffee:read"]);
    expect(res.status).toBe(302);

    const grants = await grantsOf(handle.sql, first.userId);
    expect(grants[0]!.scopes).toEqual(["records:read", "coffee:read"]);
    expect(grants[0]!.epoch).toBe(2);
  });

  it("Step-up 时提交已有 scope 也不会重复（幂等并集）", async () => {
    const first = await flow("records:read");
    await approve(first, ["records:read"]);

    const second = await flow("records:read coffee:read");
    await approve(second, ["records:read", "coffee:read"]);

    const grants = await grantsOf(handle.sql, first.userId);
    expect(grants[0]!.scopes).toEqual(["records:read", "coffee:read"]);
  });

  it("Step-up 时一个新增项都不勾 → 按拒绝处理，已有 grant 原样不动", async () => {
    const first = await flow("records:read");
    await approve(first, ["records:read"]);
    const codesBefore = await tableCount(handle.sql, "mcp_auth_codes");

    const second = await flow("records:read coffee:read");
    const res = await approve(second, []);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("access_denied");

    const grants = await grantsOf(handle.sql, first.userId);
    expect(grants[0]!.scopes).toEqual(["records:read"]);
    expect(grants[0]!.epoch).toBe(1);
    // 拒绝不产生新的授权码（第一次授权的那把还在）。
    expect(await tableCount(handle.sql, "mcp_auth_codes")).toBe(codesBefore);
  });
});

describe("非 Step-up 的收窄", () => {
  it("上次授了两个、这次只请求一个 → 每个 scope 都可选（不灰置）", async () => {
    const first = await flow("records:read coffee:read");
    await approve(first, ["records:read", "coffee:read"]);

    const second = await flow("records:read");
    const page = parseConsentPage(second.html);
    expect(page.scopes).toHaveLength(1);
    expect(page.scopes[0]!.disabled).toBe(false);
  });

  it("收窄后 grant 只剩勾选值，epoch +1", async () => {
    const first = await flow("records:read coffee:read");
    await approve(first, ["records:read", "coffee:read"]);

    const second = await flow("records:read");
    await approve(second, ["records:read"]);

    const grants = await grantsOf(handle.sql, first.userId);
    expect(grants[0]!.scopes).toEqual(["records:read"]);
    expect(grants[0]!.epoch).toBe(2);
  });

  it("收窄时不能凭旧授权把一个本次未请求的 scope 加回来", async () => {
    const first = await flow("records:read coffee:read");
    await approve(first, ["records:read", "coffee:read"]);

    const second = await flow("records:read");
    const res = await approve(second, ["records:read", "coffee:read"]);

    // coffee:read 不在本次请求里 → 400，不产生新授权。
    expect(res.status).toBe(400);
    const grants = await grantsOf(handle.sql, first.userId);
    expect(grants[0]!.scopes).toEqual(["records:read", "coffee:read"]);
    expect(grants[0]!.epoch).toBe(1);
  });
});
