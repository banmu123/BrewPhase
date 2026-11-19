# BrewPhase Remote MCP — 文档索引

> 设计基线 `feature/remote-mcp`（Phase 1.0 / 1.0.1 / 1.0.2 / 1.0.3，`fc96654`；其后叠加
> **Phase 0 的 P0-1 / P0-2 修订**，见 §7）。
> 本系列按主题拆为 **4 族 9 册**。为守住跨文档引用，**章节号在各自族内全局唯一**；
> 引用如「协议 §9.1」「安全 §2.6」按章节号定位，不因拆分改变。每册顶部有本族导航。
> 拆分本身（整章搬移 + 导航 + 索引）**无内容变更**；**Phase 0 修订改变了正文**——
> 只涉及 Grant 授权上下文与 `jti` 语义两处，另含由此派生的错误码 / ST / OQ 计数与
> 阶段归属（§7）。状态：`READY FOR PHASE 1.1A`（Phase 0 未改变 1.1A 的开工条件）。

## 1. 架构族

| 册 | 文件 | 章节 |
|---|---|---|
| 现状审计 | `REMOTE_MCP_ARCHITECTURE.md` | 0.0* 修订摘要、§0 结论、§1–§5 现状审计（Local MCP / Bridge / Cloud 账号与 OAuth / Desktop 数据与同步 / Cloud 部署） |
| 目标设计 | `REMOTE_MCP_ARCHITECTURE_DESIGN.md` | §6 总体架构（含 §6.5 共享执行层）、§7 风险（含 §7.3 OQ 总表）、§8 关系、§9 未做的事 |

## 2. 协议族

| 册 | 文件 | 章节 |
|---|---|---|
| 核心与接入 | `REMOTE_MCP_PROTOCOL.md` | 0.0* 修订摘要、§1 分层与版本、§2 帧、§3 设备注册、§4 WSS 握手、§5 心跳 |
| 请求与可靠性 | `REMOTE_MCP_PROTOCOL_RUNTIME.md` | §6 请求转发、§7 时间/超时/取消、§8 重复请求与缓存、§9 错误码、§10 断线重连 |
| 生命周期与参考 | `REMOTE_MCP_PROTOCOL_LIFECYCLE.md` | §11 生命周期、§12 多实例路由、§13 字段归属与校验、§14 时序示例、§15 HTTP 端点、§16 与 Local MCP 对照 |

## 3. 安全族

| 册 | 文件 | 章节 |
|---|---|---|
| 权限与身份 | `REMOTE_MCP_SECURITY.md` | 0.0* 修订摘要、§0 前提、§1 信任边界、§2 五层权限（含 §2.6 五身份）、§3 Token 生命周期 |
| 状态与威胁 | `REMOTE_MCP_SECURITY_OPERATIONS.md` | §4 状态机与撤销、§5 跨用户隔离、§6 数据隐私与审计、§7 威胁模型与 ST 矩阵、§8 与 Local 边界、§9 OPEN QUESTION |

## 3a. 运维族

| 册 | 文件 | 内容 |
|---|---|---|
| 部署约束 | `REMOTE_MCP_DEPLOYMENT.md` | §1 单副本、§2 滚动更新、§3 重启后果、§4 反代、§5 环境变量、§6 健康检查、§7 停机、§8 自查清单 |

## 4. 阶段族

| 册 | 文件 | 章节 |
|---|---|---|
| 近期阶段 | `REMOTE_MCP_PHASES.md` | 0.0* 修订摘要、§0 总览、Phase 1.0.1 / 1.1A / 1.1B、0.1.4 准入检查表 |
| 后续阶段与门禁 | `REMOTE_MCP_PHASES_ROADMAP.md` | Phase 1.2 / 1.3 / 1.4 / 1.5、§4 共同门禁、§5 依赖关系图、§6 实际交付 |

*「0.0*」= 0.0 / 0.0.1 / 0.0.2 修订摘要，仅保留在各族主册。

## 5. 唯一权威表落位（拆分后不变）

| 权威项 | 位置 |
|---|---|
| 错误码唯一权威表（19 个） | `REMOTE_MCP_PROTOCOL_RUNTIME.md` §9.1 |
| OPEN QUESTION 唯一权威表（23 项） | `REMOTE_MCP_ARCHITECTURE_DESIGN.md` §7.3 |
| 五个身份分层与生命周期 | `REMOTE_MCP_SECURITY.md` §2.6 |
| **Grant 授权上下文（P0-1）** | `REMOTE_MCP_SECURITY.md` §2.7（模型）/ `REMOTE_MCP_PROTOCOL_RUNTIME.md` §6.5（线格式） |
| **`jti` 语义（P0-2）** | `REMOTE_MCP_SECURITY.md` §3.2.1 / `REMOTE_MCP_PROTOCOL_LIFECYCLE.md` §15.2 |
| 安全测试矩阵 ST-1~ST-26（含阻断级别） | `REMOTE_MCP_SECURITY_OPERATIONS.md` §7.1 |
| 契约常量（4 scope / 8 工具 / **19 错误码** / 14 close code） | 唯一权威表：`REMOTE_MCP_PROTOCOL_RUNTIME.md` §9.1；交叉校验：架构设计 §6.8 / 安全 §2.4 / 阶段 §1B.3 |

## 6. 拆分原则

1. **按整章搬移**：只在 `## ` 边界切分，`###` 子节不拆散。
2. **章节号不变**：这是数百处 `§x.y` 引用的锚点，改号会制造系统性断链。
3. **引用精确修复**：仅当引用带具体文件名、且目标章节已搬入另一册时更新文件名（共 9 处）；「本文 §x」目标搬走时改带文件名（共 3 处）。
4. **内容零丢失**：每册内容逐行源自原文件；原件备份在 `/tmp/remote_mcp_orig_bak/`（仅本地，不入仓库）。

## 7. Phase 0：P0 修订索引（P0-1 / P0-2）

| 问题 | 结论 | 权威位置 |
|---|---|---|
| **P0-1** Grant 只有连接级 scope，同设备多 MCP Client 无法区分 | 采用**逐 grant 授权上下文**：`hello_ok.grants` 下发、`req.grant_ctx` 引用、`grant_update` 撤销、撤销清缓存；删除 `hello_ok.scopes` | 安全 §2.7；协议 §4.4 / §6.1 / §6.5 / §8.4 / §11.3 |
| **P0-2** `jti` 既说「不硬去重」又说「5 分钟重复即拒绝」 | `jti` = **Token 级**，不参与请求去重；HTTP 层不加 nonce；只读工具重放无害 | 安全 §3.2.1 / §5.3；协议 §15.2 |

**新增契约**：错误码 +2（`GRANT_CONTEXT_INVALID` / `GRANT_REVOKED`，共 19）；
ST 用例 +9（ST-18~ST-26，共 26）；OQ +1（OQ-16，共 23）。
**被删除的旧字段**：`hello_ok.scopes`、`req.grant_id`、`req.client_id`、`req.client_name`。
**阶段归属修正**：`mcp_grants` 表改在 **1.2** 建（原文只列在 1.3 C5），因为 1.2 的
B14 / ST-1 跨用户校验要读它；1.3 只补 `mcp_oauth_clients` / `mcp_auth_codes`。
**未改动**：`REMOTE_SCOPES`（4）、`REMOTE_TOOLS`（8）、close code（14）、阶段划分与依赖关系
（`READY FOR PHASE 1.1A` 不变）。

---

## 8. Phase 1.1B.1：协议与安全边界收口索引

1.1B 交付后发现七处「文档要求了、实现没做到」，且**原有测试全绿**——因为
Mock 与客户端两侧都不检查。逐条见 `REMOTE_MCP_PHASES.md` §1B.9。

| 收口项 | 结论 | 权威位置 |
|---|---|---|
| device_token 认证 | 走 `net.WebSocket` 的 `Authorization` 头；**唯一**允许的载体；拿不到 `electron.net` 时 fail-closed，不退回全局 `WebSocket` | 协议 §4.1；安全 §2.3.1a |
| 连接前唯一门禁 | `canConnect()` 七条判据；start / enable / resume / 重连 / reconcile 全走它，`connect()` 内部再查一次 | 协议 §11.5.1 |
| 审计失败判据 | 拆 `writeAuditResult`（失败抛出，成功要求 `changes === 1`）；Local 旧入口零改动 | 安全运维 §6.5.5.1 |
| 帧大小 | **UTF-8 字节**；上限取 `min(本机, hello_ok.max_frame_bytes)`，Cloud 只能收紧 | 协议 §2.2 |
| deadline | epoch **只读一次**换算成 monotonic，之后只用 monotonic | 协议运行时 §7.1 |
| `hello` 契约 | 12 字段；签名覆盖除 `sig` 外全部字段；域分隔前缀 `brewphase.remote.hello.v1` | 协议 §4.2 / §4.2.1 |
| 连接生命周期 | 连接代际隔离；握手指令超时 10s；看门狗从 `hello_ok` 起算；`dropConnection` 统一收敛；draining 拒新请求 | 协议 §11.4.1 / §11.4.2 |
| inflight 语义 | v1 **拒绝，不排队**（路径在同步 handler 下结构性不可达） | 协议运行时 §8.3 |
| 设备注册 | Mock 端点跑通闭环；`RemoteService.register()` 无 registrar 时**明确抛错** | 协议 §3；阶段 §1B.9 第 28 条 |
| 畸形帧必须回话 | `req` 形状非法但 id 可用 → `PROTOCOL_VIOLATION`；提不出 id → close `4009`；`hello_ok` 形状错 `4009` / 版本错 `4002`；畸形 `grant_update` 也要 ack `applied=false` | 协议 §2.2.1；协议运行时 §6.5.2 规则 7 |

## 9. Phase 1.2A：Cloud 设备面（已实现）

范围与取舍见 `REMOTE_MCP_PHASES_ROADMAP.md` 的「Phase 1.2A」小节。要点：

| 项 | 落地 | 权威 |
|---|---|---|
| `mcp_devices` / `mcp_grants` | 迁移 `0001_remote_mcp_devices`；两表无外键、互不级联 | 安全 §2.2 / §2.3 |
| 注册 / 确认 / 领取 / 管理 | 8 个端点，全部只从 `authClaims.userId` 取身份 | 协议 §3.2–§3.5 |
| 一次性领取 | 条件 UPDATE + `RETURNING` 行数；`claim_secret` 只走请求体 | 协议 §3.4 |
| 「还没确认」 | **202** 而非 4xx（否则 Desktop 轮询在第一次就停） | 协议 §3.4 |
| Desktop 接入 | `AccountService.accessToken()` → `DeviceRegistrar` → `RemoteService`（单向） | 协议 §3；安全 §2.3.1a |

**未落地**（属 1.2B / 1.3）：WSS Gateway、`/device-link`、Ed25519 握手、
ConnectionRegistry、心跳、req/res 转发、`grant_update` 在线同步、MCP OAuth。

**新增验收**：§1B.7 之外 9 条（第 20–28 条）。
**未改动**：错误码仍是 19 个（`PROTOCOL_VIOLATION` 复用，不新增）；ST 仍是 26 条
（只补落点说明，不新增编号、不改阻断级别）；OQ 仍是 23 项。
**Test 基线**：978 → **1188**（1.1B 的 1111 + 1.1B.1 的 77）。

## 10. Phase 1.2B.1：Cloud WSS 接入与连接管理（已实现）

范围与验收结果见 `REMOTE_MCP_PHASES_ROADMAP.md` §2.0 / §2.4 的结果表。要点：

| 项 | 落地 | 权威 |
|---|---|---|
| WSS 接入 | 同一 `http.Server` 上挂 `upgrade`（`ws` `noServer` + `@hono/node-server` 的 `createServer` 注入），不开第二个端口 | 协议 §4.1 / §4.1.1 |
| Upgrade 预检 | path 精确、**query 一律拒**、Host 白名单（不看 `X-Forwarded-Host`）、子协议、token 形态 | 协议 §4.1.1 |
| 设备认证 | `sha256(token)` 命中 + `status='active'` + **`token_expires_at`**（不是 `expires_at`） | 协议 §4.3 第 2–4 步 |
| hello 验签 | 13 字段闭合键集、域分隔规范串、严格 base64url、±120s | 协议 §4.2 / §4.2.1 |
| 黄金向量 | `fixtures/remote-mcp/hello-v1.json`，**Cloud 与 Desktop 读同一份** | 本文 §10；协议 §4.2.1 |
| NonceStore | 进程内、有界 8192、fail-closed、monotonic、无 await | 协议 §4.3 第 7 步 |
| ConnectionRegistry | 每用户一条；`unbind` 带 `connectionId` 比对；先 bind 新再断旧 | 协议 §4.6 / §12.2 |
| 心跳 | 20s ping / 60s 空闲 / 3 次未回应 → 4008；`seq` 必须回显当前 ping | 协议 §5.1 |
| 撤停联动 | 先落库 → `unbind` → `bye` → close 4003/4005；清理失败不回滚 | 生命周期 §11.2 |
| 单实例约束 | `GATEWAY_EXPECTED_REPLICAS>1` **拒绝启动**；`/ready` 带 `instance_id` + `connection_count` | 生命周期 §12.2 |
| 迁移 | `0002_mcp_grant_epoch`：只给 `mcp_grants` 加 `epoch DEFAULT 1` + `CHECK >= 1` | 协议运行时 §6.5 |

**新增契约**：无新增错误码（仍是 19）、无新增 ST 编号、无新增 OQ。
唯一的语义修正：协议 §4.3 第 4 步 `expires_at` → **`token_expires_at`**。

**明确未做**（属 1.2B.2）：`req`/`res`/`cancel` 转发、`grant_update` 在线同步、
`install` 未 ack 阻断、`max_inflight` 调度、`delivery_id` 缓存重投、`deadline_ms` 预算、
轮换 `rotating`（B13）、MCP OAuth、`/mcp`、写工具、Redis 多实例。

**Test 基线**：Cloud 224 → **377**；Desktop 1209 → **1219**。

**部署约束**：Phase 1.2–1.3 必须**单副本**；滚动更新 `maxSurge=0, maxUnavailable=1`；
进程重启会断开所有在线设备，Desktop 按 1001 退避重连。

## 11. Phase 1.2B.2.1：设备凭据轮换与 `rotating`（已实现）

| 项 | 落地 | 权威 |
|---|---|---|
| 轮换端点 | `POST /mcp-devices/{id}/rotate`，**只认 device_token** + 旧私钥签名 | 协议 §3.5 |
| 签名原文 | `brewphase.remote.rotate.v1\n{device_id}\n{new_public_key}\n{ts}` | 协议 §3.5；fixture |
| 黄金向量 | `fixtures/remote-mcp/rotate-v1.json`，**两端读同一份** | 本文 §11 |
| 原子更新 | 事务 + `SELECT … FOR UPDATE` + 重验 `token_hash` → 同一条 UPDATE 换 key 与 token | 协议 §3.5 |
| 并发 | 同一旧 token 的两个轮换只有一个成功（第二个 401）；与 suspend/revoke/准入共用行锁 | 生命周期 §11.6.1 |
| `rotating` | **连接级**：`registry.markRotating(deviceId, connectionId)`；`lookup` 返回 null，`lookupByDevice` 仍可见 | 生命周期 §11.6.1 |
| 旧连接退场 | DB 提交后：摘路由 → `bye(rotated)` → close `4010`；清理失败不回滚 | 生命周期 §11.6 |
| 离线轮换 | 允许；`rotateConnection` 返回 `false`，不伪造在线连接 | 生命周期 §11.6.1 |
| Desktop 触发 | `enable` / `resume` / 在线 1h 定时器 + 每次握手成功；提前量 7 天，取自 Cloud 下发的 `expires_at` | 生命周期 §11.6.1 |
| 4010 语义 | 按阶段区分 `requesting` / `reconnecting` / 无轮换 | 安全运维 §4.1.4 |
| 失败处置 | 网络未知 / 落盘失败 / 401 / 409 → blocked；仅 429、公钥形态、响应非法可重试 | 安全运维 §4.1.3 |

**迁移**：**无**。轮换只写 `mcp_devices` 既有列（`public_key` / `token_hash` /
`token_issued_at` / `token_expires_at` / `key_rotated_at`），不新增表也不新增列。

**新增契约**：无新增错误码、无新增 close code（复用 `4010`）、无新增 ST 编号。

**明确未做**（属 1.2B.2.2）：`req`/`res`/`cancel` 转发、`grant_update` 在线同步、
`install` 未 ack 阻断、`max_inflight` 调度、`delivery_id` 缓存重投、`deadline_ms` 预算、
`rotating` 连接上的 `req` 拒绝（需要转发层才有判据点）、MCP OAuth、`/mcp`、写工具、Redis。

**Test 基线**：Cloud 393 → **432**；Desktop 1219 → **1245**。
真实进程联调 13/13（旧凭据握手 → 轮换 200 → 旧连接 4010+bye → 旧 token 4001 →
新 token 配旧私钥 4001 → 新凭据 hello_ok → 日志无明文 token）。

## 12. Phase 1.2B.2.2：请求转发、并发安全与 Grant 在线同步（已实现）

范围与验收结果见 `REMOTE_MCP_PHASES_ROADMAP.md` §2.0.3。要点：

| 项 | 落地 | 权威 |
|---|---|---|
| 派发入口 | `LinkControl.dispatchToolCall({userId, grantId, tool, arguments, clientDeadline?, signal?})`，**不暴露** connection / ctx / device | 协议 §4.8 |
| 准入 | 十项判据每次重读数据库（grants + devices 各查一次） | 运行时 §9.4 |
| 跨用户（ST-1） | 三身份一致：JWT `sub` == `grant.user_id` == `device.user_id` | 安全 §12.1 |
| `request_hash` | `sha256(canonicalJson{v,tool,arguments})`，共享 `fixtures/remote-mcp/req-v1.json` | 运行时 §8.2 |
| 三层限流 | 连接 2 / 设备 2 / 用户 4；队列上限 32、预算 2s → `DEVICE_BUSY` | `request-registry.ts` |
| deadline | 15s 默认 / 30s 硬上限 / `clientDeadline` 只收紧；超时 → `REQUEST_TIMEOUT` + `cancel(gateway_timeout)` | 运行时 §7.2 / §7.4 |
| `cancel` | 排队中取消不发 `req`；已发出取消发 `cancel(client_cancelled)` | 运行时 §7.5 |
| `res` 处理 | 四种忽略分开记日志（未知 / 重复 / 旧连接 / 畸形） | 运行时 §9.4 |
| 断线 | 该连接全部 pending 立刻 `DEVICE_OFFLINE`（不等 deadline） | 生命周期 §10.3 |
| 轮换 | 该连接全部 pending 立刻 `DEVICE_UNAUTHORIZED`（不可重试） | 生命周期 §11.6 |
| grant install | 未 ack 不可路由；`applied=false` / ack 超时 → `grant_sync_lag`（整台设备停路由） | 运行时 §6.5.2 |
| grant revoke | **先停路由** → 结束在途 → 发帧 → 等 ack | 运行时 §6.5.2 |
| scope 变更 | `replaceGrant`：revoke 旧 ctx → ack → install 新 ctx → ack | 安全 §2.7 |
| 两种 epoch | 设备级 `mcp_devices.grant_epoch`（持久化递增）与单 grant `mcp_grants.epoch` 严格分离 | 运行时 §6.5.2 |

**迁移**：**无**。设备级 `grant_epoch` 早已存在（0001），本阶段只做 `+1` 的原子 UPDATE。

**新增契约**：无新增错误码（仍 19）、无新增 close code、无新增帧类型。

**明确没做**（属 Phase 1.3）：公网 `/mcp`（Streamable HTTP）、MCP OAuth / DCR、
`/authorize` / `/token`、Inspector 与 ChatGPT 真实连接、写工具、Redis 多实例、
OAuth 侧的授权落库。

**Test 基线**：Cloud 432 → **530**；Desktop 1245 → **1265**。
真实构建产物联调 15/15（`dist/` + 真 PostgreSQL + 真 `ws`）：
握手 → 派发 → 真实 `res` → 跨用户被拒（且不发帧）→ rotating 后 `DEVICE_UNAUTHORIZED` →
轮换 `4010` → 新凭据重连 → 停机 `1001` → 计数归零。

## 13. Phase 1.2B.2.2-R1：派发、撤销与取消的竞态加固（已实现）

1.2B.2.2 验收的是**稳定态**；R1 补的是**窗口内**。四个问题的共同形状是
「先检查、后 `await`、再写出去」。范围与验收结果见
`REMOTE_MCP_PHASES_ROADMAP.md` §2.0.4。要点：

| 项 | 落地 | 权威 |
|---|---|---|
| 线性化点 | `reserve()` 提到最终 `lookup` 之前；`settled` 之后绝不写 `req` | 运行时 §9.5.1 |
| 撤销窗口 | `rejectByGrantCtx` 现在能命中「已登记、未写出」的请求（含排队项） | 安全运维 §4.1.5 |
| 最终核对 | `await` 之后复核：已结算 / 连接仍在 / 未 rotating / `connectionId` 未变 / `grant_ctx` 仍是当前映射 | 运行时 §9.5.1 |
| rotating 分类 | 用 `ConnSync.rotating` 判：`DEVICE_UNAUTHORIZED`（`retryable=false`），不再退化成 `DEVICE_OFFLINE` | 运行时 §9.5.3 |
| AbortSignal | 进入前已 aborted → 直接 `REQUEST_CANCELLED`（不查库）；窗口内 aborted → 不写 `req` 也不发 `cancel` | 运行时 §9.5.2 |
| `frameSent` | **内部事实**（不是协议字段）：只有真写出过 `req` 的请求才配收到 `cancel` | 运行时 §7.5 / §9.5.2 |
| 重复 install | 只有 `applied` / `not_installed` 才继续；`rejected` / `ack_timeout` / `offline` 停手 | 运行时 §9.5.4 |
| 三种失败日志 | `link_grant_apply_rejected` / `link_grant_ack_timeout` / `link_grant_sync_offline` 分开 | 安全运维 §6.2.2 |

**迁移**：**无**。**新增契约**：无新增错误码 / close code / 帧字段（`frameSent`
只活在 Cloud 进程内）。

**新增测试**：`cloud/tests/link/dispatch-race.test.ts`（7 条，确定性 Deferred
暂停 `registry.lookup`，不用 sleep）；`grant-sync.test.ts` 新增 3 条重复 install。

**Test 基线**：Cloud 530 → **540**；Desktop 1265（未改动）。
真实构建产物联调 **26/26**；同一脚本在修复前的构建上第一个判别点即失败
（拿到 `DEVICE_OFFLINE/retryable=true` 而不是 `GRANT_REVOKED`）。

## 14. Phase 1.2B.2.2-R2：`syncLag` 的连接级 fail-closed（已实现）

R1 收口了「派发与撤销」；R2 收口「`syncLag` 置位之后，**队列里其他 grant** 的
请求还能不能出去」。范围与验收见 `REMOTE_MCP_PHASES_ROADMAP.md` §2.0.5。

| 项 | 落地 | 权威 |
|---|---|---|
| 缺陷 | `syncLag` 只是入口/最终核对里的判断；队列项不重新经过它，`pump()` 仍会把别的 grant 的排队项写出去 | 运行时 §9.6.1 |
| 统一入口 | `markSyncLag(conn, cause)`：`syncLag` **唯一**赋值点，只 false→true，记原因，立刻清队列 | 运行时 §9.6.4 |
| 队列收敛 | `RequestRegistry.rejectQueuedByConnection`：只拒 `queued`，不动已写出的，不归还计数 | 运行时 §9.6.3 |
| 发送闸门 | `sendEntry` → `sendGate`：已结算 / 连接在 / 未 rotating / 未 `syncLag` / ctx 仍是当前映射；**不查库** | 运行时 §9.6.2 |
| 泵 | `pump()` 循环 + `pumping` 重入标志（被拒项释放槽位，需再取一批） | 运行时 §9.6.2 |
| 三种原因 | `apply_rejected` / `ack_timeout` / `offline` 各自日志 + `inspect().syncLagCause` | 安全运维 §4.1.6 |
| 恢复 | 只有新握手 + 新 `hello_ok` 快照；迟到 ack / install / res 都不行 | 运行时 §9.6.5 |
| `offline` 也置位 | 帧没写出去 ≠ 对端状态已知（fail-closed） | 安全运维 §4.1.6.3 |

**迁移**：**无**。**新增契约**：无新增错误码 / close code / 帧字段（`syncLagCause`
只出现在 `inspect()` 这个诊断接口里）。

**新增测试**：`cloud/tests/link/sync-lag.test.ts`（9 条，真实 PostgreSQL +
真实 Forwarder + 可控传输）；`grant-sync.test.ts` +4；`request-registry.test.ts` +4。

**Test 基线**：Cloud 540 → **557**；Desktop 1265（未改动）。
真实构建产物联调 **25/25**；同一脚本在修复前的构建上 **19/25**，且多写出一条 `req`。

## 15. Phase 1.3.0：规范对齐与设计冻结（已冻结，未实现）

**这是 Phase 1.3 的唯一设计基线**：`REMOTE_MCP_PHASE_1_3_DESIGN.md`（下称「设计」）。
本阶段**零生产代码、零迁移、零依赖变更**；只做规范核对、OQ-3 定稿与文档修订。

### 15.1 规范版本

| 项 | 值 |
|---|---|
| MCP 最新正式版本 | **`2026-07-28`**（2026-11-18 实查 `/specification/latest`） |
| 该版关键变更 | 移除 **GET SSE 流**；移除**协议层会话**（`Mcp-Session-Id`）；`initialize` 改为 legacy；modern 用逐请求 `_meta` + `server/discover` |
| 授权 | OAuth 2.1 + RFC 9728 PRM +（RFC 8414 / OIDC Discovery）+ RFC 8707 `resource` + RFC 9207 `iss` |
| 客户端注册 | CIMD（SHOULD，首选）/ 预注册（允许）/ **DCR（MAY，已弃用）** |

### 15.2 四条会直接写错实现的事实（1.3.0 修正）

| # | 修正 | 权威 |
|---|---|---|
| 1 | `initialize` 只属 **legacy**；modern 没有它，用 `server/discover` | 设计 §3.1；路线图 §3.0/§3.4 |
| 2 | `GET`/`DELETE /mcp` 恒 `405`；不是「以后再加」 | 设计 §4.1；生命周期 §15 |
| 3 | DCR 已弃用，**不是唯一注册路径**；CIMD 才是首选 | 设计 §7.1；路线图 §3.1 C3 |
| 4 | 协议层会话已移除；OQ-3 的「会话」是 OAuth refresh 容器，两件事无关 | 设计 §16；安全 §3.2 |

### 15.3 关键技术判断（均为实测，非推测）

| 判断 | 证据 |
|---|---|
| Cloud **无** MCP SDK；Desktop 有 `@modelcontextprotocol/server@2.4.0` | `package.json` / `node_modules` |
| 该版本是 npm `latest` | `npm view … version` → `2.4.0` |
| `SUPPORTED_PROTOCOL_VERSIONS` 只到 `2025-11-25` | 运行时导入读取 |
| **但** `createMcpHandler` 实测**同时**服务 modern（`server/discover` → `supportedVersions:["2026-07-28"]`）与 legacy（`initialize` → `2025-06-18`） | 直接构造 `Request` 喂 `handler.fetch` |
| 规范要求的错误面由 SDK 产出：`-32020` / `-32022` / `-32601` / `405` | 同上 |

→ 因此采用 **dual-era**（`legacy: 'stateless'`），**不押注**客户端用哪一代。

### 15.4 OQ-3 定稿

**独立 `mcp_sessions` 表，`auth_sessions` 零改动。**（⚠️ **已被 §16 细化为两层**：
`mcp_sessions` 只存身份，`mcp_refresh_tokens` 存每代凭据——否则 90 天会被无限续命。）
三条决定性理由来自真实代码：
全局 UNIQUE 的 `refresh_token_hash`、`logoutByRefreshToken`/重放检测**撤整族**、
缺少 `client_id`/`grant_id`/`scope`/`resource`。完整决策、状态机、轮换流程与
「登出/撤销/过期」矩阵见设计 §9。

### 15.5 Phase 1.3 拆分

| 子阶段 | 主题 |
|---|---|
| **1.3.0** | 本阶段：规范对齐与设计冻结 |
| **1.3.1** | MCP OAuth 基础设施（迁移 `0003`、`mcp_sessions`、authorize/token/register、PRM/AS 元数据、consent、与 Desktop 登录隔离） |
| **1.3.2** | Streamable HTTP 与工具服务（`POST /mcp` dual-era、Bearer + audience + grant 回查、8 工具、错误面、日志） |
| **1.3.3** | 真实客户端联调（Inspector、ChatGPT、Grok、refresh、撤销/离线/异常） |

### 15.6 本阶段修订的文件

| 文件 | 修订 |
|---|---|
| `REMOTE_MCP_PHASE_1_3_DESIGN.md` | **新增**（唯一基线，16 节） |
| `REMOTE_MCP_PHASES_ROADMAP.md` | §3.0 拆分；§3.1 端点组与 dual-era；§3.2 路由组与版本策略；§3.3/3.4 测试与门禁（G2/G2'）；§3.5 风险；§2.1 前的 1.3 交叉引用；Phase 1.5 的 SSE 条目改为 `subscriptions/listen` |
| `REMOTE_MCP_PROTOCOL_LIFECYCLE.md` | §15 端点表（`/mcp/oauth/*` 分离、`/mcp/oauth/consent`、GET/DELETE 405）；§15.1 三层要求（dual-era） |
| `REMOTE_MCP_PROTOCOL_RUNTIME.md` | §9.2.1 新增：传输层 JSON-RPC 码（`-32020`/`-32022`/`-32601`/`-32000`）不属 19 个业务码 |
| `REMOTE_MCP_SECURITY.md` | §3.2 末：OQ-3 定稿与三条代码级理由 |
| `REMOTE_MCP_SECURITY_OPERATIONS.md` | §4.1 撤销矩阵（grant 撤销同事务撤 `mcp_sessions`）；§9 OQ-3/OQ-7 行 |
| `REMOTE_MCP_ARCHITECTURE_DESIGN.md` | §7.1 B7；§7.3 OQ-3 |
| `REMOTE_MCP_INDEX.md` | 本节 |

**未改动**：`cloud/**`、`Desktop/src/**`、`cloud/src/db/migrations/`、
`auth_sessions`、任何依赖版本。

## 16. Phase 1.3.0-R1：浏览器授权闭环与 Session 模型修订（已冻结，未实现）

对 §15（1.3.0）的**设计修订**。仍属于「只改文档」：`cloud/src/**`、
`Desktop/src/**`、迁移目录、`auth_sessions` 全部未动。

### 16.1 为什么必须修订（1.3.0 的三处硬伤）

| # | 1.3.0 的说法 | 核对后的实际 |
|---|---|---|
| 1 | 「用户登录（复用 `/auth/*`）」 | **Cloud 里没有任何 Cookie**；`/auth/*` 只有 refresh/logout/me/identities，全是 Bearer；`handleProviderCallback()` 会签发 Desktop 登录码并重定向到 **127.0.0.1**。→ 浏览器侧根本没有登录态可复用 |
| 2 | `mcp_sessions` 存 `refresh_token_hash`，每次 refresh 新建一行 | 新行 `created_at = now` → `min(now+30d, created_at+90d)` **永远到不了 90 天**；且 `sid` 随之变化 → 正常刷新会打挂尚未过期的 Access Token |
| 3 | 401 challenge 带全部 4 个 scope | 等于默认索要全部数据权限，与最小权限原则冲突 |

### 16.2 修订后的三个结论

| 主题 | 结论 | 权威 |
|---|---|---|
| 浏览器登录 + Consent | 新建 `mcp_auth_requests` + 签名 Cookie `bp_mcp_bs` + **MCP 专用** Provider 回调 + `GET/POST /mcp/oauth/consent`；**不复用** Desktop 登录链路 | 设计 §5 |
| Session / Refresh | `mcp_sessions`（身份，`sid` 稳定、`absolute_expires_at` 不可变）→ 1:N → `mcp_refresh_tokens`（每代凭据） | 设计 §9 |
| 最小权限 | 401 **省略** `scope`；`tools/list` 不需业务 scope；`tools/call` 缺 scope 才 403 且**只报缺的那个**；consent 页可逐项取消；step-up 扩权 | 设计 §5.8 |

### 16.3 关键问题的答案

> 一个从未访问过 BrewPhase 的新用户，第一次在 ChatGPT 添加 Remote MCP，
> 如何登录、确认身份、看到四种权限、批准、并把 Authorization Code 交还？

**12 步，见设计 §5.0。** 要点：新用户不需要任何前置步骤——第 8 步的
`findOrCreateUserWithIdentity()` 在 Provider 回调里当场创建账户（与现有
Desktop 登录同一个函数），随后才进入同意页。

### 16.4 关键决定：刷新失败**不能**自动恢复

宽限窗口（30s）只避免「并发刷新被误判为盗用而撤族」，**不**让客户端拿回
新的 refresh token。原因：实现它需要在服务端暂存明文 token（违反「只存哈希」），
或在宽限内重新签发（等于给窃取旧 token 的人另一次成功）。
v1 的选择是：**明确失败，要求重新授权**（设计 §9.10.1）。

### 16.5 本阶段修改的文件

| 文件 | 修订 |
|---|---|
| `REMOTE_MCP_PHASE_1_3_DESIGN.md` | §0.0 修订记录、§1.5 真实代码事实、§5 全文重写、§8.1/8.2、§9 全文重写、§10 五张表、§11.1 15 条、§12 19 组、§13 R1–R9、§14 N9–N11、§15 12 步、§16 术语、§17/§18 |
| `REMOTE_MCP_PHASES_ROADMAP.md` | §3.1 C3/C10/C12/C13；§3.2 路由组与「不得复用」；§3.3 新增 6 组测试；§3.4 新增 3b/5b |
| `REMOTE_MCP_PROTOCOL_LIFECYCLE.md` | §15 端点表 + 浏览器授权会话属性表 |
| `REMOTE_MCP_SECURITY.md` | §3.2.1 两层模型；§3.2.2 Cookie 边界 |
| `REMOTE_MCP_SECURITY_OPERATIONS.md` | §4.1 撤销矩阵；§4.1.7 浏览器会话安全（10 条不变量 + TOFU + CSRF 三层） |
| `REMOTE_MCP_INDEX.md` | 本节 |

### 16.6 仍未验证（新增三项，全部高危）

| # | 项 | 影响 |
|---|---|---|
| N9 | ChatGPT 收到 403 `insufficient_scope` 后是否做 step-up | 若不做，用户取消勾选会导致工具「永久不可用」 |
| N10 | ChatGPT 是否接受**可交互**的 consent 页 | 若要求静默批准，最小权限失去落点 |
| N11 | 注册回调是否允许非 `localhost` 的 https `redirect_uri` | 若只允许 localhost，第三方 MCP 的 OAuth 模式结构上不成立 |

叠加 §15 已有的 N1–N8（尤其 **N5：是否发送 `resource`**）。

## 17. Phase 1.3.1-A：OAuth 数据层（已交付，migration 0003）

Phase 1.3 的第一个**有代码**子阶段。范围严格限定为「五张表 + 迁移 + 约束测试」：
没有 OAuth 路由、没有 Token 签发、没有 Cookie、没有 `/mcp`、没有 MCP SDK。

### 17.1 交付物

| 项 | 落点 |
|---|---|
| 迁移 | `cloud/src/db/migrations/0003_mcp_oauth.sql`（+ `meta/_journal.json` idx 3 + `meta/0003_snapshot.json`） |
| Drizzle Schema | `cloud/src/db/schema.ts`：`mcpOauthClients` / `mcpAuthRequests` / `mcpAuthCodes` / `mcpSessions` / `mcpRefreshTokens` |
| 测试助手 | `cloud/tests/helpers/oauth-db.ts` |
| 约束测试 | `cloud/tests/mcp-oauth/{schema,refresh-tokens,relations,compat}.test.ts` = **42 条** |
| 文档 | 设计 §5.3.1 / §10.5 / §10.8；路线图 §3.0 / §3.6；本册本节 |

### 17.2 三条结构性决定

| # | 决定 | 为什么 |
|---|---|---|
| 1 | `UNIQUE(session_id) WHERE consumed_at IS NULL` | 「每个会话最多一条有效 refresh token」是**集合**不变量；应用层 `FOR UPDATE` 只保护单行，保护不了「只该有一条」 |
| 2 | `mcp_auth_requests` / `mcp_auth_codes` / `mcp_sessions` 的 `client_id` **零外键** | 与 `mcp_grants.client_id` 对齐；`mcp_oauth_clients` 是注册缓存不是归属主体；`CASCADE` 会连带删掉授权历史，`RESTRICT` 会让客户端下线无解 |
| 3 | `redirect_uris` 用 `cardinality` 而非 `array_length` | `array_length('{}',1)` 返回 `NULL`，CHECK 遇 `NULL` 视为通过 —— 空数组会被静默放行 |

### 17.3 数据层守卫（`mcp_sessions` 与 `mcp_refresh_tokens`）

```
mcp_sessions（身份）
  id = JWT sid          ← 授权时生成一次，跨刷新不变
  created_at            ← 不可变，90 天起点
  absolute_expires_at   ← 不可变，CHECK 强制 > created_at
        │ 1:N
        ▼
mcp_refresh_tokens（每代凭据）
  UNIQUE(token_hash)  UNIQUE(session_id, generation)
  UNIQUE(session_id) WHERE consumed_at IS NULL   ← 核心约束
  CHECK generation >= 1 / expires_at > created_at
  replaced_by 无外键（历史链允许独立清理）
```

`mcp_sessions` 上**没有** `refresh_token_hash` / `token_family` / `expires_at` /
`replaced_by`，并有测试断言它们不会回来——那四列回到同一张表就等于
「轮换 = 改 Session」，90 天绝对期限会重新变成可续命。

### 17.4 同阶段修正：浏览器 Cookie 的路径边界

`bp_mcp_bs` 的 `Path` 从 `/mcp` 收窄到 **`/mcp/oauth`**，consent 页从
`/mcp/consent` 挪到 **`/mcp/oauth/consent`**。原因：Cookie 的 Path 是前缀匹配，
`Path=/mcp` 会让授权 Cookie 出现在每一次 `POST /mcp`（真正的数据端点）上。
两处必须同时改，否则浏览器不带 Cookie、绑定校验必然失败。详见设计 §5.3.1。

### 17.5 实测与门禁（本次执行）

| 项 | 结果 |
|---|---|
| Cloud `typecheck` / `lint` / `build` | 通过 |
| Cloud `pnpm test` | **599 passed / 38 files**（R2 基线 557，**+42**） |
| Desktop `typecheck` / `test` | 通过；**1265 passed / 89 files**（未改 Desktop 代码） |
| 迁移兼容性 | 既有 8 张表的列 / 约束 / 索引与「只应用 0000–0002」**逐字相同** |
| 变异验证 | 5 个变异全部被抓（部分唯一索引 / 级联删除 / cardinality / 公共客户端 CHECK / 绝对期限 CHECK） |
| 新增迁移 | **1 个**（`0003`），不改 0000–0002 |
| 新增协议字段/错误码 | **无** |

### 17.6 未做（属 1.3.1-B / 1.3.1-C）

Refresh Token 签发与轮换、Session 服务、`signMcpAccessToken`、`MCP_BROWSER_SESSION_KEY`、
Cookie、consent HTML、CIMD 抓取器、DCR、`/mcp` 路由、MCP SDK 引入。

## 18. Phase 1.3.1-B：Refresh Token 与 Session 生命周期（已交付）

承接 §17（数据层）。本阶段实现设计 §9 的**运行时**语义：签发、轮换、重放检测、
90 天绝对期限、Session 生命周期与三方隔离。仍然没有路由、没有 JWT、没有 Cookie。

### 18.1 交付物

| 项 | 落点 |
|---|---|
| 服务 | `cloud/src/mcp-oauth/sessions.ts` |
| 审计 | `cloud/src/db/audit.ts` +5 个 `mcp_*` 事件类型（**无迁移**） |
| 测试 | `tests/mcp-oauth/{refresh-token-service,absolute-expiry,session-lifecycle}.test.ts` = **44 条**；夹具 `tests/helpers/mcp-oauth.ts`（可注入时钟） |

### 18.2 服务接口

| 接口 | 用途 |
|---|---|
| `createMcpSession(deps, {userId, grantId, issuedScope})` | 一个事务里校验 user active / grant 未撤销 / scope ⊆ grant，写 Session + 第一代 token，返回 `{sessionId, refreshToken}` |
| `rotateMcpRefreshToken(deps, {refreshToken})` | 锁 refresh → 锁 session → 逐条判态 → 消费旧代 + 插新代 + 只推 `last_used_at`；返回新 token 与 `effectiveScope` |
| `getMcpSessionState(db, sid, now?)` | `active` / `revoked` / `expired` / `missing` 惰性判定，不写库 |
| `revokeMcpSession(deps, {sessionId, reason})` | 打标记，**不删行**；幂等 |
| `revokeMcpSessionsByGrant(deps, {grantId, reason})` | 撤该 grant 全部 Session；**可传 tx**，与 grant 撤销同事务 |

`client_id` / `resource` 不由调用方传入，直接从 Grant 取——「Session 与 Grant 一致」
因此不是一条要校验的规则，而是不可能违反的结构事实。

### 18.3 Refresh Token 状态流转

```
                createMcpSession
                       │
                       ▼
              ┌──────────────────┐
              │  未消费（当前代）  │
              └────────┬─────────┘
      rotate           │           重放（≤30s）→ invalid_grant（**不撤会话**）
      ┌────────────────┤           重放（>30s） → invalid_grant + **撤 Session**
      ▼                │
┌──────────────┐       │
│ 已消费        │───────┘
│ consumed_at  │   replaced_by ──▶ 下一代（未消费）
└──────────────┘
      │ 历史行永久保留（重放检测依赖它）
      ▼
 （Session 删除时才 CASCADE）
```

### 18.4 三条实现不变量（都有对应测试）

| # | 不变量 | 证据 |
|---|---|---|
| 1 | 锁序恒为「先 refresh 行、后 session 行」 | 并发刷新用例：恰好一个成功，另一个 `invalid_grant`，会话不撤 |
| 2 | `created_at` / `absolute_expires_at` 无任何 UPDATE 路径 | ① 剥注释后扫描全部 `.set({…})`；② 5 次刷新后 Session 全列快照（除 `last_used_at`）逐字节相同；③ 反证 `last_used_at` 确实被推进 |
| 3 | 撤销先提交、再抛错 | 事务内只返回结论，审计与 `invalid_grant` 在 commit 之后 |

### 18.5 三方隔离（设计 §9.11 验收本体）

| 动作 | MCP Session | Desktop `auth_sessions` | 证据 |
|---|---|---|---|
| 撤销 MCP Session | revoked | **不受影响**（且 Desktop token 仍可轮换） | `session-lifecycle` |
| Desktop 登出（撤整族） | **不受影响**（MCP token 仍可轮换） | revoked | 同上 |
| MCP 刷新 | 只推 `last_used_at` | **零写入**（表里 0 行） | 同上 |
| 设备撤销 | **不受影响** | 不受影响 | 同上 |

### 18.6 实测与门禁（本次执行）

| 项 | 结果 |
|---|---|
| Cloud `typecheck` / `lint` / `build` | 通过 |
| Cloud `pnpm test` | **643 passed / 41 files**（1.3.1-A 基线 599，**+44**） |
| Desktop `typecheck` / `test` | 通过；1265 passed / 89 files（未改 Desktop） |
| 新增迁移 | **无** |
| 变异验证 | **9/9 全被抓**（续期缺陷 / 换 sid / 不夹绝对期限 / 宽限窗口失效 / 宽限外不撤 / 跨域哈希 / 不查 grant / 不查用户 / 撤销后删行） |

**过程中抓到并修掉一个假绿**：宽限用例最初在同一毫秒内重放（`sinceConsumedMs = 0`），
把窗口改成 0 也能通过。改为轮换后推进 5 秒再重放，「窗口 = 0」立刻变红。

### 18.7 未做（属 1.3.1-C）

authorize / login / callback / consent / token endpoint / `signMcpAccessToken` /
浏览器 Cookie / PRM 与 AS 元数据 / CIMD / DCR / `/mcp` 数据端点。

## 19. Phase 1.3.1-C1：Access Token / 浏览器 Cookie / Grant 竞态（已交付）

承接 §18。本阶段只交付**安全基础模块**：没有 HTTP 路由、没有 consent、
没有 token endpoint、没有 discovery、没有 CIMD/DCR、没有 `/mcp`、没有 SDK。

### 19.1 交付物

| 项 | 落点 |
|---|---|
| 常量 | `cloud/src/mcp-oauth/constants.ts`（`MCP_SCOPES`、scope 解析、`mcpResourceFor`、Cookie 名与属性） |
| Access Token | `cloud/src/mcp-oauth/tokens.ts`（`signMcpAccessToken` / `verifyMcpAccessToken` / `McpTokenError`） |
| 浏览器 Cookie | `cloud/src/mcp-oauth/browser-session.ts` |
| env | `MCP_BROWSER_SESSION_KEY`（可选，≥32 字节）+ `.env.example` |
| 竞态修复 | `createMcpSession` 的 Grant 读取加 `.for("update")` |
| 测试 | `grant-race`（4）+ `tokens`（28）+ `browser-session`（22）= **54 条** |

### 19.2 JWT

```
aud = MCP_RESOURCE = BASE_URL + "/mcp"     ← 真实资源 URI，不是常量
iss = BASE_URL
sub = 用户 id
sid = mcp_sessions.id                      ← 跨刷新不变
scope = issued_scope ∩ grant.scopes        ← 空格分隔，⊆ MCP_SCOPES
jti = randomToken(16)                      ← token 级标识，**不是请求去重键**
```

两套 token **共用 `JwtKeyRing`**（密钥轮换只有一处），隔离靠 `aud` + `iss` 的
**强制校验**。测试用「同 `sub` 同 `sid`」的同位对照排除「因为 claims 不同才失败」。

`jti` 有专门的用例断言「同一 token 可被反复验证」——任何「按 `jti` 拦重复」
的实现都会让 `/mcp` 的同 token 多次工具调用失败。

### 19.3 浏览器 Cookie

| 属性 | 值 | 为什么 |
|---|---|---|
| 名 | `bp_mcp_bs` | — |
| `Path` | **`/mcp/oauth`** | 前缀匹配：写 `/mcp` 会把它送到数据端点 |
| `HttpOnly` | true | JS 不可读 |
| `SameSite` | `Lax` | 登录是顶层跳转；同时挡跨站 POST |
| `Secure` | 生产 true | 开发 `http://localhost` 下会被丢弃，故可关 |
| `Domain` | 不设 | host-only |
| `Max-Age` | 1800 | **不滑动**（读取不回写） |
| 内容 | `{sid, iat, exp}` | 无 `user_id`、无任何 token |

读取时六种失败（缺 / 篡改 / 非法 JSON / 字段类型 / sid 形态 / 过期）**一律
`{ok:false}`**，绝不降级成匿名放行。额外两条防「窗口被悄悄放大」：`exp-iat`
不得超过 1800；`iat` 超前当前时间不得超过 60 秒（时钟漂移容差）。

密钥缺失或 <32 字节时 `assertBrowserSessionKey()` **抛错**，不生成临时密钥
（那会让重启后所有进行中的授权静默失效）。

### 19.4 Grant 竞态

```
不加锁：A: SELECT grant(未撤销) → B: UPDATE grant + 撤会话 + COMMIT
        → A: INSERT session（关联已撤销 grant，revoked_at IS NULL）→ COMMIT
        ⇒ 撤销完成之后又长出一条有效 Session，且那次撤销永远扫不到它
```

加 `FOR UPDATE` 后只剩两种合法结果（由 PG 行锁串行化）：

1. **A 先拿锁** → B 阻塞到 A 提交，然后 B 看到并撤销新 Session；
2. **B 先拿锁** → A 阻塞到 B 提交，重新读到 `revoked_at` 并拒绝创建。

**锁顺序：grant 行永远在 session 行之前**（创建与撤销一致）。20 轮并发无 `40P01`。

测试用 `pg_blocking_pids()` 把「确实有人在等这把锁」变成**可观测事实**，
不靠 sleep 猜时序。移除 `FOR UPDATE` 后 3 条用例立刻红，且失败原因明确
（`timed out waiting for a session blocked by …`）。

### 19.5 为什么 `MCP_BROWSER_SESSION_KEY` 不参与启动断言

Cloud 现在同时服务 Desktop 登录（`/oauth/*`、`/auth/*`）。把它设为必填会让
「只跑登录的部署」因为一个尚未启用的 MCP 能力起不来——那是把新功能的门禁
变成旧功能的故障。

正确纪律：**C2 挂载 `/mcp/oauth/*` 时，缺密钥就不注册那些路由**（fail-closed
在能力边界上，而不是整个进程上）。本阶段只提供 `assertBrowserSessionKey()`。

### 19.6 实测与门禁（本次执行）

| 项 | 结果 |
|---|---|
| Cloud `typecheck` / `lint` / `build` | 通过 |
| Cloud `pnpm test` | **697 passed / 44 files**（1.3.1-B 基线 643，**+54**） |
| Desktop `typecheck` / `test` | 通过；1265 passed / 89 files（未改 Desktop） |
| 新增迁移 | **无** |
| 新增 HTTP 路由 | **无** |
| 变异验证 | **15/15 全被抓**（见下） |

| 变异 | 结果 |
|---|---|
| 移除 Grant `FOR UPDATE` | 3 条红 |
| Cookie `Path` 改回 `/mcp` | 2 条红（`expected '/mcp' to be '/mcp/oauth'`） |
| Cookie TTL → 24h | 红 |
| `HttpOnly` → false | 红 |
| 不校验 `exp` | 红 |
| 签名失败降级为匿名放行 | 红 |
| 清除时用默认 Path | 红 |
| MCP token 用 Desktop 的 `aud` | 8 条红 |
| 验证时不校验 `aud` | 红 |
| 验证时不校验 scope 白名单 | 红 |
| 允许 `alg=none` | 红 |
| `jti` 改成固定值 | 红 |

### 19.7 未做（C2 / C3）

authorize / login / callback / consent 路由（C2）；token / revoke /
PRM / AS 元数据 / CIMD / DCR（C3）；`/mcp` 数据端点（1.3.2）。

## 20. Phase 1.3.1-C2a：authorize / login / Provider callback（已交付）

C2 的第一半。授权流程现在能从「客户端发起」走到「Provider 身份已确认、用户已
写回授权请求」，然后停在 `/mcp/oauth/consent`（**该路由属 C2b，当前 404**）。

### 20.1 交付物

| 项 | 落点 |
|---|---|
| 路由 | `cloud/src/routes/mcp-oauth.ts`：`GET /mcp/oauth/authorize` / `/login` / `/callback/:provider` |
| 业务层 | `cloud/src/mcp-oauth/authorize-flow.ts` |
| 登录页 | `cloud/src/mcp-oauth/login-page.ts` |
| 启用边界 | `cloud/src/mcp-oauth/enablement.ts` + `app.ts` 的能力判定 |
| 测试 | `authorize-route`(24) / `login-route`(24) / `callback-route`(23) / `route-enablement`(14) / `authorize-flow`(13) = **98 条** |

### 20.2 流程（本阶段实际打通的路径）

```
客户端 → GET /mcp/oauth/authorize?…（8 个参数逐项校验）
         → INSERT mcp_auth_requests（csrf 占位、binding NULL、user NULL）
         → Set-Cookie（复用或新建）→ 302 /mcp/oauth/login?rid=
用户浏览器 → GET /mcp/oauth/login?rid=…（TOFU 绑定）
         → 200 登录页（只列已配置的 Provider）
用户点 Google → GET /mcp/oauth/login?rid=&provider=google
         → 条件 UPDATE 占用 Provider（写 PR 哈希 + nonce 哈希）→ 302 到 Provider
Provider 回调 → GET /mcp/oauth/callback/google?code&state
         → 原子消费 State → 交换身份 → findOrCreateUserWithIdentity
         → 写 user_id → 302 /mcp/oauth/consent?rid=（**C2b 才实现**）
```

### 20.3 五条安全判据（每条都有测试）

| # | 判据 | 反例（被测试拒绝） |
|---|---|---|
| 1 | `redirect_uri` **逐字符**匹配注册值 | 尾斜杠、多路径、加 query、加 fragment、换协议、显式 443、主机名大小写 |
| 2 | `resource` 逐字符等于 `BASE_URL + "/mcp"` | 无 `/mcp`、多斜杠、换域名、换协议、缺失 |
| 3 | PKCE 只接受 `S256` + 43 字符 base64url | `plain`、`s256`、空、42/44 字符、带 `+`/`=` |
| 4 | `scope` 非空且 ⊆ `MCP_SCOPES` | 空、全空格、`records:write`、混合未知值 |
| 5 | `grant_types` 必须含 `authorization_code` | 只有 `refresh_token` 的客户端 |

### 20.4 与 Desktop 登录的隔离（回归已覆盖）

| 断言 | 结果 |
|---|---|
| MCP 流程不写 `oauth_codes` / `oauth_transactions` / `auth_sessions` | 0 行 |
| `/oauth/authorize` 仍只接受 `127.0.0.1` 回调 | 非回环仍 400 |
| `/oauth/callback/:provider` 仍在（JSON `invalid_grant`，不是 MCP 的 HTML 400） | 通过 |
| MCP 的 `bp_mcp_bs` 发给 `/auth/me` | 仍 401 |
| MCP 的 `bp_mcp_bs` 发给 `/oauth/token` | 仍 400 `invalid_request` |

### 20.5 启用边界（这是本阶段最容易被做错的一处）

`MCP_BROWSER_SESSION_KEY` 不合格时，`/mcp/oauth/*` **三个路由都不注册（404）**，
而 `/oauth/*`、`/auth/*`、`/mcp-devices/*`、`/health` 全部照常。

| 密钥状态 | `/mcp/oauth/*` | 其它路由 | 日志 |
|---|---|---|---|
| 缺失 / 空串 | 404 | 正常 | `mcp_oauth_disabled{reason:"missing_browser_session_key"}` |
| < 32 字节（按 UTF-8 字节） | 404 | 正常 | `…too_short` |
| 与 `JWT_SIGNING_KEY` 相同 | 404 | 正常 | `…reused_from_jwt` |
| 合格 | 正常 | 正常 | 无 disabled 日志 |

日志里**只有原因枚举**：不含密钥、不含长度、不含任何片段（有哨兵测试）。

### 20.6 变异验证（9/9 全部被抓）

| 变异 | 抓它的判据 |
|---|---|
| 移除 `redirect_uri` 精确匹配（改前缀） | 7 种近似 URI 全部 400 |
| 移除 `resource` 检查 | 5 种错误 resource 全部 400 |
| 放宽 PKCE（接受 `plain`） | `plain` 必须 400 |
| 跳过 TOFU 绑定 | 不同 sid 必须 400 + 删行 |
| State 不做原子消费（去掉 `consumed_at` 判据） | 行锁制造的交叠下「恰好一条成功」 |
| callback 不验证 provider | `reason` 必须是 `provider_mismatch`（不是 `consumed`） |
| 使用 Desktop 的回调地址 | `redirect_uri` 必须以 `/mcp/oauth/callback/` 开头 |
| 使用 Desktop 的表 | `oauth_transactions` 必须 0 行 |
| 缺密钥仍挂载路由 | `/mcp/oauth/*` 必须 404 |

**其中两条一开始是存活的**（State 原子消费、provider 验证）：它们各有第二道
防护（读阶段的 `consumed_at` / UPDATE 的 `provider` 条件），路由层的 400 无法
区分「第一道挡住了」与「第二道挡住了」。修法不是删掉纵深防御，而是**加业务层
测试**：断言内部 `reason`、并用行锁让两条并发调用**必然**都读到「未消费」。

### 20.7 实测与门禁（本次执行）

| 项 | 结果 |
|---|---|
| Cloud `typecheck` / `lint` / `build` | 通过 |
| Cloud `pnpm test` | **795 passed / 49 files**（1.3.1-C1 基线 697，**+98**） |
| Desktop `typecheck` / `test` / `build` / `mcp:build` | 全部通过；**1265 passed / 89 files**；`stdio.mjs` 911.67 kB 不变 |
| 新增迁移 | **无** |
| 新增 HTTP 路由 | **3 条**（均在 `/mcp/oauth/*`，缺密钥时不注册） |
| 跳过/待定的测试 | 无 `skip`、无 `todo` |

### 20.8 未做（当时的状态；C2b 已补齐，见 §21）

- **C2b**：`GET/POST /mcp/oauth/consent`、grant upsert、`mcp_auth_codes` 签发、
  CSRF 重新生成。当时 `csrf_hash` 是「一次性丢弃明文的随机占位」，**任何提交
  都不可能通过**（fail-closed）。**现已由 §21 实现。**
- **C3**：`/mcp/oauth/token`、`/revoke`、PRM、AS metadata、CIMD、DCR。
- **1.3.2**：`/mcp` 数据端点、工具面、`scopeForTool`、`MCP_SCOPES` 与
  Desktop `REMOTE_SCOPES` 的一致性测试。

---

## 21. Phase 1.3.1-C2b：Consent / Grant / 授权码（已交付）

C2 的后半。授权流程现在从「客户端发起」一直走到「302 带 `code` 回客户端」，
Cloud 侧不再有断点；`POST /mcp/oauth/token` 兑换 token 仍属 **C3（未实现）**。

### 21.1 交付物

| 项 | 落点 |
|---|---|
| 路由 | `cloud/src/routes/mcp-oauth.ts`：追加 `GET /mcp/oauth/consent`、`POST /mcp/oauth/consent` |
| 业务层 | `cloud/src/mcp-oauth/consent-flow.ts`（前置校验 / CSRF / deny / allow 事务） |
| 页面 | `cloud/src/mcp-oauth/consent-page.ts`（纯静态 HTML） |
| 在线同步 | `cloud/src/mcp-oauth/grant-sync.ts` |
| 审计 | 5 个新事件（无迁移） |
| 测试 | 7 个新文件 **104 条** + C2a 回归 **+13** |
| 迁移 | **无** |

### 21.2 流程（本阶段打通的路径）

```
GET  /mcp/oauth/consent?rid=…（Cookie + 绑定 + user_id + 已消费 Provider）
     → 生成 CSRF（只存哈希）→ 200 同意页（客户端名 / 回调 host / scope 列表）
POST /mcp/oauth/consent（rid / csrf / decision / scope[]）
     → 事务：行锁 → 重校验 → upsert grant → 插 60s 授权码 → 删授权请求
     → 提交 → 审计 → 清 Cookie → 302 redirect_uri?code&state&iss
```

拒绝（或取消全部勾选）走同一条原子删除，返回 `error=access_denied`。

### 21.3 四条安全判据（每条都有测试）

| # | 判据 | 反例（被测试拒绝） |
|---|---|---|
| 1 | CSRF 每次渲染换一把，比对用常量时间 | 旧表单、留十分钟的表单、重复字段、缺字段 |
| 2 | 最终 scope ⊆ 请求 scope | 提交未请求的 scope、未知 scope、写入权限 |
| 3 | 授权请求只被消费一次 | 同 rid 两个 allow、allow×deny、重放 |
| 4 | 三个写入同事务 | 授权码插入失败 → grant 不残留、请求仍可重试 |

### 21.4 Step-up 与 epoch

- Step-up 只在「已有 active scope ⊆ 本次请求 且 新增了 scope」时成立；
  已有项灰置不提交，服务端按并集补回（**旧权限不会丢**）。
- 非 Step-up 按勾选覆盖（支持**收窄**），不能凭旧 grant 把本次未请求的
  scope 加回来（越界即 400）。
- `mcp_grants.epoch`：新建 1；scope 未变不涨；scope 变了 +1；撤销后复活 +1。

### 21.5 在线 Grant 同步（提交之后）

| 情形 | 动作 |
|---|---|
| 新 grant / 复活，设备在线 | `installGrant()` |
| scope 变了、旧 ctx 已安装 | `replaceGrant()` |
| scope 未变且已安装 | 不发帧 |
| 无在线设备 | 不同步，等 `hello_ok` 快照 |

`ack` 超时 / `applied=false` / 离线都**不回滚数据库**；转发层 fail-closed，
设备重新握手时 `hello_ok` 按数据库重建快照。**授权码不会因为同步失败丢失。**

### 21.6 C2a 的四处回归（本阶段一起修）

| 问题 | 修法 |
|---|---|
| 服务端拉 `authorize` 后浏览器首次进 `/login` 无 Cookie | 仅未绑定时新建会话 + TOFU；已绑定仍 fail-closed；callback 永不匿名建会话 |
| Provider `error` 全部映射成 `access_denied` | 只有 `access_denied` 原样回传，其余 `server_error` |
| 交换失败返回 Cloud 500 | 302 回客户端带 `error=server_error` + `state` + `iss` |
| 旧 State 拒绝回调删掉新授权 | DELETE 补 `state_hash` / `provider` / `binding` / `consumed_at IS NULL` / 未过期 |

### 21.7 变异验证（13/13 全部被抓）

覆盖：删 CSRF 校验、CSRF 改普通比较、允许空 scope、允许越界 scope、
Grant 重复 INSERT、scope 变更不涨 epoch、撤销后无法复活、授权码明文入库、
TTL 改 1 小时、成功后不删授权请求、并发去掉行锁、授权码没落库但 grant 留下、
ack 失败仍当作已安装。

**M13 第一版存活**：`syncLag` 也会让派发失败，所以「只看派发结果」区分不出
「已安装」与「未安装」。改为直接断言
`inspectForwarder().connections[].grants[].installed === false` 之后被抓。

### 21.8 实测与门禁（本次执行）

| 项 | 结果 |
|---|---|
| Cloud `typecheck` / `lint` / `build` | 通过 |
| Cloud `pnpm test` | **912 passed / 56 files**（C2a 基线 795 / 49，**+117**） |
| Desktop `typecheck` / `test` / `build` / `mcp:build` | 全部通过；**1265 passed / 89 files**；`stdio.mjs` 911.67 kB 不变 |
| 新增迁移 | **无** |
| 新增 HTTP 路由 | **2 条**（`GET`/`POST /mcp/oauth/consent`，缺密钥时整组不注册） |
| 跳过/待定的测试 | 无 `skip`、无 `todo` |

### 21.9 未做（C3 / 1.3.2 / 1.3.3）

- **C3**：`/mcp/oauth/token`（code 兑换 + refresh 轮换）、`/revoke`、PRM、
  AS metadata、CIMD、DCR。**授权码兑换时创建 Session 也属 C3**——
  `mcp_sessions` / `mcp_refresh_tokens` 在 C2b 里一行都不写。
- **1.3.2**：`/mcp` 数据端点、8 个只读工具、`scopeForTool` 一致性。
- **1.3.3**：ChatGPT / Grok 真实联调。
- **仍未验证**：真实 Google / GitHub 的完整回调（本阶段用契约校验型 Mock）；
  真实客户端对 `iss` 参数与 60 秒授权码的接受度。

---

## 22. Phase 1.3.1-C2b-R1：绑定失败的条件删除（已交付）

C2b 的安全加固。两个「绑定不匹配」分支原本都按 `rid` 直接删行，而同一个
`rid` 允许在同一 Provider 下重新发起登录（换一把 `provider_state_hash`）：
旧 State 的失配回调会把用户刚发起的新授权一起删掉。

### 22.1 修复

| 位置 | 修复 |
|---|---|
| `/callback/:provider` 的 `binding_mismatch` | 改调 `deleteMismatchedProviderRequest()` |
| `handleProviderDenied` 的失配分支 | 同上 |
| `ConsumeOutcome` | `binding_mismatch` 独立成携带 `provider` / `stateHash` / `storedBindingHash` 的分支 |

### 22.2 判据（六条，值全部来自那次 SELECT）

`id` + `provider_state_hash` + `provider` + **行内** `browser_binding_hash` +
`provider_consumed_at IS NULL` + `expires_at > now`，`RETURNING id`。

- 命中 1 行：删掉「刚才读到的那一行」，写 `mcp_browser_binding_mismatch`。
- 命中 0 行：状态已变 → **不删、不审计、不重定向**，对外仍 400。
- 预期绑定**绝不**取请求携带的值（那是攻击者的）。

### 22.3 新增测试（+11 条）

| 用例 | 位置 |
|---|---|
| 正常回调：旧 State 的失配回调不能删新授权 | `callback-route.test.ts` |
| 拒绝：旧 State 的失配拒绝回调不能删新授权 | 同上 |
| 正常拒绝：旧 State 的拒绝回调不能删新授权 | 同上 |
| 拒绝路径状态未变时仍清理并审计 | 同上 |
| 条件删除的六条判据（命中 + 五种不命中） | `authorize-flow.test.ts` |

交错用**行锁 + `pg_stat_activity` 的 Lock 等待**构造，不 sleep、不重试。

### 22.4 变异（5/5 被抓）

失配清理去掉 state 判据（路由 / 业务层）、正常拒绝去掉 state 判据、
两处把预期绑定换成请求绑定——各有具体用例转红。

> 第一次跑的 M1 变异**误命中**了 `deleteDeniedProviderRequest` 里的同名条件
> （两处 SQL 片段相同），因此存活。顺手补了「正常拒绝：旧 State 的拒绝回调
> 也不能删除新授权」，把那条判据也钉住。

### 22.5 门禁

Cloud `typecheck` / `lint` / `build` 通过，`pnpm test` **923 passed / 56 files**；
Desktop `typecheck` / `test` / `build` / `mcp:build` 通过，**1265 passed / 89 files**，
`stdio.mjs` 911.67 kB 不变。**无新增迁移、无新增路由、未改 Desktop 生产代码。**

### 22.6 状态

C2b 至此完成（授权到「302 带 code」）；`/mcp/oauth/token` 已由 §23 补齐，
`/revoke`、PRM、AS metadata、CIMD、DCR、`POST /mcp` 仍属 **C3b / 1.3.2（未实现）**。

---

## 23. Phase 1.3.1-C3a：Token Endpoint（已交付）

授权链路闭环到「客户端拿到可用的 Access Token」。`mcp_sessions` 与
`mcp_refresh_tokens` 从本阶段开始真正被写入（C2b 里是零写入）。

### 23.1 交付物

| 项 | 落点 |
|---|---|
| 路由 | `cloud/src/routes/mcp-oauth.ts`：`POST /mcp/oauth/token` + 独立限流桶 `mcp-token` |
| 业务层 | `cloud/src/mcp-oauth/token-flow.ts`（`exchangeAuthorizationCode` / `exchangeRefreshToken`） |
| Session 服务 | `sessions.ts` 拆出 `createMcpSessionInTransaction(tx, …)`，`createMcpSession()` 变成事务包装 |
| 授权码哈希 | `mcpAuthCodeHash` 移到 `authorize-flow.ts`（签发与兑换共用） |
| 错误码 | `invalid_client`(401) / `invalid_scope`(400) / `unsupported_grant_type`(400) |
| 测试 | 5 个新文件 **70 条** |
| 迁移 | **无** |

### 23.2 单事务（本阶段唯一真正的新结构）

```
BEGIN
  ① SELECT mcp_auth_codes … FOR UPDATE
  ② 校验未消费 / 未过期 / client_id / redirect_uri / resource / PKCE S256
  ③ 条件 UPDATE 消费（consumed_at IS NULL + expires_at > now）→ RETURNING
  ④ createMcpSessionInTransaction(tx, …)      ← 同一个 tx
  ⑤ COMMIT
→ 事务外：签 JWT、写审计、在线 Grant 同步
```

`createMcpSessionInTransaction()` 内部对 Grant 取 `FOR UPDATE`，锁序
**grant → session**。并发兑换同一个 code 只有一个命中条件 UPDATE，另一个拿
`invalid_grant`——不会出现两条 Session 或两条初代 Refresh Token。

### 23.3 Refresh 绑定（补的缺口）

`rotateMcpRefreshToken()` 新增可选 `clientId` / `resource` / `requestedScope`，
**全部在改动任何状态之前判定**：

| 入参 | 失败 |
|---|---|
| `clientId` ≠ Session 的 | `invalid_client` 401 |
| `resource` ≠ Session 的 | `invalid_grant` |
| scope ⊄ `issued ∩ grant` | `invalid_scope` 400 |

顺序是安全要求：绑定校验必须排在「宽限外重放 → 撤销 Session」之前，否则
错误 `client_id` 反而能触发合法 Session 的破坏性撤销。`effectiveScope` 先算
后写，交集为空时拒绝且**不消费旧代**。

### 23.4 请求面

只接受 urlencoded（≤ 8 KiB，单字段 ≤ 512），**任何字段重复即 `invalid_request`**
（`Object.fromEntries` 的后者覆盖前者会制造校验绕过面）。`resource` 必须逐字符
等于 `mcpResourceFor(baseUrl)`。**完全不读 `bp_mcp_bs`**。

响应固定 `Cache-Control: no-store` + `Pragma: no-cache`；`expires_in` 取配置值。

### 23.5 测试（70 条）

| 文件 | 条数 | 覆盖 |
|---|---:|---|
| `token-code.test.ts` | 19 | 兑换成功、JWT claims、码消费、重放、过期、PKCE、client/redirect/resource 不符、Grant 撤销、用户非 active |
| `token-refresh.test.ts` | 20 | 轮换、generation、sid 稳定、绝对期限不变、宽限内/外重放、并发、client/resource 绑定、scope 收窄 |
| `token-atomicity.test.ts` | 6 | 事故注入证明「码消费 + Session + 初代 Refresh」同一事务；三种中途失败均整体回滚 |
| `token-route.test.ts` | 18 | 协议面：Content-Type、重复字段、未知 grant、错误码、响应头、Desktop 隔离 |
| `token-invariants.test.ts` | 7 | 静态不变量：无硬编码 TTL、无明文哈希、JWT 走 `signMcpAccessToken` |

### 23.6 变异（8/8 被抓）

去掉 `consumed_at IS NULL`、去掉码的 `FOR UPDATE`、去掉 PKCE、Session 创建
移出事务、初代 Refresh 明文存储、去掉 Refresh 客户端绑定、去掉重放保护、
`effectiveScope` 换成 Grant 全量。

> **M6 第一版存活**：锚点先命中同形代码（`bindingRejection` 出现两次），等于
> 只删了一半。修正锚点后 `token-route` 2 条转红。

### 23.7 门禁

Cloud `typecheck` / `lint` / `build` 通过，`pnpm test` **993 passed / 61 files**
（923 / 56 → **+70 / +5**）；Desktop `typecheck` / `test` / `build` / `mcp:build`
通过，**1265 passed / 89 files**，`stdio.mjs` 911.67 kB 不变。
**无新增迁移**、新增 **1 条** 路由、未改 Desktop 生产代码。

### 23.8 未做（C3b / 1.3.2 / 1.3.3）

`POST /mcp/oauth/revoke`、PRM、AS Metadata、CIMD、DCR、`POST /mcp`、8 个只读
工具、Streamable HTTP、真实 ChatGPT / Grok 联调。**未进入 C3b。**

---

## 24. Phase 1.3.1-C3a-R1：Token 请求面硬化（已交付）

C3a 的请求边界收口。**不动**兑换事务、轮换顺序、锁序、JWT claims、错误映射，
也不碰 Desktop。三处问题都在业务判据之前：

| # | 原实现 | 后果 |
|---|---|---|
| 1 | `body.length > 8192` | `.length` 是 UTF-16 码元数；3000 汉字（9000 字节）只算 3000 |
| 2 | `await c.req.text()` 之后再比大小 | 上限事后生效，任意大的请求先读进内存 |
| 3 | `startsWith("application/x-www-form-urlencoded")` | `…-evil` 只因前缀相同被当成表单 |

### 24.1 现在的请求面

```
Content-Length 存在？
  ├─ 不匹配 /^\d+$/ → 400 invalid_request（空值/负数/小数/科学计数/0x10）
  └─ > 8192 → 400（不读 body）
读 raw stream：逐 chunk 累加 byteLength
  ├─ total > 8192 → reader.cancel() → 400
  └─ 读完 → 合并 → TextDecoder("utf-8", { fatal: true }) → URLSearchParams
```

- **字节不是字符**：`.length` 与 `byteLength` 在多字节字符上差 3 倍。
- **边读边截断**：1 MiB 的流只拉取 ≈9 KiB（测试直接计数 `pulled`）。
- **Content-Length 只是早退优化**：缺失走流累计、撒谎仍被累计值拒。
- **严格媒体类型**：类型逐字符相等 + 只允许 `charset=utf-8`；
  `-evil`、`boundary=x`、空参数、`charset=iso-8859-1`、JSON、multipart 全拒。
- **严格 UTF-8**：非法字节 fail-closed，不替换 U+FFFD。
- **顺序**：先截断再解码——否则两条拒绝理由互相掩盖。

### 24.2 测试（+16，`token-route` 18 → 34）

| 组 | 条数 |
|---|---:|
| 请求体字节上限 | 9（含 8192 恰好通过 / 8193 拒绝 / 1 MiB 流计数） |
| Content-Type 严格解析 | 4 |
| UTF-8 严格解码 | 3 |

全部断言数据库状态：`mcp_auth_codes.consumed_at` 为 NULL、`mcp_sessions` 与
`mcp_refresh_tokens` 零行——超限不得留下半张授权。

### 24.3 变异（7/7 被抓）

`.length` 代替字节、读完整再判、`startsWith`、不校验 CL 合法性、非 fatal 解码、
只信 CL、接受任意 charset。

> 三条第一版存活，全是**测试**的问题：媒体类型用例传对象而非字符串正文
> （400 来自「grant_type is required」）、非法 UTF-8 与 CL 非法值用例只发了
> 半截表单（宽松解码后同样死在缺字段，错误码相同）。改成「完整合法表单 +
> 只破坏一个维度」后全部转红。

### 24.4 门禁

Cloud `typecheck` / `lint` / `build` 通过，`pnpm test` **1009 passed / 61 files**
（993 → **+16**，文件数不变）；Desktop `typecheck` / `test` / `build` / `mcp:build`
通过，**1265 passed / 89 files**，`stdio.mjs` 911.67 kB 不变。
**无新增迁移、无新增路由、未改 Desktop 生产代码。**

### 24.5 状态

**C3a 已完成并经 R1 / R2 修订**。C3b（`/revoke`、PRM、AS Metadata、CIMD、DCR）
未开始。

---

## 25. Phase 1.3.1-C3a-R2：字段限长与 Content-Type 参数唯一性（已交付）

R1 之后仍有两处不对称：

| 问题 | 说明 |
|---|---|
| `scope` 无长度上限 | 走 `form.get("scope")`，绕过 `requireField()`；600 字符也能到达 `parseScopeParam` |
| 未知扩展字段无长度上限 | 只要整个 body ≤ 8 KiB，单个扩展字段可以任意长 |
| Content-Type 参数可重复 | `charset=utf-8; charset=UTF-8` 被接受；两个解析器各取一个就是两种行为 |

### 25.1 修法

- `parseTokenForm()` 建 Map 的循环里统一判 `value.length > 512` → `invalid_request`。
  必填、可选（`scope`）、未知扩展一视同仁，且在业务层之前完成。
- `requireField()` 的长度检查**保留**（第二道，防未来绕过 `parseTokenForm()` 的调用路径）。
- 未知扩展字段仍**忽略语义**，但不忽略长度。
- 错误文案**不回显字段名**（参数名由请求方控制，拼进去是日志注入面）。
- `isFormContentType()` 增加 `seen` 集合：同名参数第二次出现即拒，
  大小写不敏感，**值相同也拒**。

### 25.2 测试（+7，`token-route` 34 → 41）

| 用例 | 判据 |
|---|---|
| scope 512 → 200 | 边界 512；码被消费、Session/Refresh 各 1 行 |
| scope 513 → 400 | 码未消费、Session/Refresh 零行 |
| 未知扩展 513 → 400 / 512 → 200 | 忽略语义但限长 |
| code 700 → 400 | 必填字段同判据 |
| 重复 charset（4 种写法）→ 400 | 值相同、仅大小写不同都拒 |
| 单个 charset → 200 | 排除误伤 |

> 测试里的填充构造器也一并重构：原 `paddedForm` 用一个 7000 字符的 `pad`
> 撑 body，现在会先撞字段上限。改成按目标字节数拼多个 ≤500 字符的字段，
> 「8 KiB 边界」那几条才继续测字节维度。

### 25.3 变异（3/3 被抓）

删除统一限长（2 条转红）、允许参数重复（1 条）、边界放宽到 513（2 条）。

### 25.4 门禁

Cloud `typecheck` / `lint` / `build` 通过，`pnpm test` **1016 passed / 61 files**
（1009 → **+7**，文件数不变）；Desktop `typecheck` / `test` / `build` / `mcp:build`
通过，**1265 passed / 89 files**，`stdio.mjs` 911.67 kB 不变。
**无新增迁移、无新增路由、未改 Desktop 生产代码。**

### 25.5 状态

C3a（含 R1 / R2）完成。C3b 由 §26 交付。

---

## 26. Phase 1.3.1-C3b：Token Revocation（已交付）

`POST /mcp/oauth/revoke`（RFC 7009）。撤销单位是 **Session**，不是 Grant。

### 26.1 交付物

| 项 | 落点 |
|---|---|
| 路由 | `cloud/src/routes/mcp-oauth.ts`：`POST /mcp/oauth/revoke` + 独立限流桶 `mcp-revoke` |
| 业务层 | `cloud/src/mcp-oauth/revoke-flow.ts`（`revokeToken`） |
| 错误码 | `unsupported_token_type`（400） |
| 表单 | 复用 `parseTokenForm()`（8 KiB / 512 字符 / 重复字段 / 严格媒体类型） |
| 撤销 | 复用 `revokeMcpSession({ reason: "client_revoke" })` |
| 迁移 | **无** |

### 26.2 响应

| 输入 | 结果 |
|---|---|
| 有效 Refresh Token（未消费、未过期、Session active） | 200 空体 |
| 随机 / 不存在 / 已消费旧代 / 已过期 / Session 已撤销或已过期 | 200 空体 |
| 有效 MCP Access JWT | 400 `unsupported_token_type` |
| 缺 token / 重复字段 / 媒体类型错 / 超限 | 400 `invalid_request` |

无效 Token 一律 200（RFC 7009 §2.2）——区分原因会把端点变成存在性探针。
所有响应（含 400）带 `no-store` + `no-cache`。

### 26.3 Session / Grant 隔离（核心证据）

B 组用「同一个 Grant 下的两个 Session」验证：

- 撤 A：A 的 `revoked_at` 写入、`revoked_reason = client_revoke`；**B 仍 active**；
- `mcp_grants` 的 `scopes` / `epoch` / `revoked_at` 逐字段不变；
- `auth_sessions`（Desktop）零写入；
- 两行 Session 都还在，`user_id` / `grant_id` 归属不变；
- 撤销别的 client 的会话时，本 client 不受影响。

**RFC 7009 §2.1 SHOULD 偏离**：RFC 建议撤销 Refresh 时连带失效该授权下的
Access Token。本项目以 Session 为凭证家族边界，`/mcp` 按 `sid` 回查状态，
所以「连带失效」的**效果**成立，但不走撤销 Grant 这条更粗的路径。

### 26.4 `token_type_hint`

只当提示：先查 Refresh 哈希（唯一索引），未命中才验 Access JWT。因此 Hint
缺失 / 未知 / 写成 `access_token` 都不影响正确撤销；反过来先验 JWT 会让每个
无效 token 都花一次签名验证。

### 26.5 测试与变异

+31 条（Cloud 1016 → **1047 / 62 files**）：协议面 10、Session 隔离 3、
Token 生命周期 7、Hint 7、并发与审计 3、服务层幂等 1。

> 服务层幂等那条是刻意的：路由在调用前先判 `getMcpSessionState()`，所以
> 「重复撤销」在 HTTP 层提前返回，测不到 `revokeMcpSession` 自己的
> `WHERE revoked_at IS NULL`。直接打服务层才钉得住。

变异 7/7：删 `revoked_at IS NULL`、扩大成 Grant 批量撤销、不查 `consumed_at`、
不查 `expires_at`、无效 Token 返 400、错误响应回显 Token、重复撤销仍写审计。

### 26.6 门禁

Cloud `typecheck` / `lint` / `build` 通过，`pnpm test` **1047 passed / 62 files**；
Desktop `typecheck` / `test` / `build` / `mcp:build` 通过，**1265 passed / 89 files**，
`stdio.mjs` 911.67 kB 不变。**无新增迁移、未改 Desktop 生产代码。**

### 26.7 状态

C3b 完成。**C3c 未开始**（PRM、AS Metadata、CIMD、DCR）。
