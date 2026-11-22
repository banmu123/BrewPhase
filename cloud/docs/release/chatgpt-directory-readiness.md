# ChatGPT Plugins Directory 上架就绪审计（Phase 1.3.3-A-R4）

> 日期：2026-11-22 · 分支 `feature/remote-mcp` · 基线 `cd899d6`
> **性质：只读审计 + 文档。本轮不改 OAuth 协议、不改 Discovery 能力声明、
> 不做生产部署、不提交 OpenAI 审核。**
>
> 状态取值：`PASS` / `FAIL` / `NOT VERIFIED` / `NOT APPLICABLE`
>
> 判定原则：**只写代码里能指到行号的事实**。凡是需要真实 ChatGPT 才能确认的，
> 一律 `NOT VERIFIED`，不用 Inspector 的通过结果代替。

---

## 0. 一句话结论

协议层（Discovery、resource、aud、PKCE、redirect_uri、Scope）**已具备上架的
技术前提**；真正的差距集中在三处：

1. **客户端注册路径未定**——服务端 CIMD 已接入但**未声明能力**，DCR 未实现，
   目前唯一可用的是**预注册**（`FAIL` for CIMD-ready，见 §2）；
2. **工具级 OAuth 触发缺失**——没有 `securitySchemes` / oauth2 scope，
   也没有 `_meta["mcp/www_authenticate"]`，不能假定 ChatGPT 会自动弹授权（`FAIL`）；
3. **目录素材与合规页面未就绪**——Privacy Policy 仍描述「无账号体系」，
   Terms 缺失，Demo 环境未建（`FAIL`）。

---

## 1. MCP Server（§6.1）

| 检查项 | 结论 | 证据 |
|---|---|---|
| 公网 HTTPS | `NOT VERIFIED` | 本地 `BASE_URL=http://127.0.0.1:3000`；生产**强制** https（`cloud/src/env.ts:297-298`「BASE_URL must be an explicitly set https URL in production」）。**尚未部署生产**，故线上 HTTPS 未实测。 |
| MCP endpoint 稳定 | `PASS`（本地） | `POST /mcp`；`cloud/src/routes/mcp-http.ts:161` 起注册 GET/DELETE/POST，OPTIONS 独立路由 |
| PRM 正确 | `PASS` | 根形式与 `/mcp` 变体返回**同一份**文档（`cloud/src/routes/mcp-discovery.ts:23-26`）；字段 `resource` / `authorization_servers` / `scopes_supported` / `bearer_methods_supported`（`cloud/src/mcp-oauth/discovery.ts:55-69`）；`resource` = `<baseUrl>/mcp`（`constants.ts:88-90`） |
| AS Metadata 正确 | `PASS` | `discovery.ts:74-90`：issuer / authorize / token / revoke 同源同协议；`response_types:["code"]`；`grant_types:["authorization_code","refresh_token"]`；`token_endpoint_auth_methods:["none"]`；`code_challenge_methods:["S256"]`；`authorization_response_iss_parameter_supported:true` |
| `resource` 贯穿 authorize 与 token | `PASS` | authorize 逐字符校验（`authorize-flow.ts:165-168`）；token 必填 + 比对（`routes/mcp-oauth.ts:1360,1362-1365`）；兑换再与授权码行比对（`token-flow.ts:166`）；refresh 与 session 比对（`sessions.ts:482-489`）；每次 `/mcp` 回查（`mcp-http/authorize.ts:153,178`） |
| Token `aud` 与 Resource 精确匹配 | `PASS` | 签发 `.setAudience(options.resource)`（`tokens.ts:111`）；校验 `jwtVerify({ issuer, audience: options.resource })`（`tokens.ts:168-175`）；`resource` 同源于 `mcpResourceFor(baseUrl)` |
| PKCE 强制 S256 | `PASS` | `codeChallengeMethod !== "S256"` 即拒（`authorize-flow.ts:156-159`）；challenge 必须 43 位 base64url（`:35,161-163`）；DB CHECK `= 'S256'`（`schema.ts:480-481`）；AS 元数据只声明 `["S256"]`（`discovery.ts:87`）；兑换侧只做 SHA-256 比较（`security/crypto.ts:38-46`） |

**协议层小结：`PASS`（本地）。生产 HTTPS 部署：`NOT VERIFIED`。**

---

## 2. ChatGPT Client Registration（§6.2）

### 2.1 三条路径的现状

| 路径 | 结论 | 证据 |
|---|---|---|
| **预注册 OAuth Client** | `PASS`（唯一当前可用） | 判定顺序第 2-3 步：按 `client_id` 精确查 `mcp_oauth_clients`，命中 `pre_registered` 即用（`cimd-registry.ts:469-486`）。本地已有 `mcp-inspector-cli` 行（`redirect_uris = http://127.0.0.1:6276/oauth/callback`）。 |
| **CIMD（服务端实现）** | `PASS`（已接入授权链路） | `GET /mcp/oauth/authorize` 步骤 1 调 `resolveClientForAuthorize`（`routes/mcp-oauth.ts:397`）；URL 形态 client_id 走 DNS-pinned 抓取并 INSERT `registrationSource:'cimd'`（`cimd-registry.ts:497-507`、`cimd.ts:898-1015`） |
| **CIMD（能力声明）** | **`FAIL`** | AS Metadata **不声明** `client_id_metadata_document_supported`（`discovery.ts:42-53` 接口无该字段、`:74-90` 返回无该键；不声明理由 `:17-18`、`cimd.ts:12-13`）。**按路线图，声明必须排在真实客户端联调之后单独提交**（`REMOTE_MCP_INDEX.md` 3B-3 节、设计 `:1323`），本轮禁区明确禁止提前打开。 |
| **DCR** | **`FAIL`（未实现）** | `grep "oauth/register"` 在 `cloud/src` **0 命中**；`POST /mcp/oauth/register` → 404（负向测试 `tests/mcp-oauth/discovery.test.ts:209-213`）；`discovery.ts` 不声明 `registration_endpoint`。`registration_source='dcr'` 只是 schema 允许的取值，没有创建路径。 |

> ⚠️ **注意一处代码与注释不一致**：`cimd-registry.ts:21` 文件头仍写
> 「**不**接入 `/mcp/oauth/authorize` 路由（那是 C3c-3B-3）」，但该路由
> **已经调用**它（`routes/mcp-oauth.ts:397`）。这是过期注释，与 R4 的
> 「修正过期注释」同类，**建议下一轮顺手修**（本轮未改，避免扩大改动面）。

### 2.2 ChatGPT CIMD `client_id` 能否解析

`client_id` 形如 `https://chatgpt.com/connector/oauth/{callback_id}` 时：

- 是 absolute URL、scheme `https`、authority 非空、无 userinfo、端口缺省（443）、
  路径非 `/`、无 query / fragment / 反斜杠 / 点段 → **通过**
  `validateClientIdentifierUrl`（`cimd.ts:238-284`，逐条规则见 `:245-275`）；
- 不会命中 trusted 标识（trusted 只含 `baseUrl` / `mcpResource` /
  `mcpTrustedPeerIdentifiers`，`cimd-registry.ts:436-438`），因此**不会被误判成身份冲突**；
- 若库中无该行 → 走网络抓取：必须 200 + `application/json`
  （`cimd.ts:973-987`），SSRF 拒绝（`:946-950`），并做 DNS pinning。

**结论：服务端能解析 ChatGPT 的 URL 形态 client_id —— `PASS`（代码路径）。
但因为能力未声明（上表 `FAIL`），ChatGPT 是否会走这条路 = `NOT VERIFIED`。**

### 2.3 `redirect_uris` 与 callback-id 模式

- 抓取到的 `redirect_uris`：1–5 条、去重、每条过 `validateRedirectUri`
  （`cimd.ts:762-775`、规则 `:602-636`）：**只允许 https（http 仅回环）、
  禁止通配 `*`、禁止 fragment、禁止 userinfo、禁止反斜杠、必须绝对 URL**；
- 授权时**逐字符相等**比对（`authorize-flow.ts:144-148`），不做前缀、不做
  URL 规范化；兑换时再比一次（`token-flow.ts:165`）；
- **因此**：`https://chatgpt.com/connector/oauth/{callback_id}` 只要出现在该
  client 的 CIMD 文档（或预注册行）的 `redirect_uris` 里，就能被合法接受；
  通配 redirect_uri **不可能**被接受（`validateRedirectUri` 直接拒 `*`）；
- **不硬编码共用 callback_id**：Cloud 侧没有任何写死的 callback_id，
  `redirect_uris` 完全来自注册数据。

> **实际生产回调 URI 应以 OpenAI 插件管理界面显示的值为准**——上面是
> 「给定该值后服务端能否接受」的代码结论，不是对 OpenAI 当前实际值的确认。

**状态：`PASS`（校验规则）/ `NOT VERIFIED`（OpenAI 实际给出的 URI）。**

---

## 3. OAuth 认证 UI 触发（§6.3）

这是**与 OpenAI 集成最可能卡住**的一块。逐项：

| 检查项 | 结论 | 证据 |
|---|---|---|
| per-tool `securitySchemes` | **`FAIL`（缺失）** | `grep securitySchemes` 全仓库 **0 命中**；`tools/list` 不返回任何安全方案声明 |
| per-tool `oauth2` Scope | **`FAIL`（缺失）** | 8 个工具注册只有 `annotations`，无 scope 声明（`handler.ts:124-130`）；scope 只存在于 PRM `scopes_supported`（`discovery.ts:64`）与同意页文案 |
| 工具调用失败时的 `_meta["mcp/www_authenticate"]` | **`FAIL`（缺失）** | `grep www_authenticate` 全仓库 **0 命中**；`grep _meta` 业务代码 0 命中（只在 drizzle migration snapshot 里） |
| HTTP `WWW-Authenticate` 401 challenge | `PASS` | `Bearer resource_metadata="<prm-url>"`（`mcp-http/authorize.ts:66-69`），**不带 `scope`**；产生点 `:116,128,156`，输出 `routes/mcp-http.ts:92-94,218` |
| HTTP `WWW-Authenticate` 403 insufficient_scope | `PASS` | `Bearer error="insufficient_scope", scope="<缺的那一个>", resource_metadata="…"`（`authorize.ts:71-77`），只报缺的**一个**；输出 `routes/mcp-http.ts:222-226` |
| grant 回查失败的 403 | `PASS` | `Bearer error="invalid_token", resource_metadata="…"`（`authorize.ts:79-82`） |
| 工具回调内的第二道 scope 检查 | `PASS` | `SCOPE_DENIED` → `isError` 结果（`handler.ts:148-156`），fail-closed |

**关键判断（任务书明确要求）：**

> **不能因为返回 HTTP 401 就认定 ChatGPT 一定会自动打开授权界面。**

现状是：`/mcp` 的 401/403 **只在 HTTP 头**给 challenge；`tools/list` 里没有任何
OAuth 元数据。OpenAI 的工具级 linking UI 若依赖 `securitySchemes` 或
工具结果里的 `_meta["mcp/www_authenticate"]`，**当前实现不会触发**。

**状态：`FAIL`（需修改）——但修改方案涉及工具面契约，属下一轮范围，
本轮禁区禁止改动。**

### 已实现 / 需修改 / 已在 Inspector 验证 / 仍需真实 ChatGPT 验证

| 类别 | 内容 |
|---|---|
| **已实现** | PRM、AS Metadata、`resource` 双端校验、`aud` 精确匹配、PKCE S256 强制、预注册 client、CIMD 服务端抓取与逐字符 redirect_uri、401/403 challenge、8 个只读工具、scope 逐 grant 校验、consent 页 |
| **需要修改** | ① 工具级 `securitySchemes` + oauth2 scope；② 工具失败时的 `_meta["mcp/www_authenticate"]`；③（上架前）声明 `client_id_metadata_document_supported` **或**走预注册；④（可选）实现 DCR |
| **已在 Inspector 验证** | 真实 OAuth 全流程（authorize → login → consent → 302 → token 200 → `/mcp` 200 → `tools/list` 8 工具）、Discovery 双端点、双时代协议（modern `server/discover` + legacy `initialize`）、Scope 403 边界、R2 408 / OPTIONS 隔离 |
| **仍需真实 ChatGPT 验证** | CIMD 是否被触发、授权 UI 是否自动弹出、callback-id 形态 redirect_uri 实际值、`resource` 是否发送、refresh 行为、`tools/call` 真实数据返回、撤销/离线语义 |

---

## 4. Tool annotations（§6.4）

8 个工具**全部**由同一个注册函数装配（`cloud/src/mcp-http/handler.ts:124-130`）：

```ts
server.registerTool(tool.name, {
  description: tool.description,
  inputSchema: tool.input,
  annotations: { readOnlyHint: true },   // ← 唯一字段
}, …)
```

| 工具 | scope | `readOnlyHint` | `openWorldHint` | `destructiveHint` |
|---|---|---|---|---|
| `search_records` | `records:read` | `true` | 未设置 | 未设置 |
| `get_record` | `records:read` | `true` | 未设置 | 未设置 |
| `list_record_tags` | `tags:read` | `true` | 未设置 | 未设置 |
| `list_beans` | `coffee:read` | `true` | 未设置 | 未设置 |
| `list_brews` | `coffee:read` | `true` | 未设置 | 未设置 |
| `list_tastings` | `coffee:read` | `true` | 未设置 | 未设置 |
| `list_canvases` | `canvas:read` | `true` | 未设置 | 未设置 |
| `get_canvas` | `canvas:read` | `true` | 未设置 | 未设置 |

- **`openWorldHint`：全仓库 0 命中**（Cloud 与 Desktop 都没有）。
- **`destructiveHint`：只出现在 Desktop 的写工具**（`records.ts:14`、
  `canvas.ts:13`、`work-context.ts:14`、`personal-direction.ts:17`，
  均为 `{ readOnlyHint:false, destructiveHint:false, idempotentHint:true }`），
  **这 8 个只读工具不使用它**。
- Desktop stdio 侧同样只给 `{ readOnlyHint: true }`
  （`Desktop/src/mcp/tools/records.ts:13`、`coffee.ts:13`、`canvas.ts:12`），
  **两侧一致**。
- 一致性由 `tests/mcp-http/schema.test.ts:38-76` 钉住（数量 8、description、
  schema、scope、Desktop `write=false`），**但该测试不比较 annotations**
  （`grep annotation` 在 `cloud/tests` 0 命中）。

### 注解是否符合真实业务行为

- `readOnlyHint: true` —— **符合**。8 个工具在 Cloud 侧只进
  `dispatchToolCall` 读路径，`REMOTE_TOOLS` 明确排除写工具
  （`tools.ts:26-31` 注释：写工具需要 DPoP 发送者约束，本阶段不开放）。
- `openWorldHint` **未设置**（默认 `false`）。语义是「是否访问宿主之外的
  外部实体」。BrewPhase 读的是**用户自己本机**的数据，经 Cloud 转发但
  数据源仍是用户自己的 Desktop——**不属于 open world**，默认 `false` 合理。
  ⚠️ 但这是**推断**，未与 OpenAI 的扫描口径核对 → `NOT VERIFIED`。
- `destructiveHint` **未设置**。只读工具不设置是允许的（`readOnlyHint:true`
  已蕴含非破坏）。**没有为了通过扫描而虚假标注**——没有把任何工具标成
  `destructiveHint:false` + `readOnlyHint:false` 这种矛盾组合。

**状态：`PASS`（与真实行为一致、未造假）；`openWorldHint` 口径 `NOT VERIFIED`。**

---

## 5. ChatGPT callback（§6.5）

| 检查项 | 结论 | 证据 |
|---|---|---|
| 客户端 CIMD metadata 含真实 callback URL | `NOT VERIFIED` | 取决于 OpenAI 实际下发的文档；服务端会抓取并校验（`cimd.ts:898-1015`），但**本轮未拿到真实 ChatGPT 文档** |
| Cloud 逐字符验证 `redirect_uri` | `PASS` | `authorize-flow.ts:144-148`（`registered === redirectUri`）+ 兑换二次比对 `token-flow.ts:165` |
| CSP `form-action` 能放行该次已验证回调 Origin | `PASS`（代码路径） | 同意页 CSP 用 `authPageHeaders({ formActionOrigin: redirectOrigin })`（`routes/mcp-oauth.ts:857`），`redirectOrigin` 来自 `originOf(redirectUri)`（`consent-flow.ts:264-276`），再过 `cspFormActionSource` 白名单（`login-page.ts`，round-trip + 字符双闸）。`https://chatgpt.com/connector/oauth/{id}` 的 Origin 是 `https://chatgpt.com`，属纯 Origin → **会被放行** |
| 不使用通配 redirect_uri | `PASS` | `validateRedirectUri` 遇 `*` 直接拒（`cimd.ts:606`）；`cspFormActionSource` 遇通配/非纯 Origin 退回 `'self'`（fail-closed） |
| 不硬编码共用 callback_id | `PASS` | Cloud 无任何硬编码 callback_id；`redirect_uris` 全部来自注册数据 |

> **历史坑（R1 已修，记录在此以免重犯）**：同意页原 CSP 只写
> `form-action 'self'`，而 Chromium 把它套用到表单提交后的 302 上——
> 跨 Origin 回调被中止成 `net::ERR_ABORTED`，**授权码签发了却到不了客户端**。
> 现已放行**本次已验证的回调 Origin**。若 ChatGPT 上线时授权卡在 consent
> 页不跳转，**先查这一行**，不要去怀疑 token 或 PKCE。

---

## 6. 公开目录上架准备清单

| 项目 | 当前状态 | 说明 / 下一步 |
|---|---|---|
| Plugin 名称 | `PASS` | BrewPhase |
| Plugin 类型 | 待产品决策 | With MCP / MCP-only（本表按任务书占位） |
| MCP Endpoint | `NOT VERIFIED` | 需生产 `BASE_URL` + `/mcp`；本地为 `http://127.0.0.1:3000/mcp`，**未部署** |
| Server 类型 | 待产品决策 | Universal |
| Developer Identity | `NOT VERIFIED` | 需确认 OpenAI Platform 个人或企业认证 |
| OAuth | `NOT VERIFIED` | 本地 Inspector 已通；**ChatGPT 未实测** |
| Domain Verification | `NOT VERIFIED` | 待 OpenAI Portal 验证 |
| Logo | `NOT APPLICABLE`（本轮） | 待确定正式发布素材；页面内品牌标是内联 SVG，非发布素材 |
| 简短描述 | 待准备 | 产品定位：**BrewPhase — Your Personal Data Workspace** |
| 完整描述 | 待准备 | 见 §6.1 要点（只读、8 工具、数据在本机） |
| Website URL | `NOT VERIFIED` | 待确定正式地址 |
| Privacy Policy URL | **`FAIL`** | 现有政策仍描述「不注册、不登录、无账号体系、核心功能无网络请求」，与 Cloud OAuth / Remote MCP **不一致**；且 `Tools/Privacy-Compliance-Report.md:43-49` 记录 `…/privacy.html` 当前 **404（Pages 未启用）**。详见 `docs/privacy-gap.md` |
| Terms URL | **`FAIL`** | 未找到独立公开页面；**不得虚构条款**，也不得标记为发布就绪 |
| Support URL | `PASS`（初始） | GitHub Issues 可作初始支持入口 |
| Starter Prompts | 待准备 | — |
| Positive Tests | 待准备 | **≥ 5 条** |
| Negative Tests | 待准备 | **≥ 3 条** |
| Demo Account | 待准备 | 见 §7 |
| Demo Desktop | 待准备 | 见 §7 |

### 6.1 上架描述可用的技术要点（已核实）

- 只读：8 个工具（`search_records`、`get_record`、`list_record_tags`、
  `list_beans`、`list_brews`、`list_tastings`、`list_canvases`、`get_canvas`），
  无任何写/删能力；
- 数据在用户自己的 BrewPhase Desktop 本地，**Cloud 不持久化业务数据**
  （13 张表全为身份/会话/设备/授权/审计，`cloud/src/db/schema.ts`）；
- 工具调用的**请求与响应经 Cloud 转发**，但**不落盘**
  （`forwarder.ts:1027-1039` 只进内存 registry；日志不记 arguments/结果正文
  `handler.ts:62-66,193`）；
- Desktop 离线时远程读取返回 `DEVICE_OFFLINE`（非超时、非空结果）；
- 授权由用户逐项勾选，最小权限 scope，可随时撤销。

---

## 7. Demo 环境特别要求

OpenAI 审核需要**能完成真实认证与真实调用**的测试环境。BrewPhase 的数据在
Desktop 本地，因此 Demo 必须单独设计：

| 要求 | 现状 | 需要做什么 |
|---|---|---|
| 专门的审核测试账号 | `NOT VERIFIED` | 建立独立 Google/GitHub 账号用于审核，**不复用开发者私人账号** |
| 单独的 Desktop 测试环境 | `NOT VERIFIED` | 独立的 userData 目录 / 独立设备，与开发者本机隔离 |
| 专门的非敏感测试数据 | `NOT VERIFIED` | 预置记录 / 咖啡豆 / 画布样本，**不含任何个人数据** |
| 审核期间稳定在线的设备 | `NOT VERIFIED` | 需要一台持续运行的 Demo Desktop；R2 已让 WSS 能连上（`connection_count` 0→1），但**长期在线未验证** |
| 不依赖私人局域网 | `NOT VERIFIED` | Demo Desktop 必须在公网可达的 Cloud 上注册（当前本地 Cloud 仅 loopback） |
| 无额外人工验证码 | `NOT VERIFIED` | 审核流程中不得要求人工输入验证码 |

**隔离红线**：Demo Desktop 必须与开发者真实个人数据**完全隔离**——
独立账号、独立设备凭据、独立数据集。当前开发者的设备
`2951ba0a`（绑定私人账号）**不得**作为 Demo 设备。

---

## 8. 待办（按依赖顺序）

1. **下一轮可做（协议面，需单独授权）**
   - 工具级 `securitySchemes` + oauth2 scope + `_meta["mcp/www_authenticate"]`
     —— 决定 ChatGPT 是否自动弹授权（§3 `FAIL`）；
   - `openWorldHint` 口径核对；
   - 修正 `cimd-registry.ts:21` 过期注释（§2.1 注）。
2. **上架前必须完成（非协议）**
   - Privacy Policy 重写（`docs/privacy-gap.md` 已列出章节）；
   - Terms 页面；
   - 生产 HTTPS 部署 + Domain Verification；
   - Demo 账号 / Desktop / 数据集；
   - ≥5 Positive、≥3 Negative 测试用例。
3. **真实 ChatGPT 验证（唯一能给出 `PASS` 的途径）**
   - CIMD 触发、授权 UI、callback 实际值、`resource`、refresh、
     `tools/call` 真实数据、撤销、离线。
