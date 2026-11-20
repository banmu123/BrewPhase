import dns from "node:dns/promises";
import { performance } from "node:perf_hooks";
import net from "node:net";
import { requestPinnedHttps, type OutboundProxy } from "../net/proxy-fetch.js";

/**
 * CIMD（Client ID Metadata Document）严格抓取器（Phase 1.3.1-C3c-2）。
 *
 * 依据 `draft-ietf-oauth-client-id-metadata-document-03`
 * （Internet-Draft，发布日期 **2026-11-02**，有效期至 2027-05-06；
 * **不是 RFC**，不应作为正式标准引用）。本模块只负责「拿文档、验文档、算缓存」，
 * 不接入授权流程，也不对外声明 CIMD 能力——`client_id_metadata_document_supported`
 * 仍然是「未实现」。
 *
 * 三条纪律：
 * 1. **原始字符串优先**：`client_id` 的比较、路径形态的判断都在规范化之前做。
 *    WHATWG 会把 `/a/..` 变成 `/`，先解析再判断等于把攻击面交给解析器。
 * 2. **DNS Pinning**：解析一次、校验全部结果、连接只用其中一个 IP。校验和连接
 *    之间不再查 DNS，否则 DNS Rebinding 会让「校验时是公网、连接时是内网」。
 * 3. **失败要分类**：transient（DNS/网络/超时）不能作废已缓存的元数据，
 *    terminal（SSRF/重定向/文档非法）才可以。两者共用一套处理逻辑就等于
 *    「一次网络抖动把用户踢下线」。
 */

/** 草案 §10.11 建议的最大读取量：5 KiB。 */
export const CIMD_MAX_BODY_BYTES = 5 * 1024;

/** 连接超时 3 秒（项目取值，不是草案要求）。 */
export const CIMD_CONNECT_TIMEOUT_MS = 3_000;

/** 从开始解析 DNS 起算的总预算 5 秒（含 DNS、连接与读取）。 */
export const CIMD_TOTAL_TIMEOUT_MS = 5_000;

/** 没有 Cache-Control 时的默认有效期 1 小时。 */
export const CIMD_DEFAULT_TTL_MS = 60 * 60 * 1000;

/** 无论响应头怎么写都不超过 24 小时。 */
export const CIMD_MAX_TTL_MS = 24 * 60 * 60 * 1000;

/** 单个 URL 字段的长度上限（项目策略）。 */
export const MAX_URL_LENGTH = 2048;

/** client_name 的长度上限（项目策略）：5 KiB 的展示名只会拖垮同意页。 */
export const MAX_CLIENT_NAME_LENGTH = 256;

/**
 * redirect_uris 上限。与 `mcp_oauth_clients` 的 CHECK
 * （`cardinality(redirect_uris) between 1 and 5`）保持一致——多一条就落不了库，
 * 那应该在抓取阶段就拒绝，而不是等到写入时炸掉。
 */
export const CIMD_MAX_REDIRECT_URIS = 5;

/* -------------------------------------------------------------------------- *
 * 结果类型
 * -------------------------------------------------------------------------- */

export type CimdFailureKind = "transient" | "terminal";

export type CimdFailureReason =
  | "client_id_url"
  | "dns_failure"
  | "ssrf_address"
  | "timeout"
  | "tls_failure"
  | "transport_error"
  | "http_status"
  | "content_type"
  | "too_large"
  | "json"
  | "client_id_mismatch"
  /** [ID §10.1]：client_id 等于 issuer / resource / 受信 AS·RS 标识符（设计 §3.2）。 */
  | "client_id_conflict"
  | "document"
  | "unsupported_client";

export interface CimdClientMetadata {
  clientId: string;
  clientName: string;
  clientUri?: string;
  logoUri?: string;
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: "none";
}

export interface CimdCachePolicy {
  /** `no-store` 为 false：连缓存行都不该写。 */
  storable: boolean;
  /** 有效期（毫秒）。`no-cache` 为 0：可存但立刻过期，必须重新抓取。 */
  ttlMs: number;
  source: "no-store" | "no-cache" | "s-maxage" | "max-age" | "default";
}

export type CimdOutcome =
  | {
      ok: true;
      metadata: CimdClientMetadata;
      cache: CimdCachePolicy;
      /** 写 `metadata_cache_expires_at` 的值；不可缓存时为 null。 */
      cacheExpiresAt: Date | null;
    }
  | {
      ok: false;
      kind: CimdFailureKind;
      reason: CimdFailureReason;
      detail: string;
    };

export type HttpStatusClass = "ok" | "transient" | "terminal";

/**
 * HTTP 状态码分类（R1-4）。
 *
 * 「非 200 一律 terminal」会把 503 / 429 这类**临时**故障记成「客户端元数据
 * 失效」，进而允许调用方作废缓存与 refresh token。临时故障必须可重试：
 *
 * - `transient`：408（请求超时）、425（Too Early）、429（限流）、全部 5xx。
 * - `terminal`：3xx（不跟随重定向）、其它 4xx，以及 2xx 里除 200 之外的形态
 *   （201/204 不是 CIMD 文档）。
 *
 * 只有 200 会进入 JSON 解析。
 */
export function classifyHttpStatus(status: number): HttpStatusClass {
  if (status === 200) return "ok";
  if (status === 408 || status === 425 || status === 429) return "transient";
  if (status >= 500 && status <= 599) return "transient";
  return "terminal";
}

function terminal(reason: CimdFailureReason, detail: string): CimdOutcome {
  return { ok: false, kind: "terminal", reason, detail };
}

function transient(reason: CimdFailureReason, detail: string): CimdOutcome {
  return { ok: false, kind: "transient", reason, detail };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type DeadlineResult<T> =
  | { kind: "value"; value: T }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" };

/**
 * 给一个 Promise 加**真正的**截止时间（R1-2）。
 *
 * `Promise.race` 的经典陷阱是落败那一边的 rejection 没人接，变成
 * `unhandledRejection`。这里把工作分支先 `.then(…, …)` 成**永不 reject** 的
 * promise，再用一个只 resolve 的定时器竞速——两边都不会抛，迟到结果被安静吸收。
 *
 * 另一个陷阱是「await 之后再检查耗时」：DNS 如果一直 pending，检查永远轮不到。
 * 所以截止时间必须在等待**期间**生效。
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<DeadlineResult<T>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<DeadlineResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), Math.max(0, ms));
  });
  const settled = work.then(
    (value): DeadlineResult<T> => ({ kind: "value", value }),
    (error): DeadlineResult<T> => ({ kind: "error", error }),
  );

  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- *
 * Client Identifier URL（草案 §3 + 项目更严格的本地策略）
 * -------------------------------------------------------------------------- */

const ABSOLUTE_URL = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([\s\S]*)$/;
const ALLOWED_PORT = "443";

type UrlCheck = { ok: true } | { ok: false; detail: string };

function urlFail(detail: string): UrlCheck {
  return { ok: false, detail };
}

/**
 * 拆 authority，返回 host 与 port。
 *
 * 不能用 `split(":")`：IPv6 字面量 `[::1]:443` 的 host 里就有冒号。方括号形式
 * 单独处理，其余情况按「最后一个冒号」切（端口不可能含冒号）。
 */
function splitAuthority(authority: string): { host: string; port: string | null } {
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close === -1) return { host: "", port: null };
    const host = authority.slice(1, close);
    const rest = authority.slice(close + 1);
    if (rest === "") return { host, port: null };
    if (!rest.startsWith(":")) return { host: "", port: null };
    return { host, port: rest.slice(1) };
  }
  const colon = authority.lastIndexOf(":");
  if (colon === -1) return { host: authority, port: null };
  return { host: authority.slice(0, colon), port: authority.slice(colon + 1) };
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Client Identifier URL 校验。**只看原始字符串**。
 *
 * | 规则 | 依据 |
 * |---|---|
 * | https only | 草案 §3 MUST |
 * | 无 userinfo（含空 userinfo `https://@host/x`） | 草案 §3 MUST NOT |
 * | 路径不能是 `/` | 草案 §3 MUST |
 * | 无 `.` / `..` 段（含百分号编码） | 草案 §3 MUST NOT |
 * | 无 fragment（含空 fragment） | 草案 §3 MUST NOT |
 * | 无 query | 草案是 SHOULD NOT，**本项目直接拒绝**（更严格） |
 * | 端口只能是 443 | **项目自己的安全限制**，草案允许带端口 |
 * | 无反斜杠 | 项目限制：WHATWG 把 `\` 当 `/`，先拒绝再解析 |
 */
export function validateClientIdentifierUrl(raw: string): UrlCheck {
  if (raw.length === 0) return urlFail("empty client_id");
  // 长度上限是**项目策略**（草案没有长度要求）：2048 已远高于任何真实 client_id。
  if (raw.length > MAX_URL_LENGTH) return urlFail(`client_id is longer than ${MAX_URL_LENGTH}`);
  if (raw !== raw.trim()) return urlFail("client_id has surrounding whitespace");

  const parts = ABSOLUTE_URL.exec(raw);
  if (!parts) return urlFail("client_id must be an absolute URL");
  const scheme = (parts[1] ?? "").toLowerCase();
  if (scheme !== "https") return urlFail(`scheme "${scheme}" is not https`);

  const afterScheme = parts[2] ?? "";
  const authorityEnd = afterScheme.search(/[/\\?#]/);
  const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  const rest = authorityEnd === -1 ? "" : afterScheme.slice(authorityEnd);

  if (authority === "") return urlFail("empty authority");
  if (authority.includes("@")) return urlFail("userinfo is not allowed");

  const { host, port } = splitAuthority(authority);
  if (host === "") return urlFail("empty host");
  if (port !== null && port !== ALLOWED_PORT) {
    return urlFail(`port "${port}" is not allowed (only 443)`);
  }

  if (rest === "" || rest === "/") return urlFail("client_id must have a path other than /");
  if (rest.startsWith("?") || rest.startsWith("#")) return urlFail("client_id must have a path");
  if (rest.includes("#")) return urlFail("fragment is not allowed");
  if (rest.includes("?")) return urlFail("query is not allowed (project policy)");
  if (rest.includes("\\")) return urlFail("backslash is not allowed in the path");

  for (const segment of rest.split("/")) {
    if (segment === "") continue;
    const decoded = decodeSegment(segment);
    if (decoded === null) return urlFail("invalid percent-encoding in the path");
    // 点段在解析后会被折叠成 `/`；原始串里必须先拒绝。
    if (decoded === "." || decoded === "..") return urlFail("dot path segment is not allowed");
  }

  try {
    // 合法性兜底（非法主机名、裸 `[` 等）。判断已经做完，这里不读它的字段。
    new URL(raw);
  } catch {
    return urlFail("client_id is not a valid URL");
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- *
 * Client Identifier URL 的身份冲突检查（[ID §10.1]，设计 §3.2）
 * -------------------------------------------------------------------------- */

/**
 * `client_id` 是否为 **URL 形态**（含 `scheme://`）。
 *
 * [ID §10.1] 的对象是 Client Identifier URL；不透明 id（`brewphase-desktop`
 * 这类随机串）在构造上不可能等于 URL 形态的 issuer / resource / 受信 AS·RS
 * 标识符，因此**不经过**身份比对（设计 §3.2 纪律 4）。
 *
 * 判据是**原始字符串**里有没有 `scheme://`——不做 WHATWG 解析，因为
 * `https://h/a/..` 这类值在解析后看不出问题（C3c-1-R1 / C3c-2 的同一个教训）。
 */
export function isUrlShapedClientId(clientId: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(clientId);
}

/**
 * [ID §10.1] 身份冲突比较：`client_id` 是否等于某个受信标识符。
 *
 * **纯函数**：不读 env、不发网络、不写库——受信列表由调用方注入
 * （生产是 `Env.mcpTrustedPeerIdentifiers` + issuer + MCP resource）。
 *
 * **原始字符串逐字符比较**：不做大小写折叠、不补默认端口、不去尾斜杠。
 * §10.1 明确要求 RFC 3986 §6.2.1 的简单字符串比较；在这里做归一化反而会
 * 造出「被拒绝的字符串」与「当成自己的字符串」两套判据（设计 §3.2 纪律 1）。
 */
export function conflictsWithTrustedIdentifier(
  clientId: string,
  trusted: readonly string[],
): boolean {
  return trusted.some((identifier) => identifier === clientId);
}

/**
 * [ID §10.1] 身份冲突的**完整判定**（设计 §3.2 纪律 4）：按 client_id **形态**
 * 适用，**不按 `registration_source`**。
 *
 * - URL 形态（含 `scheme://`，**包括人工预注册的 URL id**）→ 逐字符比较；
 * - 不透明 id（`brewphase-desktop` 这类）→ 跳过（构造上不可能等于 URL 形态的
 *   受信标识符；[ID §10.1] 的对象也是 Client Identifier URL）。
 *
 * 返回 `true` 表示必须拒绝（terminal `client_id_conflict`）。**不能仅凭
 * `registration_source` 就绕过 token confusion 检查**——预注册 URL id 若等于
 * issuer / resource / 受信 AS·RS 同样必须拒。
 *
 * 这是 fetch 路径与（C3c-3B-2 的）registry 共用的同一个谓词。
 */
export function clientIdConflictsWithTrusted(
  clientId: string,
  trusted: readonly string[],
): boolean {
  if (!isUrlShapedClientId(clientId)) return false;
  return conflictsWithTrustedIdentifier(clientId, trusted);
}

/* -------------------------------------------------------------------------- *
 * SSRF：地址分类
 * -------------------------------------------------------------------------- */

/**
 * RFC 6890 特殊用途地址。
 *
 * `net.BlockList` 内部把 IPv4 表示成 `::ffff:a.b.c.d`，所以**绝不能**把
 * `::ffff:0:0/96` 加进同一张表——那会把所有 IPv4 都判成私有。IPv4-mapped
 * 地址改用单独的 BlockList 识别，见 `isPubliclyRoutableAddress`。
 */
const BLOCKED = new net.BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8], // 本网络 / 未指定
  ["10.0.0.0", 8], // 私有
  ["100.64.0.0", 10], // CGNAT (RFC 6598)
  ["127.0.0.0", 8], // Loopback
  ["169.254.0.0", 16], // Link-local（含云元数据 169.254.169.254）
  ["172.16.0.0", 12], // 私有
  ["192.0.0.0", 24], // IETF Protocol Assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.31.196.0", 24], // AS112-v4
  ["192.52.193.0", 24], // AMT
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // 私有
  ["192.175.48.0", 24], // AS112 direct delegation
  ["198.18.0.0", 15], // Benchmark
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // Multicast
  ["240.0.0.0", 4], // Reserved（含 255.255.255.255 广播）
] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128], // 未指定
  ["::1", 128], // Loopback
  ["::", 96], // IPv4-compatible（已废弃）
  ["64:ff9b::", 96], // NAT64 well-known
  ["64:ff9b:1::", 48], // NAT64 local-use
  ["100::", 64], // Discard-only
  ["2001::", 23], // IETF Protocol Assignments（含 Teredo）
  ["2001:db8::", 32], // 文档保留
  ["2002::", 16], // 6to4
  ["2620:4f:8000::", 48], // AS112-v6
  ["3fff::", 20], // 文档保留（RFC 9637）
  ["5f00::", 16], // SRv6 SIDs（RFC 9602）
  ["fc00::", 7], // ULA
  ["fe80::", 10], // Link-local
  ["ff00::", 8], // Multicast
] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv6");
}

/** 单独一张表：只用来识别 IPv4-mapped IPv6，避免污染 IPv4 判定。 */
const IPV4_MAPPED = new net.BlockList();
IPV4_MAPPED.addSubnet("::ffff:0:0", 96, "ipv6");

/**
 * IANA IPv6 Address Space Registry 里的全球单播段 `2000::/3`。
 *
 * 黑名单挡不住「整段都不是公网」的地址（`4000::1`、`c000::1` 之类），所以
 * IPv6 先用这张表做**白名单**：不属于 2000::/3 的一律拒绝，再走特殊用途排除。
 * 这比「只排掉已知坏段」稳妥——未分配的段等于不可达，没有理由去连。
 */
const GLOBAL_UNICAST_V6 = new net.BlockList();
GLOBAL_UNICAST_V6.addSubnet("2000::", 3, "ipv6");

/**
 * 这个地址能不能作为抓取目标。
 *
 * 只接受「确定是公网」的地址：未知形态、IPv4-mapped IPv6、任何 RFC 6890
 * 特殊用途段一律 false。返回 false 就是拒绝整个目标（不看其它解析结果）。
 */
export function isPubliclyRoutableAddress(address: string): boolean {
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const family = net.isIP(bare);

  if (family === 4) return !BLOCKED.check(bare, "ipv4");

  if (family === 6) {
    // IPv4-mapped 一律拒绝：公网域名没有理由解析到映射地址，而它是经典的
    // 「看起来像 IPv6、实际打到 127.0.0.1」绕过手段。
    if (IPV4_MAPPED.check(bare, "ipv6")) return false;
    // 白名单：先确认属于全球单播 2000::/3，再排特殊用途段。
    if (!GLOBAL_UNICAST_V6.check(bare, "ipv6")) return false;
    return !BLOCKED.check(bare, "ipv6");
  }
  return false;
}

export interface CimdAddress {
  address: string;
  family: 4 | 6;
}

/**
 * 解析目标主机的**全部** A / AAAA 记录。
 *
 * 用 `resolve4` / `resolve6` 而不是 `lookup`：后者只返回一个地址，而 SSRF
 * 的关键判据是「所有结果都必须是公网」——只查第一个等于给攻击者留一个
 * 「第一条公网、第二条内网」的缝隙。
 */
export async function resolveCimdHost(hostname: string): Promise<CimdAddress[]> {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

  // IP 字面量没有 DNS 可查，直接按地址本身分类。
  const literal = net.isIP(bare);
  if (literal === 4) return [{ address: bare, family: 4 }];
  if (literal === 6) return [{ address: bare, family: 6 }];

  const [v4, v6] = await Promise.allSettled([dns.resolve4(bare), dns.resolve6(bare)]);
  const out: CimdAddress[] = [];
  const seen = new Set<string>();
  const push = (address: string, family: 4 | 6): void => {
    if (seen.has(address)) return;
    seen.add(address);
    out.push({ address, family });
  };

  if (v4.status === "fulfilled") for (const address of v4.value) push(address, 4);
  if (v6.status === "fulfilled") for (const address of v6.value) push(address, 6);

  if (out.length === 0) {
    const reason = v4.status === "rejected" ? v4.reason : v6.status === "rejected" ? v6.reason : null;
    throw reason instanceof Error ? reason : new Error(`no A/AAAA records for ${bare}`);
  }
  return out;
}

/* -------------------------------------------------------------------------- *
 * HTTP 响应
 * -------------------------------------------------------------------------- */

export interface CimdTransportRequest {
  url: URL;
  /** 已经过 SSRF 校验、且**必须**用于连接的那个地址。 */
  address: string;
  family: 4 | 6;
  connectTimeoutMs: number;
  totalTimeoutMs: number;
}

export interface CimdTransportResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Uint8Array;
  /** 超过 `CIMD_MAX_BODY_BYTES`：无论状态码如何都按错误处理。 */
  bodyTooLarge: boolean;
}

export interface CimdFetcherDeps {
  resolve(hostname: string): Promise<CimdAddress[]>;
  request(input: CimdTransportRequest): Promise<CimdTransportResponse>;
  now(): Date;
  /** 单调时钟（毫秒）。DNS 也计入总预算，所以要在解析前后各取一次。 */
  monotonic(): number;
  totalTimeoutMs?: number;
}

/** 生产依赖：真实 DNS + 固定目标 HTTPS 请求。 */
export function createCimdDeps(proxy: OutboundProxy): CimdFetcherDeps {
  return {
    resolve: resolveCimdHost,
    request: async (input) => {
      const response = await requestPinnedHttps({
        url: input.url,
        pinnedAddress: input.address,
        addressFamily: input.family,
        maxBodyBytes: CIMD_MAX_BODY_BYTES,
        connectTimeoutMs: input.connectTimeoutMs,
        totalTimeoutMs: input.totalTimeoutMs,
        proxy,
        // 刻意**不**设置 `caOverride`：生产入口必须走系统默认 CA 信任链
        // （设计 §10.2）。信任锚覆盖只属于测试注入。
      });
      return {
        status: response.status,
        headers: response.headers,
        body: response.body,
        bodyTooLarge: response.bodyTooLarge,
      };
    },
    now: () => new Date(),
    // 单调时钟：不受系统时间回拨影响，DNS / 连接 / 读取共用一个预算。
    monotonic: () => performance.now(),
  };
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/**
 * 只接受 `application/json` 与 `application/<subtype>+json`。
 *
 * 缺 Content-Type 一律拒绝：草案只要求「响应是 JSON」，但一个不说自己是什么
 * 的响应无法证明这点，公开文档没有理由不带。
 */
export function isJsonContentType(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const mime = raw.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime === "application/json") return true;
  return /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mime);
}

const TLS_ERROR_PATTERN = /CERT|VERIFY|TLS|SSL/;

function classifyTransportError(error: unknown): CimdOutcome {
  const code =
    typeof (error as { code?: unknown } | null)?.code === "string"
      ? ((error as { code: string }).code)
      : "";
  const name = error instanceof Error ? error.name : "";

  if (code === "PINNED_REQUEST_TIMEOUT" || code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
    return transient("timeout", describe(error));
  }
  if (code === "ABORT_ERR" || name === "AbortError") {
    return transient("timeout", "request aborted");
  }
  // 证书链 / 主机名不匹配：这是信任问题，不是「等会儿再试」。
  if (TLS_ERROR_PATTERN.test(code)) {
    return terminal("tls_failure", describe(error));
  }
  return transient("transport_error", describe(error));
}

/* -------------------------------------------------------------------------- *
 * 文档校验
 * -------------------------------------------------------------------------- */

const SUPPORTED_GRANT_TYPES = new Set(["authorization_code", "refresh_token"]);
const SUPPORTED_RESPONSE_TYPES = new Set(["code"]);
const SHARED_SECRET_METHODS = new Set([
  "client_secret_post",
  "client_secret_basic",
  "client_secret_jwt",
]);
const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"] as const;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "::1", "localhost"]);

/**
 * redirect URI 的本地策略。
 *
 * 项目目前只支持 Web 与回环客户端：https 任意主机；http 仅限回环（RFC 8252
 * 的原生应用回环流程）。不接受自定义 scheme、通配符、fragment 或 userinfo。
 * 这是**本项目**的准入策略，CIMD 草案本身不限制这些形态。
 */
export function validateRedirectUri(raw: string): UrlCheck {
  if (raw.length === 0) return urlFail("empty redirect_uri");
  if (raw.length > 2048) return urlFail("redirect_uri is too long");
  if (raw.includes("*")) return urlFail("wildcard is not allowed");
  if (raw !== raw.trim()) return urlFail("redirect_uri has surrounding whitespace");

  const parts = ABSOLUTE_URL.exec(raw);
  if (!parts) return urlFail("redirect_uri must be an absolute URL");
  const scheme = (parts[1] ?? "").toLowerCase();
  if (scheme !== "https" && scheme !== "http") {
    return urlFail(`scheme "${scheme}" is not supported`);
  }

  const afterScheme = parts[2] ?? "";
  const authorityEnd = afterScheme.search(/[/\\?#]/);
  const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  const rest = authorityEnd === -1 ? "" : afterScheme.slice(authorityEnd);

  if (authority === "") return urlFail("empty authority");
  if (authority.includes("@")) return urlFail("userinfo is not allowed");
  if (rest.includes("#")) return urlFail("fragment is not allowed");
  if (rest.includes("\\")) return urlFail("backslash is not allowed");

  const { host } = splitAuthority(authority);
  if (scheme === "http" && !LOOPBACK_HOSTS.has(host.toLowerCase())) {
    return urlFail("http is only allowed for loopback redirect URIs");
  }

  try {
    new URL(raw);
  } catch {
    return urlFail("redirect_uri is not a valid URL");
  }
  return { ok: true };
}

/**
 * `client_uri` / `logo_uri` 这类**只展示、从不抓取**的 URL。
 *
 * 草案不限制它们的 scheme，但项目会在同意页把它们渲染成链接/图片，所以按
 * 「可安全渲染」的标准收紧：https、无 userinfo、长度受限。这是**项目策略**，
 * 不是 RFC 要求。校验失败按文档非法处理（fail-closed）——悄悄丢弃会让一个被
 * 篡改的文档看起来仍然正常。
 */
export function validateInformationalUri(raw: string): UrlCheck {
  if (raw.length === 0) return urlFail("empty");
  if (raw.length > MAX_URL_LENGTH) return urlFail(`longer than ${MAX_URL_LENGTH}`);
  if (raw !== raw.trim()) return urlFail("surrounding whitespace");

  const parts = ABSOLUTE_URL.exec(raw);
  if (!parts) return urlFail("must be an absolute URL");
  const scheme = (parts[1] ?? "").toLowerCase();
  if (scheme !== "https") return urlFail(`scheme "${scheme}" is not https`);

  const afterScheme = parts[2] ?? "";
  const authorityEnd = afterScheme.search(/[/\\?#]/);
  const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  if (authority === "") return urlFail("empty authority");
  if (authority.includes("@")) return urlFail("userinfo is not allowed");

  try {
    new URL(raw);
  } catch {
    return urlFail("not a valid URL");
  }
  return { ok: true };
}

type DocumentCheck =
  | { ok: true; metadata: CimdClientMetadata }
  | { ok: false; reason: CimdFailureReason; detail: string };

function docFail(reason: CimdFailureReason, detail: string): DocumentCheck {
  return { ok: false, reason, detail };
}

function readStringArray(value: unknown): string[] | null | "invalid" {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return "invalid";
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return "invalid";
    out.push(item);
  }
  return out;
}

/**
 * 校验 Client ID Metadata Document。
 *
 * 必需字段（**项目策略**，草案只把 `client_id` 定为 MUST）：
 * `client_id`（逐字符相等）、`client_name`（非空）、`redirect_uris`（1–5 条、
 * 不重复、无通配符）。同时执行草案 §4.1 的凭据限制与 §6 的 grant/response
 * 交集要求。
 */
export function validateCimdDocument(doc: Record<string, unknown>, clientId: string): DocumentCheck {
  if (doc.client_id !== clientId) {
    return docFail("client_id_mismatch", "document client_id does not match the fetched URL");
  }

  const clientName = doc.client_name;
  if (typeof clientName !== "string" || clientName.trim() === "") {
    return docFail("document", "client_name must be a non-empty string");
  }
  if (clientName.length > MAX_CLIENT_NAME_LENGTH) {
    return docFail("document", `client_name is longer than ${MAX_CLIENT_NAME_LENGTH}`);
  }

  // 草案 §4.1：共享对称密钥相关字段一律不得出现。
  if ("client_secret" in doc) return docFail("unsupported_client", "client_secret must not be used");
  if ("client_secret_expires_at" in doc) {
    return docFail("unsupported_client", "client_secret_expires_at must not be used");
  }

  if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== "none") {
    return docFail("unsupported_client", "only token_endpoint_auth_method=none is supported");
  }

  if (doc.token_endpoint_auth_methods_supported !== undefined) {
    const methods = readStringArray(doc.token_endpoint_auth_methods_supported);
    if (methods === "invalid" || methods === null || methods.length === 0) {
      return docFail("document", "token_endpoint_auth_methods_supported must be a non-empty string array");
    }
    if (methods.some((method) => SHARED_SECRET_METHODS.has(method))) {
      return docFail("unsupported_client", "shared-secret client authentication is not supported");
    }
    if (!methods.includes("none")) {
      return docFail("unsupported_client", "client does not support token_endpoint_auth_method=none");
    }
  }

  if ("jwks" in doc && "jwks_uri" in doc) {
    return docFail("document", "jwks and jwks_uri must not both be present");
  }
  if ("jwks" in doc) {
    const jwks = doc.jwks;
    if (typeof jwks !== "object" || jwks === null) {
      return docFail("document", "jwks must be an object");
    }
    const keys = (jwks as { keys?: unknown }).keys;
    if (!Array.isArray(keys)) return docFail("document", "jwks.keys must be an array");
    for (const key of keys) {
      if (typeof key !== "object" || key === null) return docFail("document", "jwks key must be an object");
      for (const member of PRIVATE_JWK_MEMBERS) {
        if (member in (key as Record<string, unknown>)) {
          return docFail("unsupported_client", "private key material must not be included");
        }
      }
    }
  }

  // 只展示、不抓取的两个 URL：仍然要能安全地渲染成链接/图片。
  for (const field of ["client_uri", "logo_uri"] as const) {
    const value = doc[field];
    if (value === undefined) continue;
    if (typeof value !== "string") return docFail("document", `${field} must be a string`);
    const check = validateInformationalUri(value);
    if (!check.ok) return docFail("document", `${field}: ${check.detail}`);
  }

  const redirectUris = readStringArray(doc.redirect_uris);
  if (redirectUris === "invalid" || redirectUris === null || redirectUris.length === 0) {
    return docFail("document", "redirect_uris must be a non-empty string array");
  }
  if (redirectUris.length > CIMD_MAX_REDIRECT_URIS) {
    return docFail("document", `redirect_uris must not exceed ${CIMD_MAX_REDIRECT_URIS} entries`);
  }
  const seen = new Set<string>();
  for (const uri of redirectUris) {
    if (seen.has(uri)) return docFail("document", `duplicate redirect_uri "${uri}"`);
    seen.add(uri);
    const check = validateRedirectUri(uri);
    if (!check.ok) return docFail("document", `redirect_uri "${uri}": ${check.detail}`);
  }

  // RFC 7591 §2 的缺省值（设计 §5.6）：**只有省略字段**才走默认。
  // 空数组 `[]` 是「声明了但为空」——交集必空，按 §6 拒绝；两者不可混。
  const declaredGrantTypes = readStringArray(doc.grant_types);
  if (declaredGrantTypes === "invalid") {
    return docFail("document", "grant_types must be a string array");
  }
  const grantTypes = declaredGrantTypes ?? ["authorization_code"];

  const declaredResponseTypes = readStringArray(doc.response_types);
  if (declaredResponseTypes === "invalid") {
    return docFail("document", "response_types must be a string array");
  }
  const responseTypes = declaredResponseTypes ?? ["code"];

  // 草案 §6：两个数组**各自**与 AS 支持集求交集，空交集必须拒绝。
  if (!grantTypes.some((type) => SUPPORTED_GRANT_TYPES.has(type))) {
    return docFail("document", "grant_types has no supported value");
  }
  if (!responseTypes.some((type) => SUPPORTED_RESPONSE_TYPES.has(type))) {
    return docFail("document", "response_types has no supported value");
  }

  /**
   * RFC 7591 §2.1 交叉一致性（设计 §5.6，[项目策略] terminal）。
   *
   * `response_types` 含 `code` ⇒ `grant_types` 必须含 `authorization_code`
   * （「vice versa」方向）。只声明 `refresh_token`、`response` 走默认 `["code"]`
   * 的文档自相矛盾：code 只能由 `authorization_code` grant 产生，而它没有任何
   * 取得首个 code 的途径——**不能因为两个数组各自都有受支持值就放行**。
   *
   * 反向（`grant` 含 `authorization_code` ⇒ `response` 含 `code`）对本项目被
   * 上面的 response 交集检查 subsume：AS 的 `response_types_supported` 只有
   * `"code"`，`response` 不含 `code` 时交集必空，已经先拒了。
   */
  if (responseTypes.includes("code") && !grantTypes.includes("authorization_code")) {
    return docFail(
      "document",
      'inconsistent grant_types/response_types: response_types has "code" but grant_types lacks "authorization_code"',
    );
  }

  const metadata: CimdClientMetadata = {
    clientId,
    clientName,
    redirectUris,
    // 只声明 `authorization_code` 时不自动带上 `refresh_token`：是否签发
    // refresh token 由 `grant_types` 是否**显式**含它决定（设计 §12 #11）。
    grantTypes: [...grantTypes],
    tokenEndpointAuthMethod: "none",
  };
  if (typeof doc.client_uri === "string") metadata.clientUri = doc.client_uri;
  if (typeof doc.logo_uri === "string") metadata.logoUri = doc.logo_uri;
  return { ok: true, metadata };
}

/* -------------------------------------------------------------------------- *
 * 缓存策略
 * -------------------------------------------------------------------------- */

/**
 * 解析 Cache-Control。
 *
 * - `no-store`：不缓存（**不能被默认 TTL 覆盖**）。
 * - `no-cache`：可存但立刻过期——没有 revalidation 通道时，它就是「下次必须
 *   重新抓」。
 * - `s-maxage` 优先于 `max-age`：我们是共享缓存（所有用户共用一份客户端
 *   元数据），RFC 9111 的语义就是共享缓存看 s-maxage。
 * - `Expires` 不读：Cache-Control 优先，而且它更容易写错。
 */
export function parseCimdCachePolicy(cacheControl: string | string[] | undefined): CimdCachePolicy {
  const raw = Array.isArray(cacheControl) ? cacheControl.join(",") : (cacheControl ?? "");
  const directives = new Map<string, string | null>();

  for (const part of raw.split(",")) {
    const segment = part.trim();
    if (segment === "") continue;
    const eq = segment.indexOf("=");
    const key = (eq === -1 ? segment : segment.slice(0, eq)).trim().toLowerCase();
    const value = eq === -1 ? null : segment.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1");
    // 同名指令以第一个为准（RFC 9111 §4.2.1）。
    if (!directives.has(key)) directives.set(key, value);
  }

  if (directives.has("no-store")) return { storable: false, ttlMs: 0, source: "no-store" };
  if (directives.has("no-cache")) return { storable: true, ttlMs: 0, source: "no-cache" };

  for (const source of ["s-maxage", "max-age"] as const) {
    const value = directives.get(source);
    if (value === undefined || value === null) continue;
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) continue;
    const ttlMs = Math.min(Math.max(0, seconds * 1000), CIMD_MAX_TTL_MS);
    return { storable: true, ttlMs, source };
  }

  return { storable: true, ttlMs: CIMD_DEFAULT_TTL_MS, source: "default" };
}

/* -------------------------------------------------------------------------- *
 * 抓取
 * -------------------------------------------------------------------------- */

/**
 * 抓取并校验 Client ID Metadata Document。
 *
 * 顺序：URL 形态 → DNS（全部结果都要公网）→ 固定 IP 请求 → 状态/类型/大小 →
 * JSON → 文档字段 → 缓存策略。任何一步失败都带 `kind` 返回，不抛异常。
 */
export async function fetchClientMetadataDocument(
  clientId: string,
  deps: CimdFetcherDeps,
  options: { trustedIdentifiers?: readonly string[] } = {},
): Promise<CimdOutcome> {
  const urlCheck = validateClientIdentifierUrl(clientId);
  if (!urlCheck.ok) return terminal("client_id_url", urlCheck.detail);

  /**
   * [ID §10.1] 身份冲突检查：**必须在 DNS 之前**（设计 §3.2 纪律 2）。
   *
   * 走到这里 `clientId` 已通过 Client Identifier URL 形态校验，因此它必然是
   * URL 形态——不透明 id（预注册的 `brewphase-desktop` 这类）根本到不了这里，
   * 由 registry 在查库后按形态分流（设计 §3.2 纪律 4）。
   *
   * 一个必然被拒的值不该打开 DNS / 连接面：那既是 SSRF 面（§10.7），也是
   * 「先联网再发现不该抓」的无谓外泄。
   */
  const trusted = options.trustedIdentifiers;
  if (trusted && trusted.length > 0 && clientIdConflictsWithTrusted(clientId, trusted)) {
    return terminal("client_id_conflict", "client_id equals a trusted identifier");
  }

  const url = new URL(clientId);
  const budget = deps.totalTimeoutMs ?? CIMD_TOTAL_TIMEOUT_MS;
  const startedAt = deps.monotonic();

  // 预算从**开始解析 DNS 之前**起算：DNS、连接、TLS、读 body 共用它。
  let resolving: Promise<CimdAddress[]>;
  try {
    resolving = deps.resolve(url.hostname);
  } catch (error) {
    // 同步抛错（注入的实现可能这样）不能逃出「本函数只返回结果、不抛异常」的契约。
    return transient("dns_failure", describe(error));
  }
  const resolved = await withDeadline(resolving, budget);
  if (resolved.kind === "timeout") {
    return transient("timeout", "DNS resolution exceeded the timeout budget");
  }
  if (resolved.kind === "error") {
    // DNS 失败：可能是临时的，也可能是永久不存在。按 transient 处理——保守
    // 方向是「保留已有缓存」，而不是因为一次解析失败就让客户端失效。
    return transient("dns_failure", describe(resolved.error));
  }
  const addresses = resolved.value;
  if (addresses.length === 0) return transient("dns_failure", "no A/AAAA records");

  // 只要有一条落在特殊用途地址，就拒绝整个目标（不看第一个）。
  for (const candidate of addresses) {
    if (!isPubliclyRoutableAddress(candidate.address)) {
      return terminal("ssrf_address", `resolved to special-use address ${candidate.address}`);
    }
  }

  const pinned = addresses[0];
  if (!pinned) return transient("dns_failure", "no A/AAAA records");

  // HTTP 阶段拿到的是**扣除 DNS 之后**的剩余时间，不是重新开始计时的完整预算。
  const remaining = budget - (deps.monotonic() - startedAt);
  if (remaining <= 0) return transient("timeout", "DNS resolution consumed the timeout budget");

  let response: CimdTransportResponse;
  try {
    response = await deps.request({
      url,
      address: pinned.address,
      family: pinned.family,
      connectTimeoutMs: Math.min(CIMD_CONNECT_TIMEOUT_MS, remaining),
      totalTimeoutMs: remaining,
    });
  } catch (error) {
    return classifyTransportError(error);
  }

  // 重定向在这里就是「状态不是 200」：不跟随、不重试、不换 URL。
  const statusClass = classifyHttpStatus(response.status);
  if (statusClass === "transient") {
    return transient("http_status", `HTTP ${response.status}`);
  }
  if (statusClass === "terminal") {
    return terminal("http_status", `HTTP ${response.status}`);
  }
  if (response.bodyTooLarge) {
    return terminal("too_large", `response exceeds ${CIMD_MAX_BODY_BYTES} bytes`);
  }

  const contentType = headerValue(response.headers, "content-type");
  if (!isJsonContentType(contentType)) {
    return terminal("content_type", `unsupported content type ${contentType ?? "(missing)"}`);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
  } catch {
    return terminal("json", "response body is not valid UTF-8");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return terminal("json", "response body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return terminal("json", "document must be a JSON object");
  }

  const document = validateCimdDocument(parsed as Record<string, unknown>, clientId);
  if (!document.ok) return terminal(document.reason, document.detail);

  const cache = parseCimdCachePolicy(headerValue(response.headers, "cache-control"));
  const cacheExpiresAt = cache.storable
    ? new Date(deps.now().getTime() + cache.ttlMs)
    : null;

  return { ok: true, metadata: document.metadata, cache, cacheExpiresAt };
}
