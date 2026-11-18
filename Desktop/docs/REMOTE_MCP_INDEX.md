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
