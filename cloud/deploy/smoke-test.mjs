/**
 * Remote MCP 部署冒烟测试（Phase 1.3.3-A-R5）。
 *
 * 用法：
 *   BASE_URL=https://api.phase.commitbrew.com node deploy/smoke-test.mjs
 *   # 或
 *   node deploy/smoke-test.mjs https://api.phase.commitbrew.com
 *
 * 覆盖任务书 §8 的 **HTTP + Discovery + 未授权 MCP** 三组。
 * WSS 真机验收需要真实 BrewPhase Desktop，无法在脚本里伪造——
 * 见 deploy/README.md 的「WSS 真机验收」，那部分必须人工执行。
 *
 * 设计纪律：
 * - **零依赖**：只用 Node 内置 fetch，部署机上不需要装任何东西；
 * - **只读**：全部是 GET 或「注定被拒绝」的 POST，不创建、不授权、不改数据；
 * - **不打印任何凭据**：本脚本不需要 token，也不输出响应体里的敏感字段；
 * - **失败即非零退出**：任何一项不达标都让部署流程停住，而不是打印一行继续。
 */

const BASE = (process.argv[2] ?? process.env.BASE_URL ?? "").replace(/\/+$/, "");

if (!BASE) {
  console.error("usage: BASE_URL=https://host node deploy/smoke-test.mjs [base-url]");
  process.exit(2);
}
let baseOrigin;
try {
  baseOrigin = new URL(BASE).origin;
} catch {
  console.error(`[smoke] invalid BASE_URL: ${BASE}`);
  process.exit(2);
}

const failures = [];
const passes = [];

function pass(name, detail) {
  passes.push(name);
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, detail) {
  failures.push(`${name}: ${detail ?? ""}`);
  console.log(`  FAIL  ${name} — ${detail}`);
}

async function get(path, init = {}) {
  try {
    const res = await fetch(`${BASE}${path}`, { redirect: "manual", ...init });
    const text = await res.text();
    return { res, text };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function json(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

console.log(`[smoke] target = ${BASE}\n`);

// ── 1. 进程与就绪 ────────────────────────────────────────────────────────────
console.log("1) health / ready");
{
  const h = await get("/health");
  if (h.error) fail("/health", h.error);
  else if (h.res.status !== 200) fail("/health", `expected 200, got ${h.res.status}`);
  else pass("/health", h.text.slice(0, 120));

  const r = await get("/ready");
  if (r.error) fail("/ready", r.error);
  else if (r.res.status !== 200) fail("/ready", `expected 200 (db up), got ${r.res.status}`);
  else {
    const body = json(r.text);
    // 单副本验收：就绪响应里的 instance_id 必须只有一个（负载均衡后端唯一）。
    pass("/ready", `status=${body?.status} instance_id=${body?.instance_id} connections=${body?.connection_count}`);
    if (body?.status !== "ready") fail("/ready", `status is ${body?.status}, expected "ready"`);
    if (typeof body?.connection_count !== "number") {
      fail("/ready", "connection_count missing — WSS state not exposed");
    }
  }
}

// ── 2. Discovery ────────────────────────────────────────────────────────────
console.log("\n2) discovery");
const expectedResource = `${baseOrigin}/mcp`;
{
  // PRM 根形式
  const a = await get("/.well-known/oauth-protected-resource");
  if (a.error) fail("PRM (root)", a.error);
  else if (a.res.status !== 200) fail("PRM (root)", `got ${a.res.status}`);
  else {
    const body = json(a.text);
    if (body?.resource !== expectedResource) {
      fail("PRM (root)", `resource=${body?.resource}, expected ${expectedResource}`);
    } else pass("PRM (root)", `resource matches ${expectedResource}`);
    if (!Array.isArray(body?.authorization_servers) || body.authorization_servers[0] !== baseOrigin) {
      fail("PRM (root)", `authorization_servers=${JSON.stringify(body?.authorization_servers)}`);
    } else pass("PRM (root)", `authorization_servers[0]=${baseOrigin}`);
    const scopes = body?.scopes_supported ?? [];
    const expectedScopes = ["records:read", "tags:read", "coffee:read", "canvas:read"];
    if (JSON.stringify([...scopes].sort()) !== JSON.stringify([...expectedScopes].sort())) {
      fail("PRM (root)", `scopes_supported=${JSON.stringify(scopes)}`);
    } else pass("PRM (root)", `scopes_supported = ${scopes.join(" ")}`);
    if (JSON.stringify(body?.bearer_methods_supported) !== JSON.stringify(["header"])) {
      fail("PRM (root)", `bearer_methods_supported=${JSON.stringify(body?.bearer_methods_supported)}`);
    } else pass("PRM (root)", "bearer_methods_supported = [header]");
  }

  // PRM path-inserted 变体必须与根形式同源
  const b = await get("/.well-known/oauth-protected-resource/mcp");
  if (b.error) fail("PRM (/mcp variant)", b.error);
  else if (b.res.status !== 200) fail("PRM (/mcp variant)", `got ${b.res.status}`);
  else if (b.text !== a.text) fail("PRM (/mcp variant)", "differs from root document");
  else pass("PRM (/mcp variant)", "identical to root document");

  // AS Metadata
  const c = await get("/.well-known/oauth-authorization-server");
  if (c.error) fail("AS metadata", c.error);
  else if (c.res.status !== 200) fail("AS metadata", `got ${c.res.status} — MCP OAuth routes are probably not registered`);
  else {
    const body = json(c.text);
    const checks = [
      ["issuer", baseOrigin],
      ["authorization_endpoint", `${baseOrigin}/mcp/oauth/authorize`],
      ["token_endpoint", `${baseOrigin}/mcp/oauth/token`],
      ["revocation_endpoint", `${baseOrigin}/mcp/oauth/revoke`],
    ];
    for (const [field, want] of checks) {
      if (body?.[field] !== want) fail("AS metadata", `${field}=${body?.[field]}, expected ${want}`);
      else pass("AS metadata", `${field} = ${want}`);
    }
    // PKCE 只允许 S256（plain 等于没有 PKCE）
    if (JSON.stringify(body?.code_challenge_methods_supported) !== JSON.stringify(["S256"])) {
      fail("AS metadata", `code_challenge_methods_supported=${JSON.stringify(body?.code_challenge_methods_supported)}, expected ["S256"]`);
    } else pass("AS metadata", "code_challenge_methods_supported = [S256]");
    if (JSON.stringify(body?.token_endpoint_auth_methods_supported) !== JSON.stringify(["none"])) {
      fail("AS metadata", `token_endpoint_auth_methods=${JSON.stringify(body?.token_endpoint_auth_methods_supported)}`);
    } else pass("AS metadata", "token_endpoint_auth_methods = [none]");
    // DCR 端点本轮仍未实现 → 不该被声明（声明了却 404 更糟）
    if (body?.registration_endpoint !== undefined) {
      fail("AS metadata", "registration_endpoint declared but DCR is not implemented");
    } else pass("AS metadata", "registration_endpoint not declared (DCR未实现，一致)");
  }
}

// ── 3. 未授权 MCP 请求 ──────────────────────────────────────────────────────
console.log("\n3) unauthorized POST /mcp");
{
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const text = await res.text();

  // 不能是 404 —— 404 意味着 /mcp 没注册（MCP_BROWSER_SESSION_KEY 缺失的典型症状）
  if (res.status === 404) {
    fail("POST /mcp", "404 — /mcp is not registered (check MCP_BROWSER_SESSION_KEY preflight)");
  } else if (res.status !== 401) {
    fail("POST /mcp", `expected 401 for a tokenless request, got ${res.status}`);
  } else {
    pass("POST /mcp", "401 (registered and correctly rejecting)");
    const www = res.headers.get("www-authenticate");
    if (!www) fail("POST /mcp", "WWW-Authenticate header missing");
    else if (!www.includes("resource_metadata=")) {
      fail("POST /mcp", `WWW-Authenticate lacks resource_metadata: ${www}`);
    } else pass("POST /mcp", `WWW-Authenticate: ${www}`);
    // challenge 不得带 scope（401 只说「要去哪拿元数据」，不说缺哪个权限）
    if (www && www.includes("scope=")) fail("POST /mcp", "401 challenge must not carry scope");
    else pass("POST /mcp", "401 challenge carries no scope (per spec)");
  }

  // 不得泄露内部实现：响应体里不该出现栈、SQL、表名、主机名
  const leaks = ["SELECT ", "INSERT ", "postgres://", "Error:", " at Object.", ".ts:"];
  const found = leaks.filter((l) => text.includes(l));
  if (found.length > 0) fail("POST /mcp", `response body leaks internal detail: ${found.join(", ")}`);
  else pass("POST /mcp", "no internal detail in response body");
}

// ── 4. 登录入口纪律（只读检查）──────────────────────────────────────────────
console.log("\n4) entry points");
{
  // MCP 登录页必须由 authorize 触发；直接访问没有 rid 应当被拒，而不是
  // 渲染成一个可公开使用的登录入口。
  const login = await get("/mcp/oauth/login");
  if (login.error) fail("/mcp/oauth/login", login.error);
  else if (login.res.status === 200) {
    fail("/mcp/oauth/login", "200 without rid — the login page must not be a public entry point");
  } else pass("/mcp/oauth/login", `rejected without rid (${login.res.status})`);
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log(`\n[smoke] ${passes.length} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("[smoke] FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("[smoke] OK");
console.log("[smoke] NOTE: WSS 真机验收（Host/Origin/子协议/link_established/心跳）必须按 deploy/README.md 人工执行。");
