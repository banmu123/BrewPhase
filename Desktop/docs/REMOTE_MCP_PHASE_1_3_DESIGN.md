# BrewPhase Remote MCP — Phase 1.3 设计基线（1.3.0 冻结）

> **状态**：`FROZEN`（设计冻结，未实现）
> **冻结日期**：2026-11-18
> **代码基线**：`feature/remote-mcp` @ `898f12a`（1.2B.2.2-R2 之后）
> **本文件地位**：Phase 1.3 的**唯一设计基线**。当本文件与其它册的
> Phase 1.3 描述冲突时，以本文件为准；其它册的冲突段落已在 1.3.0 一并修订。
>
> **本阶段没有写任何生产代码、没有新增迁移、没有改动 `auth_sessions`。**

---

## 0. 一句话结论

**MCP 2026-07-28 已移除协议层会话与 GET SSE，并把 `initialize` 换成逐请求
`_meta` + `server/discover`；但真实客户端（ChatGPT）目前仍在用 `initialize`。
所以 BrewPhase 必须同时服务两个时代（dual-era），而 SDK 2.4.0 恰好已经能
同时服务——这是本设计的地基。**

---

## 1. 规范版本与证据状态

### 1.1 本设计对照的规范

| 项 | 值 | 如何确认 |
|---|---|---|
| MCP 最新正式版本 | **`2026-07-28`** | `modelcontextprotocol.io/specification/latest` 实际跳转到 `2026-07-28`（2026-11-18 抓取） |
| Streamable HTTP | 2026-07-28 修订：**移除 GET 流、移除协议层会话** | 传输页原文 "Revision 2026-07-28 changed the behavior… Removal of the GET stream endpoint. Removal of protocol-level sessions." |
| 传输端点 | 单一 MCP endpoint，**仅 POST**；GET/DELETE → `405` | 同上 |
| 逐请求元数据 | `_meta` 三键 + `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` 头 | 传输页 §Request Metadata |
| 版本协商 | **无握手**；每请求声明版本；不支持 → `400` + `UnsupportedProtocolVersionError`（`-32022`） | 版本页 "There is no negotiation handshake." |
| 服务发现方法 | `server/discover`，服务端 **MUST** 实现 | `server/discover` 页 |
| 授权 | **OAuth 2.1**（AS）+ RFC 9728 PRM +（RFC 8414 或 OIDC Discovery）+ RFC 8707 `resource` + RFC 9207 `iss` | 授权页 / 发现页 |
| 客户端注册 | CIMD（SHOULD，首选）/ 预注册（允许）/ **DCR（MAY，已弃用）** | 注册页原文 "Dynamic Client Registration is deprecated" |
| 令牌绑定 | AS 必须按 audience 签发；资源服务器必须校验 audience；**禁止令牌透传** | 授权页 + 安全考量页 |

> **不机械照抄任务书版本号**：任务书给的 `2026-07-28` 经实查确为当前最新，
> 因此沿用。若将来发布新版本，本文件的「版本策略」（§3）不需要重写，
> 只需更新本节表格与 §3.2 的 SDK 支持矩阵。

### 1.2 已实测的本机事实（不是推测）

在 `feature/remote-mcp @ 898f12a` 上直接执行得到：

| 事实 | 证据 |
|---|---|
| Cloud **没有** 安装任何 MCP SDK | `cloud/package.json` 依赖仅 `@hono/node-server / drizzle-orm / hono / jose / postgres / ws / zod` |
| Desktop **已安装** `@modelcontextprotocol/server@2.4.0` + `client@2.4.0` | `Desktop/package.json`；`node_modules` 实存 |
| 该版本是 npm `latest`（无更新版本） | `npm view @modelcontextprotocol/server version dist-tags` → `2.4.0` |
| SDK 的**旧常量**只到 `2025-11-25` | `SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25","2025-06-18","2025-03-26","2024-11-05","2024-10-07"]`，`LATEST_PROTOCOL_VERSION = "2025-11-25"` |
| **但** `createMcpHandler` 实际**同时**服务两个时代 | 见下 §1.3 的实测响应 |

### 1.3 SDK 双时代能力实测（决定性证据）

用 `createMcpHandler(() => new McpServer(...))` 构造 handler，直接喂 `Request`：

| 请求 | 实际响应 |
|---|---|
| `initialize`（`protocolVersion: 2025-06-18`） | `200` + `text/event-stream`，`result.protocolVersion = "2025-06-18"` |
| `server/discover`（`_meta` 带 `2026-07-28` + 三个头） | `200` + `application/json`，`result.supportedVersions = ["2026-07-28"]` |
| 头 `2025-11-25` vs 体 `2026-07-28` | `400` + `-32020`（HeaderMismatch，含 `data.mismatch`） |
| `protocolVersion: 1900-01-01` | `400` + `-32022`（含 `data.supported`） |
| 未知方法 | `404` + `-32601` |
| `GET` / `DELETE` | `405`（`-32000 Method not allowed.`） |

**结论**：`SUPPORTED_PROTOCOL_VERSIONS` 是旧 `Server` 类的常量，**不是**
`createMcpHandler` 的能力上界。`createMcpHandler` 已经是 dual-era 实现，
规范要求的错误面（`-32020` / `-32022` / `-32601` / `405`）全部由 SDK 产出。

### 1.4 真实客户端行为（部分仍未验证）

| 客户端 | 证据 | 状态 |
|---|---|---|
| ChatGPT 自定义连接器 | 多份第三方接入文档显示：用 `initialize` + `protocolVersion: "2025-06-18"`；通过 `401 + WWW-Authenticate: … resource_metadata=` 发现 AS；部分实现观察到 DCR + PKCE S256；无 refresh token 时连接约 1 小时后过期 | **`NOT VERIFIED`**（无 OpenAI 官方文档，且非本项目实测） |
| Grok | 未找到任何可靠证据 | **`NOT VERIFIED`** |
| MCP Inspector / 官方 client SDK | SDK 同时具备 legacy 与 modern 客户端路径 | 可用作 1.3.3 的第一层证据（但**不等于**真实 ChatGPT） |

**纪律**：§1.4 的「ChatGPT 用 `initialize`」是**设计假设**，不是本设计的
依据。设计依据是 §1.3 的 SDK 能力——它让两种假设都成立，因此**不需要**
赌 ChatGPT 用哪一代。这是 dual-era 的真正理由。

---

## 2. 三类要求的分离（规范 / 客户端 / 自身策略）

这一节的作用是防止把三者混成一条「必须实现 X」的清单。

| # | 类别 | 内容 | 谁决定 | 违反的后果 |
|---|---|---|---|---|
| A | **MCP 规范强制** | `POST` 单端点；`Accept` 同时列 `application/json` 与 `text/event-stream`；`MCP-Protocol-Version` 与 `_meta` 一致；`Mcp-Method`/`Mcp-Name`；`Origin` 不合法 → `403`；未知方法 → `404`；`GET`/`DELETE` → `405`；RFC 9728 PRM；`resource` 双处传递；audience 校验；禁止透传；`iss` 校验 | 规范 | 不算「符合 MCP」；互操作性无从谈起 |
| B | **客户端兼容** | 真实 ChatGPT 用什么版本、是否必须 DCR、是否要求 SSE、`outputSchema` 是否必需、refresh 是否被使用 | 客户端（**本项目无法单方面决定**） | 连不上 ChatGPT（但规范上仍正确） |
| C | **BrewPhase 安全策略** | `redirect_uri` 精确匹配（不走通配）；scope 逐项展示；`aud` 必须等于真实 resource；grant 每次回查；撤销立即生效；token 短命；refresh 轮换 + 重放检测；CIMD 抓取防 SSRF | 本项目 | 越权 / 授权劫持 / SSRF |

**冲突裁决顺序**：C 是硬约束，不可为 B 让步；A 是底线，不可为 B 让步；
B 只在「A 与 C 都允许的实现空间内」选择具体形态。

> 例：若 ChatGPT 只支持 DCR（B），我们**不会**因此放宽 `redirect_uri` 精确匹配（C），
> 也不会因此放弃 audience 校验（A）。可选的是「是否额外提供 DCR」——
> 那是 A 允许（`MAY`）且 C 可加固的范围。

---

## 3. 版本策略（冻结）

### 3.1 双时代，不选边

```
                    ┌──────────────────────────────────────┐
   modern client ──▶ │ POST /mcp                            │
   (2026-07-28)      │  _meta.protocolVersion = 2026-07-28  │──▶ server/discover
                     │  MCP-Protocol-Version: 2026-07-28    │    tools/list
                     │  Mcp-Method: tools/call              │    tools/call
                     │  Mcp-Name: <tool>                    │
                     └──────────────────────────────────────┘
                                     │ 同一 handler，按请求分类
                     ┌──────────────────────────────────────┐
   legacy client  ──▶ │ POST /mcp                            │
   (2025-06-18/25)    │  {"method":"initialize", ...}        │──▶ initialize
                     │  无 _meta                            │    tools/list
                     └──────────────────────────────────────┘    tools/call
```

**决定**：

1. `createMcpHandler(..., { legacy: 'stateless' })` —— **不是** `'reject'`。
   `'reject'` 会把 ChatGPT 这类 legacy 客户端直接挡在门外。
2. **不发 `Mcp-Session-Id`**。`'stateless'` 模式本身就不生成会话 id，
   GET/DELETE 一律 `405`。这同时满足 2026-07-28 的「移除协议层会话」
   与 2025-11-25 的「服务端 MAY 提供 SSE/会话」——我们选择不提供。
3. 现代时代的 SSE 响应：`responseMode: 'auto'`（默认）。理由见 §4.3。
4. `LATEST_PROTOCOL_VERSION` 等旧常量**不作为**版本声明来源；对外声明的
   支持版本以 `server/discover` 的 `supportedVersions` 与
   `UnsupportedProtocolVersionError.data.supported` 的实际输出为准。

### 3.2 何时可以只做 modern

当且仅当满足两条时，才可把 `legacy` 改成 `'reject'`：

- ChatGPT（或目标客户端）已用 modern 请求实测通过（1.3.3 的 G2'）；
- 线上旧客户端的 `initialize` 请求在 30 天内为 0（Cloud 日志可测）。

在那之前 `'reject'` 视为**回归**。

### 3.3 依赖策略

| 项 | 决定 |
|---|---|
| Cloud 是否引入 `@modelcontextprotocol/server` | **是**，`1.3.2` 引入，版本与 Desktop 对齐（`^2.4.0`），同一 lockfile 语义 |
| 是否本阶段引入 | **否**（1.3.0 不改 `package.json`） |
| 是否手写 Streamable HTTP | **否**。§1.3 已证明 SDK 覆盖全部必需行为；手写会把 `-32020`/`-32022`/分类逻辑重新实现一遍 |
| SDK 升级 | 只允许「同 major 内升级 + 双时代实测表（§1.3）重跑通过」；跨 major 需单独 ADR |

> **不引入 = 不实现**：本阶段仅冻结，`cloud/package.json` 保持原样。

---

## 4. HTTP Transport 设计

### 4.1 端点与方法

| 方法 | 路径 | 行为 |
|---|---|---|
| `POST` | `/mcp` | 唯一 MCP 端点 |
| `GET` | `/mcp` | `405`（不提供 SSE 流） |
| `DELETE` | `/mcp` | `405`（没有会话可终止） |
| `OPTIONS` | `/mcp` | `204`（CORS 预检；默认不开放跨源，见 §4.5） |

### 4.2 请求处理流程

```
POST /mcp
  │
  ├─ 1. 方法/路径/大小
  │     GET|DELETE → 405；body > 256 KiB → 413
  │
  ├─ 2. Origin 校验（规范 MUST）
  │     Origin 存在且不在白名单 → 403（可带无 id 的 JSON-RPC error）
  │     无 Origin（服务端到服务端调用）→ 通过
  │
  ├─ 3. 认证（见 §7）
  │     无 Bearer / 无效 / 过期 → 401 + WWW-Authenticate(resource_metadata, scope)
  │     aud ≠ MCP_RESOURCE → 401（不泄露「差在哪」）
  │
  ├─ 4. Grant 回查（见 §8）——**每次都查库**
  │     无 grant / 已撤销 / scope 不足 → 403 + WWW-Authenticate(error="insufficient_scope", scope=…)
  │
  ├─ 5. 交给 createMcpHandler().fetch(request, { authInfo })
  │     ├─ modern：校验 _meta 三键 + 三个头 + 版本支持
  │     ├─ legacy：initialize / tools/list / tools/call
  │     └─ 分类失败：400 / 404 / 405（SDK 产出，见 §1.3 表）
  │
  └─ 6. tools/call → Cloud 转发层（既有 R1/R2 语义，一字不改）
```

### 4.3 响应格式

| 时代 | 默认 | 说明 |
|---|---|---|
| modern | `application/json`（`responseMode: 'auto'`） | 8 个只读工具都是「一问一答」，无进度通知 → 永远走 JSON 分支 |
| modern（未来有通知时） | 自动升级为 `text/event-stream` | 只有 handler 在结果前发出相关消息才升级；本阶段不会发生 |
| legacy | `text/event-stream`（SDK 固定） | 实测：`initialize` / `tools/list` 都返回 SSE 帧。**必须**按 SSE 解析 |

**这是最容易写错的一处**：文档若只说「返回 JSON」，legacy 客户端会拿到
SSE 而解析失败；若只说「返回 SSE」，modern 客户端会等不到流结束。
**两种都要支持**，由 SDK 决定，Cloud 侧**不干预** `Content-Type`。

### 4.4 取消语义

- modern：**关闭响应流即取消**。Cloud 侧在 `Request` 的 `signal` 上挂
  `AbortSignal`，透传给 `dispatchToolCall({ signal })`（R1 已实现该参数）。
- legacy：`notifications/cancelled` 在 2025-11-25 的 HTTP 传输里仍可能到达；
  SDK 负责解析，Cloud 侧把它映射为同一条 abort 路径。
- **不新增**任何取消帧/字段。R1 的 `frameSent` 判据决定是否向 Desktop 发
  `cancel`——保持不变。

### 4.5 Origin / Host

| 检查 | 规则 | 失败 |
|---|---|---|
| `Host` | 必须属于 `GATEWAY_ALLOWED_HOSTS`（含 `BASE_URL` 推导；反代场景显式配置） | `403` |
| `Origin` | 存在时必须属于 `CORS_ORIGINS` ∪ 显式 MCP 白名单 | `403` |
| 无 `Origin` | 允许（服务端到服务端） | — |
| `Access-Control-Allow-Origin` | **默认不下发**（ChatGPT 是服务端调用，不需要 CORS） | — |

> `originValidationResponse` / `hostHeaderValidationResponse` 是 SDK 提供的
> 现成响应构造器，与既有 `link-server.ts` 的 Host 白名单语义一致；
> 两处必须共用同一份 env 解析，否则会出现「WSS 能连、/mcp 被拒」。

### 4.6 HTTP 状态码总表

| 状态 | 触发 | 响应体 |
|---|---|---|
| `200` | 正常请求 | JSON 或 SSE（按时代） |
| `202` | 通知被接受（legacy notification） | 无 |
| `400` | `_meta` 与头不一致（`-32020`）／不支持的版本（`-32022`）／JSON-RPC 非法 | JSON-RPC error |
| `401` | 无 Bearer / 令牌无效 / 过期 / `aud` 不符 | `WWW-Authenticate: Bearer resource_metadata="…", scope="…"` |
| `403` | `Origin` 非法 / grant 已撤销 / scope 不足 | `WWW-Authenticate: Bearer error="insufficient_scope", scope="…", resource_metadata="…"` |
| `404` | 未知方法（`-32601`） | JSON-RPC error |
| `405` | `GET` / `DELETE` | JSON-RPC error（无 id） |
| `413` | body 超限 | 纯文本 |
| `429` | 限流 | `Retry-After` |

**不新增业务错误码**：19 个 `REMOTE_ERROR_CODES` 保持不变；上表的
`-32020` / `-32022` / `-32601` 是 **JSON-RPC 传输层**码，不是业务码。

---

## 5. OAuth 2.1 授权设计

### 5.1 完整时序

```
 ChatGPT（client）                Cloud AS                    用户浏览器         Desktop
      │                              │                            │                │
 1    │ GET /mcp（无 token）          │                            │                │
      │─────────────────────────────▶│                            │                │
 2    │ 401 + WWW-Authenticate:       │                            │                │
      │  resource_metadata="…/prm",   │                            │                │
      │  scope="records:read …"       │                            │                │
      │◀─────────────────────────────│                            │                │
 3    │ GET /.well-known/oauth-protected-resource[/mcp]            │                │
      │─────────────────────────────▶│  200 {resource,            │                │
      │                              │       authorization_servers,│                │
      │                              │       scopes_supported}     │                │
 4    │ GET /.well-known/oauth-authorization-server                 │                │
      │─────────────────────────────▶│  200 {issuer, authorize,    │                │
      │                              │       token, registration?, │                │
      │                              │       code_challenge_methods_supported:["S256"],
      │                              │       authorization_response_iss_parameter_supported:true}
 5    │ （注册：预注册 / CIMD / DCR，见 §6）                          │                │
 6    │ GET /mcp/oauth/authorize?response_type=code&client_id=…     │                │
      │   &redirect_uri=…&scope=…&state=…&code_challenge=…          │                │
      │   &code_challenge_method=S256&resource=<MCP_RESOURCE>       │                │
      │─────────────────────────────▶│  校验 client / redirect / PKCE / resource
      │                              │  创建 pending authorization ────────────────▶│
 7    │ 302 → /mcp/consent?req=<opaque>                            │                │
      │◀─────────────────────────────│                            │                │
 8    │                              │◀─── 用户登录（复用 /auth/*）│                │
 9    │                              │◀─── 勾选 4 个 scope + 批准 │                │
      │                              │  落库：mcp_grants（upsert）  │                │
      │                              │        mcp_auth_codes        │                │
 10   │ 302 → redirect_uri?code=…&state=…&iss=<issuer>             │                │
      │◀─────────────────────────────│                            │                │
 11   │ POST /mcp/oauth/token                                       │                │
      │  grant_type=authorization_code&code=…&code_verifier=…       │                │
      │  &redirect_uri=…&client_id=…&resource=<MCP_RESOURCE>        │                │
      │─────────────────────────────▶│  原子消费 code → 建 mcp_sessions
      │◀─────────────────────────────│  {access_token, refresh_token, expires_in, scope}
 12   │ POST /mcp + Authorization: Bearer …                         │                │
      │─────────────────────────────▶│  校验 → grant 回查 → 转发 ──────────────────▶│
```

### 5.2 参数与校验矩阵

| 参数 | 位置 | 必填 | 校验 |
|---|---|---|---|
| `response_type` | authorize | ✅ | 只接受 `code` |
| `client_id` | authorize / token | ✅ | 必须已注册（三种来源之一） |
| `redirect_uri` | authorize / token | ✅ | **精确字符串匹配**已注册值；不做前缀/通配/端口放宽 |
| `scope` | authorize / token | ✅（本服务） | 空格分隔；必须 ⊆ `REMOTE_SCOPES`；未请求到的 scope 不得在 token 中出现 |
| `state` | authorize | 建议 | 原样回传；CSRF 由客户端校验 |
| `code_challenge` | authorize | ✅ | 43 字符 base64url（S256） |
| `code_challenge_method` | authorize | ✅ | **只接受 `S256`**；`plain` → `400 invalid_request` |
| `resource` | authorize / token | ✅ | 必须**逐字符等于** `MCP_RESOURCE` |
| `code_verifier` | token | ✅ | S256 校验；一次性 |
| `code` | token | ✅ | 只存哈希；60 秒；消费即焚；**失败一次也不得重试**（防爆破） |
| `grant_type` | token | ✅ | `authorization_code` / `refresh_token` |
| `refresh_token` | token | 视 grant | 只存哈希；轮换；重放检测 |
| `iss` | 授权响应 | ✅（本服务发送） | 元数据声明 `authorization_response_iss_parameter_supported: true` |

### 5.3 与现有 Desktop 登录 OAuth 的隔离（硬边界）

| 维度 | 现有 `/oauth/*`（Desktop 登录） | 新 `/mcp/oauth/*` |
|---|---|---|
| `redirect_uri` | **只允许** `http://127.0.0.1:<port>/callback`（`isValidLocalCallbackUri`） | 注册表精确匹配（可 https，可 localhost） |
| `grant_type` | 无（`tokenRequestSchema` 只有 code/verifier/redirect_uri） | 必须支持 `authorization_code` + `refresh_token` |
| scope | 无（JWT 无 `scope`） | 必须有，且逐项展示 |
| `aud` | `brewphase-desktop`（常量） | `MCP_RESOURCE`（`<baseUrl>/mcp`） |
| 会话表 | `auth_sessions` | `mcp_sessions`（新，见 §9） |
| 客户端 | 只有第一方 Desktop | 第三方（ChatGPT 等） |
| 用户同意 | 无 | **必须有** consent 页 |

**三条不可动的隔离要求**：

1. **不得修改** `validateAuthorizeInput()` 的 `isValidLocalCallbackUri` 白名单。
   放宽它 = 允许任意站点做 Desktop 登录的 redirect 劫持。
2. **不得让 Desktop 登录 token 通过 `/mcp` 的 audience 校验**：
   `verifyMcpAccessToken` 只接受 `aud === MCP_RESOURCE`。
3. **不得让 MCP token 通过 `/auth/*`**：`verifyAccessToken` 只接受
   `aud === "brewphase-desktop"`。这是既有行为，无需改动，但必须有回归测试
   （双向）。

### 5.4 Scope 集合

沿用既有 4 个只读 scope，**不新增**：

| scope | 覆盖工具 |
|---|---|
| `records:read` | `search_records`, `get_record` |
| `tags:read` | `list_record_tags` |
| `coffee:read` | `list_beans`, `list_brews`, `list_tastings` |
| `canvas:read` | `list_canvases`, `get_canvas` |

**不请求 `offline_access`**：规范明确「资源服务器 SHOULD NOT 把
`offline_access` 放进 `WWW-Authenticate` 或 PRM 的 `scopes_supported`」。
本服务**总是**签发 refresh token（§9.3），因此无需 `offline_access` 语义。

### 5.5 Token 端点错误（OAuth 2.1 §5.2 形状）

| 错误 | HTTP | 场景 |
|---|---|---|
| `invalid_request` | 400 | 缺参数 / `resource` 不匹配 / 未知 `grant_type` |
| `invalid_client` | 401 | `client_id` 未知或与 `redirect_uri` 不符 |
| `invalid_grant` | 400 | code 无效/过期/已用；verifier 不符；refresh 无效/过期/重放 |
| `invalid_scope` | 400 | scope 超出 `REMOTE_SCOPES` |
| `unsupported_grant_type` | 400 | — |
| `server_error` | 500 | 不泄露细节 |

**`invalid_grant` 不区分「不存在」与「已用过」**：区分会变成一个 code
存在性探针。

---

## 6. Discovery 设计

### 6.1 关系图

```
MCP_RESOURCE = https://<host>/mcp          ← JWT aud，mcp_grants.resource
      │
      │  ① 401 WWW-Authenticate: Bearer resource_metadata="…"
      ▼
PRM: https://<host>/.well-known/oauth-protected-resource
     （同时提供 path-inserted 版本 /…/oauth-protected-resource/mcp）
     {
       "resource": "https://<host>/mcp",
       "authorization_servers": ["https://<host>"],     ← issuer
       "scopes_supported": [...4 个...],
       "bearer_methods_supported": ["header"]
     }
      │
      │  ② authorization_servers[0]
      ▼
ISSUER = https://<host>                    ← 无路径，简单情形
      │
      │  ③ RFC 8414（首选） / OIDC Discovery（备选）
      ▼
AS Metadata: https://<host>/.well-known/oauth-authorization-server
     {
       "issuer": "https://<host>",                       ← 必须与 URL 一致
       "authorization_endpoint": "…/mcp/oauth/authorize",
       "token_endpoint":         "…/mcp/oauth/token",
       "registration_endpoint":  "…/mcp/oauth/register",   ← 仅当启用 DCR
       "scopes_supported": [...],
       "response_types_supported": ["code"],
       "grant_types_supported": ["authorization_code","refresh_token"],
       "code_challenge_methods_supported": ["S256"],       ← 必须存在
       "token_endpoint_auth_methods_supported": ["none"],  ← 公共客户端
       "authorization_response_iss_parameter_supported": true,
       "client_id_metadata_document_supported": true       ← 仅当启用 CIMD
     }
```

### 6.2 路径规则（含 issuer 带路径的情形）

| issuer | PRM 位置 | AS Metadata 位置 |
|---|---|---|
| `https://h`（本项目） | `/.well-known/oauth-protected-resource`（+ `/…/mcp`） | `/.well-known/oauth-authorization-server` |
| `https://h/tenant1`（若将来多租户） | `/.well-known/oauth-protected-resource/tenant1/…`（按 RFC 9728 插入） | ① `/.well-known/oauth-authorization-server/tenant1` ② `/.well-known/openid-configuration/tenant1` ③ `/tenant1/.well-known/openid-configuration` |

本设计**刻意让 issuer 不带路径**（`https://<host>`）：带路径会让元数据
发现出现三种候选 URL，而任何一处不一致都会让客户端静默失败。
若将来确实需要多租户，那是一次独立 ADR。

### 6.3 `iss` 参数（RFC 9207）

- Cloud **发送** `iss`（授权响应与错误响应都发）；
- 元数据声明 `authorization_response_iss_parameter_supported: true`；
- 客户端**必须逐字符比较**（禁止大小写折叠/默认端口省略/尾斜杠归一化）；
- 不匹配时客户端不得展示 `error_description`——这条是客户端责任，
  但**服务端必须发 `iss`**，否则能力无从谈起。

### 6.4 Challenge 的 `scope`

| 响应 | `scope` 参数 | 内容 |
|---|---|---|
| 401（无 token） | 包含 | `scopes_supported` 全集的空格连接（4 个） |
| 403（scope 不足） | 包含 | **本次调用实际缺少的 scope**（不是全集） |

理由：一次挑战给全所需 scope 是规范的 SHOULD；但已授权部分不该重复要求，
否则客户端会做无意义的 step-up。

---

## 7. 客户端注册

### 7.1 三种方式的定位

| 方式 | 规范强度 | 本设计 | 理由 |
|---|---|---|---|
| **预注册**（静态 `client_id`） | 允许 | ✅ **必做** | 零网络抓取、零攻击面；第一方与已知合作方用这个 |
| **CIMD**（`client_id` 是 HTTPS URL） | SHOULD | ✅ **做，但走严格抓取器** | 规范首选路径；但抓取是 SSRF 面，必须加固（§7.3） |
| **DCR**（RFC 7591） | MAY，**已弃用** | ⚠️ **保留兼容，默认关闭** | 有第三方证据显示 ChatGPT 走 DCR，但**`NOT VERIFIED`**；作为兼容开关存在，启用与否由 1.3.3 实测决定 |

### 7.2 客户端选择优先级（与规范一致）

```
1. 有预注册信息 → 用它（最安全、最快）
2. AS 元数据 client_id_metadata_document_supported=true → CIMD
3. AS 元数据有 registration_endpoint → DCR（兼容回退）
4. 都没有 → 提示用户手动填写（本项目不做 UI，返回明确错误）
```

### 7.3 CIMD 抓取器（防 SSRF，硬要求）

| 约束 | 值 | 为什么 |
|---|---|---|
| scheme | **只允许 `https`** | 明文可被中间人替换元数据 |
| `client_id` 形态 | 必须含 path 段（`https://h/client.json`） | 规范要求；也排除 `https://h` 这种无意义 id |
| 重定向 | **不跟随**（`redirect: 'manual'`）；3xx → 拒绝 | 跟随会被跳到内网 |
| 目标 IP | 解析后必须**非私有/非回环/非链路本地/非元数据地址**（`169.254.169.254` 等） | SSRF 的核心 |
| 端口 | 只允许 443 | 减少内网服务命中面 |
| 超时 | 3 s 连接 + 5 s 总计 | 防慢速拖死 |
| 响应大小 | ≤ 64 KiB | 防内存放大 |
| `Content-Type` | 必须是 `application/json`（或 `+json`） | 防 HTML 注入 |
| 结构校验 | `client_id` 必须**逐字符等于**请求 URL；必须有 `client_name`、`redirect_uris` | 规范 MUST |
| 缓存 | 遵循 `Cache-Control`；默认 TTL 1 h；上限 24 h | 规范 SHOULD |
| 失败 | 拒绝该客户端（`invalid_client`），**不**回退到 DCR | 静默回退会让 SSRF 变成「一次失败换一条路径」 |
| 出网 | 只允许经 `src/net/proxy-fetch.ts` | 与本项目既有出网纪律一致 |

**DNS rebinding 补充**：解析→校验→连接必须用**同一份**解析结果
（不允许「校验用一次解析、连接再解析一次」）。实现上通过
`lookup` 钩子固定 IP。

### 7.4 DCR 加固（若启用）

| 项 | 要求 |
|---|---|
| 认证 | 仅 `token_endpoint_auth_method: "none"`（公共客户端） |
| `redirect_uris` | 必须 `https` 或 `http://127.0.0.1:<port>/…`；禁止通配；数量 ≤ 5 |
| `application_type` | 客户端 `MUST` 指定；缺省按 `native` 处理并记录 |
| 限额 | 每 IP / 每小时 ≤ 10 次注册；每用户 ≤ 20 个客户端 |
| 存储 | 注册记录带 `registration_source='dcr'`，可批量清理 |
| 关闭开关 | env `MCP_DCR_ENABLED=false` 时 `registration_endpoint` 不出现在元数据里 |

> **不允许**：把 DCR 当成唯一注册路径。规范已弃用它；把它做成唯一路径
> 等于把兼容方案变成硬依赖。

---

## 8. Token 与 Grant 授权链路

### 8.1 Access Token（MCP 专用）

```
签名：HS256，复用 keyRing（同进程；拆分服务时再评估 RS256）
claims：
  iss   = https://<host>              ← 与 AS 元数据 issuer 逐字符相同
  aud   = MCP_RESOURCE = https://<host>/mcp
  sub   = user_id
  sid   = mcp_sessions.id
  grant_id  = mcp_grants.id
  client_id = OAuth client_id
  scope = "records:read coffee:read"  ← 空格分隔，⊆ 授予集合
  jti   = 随机 16 字节 base64url
  iat / exp
```

**硬规则**：

| # | 规则 |
|---|---|
| T1 | **不复用** `signAccessToken()`。新函数 `signMcpAccessToken()`，`aud` 不同 |
| T2 | `aud` 必须是**真实 resource URI**，不是 `"mcp"` 这类不明确常量 |
| T3 | `verifyMcpAccessToken()` 必须校验 `aud`、`iss`、`exp`、`alg=HS256`、`kid` |
| T4 | 令牌**不得**出现在 URL query（`?token=`）——一律 `Authorization: Bearer` |
| T5 | 每个 `/mcp` 请求都必须带 Bearer；不缓存「已认证」状态 |
| T6 | `scope` 只是**快照**，不作为最终授权依据（见 §8.3） |

### 8.2 Grant 与 Session 的关系

```
users ──1:N── mcp_grants ──1:N── mcp_sessions
                  │                  │
                  │                  └─ refresh_token_hash, token_family
                  └─ client_id, scopes[], resource, epoch, revoked_at

mcp_devices ──(无外键)──┐
                        └─ 执行侧：grant_ctx 由 Cloud 在 WSS 上下文中分配
```

| 事实 | 谁持有 | 生命周期 |
|---|---|---|
| 「这个用户授权了这个 client 读这些数据」 | `mcp_grants` | 用户撤销 / 过期策略（本阶段不设过期） |
| 「这个 client 现在持有一组凭证」 | `mcp_sessions` | refresh 轮换 / 撤销 / 过期 |
| 「这个 grant 此刻能不能派发」 | `mcp_grants.revoked_at` + WSS 侧 `ConnSync` | 每次 `/mcp` 回查 + R1/R2 的发送闸门 |

**关键**：grant 是「授权」，session 是「凭证容器」。撤销 grant 必须连带
撤销**该 grant 的** session；撤销 session **不**撤销 grant（用户可能只是
登出了这个客户端，稍后重新授权）。

### 8.3 每次 `/mcp` 都必须回查 grant

```
Authorization: Bearer <jwt>
  ↓ 验签 + aud + exp（内存）
  ↓ 读 mcp_sessions（sid 必须存在、未撤销、未过期）      ← 1 次索引查询
  ↓ 读 mcp_grants（grant_id 必须存在、未撤销、scopes 覆盖、resource 匹配）  ← 1 次索引查询
  ↓ 交给 handler
```

**不能只信 JWT 里的 `scope`**：token 有 15 分钟寿命，而撤销必须「下一次
请求就生效」。只信 JWT 会让撤销窗口等于 token TTL。

**为什么还要读 session**：token 本身无法被单独撤销（无状态 JWT）。
`mcp_sessions.revoked_at` 是「立即失效」的落点——撤销 session 后，
即便 token 未过期，`sid` 也查不到。

### 8.4 `jti` 的语义（P0-2 回归）

| 是 | 不是 |
|---|---|
| Token 级唯一标识 | **请求级去重键** |
| 日志关联（只记前 8 位） | 频率限制的键（限流按 client/user） |
| 异常来源检测的辅助字段 | 「同一 jti 第二次即拒绝」的依据 |

**严禁按 `jti` 阻断同一 access token 的正常多次调用。** 一个 15 分钟的
token 在其生命周期内做 10 次 `tools/call` 是**完全正常**的。任何
「jti 已见过 → 409/401」的实现都是 bug，且会被既有的 ST-25/ST-26 测试抓住。

### 8.5 撤销传播时序

```
用户点「撤销 ChatGPT 的访问」
  ↓
① mcp_grants.revoked_at = now()          （数据库，先落库）
② mcp_sessions（该 grant 的全部）revoked_at = now()
③ grant_epoch + 1
④ Cloud → Desktop：grant_update{op:"revoke"} → 等 ack（R2 的 markSyncLag）
⑤ 之后任何 /mcp 请求：grant 回查失败 → 403
```

| 时刻 | 在途请求 | 新请求 |
|---|---|---|
| ① 之前 | 正常 | 正常 |
| ①–④ 之间 | **立即** `GRANT_REVOKED`（R1 的 `rejectByGrantCtx`） | 403 |
| ④ 失败（ack 超时） | — | 403（Cloud 侧已拒，与 Desktop 状态无关） |

**注意**：Cloud 侧的 `/mcp` 拒绝**不依赖** Desktop 的 ack。ack 只影响
「Desktop 是否还愿意为这个 ctx 执行」，而 `/mcp` 的准入在 Cloud 内完成。
这让撤销对 HTTP 侧是**立即**的。

---

## 9. OQ-3 正式决策：独立 `mcp_sessions` 表

### 9.1 决策

**采用方案 B：新建独立 `mcp_sessions` 表。不改 `auth_sessions`。**

### 9.2 理由（逐条对照真实代码）

| # | 事实（已核对代码） | 若复用 `auth_sessions` 的后果 |
|---|---|---|
| R1 | `auth_sessions.refresh_token_hash` 是 **全局 UNIQUE** | MCP 会话与 Desktop 会话共表时，两套 token 必须在同一唯一域里；任一方的哈希碰撞/清理逻辑都会波及另一方 |
| R2 | `logoutByRefreshToken()` **撤销整个 `token_family`** | 若 MCP 与 Desktop 恰好共享 family（复用逻辑下几乎必然），**MCP 登出会踢掉 Desktop 登录** |
| R3 | `rotateRefreshToken()` 的复用检测会**撤销整族** | MCP 客户端的并发 refresh（很常见：多窗口/重试）会误判为盗用，把 Desktop 一起踢掉 |
| R4 | `auth_sessions` 无 `client_id` / `grant_id` / `scope` / `resource` 列 | 需要加 4 列 + `session_kind`；而这些列对 Desktop 行永远为 NULL——一张表两种语义 |
| R5 | `createSession()` 的 `device_id` 是 Desktop 设备管理预留 | 语义冲突：MCP 的「设备」是 `mcp_devices`（另一张表、另一套凭据） |
| R6 | 现有 340+ 条会话测试全部围绕 `authSessions` | 加列/加 kind 会让每条查询都必须记得 `WHERE session_kind='desktop'`；漏一处就是越权或误踢 |
| R7 | `verifyAccessToken()` 只校验 `aud`，**不查 session 状态** | 两个 `aud` 已经隔离了 token 互用；session 表独立后，撤销语义也天然隔离 |

**决定性理由**：R2/R3 是**结构性**的——不是「注意一下就行」，而是
现有实现会把两个域的会话当成一个安全域。改 `auth_sessions` 需要重写
rotation / logout / reuse-detection 三处核心逻辑，风险远高于新增一张表。

### 9.3 Session 状态机

```
                 create（token 端点签发）
                        │
                        ▼
                   ┌─────────┐
                   │ active  │◀────────┐
                   └────┬────┘         │ rotate（旧行 → rotated）
        refresh 轮换 ────┘              │
                        │              │
        ┌───────────────┼──────────────┴────────┐
        ▼               ▼                       ▼
   ┌─────────┐    ┌──────────┐            ┌──────────┐
   │ rotated │    │ revoked  │            │ expired  │
   └─────────┘    └──────────┘            └──────────┘
   旧行保留           用户撤销 /              expires_at
   供重放检测          grant 撤销 /           到期（惰性判断）
                      reuse 检测
```

| 状态 | 判定 | `/mcp` 行为 | refresh 行为 |
|---|---|---|---|
| `active` | `revoked_at IS NULL AND replaced_by IS NULL AND expires_at > now` | 通过 | 允许 |
| `rotated` | `replaced_by IS NOT NULL` | **拒绝**（旧 token 不该再用） | 宽限窗口内 → `invalid_grant`（不撤族）；窗口外 → **撤族** |
| `revoked` | `revoked_at IS NOT NULL` | 拒绝 | 拒绝 |
| `expired` | `expires_at <= now` | 拒绝（`sid` 查询加 `expires_at > now`） | 拒绝 |

### 9.4 Access Token 生命周期

| 项 | 值 | 理由 |
|---|---|---|
| 算法 | HS256（复用 keyRing） | 同进程签发与校验 |
| TTL | **15 分钟**（复用 `ACCESS_TOKEN_TTL_SECONDS`） | 泄露窗口；撤销靠 session 表兜底，不靠 TTL |
| 撤销 | 无状态——**不逐 token 撤销** | 撤销 `mcp_sessions` 行即可让 `sid` 查不到 |
| 校验 | 每次请求：签名 + `aud` + `iss` + `exp` + `sid` 存在且 active + grant 有效 | 4 步，2 次索引查询 |

### 9.5 Refresh Token 轮换

```
POST /mcp/oauth/token  grant_type=refresh_token&refresh_token=R0
  │
  ├─ BEGIN
  │   SELECT ... FROM mcp_sessions WHERE refresh_token_hash = H(R0) FOR UPDATE
  │   ├─ 无行              → invalid_grant（不区分「不存在」）
  │   ├─ revoked_at ≠ NULL → invalid_grant（**不**透露已撤销）
  │   ├─ replaced_by ≠ NULL：
  │   │     ├─ 距 replaced 时刻 ≤ 宽限（30s）→ invalid_grant（并发重试，不撤族）
  │   │     └─ 超出宽限 → **撤销整个 token_family** + 审计 → invalid_grant
  │   ├─ expires_at ≤ now   → invalid_grant
  │   └─ 正常：
  │        INSERT 新行（同 family，新 hash，replaced_by=NULL）
  │        UPDATE 旧行 SET replaced_by=<新 id>, revoked_at=now
  │ COMMIT
  └─ 返回 {access_token, refresh_token=R1, expires_in, scope}
```

| 规则 | 说明 |
|---|---|
| 只存哈希 | `sha256(pepper ‖ raw)`；明文只在响应中出现一次 |
| 一次性 | 用过即轮换；旧值不可再用 |
| 重放检测 | 宽限窗口外复用 → 撤整族（与 Desktop 登录同一策略） |
| 宽限窗口 | **30 s**（并发刷新很常见；比 Desktop 的窗口短，因为 MCP 客户端重试更激进） |
| 失败不续命 | 轮换失败**不延长** `expires_at`；绝对上限 `min(now + TTL, session_absolute_max)` |
| 绝对上限 | **90 天**（`mcp_sessions.expires_at` 每次轮换取 `min(now+30d, created_at+90d)`） |

**「轮换失败不能造成 Session 无限有效」的实现**：绝对上限锚在
`created_at` 而非「最后一次轮换」。每次轮换只把 `expires_at` 推到
`min(now + 30d, created_at + 90d)`——90 天后必然过期，无论刷新多少次。

### 9.6 行为矩阵（登出 / 撤销 / 过期）

| 触发 | `mcp_grants` | `mcp_sessions` | Desktop 登录 | 其它 MCP 客户端 |
|---|---|---|---|---|
| MCP 客户端登出（`/mcp/oauth/revoke` 带 refresh） | **不动** | 该 family → revoked | **不受影响** | 不受影响 |
| 用户在 Web 撤销某 client 的授权 | 该行 `revoked_at` | **该 grant 的全部** → revoked | 不受影响 | 不受影响 |
| Desktop 登出（`/auth/logout`） | 不动 | **不动** | 该 family → revoked | 不受影响 |
| Desktop 会话过期 | 不动 | 不动 | 该行失效 | 不受影响 |
| Access token 过期 | 不动 | 不动 | 不动 | 不动（自动 refresh） |
| Refresh 重放 | 不动 | 该 family → revoked | 不受影响 | 不受影响 |
| 设备被撤销（`mcp_devices.revoked`） | 不动（安全运维 §4.1 规则 2） | 不动 | 不受影响 | 不受影响（但无设备可执行 → `DEVICE_OFFLINE`） |

**这张表是 OQ-3 的验收本体**：任何一行出现跨列联动，即违反决策。

---

## 10. 数据表设计草案（1.3.1 实施，本阶段不迁移）

> 全部为**草案**。1.3.1 落地时必须校验：不改现有 6 张表、不新增列到
> `auth_sessions`、迁移幂等。

### 10.1 `mcp_oauth_clients`

| 列 | 类型 | 说明 |
|---|---|---|
| `client_id` | text PK | 预注册 id / CIMD 的 URL / DCR 生成的 id |
| `client_name` | text NOT NULL | 同意页展示 |
| `client_uri` | text | 展示用 |
| `logo_uri` | text | 展示用（不抓取，只展示；前端需 `referrerpolicy`） |
| `redirect_uris` | text[] NOT NULL | **精确匹配**用；元素为完整 URI |
| `grant_types` | text[] NOT NULL DEFAULT `{authorization_code,refresh_token}` | |
| `token_endpoint_auth_method` | text NOT NULL DEFAULT `'none'` | 只支持公共客户端 |
| `registration_source` | text NOT NULL | `pre_registered` / `cimd` / `dcr` |
| `metadata_fetched_at` | timestamptz | CIMD 抓取时刻 |
| `metadata_cache_expires_at` | timestamptz | 缓存到期 |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |

约束：`CHECK registration_source IN (...)`；`CHECK array_length(redirect_uris,1) BETWEEN 1 AND 5`。

### 10.2 `mcp_sessions`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | = JWT `sid` |
| `user_id` | uuid NOT NULL → `users(id)` ON DELETE CASCADE | |
| `grant_id` | uuid NOT NULL → `mcp_grants(id)` ON DELETE CASCADE | 撤销 grant 连带删/撤 session |
| `client_id` | text NOT NULL | 便于按客户端查询 |
| `refresh_token_hash` | text NOT NULL UNIQUE | 只存哈希 |
| `token_family` | uuid NOT NULL | 轮换族 |
| `scope` | text[] NOT NULL | 签发时的 scope 快照 |
| `resource` | text NOT NULL | `MCP_RESOURCE` |
| `expires_at` | timestamptz NOT NULL | 见 §9.5 绝对上限 |
| `revoked_at` | timestamptz | |
| `replaced_by` | uuid | 轮换链指针（无外键） |
| `ip_hash` | text NOT NULL DEFAULT `''` | 只存哈希 |
| `user_agent` | text NOT NULL DEFAULT `''` | |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |
| `last_used_at` | timestamptz NOT NULL DEFAULT now() | |

索引：`(user_id)`、`(grant_id)`、`(token_family)`、`(expires_at)`。

> **`grant_id` 用 CASCADE 是刻意的**：grant 被**删除**（不是撤销）时，
> 其 session 已无意义。撤销走 `revoked_at`，不删行。

### 10.3 `mcp_auth_codes`

| 列 | 类型 | 说明 |
|---|---|---|
| `code_hash` | text PK | 只存哈希 |
| `user_id` | uuid NOT NULL | |
| `client_id` | text NOT NULL | |
| `redirect_uri` | text NOT NULL | 精确匹配 |
| `code_challenge` | text NOT NULL | 43 字符 S256 |
| `scope` | text[] NOT NULL | 用户批准的实际 scope |
| `resource` | text NOT NULL | 必须是 `MCP_RESOURCE` |
| `grant_id` | uuid NOT NULL | 同意时 upsert 出的 grant |
| `consumed_at` | timestamptz | |
| `expires_at` | timestamptz NOT NULL | 60 s |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |

### 10.4 复用而非新建

| 需求 | 用现有的 | 不改 |
|---|---|---|
| 「用户授权了某 client」 | `mcp_grants` | 表结构已够（`client_id` / `scopes` / `resource` / `epoch`） |
| 设备凭据 | `mcp_devices` | 不动 |
| 审计事件 | `auth_events`（`event_type` 加新值，不加列） | 复用 |
| 登录态 | `auth_sessions` | **零改动** |

---

## 11. Phase 1.3 拆分

### 11.1 Phase 1.3.1 — MCP OAuth 基础设施

| # | 范围 | 验收 |
|---|---|---|
| 1 | 迁移 `0003_mcp_oauth`：三张新表 | 幂等；现有 6 张表 `information_schema` 逐列不变 |
| 2 | `/mcp/oauth/authorize`（+ consent 页） | 4 个 scope 逐项展示；`redirect_uri` 精确匹配；PKCE 强制 S256 |
| 3 | `/mcp/oauth/token`（`authorization_code` + `refresh_token`） | 轮换、重放检测、绝对上限 |
| 4 | `/mcp/oauth/register`（DCR，**默认关闭**） | 开关关闭时元数据不出现 `registration_endpoint` |
| 5 | CIMD 严格抓取器 | SSRF 用例全绿（私网/回环/重定向/超大/超时/非 JSON） |
| 6 | PRM（root + path-inserted）与 AS 元数据 | `issuer` 与 URL 逐字符一致；`code_challenge_methods_supported` 存在 |
| 7 | `signMcpAccessToken` / `verifyMcpAccessToken` | `aud` 隔离双向测试 |
| 8 | `mcp_sessions` 生命周期 | §9.6 矩阵逐行测试 |
| 9 | 与 Desktop 登录隔离 | `/oauth/authorize` 非 127.0.0.1 仍 400；MCP token 打 `/auth/me` → 401 |

**不含**：`/mcp`、工具、ChatGPT。

### 11.2 Phase 1.3.2 — Streamable HTTP 与工具服务

| # | 范围 | 验收 |
|---|---|---|
| 1 | 引入 `@modelcontextprotocol/server@^2.4.0` 到 Cloud | §1.3 的双时代实测表在 CI 里重跑通过 |
| 2 | `POST /mcp`（`createMcpHandler` + `legacy:'stateless'`） | modern `server/discover` 与 legacy `initialize` 都通过 |
| 3 | Origin / Host / 大小 / 限流 | 非法 Origin → 403；超限 → 413 |
| 4 | Bearer + `aud` + `iss` + `sid` + grant 回查 | 撤销后**下一次**请求即 403 |
| 5 | 8 个只读工具 + schema 一致性 | Cloud 声明与 Desktop `TOOL_DEFINITIONS` 深度相等（fixture） |
| 6 | `tools/call` → `dispatchToolCall` | 复用 R1/R2，不改一行语义 |
| 7 | 错误面 | §4.6 表逐行测试（`-32020`/`-32022`/`-32601`/405） |
| 8 | 日志 | 无 token / 无参数 / 无结果；`jti` 前 8 位 + `grant_id` |
| 9 | `jti` 回归门禁 | 同 token 连续 10 次 `tools/call` 全成功 |

**不含**：真实 ChatGPT。

### 11.3 Phase 1.3.3 — 真实客户端联调

| # | 范围 | 证据要求 |
|---|---|---|
| 1 | MCP Inspector / 官方 client SDK | modern + legacy 各跑一遍（**这是工程验证，不是 ChatGPT 证据**） |
| 2 | ChatGPT 真实连接 | 授权 → 工具发现 → 调用 → 撤销 → 离线，全流程录屏/截图 + 原始请求日志 |
| 3 | Grok 真实连接 | 同上；不支持则明确记录 `NOT VERIFIED` |
| 4 | Refresh 行为 | 观察真实客户端的 refresh 间隔与轮换接受度 |
| 5 | 撤销 / 离线 / 异常恢复 | 与 G4/G5 对应 |
| 6 | 回填 `NOT VERIFIED` 项 | §15 清单逐项关闭 |

**Mock 不得作为 2/3 的证据。** 拿不到真实连接就标记 `NOT VERIFIED`，
不允许用「模拟 ChatGPT 行为」替代。

---

## 12. 测试矩阵

| 组 | 主题 | 条数（目标） | 阻断级别 |
|---|---|---|---|
| A | OAuth 授权码：PKCE / 一次性 / 60s / `redirect_uri` 精确 | ≥ 14 | 发布阻断 |
| B | Refresh：轮换 / 重放 / 宽限 / 绝对上限 | ≥ 10 | 发布阻断 |
| C | Token 隔离（双向 `aud`） | ≥ 6 | 发布阻断 |
| D | Grant 回查与撤销传播 | ≥ 10 | 发布阻断 |
| E | Session ↔ Grant ↔ Desktop 登录三方隔离（§9.6 矩阵） | ≥ 14 | 发布阻断 |
| F | Discovery（PRM / AS 元数据 / `iss` / 路径规则） | ≥ 10 | 发布阻断 |
| G | CIMD SSRF（私网 / 回环 / 重定向 / 大小 / 超时 / 非 JSON） | ≥ 10 | 发布阻断 |
| H | DCR（开关 / 限额 / redirect 约束） | ≥ 6 | 非阻断（默认关闭） |
| I | Streamable HTTP 协议面（`-32020`/`-32022`/`-32601`/405/403/202） | ≥ 16 | 发布阻断 |
| J | 双时代（modern + legacy 各一遍） | ≥ 8 | 发布阻断 |
| K | 工具面一致性（8 个 schema 深度相等） | ≥ 3 | 发布阻断 |
| L | `jti` 不误杀（ST-25/26 回归） | ≥ 4 | 发布阻断 |
| M | 日志安全（哨兵参数 grep 0 命中） | ≥ 3 | 发布阻断 |
| N | 真实客户端（ChatGPT / Inspector） | ≥ 6 | 发布阻断（G1–G5） |

---

## 13. 与现有文档/代码的差异表（1.3.0 修订项）

| # | 旧说法（1.3.0 之前） | 实际 | 处理 |
|---|---|---|---|
| D1 | 路线图 C1：`/mcp` 用 `createMcpHandler + WebStandardStreamableHTTPServerTransport` | `createMcpHandler` 已内部封装 transport，返回 `{fetch, notify, bus, close}`；直接 `handler.fetch(request)` 即可 | 改为 `createMcpHandler(...).fetch`，不再手接 transport |
| D2 | 路线图 G2 验收：`initialize` → `tools/list` | 2026-07-28 **没有** `initialize`（modern）；legacy 才有 | G2 拆成 G2(legacy) 与 G2'(modern `server/discover`)，两者都要过 |
| D3 | 生命周期 §15：「不支持 GET 的 SSE 长连接（ChatGPT 若要求 SSE，1.3 再加）」 | 2026-07-28 **移除** GET 流；`legacy:'stateless'` 也返回 405 | 明确写「GET/DELETE 恒 405」，并删除「1.3 再加」这种会被误读成待办的说法 |
| D4 | 路线图 Phase 1.5 E3：「SSE 长连接（GET /mcp）」 | 已从规范移除（`subscriptions/listen` 取代） | 从 1.5 候选删除，改为「`subscriptions/listen`（若客户端需要）」 |
| D5 | §15 端点表：`POST /register`、`GET /authorize`、`POST /token`（根路径） | 必须与 `/oauth/*` 分离 | 改为 `/mcp/oauth/register|authorize|token|revoke` |
| D6 | 生命周期 §15.1 A 层：「`initialize` / `tools/list` / `tools/call`」 | 三方法分属两个时代 | 补 dual-era 说明 |
| D7 | 架构设计 B7 / OQ-3：「加 `session_kind` 或独立表」 | 决定独立表 | OQ-3 关闭，指向本文件 §9 |
| D8 | 路线图 C3：「`/register`（DCR）」当作必做 | DCR 已弃用，规范为 `MAY` | 改为「默认关闭的兼容项」 |
| D9 | 安全 §3.2 附近：MCP refresh 归属「OQ-3 未定」 | 已定 | 指向本文件 §9 |
| D10 | 路线图 C10：「按 OQ-3 结论落地」 | 已定 | 改为「`mcp_sessions` 独立表」 |

---

## 14. 未验证风险清单（`NOT VERIFIED`）

| # | 项 | 影响 | 何时能关 |
|---|---|---|---|
| N1 | ChatGPT 实际使用的 MCP 协议版本 | 若它只支持 modern，`legacy` 可关；若只支持 legacy，`legacy:'stateless'` 是唯一选择 | 1.3.3 抓原始请求 |
| N2 | ChatGPT 是否要求 DCR | 若要求，`MCP_DCR_ENABLED=true` 成为必选而非兼容 | 1.3.3 |
| N3 | ChatGPT 是否要求 `outputSchema` / `annotations` | 影响 `tools/list` 形态 | 1.3.3 |
| N4 | ChatGPT 的无 refresh 行为（1 小时过期）是否可通过签发 refresh 解决 | 影响会话体验 | 1.3.3 |
| N5 | ChatGPT 是否发送 `resource` 参数 | 若不发，`resource` 校验会拒掉它 → 必须放宽为「缺省时按 client 注册的 resource 补全」，但那是**安全让步**，需明示 | 1.3.3（高危） |
| N6 | Grok 是否支持远程 MCP / 用哪种注册 | 决定是否要额外兼容 | 1.3.3 |
| N7 | CIMD 在真实客户端中的采用率 | 决定 CIMD 的实现优先级 | 1.3.3 |
| N8 | 多实例下 `/mcp` 的 session 表读写是否成为瓶颈 | 影响 1.4 | 1.4 |

**N5 是最高危项**：若 ChatGPT 不发 `resource`，而规范要求「客户端 MUST 发送、
服务端 MUST 校验」，则「照规范严格校验」会直接导致连不上。届时的选择只能是
（a）保持严格、接受连不上；（b）在**仅当** `resource` 缺失时，按
`client_id` 的预注册 resource 补全并记审计。**本阶段不预决**，但把它列为
1.3.3 的第一优先验证项。

---

## 15. 1.3.1 下一阶段实施计划（可直接开工）

### 15.1 顺序（不可并行）

```
1. 迁移 0003 + schema 定义 + 幂等测试
      ↓
2. mcp_sessions 服务（create / rotate / revoke / 复用检测）+ 纯单测
      ↓
3. signMcpAccessToken / verifyMcpAccessToken + 双向 aud 隔离测试
      ↓
4. CIMD 抓取器（独立模块 + SSRF 用例，先不接路由）
      ↓
5. PRM / AS 元数据（静态 JSON，字段来自 env）
      ↓
6. /mcp/oauth/authorize + consent 页 + PKCE 校验 + code 落库
      ↓
7. /mcp/oauth/token（两分支）
      ↓
8. /mcp/oauth/register（DCR，默认关闭）
      ↓
9. §9.6 矩阵全量测试 + 回归（现有 557 条 Cloud 测试全绿）
```

**为什么先做 session 服务**：authorize 与 token 都要用它；
而它又是 OQ-3 决策的落点——先证明状态机正确，再往上接路由。

### 15.2 文件落点（预计）

```
cloud/src/db/migrations/0003_mcp_oauth.sql
cloud/src/db/schema.ts                        （+3 表，不动现有）
cloud/src/mcp-oauth/{sessions.ts, tokens.ts, discovery.ts, cimd.ts, routes.ts, consent.ts}
cloud/src/mcp-oauth/clients.ts                （预注册 + DCR + CIMD 统一解析）
cloud/tests/mcp-oauth/*.test.ts
```

### 15.3 明确不做（1.3.1）

`POST /mcp`、任何工具、`server/discover`、ChatGPT 联调、写工具、
多实例、Redis、`auth_sessions` 改动、Desktop 代码改动。

### 15.4 门禁

```bash
cd cloud && pnpm typecheck && pnpm lint && pnpm test && pnpm build
cd Desktop && pnpm typecheck && pnpm test   # 确认零连带影响
```

必须保持：现有 Cloud 测试全绿（557 → 只增不减）；Desktop 1265 不变；
`auth_sessions` 的 `information_schema` 快照逐列相同；现有
`/oauth/*` 的 9 条身份路由响应体逐字节不变。

---

## 16. 术语对照（避免旧文档用词漂移）

| 旧词 | 新词 | 说明 |
|---|---|---|
| MCP 会话 / `Mcp-Session-Id` | **协议层会话（已移除）** | 2026-07-28 不再有；我们也不生成 |
| session（安全文档里） | **`mcp_sessions`（OAuth 会话）** | 指 refresh token 容器，与协议层会话无关 |
| HTTP+SSE 传输 | **已弃用的旧传输** | 2024-11-05；不实现 |
| `initialize` | **legacy 时代握手** | modern 时代不存在 |
| SSE 长连接 | **`subscriptions/listen`** | 2026-07-28 的通知流机制；本阶段不做 |
| DCR（必做） | **DCR（兼容，默认关闭）** | 已弃用 |
