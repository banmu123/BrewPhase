# BrewPhase Remote MCP — 架构（Phase 1.0 设计）

> 状态：**设计阶段**，无功能代码。基线 `feature/remote-mcp` @ `b1d311d`。
> 本文的每条现状结论都对应真实文件与行号；凡未验证的一律标「待确认」。
> 协议见 `REMOTE_MCP_PROTOCOL.md`，安全见 `REMOTE_MCP_SECURITY.md`，
> 实施排期见 `REMOTE_MCP_PHASES.md`。

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

**没有** `/mcp`、`/devices`、`/ws`、`/.well-known/*`。

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

### 3.6 能否区分「Cloud 登录授权」与「MCP 数据访问授权」

**不能。** 现有模型里没有任何 scope / grant / consent 概念：

- `auth_sessions` 没有 `scopes` 列
- 授权码不携带 scope
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
| API 路由 | 9 条，全部身份类 | 需新增 `/mcp`、`/.well-known/*`、`/devices` |
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
| Grant / Consent 存储 | Cloud | 用户授权哪个 client 哪些 scope | 新增表 |
| 设备注册表 | Cloud | `devices`（user_id, public_key, status, revoked_at, last_seen） | 新增表 |
| 连接路由表 | Cloud | `connection_id → instance_id`，多实例必需 | 新增（Redis / PG） |
| 连接管理器 | Cloud | WSS 接入、鉴权、心跳、请求转发、超时 | 新增 |
| 工具白名单（远程） | Cloud + Desktop **双份** | 远程只读子集，两端各自校验 | 新增常量 |
| Desktop Remote Agent | Desktop | 出站 WSS、设备身份、重连、准入 | 新增 `src/main/remote/` |
| 工具执行 | Desktop | 复用 `HANDLERS` + `*ForMcp` | **复用** |
| 本地远程开关 | Desktop | 用户级 kill switch | 新增 |
| 审计 | Desktop（权威）+ Cloud（接入事件） | 每次远程调用落 `mcp_operation_log` | 复用表，加 `channel` 列（分阶段：Phase 1.1 先用 `client_id='remote:<device_id>'` 临时区分，1.2 起落列） |
| Local MCP | Desktop | 不变 | **零改动** |

### 6.4 数据流：一次 `search_records`

```
1. ChatGPT → POST /mcp   Authorization: Bearer <MCP access token>
2. Gateway: 验签(JWT, aud=resource) → 取 user_id + grant_id + scopes
3. Gateway: scope 含 records:read ? → 否则 -32001 SCOPE_DENIED
4. Gateway: 查连接表 user_id → connection_id → 在线? 否则 DEVICE_OFFLINE
5. Gateway → WSS: { type:"req", id, tool:"search_records", args, deadline_ms }
6. Desktop Agent:
     a. 本地远程开关开? 否则拒绝
     b. tool ∈ REMOTE_READONLY_ALLOWLIST ? 否则拒绝
     c. 设备 token 有效期? 否则触发重注册
     d. 调 BridgeServer 的同一 HANDLERS（不新开 socket，直接进程内调用）
     e. 写 mcp_operation_log（Phase 1.1：client_id='remote:<device_id>'；1.2 起加 channel='remote'）
7. Desktop → WSS: { type:"res", id, ok:true, data }
8. Gateway → ChatGPT: tool result（structuredContent + text）
```

### 6.5 复用矩阵（核心问题回答）

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
| 审计 | ⚠️ 扩 | 复用 `mcp_operation_log`，加 `channel` 列区分 local/remote |

**明确不做的事**：Gateway 不复制任何查询逻辑，不缓存业务数据，不落业务表。
Gateway 只做「认证 → 授权 → 路由 → 转发 → 回传」。

### 6.6 十二条架构原则的可行性判定

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
| 9 | Desktop 保留最终校验权 | ✅ | Agent 侧二次校验 scope + 白名单 + 开关 |
| 10 | 关闭远程访问后 Cloud 不再访问 | ⚠️ 需协议支持 | 光断连不够：Cloud 必须**先撤销 grant 再**接受断连，否则积压请求仍可能转发 |
| 11 | 设备离线明确返回 | ✅ | `DEVICE_OFFLINE`，且**不得**降级为缓存/历史数据 |
| 12 | 不伪装未同步数据 | ✅ 天然满足 | 无 Cloud 镜像，故只有「查到」或「离线」两种结果 |

**需要调整/补充的三处**：

1. **原则 10 要落到服务端状态**：Desktop 关开关时，除了断 WSS，还要调
   `POST /devices/{id}/suspend`，Cloud 把设备标 `suspended` 并**清空连接表**。
   断连是结果，不是机制。
2. **原则 7 要写成代码约束**：`src/main/remote/` 不得 import
   `application/authorization/permission-service.ts` 的 token 逻辑；
   远程路径只认 `device_token`。用 lint 规则或单测断言目录依赖方向。
3. **原则 9 需要「本地能拒」的通道**：Desktop 若认为请求越权（例如工具已从白名单移除
   但 Cloud 还没更新），必须能返回结构化拒绝而不是断连——否则 Cloud 无法区分
   「越权」与「故障」。

### 6.7 Remote 第一版工具面（只读 8 个）

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

---

## 7. 技术障碍与风险

### 7.1 阻塞级（不解决无法开工）

| # | 障碍 | 影响 | 处理方向 |
|---|---|---|---|
| B1 | 现有 `/oauth/*` 的 `redirect_uri` 只认 127.0.0.1 | ChatGPT 无法授权 | 新建独立 MCP AS 端点组，**不改**现有登录流程 |
| B2 | Cloud 无 WS 承载 | 设备无法上线 | `@hono/node-server` 的 `serve({ websocket })` + 新增连接管理器 |
| B3 | 无设备模型 | 无法路由 | 新增 `devices` / `mcp_grants` / `mcp_clients_public` 表（migration 0001） |
| B4 | Desktop 无 WS 客户端 | 无法出站 | 新增 `src/main/remote/`；Electron 45 内置 Node 版本需实测是否可直接用全局 `WebSocket`，否则加 `ws` |
| B5 | 无连接路由表 | 多实例不可用 | 第一版**单实例**明确限制；多实例需 Redis，写入 Phase 1.4 |

### 7.2 高危风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 改动 Bridge 影响 Local MCP | Remote Agent 走**进程内直接调用 HANDLERS**，不改 `bridge-server.ts` 与 `request-router.ts` 的既有分支；新增 `channel` 参数默认 `'local'` |
| R2 | 远程请求被当成 local 审计 | `mcp_operation_log` 加 `channel` 列 + `client_id` 用设备 id，`channel='remote'` |
| R3 | Cloud 存了用户查询内容 | Gateway 不落请求体；日志只记 tool 名 + 结果码 + 耗时（扩 `redact` 覆盖 `args`） |
| R4 | 设备 token 被复制到另一台机 | 设备私钥在 `safeStorage`，且握手时 Cloud 校验 `device_id` 与公钥绑定；换机必须重新走用户确认 |
| R5 | 用户退出登录后连接残留 | 登出 → Cloud 撤销该 user 全部 grant + 断开全部 connection；Desktop 同时 `disconnect()` |
| R6 | 协议版本错配导致静默失败 | 握手 `min/max_version` 协商，不支持直接 `PROTOCOL_VERSION_UNSUPPORTED` 并断开 |

### 7.3 「待确认」清单

以下无法从代码判定，必须在 Phase 1.1 前问清：

1. **Cloud 生产部署形态**：单容器还是多副本？反代是哪一层？（决定 B5 是否立刻要 Redis）
2. **MCP OAuth 是否必须支持 DCR**（RFC 7591）：ChatGPT 当前流程是否需要动态注册客户端，还是用预注册 client_id。
3. **ChatGPT 侧 MCP 接入的实际能力**：是否支持 `notifications/cancelled`、是否要求 `outputSchema`、首次连接是否强制 `tools/list`。
4. **Electron 45 是否暴露全局 `WebSocket`**（Node 22 有，但 Electron 渲染/主进程环境需实测）。
5. **是否需要 Windows 设备**：`safeStorage` 在 Windows 用 DPAPI，行为与 macOS Keychain 不同，需单独验证。
6. **域名与证书**：Gateway 的 `BASE_URL` 是否与现有 `cloud` 同域（影响 `aud` 与 CORS）。

---

## 8. 与现有功能的关系

| 现有功能 | 关系 | 会不会被改 |
|---|---|---|
| Local MCP（27 工具 / Bridge / token） | **完全独立**，共享 Service 层 | 不改运行逻辑；只在 `request-router` 加 `channel` 参数 |
| LAN Sync（HTTP 47821 / 配对码 / HMAC） | **无关**，不复用任何路由与凭据 | 不改 |
| Cloud 登录（`/oauth/*` + `/auth/*`） | 共用 `users` 表与 JWT 签发工具，但**流程独立** | 不改现有 9 条路由 |
| Desktop `account/` 模块 | 复用 `credentials.ts` 的 safeStorage 模式与 `cloud-client.ts` 的 FetchLike/超时纪律 | 不改行为；Remote Agent 复用其模式，不复用其 token |
| `mcp_operation_log` | 扩列 `channel` | Desktop SQLite migration 14（当前最高 13），只加列带默认值 `'local'`；Cloud 侧另有独立 PG migration `0001`（devices 等），两者不是同一套版本号 |
| Canvas / Records / Coffee 业务 | 只读投影已存在 | 不改 |

---

## 9. 本阶段未做的事

- 未实现任何 Remote MCP 代码
- 未改 Local MCP 运行逻辑
- 未改 LAN Sync
- 未改 Cloud 现有 9 条路由
- 未改生产数据库结构（新表设计在文档里，migration 未写）
- 未提交、未推送、未合并
