/**
 * WSS Upgrade 的 Origin 白名单构造（Phase 1.3.3-A-R2）。
 *
 * ## 为什么 BASE_URL 要自动进白名单
 *
 * 上一轮用真实设备诊断推翻了既有假设：Electron 45 主进程的 `net.WebSocket`
 * **会**发送 Origin，值就是目标 Cloud URL 自身的 Origin。于是
 * `CORS_ORIGINS` 默认空 → `allowedOrigins` 空集 → **所有**携带 Origin 的
 * Upgrade 请求被 403（15 分钟 16 次 `stage=origin`，Host / 子协议 /
 * Bearer 形态全部通过）。设备 `2951ba0a` 拿到了凭据却永远连不上。
 *
 * 而 Desktop 连的正是 `BASE_URL` 自己——把 BASE_URL 的 Origin 纳入 WSS
 * 白名单，等于「允许连到我自己的 Cloud」，不是放宽边界：它**不经过网络**
 * 可被别人构造（Origin 是浏览器赋的，非浏览器客户端想写什么就写什么），
 * 所以真正的身份认证仍然只有 device_token + 数据库状态 + Ed25519 签名 +
 * nonce。Origin 这一层要挡的是**浏览器上下文**里的网页——那些页面的
 * Origin 由浏览器强制赋值，改不了。
 *
 * ## 三条纪律
 *
 * 1. **精确比对**：只做 `Set.has(origin)`，没有通配、没有后缀匹配、没有
 *    端口忽略。`https://example.com` 不匹配 `https://evil.example.com`，
 *    `http://127.0.0.1:3000` 不匹配 `:3001`。
 * 2. **不接受配置里混进非 Origin**：带 path / query / fragment 的串、
 *    通配域名、非 http(s) scheme 一律**抛错**。静默丢弃会让「我配了却
 *    没生效」变成一个查半天的运维问题；而静默放行更是直接破边界。
 * 3. **BASE_URL 非法必须抛错**，绝不退化成「允许所有 Origin」——那等于
 *    把这一层整个关掉。
 *
 * 本函数是纯函数：不读 env、不读请求、不保存任何 Origin 到模块状态，
 * 返回的数组就是调用方要传给 `createLinkServer` 的全部。
 */

/**
 * 把一个配置值解析成**纯 Origin**（`scheme://host[:port]`），非法即抛。
 *
 * 用 `URL.origin` 而不是原样收下：它会把 scheme / host 小写、去掉默认端口
 * （`https://a.example:443` → `https://a.example`），而浏览器发出的 Origin
 * 头正是这个形态——不规范化就会出现「我配了 `:443` 却永远匹配不上」。
 */
function pureOriginOf(value: string, label: string): string {
  const trimmed = value.trim();
  // 空白条目 = 「没配」，直接跳过而不是抛错：与 `env.ts` 切分
  // `CORS_ORIGINS` 时过滤空串的语义一致（`CORS_ORIGINS=a,,b` 不该炸启动）。
  // 注意这只处理**空**；非空但形态非法的仍然抛——那才是真配错了。
  if (trimmed.length === 0) return "";

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${label} is not a valid origin: ${JSON.stringify(trimmed)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must be an http(s) origin: ${JSON.stringify(trimmed)}`);
  }
  // `https://user:pass@a.example` 不是 Origin 形态，且会把凭据带进白名单。
  if (url.username || url.password) {
    throw new Error(`${label} must not carry userinfo: ${JSON.stringify(trimmed)}`);
  }
  // 通配域名：URL 解析器放行 `*`，但 Origin 头永远不会长这样，
  // 收下它只会让人误以为「配了就匹配所有子域」。
  if (url.hostname.includes("*")) {
    throw new Error(`${label} must not use a wildcard host: ${JSON.stringify(trimmed)}`);
  }
  // Origin 没有 path / query / fragment。收下带 path 的串等于给了一个
  // 永远匹配不上的条目（而 `*` 一旦被当成 host 参与比对，后果更糟）。
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error(
      `${label} must be a bare origin without path, query or fragment: ${JSON.stringify(trimmed)}`,
    );
  }
  return url.origin;
}

/**
 * 构造 WSS Upgrade 的 Origin 白名单：`BASE_URL 的 Origin ∪ CORS_ORIGINS`。
 *
 * - **不修改**传入的 `corsOrigins`（纯函数，调用方的 env 对象保持原样）；
 * - **去重**后返回精确 Origin 列表（重复项只留一个）；
 * - 每一项都过 `pureOriginOf`：非法配置在**启动时**就失败，而不是等到
 *   某个客户端连不上才去翻日志。
 *
 * 注意：HTTP 的 CORS **不**使用这个结果——`app.ts` 的 `corsMiddleware`
 * 仍然只吃 `ctx.env.corsOrigins`。BASE_URL 的自动放行是 WSS 专属的，
 * 不能因为修 Desktop 就把普通 HTTP CORS 也扩了。
 *
 * @throws BASE_URL 或任何一条 CORS_ORIGINS 不是合法的纯 http(s) Origin。
 */
export function resolveWebSocketAllowedOrigins(
  baseUrl: string,
  corsOrigins: readonly string[],
): string[] {
  const allowed = new Set<string>();
  // BASE_URL 必须是**非空**的合法 Origin：空白/非法一律抛，绝不退化成
  // 「白名单为空」或「允许所有」——那等于把这层边界整个关掉。
  const base = pureOriginOf(baseUrl, "BASE_URL");
  if (base.length === 0) throw new Error("BASE_URL must not be blank");
  allowed.add(base);
  for (const entry of corsOrigins) {
    const origin = pureOriginOf(entry, "CORS_ORIGINS entry");
    if (origin.length > 0) allowed.add(origin);
  }
  // Set 已去重；`Array.from` 给调用方一个可自由传递的快照。
  return Array.from(allowed);
}
