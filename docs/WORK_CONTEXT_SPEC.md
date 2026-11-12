# BrewPhase Work Context V1 — 持续工作上下文

> 状态：V1 已实现（2026-11-12）。这份文档描述**已经落地的结构**。
> 工具入参见 `MCP_TOOLS.md`，信任边界见 `MCP_SECURITY.md`。

## 1. 目标

让 BrewPhase 记住「用户正在做什么」：

- 一项持续工作的**名称、目标、当前进度、下一步**；
- 它**关联了哪些资料**（Records / Canvas / 外部 URL——只存 ID 与 URL，不复制内容）;
- WorkBuddy / Codex 下次通过 MCP 恢复工作时，先 `list_work_contexts` →
  `get_work_context`，就能从上次停下的地方继续。

**不是**：任务管理系统、甘特图、看板、独立便签系统。不重复 Records / Canvas
的任何能力。

## 2. 数据模型（migration 008）

### `work_contexts`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | TEXT PK | UUID |
| title | TEXT NOT NULL | 工作名称（≤200） |
| goal | TEXT DEFAULT '' | 工作目标（≤2000） |
| summary | TEXT DEFAULT '' | 当前进度摘要（≤4000） |
| next_step | TEXT DEFAULT '' | 下一步计划（≤2000） |
| status | TEXT DEFAULT 'active' | active / paused / completed |
| created_at / updated_at / last_activity_at | INTEGER | epoch 毫秒，Main 维护 |

### `work_context_resources`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | TEXT PK | UUID |
| work_context_id | TEXT FK → work_contexts ON DELETE CASCADE | |
| resource_type | TEXT | record / canvas / url |
| resource_id | TEXT | 实体 ID；url 类型存规范化 HTTP(S) 地址 |
| role | TEXT DEFAULT 'reference' | source / output / reference |
| note | TEXT DEFAULT '' | 可选说明（≤500） |
| created_at | INTEGER | |

约束：`UNIQUE (work_context_id, resource_type, resource_id)`——同一上下文不重复
关联同一资源。Record / Canvas 被删除后，**读取时自动清理失效关联**
（prune-on-read）；URL 关联永久有效。

**V1 边界**：

- Desktop 本地数据，**不进 change_log，不进 iOS 同步协议**；
- 不提供删除接口（Agent 无删除权限）；无关联内容的复制；
- 不保存本地文件系统路径。

## 3. Application Service

`WorkContextService`（`src/main/application/work-context/work-context-service.ts`）：

- `create / list / get / update / link` + `listForStudio`（Studio Home 扁平视图）；
- `update` 支持 `expectedUpdatedAt` 乐观并发（不匹配抛 `STALE_RECORD`）；
- `link` 校验 record / canvas 真实存在，URL 仅 http/https，重复关联幂等；
- 所有写操作 `events.emit('workContexts')` → Main 广播 `app:changed` →
  Studio Home 区块自动刷新；
- 业务错误统一 `WorkContextError extends ApplicationError`（code 原样透给 MCP）。

## 4. MCP 工具（5 个新增，总计 23）

| 工具 | Scope | 幂等键 | 说明 |
| --- | --- | --- | --- |
| `list_work_contexts` | `work_context:read` | — | status 过滤，按最近活动排序，含资源计数 |
| `get_work_context` | `work_context:read` | — | 基本信息 + 全部关联资源（类型/角色/label） |
| `create_work_context` | `work_context:create` | ✓ | title 必填；返回 `context_id` |
| `update_work_context` | `work_context:update` | — | `expected_updated_at` 乐观锁；只改传入字段 |
| `link_work_context_resource` | `work_context:link` | ✓ | 关联现有资源；重复关联幂等 |

新增 Scope：`work_context:read` / `create` / `update` / `link`（设置 → AI 连接
里按客户端单独勾选）。写操作全部进审计表；响应带
`sync_status: "desktop_local_only"`。

## 5. Studio Home「继续工作」

三栏工作台下方追加一个轻量区块（`WorkContextSection`）：

- 仅当存在 active 上下文时渲染；
- 每张卡片：标题、进度摘要（2 行截断）、下一步、资源计数、资源 chips；
- chip 点击：record → Records 页；canvas → Canvas 页；url → 内置浏览器打开；
- 数据经只读 IPC（`work-contexts:studio`），订阅 `app:changed` 的
  `workContexts` 域自动刷新。

## 6. 兼容性说明

- **MCP 幂等键按 client_id 隔离**：跨客户端恢复工作必须先
  `list_work_contexts` 查询，不能依赖幂等键去重；
- 既有 18 个工具行为不变；`mcp-protocol` 集成测试的工具数断言从 18 → 23；
- Windows 的 Bridge（Named Pipe）与 macOS / Linux（Unix socket）行为一致。

## 7. 已知限制与下一阶段建议

- 无状态变更历史（只有最新摘要）；如需时间线，V2 可加 `work_context_events`；
- 不支持把上下文导出 / 归档为 Record；
- Studio Home 只展示最近 3 个 active 上下文；
- 资源关联不支持顺序（role 之外无排序字段）。
