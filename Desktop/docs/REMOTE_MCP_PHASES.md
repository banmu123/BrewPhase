# BrewPhase Remote MCP — 实施阶段（Phase 1.0 / 1.0.1 / 1.0.2 / 1.0.3 设计产出）

> 依据 `REMOTE_MCP_ARCHITECTURE.md` / `REMOTE_MCP_SECURITY.md` / `REMOTE_MCP_PROTOCOL.md`。
> 每个阶段都必须独立可验收、可回滚。**上一阶段验收不通过，不开始下一阶段。**
> 修订：**Phase 1.0.1**、**1.0.2**、**1.0.3**（2026-11-17），基线 `feature/remote-mcp` @ `89866cd`。

## 0.0 Phase 1.0.3 修订摘要（本文）

| # | 修订点 | 原因 |
|---|---|---|
| 1 | **ST-13 改为发布阻断项**（§4.1 阻断清单补入），ST-15 仍为非阻断体验项 | 1.0.2 安全模型标 ST-13 为 ✅ 阻断，阶段文档却写「不阻断」——同一事项两个结论 |
| 2 | §0 总览表与 §5 依赖图重写 1.1B/1.2 的关系 | 「1.2 前置 = 1.1B」与「可并行」需要写成**带条件的并行**，并明确「各自 Mock 验收 ≠ 端到端集成验收」 |
| 3 | §2.3 设备领取改为 `POST` 请求体，并新增传输纪律 | query 会进 access log；凭证不该出现在 URL 里 |
| 4 | §1B.7 验收补 **ST-16 / ST-17** | 关闭开关与重复投递的竞态、用户切换后的崩溃恢复，都没有验收项 |
| 5 | §4.1 阻断清单扩到 ST-1~ST-17（除 ST-15） | 安全文档是唯一权威，阶段必须逐条认领 |
| 6 | §0.1.4 准入表随 1.0.3 更新 | 准入条件必须反映最终文档，而不是 1.0.2 的中间态 |

## 0.0.1 Phase 1.0.2 修订摘要（本文，保留）

| # | 修订点 | 原因 |
|---|---|---|
| 1 | **Phase 1.1 拆成 1.1A / 1.1B**（§1A / §1B） | 原文「1.2 依赖 1.1」与「可与 1.2 并行」自相矛盾；执行层抽取本身可独立验收 |
| 2 | §0 阶段总览与 §5 依赖图重写 | 同上，且明确「并行 ≠ 跳过前置」 |
| 3 | §0.1.3 Spike 表改用 **五级状态码**（D/P/L/E/C） | 原文只有「待执行/待联调」，无法区分「方案已设计」与「已跑通」 |
| 4 | 新增 §4.1 **安全测试矩阵归属 + 发布阻断项汇总**（ST-1~ST-15 → 阶段）〔1.0.3 已扩到 ST-1~ST-17〕 | 安全文档有了用例，阶段文档必须认领，否则没人实现 |
| 5 | 1.1A / 1.1B / 1.2 的验收条件分别补齐 | 拆分后原验收项混在一起，无法独立判定 |
| 6 | 各阶段标注**发布阻断项** | 「通过验收」与「可以发布」是两件事 |

## 0. 阶段总览

| 阶段 | 目标 | 产出 | 前置依赖 | 风险 |
|---|---|---|---|---|
| **1.0.1** | 设计修订 + OAuth 兼容性 Spike（仅文档 + 只读验证） | 四份文档 1.0.1 修订、OQ 清单、状态机、安全决策 | 1.0 | 低 |
| **1.0.2** | **设计硬化：审计策略、`request_hash`、身份生命周期、阶段拆分、测试矩阵** | 四份文档 1.0.2 修订 | 1.0.1 | 低 |
| **1.0.3** | **最终一致性修订：ST-13 阻断级别、1.1B/1.2 依赖、`claim_secret` 传输、审计计数生命周期、竞态与崩溃恢复测试、时间术语** | 四份文档 1.0.3 修订 | 1.0.2 | 低 |
| **1.1A** | **共享 Tool Execution Layer**（只抽执行层，**不接远程**） | `src/main/application/mcp-tools/`；`request-router.ts` 改调 `executeTool` | 1.0.3 | 中（唯一一次动 Local 代码） |
| **1.1B** | **Desktop Remote Agent**（设备身份 + 出站 WSS + 准入 + 审计） | `src/main/remote/`、Mock Gateway | **1.1A** | 中（长连接与定时器） |
| 1.2 | Cloud 设备面：注册 / 确认 / 领取 / WSS 接入 / 连接表 / 转发 | `cloud/src/mcp-devices/`、`cloud/src/link/` | 1.1A（硬）+ 1.1B（并行需 P1/P2/P3 全满足；否则等 1.1B 完成再串行，见 §5） | 中（首个长连接服务） |
| 1.3 | Cloud MCP 前端：`/mcp` + 独立 MCP OAuth AS + 真实 ChatGPT 验收 | `cloud/src/mcp/`、`cloud/src/oauth-mcp/` | 1.2 | **高**（OAuth 语义 + ChatGPT 兼容性） |
| 1.4 | 多实例与多设备；审计熔断评估（OQ-5） | `cloud/src/link/registry-redis.ts` | 1.3 | 中（部署形态未定） |
| 1.5 | 可选增强：E2E 加密、写入工具、SSE 长连接 | — | 1.4 + 产品决策 | 高（改变信任模型） |

**关键排期判断**：

- **1.1A 必须先于 1.1B**：如果 Remote 先直接调 `HANDLERS` 跑起来，再回头抽执行层，
  就要同时改「已跑通的 Remote」与「Local 两条路径」，回归面翻倍。
- **1.1B 与 1.2 可以在协议冻结后并行**，但**并行不等于跳过前置**——三条硬条件见 §5.1。
  任一条件不满足（尤其 P2 共享 fixture），必须**串行**。
- **并行期的两次通过都不是集成通过**：1.1B 用 Mock Gateway 验收、1.2 用 Mock Device
  验收，各自只能证明「本方符合协议」；**端到端集成验收只能在 1.3 之前联调时做**。
  任何阶段报告都不得把「1.1B ✅ + 1.2 ✅」写成「远程链路已打通」。
- 1.3 是最容易翻车的阶段（OAuth 兼容性），必须留出真实 ChatGPT 联调时间。

---

## Phase 1.0.1 — Architecture & Protocol Hardening（已完成）

### 0.1.1 范围

**只改四份 Markdown 文档 + 一次只读兼容性 Spike。不写功能代码、不改 Cloud、
不改数据库、不提交不推送。**

| # | 产出 | 状态 |
|---|---|---|
| R1 | 四份文档一致性修订（七项主题） | ✅ 完成 |
| R2 | `OPEN QUESTION` 清单（架构 §7.3、安全 §9、协议 §8.9） | ✅ 完成 |
| R3 | 五个状态机（安全 §4.0） | ✅ 完成 |
| R4 | 关键安全决策记录（设备四凭证、审计方案 A、撤销顺序、去重语义） | ✅ 完成 |
| R5 | Phase 1.1A 准入检查表（§0.1.4） | ✅ 完成 |
| R6 | **OAuth 兼容性 Spike（不修改生产代码）** | ⏳ **设计完成，未执行**（见 §0.1.3） |

### 0.1.2 技术债/矛盾关闭清单

| 原矛盾 | 关闭方式 | 位置 |
|---|---|---|
| 「直接调 `HANDLERS`」会绕过 Zod/scope/审计 | 抽 `executeTool`，两入口共用 | 架构 §6.5 |
| A10 要 `channel` vs 1.1.2 禁止迁移 | 方案 A：`client_id='remote:<device_id>'` | 安全 §6.5 |
| `sha256(tool+args)` 会把独立查询误合并 | 只按 `delivery_id` 去重；`request_hash` 仅校验同 id 内容 | 协议 §8 |
| 「先断连再清凭据」在断网时失效 | 改为「先持久化 → 再清理」 | 协议 §11 / 安全 §4.1 |
| `connection_id` 每帧携带 vs 连接上下文 | 明确只在 `hello_ok` 出现 | 协议 §4.4 |
| 版本协商公式不完整 | 给出 `lo=max(min)` / `hi=min(max)` 判定 | 协议 §1.1 |
| `session_kind='mcp'` 不存在 | 标为 OQ-3 + B7 | 安全 §3.2 / 架构 §7.1 |
| 「复用 JWT」但 `aud` 硬编码 | 新增 MCP 专用签发/校验路径 | 安全 §3.2 / 架构 B6 |
| 未知 `req` 被静默忽略会永久等待 | 「只有 `req` 必须回应」规则 | 协议 §2.2 |
| **审计失败 → 查询仍成功，算不算「有审计」** | 三段状态分离 + best-effort 承诺（1.0.2） | 安全 §6.5.5 |
| **「1.2 依赖 1.1」vs「可与 1.2 并行」** | 拆 1.1A/1.1B + 并行三条件（1.0.2） | 本文 §5 |

### 0.1.3 Spike 状态（Phase 1.0.2 改用五级状态码）

**状态码定义（必须严格使用，不得混用）**：

| 码 | 含义 | 判据 |
|---|---|---|
| **D** | 设计已完成 | 文档写清了要验证什么、怎么验、判据是什么 |
| **P** | 验证方案已确定，未执行 | 有可执行的命令/脚本步骤，但没跑过 |
| **L** | 本地实验已通过 | 在本机 **系统 Node / 非生产环境** 跑通，有输出证据 |
| **E** | Electron 实机已通过 | 在 Electron 主进程内跑通（`app.evaluate` 或打包产物） |
| **C** | ChatGPT 真实联调已通过 | 真实 ChatGPT 客户端走通，有会话记录 |

**「P」不等于「L」，更不等于「已通过」。** 本表当前状态：

| # | 待验证 | 验证方式 | 层 | 状态 |
|---|---|---|---|---|
| S1 | MCP SDK 能否在本仓库跑起 `/mcp` | `cloud/` 临时目录（不提交）用 `createMcpHandler` + `WebStandardStreamableHTTPServerTransport` 起 echo server，用 `@modelcontextprotocol/client` 走 `initialize`→`tools/list`→`tools/call` | A | **P** |
| S2 | `buildOAuthProtectedResourceMetadata` 输出形状 | 调用该函数打印 JSON，对照 RFC 9728 | A | **P** |
| S3 | `requireBearerAuth` 的 `resource` 校验 | 传错 `aud` 的 token，确认拒绝 | A + C | **P** |
| S4 | ChatGPT 是否要求 DCR | 无法本地验证 | B | **P**（只能等 C） |
| S5 | ChatGPT 是否要求 `outputSchema` / SSE | 无法本地验证 | B | **P**（只能等 C） |
| S6 | `resource` 参数是否被 ChatGPT 发送 | 无法本地验证 | B | **P**（只能等 C） |
| S7 | Electron 45 主进程 `WebSocket` | `app.evaluate(() => typeof WebSocket)` + 实际建连 | — | **P**（1.1B 第一天必须转 E） |
| S8 | Electron 主进程 Ed25519 往返 | `app.evaluate` 跑 `generateKeyPairSync('ed25519')` + sign/verify | — | **L**（系统 Node v22.22.2 已通过）→ 需补 **E** |

**S8 的诚实说明**：本地实验（L）用的是**系统 Node v22.22.2**，不是 Electron 内置运行时。
两者的 `node:crypto` 实现理论上一致，但**未验证**。因此 S8 在 Electron 内的状态仍是
**P→L 之间**，必须由 1.1B 第一天补 E。

**S7 是 1.1B 的开工门禁**：若 `typeof WebSocket === 'undefined'`，
需要加 `ws` 依赖（此时 1.1B 的依赖清单变化，需在开工前记录）。
**它在转 E 之前，1.1B 不得合并任何 WSS 代码。**

**S1–S3 是 1.3 的开工门禁**：它们可以在 1.1A/1.1B 期间任意时间做（只读、不改生产代码），
但 1.3 开工前必须至少 **L**。

**S4–S6 只有 C 才有意义**：任何文档都不得基于「推测 ChatGPT 如何」写死实现。

### 0.1.4 Phase 1.1A 准入检查表（Phase 1.0.3 定稿）

进入 Phase 1.1A（只抽执行层）前必须全部满足：

| # | 条件 | 当前 | 依据 |
|---|---|---|---|
| 1 | 四份文档的 scope 集合一致（4 个只读） | ☑ | 架构 §6.8 / 安全 §2.4 / 协议 §4.4 / 本文 §1B.3 |
| 2 | 8 个远程工具清单四份文档一致 | ☑ | 同上 |
| 3 | 审计方案已定（方案 A），且 1.1 不需要迁移 | ☑ | 安全 §6.5.2 |
| 4 | 审计三段分离（准入/业务/审计）已定义 | ☑ | 安全 §6.5.5 |
| 5 | **审计失败计数器为进程内状态**已写明，且 UI 不得谎称历史已补齐 | ☑ | 安全 §6.5.6 |
| 6 | 撤销顺序唯一（先持久化 → 再清理） | ☑ | 安全 §4.1 / 协议 §11 |
| 7 | 去重语义唯一（`delivery_id` 去重 + `request_hash` 校验） | ☑ | 协议 §8 |
| 8 | **缓存命中在准入之后**，且关闭开关时清空缓存 | ☑ | 协议 §8.5 |
| 9 | `executeTool` 的代码边界明确（新增 3 文件 + 改 1 文件） | ☑ | 架构 §6.5.3 |
| 10 | 错误码表唯一（17 个），`REMOTE_DISABLED` 已纳入 | ☑ | 协议 §9.1 |
| 11 | 五个状态机与「本地开关优先」已定 | ☑ | 安全 §4.0 |
| 12 | Local 949 条基线可复现（作为抽取等价性证明） | ☑（1.0 实测，1.0.2/1.0.3 未重跑） | 本文 §4 |
| 13 | 1.1A 的验收办法不只依赖「测试数不变」，还有行为对照表 | ☑ | §1A.4 |
| 14 | **`claim_secret` 只走 POST 请求体**，四条传输纪律已定 | ☑ | 协议 §3.4 |
| 15 | **ST-1~ST-17 的归属与阻断级别已认领**（ST-13/16/17 均为阻断） | ☑ | 安全 §7.1 / 本文 §4.1 |
| 16 | **时间术语唯一**（Unix epoch 跨进程 / monotonic 进程内） | ☑ | 协议 §2.1 / §7.1 |
| 17 | OQ 清单中**没有**标记为「阻塞 1.1A」的未决项 | ☑（0 项） | 架构 §7.3 |

**结论（文档层面）：`READY FOR PHASE 1.1A`**。

⚠️ **两处仍是「方案已定、未执行」，不影响开工但必须在开工后立刻处理**：
S1–S3 的 Spike（只读，1.3 前需转 L）；Local 949 条的**当次**复跑
（1.0.3 只改文档，未跑测试——开工第一件事是记录基线，见 §1A.5 / §1A.6）。

**Phase 1.1B 的额外门禁**（不在本表，见 §4.1 与 §1B.6）：
S7 转 **E**（Electron `WebSocket` 可用）；Mock Gateway 帧集合与协议 §2 一致；
ST-4~ST-10、ST-13~ST-17 的用例已实现（可以先红）。

---

## Phase 1.1A — 共享 Tool Execution Layer

> **本阶段不接远程请求、不建 WSS、不做设备注册。** 它唯一的目标是把
> 「scope → Zod → handler → 错误映射 → 审计」抽成一个入口，
> 让 Local 与（未来的）Remote 共用，**且 Local 行为逐项不变**。

### 1A.1 范围（做什么）

| # | 能力 | 说明 |
|---|---|---|
| A-1 | `ToolServices` 类型 | 5 个 service（records / coffee / canvas / workContexts / personalDirection）；**无 `db`、无 `clients`** |
| A-2 | `handlers.ts` | 27 个 handler **原样搬移**（每行仍是 `ctx.services.x.y(...)`，零逻辑改动） |
| A-3 | `tool-executor.ts` | `executeTool()`：tool 存在性 → scope → Zod → handler → 错误映射 → `ctx.audit` |
| A-4 | `request-router.ts` 改造 | `routeBridgeRequest` 内部改调 `executeTool`；协议版本 / method / 工具白名单 / `authenticate` / 幂等 / 错误码 **逐字保留** |
| A-5 | 等价性对照测试 | 新增 `mcp-executor.test.ts`：对 27 个工具逐一断言「抽取前后」的返回形状与错误码 |

### 1A.2 明确不做（护栏）

- ❌ 不新增 `src/main/remote/`（一行都没有）
- ❌ 不引入任何 WSS / WebSocket 依赖
- ❌ 不做设备注册、不生成 Ed25519 密钥
- ❌ 不新增 `remote:*` IPC
- ❌ **不改 `mcp_operation_log` 结构、不加迁移**
- ❌ 不改 `src/mcp/*`（Local MCP 进程）
- ❌ 不改 `bridge-server.ts` / `bridge-client.ts` / `sync/*`
- ❌ 不改 Local 的认证、授权、白名单、幂等、错误码
- ❌ 不改 `routeBridgeRequest` 的签名

### 1A.3 代码模块

```
Desktop/src/main/application/mcp-tools/     （新增）
├── tool-services.ts          ToolServices 类型
├── handlers.ts               27 个 handler（原样搬移）
└── tool-executor.ts          executeTool()

Desktop/src/main/mcp-bridge/request-router.ts   （改，唯一触碰的既有文件）
   - HANDLERS 移到 mcp-tools/handlers.ts
   - routeBridgeRequest 内部改调 executeTool
   - 其余逐字保留；签名不变

Desktop/tests/unit/mcp-executor.test.ts     （新增）
```

**为什么 1.1A 是独立阶段**：它是唯一一次动 Local 生产代码的改动，
而 Local 已经在用户手里跑（27 工具、Windows Named Pipe、真实客户端）。
把它单独拎出来，失败时只需回滚一次纯重构，不会连带回滚远程功能。

### 1A.4 关键行为对照表（不只靠「测试数不变」）

**949 条全绿是必要条件，不是充分条件。** 因为测试可能恰好没覆盖到被改的路径。
因此必须另外做一张**逐项对照**，每项都有可观察的判据：

| # | 行为 | 抽取前（基线，需先记录） | 抽取后必须一致 | 断言方式 |
|---|---|---|---|---|
| CB-1 | 未知 tool 名 | `VALIDATION_ERROR` + `unknown tool: X` | 相同 | 直接调 `routeBridgeRequest` |
| CB-2 | 协议版本不匹配 | `BRIDGE_PROTOCOL_MISMATCH` | 相同 | 传 `protocolVersion: 999` |
| CB-3 | 非 `tools.call` 方法 | `VALIDATION_ERROR` + `unsupported method` | 相同 | 传 `method: 'x'` |
| CB-4 | token 无效 | `UNAUTHORIZED` + 固定文案 | 相同（**不区分「不存在」与「已撤销」**） | 三种 token 各一次 |
| CB-5 | scope 不足（写工具） | `PERMISSION_DENIED` + **写审计** | 相同（审计行数 = 1） | 查 `mcp_operation_log` |
| CB-6 | scope 不足（读工具） | `PERMISSION_DENIED` + **不写审计** | 相同（审计行数 = 0） | 同上 |
| CB-7 | 参数非法（写） | `VALIDATION_ERROR` + 写审计 | 相同 | 同上 |
| CB-8 | 参数非法（读） | `VALIDATION_ERROR` + 不写审计 | 相同 | 同上 |
| CB-9 | 业务 `ApplicationError` | message **原文透传** | 相同 | 用 `NOT_FOUND` 触发 |
| CB-10 | 非 `ApplicationError` | `INTERNAL_ERROR` + 通用文案（无堆栈/SQL/路径） | 相同 | 注入 `throw new Error('sql...')` |
| CB-11 | 幂等命中（同 key 同摘要） | 回放 + `replayed:true` + `sync_status:'desktop_local_only'` | 相同（**形状逐字段等价**） | 两次 `create_record` |
| CB-12 | 幂等冲突（同 key 不同摘要） | `IDEMPOTENCY_KEY_REUSE` + 写审计 | 相同 | 改参数重放 |
| CB-13 | 写工具成功 | 返回含 `sync_status:'desktop_local_only'` | 相同 | `create_canvas` |
| CB-14 | 读工具成功 | 返回**不含** `sync_status` | 相同 | `list_beans` |
| CB-15 | `TOOL_NAMES` | 27 个、顺序固定 | 逐项相等 | `expect(TOOL_NAMES).toEqual([...])` |
| CB-16 | `out/mcp/stdio.mjs` | 911.67 kB（基线） | 变化 < 5% | 构建后比较大小 |

**CB-5 到 CB-8 是这次重构最容易被破坏的地方**：审计「只记写工具」的分支散落在
`routeBridgeRequest` 的多处 `if (definition.write)`，搬移时极易漏掉一处。
它们是 1.1A 的**发布阻断项**。

### 1A.5 测试要求

| 类型 | 覆盖 | 数量 |
|---|---|---|
| 回归 | 现有 **949** 条全绿 | 949 |
| 对照 | CB-1 ~ CB-16 逐项 | ≥ 16 |
| 单元 | `executeTool` 的 scope / Zod / 错误映射三分支 | ≥ 12 |
| 结构 | `mcp-tools/**` **不 import** `mcp-bridge/**`（反向依赖禁止） | ≥ 1 |

### 1A.6 验收标准（可机械判定）

1. `pnpm typecheck` / `pnpm test` / `pnpm build` / `pnpm mcp:build` 全绿；
   测试总数 ≥ 949 + 29。
2. **CB-1 ~ CB-16 全部通过**，且基线值在改动前已记录（否则无法证明「一致」）。
3. `TOOL_NAMES` 27 个、顺序一致（`toEqual` 断言）。
4. **不新增任何数据库迁移**：`migrations.ts` 的数组长度仍为 13，`user_version` 不变。
5. **Windows Named Pipe 行为不变**：`bridge-contract.ts` 与 `bridge-server.ts`
   的 git diff 为空。
6. `src/main/remote/` **不存在**（`ls` 断言）。
7. `git diff --stat` 只含 `mcp-tools/`（新增）+ `request-router.ts`（改）+ 测试文件。

### 1A.7 风险与缓解

| 风险 | 缓解 |
|---|---|
| 搬移时漏掉某处 `if (definition.write)` 审计分支 | CB-5~CB-8 四项专门覆盖；以「审计行数」为断言，不看返回体 |
| 抽取后 `RouterContext` 类型不兼容 | `RouterContext = ToolServices & { db, clients }` 是结构超集，`routeBridgeRequest` 可直接把 `ctx` 传给 `executeTool`，不需要构造新对象 |
| 幂等重放形状漂移 | CB-11 用 `toEqual` 而非 `toMatchObject`；`replayIdempotent` 留在 Local 不放执行层 |
| 误以为「测数不变 = 行为不变」 | 1A.4 的 16 项对照是独立验收项，缺一不可 |

---

## Phase 1.1B — Desktop Remote Agent

> **前置：1.1A 已验收通过。** 本阶段才引入 WSS、设备身份、IPC 与设置界面。

### 1B.1 范围（做什么）

| # | 能力 | 说明 |
|---|---|---|
| B-1 | 设备身份 | Ed25519 密钥对（PKCS8/SPKI DER）；私钥 + `device_token` + **`boundUserId`** 一起 `safeStorage` 加密存 `userData/remote/device.json` |
| B-2 | 设备注册客户端 | 调 `/mcp-devices/register` → 显示 `confirm_code` → **内存持有 claim_secret** → 轮询 `/credentials`（本阶段用 Mock Gateway） |
| B-3 | 出站 WSS | 主动连接、`hello` 握手（Ed25519 签名）、`hello_ok` 处理、区间版本协商 |
| B-4 | 连接状态机 | `idle / connecting / handshaking / online / draining / backoff / blocked`（安全 §4.0 S3），单一状态源 |
| B-5 | 心跳 | 应答 `ping`；90s 无 `ping` 主动重连 |
| B-6 | 自动重连 | 指数退避 + jitter；**4xxx 不重连**（`4010` 除外）；重连清理清单 7 项逐项执行 |
| B-7 | 请求准入 | 开关 → 帧大小 → deadline → 白名单 → scope → **hash 一致** → 缓存 → `executeTool`（协议 §6.2） |
| B-8 | 工具执行 | 经 `executeTool`（1.1A 产物），**不直接调 `HANDLERS`**，不走 socket |
| B-9 | 超时与取消 | epoch→monotonic 换算；`remaining ≤ 0` 不执行；已取消不发 `res` |
| B-10 | `delivery_id` + 缓存 | 按 `delivery_id` 去重 + `request_hash` 校验 + 条数/字节双上限 LRU（协议 §8.3/§8.4） |
| B-11 | 审计 | `client_id='remote:<device_id>'`；**只读也记**；三段状态分离；失败计数 + stderr + UI 告警；**计数为进程内状态，重启归零**（安全 §6.5.6） |
| B-12 | 本地开关 | 默认关；**本地优先**（先写 `local_state` 再尽力 suspend）；关闭即拒 `req` |
| B-13 | 用户切换阻断 | `boundUserId` 比对；不匹配强制 `blocked`（安全 §2.6.4） |
| B-13b | **启动即校验（崩溃恢复）** | `RemoteService` 初始化内跑「`enabled` + `boundUserId`」双门，**早于 BrowserWindow 创建**；任一失败零出站连接（安全 §2.6.4，ST-17） |
| B-14 | 界面 | 设置页「远程访问」区：状态、设备名、最后活跃、解绑、撤销、诊断（含审计失败计数与告警条） |

### 1B.2 明确不做（护栏）

- ❌ 不改 `cloud/`（一行都不改；联调用仓内 Mock Gateway）
- ❌ 不改 `src/mcp/*`、`bridge-server.ts`、`bridge-client.ts`、`sync/*`
- ❌ 不改 `mcp-tools/*`（1.1A 产物冻结；若必须改，回 1.1A 重新验收）
- ❌ **不加数据库迁移**
- ❌ 不开放写工具
- ❌ 不实现 MCP OAuth（属 1.3）
- ❌ 不实现按内容合并（协议 §8.6）、不做断线排队（协议 §10.3）
- ❌ 不实现审计熔断（属 1.4，OQ-5）

### 1B.3 契约常量（唯一权威，四份文档一致）

进入实现前，以下三个集合必须逐字一致（`src/shared/contracts/remote.ts` 是代码侧唯一来源）：

**`REMOTE_SCOPES`（4 个）**

```ts
['records:read', 'tags:read', 'coffee:read', 'canvas:read']
```

**`REMOTE_TOOLS`（8 个，全部只读）**

```ts
['search_records', 'get_record', 'list_record_tags',
 'list_beans', 'list_brews', 'list_tastings',
 'list_canvases', 'get_canvas']
```

**`REMOTE_ERROR_CODES`（17 个）**：唯一权威表 = `REMOTE_MCP_PROTOCOL.md` §9.1。
依次为 `DEVICE_OFFLINE` / `DEVICE_UNAUTHORIZED` / `DEVICE_REVOKED` /
`DEVICE_SUSPENDED` / `REMOTE_DISABLED` / `DEVICE_BUSY` / `USER_MISMATCH` /
`SCOPE_DENIED` / `TOOL_NOT_ALLOWED` / `INVALID_ARGUMENTS` / `NOT_FOUND` /
`REQUEST_TIMEOUT` / `REQUEST_CANCELLED` / `REQUEST_TOO_LARGE` /
`PROTOCOL_VERSION_UNSUPPORTED` / `PROTOCOL_VIOLATION` / `INTERNAL_ERROR`。

**交集规则**（协议 §4.4）：
`effective_tools = REMOTE_TOOLS ∩ hello_ok.allowed_tools ∩ toolsForScopes(scopes)`。
三个集合任一为空 → 保持连接但所有 `req` 回 `TOOL_NOT_ALLOWED`。

### 1B.4 代码模块

```
Desktop/src/main/remote/                    （新增目录）
├── device-identity.ts        Ed25519 生成/加载/加密存储/轮换 + boundUserId
├── link-client.ts            WSS 连接、hello 握手、帧编解码、心跳
├── link-state.ts             连接状态机（唯一状态源）
├── reconnect.ts              退避计算（纯函数）
├── request-handler.ts        准入链 + hash 校验 + 缓存 + 调 executeTool + 审计
├── result-cache.ts           delivery_id → 结果 LRU（条数 + 字节双上限）
├── remote-policy.ts          REMOTE_SCOPES / REMOTE_TOOLS / effectiveTools 交集
├── remote-service.ts         门面：prepareFor/start/stop/enable/disable/forget/status
└── index.ts

Desktop/src/shared/contracts/remote.ts      （新增）
├── REMOTE_SCOPES             4 个只读 scope
├── REMOTE_TOOLS              8 个工具（独立常量）
├── REMOTE_ERROR_CODES        17 个
└── remoteStatusSchema        state/deviceId/boundUserId/lastPongAt/lastError/
                              auditStatus{consecutiveFailures,lastFailureAt,totalFailures}

Desktop/src/main/index.ts                   （改：装配 RemoteService，默认不启动）
Desktop/src/main/ipc/register.ts            （改：新增 remote:* 通道）
Desktop/src/preload/index.ts                （改：暴露 remote 命名空间）
Desktop/src/renderer/src/features/settings/ （改：新增「远程访问」面板 + 审计告警条）
Desktop/tests/unit/remote-*.test.ts         （新增 8 个测试文件）
Desktop/tests/helpers/mock-gateway.ts       （新增：本地 WS 服务 + 协议测试向量）
```

### 1B.5 IPC 面

| 通道 | 入参 | 返回 |
|---|---|---|
| `remote:status` | — | `RemoteStatus`（含 `auditStatus`） |
| `remote:enable` | `{ scopes: RemoteScope[] }` | `RemoteStatus`（含确认提示态） |
| `remote:disable` | — | `RemoteStatus` |
| `remote:register` | — | `{ deviceId, confirmCode, expiresAt }`（**不含 claim_secret**） |
| `remote:forget` | — | `RemoteStatus`（删私钥 + 尽力撤销云端） |
| `remote:unbind` | — | `RemoteStatus`（`boundUserId` 不匹配时的解绑入口） |
| `remote:diagnose` | — | `{ state, lastError, lastPongAt, reconnectAttempt, auditStatus }` |
| `remote:changed` | 广播 | `RemoteStatus` |

**没有 `remote:call`**。远程调用只能由 Cloud 发起，本地不提供「手动触发一次远程工具」
的通道——那会变成一个绕过所有 UI 确认的后门。

**`claim_secret` 绝不出现在 IPC 响应里**：它只在主进程内存中用于领取，
渲染层只需显示 `confirm_code`。

### 1B.6 测试要求

| 类型 | 覆盖 | 数量 |
|---|---|---|
| 单元（退避） | 退避序列、jitter 边界、`attempt` 稳定 60s 后归零 | ≥ 10 |
| 单元（身份） | 生成/加载、加密不可用拒绝落盘、解密失败视为未授权、轮换、PKCS8/SPKI 往返、`boundUserId` 比对三种结果 | ≥ 15 |
| 单元（准入链） | 8 道检查逐一拒绝；`remaining ≤ 0` 不执行（service 调用次数 0） | ≥ 25 |
| 单元（去重/缓存） | 协议 §8.3 六种情况逐条；字节上限淘汰；断线清空；重连后同 id 当新请求 | ≥ 18 |
| 单元（审计三段） | 审计失败时 `res.ok` 仍为 true；计数递增/归零；`lastFailureAt` 保留 | ≥ 10 |
| 单元（执行层接入） | Remote 侧错误码映射表与协议 §9.1 一致 | ≥ 5 |
| 合同 | `REMOTE_TOOLS` / `REMOTE_SCOPES` / 错误码三个集合的断言 | ≥ 5 |
| 结构 | `src/main/remote/**` 不 import `mcp-bridge/**` 与 `permission-service` | ≥ 2 |
| 集成（Mock Gateway） | 握手成功 / 版本无交集 4002 / 4003 不重连 / 4010 换凭证重连 / 心跳超时 / drain 排空 / 未知 req 必回 res | ≥ 14 |
| **安全矩阵** | **ST-4 ~ ST-10、ST-13 ~ ST-17**（安全 §7.1） | 12 |
| e2e | 开关状态变化；关闭后 1s 内断连且 60s 无重连；`boundUserId` 不匹配进入 blocked | ≥ 4 |
| 回归 | 1.1A 的 949 + 29 条全绿 | 978 |

**不能声称「已测」的项**：真实 ChatGPT 联调、真实 Cloud WSS、真机网络切换
（Wi-Fi ↔ 有线）、NAT 半开、Windows DPAPI。这些在 1.1B 只到 Mock 级。

### 1B.7 验收标准（可机械判定）

1. `pnpm typecheck` / `pnpm test` / `pnpm build` / `pnpm mcp:build` 全绿；
   测试总数 ≥ 978 + 106（1.0.3 因 ST-16/ST-17 由 104 增至 106）。
2. **Local 行为不变**：1.1A 的全部测试仍通过；`TOOL_NAMES` 与 `stdio.mjs` 体积不变。
3. 默认「远程关闭」，且**不建立任何出站连接**（`net` 层断言无 socket）。
4. 关闭开关后 1s 内连接关闭，60s 内零重连；**且 Mock 拒绝 suspend 时本地仍拒 `req`**
   （对应 ST-5）。
5. 收到 close `4001/4002/4003/4004/4005/4006/4009` 时**零重连**；
   `4010` 用新凭证立即重连一次；`1001/1011/4008/4011` 按退避重连，
   首次延迟 ∈ [500ms, 1000ms]。
6. 请求已过 `deadline_ms` 时**不进入业务层**（service 调用次数断言 0）。
7. 审计：每次远程调用**尝试**写一行，`client_id` 以 `remote:` 开头；
   **只读工具也有一行**；不含任何参数/结果。
8. **审计失败时 `res.ok` 仍为 `true`**，且 `auditStatus.consecutiveFailures ≥ 1`、
   设置页告警可见（ST-10）。
9. 同参数两次不同 `delivery_id` → 审计 **2 行**，第二次反映最新数据（ST-8）。
10. 同 `delivery_id` 不同 `request_hash` → `PROTOCOL_VIOLATION`，原缓存不被覆盖（ST-6）。
11. `boundUserId` 不匹配 → `remote.enabled=false` + `blocked` + 零出站连接（ST-4）。
12. **执行中关闭开关后，同 `delivery_id` 重投**：`REMOTE_DISABLED`，不返回在执行请求
    的结果、不命中缓存，`executeTool` 调用次数仍为 1（ST-16）。
13. **用户切换 + 关闭开关 + 主进程崩溃重启**：不创建 BrowserWindow 的主进程测试里，
    `RemoteService` 初始化即判定 `blocked` + 零出站连接（ST-17）。
14. 凭据隔离：`src/main/remote/` 下 grep 不到 `authenticate(` / `McpClientService` / `bp_mcp_`。
15. 哨兵字符串（`SENTINEL-7f3a9c`）不出现在 `mcp_operation_log` 任何行。

### 1B.8 风险与缓解

| 风险 | 缓解 |
|---|---|
| WSS 客户端依赖不确定（OQ-D / S7） | **开工前**先做 spike 转 E；不通则加 `ws` 并记录依赖变更 |
| Electron 内 Ed25519 与系统 Node 不一致（S8） | 同上，开工第一天补 E；失败则评估纯 JS 实现 |
| 主进程长连接影响退出 | `before-quit` 显式 `stop()`；状态机有 `disposed` 终态 |
| 心跳/退避定时器泄漏 | 全部定时器在 `stop()` 清理；fake timers 断言无残留；重连清理清单 7 项逐条测 |
| `safeStorage` 不可用（Linux/无 keyring） | 与 `account/credentials.ts` 同策略：拒绝落盘 + 明确提示，不退化明文 |
| 缓存按字节数爆内存 | 条数 + 字节双上限（协议 §8.4），单测覆盖大结果淘汰 |
| 把 Remote 逻辑混进 Bridge 导致 Local 回归 | 结构测试断言 import 方向 + `bridge-server`/`bridge-client` 零改动 |

## Phase 1.2 — Cloud 设备面

### 2.1 范围

| # | 能力 |
|---|---|
| B1 | 表 `mcp_devices`：`id, user_id, name, platform, public_key, status(pending\|active\|suspended\|revoked), confirm_code_hash, claim_secret_hash, expires_at, token_hash, token_issued_at, key_rotated_at, last_seen_at, revoked_at, created_at` |
| B2 | 端点：`POST /mcp-devices/register`、`POST /mcp-devices/{id}/confirm`、`POST /mcp-devices/{id}/credentials`（**请求体传 `claim_secret`，不入 URL**）、`GET /mcp-devices`、`POST /mcp-devices/{id}/rotate`、`POST /mcp-devices/{id}/suspend`、`POST /mcp-devices/{id}/resume`、`DELETE /mcp-devices/{id}` |
| B3 | **凭证领取闭环**：`claim_secret` 生成/只存哈希/一次有效；领取用**条件 UPDATE + RETURNING** 保证原子（协议 §3.4） |
| B4 | 设备状态机：`pending → active → suspended ⇄ active`；任意状态 `→ revoked`（安全 §4.0 S2）。**状态转换只用单条 UPDATE，不做多步** |
| B5 | WSS 接入：`/device-link`，握手 9 步（协议 §4.3），含 Ed25519 验签与**原子 nonce 去重** |
| B6 | 连接表：`ConnectionRegistry` 内存实现 + 接口定稿；顶替时**先 bind 新、再断旧** |
| B7 | 心跳：`ping`/`pong`、60s 无 `pong` 断连、`last_seen_at` 更新 |
| B8 | 转发：`req`/`res`/`cancel`，`deadline_ms` 原样传播，`max_inflight` 限流，`drain` 时停路由 |
| B9 | 撤销：**先持久化 `status`**，再删路由、再发 `bye`/close（协议 §11.2） |
| B10 | 迁移 `0001`：`mcp_devices` 表 + `startSweep` 清理过期 pending |
| B11 | 运维：`/ready` 暴露 `instance_id`、`connection_count`；`GATEWAY_EXPECTED_REPLICAS>1` 拒绝启动 |
| B12 | **设备与 grant 的关系**：两表无外键、互不级联；撤销设备不撤 grant（安全 §4.1 规则 2） |
| B13 | **轮换的 `rotating` 状态**：② 提交后旧连接上的新 `req` 立刻回 `DEVICE_UNAUTHORIZED`（协议 §11.6） |
| B14 | **`mcp_devices` 与 grant 的跨用户校验**：转发前查 `grant.user_id == device.user_id`（ST-1） |

### 2.2 涉及模块

```
cloud/src/mcp-devices/{service.ts, routes.ts, claim.ts, rotate.ts}
cloud/src/link/{link-server.ts, handshake.ts, connection-registry.ts, forwarder.ts}
cloud/src/db/schema.ts                  （加 1 表；不动现有 6 张）
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
- 握手 9 步逐项负例（token 错 / pending / suspended / revoked / nonce 重放 /
  ts 偏移 / 签名错 / 版本无交集 / 重复连接顶替）≥ 18 条
- **撤销顺序**：撤销后即使 `unbind` 抛错，用旧 token 握手仍被拒（断言）≥ 2 条
- 轮换：旧 token 立即失效、`rotating` 窗口内新 req 被拒、旧连接被 close `4010` ≥ 6 条
- 心跳：3 次丢失断连、`last_seen_at` 正确 ≥ 5 条
- 转发：正常 / 设备离线 / `max_inflight` 超限 / deadline 到点 / cancel / drain ≥ 10 条
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
| C5 | 表：`mcp_grants`、`mcp_oauth_clients`、`mcp_auth_codes` |
| C6 | Scope 校验：Cloud 侧一次 + Desktop 侧一次 |
| C7 | 401 challenge：`WWW-Authenticate: Bearer resource_metadata="…"` |
| C8 | 日志纪律：只 tool/status/duration/error_code/delivery_id |
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

**真实 ChatGPT 验收门禁（本阶段独有，缺一不可通过）**：

| # | 门禁 | 通过判据 | 失败后果 |
|---|---|---|---|
| G1 | OAuth 授权完成 | ChatGPT 能走完 authorize → consent → token，拿到可用于 `/mcp` 的 token | 阶段不通过 |
| G2 | `initialize` + `tools/list` | 列出 8 个工具且描述可读 | 阶段不通过 |
| G3 | 一次真实 `tools/call` | 返回真实数据（与桌面端一致） | 阶段不通过 |
| G4 | 撤销后立即失效 | Web 撤销 grant 后，ChatGPT 下一次调用被拒 | 阶段不通过 |
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

**测试用例的完整定义（阶段 / 位置 / 预期结果 / 阻断级别）在 `REMOTE_MCP_SECURITY.md` §7.1（ST-1~ST-17，共 17 条）。**
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
**除 ST-15 外，ST-1~ST-17 全部为发布阻断项。**

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
| `REMOTE_MCP_ARCHITECTURE.md` | 27 工具实测、共享执行层（§6.5）、Bridge 边界、Cloud 9 路由、`redirect_uri` 硬限制、设备模型缺失、12 原则判定、8 工具面、B1–B7 阻塞项、**22 项 OQ 总表**、**阶段依赖三性质与「Mock ≠ 集成」**、**时间术语** |
| `REMOTE_MCP_SECURITY.md` | 五层权限、设备四凭证与注册闭环（`claim_secret` 走 POST 体）、4 个远程 scope、五个状态机、撤销顺序、审计方案 A、**审计三段分离与 best-effort 承诺（计数器为进程内状态）**、**启动即校验（不依赖 UI）**、T1–T19、**ST-1~ST-17 测试矩阵** |
| `REMOTE_MCP_PROTOCOL.md` | **17 个错误码 + 14 个 close code**、9 步握手、**Unix epoch / monotonic 二分**、`delivery_id` + **`request_hash`**、六种重复投递情况、**缓存双上限 + 关闭开关即清空**、四个竞态场景 R1–R4、退避、撤销顺序、用户切换与轮换、多实例路由、OAuth 三层分离 |
| `REMOTE_MCP_PHASES.md` | **1.1A / 1.1B 拆分**、CB-1~CB-16 行为对照表、Spike 五级状态码、**发布阻断项汇总（除 ST-15 外全部阻断）**、**并行四条件 P0–P3**、1.2/1.3（含真实 ChatGPT 门禁 G1–G6）/1.4/1.5 |

**未产生**：任何功能代码、数据库迁移、路由改动、配置改动、依赖变更、commit/push/merge。
**未执行**：任何 Spike、任何测试（三轮修订均为纯文档工作）。
