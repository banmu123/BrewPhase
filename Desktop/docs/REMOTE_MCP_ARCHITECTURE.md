# BrewPhase Remote MCP — 架构（Phase 1.0 设计，1.0.1 / 1.0.2 / 1.0.3 修订）

> 状态：**设计阶段**，无功能代码。基线 `feature/remote-mcp` @ `89866cd`。
> 修订：**Phase 1.0.1 — Architecture & Protocol Hardening**、
> **Phase 1.0.2**、**Phase 1.0.3 Final Consistency**（均 2026-11-17）。
> 本文的每条现状结论都对应真实文件与行号；凡未验证的一律标「待确认」，
> 凡需产品决策或无法从代码判定的标 `OPEN QUESTION`。
> 协议见 `REMOTE_MCP_PROTOCOL.md`，安全见 `REMOTE_MCP_SECURITY.md`，
> 实施排期见 `REMOTE_MCP_PHASES.md`。

> **文档族导航**：架构族共 2 册，章节号全族唯一：
> - `REMOTE_MCP_ARCHITECTURE.md`（本册）：§0 一句话结论、§1–§5 现状审计（Local MCP / Bridge / Cloud 账号与 OAuth / Desktop 数据与同步 / Cloud 部署能力）
> - `REMOTE_MCP_ARCHITECTURE_DESIGN.md`：§6 总体架构、§7 技术障碍与风险（**§7.3 = OPEN QUESTION 唯一权威表**）、§8 与现有功能的关系、§9 本阶段未做的事
> 全系列索引见 `REMOTE_MCP_INDEX.md`。
## 0.0.3 Phase 0（P0-1 / P0-2）修订摘要（本系列）

| # | 修订点 | 原因 |
|---|---|---|
| 1 | **P0-1**：`ExecuteContext.scopes` 的来源改为**逐 grant 上下文**（不是连接级）；§6.9 增加第 6 条身份约束 | 同一设备多个 MCP Client 必须各自校验 scope、各自撤销 |
| 2 | **P0-2**：`jti` 语义定稿为 Token 级、不做请求去重 | 与安全 §3.2.1、协议 §15.2 对齐 |
| 3 | 错误码 17 → **19**；OQ 22 → **23**（+OQ-16） | 契约常量四处一致；写工具发送者约束仍开放 |

## 0.0 Phase 1.0.3 修订摘要（本系列）

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
| 5 | §7.3 OQ 总表扩到 22 项，新增 OQ-13/14/15 与 S7/S8 的**五级状态**〔Phase 0 扩到 23 项，+OQ-16〕 | 原文用「待执行 / 待联调」两种状态，无法区分「方案已设计」与「已跑通」 |

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
| 协议版本 | **实测值**：`LATEST_PROTOCOL_VERSION` = **`2025-11-25`**；`SUPPORTED_PROTOCOL_VERSIONS` = `["2025-11-25","2025-06-18","2025-03-26","2024-11-05","2024-10-07"]`。这两个常量描述的是**旧 `Server` 类**的上界，**不是** `createMcpHandler` 的能力上界——后者实测同时服务现代（`server/discover` → `supportedVersions: ["2026-07-28"]`）与 legacy（`initialize` → `2025-06-18`）。详见 `REMOTE_MCP_PHASE_1_3_DESIGN.md` §1.3 | `node_modules/@modelcontextprotocol/server`（运行时导入读取） |
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
4. **I4 → I5 的绑定是逐请求的**：WSS 连接建立后，Cloud 把该设备的 active grant
   以**Grant 授权上下文**下发；每个 `req` 带 `grant_ctx`，Desktop 据此校验 scope 与
   归属。**连接级 scope 不再存在**（Phase 0 / P0-1，安全 §2.7、协议 §6.5）。
   没有这条，「同一设备上多个 MCP Client」在 Desktop 眼里是同一个身份。

完整的五个生命周期场景（登出 / 用户切换 / 关开关 / 忘记设备 / 轮换）
见 `REMOTE_MCP_SECURITY.md` §2.6；协议侧的实现约束见
`REMOTE_MCP_PROTOCOL_LIFECYCLE.md` §11。

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
