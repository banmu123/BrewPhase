# BrewPhase MCP V1 — 工具清单

> 与 `MCP_ARCHITECTURE.md`（结构）、`MCP_SECURITY.md`（信任边界）配套。
> 所有工具的参数在 Main 端用 Zod 再校验一次；MCP Server 的校验只是第一道。

## 通用约定

- 所有 ID 是 UUID 字符串；所有时间是 **epoch 毫秒**（字段名带 `_at` / `*_ms` 的都是毫秒）。
- 分页：`limit` 默认 20 / 最大 50（coffee 最大 100）；`offset` ≥ 0。
- 返回：`structuredContent` 为机器可读对象，`content[0].text` 是同一对象的 JSON。
- 写工具响应都带 `"sync_status": "desktop_local_only"`；create 类返回**简版**
  （`record_id` / `canvas_id` / `note_id` + 少量字段），完整字段用对应的 get 工具读。
- 正文截断：`search_records` 列表里的 note/summary 截 400 字符，`get_record` 截 4000。
- 错误统一 `{ "error": { "code": "...", "message": "..." } }`，错误码表见
  `MCP_SECURITY.md` §5。不返回 SQL、堆栈、绝对路径。

## Records

### `search_records` — `records:read`

```ts
{ search?: string, carrier?: 'link'|'image'|'video'|'text', tag_id?: string,
  limit?: number, offset?: number }
```

返回 `{ items: RecordSummary[], limit, offset, has_more }`。搜索覆盖标题、正文、
备注、来源/作者/摘要、URL 与本地派生元数据（URL 一致才算）。

### `get_record` — `records:read`

`{ record_id: string }` → 完整记录：id / carrier / title / note / url / provider /
source / tags / metadata / createdAt / updatedAt / has_media（`has_media` 是布尔，
**不返回文件名与路径**）。

### `list_record_tags` — `tags:read`

→ `{ items: [{ id, name, created_at }] }`。

### `create_record` — `records:create`

```ts
{ carrier: 'link'|'text', title?: string, note?: string, url?: string,
  tag_ids?: string[], idempotency_key: string }
```

- `text` 可不带 `url`；`link` 必须带合法 http(s) URL。
- 平台识别与规范化由 Main 端 `parseLink` 完成（provider / canonicalUrl /
  platformContentId 由 BrewPhase 生成，AI 不能指定）。
- 不接受 `mediaPath` / `previewPath`（V1 不允许 AI 上传媒体）。
- `tag_ids` 必须全部存在，否则 `NOT_FOUND`。
- 创建后自动调度本地元数据补全（与 Renderer 创建同一条链路）。
- 返回 `{ record_id, title, carrier, created_at, updated_at, sync_status }`（简版；
  完整字段用 `get_record`）。

### `update_record` — `records:update`

```ts
{ record_id: string, expected_updated_at: number,
  patch: { title?: string, note?: string, url?: string, tag_ids?: string[] } }
```

- 至少一个字段；`patch` 里没有的字段保持原值（空字符串表示清空）。
- 不允许改 carrier / 媒体字段。
- 乐观并发：库中 `updated_at !== expected_updated_at` → `STALE_RECORD`。
- URL 变更沿用 Repository 的 URL 生命周期（清旧派生元数据、重新补全）。

### `create_tag` — `tags:create`

`{ name: string }`（1–40 字符，重名返回已存在标签）→ `{ tag_id, name, created_at }`。

## Coffee（V1 全部只读）

### `list_beans` — `coffee:read`
`{ status?: 'active'|'finished', limit?, offset? }` → 豆子列表（含剩余克数、
烘焙日期、`days_since_roast` 由 `roast_date` 与当前时间直接计算，无数据时为 null）。

### `get_bean` — `coffee:read`
`{ bean_id }` → 豆子详情 + 该豆的冲煮与品鉴计数。

### `list_brews` — `coffee:read`
`{ bean_id?: string, since_ms?: number, limit?, offset? }` → 冲煮记录（参数、
评分、风味标签、`stock_deducted_g`）。

### `list_tastings` — `coffee:read`
`{ bean_id?: string, since_ms?: number, limit?, offset? }` → 品鉴记录。

### `get_coffee_summary` — `coffee:read`
`{}` → `{ beans: { total, active, finished }, brews: { total, last_30_days },
tastings: { total, average_score } }`。只读聚合，不推导不存在的数据。

**Coffee 没有写工具。** 库存扣减/退还只存在于 Repository 的冲煮写入路径
（Renderer 与 iOS 同步），V1 不允许 AI 触碰。

## Canvas

> 本节五个写工具（`create_canvas` / `add_record_to_canvas` /
> `create_canvas_note` / `update_canvas_note` / `annotate_canvas_node`）全部是
> **Desktop 本地操作**：只改本机 SQLite，响应里的
> `sync_status: desktop_local_only` 表示不会回传 iPhone。便签与笔迹也只属于
> Desktop（iOS 无对应同步模型）。客户端授权、`canvas:write` scope、幂等键、
> `expected_updated_at` 乐观并发与写入审计照常生效；这些边界不因本地写入而改变。
> 桌面改过的节点在 iPhone 再次同步时会进入冲突队列并保留本地版本，见
> `docs/SYNC_PROTOCOL.md` §4。

### `list_canvases` — `canvas:read`
`{}` → `{ items: [{ id, name, note, created_at, updated_at, node_count, note_count }] }`。

### `get_canvas` — `canvas:read`
`{ canvas_id }` → 画布基础信息 + `nodes[]`（id、record 摘要、坐标、尺寸、
annotation）+ `notes[]` + `strokes[]`（只有 id/颜色/宽度/点数量，**不返回点集**）。

### `create_canvas` — `canvas:write`
`{ name, note?, idempotency_key }` → `{ canvas_id, name, created_at, updated_at, sync_status }`。

### `add_record_to_canvas` — `canvas:write`
`{ canvas_id, record_id, annotation?, idempotency_key }`

- 画布或记录不存在 → `NOT_FOUND`。
- 初始摆放由 `nextNodeOrigin` 计算（AI 不接触屏幕坐标）。
- 同一画布同一记录重复添加返回**既有节点**（`created: false`，数据库唯一索引 + 先查再插）。
- 返回 `{ node, created, sync_status }`。

### `create_canvas_note` — `canvas:write`
`{ canvas_id, title, body, color?, idempotency_key }`

- 自动排布位置（首个便签在原点，其后按 `nextNodeOrigin` 避让已有便签）。
- 返回 `{ note_id, title, canvas_id, created_at, updated_at, sync_status }`。

### `update_canvas_note` — `canvas:write`
`{ note_id, expected_updated_at, title?, body?, color? }`
→ 版本不匹配 `STALE_RECORD`；只更新给出的字段。

### `annotate_canvas_node` — `canvas:write`
`{ node_id, annotation }`（≤ 2000 字符）→ 节点必须真实存在，否则 `NOT_FOUND`。

## 未提供的工具（V1 明确不做）

`execute_sql` / `run_command` / `read_file` / `write_file` / `delete_record` /
`delete_canvas` / `delete_canvas_note` / `remove_canvas_node` / `create_brew` /
`update_brew` / `delete_brew` / `update_bean` / 任何媒体上传、任何网络代理。

## 工具 → Scope 映射（Main 端强制）

| Tool | Scope |
|---|---|
| search_records / get_record | records:read |
| create_record | records:create |
| update_record | records:update |
| list_record_tags | tags:read |
| create_tag | tags:create |
| list_beans / get_bean / list_brews / list_tastings / get_coffee_summary | coffee:read |
| list_canvases / get_canvas | canvas:read |
| create_canvas / add_record_to_canvas / create_canvas_note / update_canvas_note / annotate_canvas_node | canvas:write |
| list_work_contexts / get_work_context | work_context:read |
| create_work_context / link_work_context_resource | work_context:create |
| update_work_context | work_context:update |
| get_direction_overview | direction:read |
| propose_current_state / propose_direction / propose_stage_goal | direction:propose |

**没有** `direction:confirm` 这类 scope。确认动作不存在于 MCP 侧，故无从授出。

## Work Context（持续工作上下文）

> 设计与边界见 `docs/WORK_CONTEXT_SPEC.md`。V1 为 Desktop 本地数据，
> 所有写响应带 `"sync_status": "desktop_local_only"`，不进 iOS 同步。

### `list_work_contexts` — `work_context:read`

```ts
{ status?: 'active'|'paused'|'completed', limit?: number, offset?: number }
```

返回 `{ items: [{ context_id, title, status, summary, next_step,
last_activity_at, record_count, canvas_count, url_count }], limit, offset,
has_more }`，按 `last_activity_at` 倒序。**恢复工作的入口**：先 list 再 get。

### `get_work_context` — `work_context:read`

```ts
{ context_id: string }
```

返回基本信息 + `resources[]`（`{ resource_id, resource_type: 'record'|'canvas'|'url',
resource_ref, role, note, label }`，label 是 record 标题 / canvas 名称 / url 本身）。
指向已删除实体的关联会在读取时自动清理。

### `create_work_context` — `work_context:create`（幂等）

```ts
{ title, goal?, summary?, next_step?, idempotency_key }
```

返回 `{ context_id, title, status, created_at, updated_at, sync_status }`。

### `update_work_context` — `work_context:update`

```ts
{ context_id, expected_updated_at, patch: { title?, goal?, summary?, next_step?,
status?: 'active'|'paused'|'completed' } }
```

只改传入字段；`expected_updated_at` 不匹配返回 `STALE_RECORD`（重读后重试）。
返回更新后的完整上下文（同 get 形状）。

### `link_work_context_resource` — `work_context:link`（幂等）

```ts
{ context_id, resource_type: 'record'|'canvas'|'url', resource_id?, url?, role?,
note?, idempotency_key }
```

record / canvas 必须真实存在（否则 `NOT_FOUND`）；url 仅 http/https；同一资源
重复关联返回已有关联（`created: false`）。返回
`{ resource: { resource_id, resource_type, resource_ref, role, note, label }, created }`。

## Personal Direction（现状 / 方向 / 阶段）

> 设计见 `docs/PERSONAL_DIRECTION_SPEC.md`。Desktop 本地数据，不进 iOS 同步。
>
> **这组工具只有 read 与 propose。** 确认动作只挂在应用界面的 IPC 上，
> MCP 侧没有对应工具、也没有对应 scope——AI 因此无法把草稿变成用户的正式资料。
> 这不是调用约定，是通道层面的事实：少一条通道，就少一条越界的路径。

### `get_direction_overview` — `direction:read`

```ts
{ include_state_history?: boolean }
```

返回 `{ current_state, current_state_draft, directions[], stages[],
pending_proposals: { current_state, directions, stages } }`。

- `current_state` 是**已确认**的现状（没有就是 `null`）；`current_state_draft`
  是 Agent 之前写的那份草稿。两者分开，AI 不该把草稿当成用户的真实状态。
- `directions[]` 含 `direction_id / title / description / motivation /
  time_horizon / outcomes / constraints / status / source`。
- `stages[]` 含 `stage_id / direction_id / name / goal / expected_outcome /
  completion_criteria / time_horizon / obstacles / work_context_id / status`。
- 刻意不返回 `created_at`：AI 很容易拿一个时间戳编出「最近三周没进展」，
  而它并没有活动数据支撑这个结论。

### `propose_current_state` — `direction:propose`

```ts
{ summary?, work_status?, capabilities?, ongoing?, capacity?, constraints?, other? }
```

写入**草稿**，不替换已确认的现状。重复调用覆盖上一份草稿（不会堆成多条）。
字段留空比编造好——用户没说过的事不要替他说。

返回 `{ state_id, status: 'draft', note }`。

### `propose_direction` — `direction:propose`

```ts
{ title, description?, motivation?, time_horizon?, outcomes?: string[], constraints? }
```

写入 `status: 'proposed'` 的方向。同名提议视为同一份草稿的再编辑，覆盖而非追加。
返回 `{ direction_id, title, status: 'proposed', note }`。

不要求量化：无法量化的方向不折算成分数。

### `propose_stage_goal` — `direction:propose`

```ts
{ direction_id, name, goal?, expected_outcome?, completion_criteria?,
  time_horizon?, obstacles?, work_context_id? }
```

写入 `status: 'proposed'` 的阶段，`direction_id` 必须指向真实方向（否则 `NOT_FOUND`）。
同名阶段在同一方向下同样覆盖。`completion_criteria` 应当是能被观察到的；
用户没说过怎么算完成，就留空，不要自己发明一个阈值。

返回 `{ stage_id, direction_id, status: 'proposed', note }`。
