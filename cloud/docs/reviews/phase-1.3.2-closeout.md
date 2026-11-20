# BrewPhase Phase 1.3.2 — Remote MCP Streamable HTTP 与只读工具服务

> 日期：2026-11-20 · 分支：`feature/remote-mcp`
> **基线 HEAD：`69c2d4270a3ae0fe59eeac47633e298b477a0b70`**（C3c-3B-3-R1 终态；
> 开始前 `git fetch` + `git ls-remote` 核实本地 = 远程 = 基线，工作区干净）。
> 交付提交 SHA 以 `git log -1 --format=%H` 为准（见最终交付报告）。
> **不做**：真实 ChatGPT / Grok 联调（1.3.3）、CIMD 能力声明、迁移、写工具、
> Desktop 改动、Authorize / Consent / Token 业务流程改动。

---

## 1. 修改文件清单

**生产代码（6 新增 + 3 修改）**

| 文件 | 变更 |
|---|---|
| `cloud/src/mcp-http/tools.ts` | **新增**：8 个只读工具定义（name / scope / description / zod input，与 Desktop `TOOL_DEFINITIONS` 逐字一致）+ `scopeForTool` / `toolsForScopes` |
| `cloud/src/mcp-http/authorize.ts` | **新增**：Bearer → Session → Grant 回查链 + 401/403 challenge 构造 + `toSdkAuthInfo`（身份只来自 JWT `sub`） |
| `cloud/src/mcp-http/guards.ts` | **新增**：256 KiB 大小闸门（413 纯文本）、Host（复用 `link-server` 的 `normalizeHost`）、Origin（精确 origin 匹配） |
| `cloud/src/mcp-http/handler.ts` | **新增**：`createMcpHandler(factory, { legacy: "stateless", maxRequestBodySize: 256KiB })`；工厂注册全部 8 工具并按 effective scope 置 `enabled`；工具回调（scope 防御 → `dispatchToolCall` → §6.4 结果映射 → 允许字段日志） |
| `cloud/src/routes/mcp-http.ts` | **新增**：`GET/POST/DELETE /mcp` 路由与入口顺序、`tools/call` scope 预检（403 只报缺的那一个）、独立限流桶 |
| `cloud/tests/helpers/mcp-http.ts` | **新增**：harness（可注入 CORS / Host / 限流、可控 LinkControl、日志捕获）、modern/legacy 请求构造、真实 OAuth 流程取 Bearer |
| `cloud/src/app.ts` | 修改：`/mcp` 挂载进 `resolveMcpOAuthEnablement` 的 **enabled 分支**（与 MCP OAuth / Discovery 同生共死） |
| `cloud/src/env.ts` + `.env.example` | 修改：新增 `RATE_LIMIT_MAX_MCP`（默认 120/min）→ `env.rateLimit.maxMcp` |
| `cloud/src/link/link-server.ts` | 修改：`normalizeHost` **导出**（WSS 与 `/mcp` 共用同一 Host 归一化，避免「WSS 能连、/mcp 被拒」） |
| `cloud/package.json` + `pnpm-lock.yaml` | **唯一新依赖**：`@modelcontextprotocol/server@^2.4.0`（与 Desktop 同版本；未动其它依赖） |

**测试（8 新增 + 4 机械适配）**

| 文件 | 变更 |
|---|---|
| `tests/mcp-http/protocol.test.ts` | **13 条**（双时代 + `-32020/-32022/-32601/405/202` + 无 `Mcp-Session-Id`） |
| `tests/mcp-http/auth.test.ts` | **9 条**（Bearer 全套失败面 + 双向隔离 + challenge 形状） |
| `tests/mcp-http/guards.test.ts` | **10 条**（Host/Origin/413 与顺序、429 桶独立性、启用边界 404） |
| `tests/mcp-http/session-grant.test.ts` | **10 条**（Session 层 401 ×6、Grant 层 403 ×4、两用户隔离） |
| `tests/mcp-http/scope.test.ts` | **11 条**（list 过滤、403 只报一个、grant 收窄即时生效、step-up、空 scope 空数组） |
| `tests/mcp-http/forwarding.test.ts` | **8 条**（8 工具全派发、离线/超时/无 link、AbortSignal、撤销拦截、**真实 WSS 端到端 ×2**） |
| `tests/mcp-http/logging.test.ts` | **3 条**（哨兵 0 命中、失败日志只带 errorCode、jti ×10） |
| `tests/mcp-http/schema.test.ts` | **6 条**（与 Desktop 深度一致、无写工具、无身份字段） |
| `tests/helpers/desktop-tools.ts` | Desktop `TOOL_DEFINITIONS` 的**运行时**加载（`import.meta.glob`；见 §5 一致性机制说明） |
| `tests/helpers/{mcp-http,mcp-token,env}.ts`、`tests/security/*` | 夹具扩展（provider 透传 / `maxMcp` 字段）——**未删除、未跳过、未弱化任何既有断言** |

**文档**：本报告；设计文档实施状态见路线图 / 索引更新；路线图 §3.30-R1 状态修正 +
§3.32；索引 §43。**未改**：Desktop 源码与文档正文、iOS、迁移（仍 0000–0005）、
Authorize / Consent / Token 业务逻辑、CIMD Registry、Discovery 能力字段。

---

## 2. 新增的 MCP SDK 版本

```jsonc
// cloud/package.json（diff 仅此一行）
"@modelcontextprotocol/server": "^2.4.0"   // 实际解析 2.4.0（与 Desktop 的 ^2.4.0 同版本）
```

- lockfile：`cloud/pnpm-lock.yaml` 已更新（`pnpm add`，+2 packages）。
- 其它依赖零改动。
- **协议层全部由 SDK 承担**：`createMcpHandler(..., { legacy: "stateless" })`；
  **没有**手写 Streamable HTTP Transport、**没有**手接
  `WebStandardStreamableHTTPServerTransport`、**不生成** `Mcp-Session-Id`。

---

## 3. Cloud 路由结构

```text
POST /mcp   → limiter(mcp-http 独立桶)
              → 1. GET/DELETE 分支？否
              → 2. body 大小（Content-Length > 256 KiB → 413 纯文本；chunked 由 SDK
                    maxRequestBodySize=256KiB 同值兜底）
              → 3. Host ∈ GATEWAY_ALLOWED_HOSTS（与 WSS 共用 normalizeHost）→ 403 -32000
              → 4. Origin 存在则须精确命中 CORS_ORIGINS（无 Origin = 服务端调用通过）→ 403 -32000
              → 5. Bearer → verifyMcpAccessToken（HS256/kid/iss/aud/exp/sub/sid/client_id/scope/jti）→ 401
              → 6. mcp_sessions(sid) 回查 → 401；mcp_grants(grant_id) 回查 → 403
              → 7. tools/call scope 预检（读 clone，不消费原 body）→ 403 insufficient_scope
              → 8. handler.fetch(request, { authInfo })   ← 协议/时代/传输层全部由 SDK 产出
GET/DELETE /mcp → limiter → handler.fetch → 405（SDK canonical：-32000 Method not allowed.）
OPTIONS /mcp    → 既有 CORS 中间件（未配置 CORS 时与其它路由一致 404）
```

挂载：`app.ts` 的 `if (mcpOAuth.enabled)` 分支内——**OAuth 关则 `/mcp` 404**
（guards 测试钉住：不允许「OAuth 禁用但 MCP 端点存在」）。

依赖装配：`createMcpHttpHandler(ctx)` 每应用一次；`authInfo` 每请求组装
（token / scopes=effective / extra={userId,sessionId,grantId,jti}）。

---

## 4. Modern / Legacy 请求实测（protocol.test.ts，13 条全绿）

| 请求 | 实测结果 |
|---|---|
| modern `server/discover`（`params._meta` 两保留键 + `MCP-Protocol-Version` + `Mcp-Method` 头） | **200 JSON**，`supportedVersions=["2026-07-28"]`，`_meta["io.modelcontextprotocol/serverInfo"].name="brewphase"` |
| legacy `initialize`（`protocolVersion: 2025-06-18`，无 `_meta`、无协议头） | **200 `text/event-stream`**，回显 `2025-06-18`，`serverInfo` 正确 |
| modern / legacy `tools/list` | 双双 **200**，各 **8** 个工具（SSE 与 JSON 形态分别断言） |
| modern / legacy `tools/call` | 双双 **200**，结果可达、经由真实 dispatch |
| `Mcp-Method` 头 ≠ body.method | **400 + `-32020`**（HeaderMismatch） |
| `MCP-Protocol-Version` 头 ≠ 信封版本 | **400 + `-32020`** |
| 信封 `protocolVersion: 1900-01-01` | **400 + `-32022`**，`data.supported=["2026-07-28"]`、`data.requested="1900-01-01"` |
| 未知方法 `bogus/method` | **404 + `-32601`** |
| `GET` / `DELETE`（不带 Bearer 也一样） | **405 + `-32000 Method not allowed.`** |
| legacy `notifications/initialized` | **202**，空体 |
| 全部响应 | **无 `Mcp-Session-Id` 头**（stateless，不生成协议层会话） |

（现代信封的实测形态：`params._meta = {"io.modelcontextprotocol/protocolVersion": …,
"io.modelcontextprotocol/clientCapabilities": …}`——命名空间键是 SDK 的保留键；
非命名空间的 `_meta.protocolVersion` 不被承认为信封。）

---

## 5. 8 个工具清单与 Scope 映射（schema.test.ts：6 条全绿）

| 工具 | Scope | Desktop 一致性 |
|---|---|---|
| `search_records` | `records:read` | description 逐字符 + `z.toJSONSchema(input)` 深相等 |
| `get_record` | `records:read` | 同上 |
| `list_record_tags` | `tags:read` | 同上 |
| `list_beans` | `coffee:read` | 同上 |
| `list_brews` | `coffee:read` | 同上 |
| `list_tastings` | `coffee:read` | 同上 |
| `list_canvases` | `canvas:read` | 同上 |
| `get_canvas` | `canvas:read` | 同上 |

一致性机制：`tests/helpers/desktop-tools.ts` 在**测试运行时**用 `import.meta.glob`
加载 Desktop 权威 `TOOL_DEFINITIONS`（不是拷贝、不是快照——是当前源码本身），
逐字段比较；任何一侧漂移即红。附加断言：数量恰 8、名称唯一、`write===false`、
`create_record`/`update_record`/`create_canvas`/`create_canvas_note`/`create_tag`
等写工具与 `get_bean`/`get_coffee_summary` 等**未选中**读工具全部缺席、
arguments schema 不含 `userId/user_id/grant_id/session_id/jti` 等身份字段。
（动态加载的原因：Desktop `package.json` 无 `"type":"module"`，静态跨项目 import
会触发 Cloud `tsc` 的 NodeNext CJS/ESM 归属错误；生产构建不包含 Desktop 源码。）

---

## 6. Bearer / Session / Grant 校验链路（auth + session-grant：19 条全绿）

```text
Authorization: Bearer <jwt>
 1. verifyMcpAccessToken —— HS256 / kid 轮换（未知 kid 不回退）/ iss 逐字符 /
    aud = MCP_RESOURCE / exp / sub / sid / client_id / scope / jti    → 失败 401
 2. mcp_sessions(sid)：存在、revoked_at IS NULL、absolute_expires_at > now、
    user_id == sub、client_id == claim、resource == 本资源、issued_scope 合法
                                                              → 失败 401（§9.5：sid 查不到即 401）
 3. mcp_grants(session.grant_id)：存在、user_id == sub、未撤销、
    client_id == session、resource == session、scopes 合法      → 失败 403 + invalid_token challenge
 4. effective = token.scope ∩ session.issued_scope ∩ grant.scopes（三交集，不只信 JWT 快照）
```

- **身份只来自验签后的 JWT `sub`**：`dispatchToolCall({userId})` 取自 `authInfo.extra.userId`；
  Body / MCP 参数 / arguments 里的身份字段一概不读（schema 测试钉住 arguments 无身份键）。
- 实测覆盖：缺失/非法/过期/错 aud/错 iss/未知 kid → 401；**Desktop token 打 `/mcp` → 401**、
  **MCP token 打 `/auth/me` → 401**（双向隔离）；Session 撤销/过期/行删除/伪造 sid/sub/client 不符 → 401；
  Grant 撤销 → **下一次请求 403**（`link.calls` 不增）；Grant 归属他人 → 403；
  **grant.scopes 收窄 → 旧 token 立即缺权**（list 从 5 变 2、`list_beans` 立即 403）；
  两用户隔离（各自 token 各自 userId 派发、A 撤销不影响 B）。
- 全部真实 PostgreSQL（完整 OAuth 流程取真 token、真表撤销/收窄），无 mock 数据库授权。
- 无任何进程缓存：每次请求重新查两张表。

---

## 7. 工具转发路径

```text
tools/call → [路由] scope 预检（缺 → 403，dispatch 0 次）
           → [SDK] zod schema 校验（arguments 保真）
           → [handler 回调] scope 防御复核 → ctx.link 缺失？fail-closed DEVICE_OFFLINE
           → ctx.link.dispatchToolCall({ userId(JWT sub), grantId(Session), tool, arguments, signal, trace })
           → [既有 R1/R2 forwarder：准入十条判据 / reserve / 预算 / 在途计数 / 超时]
           → ok:true  → content[0].text = JSON + structuredContent（§6.4）
             ok:false → content[0].text = {error:{code,message,retryable}} + isError:true
                        （DEVICE_OFFLINE / REQUEST_TIMEOUT 都是**工具结果**，不是 JSON-RPC 错误）
```

- 实测：8 个工具逐一派发（入参逐项断言、无重复、无写工具）；设备不在线 →
  200 + `isError` + `DEVICE_OFFLINE`；超时 → `REQUEST_TIMEOUT` + `retryable:true`；
  `ctx.link === undefined`（HTTP-only）→ 同样 fail-closed，不抛异常；
  Grant 撤销 → 403 在派发前拦截；
  **AbortSignal**：请求中途 `abort()` → `dispatchToolCall` 收到的 `signal.aborted === true`；
  **真实 WSS 端到端**：真设备握手 → 真 `req` 帧（`id`/`grant_ctx`/`deadline_ms`/`arguments`
  形状与协议 §6.1 一致）→ 回 `res` → 客户端拿到设备数据；未连接设备 → 真实 forwarder
  判 `DEVICE_OFFLINE`。**未改动 forwarder 一行语义**。

---

## 8. 错误响应矩阵（设计 §4.6 逐行）

| 状态 | 触发（实测用例） | 响应形态 |
|---|---|---|
| 200 | discover / tools/list / tools/call / initialize（SSE） | JSON 或 SSE（SDK 按时代决定） |
| 202 | legacy notification | 空体 |
| 400 | `-32020` 头体不一致 ×2、`-32022` 不支持版本 | JSON-RPC error（SDK） |
| 401 | 无/坏/过期/错 aud/错 iss/坏 kid token、Session 层失败 | `WWW-Authenticate: Bearer resource_metadata="…"`，**无 scope 参数**（9+6 用例断言） |
| 403 | Host、Origin、Grant 层失败、scope 不足 | Host/Origin → JSON-RPC `-32000 id:null`；Grant → `Bearer error="invalid_token", resource_metadata="…"`；scope → `Bearer error="insufficient_scope", scope="<仅缺的一个>", resource_metadata="…"`（**不含已持有的 scope**） |
| 404 | 未知方法 `-32601` | JSON-RPC error |
| 405 | GET / DELETE | `-32000 Method not allowed.`（不需认证） |
| 413 | `Content-Length` > 256 KiB（**先于 Host 判定**，顺序用例钉住） | 纯文本 |
| 429 | `mcp-http` 桶满 | `Retry-After`；与授权桶互不干扰（双向用例） |

**协议层错误不进 19 个业务错误码**（`REMOTE_ERROR_CODES` 零改动）；Token 侧错误
仍是 JSON OAuth 形态（未改）。

---

## 9. 日志安全测试（logging.test.ts）

允许字段实测：`tool` / `status` / `durationMs` / `errorCode` / `jti`（**仅前 8 位**）/ `grantId`。

哨兵用例：构造唯一哨兵 —— 完整 Bearer token、`SENTINEL_ARGS_…`（工具参数）、
`SENTINEL_RESULT_…`（派发结果正文）、完整 `jti` —— 执行一次真实 `tools/call`
后对**全部捕获日志** `JSON.stringify` 断言 **0 命中**，并额外断言：
- 日志确实非空（不是「没记所以没命中」）；
- 不存在 `token/authorization/cookie/secret/password/verifier` 字段名；
- `mcp_tool_call` 只含允许字段，**没有 `arguments`、没有 `result`**；
- 失败调用日志只带 `errorCode`（`GRANT_REVOKED`），仍 0 命中。

（`onerror` 只记 `error.name` 不记 message——Zod 校验错误的 message 会回显参数值。）

---

## 10. jti 重复调用测试（P0-2 / ST-25 回归）

同一枚 Access Token **连续 10 次 `tools/call` 全部 200**，10 次都真实派发
（`link.calls = 10`），10 条 `mcp_tool_call` 日志的 jti 前缀**完全相同且只有 8 位**、
完整 jti 0 命中。**没有任何按 jti 去重 / 拒绝第二次的实现**；jti 不作限流键
（限流按 IP 独立桶，见 §8 的 429 用例）。

---

## 11. TypeScript / ESLint / 全量测试结果（真实执行）

```text
$ cd cloud && npx tsc --noEmit
（无输出，0 error）

$ cd cloud && npx eslint src tests
（无输出，0 error / 0 warning）

$ cd cloud && npx vitest run tests/mcp-http
 Test Files  8 passed (8)
      Tests  70 passed (70)          ← protocol 13 / auth 9 / guards 10 /
                                        session-grant 10 / scope 11 /
                                        forwarding 8 / logging 3 / schema 6

$ cd cloud && npx vitest run
 Test Files  78 passed (78)
      Tests  1585 passed (1585)      ← 基线 1515 → +70（= 新增数，既有零回归）

$ cd cloud && npm run build           ← 生产构建（tsc -p tsconfig.build.json + 资产拷贝）
build_exit=0
```

**失败项：无。** 既有测试无删除、无 skip、无弱化；对 4 个夹具/配置文件的修改仅为
新增字段（`provider` 透传、`rateLimit.maxMcp`）与既有断言的机械跟随，语义不变。
扫描复核：`/mcp` 与 OAuth 同启用边界（404 用例）· GET/DELETE 恒 405 ·
`client_id_metadata_document_supported` **仍未声明**（discovery 负向断言原样通过）·
迁移仍 6 个（无新增）· lockfile 仅新增 SDK · Desktop 源码零改动 ·
CIMD Registry / Authorize / Consent / Token 业务逻辑零改动。

---

## 12. 尚未完成的风险与边界

| # | 风险 / 边界 | 归属 |
|---|---|---|
| 1 | **真实客户端（ChatGPT / Grok / Inspector）未联调**——双时代与全部错误面是工程级实测，不等于真实客户端证据；`NOT VERIFIED` 项（OQ-B/OQ-C、G1–G6）原样保留 | **1.3.3** |
| 2 | CIMD Discovery 能力**仍未声明**（联调通过后单独提交） | 1.3.3 之后 |
| 3 | `tools/list` 的零 scope 分支在真实 token 下不可达（签发面拒绝空 scope；consent 拒绝空授权），由「grant.scopes 置空」用例覆盖 `enabled` 全关路径——结构防线在，但真实链路无法产生该状态 | 记录（无需处理） |
| 4 | grant 行不存在且 session 仍存在：`mcp_sessions.grant_id` 是 FK(ON DELETE CASCADE)，结构上不可达；代码仍按 403 fail-closed（由撤销/归属用例覆盖 403 桶） | 记录 |
| 5 | 取消（AbortSignal）用例只断言 signal 透传与 `aborted`，不断言中断后的响应形态（SDK 拥有该行为） | 记录 |
| 6 | 现代 SSE 升级路径（`responseMode: 'auto'` 的中途通知升级）本阶段 8 个工具恒为一问一答 JSON，未触发升级 | 若未来引入进度通知需补测 |
| 7 | 限流为进程内 Map（与既有设施同取向），多实例需共享存储 | Phase 1.4 |
| 8 | `TRACE` 里 `mcp_request_id` 取 JSON-RPC id（截断 128 字符）；超长 id 的日志注入面由截断 + 结构化字段限制 | 记录 |

---

## 13. GitHub CI 实际状态

- 仓库 `.github/workflows/` **仅存在 `desktop-release.yml`**（Desktop 安装包发布），
  **未配置** Cloud 的 tsc / eslint / vitest CI 工作流。
- 本机 `gh` CLI **不可用**（`command not found: gh`），因此**未观测到**任何
  GitHub Workflow Runs。
- **结论：未配置 / 未观测到——不声称「CI 通过」。** 本报告 §11 的全部结果均为
  本地真实执行；若要接入 CI，需新增 Cloud 测试工作流（超出本阶段范围）。

---

**完成后停止，等待独立代码审核；不进入 1.3.3、不开启 CIMD 能力、不合并 main。**
