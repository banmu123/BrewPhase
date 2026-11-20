import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import {
  createMcpOAuthHarness,
  seedAuthorizeClient,
  type McpOAuthHarness,
} from "../helpers/mcp-oauth-app.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import {
  grantsOf,
  parseConsentPage,
  redirectParams,
  startConsentFlow,
  submitConsent,
  tableCount,
} from "../helpers/mcp-consent.js";
import { clientIdentifierDisplay } from "../../src/mcp-oauth/consent-page.js";
import type { CimdTransportResponse } from "../../src/mcp-oauth/cimd.js";

/**
 * Consent 四条件实时复核（Phase 1.3.1-C3c-3B-3，设计 §8.3 方案 B）。
 *
 * ## 这一组的被测对象
 *
 * GET 与 POST 都必须基于**当前** `mcp_oauth_clients` 行验证四条：
 * 1 行存在、2 非 INVALID 哨兵、3 `redirect_uri` 逐字符在册、4 `grant_types`
 * 含 `authorization_code`。**不比对 `metadata_version`**（方案 B 的核心：
 * 展示字段变化导致的版本递增不得误拒）；STALE 照常放行（`no-cache` 永久 STALE）。
 *
 * ## 为什么用真实事务与真实锁
 *
 * S2（GET 与 POST 之间翻转）与「FOR SHARE 阻塞刷新」是这一节的两个 High
 * 缺口。前者必须真的跨两次 HTTP 请求制造窗口；后者必须让 PostgreSQL 真的
 * 阻塞——用 sleep「假装并发」证明不了 `FOR SHARE` 与 `UPDATE` 冲突。
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

// ---------------------------------------------------------------------------
// 原语
// ---------------------------------------------------------------------------

async function authRequestExists(rid: string): Promise<boolean> {
  const rows = await handle.sql<{ n: string }[]>`
    select count(*)::text as n from mcp_auth_requests where id = ${rid}`;
  return Number(rows[0]?.n ?? 0) === 1;
}

interface MetadataAuditRow {
  detail: Record<string, unknown>;
  user_id: string | null;
}

async function metadataAudits(rid: string): Promise<MetadataAuditRow[]> {
  return handle.sql<MetadataAuditRow[]>`
    select detail, user_id from auth_events
     where event_type = 'mcp_consent_metadata_invalid' and detail->>'rid' = ${rid}`;
}

async function codeCount(userId: string): Promise<number> {
  const rows = await handle.sql<{ n: string }[]>`
    select count(*)::text as n from mcp_auth_codes where user_id = ${userId}`;
  return Number(rows[0]?.n ?? 0);
}

async function sessionCountFor(userId: string): Promise<number> {
  const rows = await handle.sql<{ n: string }[]>`
    select count(*)::text as n from mcp_sessions where user_id = ${userId}`;
  return Number(rows[0]?.n ?? 0);
}

const INVALID = "1970-01-01T00:00:00.000Z";

/** 把注册行标成 terminal INVALID（正是 Registry terminal CAS 提交后的形态）。 */
async function markInvalid(clientId: string): Promise<void> {
  await handle.sql`
    update mcp_oauth_clients
       set metadata_cache_expires_at = ${INVALID}::timestamptz,
           metadata_version = metadata_version + 1
     where client_id = ${clientId}`;
}

/** 恢复为 FRESH（§5.4 的合法自愈路径；同样推进版本）。 */
async function restoreFresh(clientId: string): Promise<void> {
  await handle.sql`
    update mcp_oauth_clients
       set metadata_cache_expires_at = now() + interval '1 hour',
           metadata_version = metadata_version + 1
     where client_id = ${clientId}`;
}

async function setRedirectUris(clientId: string, uris: string[]): Promise<void> {
  await handle.sql`
    update mcp_oauth_clients
       set redirect_uris = ${uris}, metadata_version = metadata_version + 1
     where client_id = ${clientId}`;
}

async function setGrantTypes(clientId: string, types: string[]): Promise<void> {
  await handle.sql`
    update mcp_oauth_clients
       set grant_types = ${types}, metadata_version = metadata_version + 1
     where client_id = ${clientId}`;
}

async function deleteClientRow(clientId: string): Promise<void> {
  await handle.sql`delete from mcp_oauth_clients where client_id = ${clientId}`;
}

/** 只改展示字段（client_name）并推进版本——四条件必须照常通过。 */
async function bumpClientName(clientId: string, name: string): Promise<void> {
  await handle.sql`
    update mcp_oauth_clients
       set client_name = ${name}, metadata_version = metadata_version + 1
     where client_id = ${clientId}`;
}

async function versionOf(clientId: string): Promise<number> {
  const rows = await handle.sql<{ v: string }[]>`
    select metadata_version::text as v from mcp_oauth_clients where client_id = ${clientId}`;
  return Number(rows[0]?.v ?? 0);
}

/** 轮询直到出现等待 `mcp_oauth_clients` 行锁的后端（真实锁等待，不靠 sleep）。 */
async function waitForLockWaiter(timeoutMs = 4000): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await handle.sql<Record<string, unknown>[]>`
      select pid, wait_event_type, pg_blocking_pids(pid) as blockers
        from pg_stat_activity
       where pid <> pg_backend_pid()
         and wait_event_type = 'Lock'
         and query ilike '%mcp_oauth_clients%'`;
    if (rows.length > 0) return rows[0]!;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

// ---------------------------------------------------------------------------
// 四条件
// ---------------------------------------------------------------------------

describe("四条件：条件 1（注册行存在）", () => {
  it("GET：注册行被删 → 删 pending + 审计 condition=1 + 400 HTML，不渲染同意页", async () => {
    const flow = await startConsentFlow(h);
    expect(flow.html).toContain("scope"); // 首次 GET 正常渲染

    await deleteClientRow("test-client");
    const res = await h.app.request(`/mcp/oauth/consent?rid=${flow.rid}`, {
      headers: { cookie: flow.cookie },
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    const body = await res.text();
    expect(body).toContain("客户端信息已变更");
    // 不渲染同意页：没有 scope 复选框、没有新的 CSRF 表单。
    expect(body).not.toContain('name="scope"');
    expect(body).not.toContain('name="csrf"');

    // 删除与审计都真正持久化（不是内存记录）。
    expect(await authRequestExists(flow.rid)).toBe(false);
    const audits = await metadataAudits(flow.rid);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.user_id).toBe(flow.userId);
    expect(audits[0]?.detail.clientId).toBe("test-client");
    expect(audits[0]?.detail.stage).toBe("consent");
    expect(audits[0]?.detail.condition).toBe(1);
  });

  it("POST：注册行被删 → 400、不建 Grant / Code / Session、审计 condition=1", async () => {
    const flow = await startConsentFlow(h);
    await deleteClientRow("test-client");

    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await authRequestExists(flow.rid)).toBe(false);
    expect(await tableCount(handle.sql, "mcp_auth_codes")).toBe(0);
    expect(await tableCount(handle.sql, "mcp_grants")).toBe(0);
    expect(await sessionCountFor(flow.userId)).toBe(0);

    const audits = await metadataAudits(flow.rid);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail.stage).toBe("consent_submit");
    expect(audits[0]?.detail.condition).toBe(1);
  });
});

describe("四条件：条件 2（INVALID 哨兵）——S1 / S2 / S3 / S4", () => {
  it("S1：INVALID 先发生，Consent GET 后发生 → 删行 + 审计 + 400，不渲染", async () => {
    const flow = await startConsentFlow(h); // 这次 GET 发生在 INVALID 之前
    await markInvalid("test-client");

    const res = await h.app.request(`/mcp/oauth/consent?rid=${flow.rid}`, {
      headers: { cookie: flow.cookie },
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).not.toContain('name="scope"');

    expect(await authRequestExists(flow.rid)).toBe(false);
    const audits = await metadataAudits(flow.rid);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail.condition).toBe(2);
    expect(audits[0]?.detail.stage).toBe("consent");
  });

  it("S2：GET 通过后、POST 之前 INVALID → POST 拒绝；不建 Code、不恢复已撤 Grant", async () => {
    const flow = await startConsentFlow(h); // GET 通过（拿到 CSRF）

    // 预置一条**已撤销**的 Grant（mismatch 撤销后的形态）：拒绝路径绝不能恢复它。
    const seedGrant = await handle.sql<{ id: string }[]>`
      insert into mcp_grants (user_id, client_id, client_name, scopes, resource, epoch, revoked_at)
      values (${flow.userId}, 'test-client', 'Test Client', array['records:read'],
              ${"https://gateway.example/mcp"}, 2, now())
      returning id`;
    expect(seedGrant).toHaveLength(1);

    await markInvalid("test-client"); // GET 与 POST 之间翻转

    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull(); // 不 302
    expect(await authRequestExists(flow.rid)).toBe(false);
    expect(await tableCount(handle.sql, "mcp_auth_codes")).toBe(0);
    expect(await sessionCountFor(flow.userId)).toBe(0);

    // 已撤 Grant 原样保留：不恢复、不加 scope、epoch 不动。
    const grants = await grantsOf(handle.sql, flow.userId);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.revoked_at).not.toBeNull();
    expect(grants[0]?.epoch).toBe(2);

    const audits = await metadataAudits(flow.rid);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail.condition).toBe(2);
    expect(audits[0]?.detail.stage).toBe("consent_submit");
  });

  it("S3：terminal document invalid（非 mismatch）后旧 pending 提交 → 拒绝且不动 Grant", async () => {
    const flow = await startConsentFlow(h);
    const before = await grantsOf(handle.sql, flow.userId);

    // 与 Registry terminal CAS 提交后的行形态一致（epoch + 版本递增，不撤 Grant）。
    await markInvalid("test-client");

    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });
    expect(res.status).toBe(400);
    expect(await tableCount(handle.sql, "mcp_auth_codes")).toBe(0);
    expect(await grantsOf(handle.sql, flow.userId)).toEqual(before);

    const audits = await metadataAudits(flow.rid);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail.condition).toBe(2);
  });

  it("S4：INVALID 恢复 FRESH 后旧 pending 再提交 → 四条件通过、正常签发（版本变了不拒绝）", async () => {
    const flow = await startConsentFlow(h);
    await markInvalid("test-client");
    const vInvalid = await versionOf("test-client");
    await restoreFresh("test-client");
    const vRestored = await versionOf("test-client");
    expect(vRestored).toBe(vInvalid + 1); // 版本确实因 INVALID/恢复递增过

    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read", "coffee:read"],
    });

    expect(res.status).toBe(302);
    const params = redirectParams(res);
    expect(params.get("code")).toBeTruthy();
    expect(await authRequestExists(flow.rid)).toBe(false);
    expect(await codeCount(flow.userId)).toBe(1);
    const grants = await grantsOf(handle.sql, flow.userId);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.revoked_at).toBeNull();
    // 拒绝审计一条都没有（这次没有被 metadata 拒绝过）。
    expect(await metadataAudits(flow.rid)).toHaveLength(0);
  });

  it("版本仅因 client_name 变化而递增、行仍非 INVALID → GET 与 POST 都允许", async () => {
    const flow = await startConsentFlow(h);
    const v1 = await versionOf("test-client");
    await bumpClientName("test-client", "Renamed Client");
    const v2 = await versionOf("test-client");
    expect(v2).toBe(v1 + 1);

    // GET 仍渲染（用改名后的值）。**每次 GET 都会轮换 CSRF**——用新页面里的
    // 那把提交，否则会撞 csrf_mismatch（那是另一条被测路径）。
    const page = await h.app.request(`/mcp/oauth/consent?rid=${flow.rid}`, {
      headers: { cookie: flow.cookie },
    });
    expect(page.status).toBe(200);
    const pageHtml = await page.text();
    expect(pageHtml).toContain("Renamed Client");
    const freshCsrf = parseConsentPage(pageHtml).csrf;
    expect(freshCsrf).toBeTruthy();

    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: freshCsrf,
      decision: "allow",
      scopes: ["records:read"],
    });
    expect(res.status).toBe(302);
    expect(await codeCount(flow.userId)).toBe(1);
  });
});

describe("四条件：条件 3 / 4（redirect_uri、grant_types）——S5 / S6", () => {
  it("S5：redirect_uri 已被移出注册集合（行仍非 INVALID）→ POST 拒绝 condition=3", async () => {
    const flow = await startConsentFlow(h);
    // 新文档删掉了这个回调，但保留了另一个（行照常非 INVALID）。
    await setRedirectUris("test-client", ["https://other.example/callback"]);

    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await tableCount(handle.sql, "mcp_auth_codes")).toBe(0);

    const audits = await metadataAudits(flow.rid);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail.condition).toBe(3);
  });

  it("S5（GET）：redirect_uri 被移出 → GET 同样 400 condition=3、删行审计", async () => {
    const flow = await startConsentFlow(h);
    await setRedirectUris("test-client", ["https://other.example/callback"]);

    const res = await h.app.request(`/mcp/oauth/consent?rid=${flow.rid}`, {
      headers: { cookie: flow.cookie },
    });
    expect(res.status).toBe(400);
    expect(await authRequestExists(flow.rid)).toBe(false);
    const audits = await metadataAudits(flow.rid);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail.condition).toBe(3);
    expect(audits[0]?.detail.stage).toBe("consent");
  });

  it("S6：grant_types 不再含 authorization_code → POST 拒绝 condition=4", async () => {
    const flow = await startConsentFlow(h);
    await setGrantTypes("test-client", ["refresh_token"]);

    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });
    expect(res.status).toBe(400);
    expect(await tableCount(handle.sql, "mcp_auth_codes")).toBe(0);
    expect(await tableCount(handle.sql, "mcp_grants")).toBe(0);

    const audits = await metadataAudits(flow.rid);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail.condition).toBe(4);
  });

  it("S6（GET）：grant_types 变化 → GET 400 condition=4", async () => {
    const flow = await startConsentFlow(h);
    await setGrantTypes("test-client", ["refresh_token"]);

    const res = await h.app.request(`/mcp/oauth/consent?rid=${flow.rid}`, {
      headers: { cookie: flow.cookie },
    });
    expect(res.status).toBe(400);
    expect(await authRequestExists(flow.rid)).toBe(false);
    const audits = await metadataAudits(flow.rid);
    expect(audits[0]?.detail.condition).toBe(4);
  });

  it("deny 提交也受四条件约束：metadata invalid 时拒绝路径不 302", async () => {
    const flow = await startConsentFlow(h);
    await markInvalid("test-client");

    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "deny",
    });
    // §4.4：metadata invalid 时不得执行 302（即使是用户拒绝）。
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await authRequestExists(flow.rid)).toBe(false);
    const audits = await metadataAudits(flow.rid);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail.condition).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// S7：并发与真实锁
// ---------------------------------------------------------------------------

describe("S7 与 FOR SHARE（真实 PostgreSQL 锁）", () => {
  it("S7：同一 client 的两个用户并发 Consent POST → 都成功、无死锁", async () => {
    const first = await startConsentFlow(h, { provider: "google" });
    const second = await startConsentFlow(h, { provider: "github" });
    expect(second.userId).not.toBe(first.userId); // 确实是两个用户

    const [a, b] = await Promise.all([
      submitConsent(h, {
        rid: first.rid,
        cookie: first.cookie,
        csrf: first.csrf,
        decision: "allow",
        scopes: ["records:read"],
      }),
      submitConsent(h, {
        rid: second.rid,
        cookie: second.cookie,
        csrf: second.csrf,
        decision: "allow",
        scopes: ["coffee:read"],
      }),
    ]);

    // 两条都完成（既没有死锁报错，也没有互相阻塞成 500）。
    expect(a.status).toBe(302);
    expect(b.status).toBe(302);
    expect(redirectParams(a).get("code")).toBeTruthy();
    expect(redirectParams(b).get("code")).toBeTruthy();
    expect(await codeCount(first.userId)).toBe(1);
    expect(await codeCount(second.userId)).toBe(1);
    expect(await tableCount(handle.sql, "mcp_grants")).toBe(2);
  });

  it("FOR SHARE 兼容性：另一事务持共享锁时 POST 不被阻塞（不是 FOR UPDATE）", async () => {
    const flow = await startConsentFlow(h);

    // 手工事务持 **S 锁**（不提交）。若实现误用 FOR UPDATE，POST 会在这里阻塞。
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const heldPromise = new Promise<void>((r) => (held = r));
    const holder = handle.sql
      .begin(async (t) => {
        await t`select 1 from mcp_oauth_clients where client_id = 'test-client' for share`;
        held();
        await gate;
      })
      .catch(() => undefined);
    await heldPromise;

    const pending = submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });
    // 在持锁事务**仍然开着**的时候就必须完成——S 与 S 兼容。
    const raced = await Promise.race([
      pending.then((res) => ({ done: true as const, res })),
      new Promise<{ done: false }>((r) => setTimeout(() => r({ done: false }), 3000)),
    ]);
    release();
    await holder;

    expect(raced.done, "FOR SHARE 不应被另一个共享锁阻塞").toBe(true);
    if (raced.done) expect(raced.res.status).toBe(302);
    expect(await tableCount(handle.sql, "mcp_auth_codes")).toBe(1);
  });

  it("FOR SHARE：刷新事务持 U 锁时 POST 真实阻塞；提交后读到 INVALID → 拒绝", async () => {
    const flow = await startConsentFlow(h);

    // 手工事务：标 INVALID + 推进版本，**持锁不提交**（等价于一次刷新/terminal）。
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedPromise = new Promise<void>((r) => (locked = r));
    const holder = handle.sql
      .begin(async (t) => {
        await t`
          update mcp_oauth_clients
             set metadata_cache_expires_at = ${INVALID}::timestamptz,
                 metadata_version = metadata_version + 1
           where client_id = 'test-client'`;
        locked();
        await gate;
      })
      .catch(() => undefined);
    await lockedPromise;

    // POST：FOR UPDATE(auth_request) → **FOR SHARE(clients) 阻塞**。
    const pending = submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });

    const waiter = await waitForLockWaiter(5000);
    expect(waiter, "应观测到等待 mcp_oauth_clients 行锁的后端").not.toBeNull();
    expect(Array.isArray(waiter!.blockers)).toBe(true);
    expect((waiter!.blockers as unknown[]).length).toBeGreaterThan(0);

    // 提交持锁事务 → FOR SHARE 拿到锁，读到 epoch（INVALID）→ 拒绝。
    release();
    await holder;
    const res = await pending;

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await tableCount(handle.sql, "mcp_auth_codes")).toBe(0);
    const audits = await metadataAudits(flow.rid);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail.condition).toBe(2);
    expect(await versionOf("test-client")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// STALE 放行 + 同意页身份展示
// ---------------------------------------------------------------------------

describe("STALE 放行与同意页身份展示（§8.3 / §16）", () => {
  it("no-cache STALE 的 cimd 客户端可以完整走完 authorize → GET → POST", async () => {
    // 注入 no-cache 抓取器：授权时刷新成功但 ttl=0 → 行**永久 STALE**。
    const noCacheResponse: CimdTransportResponse = {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-cache" },
      body: Buffer.from(
        JSON.stringify({
          client_id: "https://cimd-stale.example/meta.json",
          client_name: "Stale Client",
          redirect_uris: ["https://client.example/callback"],
          grant_types: ["authorization_code"],
        }),
        "utf8",
      ),
      bodyTooLarge: false,
    };
    const staleHarness = await createMcpOAuthHarness({
      cimdFetcher: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 as const }],
        request: async () => noCacheResponse,
        now: () => new Date(),
        monotonic: () => 0,
      },
    });
    // 种一行 STALE（floor 已过 → authorize 会重新抓取；no-cache 之后仍 STALE）。
    await handle.sql`
      insert into mcp_oauth_clients
        (client_id, client_name, redirect_uris, grant_types,
         token_endpoint_auth_method, registration_source, metadata_fetched_at,
         metadata_cache_expires_at, metadata_version)
      values (
        'https://cimd-stale.example/meta.json', 'Stale Client',
        array['https://client.example/callback'], array['authorization_code'],
        'none', 'cimd',
        now() - interval '40 seconds', now() - interval '41 seconds', 1
      )`;

    const flow = await startConsentFlow(staleHarness, {
      query: new URLSearchParams({
        response_type: "code",
        client_id: "https://cimd-stale.example/meta.json",
        redirect_uri: "https://client.example/callback",
        scope: "records:read",
        state: "client-state-1",
        code_challenge: "a".repeat(43),
        code_challenge_method: "S256",
        resource: "https://gateway.example/mcp",
      }).toString(),
    });

    // 行仍然 STALE（ttl=0），不是 epoch——条件 2 必须放行 STALE。
    const rows = await handle.sql<{ expires: Date; fetched: Date }[]>`
      select metadata_cache_expires_at as expires, metadata_fetched_at as fetched
        from mcp_oauth_clients
       where client_id = 'https://cimd-stale.example/meta.json'`;
    expect(new Date(rows[0]!.expires).getTime()).not.toBe(0);
    expect(new Date(rows[0]!.expires).getTime()).toBeLessThanOrEqual(Date.now());

    const res = await submitConsent(staleHarness, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });
    expect(res.status).toBe(302);
    expect(redirectParams(res).get("code")).toBeTruthy();
  });

  it("同意页同时展示「客户端身份域名」与「回调域名」两个独立标签", async () => {
    const flow = await startConsentFlow(h); // 不透明 id = test-client
    expect(flow.html).toContain("你正在授权给 <strong>test-client</strong>");
    expect(flow.html).toContain("授权完成后你会回到 <strong>client.example</strong>");
    // 两个身份不混用：回调 host 不得出现在身份标签里。
    expect(flow.html).not.toContain("你正在授权给 <strong>client.example</strong>");
    // 只展示纯文本：没有把 client_id / client_uri 渲染成链接。
    expect(flow.html).not.toContain("<a href");
    // 不展示远程 logo。
    expect(flow.html.toLowerCase()).not.toContain("logo");
  });

  it("URL 形态 client_id 展示 hostname；IPv6 保留方括号；不透明 id 截断 40 字符", () => {
    expect(clientIdentifierDisplay("https://login.example.com/oauth/client")).toBe(
      "login.example.com",
    );
    expect(clientIdentifierDisplay("https://[::1]:8443/client")).toBe("[::1]");
    // 路径 / 查询串绝不进入展示（不回显完整 URL）。
    expect(clientIdentifierDisplay("https://evil.example.com/secret?token=ABC")).toBe(
      "evil.example.com",
    );

    const opaque = "brewphase-desktop";
    expect(clientIdentifierDisplay(opaque)).toBe(opaque);
    const long = "x".repeat(80);
    const shown = clientIdentifierDisplay(long);
    expect(shown.length).toBe(40); // 39 字符 + 省略号
    expect(shown.endsWith("…")).toBe(true);

    // http(s) 形态但解析不出 host → 空字符串（§16「解析失败」行）。
    expect(clientIdentifierDisplay("http://")).toBe("");
    // 非 http(s) 绝对 URL（如 javascript:）按不透明 id 截断，不给 host。
    expect(clientIdentifierDisplay("javascript:alert(1)")).toBe("javascript:alert(1)");
  });

  it("URL 形态的预注册客户端：同意页身份行展示 hostname", async () => {
    await seedAuthorizeClient(handle, {
      clientId: "https://partner.example.com/oauth/client",
      redirectUris: ["https://client.example/callback"],
    });
    const flow = await startConsentFlow(h, {
      query: new URLSearchParams({
        response_type: "code",
        client_id: "https://partner.example.com/oauth/client",
        redirect_uri: "https://client.example/callback",
        scope: "records:read",
        state: "client-state-1",
        code_challenge: "a".repeat(43),
        code_challenge_method: "S256",
        resource: "https://gateway.example/mcp",
      }).toString(),
    });
    expect(flow.html).toContain("你正在授权给 <strong>partner.example.com</strong>");
    expect(flow.html).not.toContain("partner.example.com/oauth/client");
  });
});

/* ========================================================================== *
 * deny / 空 scope 的事务与真实锁（C3c-3B-3-R1，任务书 §六）
 *
 * 修复前：deny / 空 scope 走「普通 SELECT 快照查四条件 → 条件 DELETE → 302」，
 * 检查与重定向之间不持锁——刷新可以在窗口内把本次 redirect_uri 移出注册集合，
 * 拒绝仍会 302 到已不在册的回调（独立审核 P2）。
 * 修复后：两条路径与 allow 同一锁序的事务
 * `auth_requests FOR UPDATE → oauth_clients FOR SHARE → 四条件 → 删行/审计`。
 * ========================================================================== */

describe("deny / 空 scope 的事务与真实锁（C3c-3B-3-R1）", () => {
  /** 另一个用户 + 另一个 client 的 Grant（断言拒绝路径不误伤）。 */
  async function seedForeignGrant(): Promise<{ userId: string; grantId: string }> {
    const users = await handle.sql<{ id: string }[]>`
      insert into users (display_name) values (${"foreign-" + Math.random().toString(36).slice(2)}) returning id`;
    const userId = users[0]!.id;
    const grants = await handle.sql<{ id: string }[]>`
      insert into mcp_grants (user_id, client_id, client_name, scopes, resource, epoch)
      values (${userId}, 'other-client', 'Foreign', array['records:read'],
              ${"https://gateway.example/mcp"}, 1)
      returning id`;
    return { userId, grantId: grants[0]!.id };
  }

  async function grantSnapshot(grantId: string): Promise<Record<string, unknown>> {
    const rows = await handle.sql<{ revoked: string | null; epoch: number; scopes: string[] }[]>`
      select revoked_at::text as revoked, epoch, scopes from mcp_grants where id = ${grantId}`;
    expect(rows).toHaveLength(1);
    return { ...rows[0]! };
  }

  it("测试 A：显式 deny 与注册信息刷新竞争 → FOR SHARE 阻塞 → B 提交后 condition=3 拒绝", async () => {
    const flow = await startConsentFlow(h);
    const foreign = await seedForeignGrant();
    const foreignBefore = await grantSnapshot(foreign.grantId);

    // 事务 B：先取 `mcp_oauth_clients` 排他锁（不提交），收到信号后再移除
    // 本次 redirect_uri 并 COMMIT。
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedPromise = new Promise<void>((r) => (locked = r));
    const holder = handle.sql
      .begin(async (t) => {
        await t`
          update mcp_oauth_clients
             set metadata_version = metadata_version + 1
           where client_id = 'test-client'`;
        locked();
        await gate;
        // B COMMIT 前的写：把 auth request 的 redirect_uri 移出注册集合。
        await t`
          update mcp_oauth_clients
             set redirect_uris = array['https://elsewhere.example/cb']
           where client_id = 'test-client'`;
      })
      .catch(() => undefined);
    await lockedPromise;

    // Consent POST（decision=deny）→ 应真实阻塞在 FOR SHARE。
    const pending = submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "deny",
    });
    try {
      const waiter = await waitForLockWaiter(5000);
      expect(waiter, "deny POST 应阻塞在 mcp_oauth_clients 的 FOR SHARE").not.toBeNull();
      expect(Array.isArray(waiter!.blockers)).toBe(true);
      expect((waiter!.blockers as unknown[]).length).toBeGreaterThan(0);
    } finally {
      // 无论断言成败都放行 B（避免失败时持锁事务泄漏、卡住后续 resetDb）。
      release();
      await holder;
    }

    // B 已提交（redirect_uri 移出注册集合）→ POST 恢复，读到条件 3 失败。
    const res = await pending;

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull(); // invalid 时绝不重定向
    expect(await authRequestExists(flow.rid)).toBe(false);

    const audits = await metadataAudits(flow.rid);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail.stage).toBe("consent_submit");
    expect(audits[0]?.detail.condition).toBe(3);

    // 零副作用：无 Code、无新 Grant、无 Session。
    expect(await tableCount(handle.sql, "mcp_auth_codes")).toBe(0);
    expect(await tableCount(handle.sql, "mcp_grants")).toBe(1); // 只有 seeded foreign
    expect(await sessionCountFor(flow.userId)).toBe(0);
    expect(await sessionCountFor(foreign.userId)).toBe(0);
    // 其他用户 / 其他 client 的 Grant 逐字段不变。
    expect(await grantSnapshot(foreign.grantId)).toEqual(foreignBefore);
  });

  it("测试 B：空 scope 与 INVALID 竞争 → FOR SHARE 阻塞 → 读到 epoch → 400 condition=2", async () => {
    const flow = await startConsentFlow(h);

    // 事务 B：把注册行标成 INVALID（U 锁）但不提交。
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedPromise = new Promise<void>((r) => (locked = r));
    const holder = handle.sql
      .begin(async (t) => {
        await t`
          update mcp_oauth_clients
             set metadata_cache_expires_at = '1970-01-01T00:00:00.000Z'::timestamptz,
                 metadata_version = metadata_version + 1
           where client_id = 'test-client'`;
        locked();
        await gate;
      })
      .catch(() => undefined);
    await lockedPromise;

    // 空 scope（allow 但一个都没勾）→ 按 deny 处理，同样必须阻塞在 FOR SHARE。
    const pending = submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: [],
    });
    try {
      const waiter = await waitForLockWaiter(5000);
      expect(waiter, "空 scope POST 应阻塞在 mcp_oauth_clients 的 FOR SHARE").not.toBeNull();
      expect((waiter!.blockers as unknown[]).length).toBeGreaterThan(0);
    } finally {
      release();
      await holder;
    }

    const res = await pending;

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await authRequestExists(flow.rid)).toBe(false);
    const audits = await metadataAudits(flow.rid);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail.stage).toBe("consent_submit");
    expect(audits[0]?.detail.condition).toBe(2);

    // 零副作用。
    expect(await tableCount(handle.sql, "mcp_auth_codes")).toBe(0);
    expect(await tableCount(handle.sql, "mcp_grants")).toBe(0);
    expect(await sessionCountFor(flow.userId)).toBe(0);
    expect(await versionOf("test-client")).toBe(2); // B 的版本推进已提交
  });

  it("测试 C：有效 deny 正常路径 → 302 access_denied、state 原样、零副作用", async () => {
    const flow = await startConsentFlow(h);

    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "deny",
    });

    expect(res.status).toBe(302);
    const params = redirectParams(res);
    expect(params.get("error")).toBe("access_denied");
    expect(params.get("state")).toBe("client-state-1"); // 原样回传
    expect(params.get("code")).toBeNull();

    expect(await authRequestExists(flow.rid)).toBe(false);
    expect(await tableCount(handle.sql, "mcp_auth_codes")).toBe(0);
    expect(await tableCount(handle.sql, "mcp_grants")).toBe(0);
    expect(await sessionCountFor(flow.userId)).toBe(0);
    // 正常拒绝不是 metadata 拒绝：无该审计。
    expect(await metadataAudits(flow.rid)).toHaveLength(0);
  });

  it("测试 D：空 scope 正常路径 → 302 access_denied、不签发、行已删", async () => {
    const flow = await startConsentFlow(h);

    const res = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: [],
    });

    expect(res.status).toBe(302);
    const params = redirectParams(res);
    expect(params.get("error")).toBe("access_denied");
    expect(params.get("state")).toBe("client-state-1");
    expect(params.get("code")).toBeNull();

    expect(await authRequestExists(flow.rid)).toBe(false);
    expect(await tableCount(handle.sql, "mcp_auth_codes")).toBe(0);
    expect(await tableCount(handle.sql, "mcp_grants")).toBe(0);
    expect(await sessionCountFor(flow.userId)).toBe(0);
    expect(await metadataAudits(flow.rid)).toHaveLength(0);
  });
});
