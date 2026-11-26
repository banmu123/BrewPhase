# BrewPhase Remote MCP — 架构 · 目标设计与风险（§6–§9）

> **分册说明**：本册从 `REMOTE_MCP_ARCHITECTURE.md` 按整章拆出，章节号沿用全系列编号。
> 本册：§6 总体架构、§7 技术障碍与风险（**§7.3 = OPEN QUESTION 唯一权威表**）、§8 与现有功能的关系、§9 本阶段未做的事。
> 全系列索引见 `REMOTE_MCP_INDEX.md`。基线 `feature/remote-mcp` @ `fc96654`。
> 本册由原文档整章拆出（仅搬移 + 补导航，无内容变更）；**其后叠加 Phase 0 的
> P0-1 / P0-2 修订**，逐条见 `REMOTE_MCP_INDEX.md` §7。

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
            → 查 mcp_grants 得 grant_id + scopes（JWT 里的 scope 只是签发快照）
3. Gateway: grant.user_id == sub == device.user_id ? → 否则 USER_MISMATCH
4. Gateway: scope 含 records:read ? → 否则 SCOPE_DENIED
5. Gateway: 查连接表 (user_id, device_id) → 在线? 否则 DEVICE_OFFLINE；
            grant 上下文已在该连接上安装并 ack? 否则 GRANT_CONTEXT_INVALID
6. Gateway → WSS: { type:"req", id:<delivery_id>, grant_ctx, tool:"search_records",
                    arguments, request_hash, deadline_ms }
7. Desktop Agent（顺序固定，任一失败即回 res.ok=false）:
     a. 本地远程开关 on? 否则 REMOTE_DISABLED
     b. frame ≤ max_frame_bytes? 否则 REQUEST_TOO_LARGE
     c. now < deadline_ms? 否则 REQUEST_TIMEOUT（不执行）
     d. grant_ctx 已知 / active / epoch 当前? 否则 GRANT_CONTEXT_INVALID
     e. ctx.bound_user_id == device.boundUserId? 否则 USER_MISMATCH（并 blocked）
     f. tool ∈ effective_tools(grant)? 否则 TOOL_NOT_ALLOWED
     g. required_scope ∈ effective_scopes(grant)? 否则 SCOPE_DENIED
     h. request_hash 一致 → 查缓存 (grant_ctx, delivery_id) → executeTool(
          tool, arguments, { scopes: effective_scopes(grant), channel:'remote', audit })
        —— 与 Local 同一个执行层：Zod → handler → 错误映射 → 审计
     i. 审计行 client_id='remote:<device_id>'，**只读也记**（与 Local 只记写不同）
8. Desktop → WSS: { type:"res", id, ok:true, data }
9. Gateway → ChatGPT: tool result（structuredContent + text）
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
                         │  + grant_ctx 校验（逐 grant）  │
                         │  + 该 grant 的 scopes ∩ 本地   │
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

#### 6.5.3 代码边界（**Phase 1.1A 已实现，以实现为准**）

| 动作 | 文件 | 说明 |
|---|---|---|
| **新增** | `src/main/application/mcp-tools/tool-services.ts` | `ToolServices = { records, coffee, canvas, workContexts, personalDirection }`——**无 `db`、无 `clients`** |
| **新增** | `src/main/application/mcp-tools/handlers.ts` | `TOOL_HANDLERS`（27 个）从 `request-router.ts` **原样搬移**，另含 `createShape` |
| **新增** | `src/main/application/mcp-tools/tool-executor.ts` | `executeTool()` + `errorCodeOf` / `messageOf` |
| **改** | `src/main/mcp-bridge/request-router.ts` | `HANDLERS` / `createShape` / 错误映射移出（558 → 213 行）；改调 `executeTool`；**认证、协议、幂等表、审计、`sync_status` 逐字保留** |
| **不动** | `src/mcp/**`、`bridge-server.ts`、`bridge-contract.ts`、`src/main/sync/**`、`tool-schemas.ts` | 零改动 |

`RouterContext` 定义为 `ToolServices & { db, clients }`——结构类型让
`routeBridgeRequest` 可以把 `ctx` 直接传给 `executeTool`，不必构造新对象。

> **实现与早期设计的三处偏差（1.1A 定稿，不再是「待定」）**：
>
> 1. **`replayIdempotent` 留在 `request-router.ts`，没有搬进共享层**。
>    它需要 `ctx.db` 直接查 `record_tags`（Service 没有 `getTagForMcp`）。
>    搬走就必须把 `db` 塞进 `ToolServices`，直接破坏「共享层不认识数据库」。
>    代价是：幂等重放的**形状构造函数** `createShape` 必须共享，因此它留在
>    `handlers.ts` 并被 router 复用——两边形状不可能漂移。
> 2. **没有 `Channel` 类型，也没有 `channel` 参数**。执行层不需要知道调用方是谁；
>    「按 channel 分化」的是审计与去重策略，都在调用方。
> 3. **没有 `audit` 回参**。执行层改为返回 `stage` + `definition` + 解析后 `params`，
>    由调用方按自己的策略记账。理由：`audit` 回调会逼共享层 import
>    `mcp-bridge/audit-log`（结构测试禁止），且「哪几个阶段要记」本身是
>    Local 与 Remote 各不相同的**策略**，不是执行层的职责。

#### 6.5.4 契约（**Phase 1.1A 实际签名**）

```ts
// tool-executor.ts —— 这是实现，不是示意
export type ExecuteToolStage = 'tool' | 'scope' | 'params' | 'replay' | 'handler'

export type ExecuteToolOptions = {
  services: ToolServices
  /** 调用方已核实的授权集合。Local：mcp_clients.scopes；
   *  Remote：该 grant 的 effectiveScopes（逐 grant，不是连接级；安全 §2.7） */
  scopes: readonly McpScope[]
  /** 可选短路钩子，插在「Zod 通过」与「Handler 执行」之间（Local 幂等表用） */
  replay?: (call: {
    toolName: ToolName
    definition: ToolDefinition
    params: Record<string, unknown>
  }) => HandlerResult | undefined
}

export type ExecuteToolSuccess = {
  ok: true
  toolName: ToolName
  definition: ToolDefinition
  params: Record<string, unknown>   // Zod 解析后；记账必须用它
  data: unknown
  entityType?: string
  entityId?: string
  replayed: boolean                 // true = replay 钩子短路，Handler 未执行
}

export type ExecuteToolFailure = {
  ok: false
  toolName: ToolName | null
  definition: ToolDefinition | null
  params: Record<string, unknown> | null   // 仅 Zod 通过后非 null
  stage: ExecuteToolStage
  code: McpErrorCode                // **Local 码**
  message: string
}

export function executeTool(
  tool: string,
  rawParams: unknown,
  options: ExecuteToolOptions
): ExecuteToolResult
```

执行顺序（**固定，不可重排**）：

```
1. tool ∈ TOOL_DEFINITIONS            → 否则 VALIDATION_ERROR（stage='tool'）
2. definition.scope ∈ options.scopes  → 否则 PERMISSION_DENIED（stage='scope'）
3. definition.input.safeParse(params) → 否则 VALIDATION_ERROR（stage='params'）
4. options.replay(...)                → 命中则短路（stage 不进，replayed=true）
5. TOOL_HANDLERS[tool](services,data) → 业务
6. 失败：ApplicationError.code 透传；其余 INTERNAL_ERROR + 通用文案
```

**返回 `Local` 的 `McpErrorCode` 是刻意的**：`VALIDATION_ERROR` / `PERMISSION_DENIED`
是 Local 的既有契约，反向映射会逼 Local 的每个错误码经过一次转译，
而「Local 行为零变化」是 1.1A 的硬约束。**Remote 入口自己维护映射表**（见 §6.8.1），
不许把 Local 码透传出去。

**为什么 `replay` 必须是钩子而不是内部实现**：幂等表要读 `db`，且必须插在
「Zod 已通过（摘要基于解析后参数）」与「Handler 未执行」之间——放在 Zod 之前会让
每次重放都退化成冲突。共享层不认识幂等表，只提供这个时机。

**`scope` 检查放在执行层内部**是刻意的：这样「绕过 scope」在结构上不可能，
而不是靠「两处都记得写」。两个入口各自只负责算出自己的 `scopes`。
Remote 侧**额外**在准入链里提前判一次（缓存之前），两次都保留——见 §6.8.1。

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

#### 6.5.6 审计策略按 channel 分化（Phase 1.1B 落定边界）

| | Local | Remote |
|---|---|---|
| 写工具 | 记（现状不变） | 第一版不开放 |
| **只读工具** | **不记**（现状不变，避免给现有库凭空涨量） | **每次必记** |
| 失败（含权限/参数） | 写工具时记（现状不变） | 必记 |
| `client_id` | `mcp_clients.id` | `remote:<mcp_devices.id>` |

**责任边界（Phase 1.1B 明确）**：共享执行层**不写审计**，也不接受 `audit` 回调。
它只返回「失败发生在哪个阶段（`stage`）+ 解析后参数（`params`）+ `definition.write`」，
由各入口自己映射成审计决策：

| `stage` | Local（router） | Remote（request-handler） |
|---|---|---|
| `tool`（未知工具） | 协议层已先拦一次，不会到这 | 记 1 行，`error_code=TOOL_NOT_ALLOWED` |
| `scope` | 写工具才记 | **必记**（`SCOPE_DENIED`） |
| `params` | 写工具才记 | **必记**（`INVALID_ARGUMENTS`） |
| `replay`（幂等冲突/失效） | 冲突记 1 行；失效不记 | 不适用（Remote 无 replay 钩子） |
| `handler` | 写工具才记 | **必记**（业务码或 `INTERNAL_ERROR`） |
| 成功 | 写工具才记 | **必记**（只读也记） |

**同一个失败只能有一行**。Remote 的规则是「一次 `req` 至多写一行审计」——
由 `request-handler` 在准入链的**单一出口**统一记账，不在每个分支各写一次。
Local 沿用原逻辑（可能写 0 行或 1 行），不受影响。

`executeTool` 只负责在正确时机执行、并如实汇报 `stage`；这既满足
「Local 行为不变」，也满足「Remote 必须可审计」。

#### 6.5.7 审计结果不进 `ExecuteResult`（Phase 1.0.2 明确）

`ExecuteResult` 只有 `ok / data / code / message` 四个维度，**没有** `audited` 字段。
审计成败由 `ctx.audit` 的实现方自己记账（计数 + stderr + 界面），
`executeTool` 不知道也不关心。

这样设计的直接后果：**「业务成功 + 审计失败」不会在类型上被表达成第三种结果**，
也就不会被某个调用方误判成失败。三段状态的完整定义见
`REMOTE_MCP_SECURITY_OPERATIONS.md` §6.5.5。

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
- `effective_tools(grant) = REMOTE_TOOLS ∩ hello_ok.allowed_tools
  ∩ toolsForScopes(effective_scopes(grant))`——**逐 grant**，不是连接级。
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
  `MCP_ERROR_CODES` 12 个，Remote 用协议 19 个），还是内部统一一套再映射？
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

#### 6.8.1 Local → Remote 错误码映射（Phase 1.1B 定稿，唯一权威）

共享执行层返回 **Local `McpErrorCode`**。Remote 入口**必须**过这张表，
不允许把 Local 码透传到协议层：

| 触发条件 | `executeTool` 返回（Local） | `stage` | Remote 对外 |
|---|---|---|---|
| 工具不在 `effectiveTools(grant)` | — | 准入链第 6 步 | `TOOL_NOT_ALLOWED` |
| `executeTool` 报未知工具（理论不可达，双保险） | `VALIDATION_ERROR` | `tool` | `TOOL_NOT_ALLOWED` |
| Scope 不足 | `PERMISSION_DENIED` | `scope` | `SCOPE_DENIED` |
| Zod 参数错误 | `VALIDATION_ERROR` | `params` | `INVALID_ARGUMENTS` |
| 实体不存在 | `NOT_FOUND` | `handler` | `NOT_FOUND` |
| 乐观锁冲突 | `STALE_RECORD` | `handler` | `NOT_FOUND`（远程不暴露「有这条记录但你版本旧了」） |
| 其余 `ApplicationError` | 其 `code` | `handler` | 见下「白名单」 |
| 未知异常 | `INTERNAL_ERROR` | `handler` | `INTERNAL_ERROR` |

**白名单**（其余 `ApplicationError.code` 一律折成 `INTERNAL_ERROR`，不向外泄漏内部语义）：
`NOT_FOUND` / `VALIDATION_ERROR` / `INTERNAL_ERROR`。

**为什么 `STALE_RECORD` 折成 `NOT_FOUND`**：远程 8 个工具全只读，不会产生 `STALE_RECORD`；
若真出现，说明内部有 bug，向外报「不存在」比报「版本冲突」泄漏更少。
**为什么 `PERMISSION_DENIED` 不能直接外传**：协议只认 19 个码，
`PERMISSION_DENIED` 不在其中，且语义上 Remote 的正确码是 `SCOPE_DENIED`。

**契约常量唯一权威**：`REMOTE_SCOPES`（4 个）、`REMOTE_TOOLS`（8 个）、
`REMOTE_ERROR_CODES`（19 个）在本文 §6.8、安全 §2.4、协议 §9.1、阶段 §1B.3
四处必须一致；错误码的**唯一权威表**是协议 §9.1。
实现侧唯一来源：`src/shared/contracts/remote.ts`。

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
   **但「在启动路径里」还不够**——见第 7 条。
6. **Grant 不是连接级 scope**：每个请求绑定一个 Grant 上下文（`grant_ctx`），
   同一设备上的多个 MCP Client 各自校验 scope、各自撤销、缓存互不命中
   （安全 §2.7；协议 §6.5）。连接级 `hello_ok.scopes` 已删除。
7. **身份校验必须收敛成一道门，而不是散在启动路径的几个分支里**
   （Phase 1.1B.1 修订）。第一版把「`boundUserId` 是否等于当前用户」写在
   `start()` 的一个 `if` 里，而 `enable()` / `resume()` / 重连定时器都直接调
   `connect()`，**绕过了那个 `if`**——A 用户的设备身份会在 B 登录后被继续使用。

   现在只有 `canConnect()` 一个判据，五条入口全走它，`connect()` 内部再查一次
   （协议 §11.5.1）。架构上的教训是：**「在启动时检查」是时序假设，不是安全属性**；
   安全属性必须是「任何通往 socket 的路径都经过同一个函数」。

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
| **B7** | **`auth_sessions` 无 `session_kind`**（列：`id/user_id/refresh_token_hash/token_family/device_id/device_name/user_agent/ip_hash/expires_at/revoked_at/replaced_by/created_at/last_used_at`） | 无法在会话层区分「Desktop 登录」与「MCP client 会话」，登出会互相牵连 | **OQ-3 已关闭（Phase 1.3.0；1.3.0-R1 细化为两层）**：新建 `mcp_sessions`（身份，`sid` 稳定）+ `mcp_refresh_tokens`（每代凭据），**不改** `auth_sessions`。理由见 `REMOTE_MCP_PHASE_1_3_DESIGN.md` §9.2（全局 UNIQUE 的 `refresh_token_hash`、`logoutByRefreshToken` 撤整族、缺少 `client_id`/`grant_id`） |

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
| OQ-3 | ~~MCP 会话用 `auth_sessions.session_kind` 还是独立表~~ | **已关闭（1.3.0，R1 细化）**：`mcp_sessions`（身份）+ `mcp_refresh_tokens`（每代凭据）两层；`auth_sessions` 零改动 | 1.3 设计 | **已定稿** | 否 |
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
| **OQ-16** | **写工具开放后 HTTP 层如何做发送者约束**（DPoP / per-request nonce / mTLS） | 只读工具重放无状态副作用；写工具会改变状态，必须引入发送者约束，选型取决于真实客户端能力 | 1.5 设计 | 1.5（写工具之前） | 否 |
| OQ-A | Cloud 生产部署形态：单容器还是多副本？反代是哪一层？ | 仓库无部署配置（只有 Dockerfile，单容器） | 用户/运维 | 1.2、1.4 | **否**（1.1A 不碰 Cloud） |
| OQ-B | ChatGPT 是否必须 DCR、是否要求 `resource` 参数 | ChatGPT 侧行为，代码无法推断 | 真实联调 | 1.3 | 否 |
| OQ-C | ChatGPT 是否要求 `outputSchema`、`notifications/cancelled`、SSE `GET /mcp` | 同上 | 真实联调 | 1.3 | 否 |
| OQ-D | Electron 45 主进程是否暴露全局 `WebSocket` | 需运行 `new WebSocket()` 实测；Node 22 有，Electron 未验证 | 1.1B 第一天 spike（S7） | 1.1B | **否**（1.1A 不建连接）。**阻塞 1.1B 合并 WSS 代码** |
| OQ-E1 | Electron 主进程的 Ed25519 行为是否与系统 Node 一致 | 已在系统 Node v22.22.2 实测通过（**L**），Electron 未验证（**E**） | 1.1B 第一天 spike（S8） | 1.1B | 否（低风险，可回退纯 JS 实现） |
| OQ-E2 | Windows DPAPI / Linux keyring 下 `safeStorage` 行为 | 需对应实机 | 1.1B 后期 / 1.2 | 1.1B（若含 Windows） | 否，若首发仅 macOS |
| OQ-F | Gateway 是否与现有 `BASE_URL` 同域（影响 `aud`、CORS） | 产品/部署决策 | 用户 | 1.3 | 否 |

**汇总**：**23 项**（`OQ-1`~`OQ-16` 共 16 项 + `OQ-A`~`OQ-F` 共 7 项——字母组里 E 拆为
`OQ-E1` / `OQ-E2` 两条，故为 7 而非 6）。其中：

- **阻塞 1.1A：0 项**（它只抽执行层，不碰网络/身份/Cloud）。
- **阻塞 1.1B：2 项**（OQ-D / OQ-E1），都需在 1.1B 第一天用 30 分钟验证，
  且都有明确退路（加 `ws` 依赖 / 换纯 JS Ed25519）。
- 其余 21 项全部落在 1.2 及以后。

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
