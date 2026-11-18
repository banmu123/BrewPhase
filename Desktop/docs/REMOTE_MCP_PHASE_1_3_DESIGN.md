# BrewPhase Remote MCP — Phase 1.3 设计基线（1.3.0 + R1 冻结）

> **状态**：`FROZEN`（设计冻结，未实现）
> **冻结日期**：2026-11-18（1.3.0）；**同日 R1 修订**
> **代码基线**：`feature/remote-mcp` @ `095f685`（1.3.0 文档之后）
> **本文件地位**：Phase 1.3 的**唯一设计基线**。当本文件与其它册的
> Phase 1.3 描述冲突时，以本文件为准；其它册的冲突段落已在 1.3.0 与 R1 一并修订。
>
> **两个阶段都没有写任何生产代码、没有新增迁移、没有改动 `auth_sessions`。**

### 0.0 修订记录

| 版本 | 内容 | 触发 |
|---|---|---|
| 1.3.0 | 规范对齐（2026-07-28）、dual-era、OQ-3 定稿、Phase 1.3 拆分 | 任务书 Phase 1.3.0 |
| **1.3.0-R1** | **① 浏览器登录 + Consent 闭环**（1.3.0 写的「复用 `/auth/*`」不成立）；**② Session / Refresh Token 两层模型**（修 90 天续命 + Access Token 提前失效）；**③ 最小权限 scope** | 任务书 Phase 1.3.0-R1 |

**R1 推翻的 1.3.0 三处结论**（详见 §13 的 R1–R9）：

1. 「用户登录复用 `/auth/*`」——Cloud **没有任何 Cookie**，`/auth/*` 全是 Bearer（§1.5）。
2. 「`mcp_sessions` 存 refresh hash、每次轮换新建一行」——这会让 90 天绝对期限
   永远重置，且 `sid` 变化会打挂未过期的 Access Token（§9.2）。
3. 「401 challenge 带全部 4 个 scope」——等于默认索要全部数据权限（§5.8）。

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

### 1.5 浏览器侧的真实现状（Phase 1.3.0-R1 核对，**推翻了 1.3.0 的一处假设**）

1.3.0 的 §5.1 写着「用户登录（复用 `/auth/*`）」——**这句话是错的**，
实现时无从落地。逐项核对真实代码后的事实：

| # | 事实 | 证据 |
|---|---|---|
| B1 | **Cloud 里没有任何 Cookie 使用** | `grep -rn "cookie" cloud/src/` 只命中一条注释（`mcp-devices/schemas.ts:28` 说 claim_secret 不放 cookie）。没有 `setCookie` / `getCookie` / `hono/cookie` import |
| B2 | `/auth/*` 只有 4 个端点，**全部是 Bearer** | `routes/auth.ts`：`POST /auth/refresh`、`POST /auth/logout`、`GET /auth/me`、`GET /auth/identities`。前两个收 `refresh_token` 请求体，后两个走 `requireAuth` |
| B3 | **不存在浏览器登录态** | 没有 session cookie、没有 `/auth/login`、没有登录页。Desktop 的登录是「应用内开系统浏览器 → 本机回环回调」，浏览器侧从不留下任何状态 |
| B4 | `handleProviderCallback()` **与 Desktop 深耦合** | `oauth/callback.ts:131-155`：它在事务里**签发 `oauthCodes` 行**（Desktop 登录码），再 `buildRedirect(transaction.redirectUri, {code, state})`；而 `redirectUri` 已被 `isValidLocalCallbackUri` 限死为 `http://127.0.0.1:<port>/callback` |
| B5 | Provider 适配器**是参数化的** | `provider.ts:16-23` 的 `cloudRedirectUri` 是入参；`google.ts:52-77` / `github.ts:42-64` 都只是 `searchParams.set("redirect_uri", cloudRedirectUri)`。**不改适配器即可指向第二个回调地址** |
| B6 | `oauthTransactions` 是 **Desktop 登录专用** | 列只有 `provider / client_state_hash / provider_state_hash / code_challenge / redirect_uri / nonce_hash / expires_at`。**没有** `client_id` / `scope` / `resource` / `state`(OAuth 的) / 用户 |
| B7 | `oauthCodes` 是 **Desktop 登录专用** | 列只有 `code_hash / user_id / transaction_id / code_challenge / redirect_uri / consumed_at / expires_at`。**没有** `client_id` / `scope` / `resource` / `grant_id` |
| B8 | 现有 `/oauth/authorize` 的 `redirect_uri` 是**硬限 127.0.0.1** | `oauth/authorization.ts:46-49` → `isValidLocalCallbackUri()`（`security/crypto.ts:56`）。这条边界**不可放宽** |

**结论（1.3.0 的错误修正）**：

- MCP 的浏览器授权**不能复用** `/auth/*`、`oauthTransactions`、`oauthCodes`、
  `handleProviderCallback()`——它们每一个都把「Desktop 本机回调」写死在语义里。
- **可以复用**：Provider 适配器（参数化）、`findOrCreateUserWithIdentity()`、
  `recordAuthEvent()`、`hashIp()`、`pepperedSha256Hex()`、`randomToken()`。
- **必须新建**：MCP 自己的授权请求表、浏览器会话载体、Provider 回调路由、
  consent 页、授权码表。

> 这条核对是 1.3.0-R1 的起点。若不先做，1.3.1 一开工就会撞上
> 「浏览器没有登录态」——而那是设计缺口，不是实现细节。

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
  │     无 Bearer / 无效 / 过期 → 401 + WWW-Authenticate(resource_metadata)  ← 不带 scope
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
| `401` | 无 Bearer / 令牌无效 / 过期 / `aud` 不符 | `WWW-Authenticate: Bearer resource_metadata="…"`（**不带 `scope`**，见 §6.4） |
| `403` | `Origin` 非法 / grant 已撤销 / scope 不足 | `WWW-Authenticate: Bearer error="insufficient_scope", scope="…", resource_metadata="…"` |
| `404` | 未知方法（`-32601`） | JSON-RPC error |
| `405` | `GET` / `DELETE` | JSON-RPC error（无 id） |
| `413` | body 超限 | 纯文本 |
| `429` | 限流 | `Retry-After` |

**不新增业务错误码**：19 个 `REMOTE_ERROR_CODES` 保持不变；上表的
`-32020` / `-32022` / `-32601` 是 **JSON-RPC 传输层**码，不是业务码。

---

## 5. OAuth 2.1 授权设计（含浏览器登录与 Consent 闭环）

> **1.3.0-R1 重写**。1.3.0 的版本把「用户登录」写成「复用 `/auth/*`」，
> 而 §1.5 已证明 Cloud 根本没有浏览器登录态。本节给出可直接实现的闭环。

### 5.0 先回答一个问题

> **一个从未访问过 BrewPhase 的新用户，第一次在 ChatGPT 添加 BrewPhase
> Remote MCP 时，怎么走完全程？**

十步，全部有明确落点（`[新]` = 1.3.1 要新建）：

| # | 谁 | 做什么 | 落到哪 |
|---|---|---|---|
| 1 | ChatGPT | `POST /mcp` 无 token → 收 `401` + `WWW-Authenticate: …, resource_metadata="…"` | 1.3.2 |
| 2 | ChatGPT | 读 PRM → 读 AS 元数据 → 选定注册方式（预注册 / CIMD / DCR） | 1.3.1 |
| 3 | ChatGPT | 在用户浏览器打开 `GET /mcp/oauth/authorize?…&code_challenge=…&resource=…` | `[新]` |
| 4 | Cloud | 校验 client / `redirect_uri`（精确）/ PKCE / `resource` → 建 **授权请求行** → `Set-Cookie: bp_mcp_bs`（签名，仅 `/mcp/oauth` 路径） | `[新]` `mcp_auth_requests` |
| 5 | Cloud | `302 → /mcp/oauth/login?rid=…`：页面只有两个按钮（Google / GitHub） | `[新]` 登录页 |
| 6 | 用户 | 点 Google → `302 → accounts.google.com`，`redirect_uri = https://<host>/mcp/oauth/callback/google`，`state = PR`，`nonce = N` | `[新]` 回调路由 |
| 7 | Google | 用户首次登录 Google（可能要过 Google 自己的同意页）→ 回到 `callback?code=…&state=PR` | — |
| 8 | Cloud | 校验 `PR` → 换身份 → **`findOrCreateUserWithIdentity()` 当场创建 BrewPhase 用户**（这就是「从未访问过」的路径）→ 把 `user_id` 写进授权请求行 → `302 → /mcp/oauth/consent?rid=…` | `[新]` + 复用 |
| 9 | 用户 | 页面上看到：**哪个客户端**（`client_name`）、**回到哪个域名**（`redirect_uri` 的 host，规范强制展示）、**四个 scope 各自能读什么**、每项一个复选框（默认全选，可取消）→ 点「允许」 | `[新]` consent 页 |
| 10 | Cloud | 事务内：upsert `mcp_grants`（scope / epoch）→ 插入 `mcp_auth_codes`（`grant_id` + `scope` + `resource` + `redirect_uri`）→ 删授权请求行 → **清 Cookie** → `302 → redirect_uri?code=…&state=…&iss=…` | `[新]` |
| 11 | ChatGPT | `POST /mcp/oauth/token`（code + verifier + redirect_uri + resource）→ 拿到 access + refresh | 1.3.1 |
| 12 | ChatGPT | `POST /mcp` + Bearer → 工具可用 | 1.3.2 |

**「从没访问过 BrewPhase」不构成额外分支**：第 8 步的
`findOrCreateUserWithIdentity()` 对「已存在」与「不存在」是同一个调用——
现有 Desktop 登录也是这么创建用户的（`oauth/callback.ts:118`）。MCP 不需要
第二条用户创建路径。

### 5.1 完整时序（含两条分支）

```
│ ChatGPT 浏览器                      │Cloud                                     │Google / GitHub           │用户      │
│ ────────────────────────────────▶│                                          │                          │        │
│ 1 GET /mcp/oauth/authorize       │① 校验 client / redirect_uri（精确）            │                          │        │
│   response_type=code             │② 校验 PKCE=S256、resource 逐字符               │                          │        │
│   client_id / scope / state      │③ INSERT mcp_auth_requests（10 min）        │                          │        │
│   code_challenge / resource      │④ Set-Cookie: bp_mcp_bs                   │                          │        │
│                                  │   Path=/mcp/oauth; 30 min 不滑动            │                          │        │
│                                  │⑤ 302 → /mcp/oauth/login?rid=…            │                          │        │
│◀──────────────────────────────── │                                          │                          │        │
│ 2 302 /mcp/oauth/login?rid=…     │                                          │                          │        │
│ ────────────────────────────────▶│                                          │                          │        │
│ 3 GET /mcp/oauth/login           │⑥ TOFU 绑定 browser_binding_hash            │                          │        │
│   ?rid=…&provider=google         │⑦ 生成 PR（32B）+ nonce → 存哈希                 │                          │        │
│                                  │ ────────────────────────────────────────▶│                          │        │
│                                  │302 accounts.google.com                   │redirect_uri 指向           │        │
│                                  │state=PR / nonce=N                        │/mcp/oauth/callback/:p    │        │
│ ───────────────────────────────────────────────────────────────────────────▶│                          │        │
│ 4                                │（浏览器跟随跳转，Cloud 不在链路上）                     │登录 / 同意                   │用户      │
│◀─────────────────────────────────────────────────────────────────────────── │                          │        │
│ 5                                │code + state=PR                           │                          │        │
│ 6 GET /mcp/oauth/callback/…      │⑧ hash(PR) 查行 + nonce 校验                  │                          │        │
│   code=…&state=PR                │⑨ 同一个 adapter 换身份                         │                          │        │
│                                  │⑩ findOrCreateUserWithIdentity            │                          │        │
│                                  │    （新用户在这一步创建）                           │                          │        │
│                                  │⑪ UPDATE 行 SET user_id / consumed_at      │                          │        │
│◀──────────────────────────────── │                                          │                          │        │
│ 7 302 /mcp/oauth/consent         │（Location: /mcp/oauth/consent?rid=…）      │                          │        │
│   ?rid=…                         │                                          │                          │        │
│ ────────────────────────────────▶│                                          │                          │        │
│ 8 GET /mcp/oauth/consent         │⑫ 校验 Cookie 绑定 + user_id 已就位              │                          │        │
│   ?rid=…                         │                                          │                          │        │
│◀──────────────────────────────── │                                          │                          │        │
│ 9 200 text/html                  │⑬ 渲染 client_name / 回调域名                   │                          │        │
│                                  │    / 4 项 scope 复选框 / csrf / rid          │                          │        │
│ ────────────────────────────────▶│                                          │                          │        │
│10 POST /mcp/oauth/consent        │⑭ 校验 Cookie 绑定 + csrf_hash                │                          │        │
│   rid/csrf/decision/scope[]      │⑮ BEGIN                                   │                          │        │
│                                  │   upsert mcp_grants（scope, epoch+1）      │                          │        │
│                                  │   INSERT mcp_auth_codes（哈希, 60s）         │                          │        │
│                                  │   DELETE mcp_auth_requests 行             │                          │        │
│                                  │   COMMIT                                 │                          │        │
│◀──────────────────────────────── │                                          │                          │        │
│11 302 redirect_uri               │⑯ Set-Cookie: bp_mcp_bs=（Max-Age=0）       │                          │        │
│   ?code=…&state=…&iss=…          │                                          │                          │        │

12  浏览器把 code 交给客户端 → 客户端 POST /mcp/oauth/token
```

### 5.2 路由表（全部在 `/mcp` 前缀下，与 `/oauth/*` 物理分离）

| 方法 | 路径 | 职责 | 认证方式 |
|---|---|---|---|
| `GET` | `/mcp/oauth/authorize` | 校验 + 建授权请求 + 签发浏览器 Cookie + 分流 | 无（公开） |
| `GET` | `/mcp/oauth/login` | 登录选择页（HTML）；带 `provider` 时直接 302 到 Provider | 浏览器 Cookie（绑定） |
| `GET` | `/mcp/oauth/callback/:provider` | MCP 专用 Provider 回调：换身份 → 建/取用户 → 写 `user_id` | Provider `state` |
| `GET` | `/mcp/oauth/consent` | 渲染同意页（HTML）；每次渲染轮换 CSRF（C2b 已实现） | 浏览器 Cookie（绑定）+ 行内 `user_id` |
| `POST` | `/mcp/oauth/consent` | 批准 / 拒绝 → upsert grant + 签 60s code + 删行（**同一事务**）→ 302 回 `redirect_uri`（C2b 已实现） | 浏览器 Cookie + CSRF |
| `POST` | `/mcp/oauth/token` | `authorization_code` / `refresh_token`（**C3 未实现**） | 无（PKCE / refresh 本身就是凭据） |
| `POST` | `/mcp/oauth/revoke` | RFC 7009；只撤 refresh 所属 **session**，不撤 grant | 无（token 即凭据） |
| `GET` | `.well-known/oauth-protected-resource` | PRM | 无 |
| `GET` | `.well-known/oauth-authorization-server` | AS 元数据 | 无 |
| `POST` | `/mcp/oauth/register` | DCR（**默认关闭**） | 无 |

**与 Desktop 登录的边界**（`/oauth/authorize` 那套）：

| 维度 | `/oauth/*`（Desktop） | `/mcp/oauth/*`（MCP） |
|---|---|---|
| 事务表 | `oauth_transactions` | `mcp_auth_requests` |
| 授权码表 | `oauth_codes` | `mcp_auth_codes` |
| `redirect_uri` | 只能 `127.0.0.1` | 注册表精确匹配（https / localhost） |
| 回调路由 | `/oauth/callback/:provider` | `/mcp/oauth/callback/:provider` |
| 浏览器状态 | **无** | 签名 Cookie（仅 `/mcp/oauth`） |
| 用户同意 | 无 | 必须 |

**两条路由组不共用任何一张表**。共用的只有 Provider 适配器与用户映射函数
（纯函数，无状态）。

### 5.3 浏览器会话模型（最小化）

**决策：签名 Cookie + 服务端零存储（stateless）。不建
`mcp_browser_sessions` 表。**

理由：浏览器会话在这里的**唯一**用途是「证明这个浏览器发起了这个授权请求」。
它不能调任何 API、不是登录态、不参与 `/mcp` 认证、30 分钟就过期。为它建表
等于为 MCP 接入引入一套平行登录系统——正是任务书明确不要的东西。

| 项 | 值 | 依据 |
|---|---|---|
| 载体 | `bp_mcp_bs`，`hono/cookie` 的 `setSignedCookie` | **已实测**：Hono 4.10 的签名 Cookie 可写入、可读回、**篡改后读回 `false`**（见下） |
| 内容 | `{"sid":"<32B base64url>","iat":<epoch>,"exp":<epoch>}` | 只有随机 `sid`；**不放 user_id**（见 §5.4 多标签页） |
| 算法 | Hono 内置 `sign`（HMAC-SHA256 + base64url） | 不自己发明 |
| 密钥 | `MCP_BROWSER_SESSION_KEY`（新 env；≥32 字节）。未配置时**拒绝启动** `/mcp/*` 路由（不是静默降级） | 与 `JWT_SIGNING_KEY` 分开：一个泄露不应波及另一个 |
| `HttpOnly` | **是** | JS 不可读 |
| `Secure` | **是**（`NODE_ENV=production`）；开发环境允许 `false` 并记一条 warn | `http://localhost` 下 `Secure` Cookie 会被丢弃 |
| `SameSite` | **`Lax`** | 登录是顶层 GET 跳转（需要 `Lax` 而非 `Strict`）；`Lax` 同时挡住跨站 POST（CSRF 第一道） |
| `Path` | **`/mcp/oauth`** | 不出现在 `/auth/*`、`/oauth/*`，也**不出现在 `/mcp` 本体**（见 §5.3.1） |
| `Domain` | **不设置**（host-only） | 不跨子域 |
| `Max-Age` | **1800 秒（30 分钟）**，**绝对不滑动** | 每次读不续期：一个 `iat` 到 `exp` 的硬窗口 |
| 清理 | consent 成功/拒绝后 `Max-Age=0`；过期自然失效 | 一次性 |

**实测证据（2026-11-18，Hono 4.10.3，`path: '/mcp/oauth'`）**：

```
SET: 200 bp_mcp_bs=tx123.<sig>; Max-Age=600; Path=/mcp/oauth; HttpOnly; Secure; SameSite=Lax
GET: 200 tx123
TAMPERED: 200 none        ← 篡改签名后 getSignedCookie 返回 false
```

### 5.3.1 为什么 Cookie 的 `Path` 是 `/mcp/oauth` 而不是 `/mcp`

Phase 1.3.0-R1 写的是 `Path=/mcp`，1.3.1-A 修正为 `Path=/mcp/oauth`。

**Cookie 的 Path 是前缀匹配（按路径段边界）**，所以 `Path=/mcp` 会让这个 Cookie
出现在**每一次** `POST /mcp` 的 JSON-RPC 请求里。那些请求由第三方客户端发出、
由 Cloud 转发给 Desktop，Cookie 在里面没有任何用途——却把「浏览器授权状态」
带进了数据端点。收窄到 `/mcp/oauth` 之后：

| 路径 | 收到 `bp_mcp_bs`？ |
|---|---|
| `/mcp/oauth/authorize` · `/login` · `/callback/:provider` · `/consent` · `/token` · `/revoke` | **是** |
| `/mcp`（JSON-RPC 数据端点） | **否**（一个字节都收不到） |
| `/auth/*` · `/oauth/*` | 否 |

**代价只有一个**：consent 页必须跟着挪到 `/mcp/oauth/consent`。如果它留在
`/mcp/consent`，浏览器不会带上 Cookie，绑定校验必然失败——所以这两处修改
是同一个决定的两面，**不能只改一处**。

前缀匹配是按**路径段**而非字符串：`Path=/mcp/oauth` 不会匹配 `/mcp/oauthx`。

### 5.4 绑定：浏览器 ↔ 授权请求

三层，缺一不可：

| 层 | 机制 | 防什么 |
|---|---|---|
| L1 | `mcp_auth_requests.browser_binding_hash = sha256("mcp-browser" ‖ sid)` | 别人的浏览器拿到 `rid` 也打不开同意页 |
| L2 | `mcp_auth_requests.user_id`（由 provider 回调写入）必须非空 | 没登录就走不到同意页 |
| L3 | `mcp_auth_requests.csrf_hash = sha256(csrf)`，`csrf` 只在渲染的 HTML 里 | 跨站伪造 `POST /mcp/oauth/consent` |

**绑定的建立时机（TOFU，首次使用即绑定）**：

```
authorize：browser_binding_hash = NULL（此时可能还没有 Cookie）
第一次进入 login / callback：若 NULL → 写入 hash(当前 sid)；若已写 → 必须相等
之后每一步：必须相等，否则 400 并**立即删除该授权请求行**
```

为什么不在 `authorize` 就绑定：客户端可能是**服务端**去拉 `authorize` URL
（拿到的 `Set-Cookie` 被丢弃），然后才把 URL 交给用户浏览器。那时
`authorize` 阶段没有真实浏览器，硬绑会直接锁死合法流程。
TOFU 的代价是「同一个 `rid` 第一次被谁打开就归谁」——而 `rid` 只在
`Location` 头里出现一次，且行在 10 分钟内过期。

**多浏览器标签页**：

| 场景 | 行为 |
|---|---|
| 同一浏览器开两个标签各自发起授权 | 两个 `rid` 各自绑同一个 `sid`（Cookie 共享）→ **互不干扰**（绑定在行上，不在 Cookie 上） |
| 标签 A 以账号 X 登录、标签 B 以账号 Y 登录 | 合法：`user_id` 写在**各自的行**上，Cookie 不含用户身份 → 两页各自同意各自的 |
| 标签 A 同意后 | 只删 A 的行、只清 A 的 code；B 不受影响（但注意 Cookie 被清 → B 需重新绑定？见下） |

> **Cookie 被清而另一个标签还在流程中**：`consent` 成功会清 Cookie，
> 此时标签 B 的下一次请求没有 Cookie → 绑定校验失败 → 明确提示
> 「授权会话已结束，请重新开始」。这是**可接受**的（B 的行仍在，10 分钟内
> 用户重新打开 `authorize` 即可，`rid` 会新生成）。
> 不为此保留 Cookie 到 30 分钟——因为「一次性状态必须清除」优先。

**错误与边界**：

| 情况 | 行为 |
|---|---|
| Provider 拒绝（`error=access_denied`） | 302 回 `redirect_uri?error=access_denied&state=…&iss=…`；删行；清 Cookie |
| Provider 交换失败 | 同上，`error=server_error`（**不**伪装成用户拒绝） |
| 用户在同意页点「拒绝」 | 302 `redirect_uri?error=access_denied&state=…&iss=…`；删行；清 Cookie |
| 授权请求过期（>10 min） | 同意页 400 + 明确文案；行由 sweep 清理 |
| 浏览器关闭 | 行自然过期；Cookie 自然过期 |
| 用户在同意页取消全选 | 视为拒绝（`access_denied`）；至少选 1 项才能「允许」 |
| `rid` 不存在 / 已消费 | 400（不 redirect——此时无可信 `redirect_uri`） |
| 绑定不匹配 | 400 + **删行**（有劫持嫌疑，留证在 `auth_events`） |
| CSRF 不匹配 | 400 + 删行 + `auth_events{event_type:"mcp_consent_csrf_mismatch"}` |

### 5.5 一次性状态的清理（三处）

| 状态 | 何时清 | 谁清 |
|---|---|---|
| `mcp_auth_requests` 行 | consent 提交（成功或拒绝）时 `DELETE`；过期由 sweep | 同上 |
| `bp_mcp_bs` Cookie | consent 提交后 `Max-Age=0` | 同上 |
| `mcp_auth_codes` 行 | 被 token 端点原子消费（条件 UPDATE + `RETURNING`）；过期由 sweep | token 端点 |

**没有第四处**：不写 `localStorage`、不写 URL、
不在 HTML 里嵌 token/code（`csrf` 与 `rid` 除外，两者都不是凭据）。

### 5.6 参数与校验矩阵

| 参数 | 位置 | 必填 | 校验 |
|---|---|---|---|
| `response_type` | authorize | ✅ | 只接受 `code` |
| `client_id` | authorize / token | ✅ | 必须已注册（三种来源之一） |
| `redirect_uri` | authorize / token | ✅ | **精确字符串匹配**已注册值；不做前缀/通配/端口放宽 |
| `scope` | authorize / token | ✅（本服务） | 空格分隔；必须 ⊆ `REMOTE_SCOPES`；未请求到的 scope 不得出现在 token 中 |
| `state` | authorize | 建议 | 原样回传；CSRF 由客户端校验 |
| `code_challenge` | authorize | ✅ | 43 字符 base64url（S256） |
| `code_challenge_method` | authorize | ✅ | **只接受 `S256`**；`plain` → `400 invalid_request` |
| `resource` | authorize / token | ✅ | 必须**逐字符等于** `MCP_RESOURCE` |
| `code_verifier` | token | ✅ | S256 校验；一次性 |
| `code` | token | ✅ | 只存哈希；60 秒；消费即焚；失败一次不可重试 |
| `grant_type` | token | ✅ | `authorization_code` / `refresh_token` |
| `refresh_token` | token | 视 grant | 只存哈希；轮换；重放检测 |
| `rid` | consent（query/body） | ✅ | UUID；行必须存在且未消费 |
| `csrf` | consent（body） | ✅ | 与行内 `csrf_hash` 比对（常量时间） |
| `decision` | consent（body） | ✅ | `allow` / `deny` |
| `scope[]` | consent（body） | allow 时 ✅ | 每项必须 ∈ 该行 `scope`；至少 1 项 |
| `iss` | 授权响应 | ✅（本服务发送） | 元数据声明 `authorization_response_iss_parameter_supported: true` |

### 5.7 与现有 Desktop 登录 OAuth 的隔离（硬边界）

| 维度 | 现有 `/oauth/*`（Desktop 登录） | 新 `/mcp/oauth/*` |
|---|---|---|
| `redirect_uri` | **只允许** `http://127.0.0.1:<port>/callback`（`isValidLocalCallbackUri`） | 注册表精确匹配（可 https，可 localhost） |
| `grant_type` | 无（`tokenRequestSchema` 只有 code/verifier/redirect_uri） | 必须支持 `authorization_code` + `refresh_token` |
| scope | 无（JWT 无 `scope`） | 必须有，且逐项展示 |
| `aud` | `brewphase-desktop`（常量） | `MCP_RESOURCE`（`<baseUrl>/mcp`） |
| 会话表 | `auth_sessions` | `mcp_sessions` + `mcp_refresh_tokens` |
| 客户端 | 只有第一方 Desktop | 第三方（ChatGPT 等） |
| 用户同意 | 无 | **必须有** consent 页 |
| 浏览器状态 | 无 | 签名 Cookie（仅 `/mcp/oauth`） |

**四条不可动的隔离要求**：

1. **不得修改** `validateAuthorizeInput()` 的 `isValidLocalCallbackUri` 白名单。
   放宽它 = 允许任意站点做 Desktop 登录的 redirect 劫持。
2. **不得让 Desktop 登录 token 通过 `/mcp` 的 audience 校验**：
   `verifyMcpAccessToken` 只接受 `aud === MCP_RESOURCE`。
3. **不得让 MCP token 通过 `/auth/*`**：`verifyAccessToken` 只接受
   `aud === "brewphase-desktop"`。
4. **不得让 MCP Cookie 影响任何非 `/mcp/oauth` 路径**：`Path=/mcp/oauth` 是结构保证，
   不是约定。

### 5.8 Scope 集合与最小权限（Phase 1.3.0-R1 修订）

沿用既有 4 个只读 scope，**不新增**：

| scope | 覆盖工具 |
|---|---|
| `records:read` | `search_records`, `get_record` |
| `tags:read` | `list_record_tags` |
| `coffee:read` | `list_beans`, `list_brews`, `list_tastings` |
| `canvas:read` | `list_canvases`, `get_canvas` |

**不请求 `offline_access`**：规范明确「资源服务器 SHOULD NOT 把
`offline_access` 放进 `WWW-Authenticate` 或 PRM 的 `scopes_supported`」。
本服务总是签发 refresh token，无需该语义。

#### 5.8.1 哪些方法需要业务 scope

| 方法 | 需要业务 scope？ | 依据 |
|---|---|---|
| `server/discover`（modern） | **否** | 只返回版本 / 能力 / serverInfo，不读用户数据 |
| `initialize`（legacy） | **否** | 同上 |
| `tools/list` | **否**（但要有效 session + grant） | 返回**按 grant scope 过滤后**的工具子集；无 scope 时返回空数组而不是 403 |
| `tools/call` | **是**：`scopeForTool(tool)` | 8 个工具与 scope 的映射两侧一致（§11.2 K 组） |

**这一条很关键**：如果把 `tools/list` 也要求 scope，那么一个只授了
`records:read` 的客户端会在列工具时就 403，永远看不到自己还能 step-up 到
`coffee:read`——而「能看见但调用被拒」才是可 step-up 的前提。

#### 5.8.2 401 challenge 的 `scope`：**省略**

| 响应 | `scope` 参数 | 理由 |
|---|---|---|
| `401`（无 token / 无效 / 过期 / `aud` 不符） | **省略** | 此刻不知道客户端要调哪个工具；给全集等于默认索要全部数据权限 |
| `403`（`insufficient_scope`） | **只给缺的那一个** | 精确到工具，才能 step-up |

**为什么可以省略**：规范说「若 challenge 无 `scope`，客户端使用 PRM 的
`scopes_supported`」——那仍然是 4 个。所以**省略并不自动实现最小权限**；
真正的约束在两处：

1. **PRM 的 `scopes_supported` 是「目录」，不是「请求清单」**。
   它是客户端**能**申请的上限，不是它**应该**申请的集合。
2. **consent 页允许逐项取消**。这是用户侧最后一道、也是唯一有效的一道
   最小权限闸门：

```
☑ records:read   — 读取你的记录（标题、正文、笔记、标签）
☑ tags:read      — 读取你的标签列表
☑ coffee:read    — 读取你的豆子、冲煮与品鉴记录
☑ canvas:read    — 读取你的画布与画布节点
   ↑ 默认全选；**你可以取消任意项**。未勾选的权限不会被授予。
```

取消后的结果：`mcp_grants.scopes = 勾选的子集`；
`mcp_auth_codes.scope = 同一子集`；token 的 `scope` 也是该子集。

#### 5.8.3 「只有 `records:read` 的用户能调 `list_beans` 吗」

**不能。** 返回：

```
HTTP/1.1 403 Forbidden
WWW-Authenticate: Bearer error="insufficient_scope",
                         scope="coffee:read",
                         resource_metadata="https://<host>/.well-known/oauth-protected-resource",
                         error_description="coffee:read is required for list_beans"
```

注意 `scope` 只有**缺的那一个**（不是全集）。

#### 5.8.4 Step-up 授权

```
1. 客户端收到 403 + scope="coffee:read"
2. 计算 union = 已持有的 scope ∪ {"coffee:read"}
3. 重新 GET /mcp/oauth/authorize?scope=<union>&…（新的 rid、新的 PKCE）
4. consent 页把「已授予」的项显示为**已勾选且灰置**，只让用户勾新增项
5. 批准后：grant.scopes = union；epoch+1；session.issued_scope = union
6. 新 code → 新 token（scope = union）→ 重试原请求
```

| 约束 | 值 |
|---|---|
| 重试上限 | 每个 `(resource, tool)` 组合 ≤ 2 次 step-up |
| 不可扩到 `REMOTE_SCOPES` 之外 | 越界 → `invalid_scope` |
| 不新增写入权限 | 硬约束 |
| 是否复用原 session | **是**：`session.issued_scope` 更新为 union，`sid` 不变 |

> Step-up 的完整实现属 **1.3.2**（它需要 `tools/call` 的 403 才有触发点）。
> 1.3.1 只需保证：`grant.scopes` / `session.issued_scope` / `code.scope`
> 三者可由 authorize 的 `scope` 参数决定，并允许 consent 收窄。

### 5.9 Token 端点错误（OAuth 2.1 §5.2 形状）

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

### 5.10 Consent 与授权码（1.3.1-C2b 已落地）

#### 5.10.1 同意页的十道门

进入 `GET /mcp/oauth/consent` 必须同时满足：rid 是 UUID、行存在、未过期、
`provider_consumed_at` 非空、`user_id` 非空、provider ∈ {google, github}、
浏览器 Cookie 有效且 `browser_binding_hash` 与当前 sid 一致。失败时：

| 失败 | 副作用 |
|---|---|
| 绑定不匹配 | **删行** + `mcp_browser_binding_mismatch{stage:"consent"}` |
| 过期 | 删行（10 分钟窗口外没有任何用途） |
| 行不存在 / 未登录 | 只给 400 页面；没有可信 `redirect_uri`，不重定向 |

**同意页不允许新建浏览器会话**：绑定只发生在 `/login`。否则「拿到 rid」
就足以在任意浏览器里打开同意页。

#### 5.10.2 CSRF 是「每次渲染换一把」

- 明文 = 32 字节随机值，只写进 HTML 隐藏字段；库里只有 `hashCsrf()`。
- 每次 GET 都**覆盖** `csrf_hash`：旧表单立刻失效（留十分钟再提交、两个
  标签页用旧的那个提交，都会 400）。
- POST 用 `constantTimeEqual(hashCsrf(提交值), row.csrf_hash)` 比对。
- 不匹配：**删行** + `mcp_consent_csrf_mismatch` + 400，不签发任何东西。
- 表单解析只接受 `application/x-www-form-urlencoded`，`rid`/`csrf`/`decision`
  必须**恰好出现一次**（重复即 400）——避免不同解析层各挑一个值。

#### 5.10.3 Step-up：已有 scope 不能丢

```
isStepUp = 已有 active grant 的 scope ⊆ 本次请求的 scope
           且 本次请求新增了 scope
```

| 页面表现 | 服务端行为 |
|---|---|
| 已有项：勾选 + `disabled` | 浏览器不提交它们；服务端按并集补回 |
| 新增项：默认勾选、可取消 | 只接受 ⊆ 请求范围的提交值 |

最终 scope = `已有 scope ∪ 用户勾选的新增 scope`，因此 `final ⊆ requested`
是结构事实。非 Step-up（例如上次授了两个、这次只请求一个）不做并集，
按用户勾选覆盖——那是**收窄**，不是越权。

#### 5.10.4 Grant upsert 与 epoch

同一 `(user_id, client_id, resource)` 只有一行（唯一索引），用
`INSERT … ON CONFLICT DO UPDATE` 完成，**不做「先 SELECT 再 INSERT」**
（不存在的行在 Postgres 里没有可锁对象，并发首授会撞唯一约束）。

| 情况 | epoch |
|---|---|
| 新建 | 1（列默认值） |
| active 且 scope 未变 | **不变** |
| active 且 scope 变了 | +1 |
| 已撤销（`revoked_at` 非空）后再次授权 | +1，并清空 `revoked_at` |

注意这是 `mcp_grants.epoch`（单条 grant 的版本），不是
`mcp_devices.grant_epoch`（设备级帧门槛）。

#### 5.10.5 授权码

- 明文 = 32 字节随机（43 字符 base64url），**只出现一次**：302 的 `Location`。
- 库内 `code_hash = sha256("mcp-code:" ‖ code)`；TTL **60 秒**。
- 继承原授权请求的 `resource` / `redirect_uri` / `code_challenge`；
  `scope` 是**用户实际勾选**的最终集合。
- 与 grant upsert、删授权请求**同一个事务**。删行命中数不是 1 就整体回滚。

#### 5.10.6 在线 Grant 同步（提交之后，不可回滚）

```
事务提交 → 选在线设备 → install / replace / skip → 302 带 code
```

| 情形 | 动作 |
|---|---|
| 新 grant，用户有在线设备 | `installGrant()` |
| 原 grant 已撤销、重新激活 | `installGrant()` |
| scope 变了、旧 ctx 已安装 | `replaceGrant()`（revoke 旧 ctx → ack → install 新 ctx） |
| scope 未变且 ctx 已安装 | **不发帧**（重复 install 会白涨设备级 epoch） |
| 用户没有在线设备 | 不同步；数据库授权照常成立 |

设备选择只读 `inspectForwarder()`（不碰 socket / registry）；Phase 1.3 是
单设备模型，多设备属 1.4。

**ack 超时 / `applied=false` / 离线**：转发层把该连接或该 grant 置为不可
路由（R2 的 `syncLag`），但**数据库不回滚**——授权与「设备此刻是否在线」是
两个生命周期。设备重新握手时 `hello_ok` 会按数据库重建整张快照，那条路径
不依赖这次在线同步是否成功。

#### 5.10.7 与 Desktop OAuth 的隔离（C2b 复核）

一次完整的同意流程不写 `oauth_codes` / `oauth_transactions` / `auth_sessions`；
`bp_mcp_bs` 发给 `/auth/me` 仍 401、发给 `/oauth/token` 仍 400；
`/oauth/authorize` 仍只认 `127.0.0.1` 回调。

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

### 6.4 Challenge 的 `scope`（Phase 1.3.0-R1 修订）

| 响应 | `scope` 参数 | 内容 |
|---|---|---|
| 401（无 / 无效 token） | **省略** | — |
| 403（scope 不足） | 包含 | **只给本次调用缺少的那一个** |

**401 为什么省略**（1.3.0 原写「给全集 4 个」，与 §5.8.2 冲突，此处以 §5.8.2 为准）：

- 此刻还不知道客户端要调用哪个工具，给全集等于**默认索要全部数据权限**；
- 省略后客户端会退化为「使用 PRM 的 `scopes_supported`」（仍是 4 个）——
  所以省略**不自动**实现最小权限，真正的闸门是 **consent 页可逐项取消**（§5.8.2）。

**403 为什么只给一个**：`insufficient_scope` 的语义是「补这个就能过」。
给全集会让客户端做一次覆盖全部 scope 的 step-up，等于把用户已经明确拒绝的
权限重新要一遍。

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
  sid   = mcp_sessions.id            ← **跨刷新不变**（§9.6）
  grant_id  = mcp_grants.id
  client_id = OAuth client_id
  scope = "records:read coffee:read"  ← 空格分隔
                                       = issued_scope ∩ grant.scopes（§9.7）
  jti   = 随机 16 字节 base64url
  iat / exp                           ← 15 分钟
```

**硬规则**：

| # | 规则 |
|---|---|
| T1 | **不复用** `signAccessToken()`。新函数 `signMcpAccessToken()`，`aud` 不同 |
| T2 | `aud` 必须是**真实 resource URI**，不是 `"mcp"` 这类不明确常量 |
| T3 | `verifyMcpAccessToken()` 必须校验 `aud`、`iss`、`exp`、`alg=HS256`、`kid` |
| T4 | 令牌**不得**出现在 URL query（`?token=`）——一律 `Authorization: Bearer` |
| T5 | 每个 `/mcp` 请求都必须带 Bearer；不缓存「已认证」状态 |
| T6 | `scope` 是**签发时的快照**，但每次请求仍要与 `grant.scopes` 求交集（§9.7）——只认 token 会让收窄的 scope 在 15 分钟内继续可用 |
| T7 | `sid` **只在授权时生成一次**；refresh 不得改变它（§9.6 第 1 条） |

### 8.2 Grant 与 Session 的关系

```
users ──1:N── mcp_grants ──1:N── mcp_sessions ──1:N── mcp_refresh_tokens
                  │                  │                    │
                  │                  │                    └─ 每代一个 hash，
                  │                  │                       轮换只动这一层
                  │                  └─ id = sid（稳定）、issued_scope、
                  │                      absolute_expires_at（不可变）
                  └─ client_id, scopes[], resource, epoch, revoked_at

mcp_devices ──(无外键)──┐
                        └─ 执行侧：grant_ctx 由 Cloud 在 WSS 上下文中分配
```

| 事实 | 谁持有 | 生命周期 |
|---|---|---|
| 「这个用户授权了这个 client 读这些数据」 | `mcp_grants` | 用户撤销 / 过期策略（本阶段不设过期） |
| 「这个 client 现在持有一组凭证」 | `mcp_sessions`（身份）+ `mcp_refresh_tokens`（每代） | 身份 90 天；每代 30 天且可轮换 |
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
   └ 其 mcp_refresh_tokens 随 session 一起失效（refresh 时先查 session 状态）
③ grant_epoch + 1
④ Cloud → Desktop：grant_update{op:"revoke"} → 等 ack（R2 的 markSyncLag）
⑤ 之后任何 /mcp 请求：grant 回查失败 → 403
```

**①②必须在同一个事务里**，否则会出现「grant 已撤、session 还能刷新」的窗口
（15 分钟内旧 Access Token 也还能用）。

| 时刻 | 在途请求 | 新请求 |
|---|---|---|
| ① 之前 | 正常 | 正常 |
| ①–④ 之间 | **立即** `GRANT_REVOKED`（R1 的 `rejectByGrantCtx`） | 403 |
| ④ 失败（ack 超时） | — | 403（Cloud 侧已拒，与 Desktop 状态无关） |

**注意**：Cloud 侧的 `/mcp` 拒绝**不依赖** Desktop 的 ack。ack 只影响
「Desktop 是否还愿意为这个 ctx 执行」，而 `/mcp` 的准入在 Cloud 内完成。
这让撤销对 HTTP 侧是**立即**的。

---

## 9. OQ-3 正式决策：Session / Refresh Token 两层模型

> **1.3.0-R1 重写**。1.3.0 的版本把「OAuth Session」与「Refresh Token 代」混成
> 一张表，导致两个真实缺陷：`created_at` 每轮重置（90 天绝对期限被无限续命）、
> `sid` 每轮更换（正常刷新会让尚未过期的 Access Token 立刻失效）。
> 本节把两者拆开，并定稿 Access Token 的刷新行为。

### 9.1 决策

**采用「`mcp_sessions`（1）→ `mcp_refresh_tokens`（N）」两层结构。**
`auth_sessions` 零改动。

### 9.2 为什么必须拆（1.3.0 的两个缺陷）

| # | 1.3.0 的写法 | 实际后果 | 本版修法 |
|---|---|---|---|
| F1 | 每次 refresh **INSERT 一条新的 `mcp_sessions`**，旧行 `revoked_at` | 新行 `created_at = now`，于是 `min(now+30d, created_at+90d)` **永远到不了 90 天**——会话可被无限续命。这正是任务书点出的缺陷 | Session 行**只在授权时创建一次**，`absolute_expires_at` 是**不可变列** |
| F2 | `mcp_sessions.id` 既是 `sid` 又是「当前 refresh 的持有者」 | 新行 = 新 `sid`，于是**上一代的 Access Token 立刻失效**（`sid` 查不到），正常刷新会打挂正在执行的 `tools/call` | `sid` 稳定；`mcp_refresh_tokens` 只换 token，不换 Session 身份 |
| F3 | 撤销粒度只有 `revoked_at` | 「撤销这代 token」与「撤销整个会话」用同一个字段，语义混淆 | 两个字段：`mcp_refresh_tokens.consumed_at`（这代用完）／`mcp_sessions.revoked_at`（整个会话作废） |

**根本原因是一个概念错位**：Session 是「一次授权的长期身份」，
Refresh Token 是「这个身份的一代凭据」。前者有 90 天寿命，后者 30 天且可轮换。
把它们塞进一张表，就必须在「续期」与「换身份」之间二选一——而两者都不对。

### 9.3 ER 图

```
users
  │ 1
  │
  │ N
mcp_grants ──────────────────────────────────────────┐
  │ id (grant_id)                                     │
  │ user_id, client_id, client_name                   │
  │ scopes[], resource, epoch, revoked_at             │
  │                                                   │
  │ 1                                                 │
  │                                                   │
  │ N                                                 │
mcp_sessions ◀────────────────────────────────────────┘
  │ id  = JWT `sid`  ← **稳定，授权时生成一次**
  │ user_id, grant_id, client_id
  │ issued_scope[]         ← 本次授权实际授予的 scope（step-up 时更新）
  │ resource
  │ created_at             ← **不可变；90 天的起点**
  │ absolute_expires_at    ← **不可变** = created_at + 90d
  │ revoked_at, revoked_reason
  │ last_used_at
  │
  │ 1
  │
  │ N
mcp_refresh_tokens
  │ id
  │ session_id ──────────▶ mcp_sessions.id （ON DELETE CASCADE）
  │ token_hash              （UNIQUE，只存哈希）
  │ generation              （1,2,3… 单调，便于排障）
  │ created_at
  │ expires_at              = min(created_at + 30d, session.absolute_expires_at)
  │ consumed_at             ← 被轮换掉的时刻（NULL = 当前这代）
  │ replaced_by             ← 下一代的 id（无外键，允许独立清理）
  │ ip_hash, user_agent
```

**没有 `token_family` 列**：Session 本身就是族根。1.3.0 的
`token_family` 是从 `auth_sessions` 抄来的——那张表里一次「登录」会产生多条
并行会话（多设备），所以要用 family 归组；而 MCP 的一次授权只有一条
Session，family 恒等于 `session_id`，加列只会多一处可能不一致。

### 9.4 Session 状态机

```
                  授权码兑换（POST /mcp/oauth/token，grant_type=authorization_code）
                                    │
                                    ▼
                            ┌───────────────┐
                            │    active     │◀── refresh 轮换（**状态不变**，
                            └───────┬───────┘     只换 refresh token）
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          │                         │                         │
          ▼                         ▼                         ▼
   ┌────────────┐          ┌──────────────┐          ┌──────────────┐
   │  revoked   │          │   expired    │          │   (无第三态)  │
   └────────────┘          └──────────────┘          └──────────────┘
   用户撤销 / grant 撤销 /     absolute_expires_at
   refresh 重放 / 登出         到期（惰性判定）
```

| 状态 | 判定 | `/mcp` 行为 | refresh 行为 |
|---|---|---|---|
| `active` | `revoked_at IS NULL AND absolute_expires_at > now` | 通过 | 允许 |
| `revoked` | `revoked_at IS NOT NULL` | 拒绝（401） | 拒绝（`invalid_grant`） |
| `expired` | `absolute_expires_at <= now` | 拒绝（401） | 拒绝（`invalid_grant`） |

**只有三态。** 1.3.0 的 `rotated` 态消失了——那正是「Session 与 Refresh 混表」
的产物：轮换是 refresh **代**的事件，不是 session 的状态。

### 9.5 Access Token 生命周期（定稿）

| 项 | 值 | 理由 |
|---|---|---|
| 算法 | HS256（复用 keyRing） | 同进程签发与校验 |
| TTL | **15 分钟** | 泄露窗口；撤销靠 Session 行兜底，不靠 TTL |
| `sid` | `mcp_sessions.id`，**跨刷新不变** | 见 §9.6 第 1 条 |
| `scope` | 签发时 = `mcp_sessions.issued_scope` ∩ `mcp_grants.scopes` | 见 §9.7 |
| 撤销 | 不逐 token 撤销 | 撤销 Session 行 → `sid` 查不到 → 立即失效 |

### 9.6 Refresh 后的 Access Token 行为（逐条定稿）

| # | 问题 | 定稿答案 | 理由 |
|---|---|---|---|
| 1 | 刷新后，**之前签发的** Access Token 还有效吗 | **有效，直到它自己的 `exp`（≤15 分钟）** | `sid` 稳定 + Session 仍 active。让一次正常轮换打挂正在执行的 `tools/call` 是不可接受的：客户端刷新与工具调用是**独立并发**的 |
| 2 | 同一 Session 内正在执行的 `tools/call` 会被刷新影响吗 | **不会** | 同上；且 Cloud 侧转发层（R1/R2）只看 `grant_ctx`，不看 token |
| 3 | Logout 后旧 Access Token 如何**立即**失效 | `mcp_sessions.revoked_at = now()` → 下一次 `/mcp` 的 `sid` 查询失败 → 401（**不是**等 15 分钟） | 无状态 JWT 无法逐 token 撤销，Session 行是唯一落点 |
| 4 | Refresh 重放后如何撤销整个「族」 | **撤销 Session**（`revoked_at` + `revoked_reason='refresh_reuse'`） | Session 即族根；连带所有代 token 与所有 Access Token 一起失效 |
| 5 | Grant 撤销后，Session 与 Access Token 如何一起失效 | **同一事务**：`mcp_grants.revoked_at` + `mcp_sessions.revoked_at`（该 grant 的全部） | 撤销必须原子；分两次会出现「grant 已撤、session 还能刷」的窗口 |

**第 1 条与第 3 条看似矛盾，实则互补**：

```
正常刷新：  sid 不变 → 旧 token 自然过期（15 min 内仍可用）→ 无感
Session 撤销：sid 那行被标记 → 旧 token 立刻失效 → 强收敛
```

这正是「稳定 `sid`」的价值：它把「刷新」与「撤销」区分开了。
如果 `sid` 每轮都变，两者都会表现为「旧 token 立刻失效」——那就无法表达
「正常的凭据轮换」与「授权被收回」的区别。

### 9.7 有效 scope = token.scope ∩ grant.scopes

每个 `/mcp` 请求的授权判定是**两个集合的交集**，再判断是否覆盖工具所需：

```
effective = (access_token.scope ∩ mcp_grants.scopes)
required  = scopeForTool(tool)
required ⊆ effective  否则 403 insufficient_scope(scope=required)
```

| 事件 | 对 effective 的影响 |
|---|---|
| 用户同意时取消某项 | 两处都没有 → 立刻不可用 |
| Grant scope 被收窄 | `grant.scopes` 变小 → **旧 token 立刻失去该权限**（不必等刷新） |
| Step-up 扩大 grant | `grant.scopes` 变大，但旧 token 的 `scope` 没变 → **需要新 token**（符合 OAuth 直觉） |
| 正常 refresh | 新 token 的 `scope` = `session.issued_scope` ∩ `grant.scopes` |

**为什么两个都要**：

- 只看 grant：一次 step-up 会让**所有历史 token** 立刻获得新权限——即使
  某个 token 是在用户还没同意那项权限时签发的。这违反「token 代表一次授权」。
- 只看 token：撤销某项 scope 后，旧 token 仍能在 15 分钟内继续用——撤销就不
  是「下一次请求生效」了。

### 9.8 Refresh Token 轮换时序

```
POST /mcp/oauth/token   grant_type=refresh_token&refresh_token=R_n&resource=…
  │
  ├─ BEGIN
  │   SELECT * FROM mcp_refresh_tokens WHERE token_hash = H(R_n) FOR UPDATE
  │   ├─ 无行                     → invalid_grant（不区分「不存在」）
  │   ├─ consumed_at IS NOT NULL：
  │   │     ├─ now - consumed_at ≤ 30s → invalid_grant（并发重试，**不撤会话**）
  │   │     └─ 否则                     → **撤销整个 Session** + 审计 → invalid_grant
  │   ├─ expires_at ≤ now          → invalid_grant
  │   └─ 正常：
  │        SELECT * FROM mcp_sessions WHERE id = session_id FOR UPDATE
  │        ├─ revoked_at NOT NULL      → invalid_grant
  │        ├─ absolute_expires_at ≤ now → invalid_grant
  │        └─ 正常：
  │             新代 R_{n+1}：
  │               generation   = R_n.generation + 1
  │               expires_at   = min(now + 30d, session.absolute_expires_at)
  │               token_hash   = H(R_{n+1})
  │             UPDATE R_n SET consumed_at = now, replaced_by = R_{n+1}.id
  │             **UPDATE mcp_sessions 只动 last_used_at**（不动 created_at /
  │              absolute_expires_at / id）
  │ COMMIT
  └─ 签发 access token（sid 不变，scope = issued_scope ∩ grant.scopes）
```

**顺序不可交换**：先锁 refresh 行，再锁 session 行。反过来的话，两个并发
refresh 可能各自锁住 session、再互相等待对方的 refresh 行——死锁。
统一「先细后粗」是这一层的锁序约定。

### 9.9 90 天绝对期限（不可续命）

```
absolute_expires_at = session.created_at + 90 days      ← 写入时算一次，之后只读
refresh_token.expires_at = min(now + 30 days, session.absolute_expires_at)
```

| 规则 | 实现要求 |
|---|---|
| `absolute_expires_at` **不可变** | 只在 INSERT 时赋值；**没有任何 UPDATE 语句碰它**（测试用 grep 断言） |
| 起点是 Session 的 `created_at` | **不是** refresh 记录的 `created_at`（1.3.0 的 bug 正在这里） |
| 每次刷新只推 `expires_at` | 且被 `absolute_expires_at` 夹住 |
| 到达上限后 | `expires_at` 已经是过去时间 → 下一次刷新必然 `invalid_grant` |
| 不因 refresh 而延长 | 刷新**不**改 `created_at`、不改 `absolute_expires_at`、不新建 Session |
| 时钟来源 | 全部由注入的 `now` 参数给出（不散落 `new Date()`） | 

**验证方案（1.3.1 必须逐条测）**：

| # | 场景 | 断言 |
|---|---|---|
| A1 | 连续 5 次正常刷新（每次间隔 1 小时） | `sid` 不变；`absolute_expires_at` 逐字节不变；**6 条** `mcp_refresh_tokens`（初始 + 5 代），前 5 条 `consumed_at` 非空 |
| A2 | 每次刷新后 `expires_at` | 恒 ≤ `absolute_expires_at`，且 ≤ 自己 `created_at` + 30d |
| A3 | 在第 **29 / 58 / 87 / 89** 天各刷新一次（注入时钟） | 每次都成功，`absolute_expires_at` **不变** |
| A4 | 第 90 天 + 1 秒再刷新 | `invalid_grant`；Session 状态为 `expired` |
| A5 | 在第 89 天刷新 | 成功，但新 token 的 `expires_at` = `absolute_expires_at`（不是 now+30d） |
| A6 | 撤销后刷新 | `invalid_grant`；不新建任何 token 行 |
| A7 | 宽限外重放 | `invalid_grant` 且 Session `revoked`；该 Session 全部 refresh 行不可用 |
| A8 | 全表扫描 | 没有任何 `UPDATE mcp_sessions SET absolute_expires_at`（grep 源码 + 运行期快照比对） |

> **1.3.1-B 修正了 A1/A3 两处数字自洽问题**（语义未变）：
>
> - A1 原写「5 条 token，前 4 条已消费」，那是 **4 次**刷新的结果。
>   5 次刷新应为 6 条（初始 + 5 代）、前 5 条已消费。
> - A3 原写「+31d / +62d / +89d」，但**单代 token 只有 30 天寿命**：
>   第 31 天时第一代必然已过期，那次刷新只会得到 `token_expired`，
>   与「Session 绝对上限」毫无关系。要跨窗口就必须在每代到期前刷新一次，
>   所以取 29/58/87/89 天。
>
> 这两处若不修正，实现者会照抄一组永远不可能通过的期望值，然后为了让它
> 「通过」而去放宽 token TTL——那正好会破坏模型的另一半。

### 9.10 Refresh 并发与重放（行为矩阵）

| 场景 | 结果 | 会话 |
|---|---|---|
| 两个并发请求用**同一个** R_n | **恰好一个 200**（拿到 R_{n+1}）；另一个 `invalid_grant` | **不撤**（宽限内） |
| 第一个成功但**响应丢失**，客户端立即重试 R_n | `invalid_grant`（宽限内） | **不撤**，但**客户端拿不到 R_{n+1}** |
| 重试发生在宽限窗口（30s）之后 | `invalid_grant` | **撤销**（判定为盗用） |
| 撤销后继续刷新 | `invalid_grant` | 已撤销 |
| 绝对上限后刷新 | `invalid_grant` | `expired` |
| R_n 已被消费但 Session 已撤销 | `invalid_grant`（**先判 session**？见下） | 已撤销 |

**判定顺序**：先看 `consumed_at`（决定是否撤会话），再看 session 状态。
理由：重放检测是安全事件，必须在「会话已撤销」这个更平淡的理由之前判定，
否则一次真实的盗用会被记成「会话已过期」。

#### 9.10.1 「响应丢失后客户端能否自动恢复」——**不能**

必须明确，不能把「宽限内不撤族」误读成「客户端可恢复」：

| 问题 | 答案 |
|---|---|
| 两个并发刷新，谁成功 | 先拿到行锁的那个（`SELECT … FOR UPDATE`），另一个必败 |
| 失败的那个拿到什么 | `400 invalid_grant`，`error_description = "refresh token was already rotated"` |
| 成功的那个响应丢了怎么办 | **无法恢复**。R_{n+1} 只存在于那次丢失的响应里 |
| 30 秒窗口内是否只返回 `invalid_grant` | **是**。不返回任何 token，也不透露 R_{n+1} |
| 30 秒外 | `invalid_grant` + **撤销整个 Session** |
| 需要幂等恢复机制吗 | **v1 不要**（理由见下） |

**为什么不做幂等恢复**：唯一能实现它的办法是把「已下发但可能丢失的新 token
明文」在服务端暂存一段时间（加密或明文），等重试时再吐一次。代价：

| 方案 | 代价 |
|---|---|
| 加密暂存新 token N 秒 | 引入第二把密钥 + 一段「明文 token 在服务端驻留」的窗口；密钥泄露即等于 token 泄露。这正是本项目一直拒绝的模式（「只存哈希」是 Cloud 的硬纪律） |
| 宽限内重新签发一代（作废旧的新 token） | 谁持有旧 R_n 谁就能拿到有效 token。攻击者若已窃取 R_n，这等于额外送他一次成功；而不做的话他只会得到 `invalid_grant`。**严格更差** |
| 客户端持久化「未确认的 refresh」 | 客户端侧问题，Cloud 无法保证 |

**结论**：v1 接受「一次刷新失败 = 需要重新授权」。这是**明确失败优于
静默不安全**的一次应用。文档与 UI 必须如实表达：「连接已断开，请重新连接」，
而不是假装可以自动重试。

### 9.11 行为矩阵（登出 / 撤销 / 过期）

| 触发 | `mcp_grants` | `mcp_sessions` | `mcp_refresh_tokens` | Desktop 登录 | 其它 MCP 客户端 |
|---|---|---|---|---|---|
| MCP 客户端登出（`/mcp/oauth/revoke` 带 refresh） | **不动** | 该 session → revoked | 该 session 全部代失效 | **不受影响** | 不受影响 |
| 用户在 Web 撤销某 client 的授权 | 该行 `revoked_at` | **该 grant 的全部** → revoked | 全部代失效 | 不受影响 | 不受影响 |
| Desktop 登出（`/auth/logout`） | 不动 | **不动** | 不动 | 该 family → revoked | 不受影响 |
| Desktop 会话过期 | 不动 | 不动 | 不动 | 该行失效 | 不受影响 |
| Access token 过期（15 min） | 不动 | 不动 | 不动 | 不动 | 自动 refresh |
| Refresh 重放（宽限外） | 不动 | **该 session** → revoked | 该 session 全部代失效 | 不受影响 | 不受影响 |
| 到达 90 天绝对上限 | 不动 | 状态为 `expired`（不写 `revoked_at`） | 全部过期 | 不受影响 | 需重新授权 |
| 设备被撤销（`mcp_devices.revoked`） | 不动（安全运维 §4.1 规则 2） | 不动 | 不动 | 不受影响 | 不受影响（但 `DEVICE_OFFLINE`） |

**这张表是 OQ-3 的验收本体**：任何一行出现跨列联动（MCP 登出影响 Desktop、
Desktop 登出撤 MCP）即违反决策。

### 9.12 `sid` 与协议层会话的区分（防混淆）

| 名称 | 是什么 | 寿命 | 出现位置 |
|---|---|---|---|
| `sid`（`mcp_sessions.id`） | OAuth 会话标识 | 90 天上限 | JWT claim |
| ~~`Mcp-Session-Id`~~ | 协议层会话（**2026-07-28 已移除**） | — | **不实现、不生成** |
| `bp_mcp_bs` Cookie | 浏览器授权流程绑定 | 30 分钟 | 仅 `/mcp/oauth` 路径 |

三者互不替代。任何文档把 `sid` 说成「MCP 会话 id」都必须改成
「OAuth 会话 id」。

## 10. 数据表设计（1.3.1-A 已落地为 migration 0003）

> **1.3.1-A 已实现**：`cloud/src/db/migrations/0003_mcp_oauth.sql` +
> `cloud/src/db/schema.ts`。落地时的三处收紧见 §10.8（都不改变本节的语义）。
> 1.3.1 落地时必须校验：不改现有 6 张表、不新增列到
> `auth_sessions`、迁移幂等。**五张新表**（1.3.0 是四张，1.3.0-R1 拆出了
> `mcp_refresh_tokens`，并新增了 `mcp_auth_requests`）。

### 10.1 `mcp_oauth_clients`

| 列 | 类型 | 说明 |
|---|---|---|
| `client_id` | text PK | 预注册 id / CIMD 的 URL / DCR 生成的 id |
| `client_name` | text NOT NULL | 同意页展示 |
| `client_uri` | text | 展示用 |
| `logo_uri` | text | 展示用（**不抓取**，只 `<img referrerpolicy="no-referrer">`） |
| `redirect_uris` | text[] NOT NULL | **精确匹配**用；元素为完整 URI |
| `grant_types` | text[] NOT NULL DEFAULT `{authorization_code,refresh_token}` | |
| `token_endpoint_auth_method` | text NOT NULL DEFAULT `'none'` | 只支持公共客户端 |
| `registration_source` | text NOT NULL | `pre_registered` / `cimd` / `dcr` |
| `metadata_fetched_at` | timestamptz | CIMD 抓取时刻 |
| `metadata_cache_expires_at` | timestamptz | 缓存到期 |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |

约束：`CHECK registration_source IN (...)`；
`CHECK array_length(redirect_uris,1) BETWEEN 1 AND 5`。

### 10.2 `mcp_auth_requests`（**新增**：浏览器授权流程的短期状态）

一次 `authorize` 一行。它是 1.3.0 完全缺失的那块——没有它，
「登录完成后回到哪个授权请求」无处可放。

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | = `rid`（出现在 `Location` 与同意页表单里） |
| `client_id` | text NOT NULL → `mcp_oauth_clients(client_id)` | |
| `redirect_uri` | text NOT NULL | 已与注册值精确匹配过 |
| `scope` | text[] NOT NULL | 客户端**请求**的 scope（用户可在此子集内收窄） |
| `resource` | text NOT NULL | 必须 = `MCP_RESOURCE` |
| `state` | text | 客户端 `state`，原样回传（可为空串） |
| `code_challenge` | text NOT NULL | 43 字符 S256 |
| `code_challenge_method` | text NOT NULL DEFAULT `'S256'` | |
| `csrf_hash` | text NOT NULL | `sha256("mcp-csrf"‖csrf)`；明文只在渲染的 HTML 里 |
| `browser_binding_hash` | text | `sha256("mcp-browser"‖sid)`；NULL = 尚未绑定（TOFU，见 §5.4） |
| `user_id` | uuid → `users(id)` ON DELETE CASCADE | NULL = 还没登录 |
| `provider` | text | 已选中的 Provider（`google` / `github`）；NULL = 未选 |
| `provider_state_hash` | text UNIQUE | `PR` 的哈希；回调时按此反查 |
| `nonce_hash` | text NOT NULL DEFAULT `''` | Google OIDC nonce |
| `provider_consumed_at` | timestamptz | Provider 回调已用掉（一次性） |
| `expires_at` | timestamptz NOT NULL | **10 分钟**（比 Desktop 的 5 分钟长：多了一次登录） |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |

索引：`(provider_state_hash)` 唯一、`(expires_at)`、`(user_id)`。

> **为什么 `state` / `code_challenge` 不存哈希**：它们是**客户端**的东西，
> 不是我们的凭据。存哈希会让回调后无法原样回传（`state` 必须逐字节还回去）。
> 这一点与 `oauth_transactions` 的做法不同——那是 Desktop 登录，它选择
> 「CS 明文经 Provider state 透传」来同时满足「只存哈希」与「原样回传」；
> MCP 侧不需要这个技巧，因为 `state` 就在我们自己的行里。

### 10.3 `mcp_auth_codes`

| 列 | 类型 | 说明 |
|---|---|---|
| `code_hash` | text PK | `sha256("mcp-code"‖code)`；明文只在 302 的 `Location` 里出现一次 |
| `user_id` | uuid NOT NULL → `users(id)` ON DELETE CASCADE | |
| `client_id` | text NOT NULL | |
| `grant_id` | uuid NOT NULL → `mcp_grants(id)` ON DELETE CASCADE | 同意时 upsert 出的 grant |
| `redirect_uri` | text NOT NULL | 精确匹配 |
| `code_challenge` | text NOT NULL | S256 |
| `scope` | text[] NOT NULL | **用户实际勾选**的子集（可能少于请求） |
| `resource` | text NOT NULL | = `MCP_RESOURCE` |
| `consumed_at` | timestamptz | 被 token 端点原子消费 |
| `expires_at` | timestamptz NOT NULL | **60 秒** |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |

### 10.4 `mcp_sessions`（**重构**：只留身份，不留凭据）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | = JWT `sid`，**授权时生成一次，之后永不变** |
| `user_id` | uuid NOT NULL → `users(id)` ON DELETE CASCADE | |
| `grant_id` | uuid NOT NULL → `mcp_grants(id)` ON DELETE CASCADE | 撤销 grant 连带撤 session |
| `client_id` | text NOT NULL | 便于按客户端查询 |
| `issued_scope` | text[] NOT NULL | 本次授权实际授予的 scope（step-up 时更新为 union） |
| `resource` | text NOT NULL | `MCP_RESOURCE` |
| `created_at` | timestamptz NOT NULL DEFAULT now() | **不可变**：90 天起点 |
| `absolute_expires_at` | timestamptz NOT NULL | **不可变** `= created_at + 90d` |
| `revoked_at` | timestamptz | |
| `revoked_reason` | text | `user_revoke` / `grant_revoked` / `refresh_reuse` / `client_revoke` |
| `last_used_at` | timestamptz NOT NULL DEFAULT now() | 只在 refresh 时更新 |
| `ip_hash` | text NOT NULL DEFAULT `''` | 只存哈希 |
| `user_agent` | text NOT NULL DEFAULT `''` | |

索引：`(user_id)`、`(grant_id)`、`(absolute_expires_at)`。

**与 1.3.0 的差异**：删掉 `refresh_token_hash`、`token_family`、
`replaced_by`、`expires_at`（可动的那一列）。它们全部搬到
`mcp_refresh_tokens`。留下的每一列都是**不可变或与身份有关**的。

> **`refresh_token_hash` 必须移走**，不只是「为了整洁」：
> 留在 `mcp_sessions` 上就会有一条 `UNIQUE` 约束跨越整个会话表，
> 而每次轮换都要 `UPDATE` 同一行——那正好是 1.3.0 缺陷的物理形态
> （轮换 = 改 Session）。

### 10.5 `mcp_refresh_tokens`（**新增**：每一代凭据）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `session_id` | uuid NOT NULL → `mcp_sessions(id)` ON DELETE CASCADE | 族根 |
| `token_hash` | text NOT NULL UNIQUE | `sha256("mcp-refresh"‖token)` |
| `generation` | integer NOT NULL | 1,2,3…；`UNIQUE(session_id, generation)` |
| `created_at` | timestamptz NOT NULL DEFAULT now() | 这代的签发时刻 |
| `expires_at` | timestamptz NOT NULL | `= min(created_at + 30d, session.absolute_expires_at)` |
| `consumed_at` | timestamptz | 被轮换掉的时刻；NULL = 当前这代 |
| `replaced_by` | uuid | 下一代的 id（**无外键**：历史链允许独立清理） |
| `ip_hash` | text NOT NULL DEFAULT `''` | |
| `user_agent` | text NOT NULL DEFAULT `''` | |

索引：`(session_id, generation)` 唯一、`(expires_at)`。

约束：`CHECK generation >= 1`；`CHECK expires_at > created_at`。

**「当前这代」的判据**：`consumed_at IS NULL`。**不用** `ORDER BY created_at
DESC LIMIT 1`——并发下两条未消费行会让「当前」变成不确定的。

而且这条判据**必须由数据库强制**：

```sql
CREATE UNIQUE INDEX "mcp_refresh_tokens_session_active_uq"
    ON "mcp_refresh_tokens" ("session_id")
    WHERE "consumed_at" IS NULL;
```

没有它，两个并发刷新可以各自读到「当前这代」并各自签出新 token——同一会话
同时存在两个有效 refresh token，重放检测随即失去意义。应用层的
`SELECT … FOR UPDATE` 只保护**同一条**行，保护不了「只该有一条」这个集合约束。

### 10.6 复用而非新建

| 需求 | 用现有的 | 不改 |
|---|---|---|
| 「用户授权了某 client」 | `mcp_grants` | 表结构已够（`client_id` / `scopes` / `resource` / `epoch`） |
| 设备凭据 | `mcp_devices` | 不动 |
| 审计事件 | `auth_events`（`event_type` 加新值，不加列） | 复用 |
| Desktop 登录态 | `auth_sessions` | **零改动** |
| Desktop 登录事务 / 授权码 | `oauth_transactions` / `oauth_codes` | **零改动、不复用** |

### 10.7 表清单（迁移 `0003` 的全部内容，1.3.1-A 已落地）

| # | 表 | 状态 |
|---|---|---|
| 1 | `mcp_oauth_clients` | 新建 |
| 2 | `mcp_auth_requests` | 新建 |
| 3 | `mcp_auth_codes` | 新建 |
| 4 | `mcp_sessions` | 新建 |
| 5 | `mcp_refresh_tokens` | 新建 |

**没有第 6 张。** 浏览器会话是 Cookie，不建表（§5.3）。

### 10.8 1.3.1-A 落地时的三处收紧

三处都是**在同一方向上收紧**，没有放宽任何一条设计语义。

| # | 设计稿写法 | 落地写法 | 为什么 |
|---|---|---|---|
| 1 | `CHECK array_length(redirect_uris,1) BETWEEN 1 AND 5` | `CHECK cardinality(redirect_uris) BETWEEN 1 AND 5` | `array_length` 对**空数组**返回 `NULL`，而 CHECK 遇 `NULL` 视为通过 —— 空 `redirect_uris` 会被静默放行，客户端永远匹配不上任何回调 |
| 2 | 「`consumed_at IS NULL` 是当前这代」 | 追加部分唯一索引 `UNIQUE(session_id) WHERE consumed_at IS NULL` | 见 §10.5：这是**集合**级不变量，行锁保护不了 |
| 3 | 未提 `client_id` 外键 | **`mcp_auth_requests` / `mcp_auth_codes` / `mcp_sessions` 的 `client_id` 一律不建外键** | 见下 |

**为什么 `client_id` 不建外键**（这是本阶段唯一一个需要论证的「不做」）：

1. `mcp_grants.client_id` 本来就没有外键，而它才是**授权的权威记录**。
   只在新表上建外键会造出「grant 不受约束、session 受约束」的不一致。
2. `mcp_oauth_clients` 是**注册缓存**不是归属主体：CIMD 元数据会重新抓取、
   预注册项可以下线、DCR 项可以清理，而已经发生的授权不该因此消失。
3. 两个现成选项都更糟：`ON DELETE CASCADE` 会在删除 client 时连带删掉
   授权码与会话（正是「为了方便扩大级联」）；`ON DELETE RESTRICT` 会让
   客户端下线必须先手工按顺序清理，且对历史 grant 无解。

真正需要的完整性是「session 的 `client_id` 与它的 grant 一致」——那是一条
**跨列**不变量，要复合外键指向 `mcp_grants(user_id, client_id, resource)`，
代价远大于收益，由应用层在同一次写入里保证。

**外键清单（0003 实际建了 6 条）**：

| 子表.列 | 父表 | ON DELETE |
|---|---|---|
| `mcp_auth_requests.user_id` | `users(id)` | CASCADE |
| `mcp_auth_codes.user_id` | `users(id)` | CASCADE |
| `mcp_auth_codes.grant_id` | `mcp_grants(id)` | CASCADE |
| `mcp_sessions.user_id` | `users(id)` | CASCADE |
| `mcp_sessions.grant_id` | `mcp_grants(id)` | CASCADE |
| `mcp_refresh_tokens.session_id` | `mcp_sessions(id)` | CASCADE |

**`mcp_refresh_tokens.replaced_by` 无外键**：轮换链允许独立清理（与
`auth_sessions.replaced_by` 同理）；加外键会让「删除某一代」变成连锁操作。

**撤销 ≠ 删除**（本阶段最容易含糊的一点）：

| 动作 | SQL | 影响 |
|---|---|---|
| 撤销 grant | `UPDATE mcp_grants SET revoked_at = now()` | **不动** sessions（应用层另发 `UPDATE mcp_sessions SET revoked_at`） |
| 删除 grant | `DELETE FROM mcp_grants` | 级联删 sessions 与 auth_codes |
| 轮换 refresh | `UPDATE mcp_refresh_tokens SET consumed_at` | 旧行**保留**，不删 |
| 删除 session | `DELETE FROM mcp_sessions` | 级联删该 session 的全部 refresh 代 |

---

## 11. Phase 1.3 拆分

### 11.1 Phase 1.3.1 — MCP OAuth 基础设施（1.3.0-R1 重排）

顺序即依赖，不可并行。

> **1.3.1-A 已交付第 1 条**（迁移 `0003` 五张表 + Drizzle schema + 42 条约束测试）。
> **1.3.1-B 已交付第 2–3 条**（`src/mcp-oauth/sessions.ts`：签发 / 轮换 / 重放 /
> 90 天绝对期限 / 撤销族，42 条服务层测试）。
> **1.3.1-C1 已交付第 4 条与第 5 条的基础设施**（`tokens.ts` 的 `signMcpAccessToken`
> / `verifyMcpAccessToken`、`browser-session.ts` 的签名 Cookie、`constants.ts`）；
> 并修掉 Session 创建与 Grant 撤销的竞态（`createMcpSession` 对 Grant 行加
> `FOR UPDATE`）。
> **1.3.1-C2a 已交付第 6–7 条**（`/mcp/oauth/authorize`、`/login`、
> `/callback/:provider`），并在 C2b 里补齐了四处回归（首次进入 login 的
> Cookie 建立、Provider 错误映射、旧 State 删除竞态、State 原子消费条件）。
> **1.3.1-C2b 已交付第 8 条**（`GET/POST /mcp/oauth/consent`：CSRF、Step-up、
> Grant upsert、授权码签发、在线 Grant 同步），实现要点见 §5.10。
> 余下第 9–15 条（token endpoint、revoke、discovery、CIMD、DCR）属 **C3**，
> 尚未实现。详见路线图 §3.8–§3.10 与索引 §19–§21。

| # | 范围 | 验收 |
|---|---|---|
| 1 | 迁移 `0003_mcp_oauth`：**五张新表**（§10.7） | 幂等；现有 6 张表 `information_schema` 逐列不变；`auth_sessions` 零改动 |
| 2 | `mcp_refresh_tokens` 服务：签发 / 轮换 / 消费 / 重放 | §9.9 的 A1–A8 全绿；`absolute_expires_at` 无任何 UPDATE 路径 |
| 3 | `mcp_sessions` 生命周期：建 / 撤销 / 过期判定 | §9.11 矩阵逐行；`sid` 跨 5 次刷新不变 |
| 4 | `signMcpAccessToken` / `verifyMcpAccessToken` | `aud` 双向隔离；`sid` 稳定；`scope` = issued ∩ grant |
| 5 | `MCP_BROWSER_SESSION_KEY` + 签名 Cookie 工具 | 未配置密钥时 `/mcp/*` 拒绝启动；篡改 Cookie 读回 `false`（§5.3 实测） |
| 6 | `/mcp/oauth/authorize`：校验 + 建 `mcp_auth_requests` + 签发 Cookie | `redirect_uri` 精确匹配；PKCE 强制 S256；`resource` 逐字符 |
| 7 | `/mcp/oauth/login` + `/mcp/oauth/callback/:provider` | **MCP 专用回调**；TOFU 绑定；`findOrCreateUserWithIdentity` 建新用户；`provider_consumed_at` 一次性 |
| 8 | `GET/POST /mcp/oauth/consent`（HTML，无前端框架） | 4 个 scope 逐项 + 可取消；显示 `client_name` 与 `redirect_uri` host；CSRF；拒绝走 `access_denied` |
| 9 | `/mcp/oauth/token` 两分支 | code 一次性 + 60s；refresh 轮换；§9.10 矩阵 |
| 10 | `/mcp/oauth/revoke` | 只撤 session，不撤 grant（§9.11 第 1 行） |
| 11 | CIMD 严格抓取器 | SSRF 用例全绿（私网/回环/重定向/超大/超时/非 JSON） |
| 12 | PRM（root + path-inserted）与 AS 元数据 | `issuer` 与 URL 逐字符一致；`code_challenge_methods_supported` 存在；`authorization_response_iss_parameter_supported: true`；401 challenge **不带** `scope` |
| 13 | `/mcp/oauth/register`（DCR，**默认关闭**） | 开关关闭时元数据不出现 `registration_endpoint` |
| 14 | 与 Desktop 登录隔离 | `/oauth/authorize` 非 127.0.0.1 仍 400；MCP token 打 `/auth/me` → 401；Desktop token 打 `/mcp` → 401；Cookie 不出现在 `/auth/*` |
| 15 | sweep 扩展 | 过期 `mcp_auth_requests` / `mcp_auth_codes` / 过期 refresh 行被清理；**不删** active session |

**第 6–9 条是 1.3.0-R1 新增的核心工作量**（1.3.0 的版本把它们当成
「复用 `/auth/*`」一笔带过，实际是从零建）。

**不含**：`/mcp` 端点、工具、step-up 的 403 触发点（需 `/mcp`）、ChatGPT。

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

| 组 | 主题 | 条数（目标） | 归属 | 阻断级别 |
|---|---|---|---|---|
| A | OAuth 授权码：PKCE / 一次性 / 60s / `redirect_uri` 精确 | ≥ 14 | 1.3.1 | 发布阻断 |
| B | Refresh 轮换 / 重放 / 宽限 / 并发（§9.10 矩阵） | ≥ 14 | 1.3.1 | 发布阻断 |
| B2 | **90 天绝对期限（§9.9 的 A1–A8）** | ≥ 8 | 1.3.1 | 发布阻断 |
| B3 | **刷新后旧 Access Token 仍有效 / `sid` 不变** | ≥ 6 | 1.3.1 | 发布阻断 |
| C | Token 隔离（双向 `aud`） | ≥ 6 | 1.3.1 | 发布阻断 |
| C2 | **浏览器 Cookie**：签名 / `Path` / `HttpOnly` / `SameSite` / TTL / 篡改 | ≥ 10 | 1.3.1 | 发布阻断 |
| C3 | **Consent 闭环**：未登录→登录→同意；拒绝；全不选；过期；绑定不匹配；CSRF | ≥ 14 | 1.3.1 | 发布阻断 |
| C4 | **首次用户**：库中无此用户 → 走完 12 步后 `users` 新增 1 行、`mcp_grants` 1 行 | ≥ 3 | 1.3.1 | 发布阻断 |
| D | Grant 回查与撤销传播 | ≥ 10 | 1.3.2 | 发布阻断 |
| E | Session ↔ Grant ↔ Desktop 登录三方隔离（§9.11 矩阵） | ≥ 16 | 1.3.1 | 发布阻断 |
| F | Discovery（PRM / AS 元数据 / `iss` / 路径规则 / 401 无 `scope`） | ≥ 12 | 1.3.1 | 发布阻断 |
| G | CIMD SSRF（私网 / 回环 / 重定向 / 大小 / 超时 / 非 JSON） | ≥ 10 | 1.3.1 | 发布阻断 |
| H | DCR（开关 / 限额 / redirect 约束） | ≥ 6 | 1.3.1 | 非阻断（默认关闭） |
| I | Streamable HTTP 协议面（`-32020`/`-32022`/`-32601`/405/403/202） | ≥ 16 | 1.3.2 | 发布阻断 |
| J | 双时代（modern + legacy 各一遍） | ≥ 8 | 1.3.2 | 发布阻断 |
| K | 工具面一致性（8 个 schema 深度相等） | ≥ 3 | 1.3.2 | 发布阻断 |
| K2 | **最小权限**：仅 `records:read` 调 `list_beans` → 403 + `scope="coffee:read"`；`tools/list` 返回过滤子集 | ≥ 6 | 1.3.2 | 发布阻断 |
| K3 | **Step-up**：403 → 重新 authorize → 新 token → 重试成功；不要求重授已授予项 | ≥ 6 | 1.3.2 | 发布阻断 |
| L | `jti` 不误杀（ST-25/26 回归） | ≥ 4 | 1.3.2 | 发布阻断 |
| M | 日志安全（哨兵参数 grep 0 命中；Cookie/code/refresh 不入日志） | ≥ 5 | 1.3.1 + 1.3.2 | 发布阻断 |
| N | 真实客户端（ChatGPT / Inspector） | ≥ 6 | 1.3.3 | 发布阻断（G1–G5） |

合计目标 **≥ 186 条**（1.3.0 是 ≥ 110）。1.3.1 承担 **≥ 93 条**，
其中 C2/C3/C4/E 四组共 ≥ 43 条是 1.3.0-R1 新识别出来的工作量。

---

## 13. 与现有文档/代码的差异表（1.3.0 + 1.3.0-R1 修订项）

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
| D10 | 路线图 C10：「按 OQ-3 结论落地」 | 已定 | 改为「`mcp_sessions` + `mcp_refresh_tokens`」 |

**1.3.0-R1 追加（都是 1.3.0 自身的错，不是更早文档的错）**：

| # | 1.3.0 的说法 | 实际 | 处理 |
|---|---|---|---|
| R1 | §5.1 时序：「用户登录（复用 `/auth/*`）」 | **Cloud 没有任何 Cookie，`/auth/*` 全是 Bearer**（§1.5 B1/B3） | 新建浏览器授权流程：签名 Cookie + `mcp_auth_requests` + MCP 专用 Provider 回调 + consent 页 |
| R2 | §15 端点表：无 `/mcp/oauth/login`、`/mcp/oauth/consent` | 没有它们，登录与同意两步无处安放 | 补 4 条路由（§5.2） |
| R3 | §9：`mcp_sessions` 存 `refresh_token_hash`，每次 refresh 新建 session | ① `created_at` 重置 → 90 天无限续命；② `sid` 变化 → 正常刷新打挂未过期的 Access Token | 拆成 `mcp_sessions`（身份，不可变）+ `mcp_refresh_tokens`（每代凭据） |
| R4 | §9.5：「轮换失败不延长 expires_at；绝对上限锚 created_at」——但写法仍靠 session 行重建 | 逻辑上不可能成立（行被重建就没有「锚」） | `absolute_expires_at` 变成**不可变列**，并有 A8 的 grep 断言 |
| R5 | §10：四张新表 | 缺授权请求表与 refresh 代表 | **五张**（§10.7） |
| R6 | §5.4：401 challenge 带全部 4 个 scope | 等于默认索要全部数据权限 | 401 **省略** `scope`；403 只给缺的那一个；consent 页可逐项取消（§5.8） |
| R7 | §5.4：未定义 `tools/list` 是否需要 scope | 若要求，只授 `records:read` 的客户端看不到可 step-up 的工具 | `tools/list` 不要业务 scope，返回按 grant 过滤的子集（§5.8.1） |
| R8 | §9.5：「refresh 的宽限窗口」未说明客户端能否恢复 | 任务书明确：不能把「不撤族」写成「可恢复」 | 新增 §9.10.1：**v1 不做幂等恢复**，并列出两种替代方案的代价 |
| R9 | §10：`mcp_sessions.scope` 语义含糊（是请求的还是授予的） | token 的 scope 必须能追溯到「用户勾了什么」 | 改名 `issued_scope`，并定义 `effective = token.scope ∩ grant.scopes`（§9.7） |

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
| N9 | ChatGPT 在被 403 `insufficient_scope` 后是否真的会做 step-up | 若不做，用户在同意页取消勾选会导致工具「永久不可用」而非「提示补授权」 | 1.3.3 |
| N10 | ChatGPT 是否接受 consent 页是可交互的 HTML 表单（而非仅 302 自动批准） | 若它要求「无交互授权」，则须改为「登录后自动同意」——那会牺牲最小权限 | 1.3.3（高危） |
| N11 | ChatGPT 的注册回调是否允许非 `localhost` 的 `https` `redirect_uri` | 若只允许 localhost，第三方 MCP 的 OAuth 模式无法成立 | 1.3.3（高危） |

**三个高危项**：

- **N5**：若 ChatGPT 不发 `resource`，而规范要求「客户端 MUST 发送、服务端
  MUST 校验」，则严格校验会直接导致连不上。选择只能是（a）保持严格、接受
  连不上；（b）**仅当** `resource` 缺失时按 `client_id` 的预注册值补全并记
  审计。**本阶段不预决**，列为 1.3.3 第一优先。
- **N10**：本设计假设 consent 是**用户可见、可交互**的一页。若真实客户端
  只接受「静默批准」，最小权限就失去落点（用户无法取消勾选）。
- **N11**：`redirect_uri` 若被限制为 `localhost`，第三方 MCP 的 OAuth 模式
  在结构上不成立——那时只能退回「预注册 + 手动粘贴 token」，不再是 OAuth。

---

## 15. 1.3.1 下一阶段实施计划（可直接开工，1.3.0-R1 重排）

### 15.1 顺序（不可并行，每步有独立验收才能进下一步）

```
1. ✅ 迁移 0003（五张表）+ schema + 幂等测试 + information_schema 快照比对
      ↓  ← 1.3.1-A 已交付；部分唯一索引就位后，「当前这代」才有确定答案
2. ✅ mcp_refresh_tokens 服务（签发 / 轮换 / 消费 / 重放）+ 集成测试
      ↓  ← 90 天模型在这里定死（A1–A8），后面才可能「不续命」
3. ✅ mcp_sessions 服务（create / revoke / 过期判定 / issued_scope）
      ↓  ← sid 稳定性在这里定死（B3）
4. ✅ signMcpAccessToken / verifyMcpAccessToken + 双向 aud 隔离
      ↓
5. ✅ MCP_BROWSER_SESSION_KEY + 签名 Cookie 工具 + 篡改用例
      ↓  ← 没有它，authorize 无法绑定浏览器
6. ✅ /mcp/oauth/authorize（校验 + mcp_auth_requests + Set-Cookie + 分流）
      ↓
7. ✅ /mcp/oauth/login + /mcp/oauth/callback/:provider（复用 adapter + 建用户）
      ↓
8. GET/POST /mcp/oauth/consent（HTML + CSRF + scope 收窄）
      ↓  ← 到这里"新用户第一次接入"才第一次可端到端跑（C4）
9. /mcp/oauth/token（authorization_code → 建 session + 第一代 refresh）
      ↓
10. refresh_token 分支（轮换 / 重放 / 宽限）
      ↓
11. /mcp/oauth/revoke + PRM/AS 元数据 + CIMD 抓取器 + DCR（默认关）
      ↓
12. sweep 扩展 + §9.11 矩阵 + 全量回归（Cloud 557 → 只增不减）
```

**为什么 2 在 3 之前**：`mcp_sessions` 的 `absolute_expires_at` 语义由
「refresh 如何被夹住」定义。先做 token 层，session 层才有一句话能说清的不变量；
反过来写会变成「先建一张表，再想办法让它不被改写」。

### 15.2 文件落点（预计）

```
cloud/src/db/migrations/0003_mcp_oauth.sql
cloud/src/db/schema.ts                        （+5 表，不动现有）
cloud/src/mcp-oauth/sessions.ts               （session + refresh token 两层）
cloud/src/mcp-oauth/tokens.ts                 （sign/verifyMcpAccessToken）
cloud/src/mcp-oauth/browser-session.ts        （签名 Cookie + 绑定哈希）
cloud/src/mcp-oauth/authorize.ts              （authorize + login + callback）
cloud/src/mcp-oauth/consent.ts                （GET/POST consent，HTML 渲染）
cloud/src/mcp-oauth/token-endpoint.ts         （code / refresh 两分支 + revoke）
cloud/src/mcp-oauth/discovery.ts              （PRM / AS 元数据 / WWW-Authenticate）
cloud/src/mcp-oauth/cimd.ts                   （严格抓取器，先不接路由）
cloud/src/mcp-oauth/clients.ts                （预注册 + DCR + CIMD 统一解析）
cloud/src/mcp-oauth/routes.ts                 （挂载）
cloud/tests/mcp-oauth/*.test.ts
```

**新增 env（1 条）**：`MCP_BROWSER_SESSION_KEY`（≥32 字节）。
未配置时 `/mcp/*` 路由不注册并记 `error` 级日志（而不是静默生成临时密钥——
那会让重启后所有进行中的授权失效且难以排查）。

### 15.3 明确不做（1.3.1）

`POST /mcp`、任何工具、`server/discover`、step-up 的 403 触发点、
ChatGPT 联调、写工具、多实例、Redis、`auth_sessions` 改动、
Desktop 代码改动、`oauth_transactions` / `oauth_codes` 的任何修改。

### 15.4 门禁

```bash
cd cloud && pnpm typecheck && pnpm lint && pnpm test && pnpm build
cd Desktop && pnpm typecheck && pnpm test   # 确认零连带影响
```

必须保持：

- 现有 Cloud 测试全绿（**557 → 只增不减**）；Desktop **1265** 不变；
- `auth_sessions` 的 `information_schema` 快照逐列相同；
- 现有 `/oauth/*` 的 9 条身份路由响应体逐字节不变；
- `grep -c "UPDATE mcp_sessions" cloud/src/mcp-oauth/` 里没有任何一条
  触碰 `absolute_expires_at`（A8 的静态判据）。

---

## 16. 术语对照（避免旧文档用词漂移）

| 旧词 | 新词 | 说明 |
|---|---|---|
| MCP 会话 / `Mcp-Session-Id` | **协议层会话（已移除）** | 2026-07-28 不再有；我们也不生成 |
| session（安全文档里） | **`mcp_sessions`（OAuth 会话）** | 指长期授权身份；**不是** refresh 容器 |
| refresh 容器 | **`mcp_refresh_tokens`（每代）** | 一代一个 hash；轮换只动这一层 |
| session 的 `scope` | **`issued_scope`** | 用户实际授予的；与 token 的 `scope` 求交集后才生效 |
| 「用户登录」 | **浏览器授权会话（`bp_mcp_bs` Cookie）** | 30 分钟、仅 `/mcp/oauth` 路径、不是登录态 |
| HTTP+SSE 传输 | **已弃用的旧传输** | 2024-11-05；不实现 |
| `initialize` | **legacy 时代握手** | modern 时代不存在 |
| SSE 长连接 | **`subscriptions/listen`** | 2026-07-28 的通知流机制；本阶段不做 |
| DCR（必做） | **DCR（兼容，默认关闭）** | 已弃用 |
| 「刷新失败可以重试恢复」 | **不能恢复，需重新授权** | 见 §9.10.1 |

---

## 17. 本阶段（1.3.0-R1）的验收自查

| # | 任务书要求 | 落点 |
|---|---|---|
| 1 | 浏览器登录与 Consent 的完整流程图 | §5.0 十二步表 + §5.1 时序图 |
| 2 | 新增路由及职责表 | §5.2 |
| 3 | Browser Session 与 Authorization Transaction 安全模型 | §5.3（Cookie 属性）+ §5.4（三层绑定）+ §5.5（清理） |
| 4 | OAuth Session 与 Refresh Token Generation 数据模型 | §9.3（ER）+ §10.4 / §10.5（表） |
| 5 | Access Token 在 Refresh 后的行为 | §9.6 五条 + §9.7（交集） |
| 6 | 90 天绝对生命周期验证方案 | §9.9 的 A1–A8 |
| 7 | Refresh 并发 / 响应丢失 / 重放行为矩阵 | §9.10 + §9.10.1 |
| 8 | 四种 Scope 的最小权限策略 | §5.8（含 401 省略 scope / consent 收窄 / 403 精确 / step-up） |
| 9 | 修改文件清单 | 见 §18 |
| 10 | 更新后的 Phase 1.3.1 实施任务表 | §11.1（15 条）+ §15.1（12 步） |
| — | **关键问题**：新用户第一次接入如何走完 | **§5.0**（12 步，含「新用户在第 8 步创建」） |

**本阶段能否宣告通过**：§5.0 的 12 步每一格都有明确的表/路由/函数落点，
且 §1.5 的八条事实共同证明「复用 `/auth/*`」这条路不存在、必须新建。
因此**流程已有明确答案**。

---

## 18. 本阶段（1.3.0-R1）修改的文件

| 文件 | 修订 |
|---|---|
| `REMOTE_MCP_PHASE_1_3_DESIGN.md` | §1.5 新增（真实代码事实）；§5 全文重写（浏览器登录 + consent + 最小权限）；§8.1/8.2 更新 claims 与 ER；§9 全文重写（两层模型 + 90 天 + 并发矩阵）；§10 重写（五张表）；§11.1 重排（15 条）；§12 扩展（19 组，≥186 条）；§13 追加 R1–R9；§14 追加 N9–N11；§15 重排（12 步）；§16 更新术语；§17/§18 新增 |
| `REMOTE_MCP_PHASES_ROADMAP.md` | §3.1 C3/C10；§3.2 路由组；§3.3 测试要求；§3.4 门禁 |
| `REMOTE_MCP_PROTOCOL_LIFECYCLE.md` | §15 端点表（新增 login / consent）；§15.1 三层要求 |
| `REMOTE_MCP_SECURITY.md` | §3.2 末（两层模型 + 浏览器 Cookie 边界） |
| `REMOTE_MCP_SECURITY_OPERATIONS.md` | §4.1 撤销矩阵；§4.1.7 新增（浏览器授权会话的安全边界） |
| `REMOTE_MCP_INDEX.md` | §16（1.3.0-R1 修订摘要） |

**未改动**：`cloud/src/**`、`Desktop/src/**`、`cloud/src/db/migrations/`、
`auth_sessions`、任何依赖版本。
