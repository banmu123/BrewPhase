# BrewPhase Remote MCP — 架构（Phase 1.0 设计，1.0.1 / 1.0.2 / 1.0.3 修订）

> 状态：**设计阶段**，无功能代码。基线 `feature/remote-mcp` @ `89866cd`。
> 修订：**Phase 1.0.1 — Architecture & Protocol Hardening**、
> **Phase 1.0.2**、**Phase 1.0.3 Final Consistency**（均 2026-11-17）。
> 本文的每条现状结论都对应真实文件与行号；凡未验证的一律标「待确认」，
> 凡需产品决策或无法从代码判定的标 `OPEN QUESTION`。
> 协议见 `REMOTE_MCP_PROTOCOL.md`，安全见 `REMOTE_MCP_SECURITY.md`，
> 实施排期见 `REMOTE_MCP_PHASES.md`。

## 0.0 Phase 1.0.3 修订摘要（本文）

| # | 修订点 | 原因 |
|---|---|---|
| 1 | §6.10 重写为**三条依赖的准确性质**（硬依赖 / 条件依赖 / 硬依赖）+ 「Mock 通过 ≠ 集成通过」的架构论证 | 原文说「可并行」，但没说「两次 Mock 通过不等于端到端」；不加这条，阶段报告必然被夸大 |
| 2 | §6.5.8 补充**审计计数器是进程内状态**（重启归零 ≠ 历史补齐） | 架构层要明确「审计可观测性」不跨重启，否则会被当成持久保证 |
| 3 | §8 关系表补充 `claim_secret` 的传输约束（POST 请求体，不入 URL） | 与协议 §3.4 / 安全 §3.1 对齐 |
| 4 | §7.4 明确「时间术语」为跨文档统一项（Unix epoch vs monotonic） | 「单调 epoch 毫秒」这类混合术语是实现歧义的来源 |

## 0.0.1 Phase 1.0.2 修订摘要（保留）

| # | 修订点 | 原因 |
|---|---|---|
| 1 | §6.5.5 审计改为**三段状态分离 + best-effort 承诺**，并明确「不得声称审计完整」 | 原文只写「查询不因审计失败而失败」，未定义承诺边界 |
| 2 | §6.5.8 新增**分期范围**（1.1B 只告警 / 1.4 才评估熔断） | 熔断是 OQ-5，不能被顺手实现 |
| 3 | §3.8 新增**身份生命周期与阶段依赖**（指向安全 §2.6） | 设备/用户/grant 三层身份此前只在安全文档里，架构层缺一张总图 |
| 4 | §6.10 新增**阶段依赖的架构含义**（1.1A 是纯重构、1.1B/1.2 可并行的前提） | 「1.2 依赖 1.1」与「可并行」的矛盾在架构层也要消掉 |
| 5 | §7.3 OQ 总表扩到 22 项，新增 OQ-13/14/15 与 S7/S8 的**五级状态** | 原文用「待执行 / 待联调」两种状态，无法区分「方案已设计」与「已跑通」 |

## 0.0.2 Phase 1.0.1 修订摘要（保留）

| # | 修订点 | 原因 |
|---|---|---|
| 1 | 新增 §6.5 共享 Tool Execution Layer，取代「给 `HANDLERS` 加 `export` 直接调用」 | 直接调用会绕过 Zod/scope/错误映射/审计，且把 `RouterContext` 的 `clients` 依赖带进 Remote |
| 2 | §6.3 设备表更名 `mcp_devices` | Desktop 本地已有 `devices` 表（LAN 配对，`schema.ts:318`），同名会造成语义混淆 |
| 3 | §1.4 / §6.5 记录 handler 的**同步性**实测结论 | 决定取消、single-flight、超时的正确形态（见协议 §8） |
| 4 | §6.5 / §8 审计改为 1.1A/1.1B **方案 A**（不改库结构） | `mcp_operation_log.client_id` 无外键无 CHECK，`remote:<device_id>` 合法（`migrations.ts` 的 `MCP_ACCESS_SQL`） |
| 5 | §7.1 增加 B6（JWT `aud` 硬编码）、B7（`session_kind` 不存在） | Phase 1.0 文档误以为可直接复用 JWT 与 session 分类 |
| 6 | §6.7 原则 10 改为「本地开关优先，Cloud 状态可最终一致」 | 原表述要求 Cloud 先撤销，网络失败时会让本地关闭失效 |

## 0. 一句话结论

现有 Local MCP 的**业务面已经可以直接复用**（27 个工具、13 个只读、统一的
`TOOL_DEFINITIONS` 与 `*ForMcp` 服务方法），但 Cloud 侧**没有任何一块能直接承载
Remote MCP**：没有设备模型、没有标准 OAuth 授权服务器、没有 WebSocket 承载能力。
因此 Remote MCP 的工程量集中在「Cloud 新增 Gateway + Desktop 新增出站 Agent」，
不在「重写业务查询」。

---

## 1. 审计：Local MCP

### 1.1 实现位置与协议

| 项 | 事实 | 位置 |
|---|---|---|
| 入口 | `McpServer` + `StdioServerTransport` | `Desktop/src/mcp/stdio.ts:2-3, 87-98` |
| SDK | `@modelcontextprotocol/server` `^2.4.0` | `Desktop/package.json` |
| 协议版本 | `LATEST_PROTOCOL_VERSION` = **`2026-07-28`**（与现有 `MCP_ARCHITECTURE.md` 的「2026-07-28 spec」一致）。其余可接受版本由 SDK 常量 `SUPPORTED_PROTOCOL_VERSIONS` 决定，**待运行时确认**（源码中以压缩形式定义，未静态读取） | `node_modules/@modelcontextprotocol/server/dist` |
| 传输 | AI 客户端 ↔ MCP 进程：**STDIO JSON-RPC**；MCP 进程 ↔ Main：**本地 socket + NDJSON** | `stdio.ts:97`、`bridge-client.ts:53-73` |
| 构建 | 独立 Vite 配置打成单文件 `out/mcp/stdio.mjs`（911 kB），只 external `node:*` | `Desktop/vite.mcp.config.ts` |
| 打包校验 | `scripts/verify-mcp-runtime.mjs` | `package.json` → `verify:mcp-runtime` |

**关键点**：MCP 进程是**纯转发器**。`stdio.ts:12-22` 的注释与代码一致——
进程内不 import `better-sqlite3`、不打开 `brewphase.db`、不碰媒体目录。

### 1.2 工具注册机制

三层单一事实来源：

```
Desktop/src/shared/mcp/tool-schemas.ts   ← 名称 + 描述 + Zod schema + scope + write
        ├── src/mcp/tools/*.ts           ← 用 TOOL_DEFINITIONS 注册（仅 5 个注册函数）
        └── src/main/mcp-bridge/request-router.ts  ← 用同一份 schema 二次校验
```

`src/mcp/tools/` 共 6 个文件、614 行，其中 `respond.ts`(33 行) 是统一响应包装，
其余 5 个各含一个 `register*Tools()`。**没有任何业务逻辑**——所有 handler 都是
`respond(bridge, '<tool>', args)`。

### 1.3 工具清单（实测 27 个，13 个只读）

| Scope | 数量 | 工具 |
|---|---|---|
| `records:read` | 2 | `search_records`、`get_record` |
| `tags:read` | 1 | `list_record_tags` |
| `records:create` | 1 | `create_record` |
| `records:update` | 1 | `update_record` |
| `tags:create` | 1 | `create_tag` |
| `coffee:read` | 5 | `list_beans`、`get_bean`、`list_brews`、`list_tastings`、`get_coffee_summary` |
| `canvas:read` | 2 | `list_canvases`、`get_canvas` |
| `canvas:write` | 5 | `create_canvas`、`add_record_to_canvas`、`create_canvas_note`、`update_canvas_note`、`annotate_canvas_node` |
| `work_context:read` | 2 | `list_work_contexts`、`get_work_context` |
| `work_context:create` / `update` / `link` | 1 / 1 / 1 | `create_work_context`、`update_work_context`、`link_work_context_resource` |
| `direction:read` | 1 | `get_direction_overview` |
| `direction:propose` | 3 | `propose_current_state`、`propose_direction`、`propose_stage_goal` |

**任务书第六阶段列的 8 个候选工具全部已存在**，无缺失项：

| 任务书工具 | 现状 | 复用可行性 |
|---|---|---|
| `search_records` | 已有，`limit ≤ 50` | 直接复用 |
| `get_record` | 已有 | 直接复用 |
| `list_record_tags` | 已有 | 直接复用 |
| `list_beans` | 已有，`limit ≤ 100` | 直接复用 |
| `list_brews` | 已有，支持 `bean_id` / `since_ms` | 直接复用 |
| `list_tastings` | 已有 | 直接复用 |
| `list_canvases` | 已有 | 直接复用 |
| `get_canvas` | 已有 | 直接复用 |

### 1.4 业务服务与数据所有权

```
BridgeServer (Main)
   └─ routeBridgeRequest (request-router.ts:344)
        ├─ ctx.clients.authenticate          ← 查 mcp_clients
        ├─ definition.input.safeParse        ← Zod 二次校验
        ├─ HANDLERS[toolName]                ← 27 个 handler，1 行调用
        └─ Application Service
             records / coffee / canvas / workContexts / personalDirection
                └─ Repository（事务 + change_log + 外键）
                     └─ SQLite（唯一所有者：Electron Main）
```

- 统一 Application Service 层：**存在**，`src/main/application/` 下 6 个域。
- MCP 专用投影方法：`searchForMcp` / `getForMcp` / `listBeansForMcp` /
  `listBrewsForMcp` / `listCoffeSummaryForMcp` / `listForMcp` / `getForMcp`
  等，命名统一为 `*ForMcp`（`coffee-service.ts`、`record-service.ts`、`canvas-service.ts`）。
  它们只做 **DTO 投影与分页**，不复制查询。
- **MCP 不可能绕过业务服务直接读库**：MCP 进程没有 DB 句柄；socket 上只接受
  `method: 'tools.call'` 且 `request.tool in TOOL_DEFINITIONS`
  （`request-router.ts:350-355`）。不存在 SQL/文件/命令通道。
- 敏感字段已在 DTO 层剥离：`beanDto()` 解构掉 `imagePath`，只给 `has_image`
  （`coffee-service.ts` 的 `function beanDto`）；`get_canvas` 只给笔画元数据、
  不给点集与路径。

**Phase 1.0.1 补充实测（决定共享执行层能否成立）**：

| 事实 | 证据 | 影响 |
|---|---|---|
| 27 个 handler **全部同步**（`type ToolHandler = (ctx, params) => HandlerResult`，返回非 Promise） | `request-router.ts:41`，`HANDLERS` 体内 `await` 出现 **0** 次 | 执行不可中断；取消只能「不开始」或「丢弃结果」 |
| handler 体内 **不使用** `ctx.clients`（0 次）与 `ctx.db`（0 次），只用 5 个 service | 对 `HANDLERS` 区段文本统计 | 执行层可以只依赖 5 个 service，**不需要** Local 的认证对象 |
| 5 个 service 全部同步（`async`/`await` 各 0 次） | `coffee-service.ts` / `record-service.ts` / `canvas-service.ts` | better-sqlite3 同步语义，无 DB 竞态 |
| `mcp_operation_log.client_id` 是 `TEXT NOT NULL`，**无外键、无 CHECK、无长度约束** | `migrations.ts` 的 `MCP_ACCESS_SQL`；`schema.ts:365-379` | `remote:<device_id>` 写入合法（审计方案 A 的前提） |
| 审计只覆盖**写**工具（`if (definition.write)`） | `request-router.ts:420, 431, 446` | Remote 全为只读，若照搬则**一行审计都不会产生**——必须按 channel 分别定义策略 |

### 1.5 Scope 与权限检查位置

- Scope 枚举：14 个，唯一来源 `Desktop/src/shared/contracts/mcp.ts:11-28`。
- 工具→scope 映射写在 `TOOL_DEFINITIONS[].scope`。
- **校验只在 Main**：`request-router.ts:365-376`。MCP 进程侧不做权限判断
  （`MCP_SECURITY.md` §1 明确「即使做了也只是 UX 过滤」）。
- 检查顺序固定：协议版本 → method → tool 白名单 → token → scope → Zod → 幂等 → Service。

### 1.6 审计与幂等

| 机制 | 事实 | 位置 |
|---|---|---|
| 审计表 | `mcp_operation_log`，**只写工具**（`if (definition.write)`），不记参数 | `request-router.ts:420-439`、`audit-log.ts:24-43` |
| 失败审计 | 权限失败 / 参数失败 / 业务失败均写 | `request-router.ts:367-389, 444-454` |
| 幂等表 | `mcp_idempotency`，主键 `(client_id, idempotency_key)` | `schema.ts:386-398` |
| 摘要 | `sha256(canonicalJson(params))`，不存原文 | `audit-log.ts:96-107` |
| 冲突 | 同 key 不同摘要 → `IDEMPOTENCY_KEY_REUSE` | `request-router.ts:399-408` |

---

## 2. 审计：MCP Bridge

### 2.1 进程结构与生命周期

**不是独立进程**——Bridge 跑在 Electron Main 内（`index.ts:270-278` 直接
`new BridgeServer(...)` 后 `start()`）。生命周期：

```
start: mkdir mcp/ (0700) → chmod 0700 → 探测既有 socket
       → 活的不动（throw，单实例锁下不该发生）/ 死的 unlink
       → bind → chmod socket 0600 → 原子写 bridge-info.json
stop:  断开所有连接 → server.close → unlink socket → unlink info
崩溃:  下次 start 的 probeSocket 负责清理（bridge-server.ts:167-179）
```

### 2.2 IPC 方式

| 平台 | 路径 | 权限 |
|---|---|---|
| macOS / Linux | `<userData>/mcp/bridge.sock` | 目录 0700 / socket 0600 |
| Windows | `\\.\pipe\brewphase-mcp-v1-<sha256(userData)[:12]>` | Node 默认 pipe ACL（当前用户 / SYSTEM / Administrators） |

`bridge-contract.ts:16` 有硬约束注释：**绝不退化为监听 TCP**。

帧格式：NDJSON，单行 ≤ 1 MB（`BRIDGE_MAX_LINE_BYTES`），`requestId` 由客户端生成、
响应原样带回；**一请求一连接**（`bridge-client.ts:53-73`），结构上排除响应错配。

### 2.3 Token 生命周期

| 阶段 | 实现 |
|---|---|
| 生成 | `bp_mcp_` + `randomBytes(32).base64url`（`permission-service.ts:55`） |
| 存储 | 仅 `sha256(token)` hex（`:62`） |
| 传递 | 只走 MCP 进程环境变量 `BREWPHASE_MCP_TOKEN`；**禁止命令行参数**（`stdio.ts:20`） |
| 校验 | **每请求查库，无进程内缓存**（`:93-110`），撤销立即生效 |
| 撤销 | 置 `revoked_at`；不主动断开既有 socket，但下一请求即 `UNAUTHORIZED` |
| 展示 | 创建响应返回一次（`mcpClientCreatedSchema.token`） |

### 2.4 超时、异常与取消

| 项 | 现状 |
|---|---|
| 客户端超时 | 硬编码 30s（`bridge-client.ts:30`） |
| 服务端超时 | **无**。`routeBridgeRequest` 是同步调用，handler 阻塞即整条连接阻塞 |
| 取消 | **无**。无 cancel 帧，AI 侧断开只导致写响应失败 |
| 异常边界 | 路由抛错 → `INTERNAL_ERROR`，原文只进 `console.error`（`request-router.ts:148-156`） |
| 错误信息 | 只对 `ApplicationError` 透传 message，其余统一文案（`:555-558`） |

这三项（无 deadline、无取消、单连接串行阻塞）在本地场景可接受，**远程场景必须补**。

### 2.5 平台支持

`platformSupportsBridge()` 返回 darwin / linux / win32 全支持
（`bridge-contract.ts:78-81`）。注释里「Windows V1 未验证」已过期——`MCP_ARCHITECTURE.md`
头部写的是 2026-11-12 起支持 Windows Named Pipe。

### 2.6 是否具备安全接入远程请求的能力

**不具备，而且不应该具备。** Bridge 监听的是本地文件系统 socket / Named Pipe，
没有网络面——这是正确设计。远程接入必须通过**新增的出站 WSS 客户端**把请求
带进来，而不是给 Bridge 开端口。**不能因为做 Remote 而给 Bridge 加 TCP 监听或
放宽路径权限。**

---

## 3. 审计：Cloud 账号与 OAuth

基线：`cloud/` 已在 `feature/remote-mcp` 工作区（67 个文件）。

### 3.1 技术栈与路由

| 项 | 事实 |
|---|---|
| 框架 | Hono `^4.10.3` + `@hono/node-server` `^1.14.4` |
| 数据库 | PostgreSQL，`drizzle-orm` `^0.45.4` + `postgres` `^3.4.7` |
| JWT | `jose` `^6.1.0`（`src/sessions/jwt.ts`） |
| 校验 | `zod` `^4.6.7` |
| 启动 | `serve({ fetch: app.fetch, port })`（`src/index.ts`） |

**全部 9 条 HTTP 路由**（`src/routes/`）：

```
GET  /health
GET  /ready
GET  /oauth/authorize
GET  /oauth/callback/:provider
POST /oauth/token
POST /auth/refresh
POST /auth/logout
GET  /auth/me
GET  /auth/identities
```

**没有** `/mcp`、`/mcp-devices`、`/ws`、`/.well-known/*`。

### 3.2 OAuth 流程完整性

| 环节 | 实现 | 位置 |
|---|---|---|
| 双 State | Client State（Desktop 生成，只存哈希）+ Provider State（Cloud 生成，只存哈希），后者形如 `<providerState>.<clientState>` | `oauth/state.ts:21, 62` |
| PKCE | **只接受 S256**，challenge 固定 43 字符 | `oauth/authorization.ts:16, 41-44` |
| 授权码 | 一次性，60s，只存 SHA-256，`SELECT ... FOR UPDATE` + 条件 UPDATE 原子消费 | `oauth/token-exchange.ts:43-110` |
| 失败处理 | 任何校验失败**立即删除授权码**（防穷举） | `token-exchange.ts:96-102` |
| 会话 | Access JWT 900s + Refresh 30 天 | `env.ts` 默认值 |
| 轮换 | Refresh Token Rotation + token family，重用即整族撤销 | `sessions/session-service.ts` |
| 凭证存储 | refresh token 只存 `sha256(pepper + token)`；IP 只存 pepper 哈希 | `db/schema.ts` |

OAuth 流程本身**完整且实现质量高**，但它是一个**专用的第一方登录流程**，
不是标准 OAuth 2.1 授权服务器。

### 3.3 决定性限制（必须先看清）

**`redirect_uri` 被硬编码白名单为 `http://127.0.0.1:<port>/callback`**

```ts
// cloud/src/security/crypto.ts:51-56
/** 只允许 Desktop 的本机回调形态：http://127.0.0.1:<port>/callback */
export function isValidLocalCallbackUri(redirectUri: string): boolean
```

```ts
// cloud/src/oauth/authorization.ts:47-49
if (!redirectUri || !isValidLocalCallbackUri(redirectUri)) {
  throw invalidRequest("redirect_uri must be http://127.0.0.1:<port>/callback");
}
```

ChatGPT 作为 MCP Client 时，`redirect_uri` 指向 OpenAI 的域名。**当前 `/oauth/authorize`
在第一步就会 400。** 这不是配置问题，是验证函数的语义。

第二个不顺配点：`/oauth/token` **没有 `grant_type` 字段**
（`routes/body.ts:51-55` 的 `tokenRequestSchema` 只有 `code` / `code_verifier` /
`redirect_uri`），刷新走独立的 `/auth/refresh`（JSON `{refresh_token}`）。
标准 MCP OAuth 客户端按 `grant_type=authorization_code|refresh_token` 对接，
会直接失败。

### 3.4 用户身份存储

| 实体 | 说明 | 位置 |
|---|---|---|
| `users` | `id`(uuid) / `status`(active\|suspended\|deleted) / `display_name` / `avatar_url` | `db/schema.ts` |
| `user_identities` | `(provider, provider_subject)` 唯一；**邮箱不是身份锚点，同邮箱绝不自动合并** | 同上 |
| `auth_sessions` | `user_id` / `refresh_token_hash` / `token_family` / `device_id`(预留) / `ip_hash` / `replaced_by` | 同上 |
| `auth_events` | `event_type` / `user_id` / `ip_hash` / `detail`(jsonb) | 同上 |

`access` token 不落库（无状态 JWT），这是对的。

### 3.5 设备关联模型：**不存在**

```ts
// db/schema.ts:82（auth_sessions 内）
// 设备管理预留（本阶段不实现），允许为空
deviceId: uuid("device_id"),
```

写入侧证据：`sessionMetaFromRequest()` 只填 `userAgent` 与 `ipHash`，
**从不设置 `deviceId`**（`routes/body.ts:43-49`）；`session-service.ts:50` 只是把
`meta.deviceId ?? null` 原样落库，而上游永远给 `undefined`。

结论：

- 无设备注册接口
- 无设备状态（online/offline）概念
- 无设备撤销能力
- 无 user ↔ desktop device 关联表

**Remote MCP 的设备体系必须从零建，不能「复用现有 device_id 列」当既成事实。**

**命名注意（Phase 1.0.1）**：Desktop **本地** SQLite 已有一张 `devices` 表
（`schema.ts:318-333`：`id/name/kind/public_key/token_hash/paired_at/last_seen_at/
last_sync_at/revoked_at`），但它是 **LAN Sync 的 iOS 配对设备**，与 Cloud 身份
无关，且当前 `public_key` 默认空串（说明该列只在协议层预留，未真正参与验证）。
因此：

- Cloud 侧新表命名 **`mcp_devices`**，路由前缀 `/mcp-devices`
- Desktop 侧**不新增设备表**：Remote 的设备就是本机自己，身份放在
  `userData/remote/device.json`（与 `account/credentials.json` 同级的独立文件）

### 3.6 能否区分「Cloud 登录授权」与「MCP 数据访问授权」

**不能。** 现有模型里没有任何 scope / grant / consent 概念：

- `auth_sessions` 没有 `scopes` 列，**也没有 `session_kind`**（见 B7）
- 授权码不携带 scope
- JWT claims 固定为 `sub/sid/iss/aud/iat/exp/jti`，**无 scope**（`sessions/jwt.ts:52-62`）
- `/auth/me` 返回的用户资料就是全部可见性

所以「我允许 ChatGPT 读我的冲煮记录，但不允许读画布」这类授权**无处表达**。

### 3.7 Desktop 如何识别当前登录用户

`Desktop/src/main/account/`（4 个模块，合并前在 `feature/auth-electron`）：

| 模块 | 职责 |
|---|---|
| `credentials.ts` | `safeStorage` 密文落盘，外层只 `{version, alg, payload}`；加密不可用则**拒绝落盘**，绝不退化明文 |
| `oauth-callback-server.ts` | `listen(127.0.0.1, 0)`，只 `GET /callback`，Host 校验防 rebinding，state 常量时间比对 |
| `cloud-client.ts` | 注入 `FetchLike`、每请求 `AbortController` 超时、`redirect:'manual'`；错误只带 kind/status/serverCode |
| `account-service.ts` | 唯一状态机：generation 丢过期异步结果、refresh 单飞、**网络失败 ≠ 会话失效**（只有 401 才清凭据） |

铁律（已在代码与文档里写死）：

- **Cloud 登录不是 Desktop 本地功能的前置条件**。`restore()` 读盘失败只当未登录，
  不阻塞启动；本地库零新增表、零迁移。
- 凭据在 `userData/account/`，**不是**业务数据目录——换数据目录不复制、退出只删这一个文件。
- Renderer 只拿 `AccountSnapshot`（无 Token）。
- `signOut()` 先清本地再尽力撤销服务端（服务端挂了也能退出）。

### 3.8 五个身份的层次（Phase 1.0.2 新增，权威定义在安全 §2.6）

架构层必须能一眼看出「谁是谁」，否则就会出现「撤销设备时顺手撤了 grant」
「登出时顺手删了设备」这类事故：

```
┌─ I1 Cloud 用户身份 ─────────────────────────────────────┐
│  refresh token · account/credentials.json · auth_sessions │
│  「你是谁」                                                │
└───────────────────────────┬──────────────────────────────┘
                            │ 用户主动登录（浏览器）
                            ▼
┌─ I4 MCP Client grant ────────────────────────────────────┐
│  mcp_grants · {user_id, client_id, scopes, resource}      │
│  「哪个 AI 能读什么」——属于用户，**不挂在设备上**           │
└───────────────────────────┬──────────────────────────────┘
                            │ 转发时校验（每次）
                            ▼
┌─ I3 Cloud 设备注册关系 ───────────────────────────────────┐
│  mcp_devices · {user_id, public_key, status}              │
│  「这台机器的公钥属于哪个账号」——可以被撤销，但不撤 grant    │
└───────────────────────────┬──────────────────────────────┘
                            │ 握手时校验（每次连接）
                            ▼
┌─ I2 Desktop 设备身份 ─────────────────────────────────────┐
│  Ed25519 私钥 + device_token + **boundUserId**            │
│  remote/device.json · 「这台机器有这把钥匙」               │
│  boundUserId 不匹配当前登录用户 → 强制 blocked（不继承）    │
└───────────────────────────┬──────────────────────────────┘
                            │ 出站连接
                            ▼
┌─ I5 WSS 连接 ─────────────────────────────────────────────┐
│  connection_id · 内存 only · 「此刻这条链路」              │
└───────────────────────────────────────────────────────────┘
```

三条不可混用的规则：

1. **I4 与 I3 正交**：撤销设备不撤 grant；撤销 grant 不断设备。
2. **I2 可跨会话保留，但不可跨用户继承**：`boundUserId` 是阻断点。
3. **I5 是唯一决定「在不在线」的东西**：它不持久化，也不由任何一方上报。

完整的五个生命周期场景（登出 / 用户切换 / 关开关 / 忘记设备 / 轮换）
见 `REMOTE_MCP_SECURITY.md` §2.6；协议侧的实现约束见
`REMOTE_MCP_PROTOCOL.md` §11。

---

## 4. 审计：Desktop 数据与同步

### 4.1 SQLite 结构与核心模型

Drizzle + `better-sqlite3 ^13`，迁移是**数组 + `user_version`**，当前
**13 个版本**（`src/main/database/migrations.ts:594-606`）。35 张表。

**任务书里点名的实体名与现实不一致，必须先纠正**：

| 任务书写的 | 实际存在 | 说明 |
|---|---|---|
| `Coffee` | `beans` | 豆子；烘焙信息**内嵌**（`roast_level` / `roast_date`），无独立烘焙实体 |
| `RoastBatch` | **不存在** | 没有批次概念，一次烘焙就是 `beans` 的一行 |
| `Bag` | **不存在** | 无包装/分装实体；库存直接是 `beans.remaining_g` |
| `BrewLog` | `brews` | 冲煮记录（配方参数 + 评分 + 风味标签） |
| `TastingRecord` | `tastings` | 品鉴；`brew_id` 可空，可为镜像记录或手记 |
| `Records` | `records` | **不是冲煮日志**，是「收藏/记录」载体：`link` / `image` / `video` / `text` |
| `Tags` | `record_tags` + `record_tag_links` | 多对多 |
| `Canvas` | `canvases` / `canvas_nodes` / `canvas_notes` / `canvas_strokes` | 节点是摆放实例 |

完整核心表：`beans`、`brews`、`tastings`、`phase_rules`、`phase_reminders`、
`records`、`record_metadata`、`record_tags`、`record_tag_links`、`canvases`、
`canvas_nodes`、`canvas_strokes`、`canvas_notes`、`work_contexts`、
`work_context_resources`、`current_states`、`directions`、`stage_goals`、
`sync_meta`、`change_log`、`devices`、`local_state`、`sync_baseline`、
`sync_conflicts`、`mcp_clients`、`mcp_operation_log`、`mcp_idempotency`、
`ai_conversations`、`ai_messages`、`roundtable_panels`、`local_workspaces`、
`card_workspace_bindings`、`captured_replies`、`reply_segments`、`action_drafts`。

> 这条纠正直接影响 Remote MCP 的工具面：**不会出现 `list_roast_batches` 或
> `list_bags`**，因为数据模型里没有这两个概念。烘焙天数由 `roast_date` 现算
> （`beanDto()` 的 `days_since_roast`，无日期为 `null`，不写 0 冒充 Day 0）。

### 4.2 业务服务与数据访问层

- 服务层：`src/main/application/{records,coffee,canvas,work-context,personal-direction,authorization,...}`
- Repository：`src/main/database/repositories/*.ts`（10 个文件）
- 事务 / `change_log` / 外键 / 本地元数据播种**只在 Repository**；Service 不复制
- 媒体：`src/main/media/store.ts`，Renderer 拿到的是**文件名**，显示走
  `bpmedia://media/<name>` 自定义协议，`isSafeMediaName()` 只接受
  `^[A-Za-z0-9_-]{8,64}(_thumb)?\.(jpg|png|webp|mov|mp4|m4v)$`

### 4.3 LAN Sync（必须与 Remote MCP 严格区分）

| 项 | 事实 | 位置 |
|---|---|---|
| 传输 | 明文 HTTP，**无 TLS** | `sync/server.ts:24-31` 注释 |
| 端口 | 首选 47821，被占则回落（多网卡共用同一端口） | `sync-service.ts:27`、`server.ts:74-104` |
| 绑定 | **所有局域网地址**（不是 127.0.0.1） | `server.ts:107-144` |
| 路由 | `GET /api/status`、`POST /api/pair`、`POST /api/unpair`、`GET /api/sync/manifest`、`POST /api/sync/apply`、`POST /api/sync/wipe`、`POST /api/sync/media/manifest`、`POST /api/sync/media/chunk`、`POST /api/sync/media/finalize`、`GET /api/sync/media/offset` | `server.ts:169-319` |
| 认证 | 一次性高熵配对码（128-bit，2 分钟，只存哈希）→ 每设备独立 token（只存 sha256） | `pairing-service.ts` |
| 防重放 | 写操作要求 `timestamp + nonce + HMAC-SHA256`；`NonceStore` 有界 2048 | `sync/auth.ts:12-14, 57-78` |
| 方向 | **仅 iOS → Desktop 单向**；Desktop Canvas 编辑不回传 | `SYNC_PROTOCOL.md` |
| 数据落点 | 本机 SQLite，与 Cloud 无关 | — |

**三个概念不能混**：

```
Local MCP  = 本机 AI 客户端 → 本机数据（socket）
LAN Sync   = 局域网 iOS ↔ Desktop（HTTP，双向协议但实现单向）
Remote MCP = 公网 AI 客户端 → 经 Cloud Gateway → 本机数据（WSS 出站）
```

Remote MCP **不经过** LAN Sync 的任何一条路由，**不复用**它的 token / 配对码，
**也不等于**「把 LAN Sync 暴露到公网」——那是明文 HTTP + 全 LAN 绑定，绝对不行。

### 4.4 是否存在 Cloud 数据同步或数据镜像

**不存在。** 证据：

- `cloud/src/db/schema.ts` 只有 6 张表，全部是身份/会话类，**没有任何业务实体表**
- schema 文件头注释：「身份与会话，业务数据永远不进云端」
- Desktop 侧无任何上传业务数据的代码路径（`src/main/account/` 只处理凭据与
  `/auth/*`、`/oauth/*` 调用）
- LAN Sync 的 `snapshot-importer.ts` 只写本机 SQLite

---

## 5. 审计：Cloud 部署能力

| 能力 | 现状 | 结论 |
|---|---|---|
| 后端框架 | Hono + `@hono/node-server` | 可承载 MCP Streamable HTTP（见 §6.2） |
| API 路由 | 9 条，全部身份类 | 需新增 `/mcp`、`/.well-known/*`、`/mcp-devices/*` |
| WebSocket / WSS | **零代码**（全仓搜 `websocket` / `upgrade` 无命中）；`serve()` 未注入 `websocket` 选项 | **不具承载能力**，需新增 |
| 反向代理 / LB | 无配置，只有 `TRUST_PROXY` / `TRUST_PROXY_HOPS` 参数 | 部署层待定，标「待确认」 |
| Redis / 共享状态 | **无依赖**（`package.json` 无 redis/ioredis） | 多实例路由不可行 |
| 限流状态 | **进程内 `Map`**（`rate-limit.ts:38`），注释自认「若水平扩容需替换为共享存储」 | 单实例假设成立 |
| 用户设备管理接口 | 无 | 需从零建 |
| 请求日志 / 审计 | `createLogger` JSON 行；请求日志只记 `method/path/status/duration`；`redact()` 按 key 正则脱敏（`token\|code\|secret\|authorization\|password\|refresh\|verifier\|nonce`） | 机制合格，需扩 MCP 事件类型 |
| 多实例连接路由 | 无 | 见 §7.3 |
| 容器 | 单容器，`USER node`，EXPOSE 3000，HEALTHCHECK `/health` | 单实例基线 |

**判断：现有 Cloud 架构不适合直接承载长连接，但不需要重构。**
它的问题是「缺少能力」而不是「架构错了」：Hono 支持升级 WS，`serve()` 预留了
`websocket` 注入点，身份与会话模型可以直接被 Gateway 消费。真正缺的是
**连接路由表的外部存储**（Redis 或 Postgres advisory/`LISTEN/NOTIFY`）。

---

## 6. Remote MCP 总体架构

### 6.1 目标架构

```
                        ChatGPT / 其他远程 MCP Client
                                    │
                                    │ HTTPS · MCP Streamable HTTP
                                    ▼
                   ┌────────────────────────────────┐
                   │  Remote MCP Gateway (Cloud)     │
                   │  · MCP 语义层（SDK createMcpHandler）
                   │  · MCP OAuth AS（独立于登录 OAuth）
                   │  · Scope 校验 + 用户身份
                   │  · 设备路由（connection registry）
                   └───────────────┬────────────────┘
                                   │ WSS（Desktop 主动出站）
                                   ▼
                   ┌────────────────────────────────┐
                   │  Desktop Remote Agent           │
                   │  src/main/remote/（新增）        │
                   │  · 设备身份（Ed25519）
                   │  · 心跳 / 重连 / 离线
                   │  · 请求准入（只读白名单 + 本地开关）
                   └───────────────┬────────────────┘
                                   │ 复用现有 BridgeServer 的 Handler 层
                                   ▼
                     Application Service（*ForMcp）
                                   │
                                   ▼
                         SQLite（本机唯一事实来源）
```

Local MCP 保持原样：

```
Codex / Claude Code / WorkBuddy
        │ STDIO
        ▼
   brewphase-mcp 进程
        │ Unix socket / Named Pipe（NDJSON）
        ▼
   BridgeServer → Application Service → SQLite
```

### 6.2 关键判断：Gateway 侧不要自己写 MCP 语义

`@modelcontextprotocol/server@2.4.0` 已导出（实测 `dist/index.d.mts` 的 export 列表）：

```
createMcpHandler                    // 通用 MCP handler
WebStandardStreamableHTTPServerTransport
PerRequestHTTPServerTransport
requireBearerAuth / verifyBearerToken / requireScopes
buildOAuthProtectedResourceMetadata / getOAuthProtectedResourceMetadataUrl
oauthMetadataResponse / hostHeaderValidationResponse / originValidationResponse
checkResourceAllowed / resourceUrlFromServerUrl
```

这意味着 **Gateway 的 MCP 协议层、Bearer 校验、保护资源元数据（RFC 9728）、
Host/Origin 校验都有现成实现**，不需要手写 JSON-RPC 生命周期与会话管理。
`cloud/` 目前不依赖该包，Phase 1.2 需新增依赖。

### 6.3 模块职责划分

| 模块 | 归属 | 职责 | 新增/复用 |
|---|---|---|---|
| MCP HTTP 端点 `/mcp` | Cloud | Streamable HTTP、会话、JSON-RPC | 新增 |
| MCP OAuth AS | Cloud | `/authorize`、`/token`、`/register`、`/.well-known/*` | **新增（不复用登录 OAuth）** |
| Grant / Consent 存储 | Cloud | 用户授权哪个 client 哪些 scope | 新增表 `mcp_grants` |
| 设备注册表 | Cloud | `mcp_devices`（user_id, public_key, status, confirm/claim 哈希, token_hash, revoked_at, last_seen_at）；注册发 `confirm_code` + 一次性 `claim_secret` | 新增表（**不叫 `devices`**，避免与 Desktop 本地 LAN 配对表同名） |
| 连接路由表 | Cloud | `connection_id → instance_id`，多实例必需 | 新增（Phase 1.2 内存 / 1.4 Redis） |
| 连接管理器 | Cloud | WSS 接入、鉴权、心跳、请求转发、超时 | 新增 |
| 工具白名单（远程） | Cloud + Desktop **双份** | 远程只读子集，两端各自校验并取交集 | 新增常量 `REMOTE_TOOLS` |
| Desktop Remote Agent | Desktop | 出站 WSS、设备身份、重连、准入 | 新增 `src/main/remote/` |
| **共享 Tool Execution Layer** | Desktop | `executeTool()`：scope → Zod → handler → 错误映射 → 审计回调；Local 与 Remote 共用 | **新增 `src/main/application/mcp-tools/`**（见 §6.5） |
| 工具执行（旧描述） | Desktop | ~~复用 `HANDLERS`~~ | 已被上一行取代 |
| 本地远程开关 | Desktop | 用户级 kill switch（持久化在 `local_state`） | 新增 |
| 审计 | Desktop（权威）+ Cloud（接入事件） | 每次远程调用落 `mcp_operation_log` | 复用表；1.1A/1.1B 用 `client_id='remote:<device_id>'`（方案 A），1.2 起 migration 14 加列 |
| Local MCP | Desktop | 行为不变（可参与执行层重构，须由现有 949 条测试证明行为等价） | 见 §6.5 |

### 6.4 数据流：一次 `search_records`

```
1. ChatGPT → POST /mcp   Authorization: Bearer <MCP access token>
2. Gateway: 验签(JWT, aud=<gateway resource>) → 取 user_id + session_id + jti
            → 查 mcp_grants 得 grant_id + scopes（JWT 里没有 scope，见 §6.5.4）
3. Gateway: scope 含 records:read ? → 否则 SCOPE_DENIED
4. Gateway: 查连接表 (user_id, device_id) → 在线? 否则 DEVICE_OFFLINE
5. Gateway → WSS: { type:"req", id:<delivery_id>, tool:"search_records", arguments, deadline_ms }
6. Desktop Agent（顺序固定，任一失败即回 res.ok=false）:
     a. 本地远程开关 on? 否则 REMOTE_DISABLED
     b. frame ≤ max_frame_bytes? 否则 REQUEST_TOO_LARGE
     c. tool ∈ effective_tools? 否则 TOOL_NOT_ALLOWED
     d. now < deadline_ms? 否则 REQUEST_TIMEOUT（不执行）
     e. executeTool(tool, arguments, { scopes, channel:'remote', audit })
        —— 与 Local 同一个执行层：Zod → handler → 错误映射 → 审计
     f. 审计行 client_id='remote:<device_id>'，**只读也记**（与 Local 只记写不同）
7. Desktop → WSS: { type:"res", id, ok:true, data }
8. Gateway → ChatGPT: tool result（structuredContent + text）
```

### 6.5 共享 Tool Execution Layer（Phase 1.0.1 定稿）

#### 6.5.1 Phase 1.0 方案的问题

Phase 1.0 写的是「给 `HANDLERS` 加一个 `export`，Remote Agent 进程内直接调用」。
这在四个点上不成立：

1. **`HANDLERS` 只做「参数 → service 调用」的映射**，Zod 校验、scope 检查、
   错误码映射、审计**全部在 `routeBridgeRequest` 里**（`request-router.ts:344-457`）。
   直接调 `HANDLERS` 等于同时绕过这四件事。
2. `HANDLERS` 的上下文类型是 `RouterContext`，含 `clients: McpClientService`
   ——那是 Local 的认证对象。把它带进 Remote 会让两条凭据域在类型层面就纠缠。
3. `routeBridgeRequest` 同步返回 `BridgeResponse`，形如 `{requestId, success, data, error}`
   ——那是 socket 线格式。Remote 需要的是 `{ok, data, error:{code,message,retryable}}`
   ——两种信封。若 Remote 拿到 `BridgeResponse` 再转换，错误码就会被二次映射，
   容易出现「Local 是 `PERMISSION_DENIED`、Remote 是 `SCOPE_DENIED`」这类漂移。
4. 审计策略是「只记写工具」（`if (definition.write)`）。Remote 第一版全只读，
   照搬会**一行审计都不产生**——而远程访问恰恰最需要审计。

#### 6.5.2 目标结构

```
                         ┌──────────────────────────────┐
Local MCP client ──socket──> routeBridgeRequest           │
                         │  协议版本 / method / 白名单    │  ← Local 专属，不动
                         │  + authenticate(token)        │
                         │  + scope 检查（保留，行为不变）│
                         └──────────────┬───────────────┘
                                        │
Remote WSS ──frame──> remote request handler              │
                         │  开关 / 帧大小 / 白名单        │  ← Remote 专属
                         │  + hello_ok scopes ∩ 本地     │
                         │  + deadline                   │
                         └──────────────┬───────────────┘
                                        ▼
                    ┌────────────────────────────────────────┐
                    │  executeTool(tool, rawParams, ctx)     │  ← 唯一业务执行入口
                    │   1. tool 存在性                        │
                    │   2. definition.scope ∈ ctx.scopes      │
                    │   3. Zod 校验                           │
                    │   4. handler(ctx.services, params)      │
                    │   5. ApplicationError → 稳定错误码       │
                    │   6. ctx.audit(...)（按 channel 策略）   │
                    └───────────────────┬────────────────────┘
                                        ▼
                        Application Services（完全不变）
                                        ▼
                              Repository → SQLite
```

#### 6.5.3 代码边界（最小改动，Phase 1.1A / 1.1B 执行）

| 动作 | 文件 | 说明 |
|---|---|---|
| **新增** | `src/main/application/mcp-tools/tool-services.ts` | `ToolServices = { records, coffee, canvas, workContexts, personalDirection }`——**无 `db`、无 `clients`** |
| **新增** | `src/main/application/mcp-tools/handlers.ts` | 27 个 handler 从 `request-router.ts` **原样搬移**（每行仍是 `ctx.services.x.y(...)`，零逻辑改动） |
| **新增** | `src/main/application/mcp-tools/tool-executor.ts` | `executeTool()`，含 `TOOL_EXECUTION_ERROR_CODES` 映射 |
| **改（既有业务代码中唯一需要动的）** | `src/main/mcp-bridge/request-router.ts` | `HANDLERS` 与 `createShape`/`replayIdempotent` 移出；`routeBridgeRequest` 内部改调 `executeTool`；其余（协议版本、method、白名单、authenticate、幂等、scope 错误码）**逐字保留** |
| **不动** | `src/mcp/**`、`src/main/mcp-bridge/bridge-server.ts`、`src/main/mcp-bridge/bridge-client.ts`、`src/main/sync/**` | 零改动 |

`RouterContext` 保留为 `ToolServices & { db, clients }`，供 `routeBridgeRequest`
的幂等重放（`replayIdempotent` 需要 `ctx.db`）继续使用；`executeTool` 只接收
`ToolServices`，因此 Remote 根本拿不到 `clients`。

> 结构类型的好处：`RouterContext` 天然满足 `ToolServices`，所以
> `routeBridgeRequest` 可以把 `ctx` 直接传给 `executeTool`，**不需要构造新对象**，
> 抽取的 diff 因而非常小。

#### 6.5.4 契约

```ts
// tool-executor.ts（设计示意，非最终签名）
export type Channel = 'local' | 'remote'

export type ExecuteContext = {
  services: ToolServices
  /** 调用方已核实的授权集合。Local：mcp_clients.scopes；Remote：hello_ok.scopes ∩ 本地 */
  scopes: readonly McpScope[]
  channel: Channel
  /** 注入式审计：Local 只在写工具时调用；Remote 每次调用都记 */
  audit: (entry: AuditEntry) => void
}

export type ExecuteResult =
  | { ok: true; data: unknown; entityType?: string; entityId?: string }
  | { ok: false; code: string; message: string }

export function executeTool(
  tool: string,
  rawParams: unknown,
  ctx: ExecuteContext
): ExecuteResult
```

执行顺序（**固定，不可重排**）：

```
1. tool ∈ TOOL_DEFINITIONS            → 否则 INVALID_TOOL（Remote 映射为 TOOL_NOT_ALLOWED）
2. definition.scope ∈ ctx.scopes      → 否则 SCOPE_DENIED
3. definition.input.safeParse(params) → 否则 INVALID_ARGUMENTS（Local 映射为 VALIDATION_ERROR）
4. HANDLERS[tool](ctx.services, data) → 业务
5. 失败：ApplicationError.code 走白名单透传；其余 INTERNAL_ERROR + 通用文案
6. ctx.audit({ tool, entityType, entityId, success, errorCode })
```

**scope 检查放在执行层内部**是刻意的：这样「绕过 scope」在结构上不可能，
而不是靠「两处都记得写」。两个入口各自只负责算出自己的 `scopes`。

#### 6.5.5 去重键的架构位置（Phase 1.0.2 明确）

去重发生在**执行层之前**，由 Remote 侧的 `request-handler` 完成，
`executeTool` 完全不知道 `delivery_id` 的存在：

```
Remote: 准入链 → request_hash 校验 → 缓存查询 → executeTool
Local:  协议校验 → authenticate → scope → 幂等表 → executeTool
```

两者用的是**不同的机制**，不能互相替代：

| | Local | Remote |
|---|---|---|
| 键 | `(client_id, idempotency_key)`，由 AI 客户端提供 | `delivery_id`，由 Cloud 生成 |
| 用途 | 防「同一次写操作被重试两次」 | 防「同一次投递被重发两次」 |
| 存储 | 持久表 `mcp_idempotency` | 内存 LRU（协议 §8.4） |
| 是否有内容指纹 | 有（`request_digest`，判断同 key 是否换了参数） | 有（`request_hash`，同 id 是否换了内容） |
| 能否合并两个独立调用 | **不能**（key 不同即不同调用） | **不能**（`delivery_id` 不同即不同调用） |

**共同点**：两者都**不按 tool + arguments 合并**。这是 Phase 1.0 的核心错误，
Phase 1.0.1 移除后 **Phase 1.0.2 不得以任何形式恢复**。

#### 6.5.6 审计策略按 channel 分化（Phase 1.0.1 的实质修正）

| | Local | Remote |
|---|---|---|
| 写工具 | 记（现状不变） | 第一版不开放 |
| **只读工具** | **不记**（现状不变，避免给现有库凭空涨量） | **每次必记** |
| 失败（含权限/参数） | 写工具时记（现状不变） | 必记 |
| `client_id` | `mcp_clients.id` | `remote:<mcp_devices.id>` |

所以「共享执行层」不等于「共享审计策略」——策略由 `ctx.audit` 的实现方决定，
`executeTool` 只负责在正确时机调用它。这既满足「Local 行为不变」，
也满足「Remote 必须可审计」。

#### 6.5.7 审计结果不进 `ExecuteResult`（Phase 1.0.2 明确）

`ExecuteResult` 只有 `ok / data / code / message` 四个维度，**没有** `audited` 字段。
审计成败由 `ctx.audit` 的实现方自己记账（计数 + stderr + 界面），
`executeTool` 不知道也不关心。

这样设计的直接后果：**「业务成功 + 审计失败」不会在类型上被表达成第三种结果**，
也就不会被某个调用方误判成失败。三段状态的完整定义见
`REMOTE_MCP_SECURITY.md` §6.5.5。

#### 6.5.8 审计承诺边界（Phase 1.0.2 明确，1.0.3 补计数生命周期）

| 承诺 | 是否成立 |
|---|---|
| 每次远程调用都**尝试**写入审计 | ✅ |
| 审计失败会**计数并告警**（stderr + 设置页） | ✅ |
| 审计记录**不含**参数/结果/搜索词/正文 | ✅ |
| 每次远程读取**都有**审计记录 | ❌ **不得声称** |
| 审计记录**不可篡改** | ❌ **不得声称** |
| 失败计数**跨重启保留** | ❌ **不成立**：计数器是主进程内存状态，重启归零 |

**理由**：审计写失败时查询仍返回成功（否则磁盘满会伪装成业务错误），
所以存在「查到但没记上」的窗口。这个窗口必须被界面告知，而不是被文档掩盖。

**计数器的架构定位**：它是**运行时可观测性**，不是持久审计账本。
持久事实只有 `mcp_operation_log` 里的行；计数器消失不代表缺口被填补。
因此架构上禁止把计数器写进 SQLite——那会制造第二套「看起来像审计」的数据，
而它既不完整也不可信。详见安全 §6.5.6。

#### 6.5.9 Remote 白名单不会因 Local 新增工具而扩张

- `REMOTE_TOOLS` 是独立常量（8 个），**不是** `TOOL_NAMES.filter(...)`。
- `effective_tools = REMOTE_TOOLS ∩ hello_ok.allowed_tools ∩ toolsForScopes(ctx.scopes)`。
- 新增 Local 工具若不显式加入 `REMOTE_TOOLS`，Remote 永远拿不到。
- 合同测试：`REMOTE_TOOLS ⊂ TOOL_NAMES` 且 `REMOTE_TOOLS` 长度 == 8 且每个
  `TOOL_DEFINITIONS[t].write === false`。

#### 6.5.10 明确不做

- ❌ Remote **不**经 socket 绕回 `BridgeServer`（多一次序列化、多一层进程边界、
  且必然携带 Local token——违反原则 7）。
- ❌ 不复制第二套 handler（复制是业务逻辑重复的起点，两份参数映射迟早漂移）。
- ❌ 不把 `executeTool` 做成 async（现有实现全同步，加 async 只会引入无意义的
  微任务与取消复杂度；见协议 §8）。

#### 6.5.11 OPEN QUESTION

- `OQ-1`：`executeTool` 的错误码是两个入口各自的对外词表（Local 用
  `MCP_ERROR_CODES` 12 个，Remote 用协议 17 个），还是内部统一一套再映射？
  **倾向**：内部用一套 `EXECUTION_ERROR_CODES`（约 6 个），各入口映射。
  需在 Phase 1.1A 写第一个失败用例时定稿。**不阻塞 1.1A**。
- `OQ-2`：`handlers.ts` 搬移后，`createShape`（6 种响应形状）放执行层还是留在
  Local？**倾向**：留 Local（Remote 不需要 `createShape`，它只用只读工具）。
  **不阻塞 1.1A**。

### 6.6 复用矩阵（核心问题回答）

> **Remote MCP 能否复用已有 MCP Tool 定义与业务服务，而不重复实现业务逻辑？**

**能，而且是唯一正确做法。**

| 层 | 复用 | 方式 |
|---|---|---|
| 工具名 / 描述 / 参数 Schema | ✅ | 直接 import `TOOL_DEFINITIONS`（需把 `tool-schemas.ts` 移到两端共享位置，或由 Gateway 静态复制一份 Zod schema 并加一致性测试） |
| 响应 DTO | ✅ | `*ForMcp` 已产出 snake_case + 分页 + 脱敏字段 |
| 分页上限 | ✅ | `recordPage.limit ≤ 50`、`coffeePage.limit ≤ 100` |
| 业务规则（库存、幂等、版本锁） | ✅ | 全在 Service / Repository |
| 权限语义 | ⚠️ 部分 | scope 名字可复用，但**远程只读子集要单独定义**（现有 14 个 scope 里有 8 个写 scope，远程第一版不给） |
| 传输 | ❌ | 必须新写：Cloud HTTPS + Desktop WSS |
| 认证 | ❌ | 必须新写：MCP OAuth AS + 设备身份 |
| **执行入口** | ✅ | **共享 `executeTool()`**（§6.5），Local 与 Remote 同一入口，不是复制 handler |
| 审计 | ⚠️ 分化 | 复用 `mcp_operation_log` 表与 `writeAudit()`；**策略按 channel 不同**（Remote 只读也记，Local 只记写） |

**明确不做的事**：Gateway 不复制任何查询逻辑，不缓存业务数据，不落业务表。
Gateway 只做「认证 → 授权 → 路由 → 转发 → 回传」。

### 6.7 十二条架构原则的可行性判定

| # | 原则 | 判定 | 依据 / 需调整处 |
|---|---|---|---|
| 1 | SQLite 仍是唯一事实来源 | ✅ 可行 | Cloud 无业务表 |
| 2 | Cloud 不直接访问 localhost | ✅ 设计保证 | Gateway 无本地网络调用 |
| 3 | Cloud 不直接访问 Desktop SQLite | ✅ 结构保证 | MCP 进程与 Gateway 均无 DB 句柄 |
| 4 | Cloud 不直接访问本地媒体目录 | ✅ | 媒体仍只由 Main 的 `bpmedia://` 提供；远程只给 `has_image`，不给文件 |
| 5 | Desktop 主动出站 WSS | ✅ 需新增 | Desktop 现无任何 WS 代码 |
| 6 | 不要求用户开放公网端口 | ✅ | 出站连接天然满足 |
| 7 | 不把 Local MCP Token 发到 Cloud | ✅ 必须显式隔离 | 两条路径用**不同凭据域**：`bp_mcp_*` 永不出本机；远程用 `device_token` |
| 8 | Remote 独立身份与授权 | ✅ 需新建 | 登录 OAuth 不能复用（§3.3） |
| 9 | Desktop 保留最终校验权 | ✅ | Agent 侧二次校验 scope + 白名单 + 开关；`executeTool` 内部第三次校验 scope |
| 10 | 关闭远程访问后 Cloud 不再访问 | ⚠️ 已调整表述 | **本地开关是权威**：先落 `local_state`、立即拒绝一切 `req`；Cloud 的 `suspended` 与断连是**异步跟随**，允许最终一致。原「必须先撤销 grant」在网络失败时会让本地关闭失效 |
| 11 | 设备离线明确返回 | ✅ | `DEVICE_OFFLINE`，且**不得**降级为缓存/历史数据 |
| 12 | 不伪装未同步数据 | ✅ 天然满足 | 无 Cloud 镜像，故只有「查到」或「离线」两种结果 |

**需要调整/补充的三处**：

1. **原则 10 改为「本地优先 + 最终一致」，且撤销一律先持久化**：Desktop 关开关 →
   ① 写 `local_state`（同步，权威）→ ② 本机立即拒绝新 `req` → ③ 尽力
   `POST /mcp-devices/{id}/suspend` → ④ 断开 WSS。**③ 失败不回滚 ① ②**；
   Cloud 侧残留的 `active` 与在线连接会在 WSS 断开后被心跳判定离线，
   最坏延迟一个心跳周期（60s）。断连是结果，不是机制。
   同理，Cloud 侧撤销设备时**先写 `status='revoked'`，再删路由、再发 `bye`**——
   清理失败也不能让已撤销的授权重新放行（安全 §4.1）。
2. **原则 7 要写成代码约束**：`src/main/remote/**` 不得 import
   `application/authorization/permission-service.ts`，也不得 import
   `mcp-bridge/**`；由一条结构测试（读 import 图）在 CI 断言。
3. **原则 9 需要「本地能拒」的通道**：Desktop 若认为请求越权（例如工具已从白名单移除
   但 Cloud 还没更新），必须能返回结构化拒绝而不是断连——否则 Cloud 无法区分
   「越权」与「故障」。

### 6.8 Remote 第一版工具面（只读 8 个）

第一版**只开 8 个**（比现有 13 个只读更窄：去掉 `work_context:*` 与
`direction:read`，因为它们是个人工作上下文，远程 AI 的收益最低、隐私敏感度最高）：

| 工具 | 复用 schema | 所需远程 scope | 数据范围 | 上限 | 敏感信息 |
|---|---|---|---|---|---|
| `search_records` | ✅ | `records:read` | 全部 records（link/image/video/text） | `limit ≤ 50`，note 截断 | 记录正文可能含私人内容 |
| `get_record` | ✅ | `records:read` | 单条全文 | — | 同上 |
| `list_record_tags` | ✅ | `tags:read` | 全部标签名 | 全量（标签量小） | 标签名可能暗示隐私 |
| `list_beans` | ✅ | `coffee:read` | 全部豆子 | `limit ≤ 100` | 购买渠道/价格 |
| `list_brews` | ✅ | `coffee:read` | 全部冲煮 | `limit ≤ 100` | 评分/笔记 |
| `list_tastings` | ✅ | `coffee:read` | 全部品鉴 | `limit ≤ 100` | 同上 |
| `list_canvases` | ✅ | `canvas:read` | 画布列表 | 全量 | 画布名 |
| `get_canvas` | ✅ | `canvas:read` | 单画布（节点摘要 + 便签） | — | 便签正文 |

**统一空结果**（不要返回 `null` 或空字符串）：

```json
{ "items": [], "limit": 20, "offset": 0, "has_more": false }
```

**统一错误**（与 Local MCP 同形，便于两端同一套提示词）：

```json
{ "error": { "code": "SCOPE_DENIED", "message": "client is not granted records:read" } }
```

**明确不提供**：任意 SQL、文件读取、命令执行、写入/删除、`work_context:*`、
`direction:*`、`get_coffee_summary`（聚合值在 8 个工具之上可由 AI 自己算，
少一个工具就少一条信息泄露路径）。

**契约常量唯一权威**：`REMOTE_SCOPES`（4 个）、`REMOTE_TOOLS`（8 个）、
`REMOTE_ERROR_CODES`（17 个）在本文 §6.8、安全 §2.4、协议 §9.1、阶段 §1B.3
四处必须一致；错误码的**唯一权威表**是协议 §9.1。

### 6.9 身份生命周期（详见安全 §2.6）

架构层只需记住五条：

1. **用户 / 设备 / grant 是三层独立身份**（§3.8 图），撤销任一层不连带另两层。
2. **设备身份可跨会话保留，但不可跨用户继承**（`boundUserId` 阻断）。
3. **本地开关永远有最终否决权**，Cloud 侧状态是异步跟随。
4. **轮换不是"换 token"，而是换整套凭据**：提交后旧连接必须进入 `rotating`
   状态，其上到达的新 `req` 一律拒（`DEVICE_UNAUTHORIZED`）。否则「轮换」
   只是让旧连接握着一把已作废的钥匙继续开门。
5. **身份校验属于进程启动路径，不属于 UI**：`RemoteService` 初始化时就要跑
   「开关 + `boundUserId`」双门，任一门不通过即零出站连接。挂在设置页或
   IPC 处理里会让「崩溃重启」与「从不打开设置」两种情况下失去保护（安全 §2.6.4，ST-17）。

### 6.10 阶段依赖的架构含义（Phase 1.0.2 新增，1.0.3 定稿）

阶段拆分不是排期技巧，它对应**代码边界的实际分层**：

```
 1.1A  只动 application/mcp-tools/ + request-router.ts
       边界：进程内、无网络、无 IPC
       ↑ 这是一个纯重构，可独立回滚
 1.1B  新增 main/remote/ + IPC + 设置界面
       边界：Desktop 进程内的网络客户端
       ↑ 硬依赖 1.1A 的 executeTool（否则会复制 handler）
 1.2   新增 cloud/src/mcp-devices/ + link/
       边界：Cloud 进程内的 WSS 服务端
       ↑ 与 1.1B 通过**协议**耦合，不通过代码耦合
```

**关键判断：1.1B 与 1.2 之间没有代码依赖，只有协议依赖。**
这正是它们可以并行的架构依据——前提是协议先冻结（阶段文档 §5.1 的 P1/P2/P3）。
反过来，如果两边都**各写一份帧定义**，那就在架构上退化成"两份实现猜一个协议"，
并行立刻变成负债。

**三条依赖的准确性质（Phase 1.0.3）**：

| 关系 | 性质 | 架构含义 |
|---|---|---|
| 1.1A → 1.1B | **硬依赖** | 1.1B 的调用面就是 1.1A 的产物；没有它，Remote 只能复制 27 个 handler |
| 1.1B → 1.2 | **条件依赖** | 无代码依赖；并行需 P1/P2/P3，否则退化为串行 |
| 1.1B + 1.2 → 1.3 | **硬依赖** | 1.3 需要两端真实可跑 |

**Mock 通过不等于集成通过——这是架构事实，不是流程规定**：
1.1B 的 Mock Gateway 与 1.2 的 Mock Device 都是**按同一份文档各自手写**的对端。
若两份实现同时偏离文档（例如都把 `deadline_ms` 当相对超时），
两边测试仍会全绿，而真实链路一接就错。因此：
**「两端 Mock 都通过」只能证明「各自符合文档」，不能证明「彼此符合」。**
端到端的第一份证据只能来自 1.3 的真实联调。

---

## 7. 技术障碍与风险

### 7.1 阻塞级（不解决无法开工）

| # | 障碍 | 影响 | 处理方向 |
|---|---|---|---|
| B1 | 现有 `/oauth/*` 的 `redirect_uri` 只认 127.0.0.1（正则 `^http://127\.0\.0\.1:(\d{1,5})/callback$`，`security/crypto.ts:54`） | ChatGPT 无法授权 | 新建独立 MCP AS 端点组，**不改**现有登录流程 |
| B2 | Cloud 无 WS 承载（全仓 `websocket`/`upgrade` 零命中；`serve()` 未注入） | 设备无法上线 | `@hono/node-server` 的 `serve({ websocket })` + 新增连接管理器 |
| B3 | 无设备模型 | 无法路由 | 新增 `mcp_devices` / `mcp_grants` / `mcp_oauth_clients` 表（PG migration `0001`） |
| B4 | Desktop 无 WS 客户端 | 无法出站 | 新增 `src/main/remote/`；Electron 45 内置 Node 22 **需实测**全局 `WebSocket`，否则加 `ws` |
| B5 | 无连接路由表 | 多实例不可用 | 第一版**单实例**（运维约束，非技术强制）；多实例需 Redis，写入 Phase 1.4 |
| **B6** | **JWT `aud` 硬编码为 `brewphase-desktop`**（`sessions/jwt.ts:15,58,97`），`verifyAccessToken` 强制校验该值；claims 只有 `sub/sid/iss/aud/iat/exp/jti`，**无 scope、无 grant** | MCP access token 若沿用此 audience，则 Desktop 登录 token 可被当作 MCP token 使用（反之亦然），且 scope 无处可取 | Phase 1.3 新增 **MCP 专用签发/校验路径**（同 keyring、不同 `aud`、附加 `grant_id` + `scope`），不改现有 `signAccessToken` 行为 |
| **B7** | **`auth_sessions` 无 `session_kind`**（列：`id/user_id/refresh_token_hash/token_family/device_id/device_name/user_agent/ip_hash/expires_at/revoked_at/replaced_by/created_at/last_used_at`） | 无法在会话层区分「Desktop 登录」与「MCP client 会话」，登出会互相牵连 | Phase 1.3 migration 加 `session_kind TEXT NOT NULL DEFAULT 'desktop'`；或用独立 `mcp_sessions` 表（`OPEN QUESTION` OQ-3） |

### 7.2 高危风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 改动 Bridge 影响 Local MCP | 走**共享 `executeTool`**（§6.5），不做「直接调 `HANDLERS`」；`bridge-server.ts` / `bridge-client.ts` 零改动；Local 的协议/认证/白名单/幂等逐字保留 |
| R2 | 远程请求被当成 local 审计 | 1.1B 用 `client_id='remote:<device_id>'`（方案 A）；1.2 起 migration 14 加 `channel` + `device_id` + `request_id` 列 |
| R3 | Cloud 存了用户查询内容 | Gateway 不落请求体；日志只记 tool 名 + 结果码 + 耗时（`redact` 需扩 `args/params/result/content/note/body/title/search/url`） |
| R4 | 设备 token 被复制到另一台机 | 私钥在 `safeStorage`；握手需 Ed25519 签名；`device_id` 与公钥在 Cloud 绑定；换机必须用户确认 |
| R5 | 用户退出登录后连接残留 | 登出 → 断开**本设备** connection + suspend 本设备；**不**撤销该用户其它设备的授权（见安全 §4） |
| R6 | 协议版本错配导致静默失败 | `hello` 带 `min/max_version`，区间无交集则 close `4002`，不静默降级 |
| R7 | `executeTool` 抽取过程中改变 Local 行为 | 以现有 949 条测试为等价性证明；`request-router` 的对外错误码与审计时机逐项回归 |

### 7.3 「待确认」/ `OPEN QUESTION` 总表（唯一权威）

以下无法从代码判定，或需产品决策。**本节是四份文档中 OQ 的唯一汇总表**；
安全 §9 与协议 §8.9/§12.2 只就地说明上下文，编号以本表为准。

**"阻塞"列的口径**：是否阻止 **Phase 1.1A** 开工。1.1A 只抽执行层，
因此绝大多数 OQ 都不阻塞它。

| # | 问题 | 为何无法判定 | 需要谁决策 | 影响 Phase | 阻塞 1.1A？ |
|---|---|---|---|---|---|
| OQ-1 | `executeTool` 的错误码：内部统一一套再映射，还是两套词表 | 取决于实现时的错误分类粒度；不影响对外契约 | 1.1A 实现者 | 1.1A | 否（倾向内部 6 个码 + 各自映射） |
| OQ-2 | `createShape`（6 种响应形状）放执行层还是留 Local | Remote 只用只读工具，不需要它 | 1.1A 实现者 | 1.1A | 否（倾向留 Local） |
| OQ-3 | MCP 会话用 `auth_sessions.session_kind` 还是独立 `mcp_sessions` 表 | `auth_sessions` 当前无该列；取决于是否复用 refresh rotation | 1.3 设计 | 1.3 | 否 |
| OQ-4 | 同用户多设备路由策略（主设备 / 任选 / 广播） | 产品决策 | 用户 | 1.2（默认单连接顶替）、1.4 | 否 |
| OQ-5 | **审计连续失败是否熔断远程开关**（含 6 项待评估条件，见安全 §6.5.7） | 产品权衡：阈值、持续时间、错误类型、恢复方式都未定 | 用户 | 1.4 | 否（**第一版不熔断**，只告警） |
| OQ-6 | 是否需要 E2E 加密（Cloud 只见密文） | 会影响 Cloud 侧过滤能力 | 用户 | 1.5 | 否 |
| OQ-7 | DCR（RFC 7591）是否必需 | ChatGPT 行为 | 真实联调 | 1.3 | 否 |
| OQ-8 | 设备确认码是否必须走 Web（能否 Desktop 内确认） | 取决于是否有 Web 设置页 | 用户 | 1.2 | 否（默认 Web） |
| OQ-9 | 多设备并行与 `is_primary` | 产品决策 | 用户 | 1.4 | 否 |
| OQ-10 | Cloud 日志/审计留存 30 天是否满足合规 | 外部合规要求 | 用户 | 1.2 | 否 |
| OQ-11 | 是否加「相同意图 5 秒内合并」（默认关） | 产品权衡；会重新引入陈旧风险 | 用户 | 1.5 | 否（倾向不做） |
| OQ-12 | `GATEWAY_EXPECTED_REPLICAS` 是否可防止误配多副本 | 运维约束，技术上不可强制 | 运维 | 1.2 | 否 |
| **OQ-13** | **同机器 A→B 切换后，是否允许 B 直接重新注册（新 `device_id`），而不必等 A 撤销旧行** | 需要确认「同一 `public_key` 出现在两个 user 名下」是否可接受（当前校验按 `(user_id, public_key)`，技术上允许） | 用户 | 1.1B | 否（1.1B 默认：**阻断 + 提示解绑**，不自动注册） |
| **OQ-14** | **轮换窗口（②→④）内「已在执行」的请求是否允许完成** | 只读无副作用，但需要明确并测试 | 1.2 设计 | 1.2 | 否（倾向允许完成） |
| **OQ-15** | **`delivery_id` 缓存的具体数值（256 条 / 8 MiB / 60s）** | 均为设计建议，未做压力测试；需真实结果体大小分布校准 | 1.1B 实现者 | 1.1B | 否（数值可先按建议值落地，后续调参） |
| OQ-A | Cloud 生产部署形态：单容器还是多副本？反代是哪一层？ | 仓库无部署配置（只有 Dockerfile，单容器） | 用户/运维 | 1.2、1.4 | **否**（1.1A 不碰 Cloud） |
| OQ-B | ChatGPT 是否必须 DCR、是否要求 `resource` 参数 | ChatGPT 侧行为，代码无法推断 | 真实联调 | 1.3 | 否 |
| OQ-C | ChatGPT 是否要求 `outputSchema`、`notifications/cancelled`、SSE `GET /mcp` | 同上 | 真实联调 | 1.3 | 否 |
| OQ-D | Electron 45 主进程是否暴露全局 `WebSocket` | 需运行 `new WebSocket()` 实测；Node 22 有，Electron 未验证 | 1.1B 第一天 spike（S7） | 1.1B | **否**（1.1A 不建连接）。**阻塞 1.1B 合并 WSS 代码** |
| OQ-E1 | Electron 主进程的 Ed25519 行为是否与系统 Node 一致 | 已在系统 Node v22.22.2 实测通过（**L**），Electron 未验证（**E**） | 1.1B 第一天 spike（S8） | 1.1B | 否（低风险，可回退纯 JS 实现） |
| OQ-E2 | Windows DPAPI / Linux keyring 下 `safeStorage` 行为 | 需对应实机 | 1.1B 后期 / 1.2 | 1.1B（若含 Windows） | 否，若首发仅 macOS |
| OQ-F | Gateway 是否与现有 `BASE_URL` 同域（影响 `aud`、CORS） | 产品/部署决策 | 用户 | 1.3 | 否 |

**汇总**：**22 项**（OQ-1~OQ-15 共 15 项 + OQ-A~OQ-F 共 7 项）。其中：

- **阻塞 1.1A：0 项**（它只抽执行层，不碰网络/身份/Cloud）。
- **阻塞 1.1B：2 项**（OQ-D / OQ-E1），都需在 1.1B 第一天用 30 分钟验证，
  且都有明确退路（加 `ws` 依赖 / 换纯 JS Ed25519）。
- 其余 20 项全部落在 1.2 及以后。

### 7.4 Spike 状态（五级，Phase 1.0.2 统一口径）

| 码 | 含义 |
|---|---|
| **D** | 设计已完成（知道要验什么、怎么验、判据） |
| **P** | 验证方案已确定，**未执行** |
| **L** | 本地实验已通过（系统 Node / 非生产环境） |
| **E** | Electron 实机已通过 |
| **C** | ChatGPT 真实联调已通过 |

当前状态（与阶段文档 §0.1.3 同源）：

| 项 | 内容 | 状态 |
|---|---|---|
| S1 | MCP SDK 跑起 `/mcp` | **P** |
| S2 | `buildOAuthProtectedResourceMetadata` 输出 | **P** |
| S3 | `requireBearerAuth` 的 `resource` 校验 | **P** |
| S4–S6 | ChatGPT 的 DCR / `outputSchema` / `resource` 行为 | **P**（只能等 C） |
| S7 | Electron 主进程 `WebSocket` | **P**（1.1B 门禁，须转 E） |
| S8 | Electron 主进程 Ed25519 | **L**（系统 Node 已通）→ 待补 **E** |

**P ≠ L ≠ E ≠ C。** 任何文档、报告、UI 都不得把「方案已设计」写成「已验证」。

**Spike 与测试的差别（1.0.3 明确）**：Spike 验证的是「环境/外部服务能不能做到」；
测试验证的是「我们的实现对不对」。本阶段（1.0.1–1.0.3）**两类都没有执行**——
所有 ✓ 只出现在「文档内部一致」这一类，不出现在「行为已验证」这一类。

### 7.5 时间术语（跨文档统一项，Phase 1.0.3）

| 术语 | 唯一取法 | 只能用于 |
|---|---|---|
| **Unix epoch 毫秒** | `Date.now()` | 跨进程：帧 `ts`、`deadline_ms`、`trace.received_at`、`expires_at` |
| **monotonic 毫秒** | `performance.now()` | 进程内：`duration_ms`、心跳 RTT、退避计时、本地 deadline 倒计时 |

**禁用词**：「单调 epoch 毫秒」「monotonic epoch」——这两个词把互斥的时钟混在一起，
是 deadline 计算错误的直接来源。四份文档中已统一清除（协议 §2.1 给出完整定义）。

---

## 8. 与现有功能的关系

| 现有功能 | 关系 | 会不会被改 |
|---|---|---|
| Local MCP（27 工具 / Bridge / token） | 共享**执行层**（`executeTool`），不共享认证 | 行为不变；`request-router.ts` 在 **1.1A** 参与一次抽取（§6.5.3），以 949 条 + CB-1~CB-16 证明等价 |
| LAN Sync（HTTP 47821 / 配对码 / HMAC） | **无关**，不复用任何路由与凭据 | 不改 |
| Cloud 登录（`/oauth/*` + `/auth/*`） | 共用 `users` 表；JWT keyring 可共用，但 **`aud` 必须区分**（B6） | 不改现有 9 条路由 |
| Desktop `account/` 模块 | 复用 `credentials.ts` 的 `SecretBox` 注入模式与 `cloud-client.ts` 的 FetchLike/超时纪律 | 不改行为；Remote Agent 复用其模式，不复用其 token。**新增 `remote.prepareFor(userId)` 调用点**（安全 §2.6.4） |
| Desktop 本地 `devices` 表 | **无关**：那是 LAN Sync 的 iOS 配对记录（`schema.ts:318`，含 `public_key`/`token_hash`/`paired_at`） | 不改；Cloud 侧设备表命名为 `mcp_devices` 以免混淆 |
| `mcp_operation_log` | **1.1A/1.1B 都不改结构**（方案 A）；1.2 起 migration 14 加 `channel`/`device_id`/`request_id` | 1.1A / 1.1B 均零迁移 |
| Canvas / Records / Coffee 业务 | 只读投影已存在 | 不改 |

**Phase 1.0.3 补充的两条跨文档硬约束**：

| 约束 | 落点 | 为什么放在架构层 |
|---|---|---|
| `claim_secret` 只走 **POST 请求体**，禁止入 URL / query / 日志 / 错误信息；Cloud 只存 sha256 | 协议 §3.4、安全 §3.1 | 它是「第四个凭证」，传输方式属于架构的凭据面，不只是实现细节 |
| 帧内 `ts` = **Unix epoch 毫秒**（`Date.now()`），进程内计时 = **monotonic**（`performance.now()`） | 协议 §2.1 / §7.1 | 术语混用会直接导致 deadline 计算错误（见 ST-9） |

---

## 9. 本阶段未做的事

- 未实现任何 Remote MCP 代码
- 未改 Local MCP 运行逻辑（`executeTool` 抽取只写进 Phase 1.1A 计划，本阶段无代码）
- 未改 LAN Sync
- 未改 Cloud 现有 9 条路由
- 未改生产数据库结构（新表设计在文档里，migration 未写）
- 未提交、未推送、未合并
- **未执行任何真实 ChatGPT / Cloud WSS 联调**（本阶段所有协议结论均为设计推演，
  可验证项已标注验证方式与所属 Phase）
- **未执行任何测试**（1.0.1 / 1.0.2 / 1.0.3 三轮都只改文档；949 / 161 是 1.0 的实测值，
  不是本轮结果）
