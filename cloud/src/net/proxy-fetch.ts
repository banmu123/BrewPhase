import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import type { Socket } from "node:net";

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

/** 建立到 target 的 CONNECT 隧道（返回裸 socket，TLS 由调用方叠加）。 */
export function openTunnel(
  proxy: URL,
  target: { host: string; port: number },
  timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const proxyPort = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
    const authority = `${target.host}:${target.port}`;
    const headers: Record<string, string> = { Host: authority };
    if (proxy.username) {
      const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers["Proxy-Authorization"] = `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
    }

    const request = http.request({
      host: proxy.hostname,
      port: proxyPort,
      method: "CONNECT",
      path: authority,
      headers,
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`proxy CONNECT timed out after ${timeoutMs}ms`));
    });
    request.once("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT rejected (${response.statusCode ?? 0})`));
        return;
      }
      resolve(socket);
    });
    request.once("error", (error) => reject(error));
    request.end();
  });
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
 * 按环境选择 Provider 出网的 fetch。
 *
 * 未配置代理 → 原生 fetch（默认行为，一行不变）。
 * 配了代理 → 走隧道；`NO_PROXY` 命中的主机仍直连。
 */
export function resolveProviderFetch(
  env: NodeJS.ProcessEnv = process.env,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  const raw = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? "";
  if (!raw.trim()) return baseFetch;

  const proxy = parseProxyUrl(raw);
  if (!proxy) {
    // 不支持的类型（例如 socks5://）：明确回退直连，不假装成功。
    console.warn("[net] unsupported proxy URL for provider traffic; using a direct connection");
    return baseFetch;
  }

  const noProxy = env.NO_PROXY ?? env.no_proxy;
  console.info(
    `[net] provider traffic goes through proxy ${proxy.hostname}:${proxy.port || (proxy.protocol === "https:" ? 443 : 80)}`,
  );

  const proxied = createProxyFetch(proxy);
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
