# BrewPhase Remote MCP — 实施阶段 · 后续阶段与门禁（Phase 1.2–1.5 / §4–§6）

> **分册说明**：本册从 `REMOTE_MCP_PHASES.md` 按整章拆出，阶段号/章节号沿用全系列编号。
> 本册：Phase 1.2 / 1.3 / 1.4 / 1.5、§4 全阶段共同门禁（含 §4.1 测试矩阵归属）、§5 依赖关系图、§6 实际交付。
> 全系列索引见 `REMOTE_MCP_INDEX.md`。基线 `feature/remote-mcp` @ `fc96654`。
> 本册由原文档整章拆出（仅搬移 + 补导航，无内容变更）；**其后叠加 Phase 0 的
> P0-1 / P0-2 修订**，逐条见 `REMOTE_MCP_INDEX.md` §7。

---

## Phase 1.1B.1 — Desktop 协议与安全边界收口

范围与验收见 `REMOTE_MCP_PHASES.md` §1B.9（同一阶段，不另立章节编号）。
这里只记**它如何改变 1.2 的开工条件**：

| 对 1.2 的影响 | 内容 |
|---|---|
| 接入校验的真值来源变了 | 1.2 的 `/device-link` 必须按协议 §4.3 的 10 步实现，**不能**照抄 Mock 的简化版（Mock 不做 nonce 去重、不做多实例路由、不做 OAuth） |
| `hello` 字段与签名已冻结 | Cloud 侧验签必须用 `helloSigningPayload` 的同一份规范串；字段集变更需递增版本前缀 |
| `serviceable` 是 Desktop 上报的提示 | 1.2 的路由可以据此暂停派发，但**不得**据此跳过 grant/scope 校验 |
| 注册端点契约已定 | §3.2/§3.3/§3.4 的请求/响应形状已在 Mock 上跑通；1.2 照实现即可，`claim_secret` 只存 `sha256`、领取必须条件 UPDATE |
| Desktop 侧注册客户端已就绪 | `createHttpDeviceRegistrar` 已实现；1.2 之后只需把「用户 Bearer 从哪来」接到 AccountService（当前 `RemoteService.register()` 在没有 registrar 时**明确抛错**，不伪造成功） |

**仍然阻塞 1.2 的项**：无。1.1B.1 的验收项与方法见 §1B.9。

---

## Phase 1.2 — Cloud 设备面

### 2.1 范围

| # | 能力 |
|---|---|
| B1 | 表 `mcp_devices`：`id, user_id, name, platform, public_key, status(pending\|active\|suspended\|revoked), confirm_code_hash, claim_secret_hash, expires_at, token_hash, token_issued_at, key_rotated_at, last_seen_at, grant_epoch INTEGER NOT NULL DEFAULT 0, revoked_at, created_at`（`grant_epoch` 为 Phase 0 / P0-1 新增，设备级单调计数） |
| B2 | 端点：`POST /mcp-devices/register`、`POST /mcp-devices/{id}/confirm`、`POST /mcp-devices/{id}/credentials`（**请求体传 `claim_secret`，不入 URL**）、`GET /mcp-devices`、`POST /mcp-devices/{id}/rotate`、`POST /mcp-devices/{id}/suspend`、`POST /mcp-devices/{id}/resume`、`DELETE /mcp-devices/{id}` |
| B3 | **凭证领取闭环**：`claim_secret` 生成/只存哈希/一次有效；领取用**条件 UPDATE + RETURNING** 保证原子（协议 §3.4） |
| B4 | 设备状态机：`pending → active → suspended ⇄ active`；任意状态 `→ revoked`（安全 §4.0 S2）。**状态转换只用单条 UPDATE，不做多步** |
| B5 | WSS 接入：`/device-link`，握手校验 9 步 + `hello_ok` 构造（协议 §4.3 共 10 项），含 Ed25519 验签与**原子 nonce 去重** |
| B6 | 连接表：`ConnectionRegistry` 内存实现 + 接口定稿；顶替时**先 bind 新、再断旧** |
| B7 | 心跳：`ping`/`pong`、60s 无 `pong` 断连、`last_seen_at` 更新 |
| B8 | 转发：`req`/`res`/`cancel` + **`grant_update`/`grant_update_ack`**；`deadline_ms` 原样传播，`max_inflight` 限流，`drain` 时停路由；**`install` 未 ack 前不得为该 grant 路由**，`revoke` 先停路由再发帧（协议 §6.5） |
| B9 | 撤销：**先持久化 `status`**，再删路由、再发 `bye`/close（协议 §11.2） |
| B10 | 迁移 `0001`：`mcp_devices` 表 + **`mcp_grants` 表（最小列，见安全 §2.2）** + `startSweep` 清理过期 pending。**`mcp_grants` 必须在 1.2 建**：B14 / ST-1 的跨用户校验要读它，而 ST-1 是 1.2 的发布阻断项 |
| B11 | 运维：`/ready` 暴露 `instance_id`、`connection_count`；`GATEWAY_EXPECTED_REPLICAS>1` 拒绝启动 |
| B12 | **设备与 grant 的关系**：两表无外键、互不级联；撤销设备不撤 grant（安全 §4.1 规则 2） |
| B13 | **轮换的 `rotating` 状态**：② 提交后旧连接上的新 `req` 立刻回 `DEVICE_UNAUTHORIZED`（协议 §11.6） |
| B14 | **`mcp_devices` 与 grant 的跨用户校验**：转发前查 `grant.user_id == device.user_id`（ST-1） |

### 2.2 涉及模块

```
cloud/src/mcp-devices/{service.ts, routes.ts, claim.ts, rotate.ts}
cloud/src/link/{link-server.ts, handshake.ts, connection-registry.ts, forwarder.ts}
cloud/src/db/schema.ts                  （加 2 表：mcp_devices、mcp_grants；不动现有 6 张）
cloud/src/db/migrations/0001_remote_mcp.sql
cloud/src/app.ts                        （挂新路由；不碰现有 9 条）
cloud/tests/{mcp-devices,link}/*.test.ts
```

> **`auth_sessions.session_kind` 不在 1.2**：它只被 MCP OAuth 的 refresh 需要，
> 属 Phase 1.3（OQ-3 定稿后再加）。

### 2.3 测试要求

- 注册：公钥长度非法 / 设备数超限 / 重复公钥 → 各自 4xx ≥ 6 条
- **领取闭环**：无 claim → 403；错 claim → 403；未 active → 409；
  **并发两请求只有一个成功**（`Promise.all`，断言 1 个 200 + 1 个 409）≥ 8 条
- **凭证传输（1.0.3 新增）**：`claim_secret` **只出现在请求体**——断言
  (a) 请求行与 query 不含它；(b) 访问日志不含请求体；(c) 错误响应体不回显；
  (d) 用哨兵 claim（`SENTINEL-CLAIM-4b1d`）跑一次后 grep 全部日志 0 命中 ≥ 4 条
- 确认：错码 / 过期 / 已 active 幂等 / 错 5 次锁定 ≥ 6 条
- 握手校验 9 步逐项负例（token 错 / pending / suspended / revoked / nonce 重放 /
  ts 偏移 / 签名错 / 版本无交集 / 重复连接顶替）≥ 18 条
- **撤销顺序**：撤销后即使 `unbind` 抛错，用旧 token 握手仍被拒（断言）≥ 2 条
- 轮换：旧 token 立即失效、`rotating` 窗口内新 req 被拒、旧连接被 close `4010` ≥ 6 条
- 心跳：3 次丢失断连、`last_seen_at` 正确 ≥ 5 条
- 转发：正常 / 设备离线 / `max_inflight` 超限 / deadline 到点 / cancel / drain ≥ 10 条
- **Grant 上下文（P0-1）**：`hello_ok.grants` 只含同 user 且未撤销的 grant；
  `install` 未 ack 不路由；`revoke` 先停路由再发帧；ack 超时 → `grant_sync_lag`
  并暂停向该设备路由所有 grant ≥ 8 条
- **安全矩阵 ST-1 ~ ST-3、ST-11 ~ ST-12**（安全 §7.1）| 5 条，**全部发布阻断**
- 迁移：幂等、可重复跑、不破坏现有 6 张表 ≥ 3 条
- **回归**：现有 cloud **161** 条全绿

### 2.4 验收标准

1. 两台设备不能同时在线（旧连接被 `4006` 顶掉，旧设备侧**不重连**）。
2. 撤销设备后，用旧 `device_token` 握手返回 `4003`，且 `registry.lookup` 为 null。
3. **先 bind 后 `hello_ok`**：用一个在 `hello_ok` 后立刻发 `req` 的测试证明不丢。
4. **撤销顺序可测**：让 `unbind` 人为抛错，断言后续握手仍被拒（持久化优先）。
5. **并发领取只有一个成功**（条件 UPDATE 生效）。
6. **ST-1 / ST-2 / ST-3 / ST-11 / ST-12 全部通过**（跨用户 grant、token-signature 错配、
   轮换窗口、Cloud 重启不重放、撤销后握手）。
7. 已有 9 条身份路由的响应体逐字节不变（快照测试）。
8. 现有 6 张表结构未变（对比 `information_schema.columns` 快照）。
9. **Grant 上下文（P0-1）**：`hello_ok.grants` 只含 `grant.user_id == device.user_id`
   且 `revoked_at IS NULL` 的 grant；`install` 未 ack 时该 grant 的 `req` 不得转发；
   `revoke` 后旧 `grant_ctx` 在 Cloud 侧即被拒（ST-1 的补充，不替代 ST-1）。
10. **迁移幂等**：`grant_epoch` 列对已有行取默认值 0，重复执行不报错。

### 2.5 风险

- 首个长连接服务：Cloud 单实例重启时来不及发 `drain`，连接全断 → 设备退避重连。
  **接受**，但需在文档写明「重启会让在线设备短暂 DEVICE_OFFLINE」。
- `@hono/node-server` 的 `websocket` 注入需实测（`serve({ websocket: { upgrade } })`）。
- 单副本无法技术强制（协议 §12.2）：靠启动断言 + `/ready` + 部署清单。
- **与 1.1B 并行时的接口漂移**：靠 §5 的三条硬条件约束（协议冻结 + 同一 Mock 向量 + 独立验收）。
- **「1.2 通过」被误读为「链路打通」**：1.2 的 Mock Device 是按文档手写的对端，
  只能证明 Cloud 侧符合文档。集成结论必须留到 1.3 真实联调，见 §5.1 的验收边界表。

---

## Phase 1.3 — Cloud MCP 前端与独立 OAuth AS

### 3.1 范围

| # | 能力 |
|---|---|
| C1 | `POST /mcp`：`createMcpHandler` + `WebStandardStreamableHTTPServerTransport` |
| C2 | 工具面：8 个只读工具，schema 与 Desktop `TOOL_DEFINITIONS` 一致（一致性测试） |
| C3 | MCP OAuth AS：`/authorize`（含 consent 页）、`/token`（`grant_type` 双分支）、`/register`（DCR） |
| C4 | 元数据：`/.well-known/oauth-protected-resource`、`/.well-known/oauth-authorization-server` |
| C5 | 表：`mcp_oauth_clients`、`mcp_auth_codes`（**`mcp_grants` 已在 1.2 建**，本阶段只写入 grant，不重建） |
| C6 | Scope 校验：Cloud 侧**逐 grant**（按 `mcp_grants` 与上下文）+ Desktop 侧**逐请求**（按 `grant_ctx`） |
| C7 | 401 challenge：`WWW-Authenticate: Bearer resource_metadata="…"` |
| C8 | 日志纪律：只 tool/status/duration/error_code/delivery_id/**`jti` 前 8 位**/`grant_id`（安全 §3.2.1、协议 §13.3） |
| C9 | **MCP 专用 JWT**：`signMcpAccessToken` / `verifyMcpAccessToken`，`aud = MCP_RESOURCE`（≠ `brewphase-desktop`）；**不改**现有 `signAccessToken` |
| C10 | **会话归属**：按 OQ-3 结论落地（`mcp_sessions` 独立表 或 `auth_sessions.session_kind`），保证 MCP 登出不撤销 Desktop 登录 |
| C11 | **真实 ChatGPT 验收**（见 §3.4 门禁表）——只有这一阶段能做 |

### 3.2 关键差异（与现有登录 OAuth）

| 项 | 现有 `/oauth/*` | 新增 MCP AS |
|---|---|---|
| `redirect_uri` | **只允许** `http://127.0.0.1:<port>/callback`（正则硬编码） | 允许 DCR 注册的 https（或 localhost），**但仍精确匹配，不用通配** |
| `grant_type` | 无此字段（`tokenRequestSchema` 只有 code/verifier/redirect_uri） | 必须支持 `authorization_code` + `refresh_token` |
| scope | 无（JWT 无 scope claim） | 必须携带、必须校验、必须在同意页逐项展示 |
| `aud` | 硬编码 `brewphase-desktop` | `MCP_RESOURCE`（新常量），两套 token 互不通用 |
| 客户端 | 只有第一方 Desktop | 第三方（ChatGPT），需 `mcp_oauth_clients` |
| 用户同意 | 无 consent 页 | **必须有**（逐项列 4 个 scope） |

**必须新建路由组，不得改动现有 `/oauth/authorize` 的白名单**——那条白名单是
Desktop 登录的安全边界，放宽它等于允许任意站点做 redirect 劫持。

### 3.3 测试要求

- 授权码：PKCE S256、一次性、60s、`redirect_uri` 严格匹配 ≥ 12 条
- scope：请求多于授予 → 拒；token 的 `scope` 与 grant 一致 ≥ 8 条
- **`aud` 隔离**（双向）：Desktop 登录 token 打 `/mcp` → 401；MCP token 打
  `/auth/me` → 401 ≥ 4 条
- `/mcp`：无 token → 401 + `WWW-Authenticate`；错 `aud` → 401；撤销 grant → 401 ≥ 10 条
- **`/mcp` 重放语义（P0-2 回归门禁，ST-25 / ST-26）**：同一 access token 连续 10 次
  `tools/call` 全部成功；并发 2 次同 `jti`、来源指纹不同 → 两次都成功、只告警不返回 4xx
  （安全 §3.2.1、生命周期 §15.2）≥ 4 条。**任何「按 `jti` 去重」的实现都会让本组测试变红**
- **Grant 上下文（P0-1，Cloud 侧）**：`revoke` 后必发 `grant_update` 且 `epoch` 严格递增
  （重发同 `epoch` 视为幂等、不得降级）；`install` 未 ack 前不向该 `grant_ctx` 路由；
  同一设备两个 grant 的 `req` 各自携带自己的 `grant_ctx`，路由互不串 ≥ 10 条
- **审计可关联**：Cloud 日志能由 `jti` 前 8 位 + `grant_id` 还原一次调用的 grant 与客户端，
  但不含 token 原文、工具参数、结果 ≥ 3 条
- 工具一致性：Cloud 的 8 个 schema 与 Desktop 深度相等（fixture 对比）
- 日志：用含哨兵字符串的参数跑一次，grep 日志与 DB，0 命中
- **回归**：cloud 161 条 + Desktop 949 条全绿；现有 9 条身份路由响应不变

### 3.4 验收标准

1. 用 MCP 官方 client（`@modelcontextprotocol/client`）完成：
   `initialize` → `tools/list`（8 个）→ `tools/call search_records` → 拿到数据。
2. 撤销 grant 后同一 token 立即 401（不是等 15 分钟）。
3. 授权页正确列出 4 个 scope 与对应数据范围的可读描述。
4. 现有 Desktop 登录流程**完全不受影响**：`/oauth/authorize` 传非 127.0.0.1
   的 `redirect_uri` 仍返回 400；登录 token 仍只能用于 `/auth/*`。
5. **同 token 多次调用不被误杀（P0-2）**：一个 15 分钟 TTL 的 access token 在其生命周期内
   连续完成 10 次 `tools/call` 全部成功（ST-25）；日志里只有 `jti` 前 8 位，无完整 token、
   无工具参数、无结果。**「按 `jti` 去重」的实现直接判不通过**。
6. **撤销的授权闭环（P0-1，Cloud 侧）**：撤销 grant 后 Cloud 在该 WSS 上发
   `grant_update`（`epoch+1`）→ Desktop 回 `grant_update_ack` → 之后同 token 的新调用 401；
   若 ack 超时，按 fail-closed 处理：Cloud **暂停向该设备路由全部 grant**（不只被撤销的
   那一个），直到重新握手（协议 §6.5.2 规则 3）。

**真实 ChatGPT 验收门禁（本阶段独有，缺一不可通过）**：

| # | 门禁 | 通过判据 | 失败后果 |
|---|---|---|---|
| G1 | OAuth 授权完成 | ChatGPT 能走完 authorize → consent → token，拿到可用于 `/mcp` 的 token | 阶段不通过 |
| G2 | `initialize` + `tools/list` | 列出 8 个工具且描述可读 | 阶段不通过 |
| G3 | 一次真实 `tools/call` | 返回真实数据（与桌面端一致） | 阶段不通过 |
| G4 | 撤销后立即失效 | Web 撤销 grant 后：(a) ChatGPT 下一次调用收到 401（Cloud 侧立即，不等 token 过期）；(b) 撤销瞬间已在途的调用，Desktop 回 `GRANT_REVOKED` 且**不回传数据**（P0-1 闭环） | 阶段不通过 |
| G5 | 离线语义 | 关闭桌面端后，ChatGPT 收到 `DEVICE_OFFLINE` 而不是超时/空结果 | 阶段不通过 |
| G6 | 是否需要 DCR / `outputSchema` / SSE | **记录实测结论**，回填协议 §15.1 的 B 层 | 不阻塞通过，但必须记录 |

**不得把 Mock 结果当成 G1–G5 的证据。** 若无法进行真实联调，本阶段只能标记为
`NOT VERIFIED`，并按 1.0.1 的 OQ-B/OQ-C 保留开放状态。

### 3.5 风险

- **ChatGPT 的 MCP OAuth 实现细节未验证**（DCR 是否必需、是否要求 `resource`
  参数、是否支持 `refresh_token`）——本阶段最大不确定性，必须尽早真实联调。
- `outputSchema` / `annotations` 是否被要求，会影响工具描述形态。
- HS256 对称密钥意味着 AS 与 `/mcp` 校验方共用同一 secret（同一进程内可接受）；
  若未来拆分服务，需改 RS256 或共享密钥管理——**本阶段不拆**。

---

## Phase 1.4 — 多实例与多设备

| # | 范围 |
|---|---|
| D1 | `ConnectionRegistry` Redis 实现（`mcp:conn:*` + pub/sub 路由），接口不变 |
| D2 | 限流改共享存储（现有 `rate-limit.ts` 的接口不变，换实现） |
| D3 | 多设备：`mcp_devices.is_primary` + 用户选择 + 单用户多连接（OQ-9 定稿后） |
| D4 | 滚动部署：`drain` 路径实测（`4011` → 退避重连） |
| D5 | 指标：在线设备数、转发延迟 P50/P95、错误码分布、`REMOTE_DISABLED` 计数（观测 Cloud 状态同步失败） |
| D6 | 解除单副本限制：移除 `GATEWAY_EXPECTED_REPLICAS` 启动断言 |

**验收**：两台 Gateway 实例 + 一台 Desktop，请求随机打到任一实例都能正确路由；
杀掉持有连接的那台，Desktop 在 5s 内退避重连到另一台，期间请求返回 `DEVICE_OFFLINE`
而不是挂起。**且 `GATEWAY_EXPECTED_REPLICAS=2` 启动断言不再阻止启动。**

**前置**：必须先有 Redis（或 PG `LISTEN/NOTIFY`）。部署形态待确认（OQ-A）。

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

| 门禁 | 基线（Phase 1.0 结束时实测，**1.0.1 / 1.0.2 未重跑**） |
|---|---|
| Desktop 单测 | 949 passed / 72 files |
| Cloud 单测 | 161 passed / 13 files |
| Desktop `typecheck` / `build` | ✅ / ✅ |
| `mcp:build` | ✅ 911.67 kB（`out/mcp/stdio.mjs`） |
| Cloud `typecheck` / `lint` / `build` | ✅ / ✅ / ✅ |

**Cloud 测试前置**：需 `brewphase-cloud-test-pg` 容器在 54329（当前在跑）。
容器不在时 `global-setup` 直接 throw，不是测试失败。

> Phase 1.0.1 / 1.0.2 **只改文档**，因此上表是引用值，不是本次执行结果。
> **任何后续阶段的实际数字必须来自当次运行。**

### 4.1 安全测试矩阵归属 + 发布阻断项汇总（跨阶段）

**测试用例的完整定义（阶段 / 位置 / 预期结果 / 阻断级别）在 `REMOTE_MCP_SECURITY_OPERATIONS.md` §7.1（ST-1~ST-26，共 26 条）。**
本节的职责是**认领**：每个阶段必须实现哪些用例、哪些未通过不得发布。

以下任一项未通过，**不得发布**（即使阶段验收的其他项都过）：

| 阻断项 | 所属阶段 | 依据 |
|---|---|---|
| CB-5 ~ CB-8（审计只记写工具的四条分支） | 1.1A | §1A.4 |
| ST-4（用户切换不继承设备） | 1.1B | 安全 §7.1 |
| ST-5（关开关时到达的 req 不进业务层） | 1.1B | 安全 §7.1 |
| ST-6（`request_hash` 不一致必须拒绝） | 1.1B | 安全 §7.1 |
| ST-7（同 `delivery_id` 只执行一次） | 1.1B | 安全 §7.1 |
| ST-8（不同 `delivery_id` 必须各执行一次） | 1.1B | 安全 §7.1 |
| ST-9（改系统时间不延长 deadline） | 1.1B | 安全 §7.1 |
| ST-10（审计失败时 `res.ok` 仍为 true，且计数可见） | 1.1B | 安全 §7.1 |
| ST-13（登出后 Cloud 连接表无残留项） | 1.1B + 1.2 | 安全 §7.1 |
| ST-14（忘记设备时云端不可达仍完成本地清理） | 1.1B | 安全 §7.1 |
| ST-16（执行中关闭开关后，同 `delivery_id` 重投必须重新走准入） | 1.1B | 安全 §7.1 |
| ST-17（用户切换后崩溃重启，不自动连旧设备） | 1.1B | 安全 §7.1 |
| ST-18（`grant_ctx` 无效必须拒，且不查缓存） | 1.1B | 安全 §7.1 |
| ST-19（上下文 `bound_user_id` 不匹配 → 阻断） | 1.1B | 安全 §7.1 |
| ST-20（同设备多 Client scope 隔离，缓存不串） | 1.1B | 安全 §7.1 |
| ST-21（撤销后旧请求不得回放缓存） | 1.1B | 安全 §7.1 |
| ST-22（撤销时在途结果不得外传） | 1.1B | 安全 §7.1 |
| ST-23（`grant_update` 重复/乱序/回退幂等） | 1.1B | 安全 §7.1 |
| ST-24（重连快照替换，旧上下文失效） | 1.1B | 安全 §7.1 |
| ST-25（同 token 连续 10 次调用不得被拒） | 1.3 | 安全 §7.1 |
| ST-26（同 token 并发 + 来源指纹不同 → 告警不拒绝） | 1.3 | 安全 §7.1 |
| ST-1（grant 与 device 跨用户必须拒） | 1.2 | 安全 §7.1 |
| ST-2（token 与签名错配必须拒） | 1.2 | 安全 §7.1 |
| ST-3（轮换后旧连接不得收新请求） | 1.2 | 安全 §7.1 |
| ST-11（重连不得重放旧请求） | 1.2 | 安全 §7.1 |
| ST-12（撤销后握手必须拒） | 1.2 | 安全 §7.1 |
| 哨兵字符串 0 命中 | 1.1B + 1.2 | 安全 §6.5.9 |
| 现有 9 条 Cloud 身份路由响应不变 | 1.2 | §2.4 |
| Local `TOOL_NAMES` 与 `stdio.mjs` 不变 | 1.1A + 1.1B | §1A.6 / §1B.7 |

**ST-13 是发布阻断项（Phase 1.0.3 修正）**：1.0.2 的阶段文档曾把它写成「不阻断」
（理由是「已在 ST-4/ST-14 的机制下覆盖」），但安全模型 §7.1 标的是 `✅ 是`。
**以安全文档为准**——它测的是「Cloud 侧连接表有没有残留」，ST-4 测的是「Desktop
不继承设备」，ST-14 测的是「本地清理」，三者断言对象不同，不能互相替代。
**除 ST-15 外，ST-1~ST-26 全部为发布阻断项。**

---

## 5. 依赖关系图

```
1.0.1 文档硬化（已完成）
   │  仅文档 + OAuth Spike 设计
   ▼
1.0.2 文档硬化（已完成）
   │  审计策略 / request_hash / 身份生命周期 / 阶段拆分 / 测试矩阵
   ▼
1.0.3 最终一致性修订（本次）
   │  ST-13 / 1.1B-1.2 依赖 / claim 传输 / 计数生命周期 / 竞态测试
   ▼
1.1A 共享执行层 ──► 1.1B Desktop Agent ──┬──► 1.2 Cloud 设备面 ──► 1.3 MCP 前端 ──► 1.4 ──► 1.5
   只抽 executeTool      设备身份/准入/审计  │   P1+P2+P3 全满足才并行
   不接远程 / 不建 WSS    Mock Gateway      │   否则串行：1.1B 完成后再开 1.2
   949 条 + CB-1..16 验收                   │
                                            └─ 并行 ≠ 跳过前置（§5.1）；两次 Mock 通过 ≠ 集成通过
```

**依赖关系的准确表述（Phase 1.0.3 定稿）**：

| 关系 | 表述 | 说明 |
|---|---|---|
| 1.1A → 1.1B | **硬依赖** | 1.1B 的 `executeTool` 调用面由 1.1A 产出；没有它就只能复制 handler |
| 1.1B → 1.2 | **条件依赖**（可并行） | 只有 P1/P2/P3 同时满足才是并行；否则退化为「1.1B 完成后串行开 1.2」 |
| 1.1B + 1.2 → 1.3 | **硬依赖** | 1.3 需要两端真实可跑；Mock 级通过不足以开 1.3 的联调门禁 |

### 5.1 「可并行」的三条硬条件

1.1B 与 1.2 **可以并行开发**，但必须同时满足以下三条，缺一不可。
另有一条**总前置**：**1.1A 已验收通过**（总原则「上一阶段不通过不开始下一阶段」
不允许被并行绕过——否则 1.1A 的等价性一旦被推翻，两端都要返工）。

| # | 条件 | 判定方式 |
|---|---|---|
| **P0** | **1.1A 已验收**：Local 949 条 + CB-1~CB-16 全过，`TOOL_NAMES` 与 `stdio.mjs` 不变 | §1A.6 验收单 |
| **P1** | **协议合同冻结**：双方实现的是同一份 `REMOTE_MCP_PROTOCOL.md` 的同一版本（当前 `v: 1`）；任何一方需要改帧结构，必须先改文档并通知另一方，不得私下扩展字段 | 双方指向同一 doc commit；文档里记录「协议冻结点」 |
| **P2** | **同一套 Mock 测试向量**：`Desktop/tests/helpers/mock-gateway.ts` 与 `cloud/tests/helpers/mock-device.ts` 使用**同一组**帧 fixture（同一份 JSON 文件），不是各自手写 | fixture 文件在共享位置，两边测试都 import 它 |
| **P3** | **各自独立验收，不联合验收**：1.1B 用 Mock Gateway 验收，1.2 用 Mock Device 验收；**不存在「两边一起测才算过」的阶段** | 各自 §1B.7 / §2.4 可单独执行 |

**如果 P2 做不到**（两边 fixture 各自维护），则**不允许并行**——
必须串行（1.1B 完成并冻结帧格式后再开 1.2）。因为「两边手写的 Mock」
几乎必然在某天开始不一致，而症状是「集成时才发现的诡异超时」。

**并行期的验收边界（最容易被夸大的一条）**：

| 已完成 | 能得出的结论 | **不能**得出的结论 |
|---|---|---|
| 1.1B 全部验收通过 | Desktop 侧符合协议 v1，准入链无漏洞 | ❌「远程链路已打通」 |
| 1.2 全部验收通过 | Cloud 侧符合协议 v1，连接管理正确 | ❌「ChatGPT 已经能查数据」 |
| 两者都通过 | 两端各自自洽 | ❌「端到端集成已验收」——Mock 是各自按文档手写的对端，**两端同时偏离文档时仍会各自通过** |

**端到端集成验收的唯一时机**：1.3 的真实联调（`/mcp` + 真实 Cloud WSS）。
在 1.3 之前，任何报告只能写「Mock 级通过」。

### 5.2 为什么 1.1A 必须先做

如果 Remote 先直接调 `HANDLERS` 跑起来，再回头抽执行层，
就要同时改「已跑通的 Remote 路径」与「Local 路径」——回归面翻倍。
**先抽取、后接入**，Local 的 949 条 + CB-1~CB-16 就是现成的等价性证明。

### 5.3 为什么 1.1A 可以完全独立

它只动 `src/main/application/mcp-tools/` 与 `request-router.ts` 一个文件，
不碰网络、不碰 IPC、不碰设置界面。失败时回滚一个纯重构即可。

---

## 6. 本阶段（1.0 / 1.0.1 / 1.0.2 / 1.0.3）的实际交付

| 文档 | 核心内容 |
|---|---|
| `REMOTE_MCP_ARCHITECTURE.md` | 27 工具实测、共享执行层（§6.5）、Bridge 边界、Cloud 9 路由、`redirect_uri` 硬限制、设备模型缺失、12 原则判定、8 工具面、B1–B7 阻塞项、**23 项 OQ 总表**、**阶段依赖三性质与「Mock ≠ 集成」**、**时间术语** |
| `REMOTE_MCP_SECURITY.md` | 五层权限、设备四凭证与注册闭环（`claim_secret` 走 POST 体）、4 个远程 scope、五个状态机、撤销顺序、审计方案 A、**审计三段分离与 best-effort 承诺（计数器为进程内状态）**、**启动即校验（不依赖 UI）**、**Grant 授权上下文（P0-1）**、**`jti` 语义（P0-2）**、T1–T19、**ST-1~ST-26 测试矩阵** |
| `REMOTE_MCP_PROTOCOL.md` | **19 个错误码 + 14 个 close code**、握手校验 9 步 + `hello_ok` 构造（共 10 项）+ **Grant 上下文帧（P0-1）**、**Unix epoch / monotonic 二分**、`delivery_id` + **`request_hash`**、六种重复投递情况、**缓存双上限 + 关闭开关即清空 + 逐 grant 键**、四个竞态场景 R1–R4、退避、撤销顺序、用户切换与轮换、多实例路由、OAuth 三层分离、**`/mcp` 重放语义（P0-2）** |
| `REMOTE_MCP_PHASES.md` | **1.1A / 1.1B 拆分**、CB-1~CB-16 行为对照表、Spike 五级状态码、**发布阻断项汇总（除 ST-15 外全部阻断）**、**并行四条件 P0–P3**、1.2/1.3（含真实 ChatGPT 门禁 G1–G6）/1.4/1.5 |

**未产生**：任何功能代码、数据库迁移、路由改动、配置改动、依赖变更、commit/push/merge。
**未执行**：任何 Spike、任何测试（三轮修订均为纯文档工作）。

> **Phase 0（P0-1 / P0-2）是 1.0.3 之后的独立一轮文档修订**，不改变上述 1.0.x 的交付结论，
> 也不改变阶段划分与阶段归属。它只做两件事：把 Grant 授权上下文闭环写进协议
> （`hello_ok.grants` / `grant_update` / `req.grant_ctx`，安全 §2.7、协议 §6.5），
> 把 `jti` 的语义定死为 **token 级、不做请求级去重**（安全 §3.2.1、生命周期 §15.2）。
> 逐条索引见 `REMOTE_MCP_INDEX.md` §7。
