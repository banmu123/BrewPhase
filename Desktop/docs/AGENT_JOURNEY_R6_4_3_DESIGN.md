# Agent Journey · R6-4.3.0 工作区证据与代码 Diff 架构蓝图

> **状态：设计阶段（R6-4.3.0）——本文档不包含任何已实现的证据采集代码。**
>
> 分支 `feature/remote-mcp` · 基线 `66575db798c84dd8905da8121836d479a7574669`
> （`git fetch` 后实测，本地 HEAD 与 `origin/feature/remote-mcp` 一致；工作区干净）

## 状态图例（全文统一）

| 标记 | 含义 |
|---|---|
| **[已实现]** | 当前代码里已经存在并运行 |
| **[已验证]** | 本阶段用真实文件 + 行号复核过 |
| **[设计确定]** | 本 ADR 已给出结论，P1 起照此实现 |
| **[待实现]** | 设计已定，尚未写代码 |
| **[尚未决策]** | 有意留白，列在 §17，附解锁条件 |

## 方案前提（用户已确认）

**方案 A**：通过用户授权的 Local Workspace，在 Agent Journey 任务执行期间采集 Git 工作区状态，观察实际文件变化，与 Agent 自述对照展示。

- **不是** Agent 进程的全量操作 Hook。
- 本阶段 `evidence_level` 仍只允许 `agent_reported`，**不修改它**，也不让 MCP Agent 声明 `workspace_observed` / `runtime_observed`——改用独立的 evidence provenance 字段（§7、§10）。

---

## 1. 当前实际代码基线

| 项 | 值 |
|---|---|
| 仓库 | `banmu123/BrewPhase` |
| 分支 | `feature/remote-mcp` |
| 远程 HEAD | `66575db798c84dd8905da8121836d479a7574669` |
| 本地 HEAD | 同上（`git fetch` 后比对一致） |
| 工作区 | **干净**（`git status --short` 为空，0 ahead / 0 behind） |
| 迁移版本 | **15**（`src/main/database/migrations.ts:760-776`：14 `agent-journeys`、15 `canvas-journey-fusion`） |
| MCP 工具 | **33** 个（`src/shared/mcp/tool-schemas.ts`），Scope **16** 个 |
| 测试规模 | **105** 个单测/集成文件 + **40** 个 E2E spec |
| 已完成阶段 | R6-0/0.1 设计 → R6-1/1.1 数据模型 → R6-2/2.1 MCP → R6-3/3.1 Skill → R6-4/4.1 Records+Canvas 融合 → R6-4.1.1 视觉 → R6-4.2/4.2.1/4.2.2 结构化证据与事件契约 |

---

## 2. Local Workspace 现有能力

### 2.1 `LocalWorkspaceService`（`src/main/application/local-workspace/local-workspace-service.ts`）**[已实现]**

构造函数 `:58-61` 仅依赖 `db: Db` + `events: ApplicationEvents`。实例化于 `src/main/index.ts:259-261`。

| 方法 | 行 | 要点 |
|---|---|---|
| `list()` / `get(id)` | :65 / :69 | `availability` **不落库**，读时 `lstatSync` 现算（:194-206） |
| `addFromDialog()` / `add(path)` | :78 / :102 | 上限 **16**（:103）；`realpathSync` 规范化（:108）；必须是目录；大小写不敏感查重；`emit('localWorkspaces')`（:131） |
| `rename` / `remove` | :135 / :145 | `remove` **只删登记不碰真实文件夹**（:145-150） |
| `resolveRoot(workspaceId)` | :153 | 最终根校验，`lstat` 不跟叶子链接 |
| `binding(tabId)` / `setBinding` / `clearBinding` | :161 / :170 / :180 | tab 关闭清理在 `src/main/index.ts:328-333` |

### 2.2 表结构 **[已实现]**

**`local_workspaces`**（`src/main/database/schema.ts:665-677`，DDL `migrations.ts:504-517`，version 12）：
`id` PK · `name`(≤80) · **`absolute_path`（realpath，唯一索引 :676）** · `platform` · `created_at` · `updated_at`。
→ **存绝对路径**，但**无 `availability` 列**（读时计算），无 `realpath` 冗余列。

**`card_workspace_bindings`**（`schema.ts:684-694`，DDL `migrations.ts:519-530`）：
`tab_id` PK · `workspace_id` **刻意无外键** · `created_at` · `updated_at`。
→ **删除工作区后保留悬空绑定**，UI 显示「绑定失效」（注释 `schema.ts:679-683`；悬空判定 `:161-167`）。这是「关联不随宿主销毁」的既有范式。

### 2.3 `WorkspaceFileService`（纯只读）**[已实现]**

文件头 `:20-30` 三条铁律：只收 workspaceId + POSIX 相对路径 / 一律 realpath 比对 / **没有写、执行、删除入口**。

- `listFiles` :89 / `readFile` :129 / `searchFiles` :176
- 闸门 `resolveInside` :242-268：拒绝对路径、盘符、反斜杠、NUL，realpath 后必须仍在根内
- `resolveWorkspaceRoot` :324-335（`lstat` 不跟叶子链接）

**限制常量**（`src/shared/contracts/local-workspace.ts`）：

| 常量 | 值 | 行 |
|---|---|---|
| `LOCAL_WORKSPACE_MAX` | 16 | :15 |
| `WORKSPACE_FILE_MAX_BYTES` | 512 KB | :20 |
| `WORKSPACE_FILE_MAX_CHARS` | 64 000 | :22 |
| `CONTEXT_TOTAL_CHAR_LIMIT` | 200 000 | :24 |
| `CONTEXT_MAX_FILES` | 20 | :26 |
| `WORKSPACE_SEARCH_MAX_DEPTH` / `_FILES` | 8 / 2 000 | :29 / :30 |

### 2.4 敏感与忽略规则（**唯一权威清单**）**[已实现]**

`workspace-file-service.ts`：

- `IGNORED_DIRECTORY_NAMES` :33-41 = `node_modules, .git, dist, build, coverage, .next, vendor`
- `SENSITIVE_FILE_PATTERNS` :44-52 =
  `/^\.env(\..*)?$/i`、`/\.pem$/i`、`/\.key$/i`、`/^id_rsa(\..*)?$/i`、`/^id_ed25519(\..*)?$/i`、`/^credentials(\..*)?$/i`、`/^secrets?(\..*)$/i`
- `isSensitiveName` :296-298；**三处强制**：列表 :114、读取（`PERMISSION_DENIED`）:133-135、搜索 :211
- 测试：`tests/unit/workspace-file-service.test.ts:187-194`

> ⚠️ **`.git` 在忽略名单里**（:35，测试 `:39,48,64` 断言不返回）。Git 证据采集必须**显式绕过**，且**绝不能**把 `.git` 原始内容通过 MCP 暴露给客户端。

### 2.5 绑定链路与 MCP 的空白 **[已验证]**

```
CardWorkspaceToolbar.tsx:105-114 → preload/index.ts:388-389 → register.ts:971-979
  → LocalWorkspaceService.setBinding:170 → repositories/local-workspaces.ts:130-148（事务先删后插）
```

**MCP 侧与 Workspace 零关联**：

- `mcp_clients`（`schema.ts:357-369`）= `id, name, token_hash, scopes, created_at, last_used_at, revoked_at` —— **无 workspace 字段**
- 33 个 MCP 工具无一涉及 workspace/文件
- `ToolExecutionContext` 只有 `{ channel, actor.clientId }`（`src/shared/contracts/mcp.ts:59-74`）—— **无 workspace 维度**
- `mcp_operation_log` / `mcp_idempotency` 同样无 workspace（`schema.ts:375-408`）

→ 现有两条绑定**互不相交**：`tabId → workspaceId`、`clientId → scopes`。**需要新建桥接（§5）。**

### 2.6 IPC 与 local-first **[已实现]**

10 个 workspace 通道（`src/shared/contracts/validation/ipc.ts:269-283` 名称 / `:604-630` schema / `src/main/ipc/register.ts:956-1005` / `src/preload/index.ts:383-397` / `src/shared/contracts/index.ts:587-604`），注释 `ipc.ts:269-271` 明确「**绝对路径与写操作没有对应通道**」。

**完全不进 change_log**：`recordChange`（`src/main/database/repositories/sync-log.ts:9`）的调用方只有 `records/coffee/canvas` 三个 repository，local-workspace **零调用**；`schema.ts:660-664` 与 `migrations.ts:505-506` 声明「只进本地库」；`src/main/sync/wipe.ts:29-43` 的 `SYNC_ENTITY_TYPES` 不含它。

---

## 3. Agent Journey 现有能力

### 3.1 状态机 **[已实现]**

`src/main/application/agent-journey/agent-journey-service.ts`：

```ts
:194 EXECUTION_TRANSITIONS  planned→[running,skipped,cancelled]  running→[completed,failed,skipped,cancelled]
                            completed/failed/skipped/cancelled → []（终态）
:209 JOURNEY_TRANSITIONS    created→[running,cancelled] running→[paused,failed,cancelled]
                            paused/failed/abandoned→[running,cancelled] completed/cancelled→[]（终态）
```

### 3.2 三个写入口的真实事务/emit 边界 **[已验证]**

| 方法 | 事务 | emit | 关键行 |
|---|---|---|---|
| `createJourney` | `:292-351` | `:354` **事务外** | 注释 `:353`「回滚时根本走不到这里」 |
| `appendEvent` | `:440-598` | `:600` **事务外** | Journey 状态推进 `:568-585`；**outcome→completed `:578-582`** |
| `updateEventStatus` | **无事务**（单条 CAS UPDATE） | `:643` | 入参 `:606-611`；乐观锁 `expectedUpdatedAt`；`STALE_RECORD` `:640-642`；repository `src/main/database/repositories/agent-journeys.ts:516-532` |
| `updateJourneyStatus` | `:679-704` | `:706` **事务外** | **取消时批量关掉未收尾执行 `:681-692`**（直接调 `updateEventStatusRow`，**绕过 `updateEventStatus`**） |

- `emit` 全部在事务外；`ApplicationEvents.emit` 同步且吞掉监听器异常（`src/main/application/events/application-events.ts:26-34`）
- 唯一订阅者 `src/main/index.ts:244-248` → `webContents.send('app:changed', domain)`
- execution 创建为 `planned`：`:405` `input.status ?? (statement ? 'completed' : 'planned')`，强制校验 `:406` + `:1029-1050`

### 3.3 状态迁移**只能从 MCP 来** **[已验证]**

`src/main/application/mcp-tools/handlers.ts:429`（`updateEventStatus`）与 `:443`（`updateJourneyStatus`）是**全仓唯二调用方**；`validation/ipc.ts` 中**无任何 journey 状态类 IPC 通道**（现有 7 条 journey 通道只读 + 笔记 + 关系，`ipc.ts:133-139`）。

→ **Snapshot 触发点完全收敛在 `AgentJourneyService` 三处**，不需要在 Renderer 或 MCP 层埋点。

### 3.4 脱敏与预算（`src/main/application/agent-journey/sanitize.ts`）**[已实现]**

`JOURNEY_TEXT_LIMITS` `:26-35`（title 200 / goal·summary·reason 2 000 / content 20 000 / label 120）；`JOURNEY_METADATA_MAX = 16_000` `:60`；`redactSecrets` `:114-128`（PEM→Bearer→JWT→AWS→`bp_mcp_`→ENV→KEY_VALUE→三种用户路径）；`sanitizeJourneyContent` `:136-143` **先脱敏后截断**；`redactDeep` `:167-185` **敏感键名整棵子树替换**；`SENSITIVE_KEY_PATTERN` `:193-194`；`TRUNCATION_MARKER` `:41`。

### 3.5 UI 现状 **[已实现]**

| 组件 | 规模 | 说明 |
|---|---|---|
| `src/renderer/src/shared/EventDetailSections.tsx` | 231 行 / 6 分区 | Records 与 Canvas **共用**，渲染 Agent Reported 详情 |
| `src/renderer/src/features/records/JourneyDetail.tsx` | 482 行 | 纵向时间线，`expanded` Set（:34）、`toggleExpanded`（:99） |
| `src/renderer/src/features/canvas/JourneyInspectorBody.tsx` | 502 行 / 5 分区 | `.journey-inspector__section` :233/:297/:320/:405/:468，`confirmAction` :189 |
| `src/renderer/src/features/canvas/JourneyGroupShape.tsx` | 1251 行 | `countsText`（`parseJourneyDetail` → 文件数+验证数，:763-768） |
| `src/renderer/src/features/canvas/journey-layout.ts` | — | `JOURNEY_NODE_SIZE` 高度 **160**（:37） |

- i18n：`src/renderer/src/i18n/messages/zh-CN/records.ts` 的 `journey.*` 现 **41 键**（含 `detail` 分区键）
- CSS：`src/renderer/src/styles/app.css` 有 **212** 行 journey 相关；`.journey-diff`（:10907 起）只是 before/after 文案块；**无 `<pre>` / diff 渲染样式**
- 视觉基建：`tests/e2e/journey-visual.e2e.spec.ts`（957 行，`VISUAL_CHECK=1` 才跑，`/tmp` 截图 + `app.evaluate` 调 BrowserWindow 尺寸）

---

## 4. 缺失的系统连接

| # | 缺口 | 证据 |
|---|---|---|
| G1 | **Journey ↔ Workspace 无任何关联** | `agent_journeys` 无 workspace 列（`schema.ts:789-816`）；`mcp_clients` 无（`:357-369`） |
| G2 | **主进程无 Git 能力** | 无 `isomorphic-git`/`simple-git`/`nodegit`/`dugite`（三个 package.json 均无）；应用代码**从不调用 git**（唯一 `child_process` 先例 `src/main/integrations/chrome/chrome-host-installer.ts:14,273,288`）；`.git` 仅作为忽略目录出现（`workspace-file-service.ts:35`） |
| G3 | **无 Snapshot 概念** | 15 版迁移无任何 snapshot/evidence 表（`migrations.ts:760-776`） |
| G4 | **无证据 provenance 字段** | `evidence_level` 只有 `agent_reported`（Service 写死，R6-4.2.1 测试锁死） |
| G5 | **无 Journey 删除** | `removeJourneyFromCanvas` 只删摆位（`src/main/application/canvas/canvas-journey.ts:275`）；**证据清理无挂载点** |
| G6 | **无「按实体删本地文件」机制** | `removeImageFiles`（`src/main/media/store.ts:103-106`）唯一生产调用是**失败回滚**（`src/main/integrations/chrome/chrome-image-receiver.ts:170`）；`src/main/application/records/record-service.ts:249-251` 删记录**不删媒体**；全量只有 `wipe.ts:117-134` |
| G7 | **数据目录迁移只搬两样** | `src/main/data-location.ts:191-200` 搬 `brewphase.db/-wal/-shm`、`:206-213` 搬 `media/` —— **新目录若不加进清单，切数据位置即孤儿** |
| G8 | **无 `<pre>`/diff 样式** | `app.css` 仅 `.journey-diff` 文案块（:10907 起） |

---

## 5. Journey / Workspace 关系设计

### 5.1 三方案对比

| | A. 创建时 MCP 传 `workspace_id` | B. Desktop 主动绑定 | C. MCP Client 配默认 Workspace |
|---|---|---|---|
| 授权语义 | 引用**已登记**的 workspace（非路径） | 用户显式点击 | 客户端配置，脱离当前任务 |
| 与既有范式 | **与 `work_context_id` 完全同构**（`src/shared/mcp/tool-schemas.ts:416`） | 与 `card_workspace_bindings` 同构（`schema.ts:684-694`） | 无先例 |
| Agent 能否越权 | 只能引用已存在的 UUID，**拿不到路径** | 不能 | 可能指向用户已忘记的目录 |
| 任务中断恢复 | 重连即带 | 需用户再点一次 | 自动 |
| 风险 | Agent 选了「存在但不属于本任务」的 workspace | 摩擦 | 身份与任务解耦 |

### 5.2 v1 决策：**A + B 双通道，Journey 单 Workspace** **[设计确定]**

1. **一个 Journey 最多关联一个 Workspace。**
   多 Workspace 会立刻带来规格 §4 点名的四个当前无法回答的问题：多个仓库各自基线怎么存、Snapshot 怎么排序、一个事件怎么指定影响了哪个工作区、一个事件怎么关联多个文件变化证据——而 Journey 语义上就是**一个任务在一个仓库里的一次执行**。多仓库是 R6-5+ 的独立议题。

2. **MCP 侧只接受 UUID，绝不接受路径。**
   `start_agent_journey` 增加可选 `workspace_id: uuid.optional()`（与 `work_context_id` 同位置同风格，`tool-schemas.ts:413-420`）。Service 校验三件事：
   - 该 `local_workspaces` 行**存在**；
   - `availability === 'available'`（复用 `local-workspace-service.ts:200-206`）与 `resolveRoot:153-157`；
   - **不接受任何路径参数**——`WorkspaceFileService.resolveInside:242-268` 的绝对路径拒绝逻辑是唯一入口，MCP 层无从绕过。

3. **Desktop 侧提供绑定/解绑**（B），语义对齐 `setBinding:170-177`，用于给「未带参数创建的 Journey」事后补绑。

4. **未绑定 = 不采集，但不报错。** Journey 照常记录，证据小节显示「未关联工作区」。这保证 R6-4.1/4.2 的既有 MCP 客户端零改动。

5. **外键**：`agent_journeys.workspace_id → local_workspaces.id ON DELETE SET NULL`
   —— 与 `work_context_id` **完全一致**（设计文档 `AGENT_JOURNEY_R6_DESIGN.md` §13：Workspace 是「项目容器」，Journey 是「个人历史资产」，删容器不销毁记忆）。

6. **Workspace 删除后的历史保存**：`SET NULL` 后，已有快照因 `journey_id` CASCADE 不受影响；`workspace_id` 置 null 的快照行在 UI 显示「原工作区已删除」，证据内容（相对路径 + diff）仍可读。

### 5.3 与 MCP Client 的关系 **[设计确定]**

**不建立 `mcp_clients → workspace` 的静态绑定。** 理由：`ToolExecutionContext`（`contracts/mcp.ts:59-74`）只有 `clientId`，把它扩成含 workspace 会波及整个执行链与幂等语义；而绑定是**任务级**的（同一 client 可在不同仓库做不同任务），落在 Journey 上比落在 client 上更准确。**不把 Workspace 文件访问能力暴露给所有 MCP 客户端。**

---

## 6. Execution 级 Snapshot 时机

### 6.1 为什么必须是 Execution 级

只有 Journey 级 Start/End，无法把文件变化归到具体节点——用户点开「#4 执行」时看不到这一步改了什么。每个 Execution 需要**一对窗口边界**。本项目采用方案 A，不捕获 Agent 每条 Shell / 文件 API 调用，因此所有证据必须明确标注为「**该 Execution 时间窗口内观察到的工作区变化**」。

### 6.2 五个触发点

| # | 时机 | 挂载点 | `snapshot_type` |
|---|---|---|---|
| T1 | Journey↔Workspace 绑定 | `setBinding` 之后 / `workspace_id` 写入之后 | `baseline`（`execution_event_id = null`） |
| T2 | Execution **首次进入 `running`** | `updateEventStatus` 成功写入之后（`:643` emit 之前） | `execution_start` |
| T3 | Execution **离开 `running`** → `completed/failed/skipped/cancelled` | 同上 | `execution_end` |
| T4 | Journey `completed` | `appendEvent` 事务**提交后**（`:600` 之前） | `journey_final` |
| T5 | Journey `cancelled` / `failed` | `updateJourneyStatus` 事务**提交后**（`:706` 之前） | `journey_final` |

### 6.3 逐项分析（规格 §3 要求的九个问题）

**① 是否适合在 `AgentJourneyService` 状态转换中触发？**
**触发**适合（状态转换是唯一收敛点，见 §3.3），**采集不适合**——`git` 子进程是慢 IO，绝不能放进 `:679-704` 的事务里。正确形态：

```ts
// updateEventStatus 尾部，CAS 已提交
const updated = updateEventStatusRow(...)          // 已落库
if (shouldCapture) void this.evidence.captureAfter(...)  // fire-and-forget
this.events.emit('agentJourneys')                  // 立即通知，不等采集
```

**② 是否需要独立 `WorkspaceEvidenceService`？**
**需要。** 与 `AgentJourneyService` 职责完全不同（git 子进程、文件 IO、脱敏、配额、失败降级），且 `AgentJourneyService` 已 1100+ 行。建议 `src/main/application/agent-journey/workspace-evidence-service.ts`，构造 `(db, events, workspaces: LocalWorkspaceService)`——**复用同一个 `events` 实例**（`src/main/index.ts:243`），否则 Renderer 只收到一半 `app:changed`（同 `:255-256` 的既有注释）。

**③ 是否需要 `ApplicationEvents`？**
**复用现有 `'agentJourneys'` domain，不新增。** 证据计数显示在 Journey 详情里，而详情已经在 `'agentJourneys'` 上重取（`RecordsPage.tsx:226`、`CanvasPage.tsx:370`）。新增 domain 要同时改 `application-events.ts:8-16` 与 `contracts/index.ts:127-139`，并有测试 `tests/unit/ipc-journey-contracts.test.ts:3` 强制两处一致——收益为零。

**④ 快照失败不阻塞普通 Journey**
三层：
1. 采集在**事务提交后** fire-and-forget（`void … .catch(…)`，沿用全仓 `.catch(() => undefined)` 惯例）；
2. 失败**写一行 `capture_status='failed'` + `error_code`**，绝不回滚状态；
3. `ApplicationEvents.emit` 本身已 `try/catch` 吞掉监听器异常（`application-events.ts:30-32`）。

**⑤ 重复状态更新不产生重复快照**
- 状态机本身挡住：`running→running` 不在 `EXECUTION_TRANSITIONS`（`:194-201`）→ 写入前就拒绝；
- 数据库兜底：**`UNIQUE(journey_id, execution_event_id, snapshot_type)` 部分唯一索引** + `INSERT OR IGNORE`；MCP 重放走 `mcp_idempotency`（同 key 同 digest 直接返回，不再进 Service）。

**⑥ 状态更新成功但快照失败**
**状态是真相。** 快照行标 `failed`，UI 在该 Execution 显示「工作区快照采集失败（`<error_code>`）」并列为观察限制。**绝不**因快照失败回滚状态——那会让 Agent 的执行记录取决于一次 `git status` 是否成功。

**⑦ 用户暂停后恢复**
`running → paused`（`JOURNEY_TRANSITIONS:211`）**不关闭**执行窗口：暂停是用户级中断，恢复后同一 Execution 继续，否则窗口被切碎。恢复 `paused → running` 也不重复采 `execution_start`（已有则跳过，靠唯一索引）。

> ⚠️ **必须补的钩子**：`updateJourneyStatus` 取消时在**事务内**把未收尾执行批量改成 `cancelled`（`:681-692`，直接调 `updateEventStatusRow`，**绕过 `updateEventStatus`**）。因此 T3 不能只挂在 `updateEventStatus` 上——还必须在 `:706` 之后扫一遍「仍开着的执行窗口」补采 `execution_end`，否则**被取消的 Journey 永远没有结束快照**。

**⑧ 同一 Journey 的多个 Execution**
每对窗口以 `execution_event_id` 为键，互不干扰；同一 Journey 可有多对 `execution_start/end`，按 `captured_at` 排序后与 `sequence` 对齐展示。

**⑨ 多个 Journey 绑同一 Workspace**
- **允许**——采集是只读的，天然安全。
- **基线比较必须串行**：Main 是单进程，用 per-workspace 采集队列（`Map<workspaceId, Promise>` 链）排队，避免两次 `git status` 交错把半个状态读成基线。
- **v1 不跨 Journey 共享基线**：每个 Journey 持有自己的 baseline 快照。代价是同一窗口可能存两份 manifest（很小，只有 hash 清单），收益是归属关系简单、删一个 Journey 不影响另一个的证据完整性。
- **窗口重叠时的诚实标注**：两个 Journey 窗口重叠且都观察到同一文件净变化 → 两侧都只能标 `attribution_confidence='window_net_change'`，UI 各自按自己的观察窗口表述，**不互相抢归属**。
- **Workspace 中途被删**：`workspace_id SET NULL`，后续采集在 `resolveRoot` 失败 → 写 `capture_status` 失败行并停止，**不阻塞 Journey**；已有历史证据完整保留（§5.2 第 6 条）。

---

## 7. Git 快照数据模型

### 7.1 主表 `journey_workspace_snapshots`（拟，Migration 17）**[设计确定]**

```sql
CREATE TABLE journey_workspace_snapshots (
  id                    TEXT PRIMARY KEY NOT NULL,
  journey_id            TEXT NOT NULL REFERENCES agent_journeys(id) ON DELETE CASCADE,
  -- 删 Workspace 不销毁观察历史：与 work_context_id 同一语义（SET NULL）
  workspace_id          TEXT REFERENCES local_workspaces(id) ON DELETE SET NULL,
  -- baseline / journey_final 时为 NULL
  execution_event_id    TEXT REFERENCES agent_journey_events(id) ON DELETE SET NULL,
  snapshot_type         TEXT NOT NULL,   -- baseline | execution_start | execution_end | journey_final
  capture_status        TEXT NOT NULL,   -- ok | failed | not_a_repository | unsupported
  error_code            TEXT,
  captured_at           INTEGER NOT NULL,

  -- 仓库身份：**不存绝对路径**
  repository_identity   TEXT NOT NULL,        -- sha256(realpath) 前 32 位
  repository_root_identifier TEXT NOT NULL,   -- 目录 basename + 短哈希，可读但不泄露家目录

  -- Git 状态（可能为 NULL：空仓库 / 非 git）
  branch                TEXT,
  head_sha              TEXT,
  tree_sha              TEXT,
  index_state_hash      TEXT,   -- index 状态哈希（git write-tree 不可用时退化为 status 摘要哈希）
  worktree_state_hash   TEXT,   -- 未提交改动的 manifest 哈希（窗口比较基准）

  -- 仓库形态
  is_git                INTEGER NOT NULL DEFAULT 0,
  is_worktree           INTEGER NOT NULL DEFAULT 0,  -- .git/worktrees/<name>
  is_submodule          INTEGER NOT NULL DEFAULT 0,  -- .git 是文件，内容 gitdir: …/modules/x
  has_unborn_head       INTEGER NOT NULL DEFAULT 0,  -- 空仓库无 HEAD

  -- 规模统计（status 计数，不存文件名）
  tracked_count, staged_count, unstaged_count, untracked_count, ignored_count INTEGER,
  changed_files_count   INTEGER NOT NULL DEFAULT 0,  -- 相对基线的净变化文件数
  insertions            INTEGER NOT NULL DEFAULT 0,
  deletions             INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX uq_journey_ws_snapshot
  ON journey_workspace_snapshots (journey_id, execution_event_id, snapshot_type);
-- ↑ 部分唯一索引：execution_event_id 为 NULL 的行（baseline / journey_final）
--   由 (journey_id, snapshot_type) 约束
CREATE INDEX idx_journey_ws_snap_journey ON journey_workspace_snapshots (journey_id, captured_at);
```

### 7.2 文件明细表 `journey_snapshot_files`（同一 Migration）

```sql
CREATE TABLE journey_snapshot_files (
  id              TEXT PRIMARY KEY NOT NULL,
  snapshot_id     TEXT NOT NULL REFERENCES journey_workspace_snapshots(id) ON DELETE CASCADE,
  repo_relative_path TEXT NOT NULL,       -- POSIX 相对路径（复用 relativePathSchema 语义）
  change_kind     TEXT NOT NULL,          -- added|modified|deleted|renamed|type_changed|untracked|staged|conflicted|binary
  status_origin   TEXT NOT NULL,          -- worktree | index（分列）
  content_hash_before TEXT,               -- 基线 blob hash；NULL = 基线不存在
  content_hash_after  TEXT,
  pre_existing_dirty  INTEGER NOT NULL DEFAULT 0,  -- 基线时已脏
  head_moved         INTEGER NOT NULL DEFAULT 0,   -- 窗口内 HEAD 变化
  rename_from_path   TEXT,                        -- renamed 时的旧路径
  insertions        INTEGER NOT NULL DEFAULT 0,
  deletions         INTEGER NOT NULL DEFAULT 0,
  line_ranges       TEXT,                        -- JSON: [{start,end}] 上限 N 段
  artifact_ref      TEXT,                        -- diff 内联内容 / 截断标记（§9）
  attribution       TEXT NOT NULL,               -- reported_and_observed | observed_only | reported_only
  attribution_confidence TEXT NOT NULL           -- confirmed | window_net_change | unconfirmed
);
CREATE UNIQUE INDEX uq_jw_snapshot_file ON journey_snapshot_files (snapshot_id, repo_relative_path);
```

### 7.3 规格 §5.1 字段逐项映射

| 要求字段 | 实现 | 取法 |
|---|---|---|
| `workspace_id` | ✓ | `SET NULL`，历史保留 |
| `journey_id` | ✓ | CASCADE |
| `execution_event_id` | ✓ | 可空（baseline / journey_final） |
| `snapshot_id` / `snapshot_type` / `captured_at` / `capture_status` | ✓ | |
| `repository_identity` | ✓ | `sha256(realpath).slice(0,32)` —— **不存绝对路径** |
| `repository_root_identifier` | ✓ | `basename(realpath)` + 短哈希 |
| `branch` | ✓ | `git symbolic-ref --short HEAD`（detached 时 NULL） |
| `head_sha` | ✓ | `git rev-parse HEAD` |
| `tree_sha` | ✓ | `git rev-parse HEAD^{tree}` |
| `index_state_hash` | ✓ | index 状态哈希；空仓库时全 NULL + `has_unborn_head=1` |

### 7.4 场景逐项分析

| 场景 | 处理 |
|---|---|
| **tracked files** | `git ls-files -s` → blob sha 清单（窗口比较基准） |
| **staged** | `git diff --cached --name-status` → `status_origin='index'` |
| **unstaged** | `git diff --name-status` → `status_origin='worktree'` |
| **untracked** | `git ls-files --others --exclude-standard` → `change_kind='untracked'`，内容 hash 现算 |
| **ignored** | 只计数（`ignored_count`），**不入明细**——`.gitignore` 是用户意图，不该被当成「未报告的变化」（D11） |
| **Git Worktree** | `git rev-parse --git-dir` 以 `.git/worktrees/` 结尾 → `is_worktree=1`。**不与普通工作区等同**：worktree 的 `HEAD` 独立、`index` 独立，基线必须按 worktree 各自采 |
| **submodule** | `.git` 是**文件**（非目录）且内容 `gitdir: …/modules/<name>` → `is_submodule=1`；子模块内改动记为父仓库的一个 `modified` 路径，**不下钻子模块内部**（v1 边界） |
| **非 Git 目录** | `is_git=0`、`capture_status='not_a_repository'`，快照行仍写入（保留「当时没有 git」这一事实），明细为空，UI 显示限制 |

---

## 8. Dirty file 归因与并发限制

**不能只比两次 `git status`** —— `status` 只给路径与状态码，不给内容，无法区分「改了又改回」与「净变化」。

### 8.1 双端采集 + 三层比较

```
基线快照 (T1)                      结束快照 (T3/T4)
├─ HEAD / tree sha                 ├─ HEAD / tree sha        → head_moved
├─ index 状态哈希                   ├─ index 状态哈希          → staged 变化
├─ worktree 状态哈希                ├─ worktree 状态哈希
└─ 每文件 blob sha 清单              └─ 每文件 blob sha 清单
        └────────────── 对比 ──────────────┘
```

**Index 与 Worktree 必须分列**（`status_origin`）：同一文件可能 staged 与 unstaged 同时变化——`git status --porcelain=v2` 的 `1 <XY> ...` 中 XY 两字符分别对应 index/worktree，分别记两行或记一个复合状态。

### 8.2 规格 §5.2 九种情形

| 情形 | 判定方式 |
|---|---|
| 任务前已改（基线脏） | 基线快照已含该文件的 dirty 状态 → 明细标 `pre_existing_dirty=1`，**不计入本执行净变化** |
| 期间改原有脏文件 | 基线 blob hash ≠ 结束 blob hash → 净变化，`pre_existing_dirty=1` 同时成立 |
| 新增 | 基线不在 `ls-files` → 结束在 / `--others` 命中 → `added` / `untracked` |
| 删除 | 基线在 → 结束不在 → `deleted` |
| 重命名 | `git status` 的 `R` + `rename_from_path`；两侧 hash 相同则内容未变 |
| staged + unstaged 同时变 | XY 两字符分别记录（`status_origin` 分列），hash 取 worktree 侧为准、index 侧单列 |
| 改后恢复 | 两侧 blob hash **相同** → 净变化为 0；Agent 自述仍保留 → 归入 `reported_only`（成因之一） |
| HEAD 期间变化 | `head_sha`/`tree_sha` 不同 → `head_moved=1`，净变化仍计算但归因降级为 `window_net_change` |
| 用户/其他 Agent 并发修改 | **无法区分**（方案 A 不 Hook 进程）→ `attribution_confidence='unconfirmed'` + UI 说明 |

### 8.3 归因状态（规格 §6 三类）+ 置信度

| `attribution` | 含义 | UI 主文案（zh） |
|---|---|---|
| `reported_and_observed` | Agent 报了该文件，且窗口内观察到净变化 | **已报告并观察到** |
| `observed_only` | 系统观察到变化，Agent 未在 `details.changes` 中报告 | **仅系统观察到** |
| `reported_only` | Agent 报了，窗口内**未**观察到净变化 | **仅 Agent 报告，未观察到净变化** |

`attribution_confidence` 三值：`confirmed` / `window_net_change` / `unconfirmed`。UI 必须把 confidence 与 attribution **同时**展示——只显示三分类会误导。

**绝不把第三类标成「虚假」**，代码层可验证的三种真实成因：

1. **改了又还原**——两侧 blob hash 相同 → 净变化为 0，但 Agent 的过程描述依然真实；
2. **窗口不完整**——基线失败（`capture_status='failed'`）或结束快照缺失 → `unconfirmed`；
3. **HEAD 在窗口内变化**（他人 commit / rebase）→ `head_moved=1`，tree 对比仍给出净变化，但无法归因到单次执行 → `window_net_change`。

### 8.4 四个必须区分的概念（规格 §5.2「明确区分」）

| 概念 | 数据来源 | 落点 |
|---|---|---|
| 文件在时间窗口内发生了净变化 | Workspace Observed（manifest 对比） | `content_hash_before ≠ content_hash_after` |
| Agent 自述修改了某文件 | Agent Reported（`details.changes[]`） | `EventDetailSections` 既有渲染 |
| 文件变化与 Agent 自述匹配 | 两者 join | `attribution='reported_and_observed'` |
| 无法确认具体修改者 | 方案 A 的固有边界 | `attribution_confidence` + UI 限制说明 |

### 8.5 并发限制（必须写进设计的现实边界）

| 并发情形 | 能否区分 | 处理 |
|---|---|---|
| 用户在窗口内手动改同一文件 | ❌ | `unconfirmed`；UI：「窗口内工作区出现非本次执行报告的变化」 |
| 另一 Agent 并发改同一文件 | ❌ | 同上。**不做进程级归属**（方案 A 不 Hook Agent 进程） |
| 窗口内 HEAD 被推进 | 部分 | `head_moved=1` + `window_net_change` |
| 两个 Journey 同时采同一 Workspace | 采集本身安全（只读） | **per-workspace 串行队列**，避免两次 `git status` 交错 |
| 快照期间工作区正被写入 | ❌ | 无法原子读；接受为 `window_net_change`，不重试到「干净」为止 |

**承诺边界（原样出现在 UI 与文档）**：本方案证明的是「**两个观察时间点之间工作区出现了净变化**」，**不证明该变化由某一个 Agent 造成**。

---

## 9. Diff Artifact 存储方案

### 9.1 核心问题：仅存 Hash 够不够？

**不够。** Hash（blob sha）只能证明「内容变过」，**无法反推变化内容**。任务结束后源工作区会继续演进（`git checkout`、`commit`、`rm`），**依赖「用户当前文件内容」恢复旧 Diff 不可复现**。

### 9.2 三方案对比

| | **A. 存基线文件副本** | **B. 采集时生成 Unified Diff** | **C. 只存路径+Hash+统计，点开时动态读** |
|---|---|---|---|
| 历史可复现 | ✅ 可 | ✅ **可**（内容已固化） | ❌ **不可**（工作区已变） |
| 存储成本 | 高（被改文件的**全量**副本，最坏复制半个仓库） | **低**（只存增量，通常 < 基线 5%） | 极低 |
| 隐私风险 | **最高**（长期持有源码副本，含未改部分上下文） | 中（只持有**实际变化的行**） | 最低 |
| 需要基线内容 | 是（必须在窗口开始时留住） | **仅采集瞬间**（内存/临时） | 否 |
| 二进制/大文件 | 存了也展示不了 | 可只存统计 + `binary` 标记 | 可 |
| 与 Journey 删除的清理 | 要删一堆文件（**当前无按实体删文件机制**，G6） | **随行级联删除** | 无 |
| 数据目录迁移 | ❌ 要改 `data-location.ts:191-213` 复制清单 | **若入 SQLite 则免改** | 免改 |

### 9.3 推荐：**B + 采集瞬间暂存基线（不落盘），产物入 SQLite** **[设计确定]**

```
窗口开始 ──► 采集基线：git ls-files → blob sha 清单 + 被改文件的旧内容
            （旧内容仅在内存 / 系统临时目录，用完即删）
窗口结束 ──► 采集终点 → 对比清单 → 对每个净变化路径生成 unified diff
            （git 能提供的走 git diff；基线脏的用暂存的旧内容）
            ──► redactSecrets() → 长度裁剪 → 写入 journey_snapshot_files.artifact_ref
```

**为什么产物入 SQLite 而不是文件目录：**

1. **`data-location.ts` 只搬 `brewphase.db` 与 `media/`**（`:191-200`、`:206-213`）。新建 `evidence/` 目录**必须同时改这份清单**，否则用户一改数据位置，证据就地孤儿——而 `data-location.ts` 不属于 Journey 范围，改它是范围外扩散。
2. **仓库没有「按实体删本地文件」的机制**（G6）。放文件里就等于**永久泄漏**，直到用户手动 wipe。SQLite 行随 `journey_id` CASCADE，R6-5 实现 Journey 删除时**一条 DELETE 全清**。
3. Diff 是文本且有界，不是大二进制。

**配额（硬边界，超限截断而非拒绝）：**

| 层 | 上限 | 超限行为 |
|---|---|---|
| 单文件 artifact | **64 KB** | 截断 + `…[truncated]`（复用 `TRUNCATION_MARKER`，`sanitize.ts:41`） |
| 单快照 artifact 总量 | **512 KB** | 后续文件只存统计与 `artifact_ref='omitted:over_budget'` |
| 单 Journey artifact 总量 | **2 MB** | 超出后新的快照只存统计 |
| 单文件行数 | **2 000 行 / 800 个 hunk** | 截断 |
| 二进制 | 不存内容 | `change_kind` 标 `binary`，只存统计 |
| 敏感文件 | **不存内容** | 复用 `SENSITIVE_FILE_PATTERNS`（`workspace-file-service.ts:44-52`）+ `isSensitiveName:296` → `artifact_ref='omitted:sensitive'` |

---

## 10. Agent Reported 与 Workspace Observed 对照方案

### 10.1 数据流

```
Agent Reported                          Workspace Observed
metadata.journey_detail_v1.changes[]    journey_snapshot_files
  file_path / change_type / symbols       repo_relative_path / change_kind
  before_behavior / after_behavior        content_hash_before/after
  why_this_location                       insertions/deletions/line_ranges
        └────────── 按 repo_relative_path 规范化后 join ──────────┘
                          ↓
              每个 Execution 生成对照表
```

**规范化规则**：两侧都强制 POSIX 相对路径（Agent 侧由 `repoRelativePathError`，`src/shared/contracts/entities/agent-journey.ts:74`；观察侧由 `relativePathSchema`，`local-workspace.ts:34-37`）→ 直接字符串相等即可 join。**不做模糊匹配**（大小写/`./` 前缀在两侧都已被拒）。

### 10.2 三类结果 + 中文文案（规格 §6）

| 类别 | zh UI 主文案 | zh UI 副文案（必须出现） |
|---|---|---|
| `reported_and_observed` | **已报告并观察到** | 「该文件在本执行的观察窗口内出现了净变化」 |
| `observed_only` | **仅系统观察到** | 「工作区有变化，但本次执行的结构化详情未报告该文件」 |
| `reported_only` | **仅 Agent 报告，未观察到净变化** | 「可能是改后还原、观察时间不完整，或变化发生在窗口之外——**不代表报告不真实**」 |

**置信度单独一行**（不与类别合并）：

| `attribution_confidence` | zh 文案 |
|---|---|
| `confirmed` | 观察窗口完整，结论可靠 |
| `window_net_change` | 窗口内 HEAD 有变动，只能确认净变化 |
| `unconfirmed` | 基线或结束快照缺失，**无法确认** |

**禁止的表达**（写进 i18n 注释与验收）：「虚假」「伪造」「Agent 说谎」「未执行」——`reported_only` **永远不能**等价于「没做」。

### 10.3 对照数据的产生位置

在 **Renderer 读取时计算**，不落库：

- `agent-journeys:get` 已返回 `events[].metadata`（R6-4.2）与（拟新增）`snapshots[]`
- 对照是纯函数：`buildEvidenceComparison(detail, snapshots) → per-event report`
- 放在 `shared/` 纯函数 → 可单测、Records 与 Canvas 共用、不产生第二份真相

---

## 11. Records 时间线和 Diff Viewer UI 设计

**不新建一级导航、不新建 Journey 页面** —— 全部在既有 `JourneyDetailView`（`RecordsPage` 的 `.float-panel` 内，`JourneyDetail.tsx` 482 行）。

### 11.1 时间线节点扩展（规格 §7 字段）

现有节点头（`JourneyDetail.tsx:241-252`）已有：序号 · 类型字形 · 类型名 · 状态 · 时间。**新增一行证据条**（仅 execution 类且有快照时）：

```
┌──────────────────────────────────────────────────────────┐
│ #4  ▷ 执行  已完成                          2026-11-24   │  ← 既有 head
│ 改 handlers.ts 的 edges 映射                              │  ← 既有 title
│ 第一次只改了断言没改字段名…                                │  ← 既有 summary
├──────────────────────────────────────────────────────────┤
│ 📂 观察窗口 14:02 → 14:19   3 个文件  +86 −21            │  ← 新增 evidence bar
│    已报告并观察到 2 · 仅系统观察到 1                       │  ← 新增对照计数
└──────────────────────────────────────────────────────────┘
```

- 类名：`.journey-event__evidence`（沿用 `journey-event__detailbar` 的 flex 模式）
- 点击 → 展开「证据面板」（复用既有 `expanded` 状态与 `toggleExpanded`，`JourneyDetail.tsx:99`）
- **没有快照** → 沿用现有 `.journey-event__nodetail` 文案风格：「本执行未关联工作区，无观察证据」

### 11.2 证据面板结构（点击后，7 项对应规格 §7 点击后 1-7）

```jsx
<section className="journey-detail__section">     ← 复用既有 section 样式
  <h4>工作区观察</h4>
  <EvidenceMeta />         // 1 窗口时间、仓库标识、分支、HEAD、形态（worktree/submodule）
  <EvidenceComparison />   // 2/3 三类对照 + 置信度（§10.2 文案）
  <EvidenceFileGroups />   // 4 文件变化分组：已报告并观察到 / 仅系统观察到 / 仅 Agent 报告
    └ <EvidenceFileRow />  // 路径 + change_kind Chip + ±行数 + 「查看 Diff」
        └ <DiffViewer />   // 5 点击某文件后查看具体 Diff
  <EvidenceLimits />       // 6 观察证据限制（未关联 / 基线失败 / 敏感被排除 / 超预算截断）
  <ExecutionNav />         // 7 继续点击下一 Execution 沿任务向后浏览（既有上下事件导航）
</section>
```

### 11.3 Diff Viewer

**新组件 `DiffViewer`（新文件，不塞进 `EventDetailSections`）**——规格 §7 明确「`EventDetailSections` 应先研究是否可以复用，但**不要提前重构**」。

复用与新增的边界：

| 复用（不改） | 新增 |
|---|---|
| `EventDetailSections.tsx`（231 行 / 6 分区）——渲染 **Agent Reported** 部分 | `EvidenceSections.tsx` ——渲染 **Workspace Observed** 部分 |
| `.journey-detail__section` / `__section-title` / `__label` | `.journey-evidence-*` 系列 |
| `.journey-file-card` / `journey-chip--change` | `.journey-diff-viewer` / `.diff-line--add` / `--del` / `--ctx` |
| `journey.changesCount` / `verifyCount` i18n | 新增 `journey.evidence.*` i18n（zh + en 双份） |

**渲染规格：**

| 项 | 决定 |
|---|---|
| 默认视图 | **Unified Diff**（窄屏/长 hunk 更省空间，复制即用） |
| Side-by-side | 可选切换，仅 ≥960px 容器宽度时显示（`@media` 控制），避免窄面板折行 |
| 文件分组 | 按 `change_kind` 分组（新增 / 修改 / 删除 / 重命名），组头显示计数与 ±行数 |
| Hunk 折叠 | 默认只展开 ±3 行上下文，中间折叠为「展开 N 行」按钮 |
| 行号 | `old → new` 双列，`font-variant-numeric: tabular-nums` |
| 大文件 | 超 2 000 行 → 只显示前 100 行 + 「已截断」提示 + 完整统计 |
| 二进制 | 不渲染内容，显示「二进制文件（N bytes）」+ 变化类型 |
| 敏感/超预算 | `artifact_ref='omitted:sensitive' / 'omitted:over_budget'` → 明确说明**为何没有内容**，不显示空框 |
| 不可读 | `artifact_ref=null` + `capture_status!='ok'` → 「快照采集失败」+ error_code |

**性能**：Diff 只在点击时取（`agent-journey:evidence:artifact` 按需 IPC），不随 `get_agent_journey` 全量返回——避免把 2 MB 塞进一次详情请求。

### 11.4 「不把所有代码塞进一张超长卡片」的落实

- 时间线默认只显示 **evidence bar 一行**（11.1）；
- 证据面板**按需展开**（复用 `expanded` Set，`JourneyDetail.tsx:34`）；
- 文件列表**默认折叠**，点文件才取 Diff；
- Diff **点开才渲染**。

### 11.5 视觉目标对照（规格 §7）

| 目标 | 落点 |
|---|---|
| 安静、清晰、层次明确 | 复用既有 `.journey-detail__section` 层级，不引入新配色体系 |
| 自述与观察有来源区分 | 证据条/面板独立成块 + 「已报告 / 系统观察」字样 + 与 `EventDetailSections` 分区并列 |
| 文件列表易扫描 | 按 change_kind 分组、路径 `code` 字体、Chip 与既有 `journey-chip--change` 一致 |
| Diff 可读性优先 | 等宽字体、行号双列、±行数着色、hunk 折叠 |
| 不做炫目大屏 | 无动画、无流水线可视化，仅状态文本与计数 |

---

## 12. Canvas Inspector 设计

**保持简洁：节点内不放任何完整 Diff。**

### 12.1 节点（`JourneyGroupShape.tsx`，1251 行）

已有 `countsText`（`parseJourneyDetail` → 文件数 + 验证数，`:763-768`）。**追加观察计数**，不改结构：

```
#4 ▷ 执行                              2 个文件 · 3 项验证
改 handlers.ts 的 edges 映射
已观察 3 文件 +86 −21          ← 新增（仅当有快照）
```

- 节点只显示：**执行步骤名称、事件状态、变化文件数量、简短变化统计**（规格 §7 四项）
- 来源：`journey_snapshot_files` 聚合（`changed_files_count` / `insertions` / `deletions`），随 canvas Journey schema 返回（`src/shared/contracts/entities/agent-journey.ts:132`）
- **节点高度 160 不变**（`JOURNEY_NODE_SIZE`，`journey-layout.ts:37`）——加一行不加尺寸，避免布局重算与既有摆位失配
- 无快照 → 不显示该行（不占位、不空框）

### 12.2 Inspector（`JourneyInspectorBody.tsx`，502 行）

在既有 5 个 `.journey-inspector__section`（`:233 / :297 / :320 / :405 / :468`）之后、危险操作区（`:189` `confirmAction`）之前，**插入第 6 节「工作区观察」**：

```jsx
<section className="journey-inspector__section">
  <h3 className="journey-inspector__title">工作区观察</h3>
  {!snapshot ? (
    <p className="journey-inspector__empty">本执行未关联工作区，或快照尚未采集。</p>
  ) : (
    <>
      <EvidenceMeta />        {/* 窗口、仓库、分支、HEAD、形态 */}
      <EvidenceSummary />     {/* 3 文件 +86 −21 · 已报告并观察到 2 · 仅系统观察到 1 */}
      <EvidenceComparison />  {/* 三类计数 + 置信度一行 */}
      {/* 文件级 Diff 在 Canvas 里只给入口，不内联渲染 */}
      <button>在记录中查看完整 Diff</button>   ← 跳转 Records Journey 详情
    </>
  )}
</section>
```

**为什么 Canvas 不内联 Diff**：

1. Inspector 宽度有限，Diff 需要等宽多列，塞进去必然横向滚动；
2. `JourneyGroupShape` 是 Konva 画布，Inspector 是 DOM——两套渲染，Diff 只该有**一份**实现（在 DOM 侧）；
3. 规格 §7 明确「不在 Canvas 节点内放完整 Diff」。

**图例**：扩展现有 `.journey-legend` 时**不加第四行**——观察证据不是「线」，它属于 Inspector 的独立小节，混进连线图例反而混淆。

### 12.3 组件复用结论

| 组件 | 复用方式 |
|---|---|
| `EventDetailSections.tsx` | **原样复用**（渲染 Agent Reported），不改一行 |
| `EvidenceSections.tsx`（新） | 渲染 Workspace Observed，**独立文件** |
| `JourneyInspectorBody.tsx` | 插入一个 section，其余 5 节不动 |
| `JourneyGroupShape.tsx` | 只加一行计数文本，几何与交互不动 |
| `buildEvidenceComparison()`（新，`shared/`） | Records 与 Canvas 共用的纯函数对照 |

---

## 13. 隐私、安全及数据生命周期

### 13.1 数据边界（全部 local-first）

| 边界 | 结论 | 依据 |
|---|---|---|
| iCloud / Cloud | **不上传** | Journey 全链无网络调用；证据仅本地 SQLite |
| iOS 同步 / `change_log` | **不进** | `recordChange` 调用方只有 `records/coffee/canvas`（`sync-log.ts:9`）；`wipe.ts:29-43` `SYNC_ENTITY_TYPES` 不含 workspace |
| MCP 可读性 | **不可读** | 33 个 MCP 工具无文件/证据读取通道；`ToolExecutionContext` 只有 `clientId`（`contracts/mcp.ts:59-74`） |
| Remote | **不可达** | Remote 工具全只读且无 Journey；Cloud 侧 schema 门禁测试 |

### 13.2 采集阶段的隐私规则

**先排除、后脱敏（顺序不可倒）：**

1. **硬排除（生成前就跳过，不进入任何表）**
   - 复用 `SENSITIVE_FILE_PATTERNS`（`workspace-file-service.ts:44-52`）与 `isSensitiveName:296-298`：`.env*`、`.pem`、`.key`、`id_rsa*`、`id_ed25519*`、`credentials*`、`secrets?*`
   - 新增（证据特有）：`.git/config`、`.git/logs/**`、`.git/hooks/**`（可能含 remote URL 内嵌 token）、`*.p12`、`*.pfx`、`*.keystore`
   - 排除项记 `artifact_ref='omitted:sensitive'`，**UI 明确写「已按敏感文件规则排除」**——用户知道少了什么
2. **内容脱敏**：`redactSecrets()`（`sanitize.ts:114-128`）
3. **路径脱敏**：只存 `repo_relative_path`（`relativePathSchema`）；`repository_root_identifier` 用 basename+hash，**绝不存家目录**
4. **不存完整源码**：只存 unified diff 的变化行，配额见 §9.3

> **诚实声明（必须写进 UI 与文档）**：正则脱敏是**尽力而为，不能保证零泄漏**。因此敏感判定必须是**硬排除**，正则只是第二道防线。

### 13.3 数据生命周期与清理

**现状（已验证）**：无 Journey 删除（G5）、无按实体删本地文件机制（G6）、数据目录迁移只搬两样（G7）。

**三条硬约束：**

1. **证据产物必须入 SQLite，不建文件目录** —— 否则要改 `data-location.ts:191-213` 的复制清单（范围外文件），且切数据位置后证据就地孤儿。
2. **证据删除必须随 R6-5 的 Journey 删除一起实现** —— 一条 `DELETE FROM agent_journeys` 靠 CASCADE 清掉 `journey_workspace_snapshots` → `journey_snapshot_files`。**当前无挂载点**，必须在 R6-5 显式做（否则证据永久残留）。
3. **Workspace 删除 ≠ 证据删除** —— `workspace_id ON DELETE SET NULL`，历史观察保留，UI 显示「原工作区已删除」。

### 13.4 用户可见性（「用户明确知道保存了什么」）

挂在既有 **Settings → 本地数据** 小节（`src/renderer/src/features/settings/SettingsPage.tsx:309-352`，`t.settings.general.localData`），不新建导航：

```
本地数据
  数据目录  <path>
  Journey 证据    3 个 Journey · 12 份快照 · 1.4 MB
  [清理全部证据]           ← 新增按钮（走 confirmAction，与 removeJourneyFromCanvas 同模式）
  证据只保存在本机 SQLite，不上传、不进入 iOS 同步。保存的是文件差异摘要，
  不是完整源码；敏感文件在采集时即被排除。
```

i18n 新增 `settings.general.journeyEvidence*`（zh + en 双份），与既有 `localDataNote` 并列。

### 13.5 安全审计要点

- `git` 子进程调用必须走 `execFile`（**参数数组，禁 shell 拼接**），参照唯一先例 `chrome-host-installer.ts:14,273,288` 的 `promisify(execFile)`
- 工作区路径来自 `resolveRoot()`（`local-workspace-service.ts:153-157`），**不接受任何来自 MCP 的路径**
- `cwd` 参数传 realpath，`git` 命令全部加 `--no-pager`，超时（建议 5s）+ 输出上限
- **绝不执行** `git checkout/reset/clean/stash` 等写命令——只读命令白名单：`rev-parse`、`symbolic-ref`、`status`、`diff`、`ls-files`、`hash-object`、`log -1`、`rev-list`

---

## 14. Migration 和 IPC 影响

### 14.1 Migration

**新增 2 个版本（只追加，规则见 `migrations.ts:10`）：**

| 版本 | 名称 | 内容 |
|---|---|---|
| **16** | `journey-workspace-binding` | `ALTER TABLE agent_journeys ADD COLUMN workspace_id TEXT REFERENCES local_workspaces(id) ON DELETE SET NULL` + 索引 `agent_journeys_workspace_idx` |
| **17** | `journey-workspace-evidence` | `journey_workspace_snapshots` + `journey_snapshot_files`（§7 DDL） |

**为何 `ALTER` 而不是新绑定表**：v1 一个 Journey 只绑一个 Workspace（§5.2），单列 + `SET NULL` 与既有 `work_context_id` 语义完全一致；若 §17 决策改为多 Workspace，则升级为绑定表（届时列废弃，属可逆演进）。

**SQLite `ADD COLUMN` 约束**：带 `REFERENCES` 的新增列**默认值必须为 NULL** → `workspace_id` 天然可空，无需回填。

**必须同步核对的既有不一致**：`src/shared/contracts/version.ts:8` 的 `DB_SCHEMA_VERSION = 1`，注释称「与 migrations.ts 里的迁移序号一一对应」，实际已与 15 版并存——P1 开工时先 grep 其使用点，仅当存在运行时校验才同步，否则记录该现存不一致。

**`schema` 汇总对象（`schema.ts:427-450`）不含任何 journey 表**——journey repository 走独立 `sqliteTable` 导出。新表**沿用该惯例**，不强行塞进 `schema` 对象（`Db = BetterSQLiteDatabase<typeof schema>` 类型面不受影响）。

### 14.2 IPC 影响

`handle()` 三段式：`assertTrustedSender`（`register.ts:1083-1090`）→ zod `safeParse`（`:182-184`）→ 执行；**没有 schema 就不能注册**（`:176` 类型收窄）。

**新增 4 个通道：**

| 通道 | 入参 | 用途 |
|---|---|---|
| `agent-journey:workspace:bind` | `{ journeyId: uuid, workspaceId: uuid \| null }` | Desktop 侧绑定/解绑（B 通道） |
| `agent-journey:evidence` | `{ journeyId: uuid }` | 返回该 Journey 全部快照 + 文件明细（对照用） |
| `agent-journey:evidence:artifact` | `{ snapshotId: uuid, repoRelativePath: relativePathSchema }` | **按需**取单文件 Diff（不随详情全量返回） |
| `agent-journey:evidence:clear` | `{ journeyId: uuid }` | 清理单条 Journey 的证据（配合 R6-5） |

**新增/修改的文件（共 6 处，与既有惯例逐条对应）：**

| 文件 | 改动 | 强制测试 |
|---|---|---|
| `src/shared/contracts/validation/ipc.ts` | `IPC` 常量（`:51-307`）+ `ipcRequestSchemas`（`:309+`）各加 4 条 | **`tests/unit/ipc-journey-contracts.test.ts:57-64` 强制两处键集合完全相等** |
| `src/main/ipc/register.ts` | Journey 段（`:348-429`）加 4 个 `handle(...)`；新依赖需改形参表 `:94-147` 与解构 `:148-171` | — |
| `src/preload/index.ts` | Journey 分组（`:278-287`）加 4 个 `invoke` | **`ipc-journey-contracts.test.ts:203-216` 强制 preload 出现 `IPC.<key>`** |
| `src/shared/contracts/index.ts` | `RendererApi`（`:159`）Journey 分组（`:322-335`）加类型 | — |
| `src/main/index.ts` | `registerIpc` 调用（`:634-659`）注入 `WorkspaceEvidenceService`；构造区（`:243-272`）**复用同一 `events` 实例** | `main/index.ts:255-256` 既有注释 |
| `src/shared/contracts/version.ts` | `DB_SCHEMA_VERSION` 视使用点结论同步 | — |

**`APP_DOMAINS` 不改**：证据事件复用 `'agentJourneys'`（§6.3 ③），因此 `application-events.ts:8-16` 与 `contracts/index.ts:127-139` **零改动**，`ipc-journey-contracts.test.ts:3` 的一致性断言自然通过。

**MCP 面影响**：仅 `start_agent_journey` 增加可选 `workspace_id: uuid.optional()`（`tool-schemas.ts:413-420`）。**工具数 33 不变、Scope 16 不变**、不加新工具。

### 14.3 不受影响的部分

`evidence_level = agent_reported` 规则、`JOURNEY_METADATA_MAX`、幂等语义、`mcp_idempotency` 表、`mcp_operation_log`、audit log、Cloud 全部、iOS 同步协议、`SYNC_ENTITY_TYPES`、`wipe.ts` —— **零改动**。

---

## 15. 分阶段实施路线

> 5 阶段，每阶段独立可交付、可回滚、有明确边界。**不一次性开发。**

### P1 · Workspace ↔ Journey 绑定与授权

**范围**：Migration 16（`workspace_id` 列）· `start_agent_journey` 的 `workspace_id` 参数与 Service 校验（存在 + `available`）· IPC `agent-journey:workspace:bind` · Records 侧绑定 UI · 解绑 · 未绑定降级文案。
**不做**：任何 git 采集。
**边界**：MCP 只能引用**已登记** UUID，无路径参数；未绑定不报错。

### P2 · Git Snapshot Engine（纯能力，无表）

**范围**：`WorkspaceEvidenceService` 骨架 + 只读 git 命令白名单封装（`execFile` + 超时 + 输出上限）· 仓库形态识别（普通/worktree/submodule/非 git/空仓库）· baseline manifest 生成 · 终态 manifest 对比 · unified diff 生成 · 敏感硬排除 + `redactSecrets` + 三级配额。
**不做**：不落库、不接状态机。
**边界**：全部纯函数或可注入依赖的类，**单测可覆盖**，不碰 Journey Service。

### P3 · Execution 级 Snapshot 与本地存储

**范围**：Migration 17（两表）· Repository · **5 个触发点**（§6.2 T1–T5，含 `updateJourneyStatus` 取消路径的补采钩子）· fire-and-forget 与失败降级 · 唯一索引幂等 · per-workspace 采集串行队列 · IPC `agent-journey:evidence`。
**不做**：Diff UI、归因对照。

### P4 · Diff Artifact 与归因对照

**范围**：artifact 写入 `journey_snapshot_files` + 三级配额截断 · `buildEvidenceComparison()` 纯函数（三分类 + 三置信度）· IPC `agent-journey:evidence:artifact` 按需取 · 敏感/超预算的 `artifact_ref` 语义。
**不做**：任何 Renderer 渲染。

### P5 · Records 时间线与 Diff Viewer + Canvas Inspector

**范围**：`JourneyDetail.tsx` 证据条 + 按需展开 · `EvidenceSections.tsx`（新）+ `DiffViewer.tsx`（新）· `JourneyGroupShape.tsx` 加观察计数一行 · `JourneyInspectorBody.tsx` 插入「工作区观察」小节 + 跳转入口 · i18n zh/en · `VISUAL_CHECK=1` 截图验收。
**不做**：不重构 `EventDetailSections`、不改 Konva 几何、不加一级导航。

**实施记录（R6-P5 系列）**：
- **P5.1 [已实现]**：`JourneyDetail.tsx` 证据摘要（置信度 + 五项计数 + 三类归因按需展开）· `journey-evidence-view.ts`（加载状态机 / 序号竞态守卫 / 视图纯函数）· i18n zh/en 同构。
  与本设计的偏差：`EvidenceSections.tsx` 未单开——证据区并入 `JourneyDetail.tsx`，复用 `journey-section` 层级。
- **P5.1.1 [已实现]**：无法判定观察的独立集合与独立计数 · 切换 Journey 即清详情 + 渲染层归属检查 · `head_moved` 第三种零文件空态。
- **P5.1.2 [已实现]**：新记录 `observation_status` 是文件级观察确定性权威（hash 缺失 / 正文不可用不再让引擎已确认的变化从时间线消失）。
- **P5.2 [已实现]**：`journey-artifact-view.ts`（按需读取状态机 + Artifact 呈现映射 + unified diff 行分类）· `DiffViewer.tsx`（点击「查看证据」才经 `agent-journey:evidence:artifact` 三元组读取；React 文本节点渲染，无危险 HTML）· 文件行入口（`reported_only` 与 `absent` 无入口）· E2E `journey-artifact.e2e.spec.ts`。
  类名注记：预览块用 `journey-diff-viewer`（§11.3 命名）——`journey-diff` 已被 `EventDetailSections` 的修改前后块占用，两者互不覆盖。
- **相对 §11.3 的偏差**：hunk 折叠、`old → new` 行号双列、side-by-side、按 change_kind 分组暂未做（P5.2 范围是按需读取与克制展示；视觉增强属后续打磨）。
- **[待实现]** Canvas Inspector：`JourneyGroupShape.tsx` 观察计数一行 · `JourneyInspectorBody.tsx`「工作区观察」小节与跳转入口 · `VISUAL_CHECK=1` 截图验收。

**关键顺序理由**：P2 在 P3 之前，是因为采集能力必须**先能被单测独立验证**（git 调用、形态识别、diff 生成都与 Journey 无关），再接到状态机上——否则触发点的失败无法区分是「采集 bug」还是「挂载 bug」。

---

## 16. 每阶段测试重点

### P1 — 绑定与授权

| 类别 | 重点 |
|---|---|
| 单元 | `workspace_id` 三态：不存在 → `VALIDATION_ERROR`；workspace `missing`（`local-workspace-service.ts:200-206`）→ 拒绝；合法 → 通过。**未带 `workspace_id` 的行为与基线逐字节一致**（回归） |
| 集成（真实 SQLite） | Migration 16 升级不破坏既有 Journey（对照 `tests/integration/agent-journey-persistence.test.ts` 的 `openAtVersion` 模式）；删 `local_workspaces` → `workspace_id` 置 null 且 Journey 仍在 |
| MCP 安全 | 传路径字符串 → schema 拒绝；无 `agent_journey:write` 仍被拦；`mcp_idempotency` 同 key 重放返回同结果 |
| 契约 | `ipc-journey-contracts.test.ts:57-64`、`:203-216` 新通道双向通过 |
| 规模门禁 | MCP 工具仍 **33**、Scope 仍 **16**；`evidence_level` 仍恒 `agent_reported` |
| UI | 未绑定 Journey 显示「未关联工作区」降级文案，不显示空的证据区块 |

### P2 — Git Snapshot Engine（纯能力，无表）

| 类别 | 重点 |
|---|---|
| 子进程安全 | `execFile` **参数数组**（参照 `chrome-host-installer.ts:14,273`）；超时（5s）、输出上限；**只读命令白名单**——负面测试断言引擎 API 无法发起 `checkout/reset/clean/stash` |
| 形态识别 | 真实 `git init` 造 fixture：普通仓库 / worktree / submodule / 非 git 目录 / 空仓库（unborn HEAD）。五种各一条，断言 `is_*` 标志与 `capture_status` |
| manifest 对比 | staged+unstaged 同时变（`status_origin` 分列）、rename、**改后恢复 → 净变化 0**、窗口内 HEAD 移动（`head_moved=1`） |
| diff 生成 | unified 格式合法（`@@ -a,b +c,d @@` 可解析）、hunk/行范围计数、超 2000 行截断、二进制只留统计 |
| 隐私硬边界 | `.env*`/`.pem`/`.key`/`id_rsa*`/`credentials*`/`secrets*` **不进任何产物**；产物过 `redactSecrets` 后正则断言无 PEM/Bearer/JWT/AWS/`bp_mcp_` 残留 |
| 配额 | 64KB / 512KB / 2MB 三级超限 → 截断 + `artifact_ref` 标记，**不抛错** |
| 非 git 目录 | 返回 `not_a_repository` 快照行而非抛错 |

### P3 — Execution 级 Snapshot 与本地存储

| 类别 | 重点 |
|---|---|
| Migration 17 | 重复 `migrate()` 幂等；部分唯一索引真实生效（直接插重复行应失败） |
| 触发点 T1–T5 | 每个时机一条集成测试；**必须覆盖 `updateJourneyStatus` 取消路径**（`:681-692` 绕过 `updateEventStatus`）——断言被取消的 Journey 也有 `execution_end` 补采 |
| 失败降级 | git 不存在 / 超时 / 无权限 → `capture_status='failed'` + `error_code`，**状态照常推进**（沿用 `.catch(() => undefined)` 惯例） |
| 幂等 | 同一 execution 重复进入不产生第二行；`mcp_idempotency` 重放不触发二次采集 |
| 并发 | 两个 Journey 同绑一 workspace → per-workspace 队列串行，断言采集不交错 |
| 暂停/恢复 | `paused→running` **不**重复 `execution_start`；暂停不关闭执行窗口 |
| 契约 | 新增 3 个证据通道过 `ipc-journey-contracts` 双向键集断言 |

### P4 — Diff Artifact 与归因对照

| 类别 | 重点 |
|---|---|
| 纯函数表驱动 | `buildEvidenceComparison()`：三分类 × 三置信度全组合；放 `shared/` 保证 Records/Canvas 同源 |
| `reported_only` 三成因 | 改后还原 / 基线失败 / HEAD 移动——各造一例，**断言文案不含「虚假」「伪造」「未执行」等词**（验收硬项） |
| artifact 语义 | `omitted:sensitive` / `omitted:over_budget` / `binary` / `null+capture_status!=ok` 四态 UI 文案可区分 |
| 路径 join | 两侧 POSIX 相等；`./` 前缀与 `\` 在 schema 层已被拒，断言无模糊匹配 |

### P5 — Records 时间线与 Diff Viewer + Canvas

| 类别 | 重点 |
|---|---|
| 组件 | evidence bar 渲染 / 三组折叠 / DiffViewer **点开才取**（按需 IPC）/ 无快照降级文案 |
| i18n | `journey.evidence.*` zh + en 双份齐全（对照既有 `journey.detail` 41 键检查方式） |
| 视觉 | `VISUAL_CHECK=1` 沿用 `tests/e2e/journey-visual.e2e.spec.ts`（957 行、`/tmp` 截图 + 页面状态指纹）；**程序化断言为准**（`toContainText`、WCAG 对比度、几何检查） |
| Canvas | 节点高度 **160 不变**；无快照行不占位；Inspector 第 6 节插入后原 5 节（`:233/297/320/405/468`）零改动 |
| 回归 | `journey-fusion.e2e`、`agent-journey-detail`、`journey-detail-quality` 全绿；已知三个基线失败**不追**（`onboarding-agent.e2e:62`、`card-workspace.e2e:170`、`roundtable-workspace.e2e:289`） |

---

## 17. 尚待确认的产品决策

| # | 决策问题 | v1 建议 | 影响 / 解锁阶段 |
|---|---|---|---|
| D1 | **采集默认开还是默认关**（是否需要 Capture Mode 式开关） | 默认开、可在 Settings→本地数据 关闭；关闭时 Journey 正常记录但无观察证据 | **P3 前必须定**，否则表结构要留开关位 |
| D2 | **预算数值**（单文件 64KB / 单快照 512KB / 单 Journey 2MB / 2000 行） | 按建议值实现为常量，产品可后调 | P4，纯常量，风险低 |
| D3 | **绑定摩擦**：每次创建 Journey 是否需要用户在 Desktop 显式确认 | 不弹窗；workspace 是用户预登记的授权容器，创建时引用已登记 uuid 即视为在授权范围内 | **P1 前必须定** |
| D4 | **非 git 目录**要不要做文件系统级 diff 替代证据 | v1 不做，仅显示「该工作区不是 Git 仓库，无观察证据」 | P2 边界 |
| D5 | **从未进入 running 的执行**（`planned→skipped/cancelled`）是否采集 | 不采集（无窗口），UI 显示「无观察窗口」 | P3 触发点 |
| D6 | **证据保留期**：自动清理（如 180 天）还是仅手动 | v1 仅手动（Settings 清理 + Journey 删除随删）；自动清理归 R6-5 | P5 |
| D7 | **手动「立即拍快照」按钮** | 不做；时机全部由状态机驱动，避免用户制造无法解释的窗口 | P3 |
| D8 | **`reported_only` 展示位置**：节点是否也标 | 仅详情面板；节点只显示文件数与 ±行数计数 | P5 |
| D9 | **多 Workspace** | v1 确认单个 → Migration 16 用 `ALTER ADD COLUMN` 而非绑定表（可逆演进） | **P1 结构决策** |
| D10 | **Workspace 删除后重建**能否按 `repository_identity` 重新关联历史 | v1 不做，显示「原工作区已删除」 | P5 文案 |
| D11 | **ignored 文件**是否进文件列表 | 不进列表，仅在「观察限制」给计数（`.gitignore` 是用户意图） | P2 |

**解锁条件**：D1/D3/D9 在 P1 开工前定；D4/D5/D11 在 P2 开工前定；其余可边做边定。

---

## 18. 第一阶段（P1）具体 Codex 提示词

> 以下内容可直接复制给 Codex。**R6-4.3.0 设计阶段不执行它**——它会产生文件改动与 Migration 16，需明确下令后才启动。

````markdown
# 任务：R6-4.3.1 / P1 — Agent Journey ↔ Local Workspace 绑定与授权

## 0. 环境与铁律
- 仓库 `/Users/banmu/Brew/BrewPhase`，业务代码在 `Desktop/` 子目录，分支 `feature/remote-mcp`，基线 `66575db798c84dd8905da8121836d479a7574669`。开工前 `git status` 必须干净。
- 门禁：`pnpm typecheck` / `pnpm build` / `pnpm test` 全绿（node 用 `~/.nvm/versions/node/v22.23.5/bin/node`；`pnpm test` = `mcp:build && vitest run`，当前 105 测试文件）。
- 已知基线失败，**不要追**：`onboarding-agent.e2e:62`（断言 14 scope，实际 16）、`card-workspace.e2e:170`、`roundtable-workspace.e2e:289`、cloud `mcp-oauth/authorize-route.test.ts` 偶发 1ms TTL 抖动。
- **禁止**：新增 MCP 工具（保持 33）、新增 Scope（保持 16）、修改 `evidence_level`（恒 `agent_reported`）、写 change_log / iOS 同步 / Cloud、任何 git 采集代码（属 P2）、重构 `EventDetailSections`。
- Migration 规则见 `migrations.ts:10`：**只追加，不修改已发布版本**。

## 1. Migration 16：`journey-workspace-binding`
- 在 `Desktop/src/main/database/migrations.ts` 的 `migrations` 数组（:760-776，当前末尾是 version 15 `canvas-journey-fusion`）**追加** `{ version: 16, name: 'journey-workspace-binding', sql: ... }`。
- SQL：`ALTER TABLE agent_journeys ADD COLUMN workspace_id TEXT REFERENCES local_workspaces(id) ON DELETE SET NULL;` + 索引 `CREATE INDEX agent_journeys_workspace_idx ON agent_journeys(workspace_id);`
- 语义先例：与 `agent_journeys.work_context_id` 完全一致（删 Workspace 保留 Journey，仅解除引用）。
- 先 grep `DB_SCHEMA_VERSION`（`src/shared/contracts/version.ts:8`，当前值 `1`，与 15 版迁移本就不一致）的全部使用点：仅当存在「与迁移序号一致」的运行时校验才同步为 16；否则**不改**并在交付说明中记录该现存不一致。

## 2. Drizzle schema
- `Desktop/src/main/database/schema.ts` 的 `agentJourneys`（:789 起）加 `workspaceId: text('workspace_id')`（可空，不写 notNull）+ 索引。**不要**把 journey 表塞进 `schema` 汇总对象（:427-450，journey 本就不在里面，`Db` 类型面不受影响）。

## 3. MCP 参数（A 通道）
- `Desktop/src/shared/mcp/tool-schemas.ts` 的 `start_agent_journey`（:404，参数块 :413-420，已有 `work_context_id` uuid 先例 :416）：增加**可选** `workspace_id: uuid.optional()`。
- **只收 uuid，绝不收路径**。描述里写明：只能引用用户已在 Desktop 登记的 Local Workspace。

## 4. Service 校验
- `Desktop/src/main/application/agent-journey/agent-journey-service.ts` 的 `createJourney`（事务 :292-351 **之前**）：若带 `workspace_id`，校验 (a) `local_workspaces` 行存在；(b) availability 为 `available`（复用 `local-workspace-service.ts:200-206` 的判定与 `resolveRoot:153-157`）；失败抛 `VALIDATION_ERROR`。未带 → 与基线行为逐字节一致。
- 依赖注入方式先读 `AgentJourneyService` 构造函数再定；若直接注入 `LocalWorkspaceService` 造成循环依赖，改为注入窄接口（如 `resolveWorkspace(id) => {available}` 函数），**不要**引入新的全局单例。
- 本阶段**不**加任何快照/采集逻辑。

## 5. IPC（B 通道，1 个新通道）
按既有四步惯例逐处落地（缺一处 `ipc-journey-contracts` 就红）：
1. `src/shared/contracts/validation/ipc.ts`：`IPC` 常量（journey 组 :133-139）加 `agentJourneyWorkspaceBind: 'agent-journey:workspace:bind'`；`ipcRequestSchemas`（journey 组 :379-405）加 `{ journeyId: uuid, workspaceId: uuid | null }`。**两处键必须一一对应**（`tests/unit/ipc-journey-contracts.test.ts:57-64` 强制全等）。
2. `src/main/ipc/register.ts`：journey 段（:348-429）加 `handle(IPC.agentJourneyWorkspaceBind, ...)`，调用 Service 新方法 `bindWorkspace(journeyId, workspaceId | null)`（事务内 CAS 更新，沿用 `expectedUpdatedAt` 乐观锁模式；null = 解绑）。若需新依赖，改形参表 :94-147 与解构 :148-171。
3. `src/preload/index.ts`：journey 分组（:278-287）加 `workspaceBind` invoke（测试 :203-216 强制出现 `IPC.<key>`）。
4. `src/shared/contracts/index.ts`：`RendererApi`（:159）journey 分组（:322-335）加类型。
- **不新增** `APP_DOMAINS`（绑定事件复用 `'agentJourneys'` domain，`application-events.ts:8-16` 与 `contracts/index.ts:127-139` 零改动）。
- 读取工作区列表复用**既有** `workspace:list`（`validation/ipc.ts:272`、`register.ts:956`），不新建读通道。

## 6. Renderer UI（最小）
- `src/renderer/src/features/records/JourneyDetail.tsx`（482 行）详情元信息区加一行：已绑定工作区名称（来自 `workspace:list` 匹配）+ 绑定/解绑控件（下拉列已登记 workspace + 「清除绑定」，交互参照 `CardWorkspaceToolbar.tsx:307`）。
- 未绑定 → 显示「未关联工作区」；**不显示任何空的证据/快照区块**（证据 UI 属 P5）。
- i18n：`src/renderer/src/i18n/messages/zh-CN/records.ts` 的 `journey.*`（现 41 键）与对应 en 文件**双份同步**。
- Canvas（`JourneyGroupShape` / `JourneyInspectorBody`）**本阶段零改动**。

## 7. 测试（新增/扩展）
- 单元：`workspace_id` 三态校验（不存在 / missing / 合法）；未带参数回归；`bindWorkspace` 解绑后 Journey 保留。
- 集成（真实 SQLite，仿 `tests/integration/agent-journey-persistence.test.ts`）：Migration 16 升级不破坏既有 Journey；删 `local_workspaces` 行 → `workspace_id` 置 null 且 Journey 仍在。
- 契约：`ipc-journey-contracts.test.ts` 新通道双向通过。
- MCP：`tests/unit/mcp-journey-tools.test.ts` 加 `workspace_id` 合法/非法用例；核对工具数仍 33、Scope 仍 16。
- 安全：传路径字符串被 schema 拒绝；无 `agent_journey:write` 仍被拦。

## 8. 验收清单
- [ ] `pnpm typecheck` / `pnpm build` / `pnpm test` 全绿（基线失败除外）
- [ ] 仅追加 Migration 16，未改动 1-15
- [ ] MCP 33 工具 / 16 Scope 不变；`evidence_level` 不变
- [ ] 零 change_log / iOS / Cloud 改动；零 git 调用代码
- [ ] 未绑定 Journey 全链路正常（MCP 创建 → Records 显示「未关联工作区」）
- [ ] `git diff --check` 无空白错误；交付说明列出改动文件与每处依据
````

---

## 附：本阶段完成标准对照

**「用户打开一次 Agent Journey 后，能不能沿着每一步看到 AI 做了什么、为什么这样做、系统观察到哪些文件变化、具体代码改在哪里，以及哪些事情仍然无法确定？」**

| 问题 | 答案 | 依据章节 |
|---|---|---|
| AI 做了什么 | **能**——纵向时间线每步执行标题+摘要+状态，展开见 `details.changes[]` | §11 |
| 为什么这样做 | **能**——decision/plan/rationale 结构化详情，`EventDetailSections` 既有 6 分区 | §11 |
| 系统观察到哪些文件变化 | **能**——Execution 级 Start/End 快照 → 按文件分组，三类对照 + 置信度 | §6/§10/§11 |
| 具体代码改在哪里 | **能**——点文件看 Unified Diff（hunk/行号/±统计），artifact 在采集时固化，**历史可复现** | §9/§11 |
| 哪些仍无法确定 | **明确标注**：① 变化由哪个 Agent/用户造成（方案 A 不 Hook 进程，只证窗口净变化）；② `reported_only` 的真实成因（改后还原/窗口不完整）；③ 基线或结束快照失败时的 `unconfirmed`；④ 敏感/超预算文件「为何没有内容」 | §8/§10/§13 |
