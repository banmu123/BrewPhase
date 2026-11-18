/**
 * MCP OAuth 的共享常量（Phase 1.3.1-C1）。
 *
 * 只放**跨模块必须逐字一致**的值。任何只被一个文件用到的常量留在那个文件里——
 * 集中定义的价值是「不可能不一致」，而不是「所有数字都住在一个文件」。
 */

/**
 * 允许的 MCP scope。
 *
 * 与 Desktop 的 `REMOTE_SCOPES`（`link/schemas.ts`）是**同一个集合的两次声明**：
 * 那边是 WSS 转发层的准入白名单，这里是 OAuth 授权与 JWT 的白名单。两边都
 * 必须逐字相同，否则会出现「token 里带着一个转发层拒绝的 scope」——
 * 表现为「授权成功但工具永远 403」。
 *
 * 1.3.2 必须加一条一致性测试把两处钉死（设计 §12 K 组）。
 */
export const MCP_SCOPES = ["records:read", "tags:read", "coffee:read", "canvas:read"] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

const SCOPE_SET: ReadonlySet<string> = new Set(MCP_SCOPES);

export function isMcpScope(value: string): value is McpScope {
  return SCOPE_SET.has(value);
}

/**
 * 把 claim 里的 `scope` 字符串（空格分隔）解析成数组。
 *
 * 做三件 claim 校验该做的事：去重、保序、拒绝未知值。**不允许空串**：
 * 一个没有任何 scope 的 access token 在所有工具上都会 403，签发它没有意义，
 * 只会把「授权失败」伪装成「授权成功但没权限」。
 */
export function parseScopeClaim(raw: string): McpScope[] | null {
  const parts = raw.split(" ").filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  const seen = new Set<string>();
  const out: McpScope[] = [];
  for (const part of parts) {
    if (!isMcpScope(part)) return null;
    if (seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out.length > 0 ? out : null;
}

/** 反过来：签发时把数组写成空格分隔的 claim。顺序即入参顺序（调用方已定序）。 */
export function formatScopeClaim(scopes: readonly string[]): string {
  return scopes.join(" ");
}

/**
 * MCP Resource（RFC 8707）。
 *
 * 同一个字符串必须同时是：
 * - JWT 的 `aud`
 * - `mcp_grants.resource`
 * - Protected Resource Metadata 里的 `resource`
 * - 授权请求里的 `resource` 参数
 *
 * 因此它**只有一个来源**：`BASE_URL + "/mcp"`。任何一处硬编码字面量都会
 * 让「刻意部署在不同域名」的实例出现「token 签得出来但资源对不上」。
 */
export function mcpResourceFor(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/mcp`;
}

/** 浏览器授权 Cookie 名（只用于 `/mcp/oauth` 路径）。 */
export const MCP_BROWSER_COOKIE_NAME = "bp_mcp_bs";

/**
 * 浏览器授权会话的固定属性。
 *
 * `path` **必须**是 `/mcp/oauth`：Cookie 的 Path 是前缀匹配，写成 `/mcp`
 * 会让这个 Cookie 出现在真正的数据端点 `POST /mcp` 上（设计 §5.3.1）。
 */
export const MCP_BROWSER_COOKIE_PATH = "/mcp/oauth";
export const MCP_BROWSER_SESSION_TTL_SECONDS = 1800;

/** 浏览器 Session 密钥的最小长度（字节）。低于它就等于用短口令做 HMAC。 */
export const MCP_BROWSER_SESSION_KEY_MIN_BYTES = 32;
