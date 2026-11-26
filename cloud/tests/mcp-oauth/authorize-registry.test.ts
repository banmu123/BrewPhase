import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import {
  authorizeQuery,
  createMcpOAuthHarness,
  seedAuthorizeClient,
  type McpOAuthHarness,
} from "../helpers/mcp-oauth-app.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import { processWideSingleflight } from "../../src/mcp-oauth/cimd-registry.js";
import type { CimdFetcherDeps, CimdTransportResponse } from "../../src/mcp-oauth/cimd.js";

/**
 * Authorize × CIMD Registry 接入（Phase 1.3.1-C3c-3B-3，任务书 §5 / §8.2）。
 *
 * 被测的是 `GET /mcp/oauth/authorize` 的**新顺序**：
 * 语法预检 → Registry（长度 → 精确查库 → 身份冲突 / 四态 / 抓取注册）→
 * 参数校验 → 建行。三条硬约束：
 *
 * 1. **先查库、再判 URL 形态**（不透明预注册 id 不得被误拒）；
 * 2. Registry 失败 → **HTML 错误页、不重定向、不建 auth request**；
 * 3. 错误页**不回显完整 client_id URL**（只显示 hostname / 截断形式）。
 *
 * 抓取器全部注入（`ctx.cimdFetcher`），断言抓取次数——不打真实 DNS。
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

async function authRequestCount(): Promise<number> {
  const rows = await handle.sql<{ n: string }[]>`select count(*)::text as n from mcp_auth_requests`;
  return Number(rows[0]?.n ?? 0);
}

async function clientRowCount(clientId: string): Promise<number> {
  const rows = await handle.sql<{ n: string }[]>`
    select count(*)::text as n from mcp_oauth_clients where client_id = ${clientId}`;
  return Number(rows[0]?.n ?? 0);
}

async function get(query: string): Promise<Response> {
  return h.app.request(`/mcp/oauth/authorize?${query}`, { method: "GET" });
}

function jsonResponse(doc: unknown): CimdTransportResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(doc), "utf8"),
    bodyTooLarge: false,
  };
}

/** 直接给 harness 换一个抓取器（registryDeps 按请求读 `ctx.cimdFetcher`）。 */
function withFetcher(fetcher: CimdFetcherDeps): McpOAuthHarness {
  h.ctx.cimdFetcher = fetcher;
  return h;
}

const CIMD_URL = "https://newclient.example/meta.json";

function cimdDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: CIMD_URL,
    client_name: "New CIMD Client",
    redirect_uris: ["https://client.example/callback"],
    grant_types: ["authorization_code"],
    ...overrides,
  };
}

async function seedCimdRow(
  clientId: string,
  opts: { expiresAt: Date; fetchedAt: Date; version?: number } = { expiresAt: new Date(), fetchedAt: new Date() },
): Promise<void> {
  await handle.sql`
    insert into mcp_oauth_clients
      (client_id, client_name, redirect_uris, grant_types, token_endpoint_auth_method,
       registration_source, metadata_fetched_at, metadata_cache_expires_at, metadata_version)
    values (
      ${clientId}, 'Seeded CIMD', array['https://client.example/callback'],
      array['authorization_code'], 'none', 'cimd',
      ${opts.fetchedAt.toISOString()}::timestamptz,
      ${opts.expiresAt.toISOString()}::timestamptz,
      ${opts.version ?? 1}
    )
    on conflict (client_id) do nothing`;
}

// ---------------------------------------------------------------------------
// 注册行为接入
// ---------------------------------------------------------------------------

describe("authorize 接入 Registry：查找顺序", () => {
  it("预注册不透明 ID 正常通过：302，且零网络（不判 URL 形态）", async () => {
    let requestCount = 0;
    withFetcher({
      resolve: async () => [{ address: "93.184.216.34", family: 4 as const }],
      request: async () => {
        requestCount += 1;
        return jsonResponse(cimdDoc());
      },
      now: () => new Date(),
      monotonic: () => 0,
    });

    const res = await get(authorizeQuery());
    expect(res.status).toBe(302);
    expect(requestCount).toBe(0);
    expect(await authRequestCount()).toBe(1);
  });

  it("URL 形态预注册 ID 等于 issuer → 身份冲突：400 HTML、不联网、不建行", async () => {
    await seedAuthorizeClient(handle, { clientId: "https://gateway.example" });
    let requestCount = 0;
    withFetcher({
      resolve: async () => {
        requestCount += 1;
        return [{ address: "93.184.216.34", family: 4 as const }];
      },
      request: async () => jsonResponse(cimdDoc()),
      now: () => new Date(),
      monotonic: () => 0,
    });

    const res = await get(authorizeQuery({ client_id: "https://gateway.example" }));
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    expect(res.headers.get("location")).toBeNull();
    const body = await res.text();
    expect(body).toContain("无法验证该客户端");
    expect(requestCount).toBe(0); // 冲突检查在 DNS 之前，零网络
    expect(await authRequestCount()).toBe(0);
  });

  it("未注册 URL Client Identifier → 抓取并首次注册（version=1、source=cimd）后 302", async () => {
    let requestCount = 0;
    withFetcher({
      resolve: async () => [{ address: "93.184.216.34", family: 4 as const }],
      request: async () => {
        requestCount += 1;
        return jsonResponse(cimdDoc());
      },
      now: () => new Date(),
      monotonic: () => 0,
    });

    const res = await get(authorizeQuery({ client_id: CIMD_URL }));
    expect(res.status).toBe(302);
    expect(requestCount).toBe(1);
    expect(await clientRowCount(CIMD_URL)).toBe(1);
    const rows = await handle.sql<{ source: string; v: string }[]>`
      select registration_source as source, metadata_version::text as v
        from mcp_oauth_clients where client_id = ${CIMD_URL}`;
    expect(rows[0]?.source).toBe("cimd");
    expect(Number(rows[0]?.v)).toBe(1);
    expect(await authRequestCount()).toBe(1);
  });

  it("FRESH 缓存命中：直接 302，不重新抓取", async () => {
    await seedCimdRow(CIMD_URL, {
      expiresAt: new Date(Date.now() + 3600_000),
      fetchedAt: new Date(),
    });
    let requestCount = 0;
    withFetcher({
      resolve: async () => {
        requestCount += 1;
        return [{ address: "93.184.216.34", family: 4 as const }];
      },
      request: async () => jsonResponse(cimdDoc()),
      now: () => new Date(),
      monotonic: () => 0,
    });

    const res = await get(authorizeQuery({ client_id: CIMD_URL }));
    expect(res.status).toBe(302);
    expect(requestCount).toBe(0);
    expect(await authRequestCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Registry 失败 → HTML、不建行
// ---------------------------------------------------------------------------

describe("authorize 接入 Registry：失败处置（§5.3 / §8.5 边界一）", () => {
  it("STALE floor 内 → 503 HTML，不发网络、不建 auth request", async () => {
    await seedCimdRow(CIMD_URL, {
      expiresAt: new Date(Date.now() - 1000),
      fetchedAt: new Date(Date.now() - 5000), // 距 floor 还有 25s
    });
    let requestCount = 0;
    withFetcher({
      resolve: async () => {
        requestCount += 1;
        return [{ address: "93.184.216.34", family: 4 as const }];
      },
      request: async () => jsonResponse(cimdDoc()),
      now: () => new Date(),
      monotonic: () => 0,
    });

    const res = await get(authorizeQuery({ client_id: CIMD_URL }));
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("暂时无法验证该客户端");
    expect(requestCount).toBe(0);
    expect(await authRequestCount()).toBe(0);
  });

  it("INVALID floor 内 → 400 HTML，不发网络、不建 auth request", async () => {
    await seedCimdRow(CIMD_URL, {
      expiresAt: new Date(0), // epoch 哨兵
      fetchedAt: new Date(Date.now() - 5000),
    });
    let requestCount = 0;
    withFetcher({
      resolve: async () => {
        requestCount += 1;
        return [{ address: "93.184.216.34", family: 4 as const }];
      },
      request: async () => jsonResponse(cimdDoc()),
      now: () => new Date(),
      monotonic: () => 0,
    });

    const res = await get(authorizeQuery({ client_id: CIMD_URL }));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("无法验证该客户端");
    expect(requestCount).toBe(0);
    expect(await authRequestCount()).toBe(0);
    expect(await clientRowCount(CIMD_URL)).toBe(1); // 行原样保留
  });

  it("未注册 URL 抓到 terminal（malformed 文档）→ 400 HTML，零注册行、零 auth request", async () => {
    const malformed: CimdTransportResponse = {
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from("{not json", "utf8"),
      bodyTooLarge: false,
    };
    withFetcher({
      resolve: async () => [{ address: "93.184.216.34", family: 4 as const }],
      request: async () => malformed,
      now: () => new Date(),
      monotonic: () => 0,
    });

    const res = await get(authorizeQuery({ client_id: CIMD_URL }));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("无法验证该客户端");
    expect(await clientRowCount(CIMD_URL)).toBe(0); // ABSENT terminal 不落行
    expect(await authRequestCount()).toBe(0);
  });

  it("未注册 URL 抓到 transient（HTTP 503）→ 503 HTML，零注册行、零 auth request", async () => {
    const unavailable: CimdTransportResponse = {
      status: 503,
      headers: { "content-type": "text/plain" },
      body: Buffer.from("unavailable", "utf8"),
      bodyTooLarge: false,
    };
    withFetcher({
      resolve: async () => [{ address: "93.184.216.34", family: 4 as const }],
      request: async () => unavailable,
      now: () => new Date(),
      monotonic: () => 0,
    });

    const res = await get(authorizeQuery({ client_id: CIMD_URL }));
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("暂时无法验证该客户端");
    expect(await clientRowCount(CIMD_URL)).toBe(0);
    expect(await authRequestCount()).toBe(0);
  });

  it("错误页不回显完整 client_id URL（只显示 hostname，路径 / 查询串不出现）", async () => {
    const evil = "https://evil.example.com/secret/path?token=XYZSECRET";
    const notFound: CimdTransportResponse = {
      status: 404,
      headers: { "content-type": "text/plain" },
      body: Buffer.from("gone", "utf8"),
      bodyTooLarge: false,
    };
    withFetcher({
      resolve: async () => [{ address: "93.184.216.34", family: 4 as const }],
      request: async () => notFound,
      now: () => new Date(),
      monotonic: () => 0,
    });

    const res = await get(
      authorizeQuery({ client_id: evil, redirect_uri: "https://client.example/callback" }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    expect(res.headers.get("location")).toBeNull();
    const body = await res.text();
    expect(body).toContain("evil.example.com"); // 允许 hostname
    expect(body).not.toContain(evil); // 完整 URL 绝不出现
    expect(body).not.toContain("secret/path");
    expect(body).not.toContain("XYZSECRET");
    expect(await authRequestCount()).toBe(0);
  });

  it("参数错误（response_type / 缺 client_id）仍是 JSON invalid_request，且不触发抓取", async () => {
    let requestCount = 0;
    withFetcher({
      resolve: async () => {
        requestCount += 1;
        return [{ address: "93.184.216.34", family: 4 as const }];
      },
      request: async () => jsonResponse(cimdDoc()),
      now: () => new Date(),
      monotonic: () => 0,
    });

    const badType = await get(authorizeQuery({ response_type: "token" }));
    expect(badType.status).toBe(400);
    expect(badType.headers.get("content-type") ?? "").toContain("application/json");

    const missing = await get(authorizeQuery({ client_id: undefined }));
    expect(missing.status).toBe(400);
    expect(missing.headers.get("content-type") ?? "").toContain("application/json");
    expect(requestCount).toBe(0);
    expect(await authRequestCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 路由级 CAS：并发同 client 只建一条 auth request
// ---------------------------------------------------------------------------

describe("authorize 接入 Registry：并发与 CAS", () => {
  it("两个并发 authorize（同 STALE client）：一次抓取、恰一条 auth request、输家 503", async () => {
    await seedCimdRow(CIMD_URL, {
      expiresAt: new Date(Date.now() - 1000),
      fetchedAt: new Date(Date.now() - 31_000), // floor 已过 → 允许抓取
    });

    let requestCount = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const startedPromise = new Promise<void>((r) => (started = r));
    withFetcher({
      resolve: async () => [{ address: "93.184.216.34", family: 4 as const }],
      request: async () => {
        requestCount += 1;
        started();
        await gate; // 让第二个请求先读到同一版本并 join singleflight
        return jsonResponse(cimdDoc());
      },
      now: () => new Date(),
      monotonic: () => 0,
    });

    const pA = get(authorizeQuery({ client_id: CIMD_URL }));
    await startedPromise; // A 已进入抓取（已读行）
    const pB = get(authorizeQuery({ client_id: CIMD_URL }));
    // B 读到同一版本后 join 进程级 singleflight（共享同一次抓取）。
    const deadline = Date.now() + 4000;
    while (processWideSingleflight.waiterCount(CIMD_URL) < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(processWideSingleflight.waiterCount(CIMD_URL)).toBe(1);
    release();

    const [a, b] = await Promise.all([pA, pB]);
    const statuses = [a.status, b.status].sort();
    expect(requestCount).toBe(1); // singleflight 合并了抓取
    expect(statuses).toEqual([302, 503]); // 输家 CAS 失败 → 503 fail-closed
    const failed = a.status === 503 ? a : b;
    expect(failed.headers.get("location")).toBeNull();
    expect(await failed.text()).toContain("暂时无法验证该客户端");
    // 恰好一条 auth request（赢家建行，输家不建）。
    expect(await authRequestCount()).toBe(1);
    expect(processWideSingleflight.size).toBe(0); // 完成即清理
    const rows = await handle.sql<{ v: string }[]>`
      select metadata_version::text as v from mcp_oauth_clients where client_id = ${CIMD_URL}`;
    expect(Number(rows[0]?.v)).toBe(2);
  });
});
