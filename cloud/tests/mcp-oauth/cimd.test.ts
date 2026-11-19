import { describe, expect, it, vi } from "vitest";
import {
  CIMD_DEFAULT_TTL_MS,
  CIMD_MAX_BODY_BYTES,
  CIMD_MAX_TTL_MS,
  classifyHttpStatus,
  fetchClientMetadataDocument,
  isJsonContentType,
  isPubliclyRoutableAddress,
  parseCimdCachePolicy,
  resolveCimdHost,
  validateClientIdentifierUrl,
  validateCimdDocument,
  type CimdAddress,
  type CimdFetcherDeps,
  type CimdTransportRequest,
  type CimdTransportResponse,
} from "../../src/mcp-oauth/cimd.js";

/**
 * CIMD 严格抓取器（Phase 1.3.1-C3c-2）。
 *
 * 全程注入 resolver 与 transport：不访问公网、不依赖真实 DNS。要钉住的是
 * **判据**——URL 形态、SSRF 地址、重定向、5 KiB、字段校验、缓存与错误分类，
 * 而不是「今天 example.com 解析到几」。
 */

const CLIENT_ID = "https://client.example.com/oauth/client.json";
const PUBLIC_V4 = "93.184.216.34";
const NOW = new Date("2026-11-19T10:00:00.000Z");

const VALID_DOC = {
  client_id: CLIENT_ID,
  client_name: "Example Client",
  redirect_uris: ["https://client.example.com/callback"],
};

interface ResponseOverrides {
  doc?: unknown;
  body?: Uint8Array;
  status?: number;
  headers?: Record<string, string | string[] | undefined>;
  bodyTooLarge?: boolean;
}

function jsonResponse(overrides: ResponseOverrides = {}): CimdTransportResponse {
  const body =
    overrides.body ??
    Buffer.from(JSON.stringify(overrides.doc === undefined ? VALID_DOC : overrides.doc), "utf8");
  return {
    status: overrides.status ?? 200,
    headers: overrides.headers ?? { "content-type": "application/json" },
    body,
    bodyTooLarge: overrides.bodyTooLarge ?? false,
  };
}

interface HarnessOptions {
  addresses?: CimdAddress[];
  resolveError?: Error;
  /** 直接给定 resolver 的 promise（用于「永不返回」「迟到」两类用例）。 */
  resolveResult?: Promise<CimdAddress[]>;
  response?: CimdTransportResponse;
  requestError?: Error;
  /** 依次返回的单调时钟读数；默认恒为 0（剩余预算 5s）。 */
  clock?: number[];
  /** 总预算；默认用生产值 5s。DNS 相关用例会调到几十毫秒以免拖慢测试。 */
  totalTimeoutMs?: number;
}

function harness(options: HarnessOptions = {}) {
  let tick = 0;
  const resolve = vi.fn(async (): Promise<CimdAddress[]> => {
    if (options.resolveResult) return await options.resolveResult;
    if (options.resolveError) throw options.resolveError;
    return options.addresses ?? [{ address: PUBLIC_V4, family: 4 }];
  });
  const request = vi.fn(async (_input: CimdTransportRequest): Promise<CimdTransportResponse> => {
    if (options.requestError) throw options.requestError;
    return options.response ?? jsonResponse();
  });
  const deps: CimdFetcherDeps = {
    resolve,
    request,
    now: () => new Date(NOW),
    monotonic: () => options.clock?.[tick++] ?? 0,
    totalTimeoutMs: options.totalTimeoutMs,
  };
  return { deps, resolve, request };
}

async function expectFailure(
  clientId: string,
  options: HarnessOptions,
  expected: { kind: "transient" | "terminal"; reason: string; detail?: string },
) {
  const h = harness(options);
  const outcome = await fetchClientMetadataDocument(clientId, h.deps);
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("expected a failure outcome");
  expect(outcome.kind).toBe(expected.kind);
  expect(outcome.reason).toBe(expected.reason);
  if (expected.detail) expect(outcome.detail).toContain(expected.detail);
  return { outcome, ...h };
}

describe("Client Identifier URL（原始字符串）", () => {
  async function expectUrlRejected(clientId: string, needle: string): Promise<void> {
    const h = harness();
    const outcome = await fetchClientMetadataDocument(clientId, h.deps);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("terminal");
    expect(outcome.reason).toBe("client_id_url");
    expect(outcome.detail).toContain(needle);
    // 形态不合格时既不该解析 DNS，也不该发起请求。
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  }

  it("拒绝非 https", async () => {
    await expectUrlRejected("http://client.example.com/oauth/client.json", "not https");
  });

  it("拒绝根路径与空路径", async () => {
    await expectUrlRejected("https://client.example.com", "path other than /");
    await expectUrlRejected("https://client.example.com/", "path other than /");
  });

  /**
   * 规范化绕过：这些 URL 的 `pathname` 在 WHATWG 解析后全是 `/`。
   * 判断必须在解析之前做，否则「带路径的 client_id」会被当成根路径放行。
   */
  it("拒绝点段与百分号编码的点段", async () => {
    await expectUrlRejected("https://client.example.com/a/..", "dot path segment");
    await expectUrlRejected("https://client.example.com/..", "dot path segment");
    await expectUrlRejected("https://client.example.com/%2e%2e", "dot path segment");
    await expectUrlRejected("https://client.example.com/a/%2E%2E", "dot path segment");
    await expectUrlRejected("https://client.example.com/a/./client.json", "dot path segment");
    await expectUrlRejected("https://client.example.com/%2E/client.json", "dot path segment");
  });

  it("拒绝 userinfo，包括空 userinfo", async () => {
    await expectUrlRejected("https://@client.example.com/oauth/client.json", "userinfo");
    await expectUrlRejected("https://user:pass@client.example.com/x", "userinfo");
  });

  it("拒绝 fragment，包括空 fragment", async () => {
    await expectUrlRejected("https://client.example.com/oauth/client.json#", "fragment");
    await expectUrlRejected("https://client.example.com/oauth/client.json#frag", "fragment");
  });

  it("拒绝 query（本项目比草案更严格）", async () => {
    await expectUrlRejected("https://client.example.com/oauth/client.json?x=1", "query");
  });

  it("只允许默认端口 443（项目安全限制，不是草案要求）", async () => {
    await expectUrlRejected("https://client.example.com:8443/oauth/client.json", "8443");
    await expectUrlRejected("https://client.example.com:80/oauth/client.json", "80");
  });

  it("拒绝反斜杠路径", async () => {
    await expectUrlRejected("https://client.example.com\\oauth\\client.json", "backslash");
    await expectUrlRejected("https://client.example.com/a\\..", "backslash");
  });

  it("拒绝空串、非绝对 URL 与非法百分号编码", async () => {
    await expectUrlRejected("", "empty client_id");
    await expectUrlRejected("client.example.com/oauth/client.json", "absolute URL");
    await expectUrlRejected("https://client.example.com/%zz", "percent-encoding");
  });

  it("接受显式 :443 与非根路径", () => {
    expect(validateClientIdentifierUrl("https://client.example.com:443/oauth/client.json").ok).toBe(
      true,
    );
    expect(validateClientIdentifierUrl(CLIENT_ID).ok).toBe(true);
  });

  it("client_id 逐字符比较：:443 与不带端口不是同一个", async () => {
    // 文档里写的是带 :443 的形式，请求用的是不带的——即便指向同一台主机也必须拒绝。
    const doc = { ...VALID_DOC, client_id: "https://client.example.com:443/oauth/client.json" };
    await expectFailure(CLIENT_ID, { response: jsonResponse({ doc }) }, {
      kind: "terminal",
      reason: "client_id_mismatch",
    });
  });
});

describe("SSRF：地址分类", () => {
  const BLOCKED_ADDRESSES: Array<[string, string]> = [
    ["10.1.2.3", "IPv4 私有"],
    ["172.16.5.5", "IPv4 私有"],
    ["192.168.1.1", "IPv4 私有"],
    ["127.0.0.1", "IPv4 Loopback"],
    ["127.10.20.30", "IPv4 Loopback 段内任意地址"],
    ["169.254.169.254", "IPv4 Link-local（云元数据）"],
    ["100.64.0.1", "CGNAT"],
    ["100.127.255.254", "CGNAT 上界"],
    ["0.0.0.0", "未指定地址"],
    ["224.0.0.1", "组播"],
    ["239.255.255.255", "组播上界"],
    ["255.255.255.255", "广播"],
    ["192.0.2.5", "文档保留"],
    ["198.51.100.7", "文档保留"],
    ["203.0.113.9", "文档保留"],
    ["198.18.0.1", "Benchmark"],
    ["192.0.0.8", "IETF Protocol Assignments"],
    ["192.31.196.5", "AS112-v4（RFC 7534）"],
    ["192.52.193.5", "AMT（RFC 7450）"],
    ["192.175.48.5", "AS112 direct delegation（RFC 7535）"],
    ["fc00::1", "IPv6 ULA"],
    ["fd12:3456::1", "IPv6 ULA"],
    ["::1", "IPv6 Loopback"],
    ["fe80::1", "IPv6 Link-local"],
    ["ff02::1", "IPv6 Multicast"],
    ["::", "IPv6 未指定"],
    ["::ffff:127.0.0.1", "IPv4-mapped IPv6"],
    ["::ffff:10.1.2.3", "IPv4-mapped IPv6（私有）"],
    ["2001:db8::1", "IPv6 文档保留"],
    ["2002::1", "6to4"],
    ["2620:4f:8000::1", "AS112-v6（RFC 7534）"],
    ["64:ff9b::1", "NAT64"],
    ["3fff::1", "IPv6 文档保留（RFC 9637）"],
    // 2000::/3 之外：未分配 / 保留段，黑名单挡不住，靠全球单播白名单。
    ["4000::1", "不属于 2000::/3"],
    ["6000::1", "不属于 2000::/3"],
    ["8000::1", "不属于 2000::/3"],
    ["a000::1", "不属于 2000::/3"],
    ["c000::1", "不属于 2000::/3"],
    ["e000::1", "不属于 2000::/3"],
    ["f000::1", "不属于 2000::/3"],
  ];

  it.each(BLOCKED_ADDRESSES)("%s（%s）判为不可访问", (address) => {
    expect(isPubliclyRoutableAddress(address)).toBe(false);
  });

  it("公网地址放行", () => {
    expect(isPubliclyRoutableAddress("93.184.216.34")).toBe(true);
    expect(isPubliclyRoutableAddress("1.1.1.1")).toBe(true);
    expect(isPubliclyRoutableAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("2000::/3 两端都在允许范围内", () => {
    // IANA IPv6 Address Space Registry：2000::/3 是全球单播。
    expect(isPubliclyRoutableAddress("2000::1")).toBe(true);
    expect(isPubliclyRoutableAddress("2001:4860:4860::8888")).toBe(true);
    // 3fff::/20 是文档保留段，边界要取在它之外但仍在 2000::/3 内。
    expect(isPubliclyRoutableAddress("3fff:ffff::1")).toBe(true);
  });

  it("无法识别的形态一律拒绝", () => {
    expect(isPubliclyRoutableAddress("not-an-address")).toBe(false);
    expect(isPubliclyRoutableAddress("")).toBe(false);
  });

  it.each(BLOCKED_ADDRESSES)("client_id 解析到 %s 时整个目标被拒绝", async (address) => {
    const family = address.includes(":") ? 6 : 4;
    const { request } = await expectFailure(
      CLIENT_ID,
      { addresses: [{ address, family }] },
      { kind: "terminal", reason: "ssrf_address", detail: address },
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("混合公网与私网：只要有一条特殊用途就拒绝整个目标", async () => {
    const { request } = await expectFailure(
      CLIENT_ID,
      {
        addresses: [
          { address: PUBLIC_V4, family: 4 },
          { address: "10.0.0.7", family: 4 },
        ],
      },
      { kind: "terminal", reason: "ssrf_address", detail: "10.0.0.7" },
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("没有解析结果 → transient", async () => {
    await expectFailure(CLIENT_ID, { addresses: [] }, {
      kind: "transient",
      reason: "dns_failure",
      detail: "no A/AAAA records",
    });
  });

  it("DNS 抛错 → transient（不能因为一次解析失败就作废缓存）", async () => {
    await expectFailure(
      CLIENT_ID,
      { resolveError: Object.assign(new Error("queryA ETIMEOUT"), { code: "ETIMEOUT" }) },
      { kind: "transient", reason: "dns_failure", detail: "ETIMEOUT" },
    );
  });

  it("IP 字面量不走 DNS，直接按地址分类", async () => {
    await expect(resolveCimdHost("127.0.0.1")).resolves.toEqual([{ address: "127.0.0.1", family: 4 }]);
    await expect(resolveCimdHost("[::1]")).resolves.toEqual([{ address: "::1", family: 6 }]);
  });

  it("DNS Rebinding：连接用的就是校验通过的那个 IP，且只解析一次", async () => {
    const addresses: CimdAddress[] = [
      { address: "93.184.216.34", family: 4 },
      { address: "93.184.216.35", family: 4 },
    ];
    const h = harness({ addresses });
    const outcome = await fetchClientMetadataDocument(CLIENT_ID, h.deps);

    expect(outcome.ok).toBe(true);
    expect(h.resolve).toHaveBeenCalledTimes(1);
    expect(h.request).toHaveBeenCalledTimes(1);
    const input = h.request.mock.calls[0]?.[0];
    // 连接目标必须是校验时看到的第一个地址，不能是再次解析的结果。
    expect(input?.address).toBe("93.184.216.34");
    expect(input?.family).toBe(4);
    expect(input?.url.hostname).toBe("client.example.com");
  });

  it("DNS 用掉了全部预算 → 不发请求，直接 transient 超时", async () => {
    const h = harness({ clock: [0, 6_000] });
    const outcome = await fetchClientMetadataDocument(CLIENT_ID, h.deps);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("transient");
    expect(outcome.reason).toBe("timeout");
    expect(h.request).not.toHaveBeenCalled();
  });
});

describe("DNS 总预算（R1-2）", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("DNS 在预算内完成 → 继续抓取", async () => {
    const h = harness({ totalTimeoutMs: 50 });
    const outcome = await fetchClientMetadataDocument(CLIENT_ID, h.deps);
    expect(outcome.ok).toBe(true);
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it("DNS 永不返回 → 必须在预算内返回 transient timeout，且不发请求", async () => {
    // 关键：不是「await 之后再检查耗时」——那样 DNS 不返回就永远轮不到检查。
    const h = harness({ resolveResult: new Promise(() => {}), totalTimeoutMs: 40 });
    const startedAt = Date.now();
    const outcome = await fetchClientMetadataDocument(CLIENT_ID, h.deps);
    expect(Date.now() - startedAt).toBeLessThan(2000);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("transient");
    expect(outcome.reason).toBe("timeout");
    expect(h.request).not.toHaveBeenCalled();
  });

  it("DNS 超时后迟到 resolve，不得接着发请求", async () => {
    const late = deferred<CimdAddress[]>();
    const h = harness({ resolveResult: late.promise, totalTimeoutMs: 20 });
    const outcome = await fetchClientMetadataDocument(CLIENT_ID, h.deps);
    expect(outcome.ok).toBe(false);

    late.resolve([{ address: PUBLIC_V4, family: 4 }]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.request).not.toHaveBeenCalled();
  });

  it("DNS 超时后迟到 reject，不产生 unhandled rejection", async () => {
    const late = deferred<CimdAddress[]>();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const h = harness({ resolveResult: late.promise, totalTimeoutMs: 20 });
      const outcome = await fetchClientMetadataDocument(CLIENT_ID, h.deps);
      expect(outcome.ok).toBe(false);

      late.reject(new Error("late DNS failure"));
      // 让微任务/下一轮事件循环跑完，若有未处理 rejection 会在这里被抓到。
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(unhandled).toEqual([]);
      expect(h.request).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("HTTP 阶段拿到的是扣除 DNS 之后的剩余预算", async () => {
    const h = harness({ clock: [0, 1_200] });
    const outcome = await fetchClientMetadataDocument(CLIENT_ID, h.deps);
    expect(outcome.ok).toBe(true);
    const input = h.request.mock.calls[0]?.[0];
    expect(input?.totalTimeoutMs).toBe(3_800);
    // 连接超时取 min(3s, 剩余)；剩余更大时仍是 3s。
    expect(input?.connectTimeoutMs).toBe(3_000);
  });

  it("剩余预算小于连接超时时，连接超时跟着缩短", async () => {
    const h = harness({ clock: [0, 4_600] });
    const outcome = await fetchClientMetadataDocument(CLIENT_ID, h.deps);
    expect(outcome.ok).toBe(true);
    const input = h.request.mock.calls[0]?.[0];
    expect(input?.totalTimeoutMs).toBe(400);
    expect(input?.connectTimeoutMs).toBe(400);
  });

  it("边界：DNS 用掉的正好等于预算 → 不发请求", async () => {
    const h = harness({ clock: [0, 5_000] });
    const outcome = await fetchClientMetadataDocument(CLIENT_ID, h.deps);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("transient");
    expect(outcome.reason).toBe("timeout");
    expect(h.request).not.toHaveBeenCalled();
  });
});

describe("HTTP 状态分类（R1-4）", () => {
  it("只有 200 进入文档解析", () => {
    expect(classifyHttpStatus(200)).toBe("ok");
    expect(classifyHttpStatus(201)).toBe("terminal");
    expect(classifyHttpStatus(204)).toBe("terminal");
  });

  it.each([408, 425, 429, 500, 501, 502, 503, 504, 599])("%i 是 transient", (status) => {
    expect(classifyHttpStatus(status)).toBe("transient");
  });

  it.each([300, 301, 302, 303, 304, 307, 308, 400, 401, 403, 404, 410, 422, 451])(
    "%i 是 terminal",
    (status) => {
      expect(classifyHttpStatus(status)).toBe("terminal");
    },
  );

  it("503 不再被当成「客户端元数据失效」", async () => {
    const h = harness({ response: jsonResponse({ status: 503 }) });
    const outcome = await fetchClientMetadataDocument(CLIENT_ID, h.deps);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("transient");
    expect(outcome.reason).toBe("http_status");
  });

  it.each([503, 429, 408])("%i 不产生缓存结果，也不会作废已有缓存的语义", async (status) => {
    const h = harness({ response: jsonResponse({ status }) });
    const outcome = await fetchClientMetadataDocument(CLIENT_ID, h.deps);
    expect(outcome.ok).toBe(false);
    expect(Object.keys(outcome)).not.toContain("cacheExpiresAt");
  });

  it("3xx 不跟随：transport 只被调用一次，Location 不被使用", async () => {
    const h = harness({
      response: jsonResponse({
        status: 302,
        headers: { "content-type": "application/json", location: "http://169.254.169.254/latest" },
      }),
    });
    const outcome = await fetchClientMetadataDocument(CLIENT_ID, h.deps);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("terminal");
    expect(outcome.reason).toBe("http_status");
    expect(h.request).toHaveBeenCalledTimes(1);
    // 唯一一次请求的目标仍是原始 client_id，不是 Location。
    expect(h.request.mock.calls[0]?.[0].url.hostname).toBe("client.example.com");
  });
});

describe("HTTP 响应", () => {
  it("200 + application/json + 合法文档 → 通过", async () => {
    const h = harness();
    const outcome = await fetchClientMetadataDocument(CLIENT_ID, h.deps);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.metadata.clientId).toBe(CLIENT_ID);
    expect(outcome.metadata.clientName).toBe("Example Client");
    expect(outcome.metadata.redirectUris).toEqual(["https://client.example.com/callback"]);
    expect(outcome.metadata.tokenEndpointAuthMethod).toBe("none");
  });

  it.each([301, 302, 303, 307, 308])("重定向 %i 不跟随，按错误处理", async (status) => {
    await expectFailure(CLIENT_ID, { response: jsonResponse({ status }) }, {
      kind: "terminal",
      reason: "http_status",
      detail: String(status),
    });
  });

  it("404 → terminal", async () => {
    await expectFailure(CLIENT_ID, { response: jsonResponse({ status: 404 }) }, {
      kind: "terminal",
      reason: "http_status",
      detail: "404",
    });
  });

  it("非 JSON Content-Type 拒绝", async () => {
    await expectFailure(
      CLIENT_ID,
      { response: jsonResponse({ headers: { "content-type": "text/html" } }) },
      { kind: "terminal", reason: "content_type", detail: "text/html" },
    );
  });

  it("缺少 Content-Type 拒绝", async () => {
    await expectFailure(CLIENT_ID, { response: jsonResponse({ headers: {} }) }, {
      kind: "terminal",
      reason: "content_type",
      detail: "(missing)",
    });
  });

  it("Content-Type 参数被忽略", () => {
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
    expect(isJsonContentType("APPLICATION/JSON")).toBe(true);
    expect(isJsonContentType("application/vnd.brewphase.client+json")).toBe(true);
    expect(isJsonContentType("application/json ; charset=utf-8")).toBe(true);
    expect(isJsonContentType("text/json")).toBe(false);
    expect(isJsonContentType(undefined)).toBe(false);
  });

  it("超过 5 KiB → terminal（由传输层的流式限制报告）", async () => {
    await expectFailure(CLIENT_ID, { response: jsonResponse({ bodyTooLarge: true }) }, {
      kind: "terminal",
      reason: "too_large",
      detail: String(CIMD_MAX_BODY_BYTES),
    });
  });

  it("上限常量就是 5 KiB", () => {
    expect(CIMD_MAX_BODY_BYTES).toBe(5 * 1024);
  });

  it("连接超时 → transient timeout", async () => {
    const error = Object.assign(new Error("pinned request timed out (connect)"), {
      code: "PINNED_REQUEST_TIMEOUT",
    });
    await expectFailure(CLIENT_ID, { requestError: error }, {
      kind: "transient",
      reason: "timeout",
    });
  });

  it("Socket 超时 → transient timeout", async () => {
    await expectFailure(
      CLIENT_ID,
      { requestError: Object.assign(new Error("socket hang up"), { code: "ETIMEDOUT" }) },
      { kind: "transient", reason: "timeout" },
    );
  });

  it("TLS 证书校验失败 → terminal（信任问题，不是暂时不可用）", async () => {
    await expectFailure(
      CLIENT_ID,
      {
        requestError: Object.assign(new Error("self signed certificate"), {
          code: "DEPTH_ZERO_SELF_SIGNED_CERT",
        }),
      },
      { kind: "terminal", reason: "tls_failure" },
    );
    await expectFailure(
      CLIENT_ID,
      {
        requestError: Object.assign(new Error("Hostname/IP does not match certificate"), {
          code: "ERR_TLS_CERT_ALTNAME_INVALID",
        }),
      },
      { kind: "terminal", reason: "tls_failure" },
    );
  });

  it("普通网络错误 → transient", async () => {
    await expectFailure(
      CLIENT_ID,
      { requestError: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) },
      { kind: "transient", reason: "transport_error" },
    );
  });
});

describe("Document 校验", () => {
  async function expectDocumentRejected(
    doc: unknown,
    expected: { reason: string; detail?: string },
  ): Promise<void> {
    await expectFailure(CLIENT_ID, { response: jsonResponse({ doc }) }, {
      kind: "terminal",
      ...expected,
    });
  }

  it("client_id 不一致 → terminal（不撤销、不缓存，由调用方处置）", async () => {
    await expectDocumentRejected(
      { ...VALID_DOC, client_id: "https://evil.example.com/oauth/client.json" },
      { reason: "client_id_mismatch" },
    );
  });

  it("缺少 / 空 client_name 拒绝", async () => {
    const { client_name: _omitted, ...withoutName } = VALID_DOC;
    await expectDocumentRejected(withoutName, { reason: "document", detail: "client_name" });
    await expectDocumentRejected({ ...VALID_DOC, client_name: "   " }, {
      reason: "document",
      detail: "client_name",
    });
  });

  it("缺少 / 空 redirect_uris 拒绝", async () => {
    const { redirect_uris: _omitted, ...withoutUris } = VALID_DOC;
    await expectDocumentRejected(withoutUris, { reason: "document", detail: "redirect_uris" });
    await expectDocumentRejected({ ...VALID_DOC, redirect_uris: [] }, {
      reason: "document",
      detail: "redirect_uris",
    });
  });

  it("重复 redirect_uri 拒绝", async () => {
    await expectDocumentRejected(
      {
        ...VALID_DOC,
        redirect_uris: [
          "https://client.example.com/callback",
          "https://client.example.com/callback",
        ],
      },
      { reason: "document", detail: "duplicate" },
    );
  });

  it.each([
    ["javascript:alert(1)", "must be an absolute URL"],
    ["ftp://client.example.com/cb", "not supported"],
    ["https://client.example.com/cb#frag", "fragment"],
    ["https://client.example.com/*", "wildcard"],
    ["http://client.example.com/cb", "loopback"],
    ["/relative/callback", "absolute URL"],
    ["https://user@client.example.com/cb", "userinfo"],
  ])("非法 redirect_uri %s 拒绝", async (uri, needle) => {
    await expectDocumentRejected({ ...VALID_DOC, redirect_uris: [uri] }, {
      reason: "document",
      detail: needle,
    });
  });

  it("回环 http 的 redirect_uri 允许（RFC 8252）", async () => {
    const h = harness({
      response: jsonResponse({
        doc: { ...VALID_DOC, redirect_uris: ["http://127.0.0.1:43121/callback"] },
      }),
    });
    const outcome = await fetchClientMetadataDocument(CLIENT_ID, h.deps);
    expect(outcome.ok).toBe(true);
  });

  it("超过数据库上限（5 条）拒绝", async () => {
    await expectDocumentRejected(
      {
        ...VALID_DOC,
        redirect_uris: Array.from({ length: 6 }, (_, i) => `https://client.example.com/cb${i}`),
      },
      { reason: "document", detail: "must not exceed 5" },
    );
  });

  it("client_secret / client_secret_expires_at 一律拒绝", async () => {
    await expectDocumentRejected({ ...VALID_DOC, client_secret: "s3cret" }, {
      reason: "unsupported_client",
      detail: "client_secret",
    });
    await expectDocumentRejected({ ...VALID_DOC, client_secret_expires_at: 0 }, {
      reason: "unsupported_client",
      detail: "client_secret_expires_at",
    });
  });

  it("只支持 token_endpoint_auth_method=none", async () => {
    await expectDocumentRejected(
      { ...VALID_DOC, token_endpoint_auth_method: "client_secret_basic" },
      { reason: "unsupported_client" },
    );
    await expectDocumentRejected(
      { ...VALID_DOC, token_endpoint_auth_methods_supported: ["none", "client_secret_post"] },
      { reason: "unsupported_client", detail: "shared-secret" },
    );
    await expectDocumentRejected(
      { ...VALID_DOC, token_endpoint_auth_methods_supported: ["private_key_jwt"] },
      { reason: "unsupported_client" },
    );
  });

  it("不接受私钥材料，jwks 与 jwks_uri 不能同时出现", async () => {
    await expectDocumentRejected(
      {
        ...VALID_DOC,
        jwks: { keys: [{ kty: "RSA", n: "public", e: "AQAB", d: "private" }] },
      },
      { reason: "unsupported_client", detail: "private key material" },
    );
    await expectDocumentRejected(
      { ...VALID_DOC, jwks: { keys: [] }, jwks_uri: "https://client.example.com/jwks.json" },
      { reason: "document", detail: "both be present" },
    );
  });

  it("grant_types / response_types 与支持集没有交集时拒绝", async () => {
    await expectDocumentRejected({ ...VALID_DOC, grant_types: ["client_credentials"] }, {
      reason: "document",
      detail: "grant_types",
    });
    await expectDocumentRejected({ ...VALID_DOC, response_types: ["token"] }, {
      reason: "document",
      detail: "response_types",
    });
    // 有交集时放行。
    const h = harness({
      response: jsonResponse({
        doc: { ...VALID_DOC, grant_types: ["refresh_token"], response_types: ["code"] },
      }),
    });
    expect((await fetchClientMetadataDocument(CLIENT_ID, h.deps)).ok).toBe(true);
  });

  it("非法 JSON / 非对象文档 → terminal", async () => {
    await expectFailure(
      CLIENT_ID,
      { response: jsonResponse({ body: Buffer.from("{not json", "utf8") }) },
      { kind: "terminal", reason: "json" },
    );
    await expectFailure(CLIENT_ID, { response: jsonResponse({ doc: ["array"] }) }, {
      kind: "terminal",
      reason: "json",
    });
    await expectFailure(CLIENT_ID, { response: jsonResponse({ doc: "string" }) }, {
      kind: "terminal",
      reason: "json",
    });
  });

  it("非 UTF-8 字节拒绝", async () => {
    await expectFailure(
      CLIENT_ID,
      { response: jsonResponse({ body: Buffer.from([0xff, 0xfe, 0x00]) }) },
      { kind: "terminal", reason: "json" },
    );
  });

  it("从不抓取 logo_uri / client_uri / jwks_uri", async () => {
    const h = harness({
      response: jsonResponse({
        doc: {
          ...VALID_DOC,
          logo_uri: "https://cdn.example.com/logo.png",
          client_uri: "https://client.example.com",
          jwks_uri: "https://client.example.com/jwks.json",
        },
      }),
    });
    const outcome = await fetchClientMetadataDocument(CLIENT_ID, h.deps);
    expect(outcome.ok).toBe(true);
    // 只发一次请求：就是抓文档本身。
    expect(h.request).toHaveBeenCalledTimes(1);
    if (!outcome.ok) return;
    expect(outcome.metadata.logoUri).toBe("https://cdn.example.com/logo.png");
  });
});

describe("文档字段的边界（R2-4）", () => {
  async function expectRejected(doc: unknown, detail: string): Promise<void> {
    await expectFailure(CLIENT_ID, { response: jsonResponse({ doc }) }, {
      kind: "terminal",
      reason: "document",
      detail,
    });
  }

  it("每个 JWK 私钥成员都被拒绝（RFC 7518 §6.2.2 含 oth）", async () => {
    for (const member of ["d", "p", "q", "dp", "dq", "qi", "oth", "k"]) {
      await expectFailure(
        CLIENT_ID,
        {
          response: jsonResponse({
            doc: { ...VALID_DOC, jwks: { keys: [{ kty: "RSA", n: "pub", e: "AQAB", [member]: "x" }] } },
          }),
        },
        { kind: "terminal", reason: "unsupported_client", detail: "private key material" },
      );
    }
  });

  it("只有公钥字段的 jwks 允许", async () => {
    const h = harness({
      response: jsonResponse({
        doc: { ...VALID_DOC, jwks: { keys: [{ kty: "RSA", n: "pub", e: "AQAB" }] } },
      }),
    });
    expect((await fetchClientMetadataDocument(CLIENT_ID, h.deps)).ok).toBe(true);
  });

  it("client_uri / logo_uri 必须是 https、无 userinfo、有长度上限", async () => {
    await expectRejected({ ...VALID_DOC, client_uri: "javascript:alert(1)" }, "client_uri");
    await expectRejected({ ...VALID_DOC, client_uri: "http://client.example.com" }, "client_uri");
    await expectRejected({ ...VALID_DOC, logo_uri: "https://user@cdn.example.com/x.png" }, "logo_uri");
    await expectRejected({ ...VALID_DOC, logo_uri: `https://cdn.example.com/${"a".repeat(2100)}` }, "logo_uri");
    await expectRejected({ ...VALID_DOC, logo_uri: 42 }, "logo_uri");
  });

  it("合法的 client_uri / logo_uri 被保留", async () => {
    const h = harness({
      response: jsonResponse({
        doc: {
          ...VALID_DOC,
          client_uri: "https://client.example.com",
          logo_uri: "https://cdn.example.com/logo.png",
        },
      }),
    });
    const outcome = await fetchClientMetadataDocument(CLIENT_ID, h.deps);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.metadata.clientUri).toBe("https://client.example.com");
    expect(outcome.metadata.logoUri).toBe("https://cdn.example.com/logo.png");
  });

  it("client_name 与 client_id 有长度上限", async () => {
    await expectRejected({ ...VALID_DOC, client_name: "名".repeat(300) }, "client_name");
    await expectFailure(
      `https://client.example.com/${"a".repeat(2048)}`,
      {},
      { kind: "terminal", reason: "client_id_url", detail: "longer than" },
    );
  });

  it("resolver 同步抛错也不会让抓取器抛出", async () => {
    const deps: CimdFetcherDeps = {
      resolve: () => {
        throw new Error("sync resolver failure");
      },
      request: vi.fn(),
      now: () => new Date(NOW),
      monotonic: () => 0,
    };
    const outcome = await fetchClientMetadataDocument(CLIENT_ID, deps);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("transient");
    expect(outcome.reason).toBe("dns_failure");
  });
});

describe("缓存策略", () => {
  function policyOf(headers: Record<string, string> | undefined) {
    return parseCimdCachePolicy(headers?.["cache-control"]);
  }

  it("无 Cache-Control → 默认 1 小时", async () => {
    expect(policyOf(undefined)).toEqual({
      storable: true,
      ttlMs: CIMD_DEFAULT_TTL_MS,
      source: "default",
    });
    const h = harness({ response: jsonResponse({ headers: { "content-type": "application/json" } }) });
    const outcome = await fetchClientMetadataDocument(CLIENT_ID, h.deps);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.cacheExpiresAt?.toISOString()).toBe(
      new Date(NOW.getTime() + CIMD_DEFAULT_TTL_MS).toISOString(),
    );
  });

  it("max-age 生效", () => {
    expect(policyOf({ "cache-control": "max-age=600" })).toEqual({
      storable: true,
      ttlMs: 600_000,
      source: "max-age",
    });
  });

  it("s-maxage 优先于 max-age（共享缓存语义）", () => {
    expect(policyOf({ "cache-control": "max-age=60, s-maxage=600" })).toEqual({
      storable: true,
      ttlMs: 600_000,
      source: "s-maxage",
    });
  });

  it("s-maxage 非法时回落到 max-age", () => {
    expect(policyOf({ "cache-control": "s-maxage=abc, max-age=120" })).toEqual({
      storable: true,
      ttlMs: 120_000,
      source: "max-age",
    });
  });

  it("24 小时上限", () => {
    expect(policyOf({ "cache-control": "max-age=604800" }).ttlMs).toBe(CIMD_MAX_TTL_MS);
    expect(policyOf({ "cache-control": "s-maxage=604800" }).ttlMs).toBe(CIMD_MAX_TTL_MS);
  });

  it("max-age=0 立即过期；负值按 0 处理", () => {
    expect(policyOf({ "cache-control": "max-age=0" }).ttlMs).toBe(0);
    expect(policyOf({ "cache-control": "max-age=-5" }).ttlMs).toBe(0);
  });

  it("no-store 不缓存，且不被默认 TTL 覆盖", async () => {
    expect(policyOf({ "cache-control": "no-store" })).toEqual({
      storable: false,
      ttlMs: 0,
      source: "no-store",
    });
    const h = harness({
      response: jsonResponse({
        headers: { "content-type": "application/json", "cache-control": "no-store, max-age=600" },
      }),
    });
    const outcome = await fetchClientMetadataDocument(CLIENT_ID, h.deps);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.cache.storable).toBe(false);
    expect(outcome.cacheExpiresAt).toBeNull();
  });

  it("no-cache 不能当作长期缓存：立刻过期", async () => {
    const h = harness({
      response: jsonResponse({
        headers: { "content-type": "application/json", "cache-control": "no-cache" },
      }),
    });
    const outcome = await fetchClientMetadataDocument(CLIENT_ID, h.deps);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.cache.source).toBe("no-cache");
    expect(outcome.cacheExpiresAt?.getTime()).toBe(NOW.getTime());
  });

  it("Expires 不参与：只看 Cache-Control", async () => {
    const h = harness({
      response: jsonResponse({
        headers: {
          "content-type": "application/json",
          expires: "Wed, 21 Oct 2026 07:28:00 GMT",
        },
      }),
    });
    const outcome = await fetchClientMetadataDocument(CLIENT_ID, h.deps);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.cache.source).toBe("default");
  });

  it("非法文档与错误响应都不带缓存结果", async () => {
    const invalid = await fetchClientMetadataDocument(
      CLIENT_ID,
      harness({ response: jsonResponse({ doc: { ...VALID_DOC, client_id: "x" } }) }).deps,
    );
    expect(invalid.ok).toBe(false);
    const error = await fetchClientMetadataDocument(
      CLIENT_ID,
      harness({ response: jsonResponse({ status: 500 }) }).deps,
    );
    expect(error.ok).toBe(false);
    // 失败结果里没有 cache / cacheExpiresAt 字段可供写入。
    expect(Object.keys(error)).not.toContain("cacheExpiresAt");
  });
});

describe("Transient 与 Terminal 不混淆", () => {
  const CASES: Array<[string, HarnessOptions, "transient" | "terminal"]> = [
    ["DNS 失败", { resolveError: new Error("ENOTFOUND") }, "transient"],
    ["无解析结果", { addresses: [] }, "transient"],
    ["网络错误", { requestError: Object.assign(new Error("x"), { code: "ECONNRESET" }) }, "transient"],
    ["超时", { requestError: Object.assign(new Error("x"), { code: "PINNED_REQUEST_TIMEOUT" }) }, "transient"],
    ["稳定 4xx", { response: jsonResponse({ status: 404 }) }, "terminal"],
    ["非法 JSON", { response: jsonResponse({ body: Buffer.from("<html>") }) }, "terminal"],
    ["client_id 不一致", { response: jsonResponse({ doc: { ...VALID_DOC, client_id: "x" } }) }, "terminal"],
  ];

  it.each(CASES)("%s → %s", async (_name, options, kind) => {
    const h = harness(options);
    const outcome = await fetchClientMetadataDocument(CLIENT_ID, h.deps);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe(kind);
  });
});

describe("validateCimdDocument 直测", () => {
  it("合法文档返回统一形状", () => {
    const result = validateCimdDocument(VALID_DOC, CLIENT_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata.grantTypes).toEqual(["authorization_code", "refresh_token"]);
  });

  it("只读不写：不修改入参", () => {
    const doc = { ...VALID_DOC };
    const snapshot = JSON.stringify(doc);
    validateCimdDocument(doc, CLIENT_ID);
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});
