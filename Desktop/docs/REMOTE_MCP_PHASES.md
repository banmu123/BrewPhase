# BrewPhase Remote MCP — 实施阶段（Phase 1.0 设计产出）

> 依据 `REMOTE_MCP_ARCHITECTURE.md` / `REMOTE_MCP_SECURITY.md` / `REMOTE_MCP_PROTOCOL.md`。
> 每个阶段都必须独立可验收、可回滚。**上一阶段验收不通过，不开始下一阶段。**

## 0. 阶段总览

| 阶段 | 目标 | 产出 | 依赖 | 风险 |
|---|---|---|---|---|
| **1.1** | **Desktop Remote Agent**（出站 WSS + 设备身份 + 准入 + 审计） | `src/main/remote/` + 测试用 Mock Gateway | 无（不依赖 Cloud 改动） | 低 |
| 1.2 | Cloud 设备面：注册 / 确认 / WSS 接入 / 连接表 / 转发 | `cloud/src/devices/`、`cloud/src/link/` | 1.1 | 中（首个长连接服务） |
| 1.3 | Cloud MCP 前端：`/mcp` + 独立 MCP OAuth AS + scope | `cloud/src/mcp/`、`cloud/src/oauth-mcp/` | 1.2 | **高**（OAuth 语义 + ChatGPT 兼容性） |
| 1.4 | 多实例与多设备：Redis 路由表、主设备选择 | `cloud/src/link/registry-redis.ts` | 1.3 | 中（部署形态未定） |
| 1.5 | 可选增强：E2E 加密、写入工具、SSE 长连接 | — | 1.4 + 产品决策 | 高（改变信任模型） |

**关键排期判断**：1.1 先做，是因为它**不依赖任何 Cloud 改动**，可以并行推进且
风险最低；同时它把「Desktop 能不能安全地接受远程请求」这个最不可控的问题
先验证掉。1.3 是最容易翻车的阶段（OAuth 兼容性），必须留出真实 ChatGPT 联调时间。

---

## Phase 1.1 — Desktop Remote Agent

### 1.1.1 范围（做什么）

| # | 能力 | 说明 |
|---|---|---|
| A1 | 设备身份 | Ed25519 密钥对；私钥 `safeStorage` 加密存 `userData/remote/device.json` |
| A2 | 设备注册客户端 | 调 Cloud `/devices/register` → 显示确认码 → 轮询 `/credentials`（本阶段用 Mock） |
| A3 | 出站 WSS | 主动连接、`hello` 握手、`hello_ok` 处理、版本协商 |
| A4 | 连接状态机 | `idle / connecting / online / draining / offline / blocked`，单一状态源 |
| A5 | 心跳 | 应答 `ping`；90s 无 `ping` 主动重连 |
| A6 | 自动重连 | 指数退避 + jitter；4xxx 策略性关闭不重试 |
| A7 | 请求准入 | 开关 → 帧大小 → 白名单 → Zod → deadline → scope → 幂等 |
| A8 | 工具执行 | **进程内**调用现有 `HANDLERS`（不走 socket、不改 `bridge-server`） |
| A9 | 超时与取消 | 尊重 `deadline_ms`；处理 `cancel` |
| A10 | 审计 | 写 `mcp_operation_log(channel='remote')`；工具名/实体/结果码，无参数无结果 |
| A11 | 本地开关 | 默认关；开启需列出 scope 与数据范围；关闭 = suspend + 断连 |
| A12 | 界面 | 设置页「远程访问」区：状态、设备名、最后活跃、撤销、连接诊断 |

### 1.1.2 明确不做（Phase 1.1 的护栏）

- ❌ 不改 `cloud/`（一行都不改；联调用仓内 Mock Gateway）
- ❌ 不改 `src/main/mcp-bridge/*`（`bridge-server.ts` / `bridge-client.ts` 零改动）
- ❌ 不改 `src/mcp/*`（Local MCP 进程零改动）
- ❌ 不改 `src/main/sync/*`（LAN Sync 零改动）
- ❌ 不加数据库迁移（`channel` 列在 1.2 与 Cloud 一起加；1.1 用现有列 +
  `client_id` 前缀 `remote:` 临时区分，**并在此阶段结束前确认该临时方案是否可接受**）
- ❌ 不开放任何写工具
- ❌ 不实现 MCP OAuth（属 1.3）

> 「不改 `mcp_operation_log` 结构」是刻意的：加列需要迁移，而迁移会动到
> `BrewPhaseSchema` 之外的 Desktop 库版本号。1.1 先用 `client_id = "remote:<device_id>"`
> 表达来源，等 1.2 与 Cloud 的设备表一起做一次 migration。

### 1.1.3 代码模块

```
Desktop/src/main/remote/                    （新增目录）
├── device-identity.ts        Ed25519 生成/加载/轮换；safeStorage 加解密；0600/0700
├── link-client.ts            WSS 连接、hello 握手、帧编解码、心跳
├── link-state.ts             连接状态机（唯一状态源，可观察）
├── reconnect.ts              退避计算（纯函数，无 IO —— 便于单测）
├── request-handler.ts        准入链 + 调 HANDLERS + 审计
├── remote-policy.ts          REMOTE_SCOPES / REMOTE_READONLY_ALLOWLIST / effective_tools 取交集
├── remote-service.ts         门面：start/stop/suspend/resume/status，供 IPC 调用
└── index.ts

Desktop/src/shared/contracts/remote.ts      （新增）
├── REMOTE_SCOPES             4 个只读 scope（独立于 MCP_SCOPES）
├── REMOTE_READONLY_ALLOWLIST 8 个工具
├── remoteStatusSchema        running/state/deviceId/lastPongAt/lastError
└── remoteErrorSchema         16 个错误码（与协议文档 §9.1 逐条对应）

Desktop/src/main/index.ts                   （改：装配 RemoteService，默认不启动）
Desktop/src/main/ipc/register.ts            （改：新增 remote:* 通道）
Desktop/src/preload/index.ts                （改：暴露 remote 命名空间）
Desktop/src/renderer/src/features/settings/ （改：新增「远程访问」面板）
Desktop/tests/unit/remote-*.test.ts         （新增 6 个测试文件）
Desktop/tests/helpers/mock-gateway.ts       （新增：本地 WS 服务，用于联调与 e2e）
```

**唯一触碰的既有业务代码**：`src/main/mcp-bridge/request-router.ts` 的
`HANDLERS` 需要从「模块私有」变为「可导出/可注入」。要求：

```ts
// 现状：const HANDLERS: Record<ToolName, ToolHandler> = { ... }
// 目标：export const HANDLERS = ... （仅加 export，不改内容）
// 且 routeBridgeRequest 行为完全不变（现有测试必须全绿）
```

如果连这一处都不想在 1.1 动，可以复制 8 个只读 handler 的**调用语句**
（每个 3–8 行，只是把 params 映射到 service 调用）到 `request-handler.ts`。
代价是两份参数映射需要一致性测试。**推荐加 `export`**——复制是业务逻辑重复的开始。

### 1.1.4 IPC 面

| 通道 | 入参 | 返回 |
|---|---|---|
| `remote:status` | — | `RemoteStatus` |
| `remote:enable` | `{ scopes: RemoteScope[] }` | `RemoteStatus`（含确认提示态） |
| `remote:disable` | — | `RemoteStatus` |
| `remote:register` | — | `{ deviceId, confirmCode, expiresAt }` |
| `remote:forget` | — | `RemoteStatus`（删私钥 + 清设备） |
| `remote:diagnose` | — | `{ state, lastError, lastPongAt, reconnectAttempt }` |
| `remote:changed` | 广播 | `RemoteStatus` |

**没有 `remote:call`**。远程调用只能由 Cloud 发起，本地不提供「手动触发一次远程工具」
的通道——那会变成一个绕过所有 UI 确认的后门。

### 1.1.5 测试要求

| 类型 | 覆盖 | 数量目标 |
|---|---|---|
| 单元（纯函数） | `reconnect.ts` 退避序列与 jitter 边界；`canonicalJson` 摘要稳定；`effective_tools` 三路交集（含空集） | ≥ 20 |
| 单元（身份） | 密钥生成/加载/加密不可用时拒绝落盘/解密失败视为未授权/轮换 | ≥ 12 |
| 单元（准入链） | 7 道检查逐一拒绝；`deadline` 已过不执行；未知工具；参数超限 | ≥ 25 |
| 单元（幂等） | 同 `idem` 命中缓存；同 `idem` 在途 single-flight；同 `id` 不同 `idem` → `PROTOCOL_VIOLATION` | ≥ 10 |
| 集成（Mock Gateway） | 握手成功 / 版本不匹配 / 4003 不重连 / 心跳超时 / drain 排空 | ≥ 12 |
| e2e | 设置页开关 → 状态变化；撤销后界面回到未连接（**不连真实 Cloud**） | ≥ 3 |
| 回归 | 现有 949 条必须全绿（尤其 `mcp-*`、`request-router` 相关） | 949 |

**不能声称「已测」的项**：真实 ChatGPT 联调、真实 Cloud WSS、真机网络切换
（Wi-Fi ↔ 有线）、NAT 半开——这些在 1.1 只做到 Mock 级，必须在报告里显式标注。

### 1.1.6 验收标准（可机械判定）

1. `pnpm typecheck` / `pnpm test` / `pnpm build` 全绿，测试总数 ≥ 949 + 82。
2. Local MCP 端到端不变：用现有 `mcp:start` + Codex/Claude 配置，27 个工具
   `tools/list` 与调用行为与改动前一致（对比 `out/mcp/stdio.mjs` 大小变化 < 5%，
   且 `TOOL_NAMES` 数组逐项相等）。
3. 默认状态为「远程关闭」，且**不建立任何出站连接**（用 `net` 层断言无 socket）。
4. 关闭开关后 1s 内连接关闭，且 60s 内无重连尝试。
5. 收到 close `4003 / 4001 / 4002 / 4004 / 4005 / 4006` 时**零重连**；
   收到 `1001 / 1011 / 4008` 时按退避重连，首次延迟 ∈ [500ms, 1000ms]。
6. 请求已过 `deadline_ms` 时**不进入业务层**（用 service 调用次数断言 0）。
7. 审计：每次远程调用在 `mcp_operation_log` 留一行，`client_id` 以 `remote:` 开头，
   且该行**不含**任何参数或结果内容（列集合不变即可证明）。
8. 与 Local MCP 的凭据隔离：在 `src/main/remote/` 下 grep 不到
   `authenticate(` / `McpClientService` / `bp_mcp_`（可作为 CI 断言）。

### 1.1.7 风险与缓解

| 风险 | 缓解 |
|---|---|
| WSS 客户端依赖不确定（Electron 45 是否暴露全局 `WebSocket`） | 第一天做 spike：主进程 `new WebSocket('wss://…')` 实测；不通则加 `ws`（本地依赖，不影响打包体积的确定性） |
| 主进程长连接影响退出 | `before-quit` 显式 `stop()`；连接状态机有 `disposed` 终态；参考 `browser-manager` 的销毁纪律 |
| 心跳定时器泄漏 | 所有 `setInterval` 在 `stop()` 清理；单测用 fake timers 断言无残留 |
| `safeStorage` 在 Linux 无 keyring 时不可用 | 与 `account/credentials.ts` 同策略：不可用则拒绝落盘 + 明确提示，不退化明文 |
| 把 Remote 逻辑混进 Bridge 导致 Local 回归 | 目录依赖方向断言（A8 的验收项 8）+ 不改 `bridge-server` 的强约束 |

---

## Phase 1.2 — Cloud 设备面

### 2.1 范围

| # | 能力 |
|---|---|
| B1 | 表：`devices`（user_id, name, platform, public_key, status, confirm_code_hash, token_hash, expires_at, last_seen_at, revoked_at） |
| B2 | 端点：`POST /devices/register`、`POST /devices/{id}/confirm`、`GET /devices/{id}/credentials`、`GET /devices`、`POST /devices/{id}/rotate`、`POST /devices/{id}/suspend`、`POST /devices/{id}/resume`、`DELETE /devices/{id}` |
| B3 | WSS 接入：`/device-link`，握手校验 9 步（协议 §4.3） |
| B4 | 连接表：`ConnectionRegistry` 内存实现 + 接口定稿 |
| B5 | 心跳：`ping`/`pong`、60s 无 `pong` 断连、`last_seen_at` 更新 |
| B6 | 转发：`req`/`res`/`cancel`，`deadline_ms` 传播，`max_inflight` 限流 |
| B7 | 迁移 `0001`：devices 表 + `auth_sessions.session_kind`（`desktop\|mcp`） |
| B8 | 运维：`/ready` 暴露 `instanceId`、`activeConnections` |

### 2.2 涉及模块

```
cloud/src/devices/{device-service.ts, routes.ts, device-token.ts}
cloud/src/link/{link-server.ts, handshake.ts, connection-registry.ts, forwarder.ts}
cloud/src/db/schema.ts                  （加 2 表 / 1 列）
cloud/src/db/migrations/0001_remote_mcp.sql
cloud/src/app.ts                        （挂新路由；不碰现有 9 条）
cloud/tests/{devices,link}/*.test.ts
```

### 2.3 测试要求

- 握手 9 步逐项负例（token 错 / pending / suspended / revoked / nonce 重放 /
  ts 偏移 / 签名错 / 版本不匹配 / 重复连接）≥ 18 条
- 心跳：3 次丢失断连、`last_seen_at` 正确 ≥ 5 条
- 转发：正常 / 设备离线 / `max_inflight` 超限 / deadline 到点 / cancel ≥ 10 条
- 迁移：幂等、可重复跑、不破坏现有 6 张表 ≥ 3 条
- **回归**：现有 cloud 161 条全绿

### 2.4 验收标准

1. 两台设备不能同时在线（旧连接被 `4006` 顶掉，旧设备侧不重连）。
2. 撤销设备后，用旧 `device_token` 握手返回 `4003`，且路由表无残留
   （断言 `registry.lookup` 为 null）。
3. `hello_ok` 到 `registry.bind` 的顺序可测（用一个在 `hello_ok` 后立刻发 `req`
   的测试证明不会丢）。
4. 现有 9 条身份路由的响应体逐字节不变（快照测试）。

### 2.5 风险

- 首个长连接服务：需要定义「Cloud 重启时已有连接怎么办」——重启即全断，
  设备自动重连，`drain` 只在滚动部署时有用（单实例重启来不及发 `drain`）。
- `@hono/node-server` 的 `websocket` 注入需实测（`serve({ websocket: { upgrade } })`）。

---

## Phase 1.3 — Cloud MCP 前端与独立 OAuth AS

### 3.1 范围

| # | 能力 |
|---|---|
| C1 | `POST /mcp`：`createMcpHandler` + `WebStandardStreamableHTTPServerTransport` |
| C2 | 工具面：8 个只读工具，schema 与 Desktop `TOOL_DEFINITIONS` 一致（一致性测试） |
| C3 | MCP OAuth AS：`/authorize`（含 consent 页）、`/token`（`grant_type` 双分支）、`/register`（DCR） |
| C4 | 元数据：`/.well-known/oauth-protected-resource`、`/.well-known/oauth-authorization-server` |
| C5 | 表：`mcp_grants`、`mcp_oauth_clients`、`mcp_auth_codes` |
| C6 | Scope 校验：Cloud 侧一次 + Desktop 侧一次 |
| C7 | 401 challenge：`WWW-Authenticate: Bearer resource_metadata="…"` |
| C8 | 日志纪律：只 tool/status/duration/error_code |

### 3.2 关键差异（与现有登录 OAuth）

| 项 | 现有 `/oauth/*` | 新增 MCP AS |
|---|---|---|
| `redirect_uri` | **只允许** `http://127.0.0.1:<port>/callback` | 允许 DCR 注册的任意 https（或 localhost） |
| `grant_type` | 无此字段 | 必须支持 `authorization_code` + `refresh_token` |
| scope | 无 | 必须携带并校验 |
| 客户端 | 只有第一方 Desktop | 第三方（ChatGPT） |
| 用户同意 | 无 consent 页 | **必须有** |

**必须新建路由组，不得改动现有 `/oauth/authorize` 的白名单**——那条白名单是
Desktop 登录的安全边界，放宽它等于允许任意站点做 redirect 劫持。

### 3.3 测试要求

- 授权码：PKCE、一次性、60s、`redirect_uri` 严格匹配 ≥ 12 条
- scope：请求多于授予 → 拒；token 的 `scope` 与 grant 一致 ≥ 8 条
- `/mcp`：无 token → 401 + challenge；错 `aud` → 401；撤销 grant → 401 ≥ 10 条
- 工具一致性：Cloud 的 8 个 schema 与 Desktop 的深度相等（fixture 对比）
- 日志：断言日志行不含 `arguments` 内容（用一个含独特字符串的参数跑，再 grep 日志）
- 回归：cloud 全绿

### 3.4 验收标准

1. 用 MCP 官方 client（`@modelcontextprotocol/client`）能完成：
   `initialize` → `tools/list`（8 个）→ `tools/call search_records` → 拿到数据。
2. 撤销 grant 后同一 token 立即 401（不是等 15 分钟）。
3. 授权页正确列出 4 个 scope 与对应数据范围的可读描述。
4. 现有 Desktop 登录流程**完全不受影响**：`/oauth/authorize` 传非 127.0.0.1
   的 `redirect_uri` 仍返回 400。

### 3.5 风险

- **ChatGPT 的 MCP OAuth 实现细节待确认**（DCR 是否必需、是否要求 `resource`
  参数、是否支持 `refresh_token`）——这是本阶段最大的不确定性，必须尽早真实联调。
- `outputSchema` / `annotations` 是否被要求，会影响工具描述形态。

---

## Phase 1.4 — 多实例与多设备

| # | 范围 |
|---|---|
| D1 | `ConnectionRegistry` Redis 实现（`mcp:conn:*` + pub/sub 路由） |
| D2 | 限流改共享存储（现有 `rate-limit.ts` 的接口不变，换实现） |
| D3 | 多设备：`devices.is_primary` + 用户选择 + 单用户多连接 |
| D4 | 滚动部署：`drain` 路径实测 |
| D5 | 指标：在线设备数、转发延迟 P50/P95、错误码分布 |

**验收**：两台 Gateway 实例 + 一台 Desktop，请求随机打到任一实例都能正确路由；
杀掉持有连接的那台，Desktop 在 5s 内重连到另一台，期间请求返回 `DEVICE_OFFLINE`
而不是挂起。

**前置**：必须先有 Redis（或 PG `LISTEN/NOTIFY`）。部署形态待确认。

---

## Phase 1.5 — 可选增强（需产品决策）

| 项 | 收益 | 代价 |
|---|---|---|
| E2E 加密（Desktop 生成会话密钥，Cloud 只转发密文） | Cloud 看不到数据 | Cloud 无法做结果过滤；密钥协商增加一轮；调试困难 |
| 写入工具（`create_record` 等） | 远程可记录 | 需要持久幂等 + 用户确认 UI + 更复杂的威胁模型 |
| SSE 长连接（`GET /mcp`） | 支持服务端推送 | 多实例下需要事件总线 |
| 断线排队 | 体验连续 | 与「明确失败优于延迟成功」冲突（协议 §10.3） |

**建议**：E2E 加密单独评估；写入工具至少等到 1.4 稳定后再做；断线排队**不做**。

---

## 4. 全阶段共同门禁

每个阶段结束必须跑并通过：

```bash
# Desktop
cd Desktop && pnpm typecheck && pnpm test && pnpm build && pnpm mcp:build
# Cloud
cd cloud   && pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

| 门禁 | 基线（1.0 结束时实测） |
|---|---|
| Desktop 单测 | 949 passed / 72 files |
| Cloud 单测 | 161 passed / 13 files |
| Desktop build | ✅ |
| `mcp:build` | ✅ 911.67 kB |
| Cloud build + lint | ✅ |

**Cloud 测试前置**：需 `brewphase-cloud-test-pg` 容器在 54329（当前在跑）。

---

## 5. 依赖关系图

```
1.1 Desktop Agent ──┐
   (Mock Gateway)   │
                    ├──> 1.2 Cloud 设备面 ──> 1.3 MCP 前端 ──> 1.4 多实例 ──> 1.5 增强
   设备身份/准入/审计  │       需要 1.1 的协议实现来对测       │
                    │                              需要 1.2 的在线设备
                    └── 可与 1.2 并行（用 Mock 先跑通两端）
```

**为什么 1.1 可以先独立做**：协议两端都在我们手里，Mock Gateway 只是按
`REMOTE_MCP_PROTOCOL.md` 发帧的测试工具。先做客户端能更早暴露「准入链有没有漏洞」，
而这个问题的修复成本在 1.1 远低于 1.3。

---

## 6. 本阶段（1.0）的实际交付

| 文档 | 行数级别 | 核心内容 |
|---|---|---|
| `REMOTE_MCP_ARCHITECTURE.md` | 现状审计 + 目标架构 | 27 工具实测、Bridge 边界、Cloud 9 路由、`redirect_uri` 硬限制、设备模型缺失、12 原则判定、8 工具面 |
| `REMOTE_MCP_SECURITY.md` | 威胁模型 | 五层权限、Ed25519 设备身份、4 个远程 scope、撤销矩阵、T14 威胁、隐私诚实边界 |
| `REMOTE_MCP_PROTOCOL.md` | 线协议 | 16 个错误码、9 步握手、绝对 deadline、幂等双字段、退避与 close code、多实例路由 |
| `REMOTE_MCP_PHASES.md` | 实施计划 | 1.1–1.5 范围/模块/测试/验收/风险 |

**未产生**：任何功能代码、数据库迁移、路由改动、commit/push/merge。
