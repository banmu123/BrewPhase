import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import type { AuthEventType, AuthEventInput } from "../db/audit.js";
import { mcpOauthClients } from "../db/schema.js";
import {
  MAX_URL_LENGTH,
  clientIdConflictsWithTrusted,
  fetchClientMetadataDocument,
  validateClientIdentifierUrl,
  type CimdOutcome,
  type CimdFailureReason,
  type CimdFetcherDeps,
} from "./cimd.js";
import { revokeMcpGrantsAndSessionsByClient } from "./sessions.js";

/**
 * CIMD 注册与元数据缓存的**状态管理层**（Phase 1.3.1-C3c-3B-2，设计 §3 / §4 / §8）。
 *
 * 这一层回答一个问题：**「这次 authorize 该拿哪个客户端行、它的元数据现在可信吗？」**
 * 它负责查找顺序、缓存四态、fetch floor、版本 CAS、ABSENT 负面冷却与 mismatch
 * 撤销——但**不**接入 `/mcp/oauth/authorize` 路由（那是 C3c-3B-3）。
 *
 * ## 三条不可动摇的纪律
 *
 * 1. **先查库，再对未注册的 client_id 判 URL 形态**（设计 §3 判定顺序）。
 *    反过来会把所有不透明预注册 ID（`brewphase-desktop` 这类）误判成「非 URL →
 *    未注册 → 拒绝」——那是 R1 修过的 High 级回退，绝不允许再犯。
 * 2. **唯一 CAS 令牌是 `metadata_version`**，条件**必须同时**包含
 *    `client_id` 与读取时的旧版本（§8.1）。0 行 = 别人先写 → 丢弃本次结果。
 * 3. **CAS 失败按 §8.5 边界一处置**：成功刷新失败 → 503 fail-closed；mismatch /
 *    其它 terminal 失败 → 400 但**零 DB 写入**；行已删除 → 400 不重新 INSERT；
 *    数据库异常 → 500 rollback。**不得**为了提高成功率放宽 fail-closed。
 */

/** fetch floor：距上次确定性抓取尝试至少 30 秒（设计 §4.1）。 */
export const CIMD_FETCH_FLOOR_MS = 30_000;

/** INVALID 哨兵：`metadata_cache_expires_at` 的精确 epoch 值（设计 §4）。 */
export const CIMD_INVALID_SENTINEL = new Date(0);

/** 负面冷却 TTL（设计 §8.5 边界三，与 fetch floor 同值）。 */
export const NEGATIVE_COOLDOWN_TTL_MS = 30_000;

/** 负面冷却的容量上限（防御无限建桶；同 `rate-limit.ts` 的取向）。 */
export const NEGATIVE_COOLDOWN_MAX_ENTRIES = 10_000;

/**
 * 冷却里允许记录的失败原因。
 *
 * 比 `CimdFailureReason` 多一个 `client_registration_unsupported`——那是 Registry
 * 层对 `Cache-Control: no-store` 的**统一**失败分类（§6.2 / C3c-3B-2-R1）：
 * ABSENT 与「已有缓存行 + no-store」两条路径**必须返回同一个 reason**，
 * 冷却命中时也原样返回它，否则同一个失败会因「第几次请求」而被分成两类。
 */
export type CooldownReason = CimdFailureReason | "client_registration_unsupported";

/* -------------------------------------------------------------------------- *
 * ABSENT 负面冷却（设计 §8.5 边界三）
 * -------------------------------------------------------------------------- */

/**
 * 负面结果的短期冷却存储。
 *
 * **只存时间戳与「发生过 terminal」这一事实（含固定枚举原因）**——
 * **绝不**存响应正文、`no-store` 内容或任何 HTTP Header。因此它不违反 §6 的
 * `no-store` 语义，也不是授权 / Grant 状态（那类状态禁止放内存）。
 *
 * ABSENT（无注册行）抓取失败不写行，因而**不受 `metadata_fetched_at` 的
 * 30 秒 floor 保护**；这个冷却就是那道缺口的最小补齐。
 */
export interface NegativeCooldownStore {
  /** 仍在冷却中则返回其 terminal 原因；否则 `null`（调用方据此决定要不要发网络）。 */
  check(clientId: string, now: Date): { reason: CooldownReason } | null;
  /** 记录一次 terminal（只写时间戳 + 原因枚举）。 */
  record(clientId: string, reason: CooldownReason, now: Date): void;
  /** 成功注册 / 成功刷新后清除该 client 的冷却。 */
  clear(clientId: string): void;
}

/**
 * 进程内实现（单实例部署；Phase 1.4 扩容时必须换成共享存储——与
 * `rate-limit.ts` 的 `buckets` 同一取向）。
 *
 * 容量：过期项先清理；仍达上限时逐出**最旧**项，因此条目数恒 ≤ `maxEntries`。
 * 时钟由调用方注入（`now` 参数），测试可控、不依赖真实时间。
 */
export class InMemoryNegativeCooldown implements NegativeCooldownStore {
  private readonly entries = new Map<string, { at: number; reason: CooldownReason }>();

  constructor(
    private readonly ttlMs: number = NEGATIVE_COOLDOWN_TTL_MS,
    private readonly maxEntries: number = NEGATIVE_COOLDOWN_MAX_ENTRIES,
  ) {}

  check(clientId: string, now: Date): { reason: CooldownReason } | null {
    const entry = this.entries.get(clientId);
    if (!entry) return null;
    if (now.getTime() - entry.at >= this.ttlMs) {
      this.entries.delete(clientId);
      return null;
    }
    return { reason: entry.reason };
  }

  record(clientId: string, reason: CimdFailureReason, now: Date): void {
    this.purge(now);
    if (!this.entries.has(clientId) && this.entries.size >= this.maxEntries) {
      this.evictOldest();
    }
    this.entries.set(clientId, { at: now.getTime(), reason });
  }

  clear(clientId: string): void {
    this.entries.delete(clientId);
  }

  /** 测试可观测：当前条目数（断言容量上限用）。 */
  get size(): number {
    return this.entries.size;
  }

  /**
   * 测试可观测：当前条目快照。
   *
   * 用于断言**只存时间戳与原因枚举**——把 `no-store` 响应正文里的哨兵串放进
   * 文档后，`JSON.stringify(snapshot())` 必须**不含**该哨兵（§8.5 边界三）。
   */
  snapshot(): Array<{ clientId: string; at: number; reason: CooldownReason }> {
    return [...this.entries].map(([clientId, entry]) => ({
      clientId,
      at: entry.at,
      reason: entry.reason,
    }));
  }

  private purge(now: Date): void {
    for (const [key, entry] of this.entries) {
      if (now.getTime() - entry.at >= this.ttlMs) this.entries.delete(key);
    }
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.entries) {
      if (entry.at < oldestAt) {
        oldestAt = entry.at;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) this.entries.delete(oldestKey);
  }
}

/* -------------------------------------------------------------------------- *
 * 进程内 singleflight（设计 §8.1「抓取风暴」：只做合并，不做正确性）
 * -------------------------------------------------------------------------- */

/**
 * 按 `client_id` 合并**同一进程内**并发抓取的最小接口。
 *
 * 纪律（设计 §8.1 冻结，本类**只**承担第一条）：
 *
 * 1. **只减少重复网络调用**：同一 `client_id` 同一时间只有一次远程抓取在飞；
 *    不同 `client_id` 互不阻塞。
 * 2. **不参与正确性**：数据库 `metadata_version` CAS（`WHERE client_id = ?
 *    AND metadata_version = ?`）仍是唯一正确性保障——合并 fetch 之后，等待者
 *    仍各自进入 CAS，由版本谓词保证**至多一个提交者**，其余 0 行按 §8.5
 *    fail-closed。**绝不**用本 Map 代替版本 CAS，也不改变多实例规则。
 * 3. **完成即清理**：Promise 无论 resolve / reject 都立刻从 Map 删除
 *    （`finally`），不留 rejected Promise。
 * 4. **抓取的生命周期不属于任何单个调用方**：共享 Promise 由本 store 持有，
 *    `CimdFetcherDeps` 没有任何调用方级 `AbortSignal`，因此一个等待者的
 *    失败 / 提前返回**不可能**中止其它等待者共享的抓取。
 *
 * 多实例语义不变：本 Map 只在进程内合并；跨实例仍由 ON CONFLICT + 版本 CAS 裁决。
 */
export interface FetchSingleflight {
  /** 该 key 已有在飞任务则共享之，否则执行 `fn` 并注册。 */
  do<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** 当前在飞任务数（观测用）。 */
  readonly size: number;
  /** 某 key 上正在**等待**共享结果的任务数（owner 不计；测试观测用）。 */
  waiterCount(key: string): number;
}

export class InMemorySingleflight implements FetchSingleflight {
  private readonly inflight = new Map<string, { promise: Promise<unknown>; waiters: number }>();

  do<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) {
      existing.waiters += 1;
      return existing.promise.finally(() => {
        existing.waiters -= 1;
      }) as Promise<T>;
    }

    const entry: { promise: Promise<unknown>; waiters: number } = { promise: Promise.resolve(), waiters: 0 };
    entry.promise = (async () => fn())().finally(() => {
      // 完成 / 失败都立即清理；只删除仍指向自己的条目（防止未来 key 被复用时误删）。
      if (this.inflight.get(key) === entry) this.inflight.delete(key);
    });
    this.inflight.set(key, entry);
    return entry.promise as Promise<T>;
  }

  get size(): number {
    return this.inflight.size;
  }

  waiterCount(key: string): number {
    return this.inflight.get(key)?.waiters ?? 0;
  }
}

/**
 * **进程级默认实例**（省略 `deps.singleflight` 时使用）。
 *
 * 生产是单实例部署（`GATEWAY_EXPECTED_REPLICAS = 1`），因此它就是「进程内
 * singleflight」的语义落点；测试注入独立实例以隔离用例，或模拟**多实例**
 * （两个 store = 两个进程 → 只剩 DB CAS 裁决）。
 */
export const processWideSingleflight: FetchSingleflight = new InMemorySingleflight();

/**
 * 经 singleflight 执行一次 CIMD 抓取（两条路径共用：已有行重抓 / ABSENT 首次）。
 *
 * `fetchClientMetadataDocument` 的契约是「不抛异常」（cimd.ts 文首）；这里仍
 * 防御注入实现的意外抛错——所有等待者拿到**同一个**确定的 transient 结果，
 * 且 Map 已被 `finally` 清理。
 */
async function fetchViaSingleflight(
  clientId: string,
  deps: CimdRegistryDeps,
  trusted: string[],
): Promise<CimdOutcome> {
  const singleflight = deps.singleflight ?? processWideSingleflight;
  try {
    return await singleflight.do(clientId, () =>
      fetchClientMetadataDocument(clientId, deps.fetcher, { trustedIdentifiers: trusted }),
    );
  } catch {
    return {
      ok: false,
      kind: "transient",
      reason: "transport_error",
      detail: "client metadata fetch failed unexpectedly",
    };
  }
}

/* -------------------------------------------------------------------------- *
 * 审计映射：**只走 reason 枚举，禁止匹配 detail 文本**
 * -------------------------------------------------------------------------- */

/**
 * 把 `CimdFailureReason` 映射到审计事件（设计 §15）。
 *
 * **禁止**通过匹配错误 `detail` 文本来决定事件名：detail 是给人看的、随时可能
 * 改写；枚举才是契约。返回 `null` 表示该 reason 不单独记审计
 * （transient → `mcp_cimd_fetch_transient`；`client_id_mismatch` → 撤销事务内
 * 的 `mcp_client_id_mismatch`；`client_id_url` 是纯形态校验，不联网、不记）。
 */
export function auditEventForCimdFailure(reason: CimdFailureReason): AuthEventType | null {
  switch (reason) {
    case "client_id_conflict":
      return "mcp_cimd_client_id_conflict";
    case "unsupported_grant":
      return "mcp_cimd_unsupported_grant";
    case "unsupported_client":
      return "mcp_cimd_unsupported_client";
    case "ssrf_address":
      return "mcp_cimd_ssrf_blocked";
    case "http_status":
    case "content_type":
    case "too_large":
      return "mcp_cimd_http_invalid";
    case "tls_failure":
      return "mcp_cimd_tls_failure";
    case "document":
    case "json":
      return "mcp_cimd_document_invalid";
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- *
 * 结果类型
 * -------------------------------------------------------------------------- */

export type McpCacheState = "fresh" | "stale" | "invalid" | "authoritative";

export interface ResolvedMcpClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  registrationSource: string;
  /** 版本 CAS 的读取基线（3B-3 若需诊断可用）。 */
  metadataVersion: number;
  /**
   * 元数据可用性：
   * - `authoritative` = `pre_registered` / `dcr`（人工核验、无缓存语义，直接可用）；
   * - `fresh` / `stale` / `invalid` = `cimd` 行按 `metadata_cache_expires_at` 判定。
   */
  cacheState: McpCacheState;
}

/** `resolveClientForAuthorize` 独有的失败原因（叠加在 `CimdFailureReason` 之上）。 */
export type RegistryFailureReason =
  | CimdFailureReason
  | "client_id_too_long"
  | "cache_stale_cooldown"
  | "cache_invalid_cooldown"
  | "cas_superseded"
  | "row_deleted"
  | "client_registration_unsupported"
  | "database_error";

export interface RegistryFailure {
  kind: "transient" | "terminal";
  reason: RegistryFailureReason;
  /** 对外 HTTP 状态：`database_error` → 500；transient → 503；terminal → 400。 */
  status: 400 | 503 | 500;
  detail: string;
}

export type RegistryOutcome =
  | { ok: true; client: ResolvedMcpClient }
  | { ok: false; failure: RegistryFailure };

export interface CimdRegistryDeps {
  db: Database;
  /** `createCimdDeps(proxy)` 产出的抓取器（含 DNS Pinning；禁止普通 fetch）。 */
  fetcher: CimdFetcherDeps;
  /** `env.baseUrl`（AS issuer）。 */
  baseUrl: string;
  /** MCP resource（`mcpResourceFor(baseUrl)`）。 */
  mcpResource: string;
  /** `Env.mcpTrustedPeerIdentifiers`（[ID §10.1] 比较对象之一）。 */
  mcpTrustedPeerIdentifiers: readonly string[];
  /** 注入时钟：floor / 缓存态 / 冷都用它。 */
  now: () => Date;
  /** 负面冷却存储（可替换；测试注入小 TTL / 小容量）。 */
  cooldown: NegativeCooldownStore;
  /**
   * 进程内抓取合并（设计 §8.1：**只做合并，不做正确性**）。
   *
   * 省略时使用 `processWideSingleflight`（进程级默认实例）。测试注入独立实例
   * 以隔离用例，或用「两个实例」模拟多进程写入者（那时只剩 DB CAS 裁决）。
   */
  singleflight?: FetchSingleflight;
  /** 审计写入（**非阻断**：失败只吞掉，不影响主流程）。 */
  audit: (input: AuthEventInput) => Promise<void>;
}

/* -------------------------------------------------------------------------- *
 * 小工具
 * -------------------------------------------------------------------------- */

function statusFor(reason: RegistryFailureReason, kind: "transient" | "terminal"): 400 | 503 | 500 {
  if (reason === "database_error") return 500;
  return kind === "transient" ? 503 : 400;
}

function fail(
  kind: "transient" | "terminal",
  reason: RegistryFailureReason,
  detail: string,
): RegistryOutcome {
  return { ok: false, failure: { kind, reason, status: statusFor(reason, kind), detail } };
}

function databaseError(): RegistryOutcome {
  return fail("terminal", "database_error", "database error while resolving client metadata");
}

/** 审计**非阻断**：写失败只吞掉（审计是记账，不是授权前置条件）。 */
async function auditBestEffort(deps: CimdRegistryDeps, input: AuthEventInput): Promise<void> {
  try {
    await deps.audit(input);
  } catch {
    /* 非阻断 */
  }
}

/** 审计一次 terminal 失败（按 reason 枚举映射；映射为 null 时不记）。 */
async function auditTerminal(
  deps: CimdRegistryDeps,
  reason: CimdFailureReason,
  clientId: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  const eventType = auditEventForCimdFailure(reason);
  if (!eventType) return;
  await auditBestEffort(deps, { eventType, detail: { clientId, reason, ...detail } });
}

function computeCacheState(expires: Date | null, now: Date): Exclude<McpCacheState, "authoritative"> {
  // `NULL` = 从未成功抓取（理论上不该出现在 cimd 行）→ fail-safe 视为 STALE（设计 §4）。
  if (expires === null) return "stale";
  if (expires.getTime() === CIMD_INVALID_SENTINEL.getTime()) return "invalid";
  return expires.getTime() > now.getTime() ? "fresh" : "stale";
}

function toResolvedClient(
  row: typeof mcpOauthClients.$inferSelect,
  now: Date,
): ResolvedMcpClient {
  const authoritative = row.registrationSource !== "cimd";
  return {
    clientId: row.clientId,
    clientName: row.clientName,
    redirectUris: row.redirectUris,
    grantTypes: row.grantTypes,
    registrationSource: row.registrationSource,
    metadataVersion: row.metadataVersion,
    cacheState: authoritative ? "authoritative" : computeCacheState(row.metadataCacheExpiresAt, now),
  };
}

async function readClientRow(
  db: Database,
  clientId: string,
): Promise<typeof mcpOauthClients.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(mcpOauthClients)
    .where(eq(mcpOauthClients.clientId, clientId))
    .limit(1);
  return rows[0];
}

function trustedIdentifiersOf(deps: CimdRegistryDeps): string[] {
  return [deps.baseUrl, deps.mcpResource, ...deps.mcpTrustedPeerIdentifiers];
}

/* -------------------------------------------------------------------------- *
 * 主入口
 * -------------------------------------------------------------------------- */

/**
 * 为一次 authorize 解析客户端（设计 §3 判定顺序 + §4 缓存四态 + §8 CAS）。
 *
 * **顺序不可调换**（R1 F11 的 High 修复，绝不回退）：
 *
 * ```text
 * 1. client_id 长度 > 2048 → 400（不查库、不解析、不发网络）
 * 2. 按原始字符串精确查询 mcp_oauth_clients
 * 3. 已存在 pre_registered / dcr → URL 形态才做身份冲突检查；不透明 ID 直接用
 * 4. 已存在 cimd → 身份冲突检查 → 缓存四态 → 按 floor 决定是否重抓
 * 5. 不存在 → 校验 Client Identifier URL → 身份冲突检查 → 才允许网络抓取 → 写行
 * ```
 */
export async function resolveClientForAuthorize(
  clientId: string,
  deps: CimdRegistryDeps,
): Promise<RegistryOutcome> {
  // ---- 1. 长度硬上限：不查库、不解析、不发网络 ----
  if (clientId.length > MAX_URL_LENGTH) {
    return fail("terminal", "client_id_too_long", `client_id is longer than ${MAX_URL_LENGTH}`);
  }

  const trusted = trustedIdentifiersOf(deps);
  const now = deps.now();

  // ---- 2. 按原始字符串精确查询（先查库，再判形态——绝不能反过来）----
  let row: typeof mcpOauthClients.$inferSelect | undefined;
  try {
    row = await readClientRow(deps.db, clientId);
  } catch {
    return databaseError();
  }

  // ---- 3. 已存在 pre_registered / dcr ----
  if (row && row.registrationSource !== "cimd") {
    // URL 形态才做身份冲突检查；不透明 ID 由 `clientIdConflictsWithTrusted`
    // 内部的形态闸门直接放行（设计 §3.2 纪律 4）。
    if (clientIdConflictsWithTrusted(clientId, trusted)) {
      await auditTerminal(deps, "client_id_conflict", clientId, { registrationSource: row.registrationSource });
      return fail("terminal", "client_id_conflict", "client_id equals a trusted identifier");
    }
    return { ok: true, client: toResolvedClient(row, now) };
  }

  // ---- 4. 已存在 cimd ----
  if (row) {
    if (clientIdConflictsWithTrusted(clientId, trusted)) {
      await auditTerminal(deps, "client_id_conflict", clientId, { registrationSource: "cimd" });
      return fail("terminal", "client_id_conflict", "client_id equals a trusted identifier");
    }
    return await resolveExistingCimdRow(row, clientId, deps, trusted, now);
  }

  // ---- 5. 不存在注册行：先判 URL 形态，再判身份冲突，最后才联网 ----
  const urlCheck = validateClientIdentifierUrl(clientId);
  if (!urlCheck.ok) {
    return fail("terminal", "client_id_url", urlCheck.detail);
  }
  if (clientIdConflictsWithTrusted(clientId, trusted)) {
    await auditTerminal(deps, "client_id_conflict", clientId);
    return fail("terminal", "client_id_conflict", "client_id equals a trusted identifier");
  }

  return await registerFreshClient(clientId, deps, trusted, now);
}

/* -------------------------------------------------------------------------- *
 * 已存在 cimd 行：缓存四态 + floor
 * -------------------------------------------------------------------------- */

async function resolveExistingCimdRow(
  row: typeof mcpOauthClients.$inferSelect,
  clientId: string,
  deps: CimdRegistryDeps,
  trusted: string[],
  now: Date,
): Promise<RegistryOutcome> {
  const expires = row.metadataCacheExpiresAt;
  const fetchedAt = row.metadataFetchedAt;
  const state = computeCacheState(expires, now);

  // FRESH（或 NULL→STALE 之外的非过期）→ 直接用缓存，不发网络（设计 §4.1）。
  if (state === "fresh") {
    return { ok: true, client: toResolvedClient(row, now) };
  }

  /**
   * floor：距上次**确定性抓取尝试** ≥ 30s 才允许再抓。
   * `fetchedAt === null` 视为已过 floor（没有可依据的冷却起点，fail-open 到
   * 「允许抓取」而不是「永远抓不了」）。
   */
  const floorPassed =
    fetchedAt === null || now.getTime() - fetchedAt.getTime() >= CIMD_FETCH_FLOOR_MS;

  if (state === "invalid") {
    // INVALID 优先于 floor（设计 §4.1 纪律 2）：冷却内直接拒绝，绝不用旧缓存。
    if (!floorPassed) {
      await auditBestEffort(deps, {
        eventType: "mcp_cimd_fetch_transient",
        detail: { clientId, kind: "invalid_cooldown" },
      });
      return fail(
        "terminal",
        "cache_invalid_cooldown",
        "client metadata is INVALID and the fetch floor has not elapsed",
      );
    }
    // floor 已过 → 重新抓取（唯一自愈路径）。
  } else {
    // STALE（含 NULL expires）：冷却内**不使用旧文档**，返回可重试的 503。
    if (!floorPassed) {
      await auditBestEffort(deps, {
        eventType: "mcp_cimd_fetch_transient",
        detail: { clientId, kind: "cooldown" },
      });
      return fail(
        "transient",
        "cache_stale_cooldown",
        "client metadata is STALE and the fetch floor has not elapsed",
      );
    }
  }

  // floor 已到、即将发网络之前：查负面冷却（C3c-3B-2-R1：`no-store` 不推进
  // `metadata_fetched_at`，floor 管不到它，冷却补上这段缺口）。命中 → 400，**不发网络**。
  // 这里仍走「行路径」语义：注册行原样保留，不与 ABSENT 混淆，也绝不放行 no-store。
  const cooled = deps.cooldown.check(clientId, now);
  if (cooled) {
    return fail(
      "terminal",
      cooled.reason,
      "served from negative cooldown (no network request; registration row retained)",
    );
  }

  const outcome = await fetchViaSingleflight(clientId, deps, trusted);
  // 完成时刻：抓取可能横跨数秒，`metadata_fetched_at` / 冷却 / 返回给调用方的
  // cacheState 一律以**完成时刻**为准，绝不用请求开始时间（否则会把抓取期间
  // 已过期的 metadata 误判成 FRESH——见 C3c-3B-2-R1 时间语义）。
  const completedAt = deps.now();

  if (!outcome.ok) {
    if (outcome.kind === "transient") {
      // 设计 §5.1：保留原行与原时间戳，什么都不写。
      await auditBestEffort(deps, {
        eventType: "mcp_cimd_fetch_transient",
        detail: { clientId, kind: outcome.reason },
      });
      return fail("transient", outcome.reason, outcome.detail);
    }
    return await applyTerminalOnExistingRow(row, clientId, outcome.reason, outcome.detail, deps, completedAt);
  }

  if (!outcome.cache.storable) {
    // `no-store`：不写行、不更新 fetched_at、不推进版本（设计 §6.2）。floor 管不到
    // 这条路径 → 写入与 ABSENT **同一 reason** 的负面冷却，防止下一次请求立刻重抓。
    deps.cooldown.record(clientId, "client_registration_unsupported", completedAt);
    await auditBestEffort(deps, {
      eventType: "mcp_cimd_no_store_rejected",
      detail: { clientId, source: "no-store", absent: false },
    });
    return fail(
      "terminal",
      "client_registration_unsupported",
      "document must not be stored (Cache-Control: no-store)",
    );
  }

  return await applySuccessOnExistingRow(row, clientId, outcome, deps, completedAt);
}

/* -------------------------------------------------------------------------- *
 * CAS 写入（唯一条件：client_id + 旧 metadata_version）
 * -------------------------------------------------------------------------- */

/** 版本 CAS 的 WHERE——**必须同时**含 client_id 与读取时版本（设计 §8.1）。 */
function casWhere(clientId: string, expectedVersion: number) {
  return and(
    eq(mcpOauthClients.clientId, clientId),
    eq(mcpOauthClients.metadataVersion, expectedVersion),
  );
}

/**
 * 成功刷新 → 版本 CAS 写入。
 *
 * §8.5 边界一：CAS **1 行** = 赢得该版本，提交状态变更；
 * **0 行** = 丢弃本次抓取结果，**503 fail-closed**（不建授权请求、不用自身结果）；
 * 重读仅用于区分「行没了」与「版本变了」，**绝不合并 / 复用自身 metadata**。
 *
 * `completedAt` = **抓取完成时刻**（不是请求开始时刻）：`metadata_fetched_at`
 * 记它，返回给调用方的 `cacheState` 也用它判定（C3c-3B-2-R1 时间语义）。
 *
 * `client_uri` / `logo_uri`：**新文档省略即清空为 NULL**——刷新语义是「用新文档
 * 替换旧文档」，保留上一份文档的 URI 会让同意页展示过期甚至已易主的信息（§7）。
 * 两列只存字符串，**从不抓取**（SSRF 面）、**从不渲染远程图片**。
 */
async function applySuccessOnExistingRow(
  row: typeof mcpOauthClients.$inferSelect,
  clientId: string,
  outcome: Extract<CimdOutcome, { ok: true }>,
  deps: CimdRegistryDeps,
  completedAt: Date,
): Promise<RegistryOutcome> {
  try {
    const updated = await deps.db.transaction(async (tx) => {
      const res = await tx
        .update(mcpOauthClients)
        .set({
          metadataVersion: sql`metadata_version + 1`,
          clientName: outcome.metadata.clientName,
          clientUri: outcome.metadata.clientUri ?? null,
          logoUri: outcome.metadata.logoUri ?? null,
          redirectUris: outcome.metadata.redirectUris,
          grantTypes: outcome.metadata.grantTypes,
          metadataFetchedAt: completedAt,
          metadataCacheExpiresAt: outcome.cacheExpiresAt,
        })
        .where(casWhere(clientId, row.metadataVersion))
        .returning();
      return res;
    });

    if (updated.length === 0) {
      // 0 行 → 重读只作诊断（区分「行已删除」与「版本已变化」），不复用自身结果。
      const current = await readClientRow(deps.db, clientId);
      if (!current) {
        return fail("terminal", "row_deleted", "registration row disappeared during fetch");
      }
      return fail("transient", "cas_superseded", "client metadata was updated concurrently");
    }

    // 成功刷新是「该 client 最近一次确定性抓取成功」→ 清除负面冷却
    // （含 ABSENT 阶段与已有行 no-store 留下的条目，C3c-3B-2-R1）。
    deps.cooldown.clear(clientId);

    await auditBestEffort(deps, {
      eventType: "mcp_cimd_refreshed",
      detail: {
        clientId,
        fromVersion: row.metadataVersion,
        toVersion: updated[0]?.metadataVersion,
      },
    });
    return { ok: true, client: toResolvedClient(updated[0] as typeof mcpOauthClients.$inferSelect, completedAt) };
  } catch {
    return databaseError();
  }
}

/**
 * terminal → 版本 CAS 标记 INVALID；`client_id_mismatch` 额外在**同一事务**
 * 撤销 Grant / Session 并写聚合审计（设计 §5.3 / §8.1）。
 *
 * §8.5 边界一：
 * - CAS **1 行** → 已提交状态变更（mismatch 则连同撤销一起提交）；
 * - CAS **0 行** → **零 DB 写入**：不标 INVALID、不撤销、不写成功审计；
 *   当前请求仍按**自身抓取结果**拒绝（400 terminal）；
 * - 重读只作诊断，不合并 / 复用自身 metadata。
 *
 * `completedAt` = 抓取完成时刻（写入 `metadata_fetched_at`；floor 从它起算）。
 */
async function applyTerminalOnExistingRow(
  row: typeof mcpOauthClients.$inferSelect,
  clientId: string,
  reason: CimdFailureReason,
  detail: string,
  deps: CimdRegistryDeps,
  completedAt: Date,
): Promise<RegistryOutcome> {
  const isMismatch = reason === "client_id_mismatch";

  try {
    const result = await deps.db.transaction(async (tx) => {
      const updated = await tx
        .update(mcpOauthClients)
        .set({
          metadataVersion: sql`metadata_version + 1`,
          metadataFetchedAt: completedAt,
          metadataCacheExpiresAt: CIMD_INVALID_SENTINEL,
        })
        .where(casWhere(clientId, row.metadataVersion))
        .returning();

      if (updated.length === 0) return { casWon: false as const };

      if (isMismatch) {
        const counts = await revokeMcpGrantsAndSessionsByClient(tx, { clientId, now: completedAt });
        return { casWon: true as const, ...counts };
      }
      return { casWon: true as const };
    });

    if (!result.casWon) {
      // CAS 失败：零 DB 写入。当前请求按自身结果拒绝（§8.5 边界一）。
      const current = await readClientRow(deps.db, clientId);
      if (!current) {
        return fail("terminal", "row_deleted", "registration row disappeared during fetch");
      }
      return fail("terminal", reason, `${detail} (superseded by a concurrent update; no state written)`);
    }

    if (isMismatch) {
      // `mcp_client_id_mismatch` 已在撤销事务内写入，这里不再重复记。
      return fail("terminal", "client_id_mismatch", detail);
    }

    await auditTerminal(deps, reason, clientId, { fromVersion: row.metadataVersion });
    return fail("terminal", reason, detail);
  } catch {
    return databaseError();
  }
}

/* -------------------------------------------------------------------------- *
 * ABSENT：负面冷却 + 首次注册
 * -------------------------------------------------------------------------- */

async function registerFreshClient(
  clientId: string,
  deps: CimdRegistryDeps,
  trusted: string[],
  now: Date,
): Promise<RegistryOutcome> {
  // ---- ABSENT 负面冷却（设计 §8.5 边界三）：命中即拒，**不发网络** ----
  const cooled = deps.cooldown.check(clientId, now);
  if (cooled) {
    return fail(
      "terminal",
      cooled.reason,
      "served from ABSENT negative cooldown (no network request)",
    );
  }

  const outcome = await fetchViaSingleflight(clientId, deps, trusted);
  // 完成时刻（见 resolveExistingCimdRow 的同名注释）：冷却与入库都用它。
  const completedAt = deps.now();

  if (!outcome.ok) {
    if (outcome.kind === "terminal") {
      // 只记时间戳 + 原因枚举；**绝不**存响应正文 / Header（不违反 no-store）。
      deps.cooldown.record(clientId, outcome.reason, completedAt);

      if (outcome.reason === "client_id_mismatch") {
        /**
         * ABSENT + mismatch 的**独立审计分支**（C3c-3B-2-R1，任务书 §三）：
         *
         * 这里**没有注册行** → 没有可执行的注册行 CAS → **不能**伪造 CAS 成功、
         * **不能**声称撤销了既有 Grant / Session。但仍必须留下**明确、可查询**的
         * 审计（不得静默丢失），因此复用同一条 `mcp_client_id_mismatch`，并用
         * detail 三字段把两种情形钉死：
         *
         * - `absent: true` / `casApplied: false`：首次注册路径，无行可 CAS；
         * - `revokedGrantCount: 0` / `revokedSessionCount: 0`：**零撤销**——
         *   绝不误报「已有 Grant / Session 已被撤销」；
         * - `user_id = NULL`：跨用户的系统动作（同既有撤销审计）。
         *
         * 选「同一事件 + 零撤销计数」而不是新事件名的理由：mismatch 是同一类
         * **身份失效信号**，安全查询必须一次拿到全部命中；两种情形由 detail
         * 字段区分，不需要靠 detail 文本匹配（§15 纪律不被破坏）。
         */
        await auditBestEffort(deps, {
          eventType: "mcp_client_id_mismatch",
          detail: {
            clientId,
            reason: "client_id_mismatch",
            absent: true,
            casApplied: false,
            revokedGrantCount: 0,
            revokedSessionCount: 0,
          },
        });
      } else {
        await auditTerminal(deps, outcome.reason, clientId, { absent: true });
      }
      return fail("terminal", outcome.reason, outcome.detail);
    }
    // transient：**不写** terminal 冷却（设计 §8.5 边界三测试 4）。
    await auditBestEffort(deps, {
      eventType: "mcp_cimd_fetch_transient",
      detail: { clientId, kind: outcome.reason, absent: true },
    });
    return fail("transient", outcome.reason, outcome.detail);
  }

  if (!outcome.cache.storable) {
    // `no-store`：不写行；冷却只存「发生过 terminal」这一事实，不存正文。
    // reason 与「已有行 + no-store」完全一致（C3c-3B-2-R1 统一，§6.2）。
    deps.cooldown.record(clientId, "client_registration_unsupported", completedAt);
    await auditBestEffort(deps, {
      eventType: "mcp_cimd_no_store_rejected",
      detail: { clientId, source: "no-store", absent: true },
    });
    return fail(
      "terminal",
      "client_registration_unsupported",
      "document must not be stored (Cache-Control: no-store)",
    );
  }

  // 成功 → 清除旧的负面冷却（设计 §8.5 边界三测试 5）。
  deps.cooldown.clear(clientId);

  try {
    const inserted = await deps.db
      .insert(mcpOauthClients)
      .values({
        clientId,
        clientName: outcome.metadata.clientName,
        // 首次注册即持久化已校验的 informational URI；省略 = NULL（不继承任何旧值，
        // 此时本就无行）。**从不抓取、从不渲染远程图片**（§7 / §16）。
        clientUri: outcome.metadata.clientUri ?? null,
        logoUri: outcome.metadata.logoUri ?? null,
        redirectUris: outcome.metadata.redirectUris,
        grantTypes: outcome.metadata.grantTypes,
        tokenEndpointAuthMethod: "none",
        registrationSource: "cimd",
        metadataFetchedAt: completedAt,
        metadataCacheExpiresAt: outcome.cacheExpiresAt,
        metadataVersion: 1,
      })
      .onConflictDoNothing({ target: mcpOauthClients.clientId })
      .returning();

    if (inserted.length === 1) {
      await auditBestEffort(deps, {
        eventType: "mcp_cimd_registered",
        detail: { clientId, metadataVersion: 1 },
      });
      return { ok: true, client: toResolvedClient(inserted[0] as typeof mcpOauthClients.$inferSelect, completedAt) };
    }

    // 并发首次注册冲突（`ON CONFLICT DO NOTHING` 未插入）→ 重读**胜者**的行，
    // **不合并**自己的抓取结果（设计 §8.1）。胜者是成功抓取才写得进来的，
    // 因此其行必为可用状态；仅防御性地挡掉「已被并发标 INVALID」的极端交错。
    const winner = await readClientRow(deps.db, clientId);
    if (!winner) {
      return fail("terminal", "row_deleted", "registration row disappeared after conflict");
    }
    if (computeCacheState(winner.metadataCacheExpiresAt, completedAt) === "invalid") {
      return fail("terminal", "cache_invalid_cooldown", "concurrent registration ended INVALID");
    }
    return { ok: true, client: toResolvedClient(winner, completedAt) };
  } catch {
    return databaseError();
  }
}
