import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import net from "node:net";

/**
 * Provider 出网的可选代理通道。
 *
 * 为什么需要：Cloud 直连 Google 的 token 端点与 JWKS。Google 在部分网络下
 * **连 TCP 都建不起来**（不是 DNS、也不是证书问题），而同一台机器上的系统代理
 * 能正常 CONNECT 过去。Node 内置的 `NODE_USE_ENV_PROXY` / `--use-env-proxy` 在这类
 * 代理上并不可靠（实测所有 host 都超时），所以这里自己做一条最短的路：
 * 用 `http.request` 发 CONNECT 建隧道，再在隧道上叠 TLS，交给 `https.Agent`。
 *
 * 纪律：
 * - **完全可选**：没有 `HTTPS_PROXY` / `HTTP_PROXY` 时直接返回原生 fetch，行为不变；
 * - **不关证书校验**：隧道之上是正常的 `tls.connect`，`rejectUnauthorized` 保持默认 true；
 * - **不打印凭据**：代理 URL 可能带账号口令，日志只输出 `host:port`；
 * - 只走标准 HTTP(S) 代理，不支持 SOCKS（需要时明确报错回退直连，不静默降级）。
 */

const CONNECT_TIMEOUT_MS = 10_000;

/** 解析代理地址：允许省略 scheme 的 `127.0.0.1:7900` 写法。 */
export function parseProxyUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  return url;
}

/**
 * `NO_PROXY` 命中的主机直接直连。
 * 支持 `*`（全部直连）、精确主机、`.suffix` 与 `*.suffix` 后缀。
 */
export function shouldBypassProxy(hostname: string, noProxy: string | undefined): boolean {
  const host = hostname.toLowerCase();
  const entries = (noProxy ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return false;
  for (const entry of entries) {
    if (entry === "*") return true;
    const bare = entry.replace(/^\*?\./, "");
    if (!bare) continue;
    if (host === bare) return true;
    if (host.endsWith(`.${bare}`)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------------- *
 * 已解析的出网代理配置（Phase 1.3.1-C3c-3B-1，设计 §9.2）
 *
 * 由 `loadEnv()` **唯一**从环境变量解析一次；Provider fetch 与 CIMD pinned
 * 请求都消费这个结构。业务代码不再各自读 `process.env`——那正是 R2v-F10 的
 * 根因（直连用例被宿主机 `HTTPS_PROXY` 静默劫持），也会产生「provider 能通、
 * CIMD 不能」的分裂配置。
 * ------------------------------------------------------------------------- */

/** 代理协议形态（由 `loadEnv` 解析得出）。 */
export type OutboundProxyScheme = "http" | "https" | "unsupported";

export interface OutboundProxy {
  /**
   * 配置的代理地址**原文**（可能含 userinfo）；`null` = 未配置任何代理变量。
   * 保留原文是为了 CONNECT 认证时能取到账号口令；消费方一律经
   * `parseProxyUrl()` 解析，不直接拼接。
   */
  url: string | null;
  /** `NO_PROXY` 原文（逗号分隔；匹配时大小写不敏感）。 */
  noProxy: string;
  /**
   * 协议形态。**只有 `url !== null` 时有意义。**
   *
   * `unsupported` = 配置了代理但协议不可用（如 `socks5://`）：
   * Provider 告警后回退直连；CIMD **必须失败**——「代理配错就直连」会让
   * DNS Pinning 在无人察觉的情况下失效。
   */
  scheme: OutboundProxyScheme;
}

/** 未配置代理的规范值（测试与「直连」分支用）。 */
export function directOutboundProxy(noProxy = ""): OutboundProxy {
  return { url: null, noProxy, scheme: "http" };
}

/**
 * 代理配置的**脱敏**描述，用于启动日志（设计 §9.2）。
 *
 * 绝不输出 userinfo / 密码 / token：http(s) 只输出 `scheme://host:port`
 * （与 `resolveProviderFetch` 的日志纪律一致）。协议不可用时**只输出协议名**，
 * 连主机名都不带——那种配置本身就可疑，没有理由把它完整写进日志。
 */
export function describeOutboundProxy(proxy: OutboundProxy): string {
  if (!proxy.url) return "not configured (direct)";
  if (proxy.scheme === "unsupported") {
    const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(proxy.url);
    const scheme = match?.[1] ?? "unknown";
    return `unsupported scheme "${scheme}" (provider connects directly; CIMD fetches fail closed)`;
  }
  const parsed = parseProxyUrl(proxy.url);
  if (!parsed) {
    return `unparseable ${proxy.scheme} proxy (provider connects directly; CIMD fetches fail closed)`;
  }
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const noProxyNote = proxy.noProxy.trim() ? `; no_proxy=${proxy.noProxy.trim()}` : "";
  return `${parsed.protocol}//${parsed.hostname}:${port}${noProxyNote}`;
}

/**
 * 代理连接的附加选项。
 *
 * 刻意**只有** `caOverride`：没有 `rejectUnauthorized`，也没有任何关闭证书校验
 * 的通道。它只影响「到代理那一跳」，目标服务器的证书校验不受影响。
 */
export interface TunnelOptions {
  /**
   * 信任锚**覆盖**（私有 CA / 测试证书），**仅测试注入**。
   *
   * 按 Node 官方文档（`tls.createSecureContext` 的 `ca` 条目），指定 `ca` 会
   * **完全替换**默认信任链，而不是像 `NODE_EXTRA_CA_CERTS` 那样追加
   * （"If specified, the default list would be completely replaced (instead of
   * being concatenated)"）。名字里的 `Override` 就是在表达这个「替换」语义——
   * 读成「追加」会让人误以为系统默认 CA 仍然生效。
   */
  caOverride?: string | string[];
  /**
   * 中止信号。总预算耗尽时由调用方触发：**建连阶段的 socket 不属于任何
   * request**，只 destroy request 管不到它，必须自己收。
   */
  signal?: AbortSignal;
}

/** 代理端点：URL 的 hostname 对 IPv6 带方括号，连接前必须去掉。 */
function proxyEndpoint(proxy: URL): { host: string; port: number } {
  const raw = proxy.hostname;
  const host = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  return { host, port: Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80)) };
}

/** 把目标写成 CONNECT 的 authority 形式；IPv6 必须保留方括号。 */
function connectAuthority(target: { host: string; port: number }): string {
  const host =
    target.host.includes(":") && !target.host.startsWith("[") ? `[${target.host}]` : target.host;
  return `${host}:${target.port}`;
}

/**
 * 与代理建立连接。
 *
 * `https:` 代理**必须先完成 TLS 握手再发 CONNECT**——否则 `Proxy-Authorization`
 * 会以明文走一跳，代理侧也只会看到一条未加密的隧道请求。证书校验保持默认开启。
 */
function connectToProxy(proxy: URL, timeoutMs: number, options: TunnelOptions): Promise<net.Socket> {
  const endpoint = proxyEndpoint(proxy);
  const secure = proxy.protocol === "https:";

  return new Promise<net.Socket>((resolve, reject) => {
    const socket = secure
      ? tls.connect({
          host: endpoint.host,
          port: endpoint.port,
          // IP 字面量不能作为 SNI（RFC 6066），证书按 IP SAN 校验。
          ...(net.isIP(endpoint.host) === 0 ? { servername: endpoint.host } : {}),
          ca: options.caOverride,
        })
      : net.connect({ host: endpoint.host, port: endpoint.port });

    let settled = false;
    const onAbort = (): void => {
      done(new Error("proxy connection aborted"));
    };
    // 单次 settle：error / close / abort 可能同时发生，重复 resolve/reject 会把
    // 「已交出去的 socket」再销毁一次，也会掩盖真正的首个错误。
    function done(error?: Error): void {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      if (error) {
        socket.destroy();
        reject(error);
        return;
      }
      socket.setTimeout(0);
      resolve(socket);
    }

    if (options.signal?.aborted) {
      done(new Error("proxy connection aborted"));
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    socket.setTimeout(timeoutMs, () => {
      done(new Error(`proxy connection timed out after ${timeoutMs}ms`));
    });
    socket.once(secure ? "secureConnect" : "connect", () => done());
    socket.once("error", (error: Error) => done(error));
    // 握手前被对端关掉时既不会 connect 也不会 error（例如明文代理遇到 TLS 握手）。
    socket.once("close", () => done(new Error("proxy connection closed before it was ready")));
  });
}

/** 在已建立的代理连接上发 CONNECT，并校验 200。 */
function sendConnect(
  socket: net.Socket,
  authority: string,
  proxy: URL,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const headers: Record<string, string> = { Host: authority };
    // 代理凭据**只**发给代理：它是 CONNECT 请求的头，不会进入隧道。
    if (proxy.username) {
      const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers["Proxy-Authorization"] = `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
    }

    // 专用 agent，**不用** `http.globalAgent`：不指定 agent 时 Node 会用全局池，
    // 而 CONNECT 的池名来自 options 的 host/port（这里是默认的 localhost:80）。
    // 一旦池里恰有同名的空闲 keep-alive socket，请求就会写到那条无关连接上。
    // 实例级 `createConnection` 保证只用我们手里这条 socket。
    const agent = new http.Agent({ keepAlive: false });
    (agent as unknown as { createConnection: () => net.Socket }).createConnection = () => socket;

    const request = http.request({
      method: "CONNECT",
      path: authority,
      headers,
      agent,
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`proxy CONNECT timed out after ${timeoutMs}ms`));
    });
    request.once("connect", (response, connected, head) => {
      if (response.statusCode !== 200) {
        connected.destroy();
        reject(new Error(`proxy CONNECT rejected (${response.statusCode ?? 0})`));
        return;
      }
      // 代理可能把目标的首批字节跟在 200 后面一起送来，必须交还给调用方。
      if (head && head.length > 0) connected.unshift(head);
      connected.setTimeout(0);
      resolve();
    });
    request.once("error", (error) => {
      agent.destroy();
      reject(error);
    });
    request.end();
  });
}

/**
 * 建立到 target 的 CONNECT 隧道（返回裸 socket，TLS 由调用方叠加）。
 *
 * `target.host` 已经是调用方校验过的 IP；这里**不再解析任何域名**。
 */
export async function openTunnel(
  proxy: URL,
  target: { host: string; port: number },
  timeoutMs = CONNECT_TIMEOUT_MS,
  options: TunnelOptions = {},
): Promise<net.Socket> {
  const socket = await connectToProxy(proxy, timeoutMs, options);

  /**
   * 建连成功之后、隧道交出去之前，socket 仍然不属于任何 request：
   * `sendConnect` 还没拿到 200 时总预算就可能耗尽。只 destroy 外层 request
   * 管不到它，所以这一段也要挂中止监听。
   */
  const onAbort = (): void => {
    socket.destroy(new Error("proxy tunnel aborted"));
  };
  if (options.signal?.aborted) {
    socket.destroy();
    throw new Error("proxy tunnel aborted");
  }
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await sendConnect(socket, connectAuthority(target), proxy, timeoutMs);
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    // 交出去之后由 request 负责；这里只覆盖「还在建隧道」的窗口。
    options.signal?.removeEventListener("abort", onAbort);
  }
  return socket;
}

type FetchInput = Parameters<typeof fetch>[0];
/** `fetch` 的 init 是可选参数，取出非空形态后用它的字段类型。 */
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;
type FetchHeaders = NonNullable<FetchInit["headers"]>;
type FetchBody = NonNullable<FetchInit["body"]>;

function bodyToBuffer(body: FetchBody | null | undefined): Buffer | null {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), "utf8");
  if (Buffer.isBuffer(body)) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return null;
}

function headersToObject(headers: FetchHeaders | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (Array.isArray(headers)) {
    for (const [key, value] of headers as Array<[string, string]>) out[key] = value;
    return out;
  }
  if (typeof (headers as Headers).forEach === "function") {
    ;(headers as Headers).forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  for (const [key, value] of Object.entries(headers as Record<string, string>)) out[key] = value;
  return out;
}

function toUrl(input: FetchInput): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL((input as Request).url);
}

/** 把 Node 的响应包装成标准 `Response`（服务端只读 status / json / text）。 */
function toResponse(status: number, rawHeaders: http.IncomingHttpHeaders, body: Buffer): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else headers.set(key, value);
  }
  // 无实体状态码不允许带 body，否则 Response 构造会抛错。
  const bodyless = status === 204 || status === 205 || status === 304;
  return new Response(bodyless ? null : body, { status, headers });
}

/**
 * 返回一个「经 HTTP(S) 代理出网」的 fetch 实现。
 * 只处理 Provider 需要的形态：字符串/URL 入参、字符串或 URLSearchParams 请求体。
 */
export function createProxyFetch(proxy: URL): typeof fetch {
  const agents = new Map<string, https.Agent>();

  const agentFor = (host: string, port: number): https.Agent => {
    const key = `${host}:${port}`;
    const cached = agents.get(key);
    if (cached) return cached;
    const agent = new https.Agent({ keepAlive: true, maxSockets: 8 });
    // 必须挂在**实例**上：`https.Agent.prototype.createConnection` 是定义在原型上的
    // （等于 `tls.connect`），构造参数里的同名字段会被忽略——那样请求会绕过代理直连目标。
    (agent as unknown as {
      createConnection: (
        options: { servername?: string },
        callback: (error: Error | null, socket?: tls.TLSSocket) => void,
      ) => void;
    }).createConnection = (options, callback) => {
      openTunnel(proxy, { host, port })
        .then((socket) => {
          // servername 必须用目标主机名做 SNI；证书校验保持默认（开启）。
          const secure = tls.connect({ socket, servername: options.servername || host });
          secure.once("error", (error) => callback(error));
          callback(null, secure);
        })
        .catch((error: Error) => callback(error));
    };
    agents.set(key, agent);
    return agent;
  };

  return async function proxyFetch(input: FetchInput, init?: FetchInit): Promise<Response> {
    const url = toUrl(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = headersToObject(init?.headers);
    const body = bodyToBuffer(init?.body ?? null);
    const signal = init?.signal ?? null;

    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));

    // 明文目标 + HTTPS 代理：这条分支会直接往代理端口发明文请求。与其静默
    // 把明文送到一个 TLS 端点，不如明确失败（Provider 全是 https，正常路径
    // 不会走到这里）。
    if (url.protocol !== "https:" && proxy.protocol === "https:") {
      throw new Error("[net] plaintext HTTP cannot be sent through an HTTPS proxy");
    }

    return await new Promise<Response>((resolve, reject) => {
      const onAbort = (): void => {
        request.destroy(new DOMException("The operation was aborted.", "AbortError"));
      };

      const request =
        url.protocol === "https:"
          ? https.request(
              { protocol: url.protocol, hostname: url.hostname, port, path: `${url.pathname}${url.search}`, method, headers, agent: agentFor(url.hostname, port) },
              (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.once("end", () => {
                  signal?.removeEventListener("abort", onAbort);
                  resolve(toResponse(response.statusCode ?? 0, response.headers, Buffer.concat(chunks)));
                });
              },
            )
          : // 明文 HTTP：按代理规范发绝对形式请求（Provider 端点不会走到这里，
            // 保留是为了覆盖本地自建端点）。
            http.request(
              {
                host: proxy.hostname,
                port: Number(proxy.port || 80),
                path: url.toString(),
                method,
                headers,
              },
              (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.once("end", () => {
                  signal?.removeEventListener("abort", onAbort);
                  resolve(toResponse(response.statusCode ?? 0, response.headers, Buffer.concat(chunks)));
                });
              },
            );

      request.once("error", (error) => {
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      });

      if (signal) {
        if (signal.aborted) {
          request.destroy(new DOMException("The operation was aborted.", "AbortError"));
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      if (body) request.write(body);
      request.end();
    });
  } as typeof fetch;
}

/**
 * 按**已解析的**代理配置选择 Provider 出网的 fetch（设计 §9.2）。
 *
 * 未配置代理 → 原生 fetch（默认行为，一行不变）。
 * 配了代理 → 走隧道；`NO_PROXY` 命中的主机仍直连。
 * 协议不可用（`unsupported`）→ 告警后**回退直连**（Provider 的既有语义；
 * CIMD 走 `resolvePinnedProxy`，那里是硬失败）。
 *
 * `proxy` 是必传参数：不再从 `process.env` 兜底，漏传在类型层就编译不过。
 */
export function resolveProviderFetch(
  proxy: OutboundProxy,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  if (!proxy.url) return baseFetch;

  if (proxy.scheme === "unsupported") {
    // 不支持的类型（例如 socks5://）：明确回退直连，不假装成功。
    console.warn("[net] unsupported proxy URL for provider traffic; using a direct connection");
    return baseFetch;
  }
  const parsed = parseProxyUrl(proxy.url);
  if (!parsed) {
    console.warn("[net] unsupported proxy URL for provider traffic; using a direct connection");
    return baseFetch;
  }

  const noProxy = proxy.noProxy;
  console.info(
    `[net] provider traffic goes through proxy ${parsed.hostname}:${parsed.port || (parsed.protocol === "https:" ? 443 : 80)}`,
  );

  const proxied = createProxyFetch(parsed);
  const routed: typeof fetch = (input, init) => {
    let hostname: string;
    try {
      hostname = toUrl(input).hostname;
    } catch {
      return baseFetch(input, init);
    }
    if (shouldBypassProxy(hostname, noProxy)) return baseFetch(input, init);
    return proxied(input, init);
  };
  return routed;
}

/* ------------------------------------------------------------------------- *
 * 固定目标请求（Phase 1.3.1-C3c-2，CIMD 专用）
 *
 * 与上面的 Provider 通道**刻意分开**：那条路要的是「能出网」，这条路要的是
 * 「只能到达刚才校验过的那个 IP」。两者的失败语义也不同——Provider 通道在
 * 代理不可用时回退直连，这条路必须硬失败（见 `resolvePinnedProxy`）。
 * ------------------------------------------------------------------------- */

/** 固定目标请求的超时 / 字节预算错误。`code` 供上层分类。 */
export class PinnedRequestTimeoutError extends Error {
  readonly code = "PINNED_REQUEST_TIMEOUT";

  constructor(readonly phase: "connect" | "total") {
    super(`pinned request timed out (${phase})`);
    this.name = "PinnedRequestTimeoutError";
  }
}

/**
 * 让 `net.connect` 永远只拿到一个地址：不查 DNS、不重试别的地址。
 *
 * `autoSelectFamily` 默认开启，Node 会用 `{ all: true }` 调这个函数并期待数组；
 * 关掉时又是 `(err, address, family)` 的三参形式。两种都要支持，否则请求会在
 * 某一种形态下**回落到真实 DNS**——那正是 DNS Rebinding 的入口。
 */
export function pinnedLookup(
  address: string,
  family: 4 | 6,
): (
  hostname: string,
  options: { all?: boolean } | undefined,
  callback: (...args: unknown[]) => void,
) => void {
  return (_hostname, options, callback) => {
    if (options?.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

/**
 * CIMD 的代理选择（消费 `loadEnv` 解析好的 `OutboundProxy`）。
 *
 * 与 `resolveProviderFetch` 的关键差别：**不支持的类型必须抛错**。那里可以先
 * 告警再直连，因为「直连 Google」并不会把请求送到一个本该被拦住的地方；而
 * CIMD 的 client_id 由对端提供，一旦「代理配错了就直连」，DNS Pinning 就在
 * 无人察觉的情况下失效了。
 *
 * 判定顺序：未配置 → 直连；协议不可用 → **抛错**（先于 `NO_PROXY`，避免
 * 「socks5 + NO_PROXY 命中」被当成合法直连）；`NO_PROXY` 命中 → 直连；其余 →
 * 解析出代理 URL。
 */
export function resolvePinnedProxy(
  hostname: string,
  proxy: OutboundProxy,
): URL | null {
  if (!proxy.url) return null;
  if (proxy.scheme === "unsupported") {
    throw new Error(
      "[net] unsupported proxy URL for pinned request; refusing to bypass the proxy",
    );
  }
  if (shouldBypassProxy(hostname, proxy.noProxy)) return null;
  const parsed = parseProxyUrl(proxy.url);
  if (!parsed) {
    throw new Error(
      "[net] unsupported proxy URL for pinned request; refusing to bypass the proxy",
    );
  }
  return parsed;
}

/**
 * 响应体的字节上限。
 *
 * 只靠 `Content-Length` 不够（可以谎报、也可以缺失），所以既做**声明值预检**
 * 也做**实际字节累计**。分块传输下每来一块就判一次，超了立刻停——不是先
 * `text()` 再量长度。
 */
export class BodySizeLimiter {
  private readonly chunks: Buffer[] = [];
  private read = 0;
  private tooLarge = false;

  constructor(readonly maxBytes: number) {}

  /** 返回 false 表示已超限，调用方必须停止读取并销毁请求。 */
  push(chunk: Buffer): boolean {
    this.read += chunk.byteLength;
    if (this.read > this.maxBytes) {
      this.tooLarge = true;
      return false;
    }
    this.chunks.push(chunk);
    return true;
  }

  get exceeded(): boolean {
    return this.tooLarge;
  }

  get bytesRead(): number {
    return this.read;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/**
 * CONNECT 的 authority 形式。
 *
 * IPv6 必须加方括号：`CONNECT 2606:4700::1:443` 会被代理当成端口语法错误，
 * 而 `CONNECT [2606:4700::1]:443` 才是合法的 authority。
 */
export function authorityHost(host: string, family: 4 | 6): string {
  return family === 6 && !host.startsWith("[") ? `[${host}]` : host;
}

/** 声明的 `Content-Length` 是否已经超限。非数字（含分块传输）一律视为「未知」。 */
export function declaredLengthExceeds(contentLength: string | string[] | undefined, maxBytes: number): boolean {
  const raw = Array.isArray(contentLength) ? contentLength[0] : contentLength;
  if (raw === undefined) return false;
  const value = Number(raw);
  return Number.isFinite(value) && value > maxBytes;
}

/** `readResponseBody` 需要的最小响应流形状（`http.IncomingMessage` 满足它）。 */
export interface ResponseBodyStream {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  once(event: "end", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  destroy(): void;
}

export interface BodyReadResult {
  body: Buffer;
  bodyTooLarge: boolean;
  bytesRead: number;
  /** 是否因为超限主动销毁了响应流（区别于正常读完）。 */
  destroyedEarly: boolean;
}

/**
 * 流式读取响应体，超过 `maxBodyBytes` 立刻停止。
 *
 * 这里是「5 KiB 上限」的**唯一执行点**：不先 `text()` 再量长度，也不把超限的
 * 半截 body 交给上层——超限时返回空 buffer + `bodyTooLarge`，让调用方按错误
 * 处理，而不是拿一段不完整的 JSON 去解析。
 */
export function readResponseBody(
  stream: ResponseBodyStream,
  maxBodyBytes: number,
): Promise<BodyReadResult> {
  return new Promise<BodyReadResult>((resolve, reject) => {
    const limiter = new BodySizeLimiter(maxBodyBytes);
    let settled = false;

    const finish = (result: BodyReadResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    stream.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (limiter.push(chunk)) return;
      // 超限：立即销毁，不再消费剩余数据。
      stream.destroy();
      finish({
        body: Buffer.alloc(0),
        bodyTooLarge: true,
        bytesRead: limiter.bytesRead,
        destroyedEarly: true,
      });
    });
    stream.once("end", () => {
      finish({
        body: limiter.toBuffer(),
        bodyTooLarge: limiter.exceeded,
        bytesRead: limiter.bytesRead,
        destroyedEarly: false,
      });
    });
    stream.once("error", (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/** `readPinnedResponse` 需要的响应形状（`http.IncomingMessage` 满足它）。 */
export interface ResponseHeadLike extends ResponseBodyStream {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
}

export interface HeadAndBody {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  bodyTooLarge: boolean;
}

/**
 * 读取一次响应的头部与 body（含 `Content-Length` 预检）。
 *
 * 预检命中时**不建立读取循环**：直接 `destroy()` 并返回 `bodyTooLarge`，避免
 * 明知超限还继续把数据读进内存。
 */
export async function readPinnedResponse(
  response: ResponseHeadLike,
  maxBodyBytes: number,
): Promise<HeadAndBody> {
  const status = response.statusCode ?? 0;
  const headers = response.headers;

  if (declaredLengthExceeds(headers["content-length"], maxBodyBytes)) {
    response.destroy();
    return { status, headers, body: Buffer.alloc(0), bodyTooLarge: true };
  }

  const result = await readResponseBody(response, maxBodyBytes);
  return { status, headers, body: result.body, bodyTooLarge: result.bodyTooLarge };
}

export interface PinnedRequestOptions {
  /** 原始 URL。hostname 用于 Host 头、TLS SNI 与证书校验。 */
  url: URL;
  /** 已经过 SSRF 校验的地址；连接**只**会到这个地址。 */
  pinnedAddress: string;
  addressFamily: 4 | 6;
  maxBodyBytes: number;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  /**
   * 已解析的出网代理（`loadEnv` 唯一解析点）。**必传**：漏传会静默直连，
   * 正是 R2v-F10（直连用例被宿主机 `HTTPS_PROXY` 劫持）的根因。
   */
  proxy: OutboundProxy;
  /**
   * 信任锚**覆盖**（私有 CA / 测试证书），对**代理那一跳与目标那一跳**都生效。
   *
   * 注意语义：按 Node 官方文档（`tls.createSecureContext` 的 `ca` 条目），
   * 指定 `ca` 会**完全替换**默认信任链，而不是像 `NODE_EXTRA_CA_CERTS` 那样
   * 追加（"If specified, the default list would be completely replaced
   * (instead of being concatenated)"）。所以这个字段一旦设置，调用方就同时
   * 失去了对公共 CA 的信任——`Override` 的名字正是在表达这层「替换」语义。
   *
   * 无论如何都不改变「必须验证」：没有 `rejectUnauthorized` 字段，也没有任何
   * 关闭校验的入口。**仅测试注入**，生产入口（`createCimdDeps`）不设置它。
   */
  caOverride?: string | string[];
}

export interface PinnedResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  /** 超过字节上限：上层必须当作错误，不能拿半截 body 去解析。 */
  bodyTooLarge: boolean;
}

/** 固定目标请求只带这一个头：不带 Cookie / Authorization / 任何用户标识。 */
export const PINNED_REQUEST_HEADERS = { accept: "application/json" } as const;

const PINNED_CONNECT_TIMEOUT_MS = 3_000;
const PINNED_TOTAL_TIMEOUT_MS = 5_000;

/**
 * 对**固定 IP** 发一次 GET，返回原始响应（不跟随重定向）。
 *
 * 三条纪律：
 * - 直连时用 `lookup` 钉死 IP，`hostname` 仍是原始域名 → SNI 与证书校验对的
 *   是域名而不是 IP，`Host` 头也是域名。
 * - 走代理时 CONNECT 的目标是**IP**，隧道之上再按域名做 TLS。
 * - 证书校验保持默认开启；本函数没有任何关闭它的开关。
 */
export async function requestPinnedHttps(options: PinnedRequestOptions): Promise<PinnedResponse> {
  const {
    url,
    pinnedAddress,
    addressFamily,
    maxBodyBytes,
    connectTimeoutMs = PINNED_CONNECT_TIMEOUT_MS,
    totalTimeoutMs = PINNED_TOTAL_TIMEOUT_MS,
    proxy: outboundProxy,
    caOverride,
  } = options;

  const port = Number(url.port || 443);
  const proxy = resolvePinnedProxy(url.hostname, outboundProxy);

  return await new Promise<PinnedResponse>((resolve, reject) => {
    let settled = false;
    let request: http.ClientRequest | null = null;
    let totalTimer: NodeJS.Timeout | null = null;

    function finish(error: Error | null, response?: PinnedResponse): void {
      if (settled) return;
      settled = true;
      if (totalTimer) clearTimeout(totalTimer);
      if (error) {
        request?.destroy();
        reject(error);
      } else {
        resolve(response as PinnedResponse);
      }
    }

    // 总预算耗尽时，除了 request 本身，还要中止**尚未交出 socket** 的建连阶段
    // （代理 TCP / 代理 TLS）。否则那条 socket 会一直挂着直到对端超时。
    const controller = new AbortController();

    totalTimer = setTimeout(() => {
      controller.abort();
      finish(new PinnedRequestTimeoutError("total"));
    }, totalTimeoutMs);

    const onResponse = (response: http.IncomingMessage): void => {
      readPinnedResponse(response, maxBodyBytes).then(
        (result) => finish(null, result),
        (error: Error) => finish(error),
      );
    };

    const requestOptions: https.RequestOptions = {
      protocol: "https:",
      hostname: url.hostname,
      port,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: PINNED_REQUEST_HEADERS,
      // 证书校验与 SNI 都按原始域名做，绝不改成 IP。
      servername: url.hostname,
      rejectUnauthorized: true,
      ca: caOverride,
    };

    if (proxy) {
      const agent = new https.Agent({ keepAlive: false });
      let connected = false;
      // 必须挂在**实例**上（原型上的 createConnection 是 tls.connect 本身，
      // 构造参数会被忽略），否则请求会绕过代理直连目标。
      (agent as unknown as {
        createConnection: (
          opts: { servername?: string },
          callback: (error: Error | null, socket?: tls.TLSSocket) => void,
        ) => void;
      }).createConnection = (_opts, callback) => {
        openTunnel(
          proxy,
          { host: authorityHost(pinnedAddress, addressFamily), port },
          connectTimeoutMs,
          { caOverride, signal: controller.signal },
        )
          .then((socket) => {
            // 隧道之上按**目标域名**做 TLS：SNI、证书校验、信任锚都按目标来。
            const secure = tls.connect({ socket, servername: url.hostname, ca: caOverride });
            let handshaking = true;
            // R2 复审（F9）：隧道交出之后、TLS 握手完成之前，socket 既不属于
            // request（callback 还没回调），abort 监听也已被 openTunnel 的
            // finally 移除。总超时在这里触发的话，没人销毁这条连接——它会一直
            // 挂到对端回应或内核 TCP 超时。abort 必须覆盖这最后一个窗口。
            const onAbort = (): void => {
              secure.destroy();
              socket.destroy();
              settle(new Error("pinned request aborted during target TLS handshake"));
            };
            const settle = (error: Error | null): void => {
              controller.signal.removeEventListener("abort", onAbort);
              if (!handshaking) return;
              handshaking = false;
              callback(error, error ? undefined : secure);
            };
            if (controller.signal.aborted) {
              onAbort();
              return;
            }
            controller.signal.addEventListener("abort", onAbort, { once: true });
            secure.once("error", settle);
            secure.once("secureConnect", () => settle(null));
          })
          .catch((error: Error) => {
            if (connected) return;
            connected = true;
            callback(error);
          });
      };
      request = https.request({ ...requestOptions, agent }, onResponse);
    } else {
      request = https.request(
        { ...requestOptions, lookup: pinnedLookup(pinnedAddress, addressFamily) as unknown as net.LookupFunction, agent: false },
        onResponse,
      );
    }

    // 连接阶段的 3 秒上限：socket 尚未连上时不产生任何数据，空闲超时正好等于
    // 「连不上」；连上之后立刻解除，避免把读取阶段也套上 3 秒。
    request.once("socket", (socket: net.Socket) => {
      const clear = (): void => {
        socket.setTimeout(0);
      };
      if (socket.connecting) {
        socket.setTimeout(connectTimeoutMs, () => {
          finish(new PinnedRequestTimeoutError("connect"));
        });
        socket.once("connect", clear);
        socket.once("secureConnect", clear);
      }
    });

    request.once("error", (error: Error) => finish(error));
    request.end();
  });
}
