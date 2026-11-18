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
