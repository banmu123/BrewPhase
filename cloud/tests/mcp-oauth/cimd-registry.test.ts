import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import { mcpOauthClients } from "../../src/db/schema.js";
import { mcpResourceFor } from "../../src/mcp-oauth/constants.js";
import type * as AuditModule from "../../src/db/audit.js";
import type { AuthEventInput } from "../../src/db/audit.js";
import type { CimdFetcherDeps, CimdTransportResponse } from "../../src/mcp-oauth/cimd.js";
import {
  CIMD_FETCH_FLOOR_MS,
  InMemoryNegativeCooldown,
  NEGATIVE_COOLDOWN_MAX_ENTRIES,
  auditEventForCimdFailure,
  resolveClientForAuthorize,
  type CimdRegistryDeps,
  type NegativeCooldownStore,
} from "../../src/mcp-oauth/cimd-registry.js";

/**
 * CIMD Registry（Phase 1.3.1-C3c-3B-2）。
 *
 * **全程真实 PostgreSQL**：CAS 竞争用真行锁 + `pg_stat_activity` /
 * `pg_blocking_pids` 断言，不用 mock 模拟两个请求的顺序。网络、时钟、冷却、
 * 审计全部注入可替换。
 *
 * 覆盖任务书 §六的五组：注册行为、缓存行为、CAS 竞争、Grant/Session 撤销、
 * 负面冷却。
 */

const ISSUER = "https://cloud.example.com";
const RESOURCE = mcpResourceFor(ISSUER);
const PUBLIC_V4 = "93.184.216.34";
const CLIENT_URL = "https://client.example.com/oauth/client.json";
const OPAQUE_ID = "brewphase-desktop";

/** `no-store` 文档里埋的哨兵：冷却快照绝不能含它（§8.5 边界三）。 */
const NO_STORE_BODY_SENTINEL = "SECRET-NO-STORE-BODY-SENTINEL";

// ---------------------------------------------------------------------------
// 注入的审计失败开关（供「审计失败 → 整体 rollback」用例）
// ---------------------------------------------------------------------------

const injectedAuditFailure = vi.hoisted(() => ({ enabled: false }));

vi.mock("../../src/db/audit.js", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof AuditModule;
  return {
    ...actual,
    recordAuthEvent: vi.fn(
      async (
        db: Parameters<typeof AuditModule.recordAuthEvent>[0],
        input: Parameters<typeof AuditModule.recordAuthEvent>[1],
      ) => {
        if (injectedAuditFailure.enabled && input.eventType === "mcp_client_id_mismatch") {
          throw new Error("injected audit failure");
        }
        return actual.recordAuthEvent(db, input);
      },
    ),
  };
});

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------

function makeClock(startIso = "2026-11-20T10:00:00.000Z") {
  let current = new Date(startIso).getTime();
  return {
    now: (): Date => new Date(current),
    advance: (ms: number): void => {
      current += ms;
    },
  };
}

function validDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: CLIENT_URL,
    client_name: "Example Client",
    redirect_uris: ["https://client.example.com/callback"],
    ...overrides,
  };
}

function jsonResponse(doc: unknown): CimdTransportResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(doc), "utf8"),
    bodyTooLarge: false,
  };
}

interface InstantFetcher {
  deps: CimdFetcherDeps;
  resolve: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
}

function instantFetcher(
  clock: { now: () => Date },
  options: { doc?: unknown; response?: CimdTransportResponse; error?: Error } = {},
): InstantFetcher {
  const resolve = vi.fn(async () => [{ address: PUBLIC_V4, family: 4 as const }]);
  const request = vi.fn(async () => {
    if (options.error) throw options.error;
    return options.response ?? jsonResponse(options.doc ?? validDoc());
  });
  return {
    deps: { resolve, request, now: clock.now, monotonic: () => 0 },
    resolve,
    request,
  };
}

/** 阻塞式 fetcher：`request` 挂在 gate 上，直到 `release()`。 */
function blockableFetcher(
  clock: { now: () => Date },
  response: CimdTransportResponse,
): { deps: CimdFetcherDeps; started: Promise<void>; release: () => void; request: ReturnType<typeof vi.fn> } {
  let releaseFn!: () => void;
  const gate = new Promise<void>((r) => (releaseFn = r));
  let signalStarted!: () => void;
  const started = new Promise<void>((r) => (signalStarted = r));
  const resolve = vi.fn(async () => {
    signalStarted();
    return [{ address: PUBLIC_V4, family: 4 as const }];
  });
  const request = vi.fn(async () => {
    await gate;
    return response;
  });
  return { deps: { resolve, request, now: clock.now, monotonic: () => 0 }, started, release: () => releaseFn(), request };
}

/** 屏障式 fetcher：第 N 次调用才放行，保证两个请求都先读到同一版本。 */
function barrierFetcher(
  clock: { now: () => Date },
  responses: CimdTransportResponse[],
): { deps: CimdFetcherDeps; release: () => void; request: ReturnType<typeof vi.fn> } {
  let idx = 0;
  let arrived = 0;
  let releaseFn!: () => void;
  const gate = new Promise<void>((r) => (releaseFn = r));
  const resolve = vi.fn(async () => [{ address: PUBLIC_V4, family: 4 as const }]);
  const request = vi.fn(async () => {
    const response = responses[idx++] ?? responses[responses.length - 1]!;
    arrived += 1;
    if (arrived >= responses.length) releaseFn();
    await gate;
    return response;
  });
  return { deps: { resolve, request, now: clock.now, monotonic: () => 0 }, release: () => releaseFn(), request };
}

const handle = await getTestDb();

function makeDeps(
  fetcher: CimdFetcherDeps,
  clock: { now: () => Date },
  cooldown: NegativeCooldownStore,
  audit: (input: AuthEventInput) => Promise<void>,
): CimdRegistryDeps {
  return {
    db: handle.db,
    fetcher,
    baseUrl: ISSUER,
    mcpResource: RESOURCE,
    mcpTrustedPeerIdentifiers: [],
    now: clock.now,
    cooldown,
    audit,
  };
}

function makeAuditSpy() {
  return vi.fn(async (_input: AuthEventInput): Promise<void> => undefined);
}

// ---------------------------------------------------------------------------
// 数据库原语
// ---------------------------------------------------------------------------

async function seedCimdClient(
  clientId: string,
  opts: {
    version?: number;
    fetchedAt?: Date | null;
    expiresAt?: Date | null;
    clientName?: string;
  } = {},
): Promise<void> {
  await handle.sql`
    insert into mcp_oauth_clients
      (client_id, client_name, redirect_uris, grant_types, token_endpoint_auth_method,
       registration_source, metadata_fetched_at, metadata_cache_expires_at, metadata_version)
    values (
      ${clientId}, ${opts.clientName ?? "Seeded"}, array['https://client.example.com/callback'],
      array['authorization_code'], 'none', 'cimd',
      ${opts.fetchedAt ? opts.fetchedAt.toISOString() : null}::timestamptz,
      ${opts.expiresAt ? opts.expiresAt.toISOString() : null}::timestamptz,
      ${opts.version ?? 1}
    )`;
}

async function seedPreRegistered(
  clientId: string,
  source: "pre_registered" | "dcr" = "pre_registered",
): Promise<void> {
  await handle.sql`
    insert into mcp_oauth_clients
      (client_id, client_name, redirect_uris, grant_types, token_endpoint_auth_method,
       registration_source, metadata_version)
    values (
      ${clientId}, 'Pre', array['https://client.example.com/callback'],
      array['authorization_code'], 'none', ${source}, 1
    )`;
}

async function seedUserAndGrant(
  clientId: string,
  opts: { userSuffix?: string; resource?: string } = {},
): Promise<{ userId: string; grantId: string }> {
  const userRows = await handle.sql<{ id: string }[]>`
    insert into users (display_name) values (${"reg-" + (opts.userSuffix ?? Math.random().toString(36).slice(2))}) returning id`;
  const userId = userRows[0]!.id;
  const grantRows = await handle.sql<{ id: string }[]>`
    insert into mcp_grants (user_id, client_id, client_name, scopes, resource, epoch)
    values (${userId}, ${clientId}, 'Reg', array['records:read'], ${opts.resource ?? RESOURCE}, 1)
    returning id`;
  return { userId, grantId: grantRows[0]!.id };
}

async function seedSession(userId: string, grantId: string, clientId: string): Promise<string> {
  const rows = await handle.sql<{ id: string }[]>`
    insert into mcp_sessions
      (user_id, grant_id, client_id, issued_scope, resource, absolute_expires_at)
    values (${userId}, ${grantId}, ${clientId}, array['records:read'], ${RESOURCE}, now() + interval '90 days')
    returning id`;
  return rows[0]!.id;
}

async function versionOf(clientId: string): Promise<number> {
  const rows = await handle.db
    .select({ v: mcpOauthClients.metadataVersion })
    .from(mcpOauthClients)
    .where(eq(mcpOauthClients.clientId, clientId));
  return rows[0]?.v as number;
}

async function rowOf(clientId: string) {
  const rows = await handle.sql<{
    metadata_version: string;
    metadata_cache_expires_at: Date | null;
    metadata_fetched_at: Date | null;
  }[]>`
    select metadata_version, metadata_cache_expires_at, metadata_fetched_at
      from mcp_oauth_clients where client_id = ${clientId}`;
  return rows[0];
}

async function grantStates(clientId: string): Promise<{ total: number; revoked: number }> {
  const rows = await handle.sql<{ total: string; revoked: string }[]>`
    select count(*)::text as total,
           count(*) filter (where revoked_at is not null)::text as revoked
      from mcp_grants where client_id = ${clientId}`;
  return { total: Number(rows[0]?.total ?? 0), revoked: Number(rows[0]?.revoked ?? 0) };
}

async function sessionStates(clientId: string): Promise<{ total: number; revoked: number }> {
  const rows = await handle.sql<{ total: string; revoked: string }[]>`
    select count(*)::text as total,
           count(*) filter (where revoked_at is not null)::text as revoked
      from mcp_sessions where client_id = ${clientId}`;
  return { total: Number(rows[0]?.total ?? 0), revoked: Number(rows[0]?.revoked ?? 0) };
}

async function mismatchAuditCount(clientId: string): Promise<number> {
  const rows = await handle.sql<{ n: string }[]>`
    select count(*)::text as n from auth_events
     where event_type = 'mcp_client_id_mismatch' and detail->>'clientId' = ${clientId}`;
  return Number(rows[0]?.n ?? 0);
}

/** 轮询直到出现等待 `mcp_oauth_clients` 行锁的后端（真实锁等待，不是 sleep）。 */
async function waitForLockWaiter(timeoutMs = 4000): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await handle.sql<Record<string, unknown>[]>`
      select pid, wait_event_type, pg_blocking_pids(pid) as blockers, left(query, 160) as q
        from pg_stat_activity
       where pid <> pg_backend_pid()
         and wait_event_type = 'Lock'
         and query ilike '%mcp_oauth_clients%'`;
    if (rows.length > 0) return rows[0]!;
    await sleep(50);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 手工开一个事务：把目标行的 version +1 并**持锁不提交**（制造真实锁等待）。 */
async function holdVersionBump(clientId: string): Promise<{ release: () => Promise<void> }> {
  let releaseFn!: () => void;
  const gate = new Promise<void>((r) => (releaseFn = r));
  let signalLocked!: () => void;
  const locked = new Promise<void>((r) => (signalLocked = r));
  const tx = handle.sql
    .begin(async (t) => {
      await t`update mcp_oauth_clients set metadata_version = metadata_version + 1 where client_id = ${clientId}`;
      signalLocked();
      await gate;
    })
    .catch(() => undefined);
  await locked;
  return {
    release: async () => {
      releaseFn();
      await tx;
    },
  };
}

beforeEach(async () => {
  await ensureDatabaseOrThrow();
  await resetDb(handle);
  injectedAuditFailure.enabled = false;
});

afterAll(async () => {
  await closeTestDb();
});

/* ========================================================================== *
 * 1. 注册行为
 * ========================================================================== */

describe("注册行为", () => {
  it("预注册不透明 ID 正常通过（不判 URL 形态、零网络）", async () => {
    await seedPreRegistered(OPAQUE_ID);
    const clock = makeClock();
    const fetcher = instantFetcher(clock);
    const result = await resolveClientForAuthorize(
      OPAQUE_ID,
      makeDeps(fetcher.deps, clock, new InMemoryNegativeCooldown(), makeAuditSpy()),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.client.registrationSource).toBe("pre_registered");
    expect(result.client.cacheState).toBe("authoritative");
    expect(fetcher.resolve).not.toHaveBeenCalled();
    expect(fetcher.request).not.toHaveBeenCalled();
  });

  it("预注册 URL 形态 ID 等于 issuer → 身份冲突拒绝（不按来源绕过）", async () => {
    await seedPreRegistered(ISSUER);
    const clock = makeClock();
    const fetcher = instantFetcher(clock);
    const audit = makeAuditSpy();
    const result = await resolveClientForAuthorize(
      ISSUER,
      makeDeps(fetcher.deps, clock, new InMemoryNegativeCooldown(), audit),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("client_id_conflict");
    expect(result.failure.status).toBe(400);
    // 身份冲突不联网。
    expect(fetcher.resolve).not.toHaveBeenCalled();
    // 审计走枚举映射，不是 detail 文本。
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "mcp_cimd_client_id_conflict" }),
    );
  });

  it("DCR 行不被 CIMD 覆盖：直接使用、不抓取、不改 registration_source", async () => {
    await seedPreRegistered("dcr-client-1", "dcr");
    const clock = makeClock();
    const fetcher = instantFetcher(clock);
    const result = await resolveClientForAuthorize(
      "dcr-client-1",
      makeDeps(fetcher.deps, clock, new InMemoryNegativeCooldown(), makeAuditSpy()),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.client.registrationSource).toBe("dcr");
    expect(fetcher.resolve).not.toHaveBeenCalled();
    const rows = await handle.sql<{ registration_source: string }[]>`
      select registration_source from mcp_oauth_clients where client_id = 'dcr-client-1'`;
    expect(rows[0]?.registration_source).toBe("dcr");
  });

  it("未注册非法 URL 不发 DNS、不发网络", async () => {
    const clock = makeClock();
    const fetcher = instantFetcher(clock);
    const result = await resolveClientForAuthorize(
      "http://client.example.com/x",
      makeDeps(fetcher.deps, clock, new InMemoryNegativeCooldown(), makeAuditSpy()),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("client_id_url");
    expect(fetcher.resolve).not.toHaveBeenCalled();
    expect(fetcher.request).not.toHaveBeenCalled();
  });

  it("未注册合法 URL → 抓取并注册（version=1、registration_source=cimd）", async () => {
    const clock = makeClock();
    const fetcher = instantFetcher(clock);
    const audit = makeAuditSpy();
    const result = await resolveClientForAuthorize(
      CLIENT_URL,
      makeDeps(fetcher.deps, clock, new InMemoryNegativeCooldown(), audit),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.client.registrationSource).toBe("cimd");
    expect(result.client.metadataVersion).toBe(1);
    expect(fetcher.request).toHaveBeenCalledTimes(1);

    const row = await rowOf(CLIENT_URL);
    expect(Number(row?.metadata_version)).toBe(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "mcp_cimd_registered" }),
    );
  });

  it("长度边界：2048 通过（进入 URL 校验），2049 直接拒绝且不查库", async () => {
    const clock = makeClock();
    const fetcher = instantFetcher(clock);
    const deps = makeDeps(fetcher.deps, clock, new InMemoryNegativeCooldown(), makeAuditSpy());

    const prefix = "https://client.example.com/";
    const atLimit = prefix + "a".repeat(2048 - prefix.length); // 恰好 2048
    expect(atLimit.length).toBe(2048);
    const tooLong = atLimit + "a"; // 2049
    expect(tooLong.length).toBe(2049);

    const r2049 = await resolveClientForAuthorize(tooLong, deps);
    expect(r2049.ok).toBe(false);
    if (!r2049.ok) expect(r2049.failure.reason).toBe("client_id_too_long");
    expect(fetcher.resolve).not.toHaveBeenCalled();

    // 2048 不是 too_long（会继续走 URL 形态校验；这里断言 reason 不是 too_long）。
    const r2048 = await resolveClientForAuthorize(atLimit, deps);
    expect(r2048.ok).toBe(false);
    if (!r2048.ok) expect(r2048.failure.reason).not.toBe("client_id_too_long");
  });
});

/* ========================================================================== *
 * 2. 缓存行为
 * ========================================================================== */

describe("缓存行为", () => {
  it("FRESH 直接使用缓存，不重新抓取", async () => {
    const clock = makeClock();
    await seedCimdClient(CLIENT_URL, {
      version: 1,
      fetchedAt: clock.now(),
      expiresAt: new Date(clock.now().getTime() + 3600_000),
    });
    const fetcher = instantFetcher(clock);
    const result = await resolveClientForAuthorize(
      CLIENT_URL,
      makeDeps(fetcher.deps, clock, new InMemoryNegativeCooldown(), makeAuditSpy()),
    );
    expect(result.ok).toBe(true);
    expect(fetcher.resolve).not.toHaveBeenCalled();
    expect(fetcher.request).not.toHaveBeenCalled();
    expect(await versionOf(CLIENT_URL)).toBe(1);
  });

  it("STALE 超过 floor → 重新抓取并 CAS 刷新", async () => {
    const clock = makeClock();
    await seedCimdClient(CLIENT_URL, {
      version: 1,
      fetchedAt: new Date(clock.now().getTime() - CIMD_FETCH_FLOOR_MS - 1000),
      expiresAt: new Date(clock.now().getTime() - 1000),
    });
    const fetcher = instantFetcher(clock);
    const audit = makeAuditSpy();
    const result = await resolveClientForAuthorize(
      CLIENT_URL,
      makeDeps(fetcher.deps, clock, new InMemoryNegativeCooldown(), audit),
    );
    expect(result.ok).toBe(true);
    expect(fetcher.request).toHaveBeenCalledTimes(1);
    expect(await versionOf(CLIENT_URL)).toBe(2);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: "mcp_cimd_refreshed" }));
  });

  it("STALE 未过 floor → 503 transient，不发网络、不写时间戳", async () => {
    const clock = makeClock();
    const fetchedAt = new Date(clock.now().getTime() - 5000);
    await seedCimdClient(CLIENT_URL, {
      version: 1,
      fetchedAt,
      expiresAt: new Date(clock.now().getTime() - 1000),
    });
    const fetcher = instantFetcher(clock);
    const result = await resolveClientForAuthorize(
      CLIENT_URL,
      makeDeps(fetcher.deps, clock, new InMemoryNegativeCooldown(), makeAuditSpy()),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("cache_stale_cooldown");
    expect(result.failure.status).toBe(503);
    expect(fetcher.resolve).not.toHaveBeenCalled();
    // 不写 metadata_fetched_at（floor 只约束网络，不推进时间戳）。
    const row = await rowOf(CLIENT_URL);
    expect(new Date(row!.metadata_fetched_at!).getTime()).toBe(fetchedAt.getTime());
    expect(await versionOf(CLIENT_URL)).toBe(1);
  });

  it("INVALID 未过 floor → 400 terminal，不发网络", async () => {
    const clock = makeClock();
    await seedCimdClient(CLIENT_URL, {
      version: 2,
      fetchedAt: new Date(clock.now().getTime() - 5000),
      expiresAt: new Date(0),
    });
    const fetcher = instantFetcher(clock);
    const result = await resolveClientForAuthorize(
      CLIENT_URL,
      makeDeps(fetcher.deps, clock, new InMemoryNegativeCooldown(), makeAuditSpy()),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("cache_invalid_cooldown");
    expect(result.failure.status).toBe(400);
    expect(fetcher.resolve).not.toHaveBeenCalled();
    expect(await versionOf(CLIENT_URL)).toBe(2);
  });

  it("INVALID 超过 floor → 重新抓取，成功后恢复 FRESH（唯一自愈路径）", async () => {
    const clock = makeClock();
    await seedCimdClient(CLIENT_URL, {
      version: 3,
      fetchedAt: new Date(clock.now().getTime() - CIMD_FETCH_FLOOR_MS - 1000),
      expiresAt: new Date(0),
    });
    const fetcher = instantFetcher(clock);
    const result = await resolveClientForAuthorize(
      CLIENT_URL,
      makeDeps(fetcher.deps, clock, new InMemoryNegativeCooldown(), makeAuditSpy()),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.client.cacheState).toBe("fresh");
    expect(await versionOf(CLIENT_URL)).toBe(4);
    const row = await rowOf(CLIENT_URL);
    expect(new Date(row!.metadata_cache_expires_at!).getTime()).not.toBe(0);
  });

  it("no-cache（ttl=0）：每次重新授权都要重新抓取", async () => {
    const clock = makeClock();
    // ttl=0 → expires = fetched_at → 立即 STALE。
    await seedCimdClient(CLIENT_URL, {
      version: 1,
      fetchedAt: new Date(clock.now().getTime() - CIMD_FETCH_FLOOR_MS - 1000),
      expiresAt: new Date(clock.now().getTime() - CIMD_FETCH_FLOOR_MS - 1000),
    });
    // no-cache 文档：Cache-Control: no-cache → ttl 0。
    const noCacheResponse: CimdTransportResponse = {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-cache" },
      body: Buffer.from(JSON.stringify(validDoc()), "utf8"),
      bodyTooLarge: false,
    };
    const deps = makeDeps(
      { ...instantFetcher(clock).deps, request: async () => noCacheResponse },
      clock,
      new InMemoryNegativeCooldown(),
      makeAuditSpy(),
    );

    const first = await resolveClientForAuthorize(CLIENT_URL, deps);
    expect(first.ok).toBe(true);
    expect(await versionOf(CLIENT_URL)).toBe(2);

    // 立刻再来一次：floor 未过 → 503（no-cache 永久 STALE）。
    clock.advance(1000);
    const second = await resolveClientForAuthorize(CLIENT_URL, deps);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.failure.reason).toBe("cache_stale_cooldown");

    // floor 过了 → 再抓一次（每次授权都要抓）。
    clock.advance(CIMD_FETCH_FLOOR_MS + 1000);
    const third = await resolveClientForAuthorize(CLIENT_URL, deps);
    expect(third.ok).toBe(true);
    expect(await versionOf(CLIENT_URL)).toBe(3);
  });

  it("no-store 不落数据库（ABSENT 时零行）", async () => {
    const clock = makeClock();
    const noStore: CimdTransportResponse = {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: Buffer.from(JSON.stringify(validDoc()), "utf8"),
      bodyTooLarge: false,
    };
    const fetcher = instantFetcher(clock, { response: noStore });
    const result = await resolveClientForAuthorize(
      CLIENT_URL,
      makeDeps(fetcher.deps, clock, new InMemoryNegativeCooldown(), makeAuditSpy()),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("client_registration_unsupported");
    const rows = await handle.sql<{ n: string }[]>`
      select count(*)::text as n from mcp_oauth_clients where client_id = ${CLIENT_URL}`;
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  });
});

/* ========================================================================== *
 * 3. CAS 竞争（真实 PostgreSQL 事务 + 行锁）
 * ========================================================================== */

describe("CAS 竞争（真实 PostgreSQL）", () => {
  async function seedStale(version = 1, clockNow = new Date()): Promise<void> {
    await seedCimdClient(CLIENT_URL, {
      version,
      fetchedAt: new Date(clockNow.getTime() - CIMD_FETCH_FLOOR_MS - 1000),
      expiresAt: new Date(clockNow.getTime() - 1000),
    });
  }

  it("两个请求同时读取同一版本 → 恰好一个赢得 CAS，另一个 503", async () => {
    const clock = makeClock();
    await seedStale(1, clock.now());
    // 屏障保证两个请求都先读到 version=1，再同时进入 CAS。
    const barrier = barrierFetcher(clock, [jsonResponse(validDoc()), jsonResponse(validDoc())]);
    const deps = makeDeps(barrier.deps, clock, new InMemoryNegativeCooldown(), makeAuditSpy());

    const [a, b] = await Promise.all([
      resolveClientForAuthorize(CLIENT_URL, deps),
      resolveClientForAuthorize(CLIENT_URL, deps),
    ]);

    const oks = [a, b].filter((r) => r.ok);
    const fails = [a, b].filter((r) => !r.ok);
    expect(oks).toHaveLength(1);
    expect(fails).toHaveLength(1);
    expect((fails[0] as { failure: { reason: string; status: number } }).failure.reason).toBe(
      "cas_superseded",
    );
    expect((fails[0] as { failure: { status: number } }).failure.status).toBe(503);
    expect(await versionOf(CLIENT_URL)).toBe(2);
  });

  it("成功 vs mismatch 并发：获胜者决定终态，失败者零写入", async () => {
    const clock = makeClock();
    await seedStale(1, clock.now());
    await seedUserAndGrant(CLIENT_URL);

    const mismatchDoc = validDoc({ client_id: "https://evil.example.com/x.json" });
    const barrier = barrierFetcher(clock, [jsonResponse(mismatchDoc), jsonResponse(validDoc())]);
    const deps = makeDeps(barrier.deps, clock, new InMemoryNegativeCooldown(), makeAuditSpy());

    const results = await Promise.all([
      resolveClientForAuthorize(CLIENT_URL, deps),
      resolveClientForAuthorize(CLIENT_URL, deps),
    ]);

    const row = await rowOf(CLIENT_URL);
    const isInvalid = new Date(row!.metadata_cache_expires_at!).getTime() === 0;
    const grants = await grantStates(CLIENT_URL);
    const audits = await mismatchAuditCount(CLIENT_URL);

    if (isInvalid) {
      // mismatch 赢：行 INVALID、Grant 全撤、成功方 503。
      expect(grants.total).toBeGreaterThan(0);
      expect(grants.revoked).toBe(grants.total);
      expect(audits).toBe(1);
      expect(results.some((r) => !r.ok && r.failure.reason === "cas_superseded")).toBe(true);
    } else {
      // 成功赢：行非 INVALID、Grant 未撤、mismatch 方 400 且零审计。
      expect(grants.revoked).toBe(0);
      expect(audits).toBe(0);
      expect(results.some((r) => !r.ok && r.failure.reason === "client_id_mismatch")).toBe(true);
    }
    expect(await versionOf(CLIENT_URL)).toBe(2);
  });

  it("INVALID 先提交、迟到的成功 → CAS 失败，INVALID 不复活", async () => {
    const clock = makeClock();
    await seedStale(1, clock.now());
    await seedUserAndGrant(CLIENT_URL);

    // A：成功抓取，阻塞在 fetch（已读到 version=1）。
    const blocker = blockableFetcher(clock, jsonResponse(validDoc()));
    const depsA = makeDeps(blocker.deps, clock, new InMemoryNegativeCooldown(), makeAuditSpy());
    const pA = resolveClientForAuthorize(CLIENT_URL, depsA);
    await blocker.started; // A 已完成读行、进入 fetch

    // B：mismatch 完整跑完（读 version=1 → CAS 命中 → INVALID + 撤销 → 提交）。
    const mismatchDoc = validDoc({ client_id: "https://evil.example.com/x.json" });
    const depsB = makeDeps(
      instantFetcher(clock, { doc: mismatchDoc }).deps,
      clock,
      new InMemoryNegativeCooldown(),
      makeAuditSpy(),
    );
    const b = await resolveClientForAuthorize(CLIENT_URL, depsB);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.failure.reason).toBe("client_id_mismatch");

    // 放行 A：其 CAS 基于旧版本 1 → 0 行。
    blocker.release();
    const a = await pA;
    expect(a.ok).toBe(false);
    if (!a.ok) {
      expect(a.failure.reason).toBe("cas_superseded");
      expect(a.failure.status).toBe(503);
    }

    // INVALID 存活、Grant 仍被撤销。
    const row = await rowOf(CLIENT_URL);
    expect(new Date(row!.metadata_cache_expires_at!).getTime()).toBe(0);
    expect(await versionOf(CLIENT_URL)).toBe(2);
    const grants = await grantStates(CLIENT_URL);
    expect(grants.revoked).toBe(grants.total);
    expect(await mismatchAuditCount(CLIENT_URL)).toBe(1);
  });

  it("成功先提交、迟到的 mismatch → CAS 失败，零撤销、零成功审计", async () => {
    const clock = makeClock();
    await seedStale(1, clock.now());
    await seedUserAndGrant(CLIENT_URL);

    // B：mismatch 阻塞在 fetch（已读 version=1）。
    const blocker = blockableFetcher(
      clock,
      jsonResponse(validDoc({ client_id: "https://evil.example.com/x.json" })),
    );
    const depsB = makeDeps(blocker.deps, clock, new InMemoryNegativeCooldown(), makeAuditSpy());
    const pB = resolveClientForAuthorize(CLIENT_URL, depsB);
    await blocker.started;

    // A：成功完整跑完（读 version=1 → CAS 命中 → FRESH → 提交）。
    const depsA = makeDeps(instantFetcher(clock).deps, clock, new InMemoryNegativeCooldown(), makeAuditSpy());
    const a = await resolveClientForAuthorize(CLIENT_URL, depsA);
    expect(a.ok).toBe(true);

    // 放行 B：其 CAS 基于旧版本 1 → 0 行 → 400，零 DB 写入。
    blocker.release();
    const b = await pB;
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.failure.reason).toBe("client_id_mismatch");

    // 行是 FRESH（非 INVALID）、Grant 未撤、无成功撤销审计。
    const row = await rowOf(CLIENT_URL);
    expect(new Date(row!.metadata_cache_expires_at!).getTime()).not.toBe(0);
    expect(await versionOf(CLIENT_URL)).toBe(2);
    const grants = await grantStates(CLIENT_URL);
    expect(grants.revoked).toBe(0);
    expect(await mismatchAuditCount(CLIENT_URL)).toBe(0);
  });

  it("malformed terminal vs 成功并发：终态由获胜者决定", async () => {
    const clock = makeClock();
    await seedStale(1, clock.now());

    const malformed: CimdTransportResponse = {
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from("{not json", "utf8"),
      bodyTooLarge: false,
    };
    const barrier = barrierFetcher(clock, [malformed, jsonResponse(validDoc())]);
    const deps = makeDeps(barrier.deps, clock, new InMemoryNegativeCooldown(), makeAuditSpy());

    const results = await Promise.all([
      resolveClientForAuthorize(CLIENT_URL, deps),
      resolveClientForAuthorize(CLIENT_URL, deps),
    ]);

    const row = await rowOf(CLIENT_URL);
    const isInvalid = new Date(row!.metadata_cache_expires_at!).getTime() === 0;
    const reasons = results
      .filter((r) => !r.ok)
      .map((r) => (r as { failure: { reason: string } }).failure.reason);

    // malformed 这一侧**永远**以自身原因拒绝（400，与 CAS 输赢无关）：
    // 赢了 → 写 INVALID 但当前请求仍失败；输了 → 零 DB 写入、仍按自身结果 400。
    expect(reasons).toContain("json");

    if (isInvalid) {
      // malformed 赢得 CAS → 行 INVALID；成功方 CAS 失败 → 503 fail-closed。
      expect(reasons).toContain("cas_superseded");
    } else {
      // 成功赢得 CAS → 行 FRESH；malformed 方 CAS 失败但仍按自身结果 400，
      // **不得**被改写成 cas_superseded，也**没有**写入任何状态。
      expect(reasons).not.toContain("cas_superseded");
    }
    expect(await versionOf(CLIENT_URL)).toBe(2);
  });

  it("删除行后的迟到请求不能重新 INSERT", async () => {
    const clock = makeClock();
    await seedStale(1, clock.now());

    const blocker = blockableFetcher(clock, jsonResponse(validDoc()));
    const deps = makeDeps(blocker.deps, clock, new InMemoryNegativeCooldown(), makeAuditSpy());
    const p = resolveClientForAuthorize(CLIENT_URL, deps);
    await blocker.started; // A 已读到行

    await handle.sql`delete from mcp_oauth_clients where client_id = ${CLIENT_URL}`;
    blocker.release();

    const result = await p;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("row_deleted");
    // 不重新 INSERT。
    const rows = await handle.sql<{ n: string }[]>`
      select count(*)::text as n from mcp_oauth_clients where client_id = ${CLIENT_URL}`;
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  });

  it("真实行锁：CAS 被持锁事务阻塞（pg_stat_activity 可观测），提交后 CAS 失败", async () => {
    const clock = makeClock();
    await seedStale(1, clock.now());

    // 手工事务：version +1 且**持锁不提交**。
    const holder = await holdVersionBump(CLIENT_URL);

    // A：instant fetch → 读到已提交的 version=1 → CAS 撞上持锁事务。
    const depsA = makeDeps(instantFetcher(clock).deps, clock, new InMemoryNegativeCooldown(), makeAuditSpy());
    const pA = resolveClientForAuthorize(CLIENT_URL, depsA);

    const waiter = await waitForLockWaiter(5000);
    expect(waiter, "应观测到等待 mcp_oauth_clients 行锁的后端").not.toBeNull();
    expect(Array.isArray(waiter!.blockers)).toBe(true);
    expect((waiter!.blockers as unknown[]).length).toBeGreaterThan(0);

    // 提交持锁事务（version 1 → 2）。
    await holder.release();
    const a = await pA;
    expect(a.ok).toBe(false);
    if (!a.ok) {
      expect(a.failure.reason).toBe("cas_superseded");
      expect(a.failure.status).toBe(503);
    }
    expect(await versionOf(CLIENT_URL)).toBe(2);
  });

  it("CAS 只影响目标 client_id：两个不同 client_id 使用相同版本互不影响", async () => {
    const clock = makeClock();
    const otherUrl = "https://other.example.com/oauth/client.json";
    await seedCimdClient(CLIENT_URL, {
      version: 1,
      fetchedAt: new Date(clock.now().getTime() - CIMD_FETCH_FLOOR_MS - 1000),
      expiresAt: new Date(clock.now().getTime() - 1000),
    });
    await seedCimdClient(otherUrl, {
      version: 1,
      fetchedAt: new Date(clock.now().getTime() - CIMD_FETCH_FLOOR_MS - 1000),
      expiresAt: new Date(clock.now().getTime() - 1000),
    });

    const fetcher = instantFetcher(clock);
    const deps = makeDeps(fetcher.deps, clock, new InMemoryNegativeCooldown(), makeAuditSpy());
    const result = await resolveClientForAuthorize(CLIENT_URL, deps);
    expect(result.ok).toBe(true);

    expect(await versionOf(CLIENT_URL)).toBe(2);
    expect(await versionOf(otherUrl)).toBe(1);
  });
});

/* ========================================================================== *
 * 4. Grant / Session 联动撤销
 * ========================================================================== */

describe("Grant / Session 联动撤销", () => {
  async function seedMismatchScenario(): Promise<{ url: string }> {
    const clock = makeClock();
    const url = "https://mismatch.example.com/oauth/client.json";
    await seedCimdClient(url, {
      version: 1,
      fetchedAt: new Date(clock.now().getTime() - CIMD_FETCH_FLOOR_MS - 1000),
      expiresAt: new Date(clock.now().getTime() - 1000),
    });
    const a = await seedUserAndGrant(url, { userSuffix: "u1" });
    await seedSession(a.userId, a.grantId, url);
    const b = await seedUserAndGrant(url, { userSuffix: "u2" });
    await seedSession(b.userId, b.grantId, url);
    return { url };
  }

  function mismatchFetcher(clock: { now: () => Date }): InstantFetcher {
    return instantFetcher(clock, {
      doc: validDoc({ client_id: "https://evil.example.com/x.json" }),
    });
  }

  it("mismatch：Grant 与 Session 都撤销、epoch 递增", async () => {
    const { url } = await seedMismatchScenario();
    const clock = makeClock();
    const fetcher = mismatchFetcher(clock);
    const result = await resolveClientForAuthorize(
      url,
      makeDeps(fetcher.deps, clock, new InMemoryNegativeCooldown(), makeAuditSpy()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("client_id_mismatch");

    const grants = await grantStates(url);
    expect(grants.total).toBe(2);
    expect(grants.revoked).toBe(2);
    const sessions = await sessionStates(url);
    expect(sessions.total).toBe(2);
    expect(sessions.revoked).toBe(2);

    // epoch 递增（撤销时 +1，初始为 1）。
    const epochs = await handle.sql<{ epoch: number }[]>`
      select epoch from mcp_grants where client_id = ${url}`;
    expect(epochs.map((r) => r.epoch)).toEqual([2, 2]);
  });

  it("跨 resource：同一 client 下不同 resource 的 Grant 都撤销", async () => {
    const clock = makeClock();
    const url = "https://multi.example.com/oauth/client.json";
    await seedCimdClient(url, {
      version: 1,
      fetchedAt: new Date(clock.now().getTime() - CIMD_FETCH_FLOOR_MS - 1000),
      expiresAt: new Date(clock.now().getTime() - 1000),
    });
    const a = await seedUserAndGrant(url, { resource: "https://gw1.example/mcp" });
    await seedUserAndGrant(url, { resource: "https://gw2.example/mcp" });

    const result = await resolveClientForAuthorize(
      url,
      makeDeps(mismatchFetcher(clock).deps, clock, new InMemoryNegativeCooldown(), makeAuditSpy()),
    );
    expect(result.ok).toBe(false);
    const grants = await grantStates(url);
    expect(grants.total).toBe(2);
    expect(grants.revoked).toBe(2);
    expect(a.grantId).toBeTruthy();
  });

  it("不影响其他 client 的 Grant / Session", async () => {
    const { url } = await seedMismatchScenario();
    const otherUrl = "https://innocent.example.com/oauth/client.json";
    await seedCimdClient(otherUrl, { version: 1 });
    const other = await seedUserAndGrant(otherUrl, { userSuffix: "other" });
    await seedSession(other.userId, other.grantId, otherUrl);

    const clock = makeClock();
    await resolveClientForAuthorize(
      url,
      makeDeps(mismatchFetcher(clock).deps, clock, new InMemoryNegativeCooldown(), makeAuditSpy()),
    );

    const otherGrants = await grantStates(otherUrl);
    expect(otherGrants.revoked).toBe(0);
    const otherSessions = await sessionStates(otherUrl);
    expect(otherSessions.revoked).toBe(0);
    expect(await versionOf(otherUrl)).toBe(1);
  });

  it("审计与撤销原子提交：一条聚合事件含两个计数", async () => {
    const { url } = await seedMismatchScenario();
    const clock = makeClock();
    await resolveClientForAuthorize(
      url,
      makeDeps(mismatchFetcher(clock).deps, clock, new InMemoryNegativeCooldown(), makeAuditSpy()),
    );

    const rows = await handle.sql<{ detail: Record<string, unknown>; user_id: string | null }[]>`
      select detail, user_id from auth_events where event_type = 'mcp_client_id_mismatch'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBeNull();
    expect(rows[0]?.detail.clientId).toBe(url);
    expect(rows[0]?.detail.reason).toBe("client_id_mismatch");
    expect(rows[0]?.detail.revokedGrantCount).toBe(2);
    expect(rows[0]?.detail.revokedSessionCount).toBe(2);
  });

  it("审计失败 → 整个事务 rollback（不标 INVALID、不撤销、无审计）", async () => {
    const { url } = await seedMismatchScenario();
    const clock = makeClock();
    injectedAuditFailure.enabled = true;

    const result = await resolveClientForAuthorize(
      url,
      makeDeps(mismatchFetcher(clock).deps, clock, new InMemoryNegativeCooldown(), makeAuditSpy()),
    );
    injectedAuditFailure.enabled = false;

    // CAS + 撤销 + 审计在同一事务：审计抛错 → 整体回滚。
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.status).toBe(500);

    const row = await rowOf(url);
    expect(Number(row?.metadata_version)).toBe(1); // 版本未推进
    expect(new Date(row!.metadata_cache_expires_at!).getTime()).not.toBe(0); // 未标 INVALID
    const grants = await grantStates(url);
    expect(grants.revoked).toBe(0); // 未撤销
    expect(await mismatchAuditCount(url)).toBe(0); // 无审计
  });

  it("CAS 失败 → 零撤销、零成功审计", async () => {
    const { url } = await seedMismatchScenario();
    const clock = makeClock();

    // 持锁事务先把 version 推到 2（不提交）。
    const holder = await holdVersionBump(url);

    // mismatch 方：读到已提交 version=1 → fetch → CAS 撞锁。
    const deps = makeDeps(mismatchFetcher(clock).deps, clock, new InMemoryNegativeCooldown(), makeAuditSpy());
    const p = resolveClientForAuthorize(url, deps);
    const waiter = await waitForLockWaiter(5000);
    expect(waiter).not.toBeNull();

    await holder.release();
    const result = await p;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("client_id_mismatch");

    // 零撤销、零成功审计；行未被标 INVALID（CAS 未获胜）。
    const grants = await grantStates(url);
    expect(grants.revoked).toBe(0);
    expect(await mismatchAuditCount(url)).toBe(0);
    const row = await rowOf(url);
    expect(Number(row?.metadata_version)).toBe(2);
    expect(new Date(row!.metadata_cache_expires_at!).getTime()).not.toBe(0);
  });
});

/* ========================================================================== *
 * 5. ABSENT 负面冷却
 * ========================================================================== */

describe("ABSENT 负面冷却", () => {
  function terminalFetcher(clock: { now: () => Date }): InstantFetcher {
    // 非法文档 → terminal `document`。
    return instantFetcher(clock, { doc: validDoc({ client_name: "" }) });
  }

  it("第一次 terminal 后写入负面冷却；30 秒内重复请求不发网络", async () => {
    const clock = makeClock();
    const cooldown = new InMemoryNegativeCooldown();
    const fetcher = terminalFetcher(clock);
    const deps = makeDeps(fetcher.deps, clock, cooldown, makeAuditSpy());

    const first = await resolveClientForAuthorize(CLIENT_URL, deps);
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.failure.reason).toBe("document");
    expect(fetcher.request).toHaveBeenCalledTimes(1);
    expect(cooldown.check(CLIENT_URL, clock.now())).toEqual({ reason: "document" });

    // 30 秒内再来：命中冷却，**不发网络**。
    clock.advance(10_000);
    const second = await resolveClientForAuthorize(CLIENT_URL, deps);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.failure.reason).toBe("document");
    expect(fetcher.request).toHaveBeenCalledTimes(1); // 仍是 1
  });

  it("冷却过期（≥30s）后允许重新抓取", async () => {
    const clock = makeClock();
    const cooldown = new InMemoryNegativeCooldown();
    const fetcher = terminalFetcher(clock);
    const deps = makeDeps(fetcher.deps, clock, cooldown, makeAuditSpy());

    await resolveClientForAuthorize(CLIENT_URL, deps);
    expect(fetcher.request).toHaveBeenCalledTimes(1);

    clock.advance(30_000);
    const again = await resolveClientForAuthorize(CLIENT_URL, deps);
    expect(again.ok).toBe(false);
    expect(fetcher.request).toHaveBeenCalledTimes(2); // 重新抓了
    expect(cooldown.check(CLIENT_URL, clock.now())).toEqual({ reason: "document" });
  });

  it("transient 不写入 terminal 冷却", async () => {
    const clock = makeClock();
    const cooldown = new InMemoryNegativeCooldown();
    const fetcher = instantFetcher(clock, {
      error: Object.assign(new Error("boom"), { code: "ECONNRESET" }),
    });
    const deps = makeDeps(fetcher.deps, clock, cooldown, makeAuditSpy());

    const result = await resolveClientForAuthorize(CLIENT_URL, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("transient");
      expect(result.failure.status).toBe(503);
    }
    expect(cooldown.check(CLIENT_URL, clock.now())).toBeNull();
    expect(cooldown.size).toBe(0);
  });

  it("成功注册后清除旧负面冷却", async () => {
    const clock = makeClock();
    const cooldown = new InMemoryNegativeCooldown();
    // 第一次 terminal。
    const bad = terminalFetcher(clock);
    await resolveClientForAuthorize(CLIENT_URL, makeDeps(bad.deps, clock, cooldown, makeAuditSpy()));
    expect(cooldown.check(CLIENT_URL, clock.now())).not.toBeNull();

    // 冷却过期后第二次抓取成功。
    clock.advance(30_000);
    const good = instantFetcher(clock);
    const result = await resolveClientForAuthorize(
      CLIENT_URL,
      makeDeps(good.deps, clock, cooldown, makeAuditSpy()),
    );
    expect(result.ok).toBe(true);
    expect(cooldown.check(CLIENT_URL, clock.now())).toBeNull();
    expect(cooldown.size).toBe(0);
  });

  it("no-store 不保存响应正文（冷却快照只含时间戳与原因枚举）", async () => {
    const clock = makeClock();
    const cooldown = new InMemoryNegativeCooldown();
    const noStore: CimdTransportResponse = {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: Buffer.from(JSON.stringify({ ...validDoc(), marker: NO_STORE_BODY_SENTINEL }), "utf8"),
      bodyTooLarge: false,
    };
    const fetcher = instantFetcher(clock, { response: noStore });
    const deps = makeDeps(fetcher.deps, clock, cooldown, makeAuditSpy());

    const result = await resolveClientForAuthorize(CLIENT_URL, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("client_registration_unsupported");

    // 冷却已写入，但快照里**没有**响应正文哨兵。
    expect(cooldown.size).toBe(1);
    const snapshotJson = JSON.stringify(cooldown.snapshot());
    expect(snapshotJson).not.toContain(NO_STORE_BODY_SENTINEL);
    expect(snapshotJson).not.toContain("Example Client");
    const entry = cooldown.check(CLIENT_URL, clock.now());
    expect(entry?.reason).toBe("unsupported_client");
  });

  it("同一个 client_id 的冷却不影响其他 client_id", async () => {
    const clock = makeClock();
    const cooldown = new InMemoryNegativeCooldown();
    const otherUrl = "https://other.example.com/oauth/client.json";
    const bad = terminalFetcher(clock);
    await resolveClientForAuthorize(CLIENT_URL, makeDeps(bad.deps, clock, cooldown, makeAuditSpy()));
    expect(cooldown.check(CLIENT_URL, clock.now())).not.toBeNull();
    expect(cooldown.check(otherUrl, clock.now())).toBeNull();

    // 另一个 client 仍会正常发起抓取（文档 client_id 必须匹配其自身 URL）。
    const good = instantFetcher(clock, { doc: validDoc({ client_id: otherUrl }) });
    const result = await resolveClientForAuthorize(
      otherUrl,
      makeDeps(good.deps, clock, cooldown, makeAuditSpy()),
    );
    expect(result.ok).toBe(true);
    expect(good.request).toHaveBeenCalledTimes(1);
  });

  it("Map 达到容量上限时不会无限增长（逐出最旧项）", async () => {
    // 生产默认上限是防御性常量（同 rate-limit.ts 的取向），不是可配置放大项。
    expect(NEGATIVE_COOLDOWN_MAX_ENTRIES).toBe(10_000);

    const clock = makeClock();
    const cap = 3;
    const cooldown = new InMemoryNegativeCooldown(30_000, cap);
    const bad = terminalFetcher(clock);
    const deps = makeDeps(bad.deps, clock, cooldown, makeAuditSpy());

    const urls = ["a", "b", "c", "d", "e"].map((n) => `https://${n}.example.com/x.json`);
    for (const url of urls) {
      await resolveClientForAuthorize(url, deps);
      clock.advance(1); // 让每个条目的时间戳不同，便于确定逐出顺序
    }
    expect(cooldown.size).toBeLessThanOrEqual(cap);
    expect(cooldown.size).toBe(cap);
    // 最旧的（a）已被逐出，最新的（e）在。
    expect(cooldown.check(urls[0]!, clock.now())).toBeNull();
    expect(cooldown.check(urls[urls.length - 1]!, clock.now())).not.toBeNull();
  });
});

/* ========================================================================== *
 * 6. 审计映射（只走 reason 枚举，禁止匹配 detail）
 * ========================================================================== */

describe("审计映射（reason 枚举）", () => {
  it("普通文档字段格式错误 → mcp_cimd_document_invalid", () => {
    expect(auditEventForCimdFailure("document")).toBe("mcp_cimd_document_invalid");
    expect(auditEventForCimdFailure("json")).toBe("mcp_cimd_document_invalid");
  });

  it("grant/response 问题 → mcp_cimd_unsupported_grant", () => {
    expect(auditEventForCimdFailure("unsupported_grant")).toBe("mcp_cimd_unsupported_grant");
  });

  it("身份冲突 → mcp_cimd_client_id_conflict", () => {
    expect(auditEventForCimdFailure("client_id_conflict")).toBe("mcp_cimd_client_id_conflict");
  });

  it("client_id mismatch → mcp_client_id_mismatch（由撤销事务写入）", () => {
    // 映射函数对 mismatch 返回 null：它不由 fetch 失败审计承担，
    // 而是由 `revokeMcpGrantsAndSessionsByClient` 在**同一事务**里写。
    expect(auditEventForCimdFailure("client_id_mismatch")).toBeNull();
  });

  it("其它 terminal 的映射覆盖设计 §15", () => {
    expect(auditEventForCimdFailure("unsupported_client")).toBe("mcp_cimd_unsupported_client");
    expect(auditEventForCimdFailure("ssrf_address")).toBe("mcp_cimd_ssrf_blocked");
    expect(auditEventForCimdFailure("http_status")).toBe("mcp_cimd_http_invalid");
    expect(auditEventForCimdFailure("content_type")).toBe("mcp_cimd_http_invalid");
    expect(auditEventForCimdFailure("too_large")).toBe("mcp_cimd_http_invalid");
    expect(auditEventForCimdFailure("tls_failure")).toBe("mcp_cimd_tls_failure");
  });

  it("transient 类与形态校验不产生独立终端审计", () => {
    expect(auditEventForCimdFailure("dns_failure")).toBeNull();
    expect(auditEventForCimdFailure("timeout")).toBeNull();
    expect(auditEventForCimdFailure("transport_error")).toBeNull();
    expect(auditEventForCimdFailure("client_id_url")).toBeNull();
  });
});

/* ========================================================================== *
 * 7. 版本递增不变量守卫（3B-1 遗留 #1 / 任务书 §八.10）
 * ========================================================================== */

describe("版本递增不变量守卫", () => {
  /**
   * 扫描 `src` 目录下全部 `.ts` 文件：凡出现 `.update(mcpOauthClients)`，其语句块
   * 必须同时满足两条——
   *
   * 1. `SET metadata_version = metadata_version + 1`（版本递增）；
   * 2. `WHERE` 同时限定 `client_id` 与旧 `metadata_version`（经 `casWhere()`）。
   *
   * 这是「不存在绕过版本递增的写路径」的应用层保证：数据库 `CHECK >= 1`
   * **只**保证版本为正数，**不**保证单调递增（3B-1 遗留 #4）。
   * 注释会被剥离，避免注释里提到这些关键字而误判。
   */
  it("所有 .update(mcpOauthClients) 都带 version+1，且 CAS 同时限定 client_id 与版本", () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".ts")) files.push(path);
      }
    };
    walk(srcDir);

    const offenders: string[] = [];
    let total = 0;
    for (const file of files) {
      const raw = readFileSync(file, "utf8");
      // 剥掉块注释与整行注释，免得注释里的示例被当成真实写路径。
      const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
      const pattern = /\.update\(\s*mcpOauthClients\s*\)/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source)) !== null) {
        total += 1;
        const block = source.slice(match.index, match.index + 800);
        const hasIncrement = block.includes("metadata_version + 1");
        const hasClientId = block.includes("mcpOauthClients.clientId") || block.includes("casWhere(");
        const hasVersion = block.includes("mcpOauthClients.metadataVersion") || block.includes("casWhere(");
        if (!hasIncrement || !hasClientId || !hasVersion) {
          offenders.push(
            `${file.replace(srcDir, "src")} → increment=${hasIncrement} clientId=${hasClientId} version=${hasVersion}`,
          );
        }
      }
    }

    // 扫描必须真的找到写路径（否则守卫本身失效）。
    expect(total).toBeGreaterThanOrEqual(2);
    expect(offenders).toEqual([]);
  });

  it("不存在用 metadata_fetched_at 作等值 / CAS 比较的写路径", () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".ts")) files.push(path);
      }
    };
    walk(srcDir);

    const offenders: string[] = [];
    for (const file of files) {
      const raw = readFileSync(file, "utf8");
      const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
      // `metadata_fetched_at` / `metadataFetchedAt` 出现在 WHERE / eq 比较里即违规。
      if (/where[\s\S]{0,400}metadata_?Fetched_?at/i.test(source) || /eq\(\s*mcpOauthClients\.metadataFetchedAt/.test(source)) {
        offenders.push(file.replace(srcDir, "src"));
      }
    }
    expect(offenders).toEqual([]);
  });
});
