# Resolver × Sync 数据一致性（Phase 3.1）

Desktop 的自动元数据补全（Link Resolver）与 iOS → Desktop 同步必须互不误伤。
本文是这条边界的**权威说明**：谁拥有哪个字段、哪些字段进同步指纹、冲突与删除
如何判定，以及对应的回归测试。

## 1. 问题（修复前）

`applyResolvedMetadata()` 直接把抓取结果写进 `records` 表：`source_name`、
`author_name`、`summary`、`thumbnail_url_string`、`metadata_status`、
`repository_*`、`canonical_url`、`platform_content_id`。这些列**全部参与 record
的同步指纹**（两端逐字段镜像，见 SYNC_PROTOCOL §5）。

于是：iOS 推送 → 桌面落库（指纹 = iOS 指纹）→ 桌面自动补全 → 本地指纹变了
→ iOS 再推同样内容 → 被判定为「桌面端自己改过」→ **假冲突**；iOS 删除时
`expectedFingerprint` 也对不上 → **假删除冲突**。

复现（修复前的真实输出）：

```
first  1 applied / 0 skipped / 0 conflict
second 0 applied / 0 skipped / 1 conflict   reason: "desktop has local changes"
```

## 2. 字段所有权

| 字段 | 所有者 | 进指纹 |
|---|---|---|
| `carrier`、`note`、`media_path`、`preview_path`、`is_sample` | iOS 同步 / 桌面用户编辑 | ✅ |
| `title` | iOS 同步 / **桌面用户手写**（自动标题不写这里） | ✅ |
| `url_string` | iOS 同步 / 桌面用户编辑（权威输入） | ✅ |
| `canonical_url`、`platform_content_id`、`provider`、`content_kind`、`link_page` | URL 派生（iOS payload 携带；桌面新建/改 URL 时按同一解析规则重算） | ✅ |
| `source_name`、`author_name`、`summary`、`thumbnail_url_string`、`metadata_status`、`repository_*` | **iOS 同步**（iOS 自己的抓取结果）；桌面用户改 URL 时清空 | ✅ |
| `record_metadata.*`（下表） | **Desktop Resolver 独占** | ❌ |
| `record_tag_links`、`canvas_nodes` | 各自实体（关系表） | — |

`title` 有两种来源，靠**存储位置**区分，而不是猜：

- 用户手写的标题 → `records.title`（用户数据，进指纹）；
- 自动抓到的标题 → `record_metadata.title`（展示信息，不进指纹）。

Inspector 里自动标题只作为输入框的 placeholder 出现；用户不输入，保存时回传
`records.title` 的原值，不会把自动标题「升级」成用户数据。

## 3. `record_metadata`（迁移 005）

| 列 | 含义 |
|---|---|
| `record_id` | 主键，外键 → `records(id)` ON DELETE CASCADE |
| `url_string` | 抓取时的 URL，与 `records.url_string` 不一致即整行作废 |
| `provider` / `content_id` / `canonical_url` | 平台身份 |
| `title` / `description` / `thumbnail_url` / `source_name` / `author_name` | 展示信息 |
| `repository_language` / `repository_stars` / `repository_forks` / `repository_license` | 仓库统计（GitHub） |
| `status` | `idle` / `pending` / `ok` / `failed`（Desktop 单方状态） |
| `error_message` / `fetched_at` | 失败原因与抓取时间 |

**URL 生命周期**：URL 变化（用户编辑或 iOS 更新）→ 整行删除并按新 URL 重建
初始状态（`pending`，非法 URL 直接 `failed`）；载体改成非 `link` → 整行删除。
旧封面不可能挂到新链接上。

**展示组装**（`toRecordItem` + `buildPreview`）：记录字段优先，`record_metadata`
只补空。`metadataStatus` 取本地状态优先，否则用 iOS 同步来的值。

## 4. 冲突与删除判定（不变的部分）

- 本地指纹只由 `records` 表计算，Resolver 不写这些列 → 自动补全**不会**制造冲突；
- 桌面用户真的改了 `title` / `note` / `urlString` 等用户字段 → 指纹变化 →
  按原规则产生冲突，绝不静默覆盖；
- iOS 删除带 `expectedFingerprint`：桌面没有用户修改时正常删除（本地派生元数据
  随外键级联消失）；桌面真改过则照旧进入删除冲突队列。

## 5. 回归测试

`Desktop/tests/integration/sync-metadata.integration.test.ts`（真实 SQLite +
真实 `applyBatch()`）：

| 场景 | 断言 |
|---|---|
| 1 首次同步 + 自动补全 + 重推同样内容 | 无冲突、`skipped`、元数据仍在；`records` 同步列保持空 |
| 2 元数据刷新失败 | 无假冲突、旧数据与 `ok` 状态保留 |
| 3 iOS 修改标题/备注 | 正常接收并更新基线；本地派生元数据不被清空；iOS 改 URL → 旧派生元数据整行作废 |
| 4 iOS 删除 | 桌面无修改 → 正常删除且级联清理；桌面真改过 → 仍产生删除冲突 |
| 5 桌面用户改标题 | iOS 再推原内容 → 冲突，桌面标题不被覆盖 |
| 6 重复同步幂等 | 连推三次不重复插入/不重复冲突；标签关系与本地元数据保持 |

配套：`tests/integration/repository.test.ts` 覆盖写入守卫（删除/载体变化/URL 变化）
与状态语义；`tests/unit/record-preview.test.ts`、`tests/unit/inspector-state.test.ts`
覆盖展示层组装与 dirty 语义。

## 6. 已知边界

- **迁移不做历史回填**：升级前已经被写进 `records` 的自动元数据保持原样（无法
  区分它来自 iOS 还是桌面抓取，贸然搬动会删用户数据）。这类老记录若本轮之前
  已累积过一次假冲突，需要用户裁决一次；**新产生的不会再有问题**。
- 单向同步不变：Desktop 本地派生元数据**不回传** iOS。
- 桌面改 URL 时会清空 `records` 里的 iOS 元数据列（旧 URL 的信息对新链接无效），
  这属于用户主动修改，按规则进入冲突是预期行为。

## 7. 同步后自动补全（Phase 3.2）

### 何时触发

```
POST /api/sync/apply
   ↓ applyBatch()                一个事务，不碰网络
   ↓ 事务提交（此时数据已经落库、可读）
   ↓ onApplied(outcome)          同步回调：只挑 applied 的 record 入队
   ↓ ResolveQueue.enqueue(...)   内存操作，不 await、不发起网络
   ↓ 写出 HTTP 200（带着 outcome）
   ┈┈┈（此后异步）┈┈┈
   ↓ 队列按并发 2 抓取（网络在事务之外）
```

**准确时序**：`applyBatch()` 的事务提交 → `onApplied()` 同步入队 → 才写出 HTTP 200
响应。也就是「响应**不是**在入队之后才发」这么简单——而是**先提交、再同步入队、
最后应答**；入队本身不发起任何网络请求，所以响应延迟与 Resolver 无关。

- **网络请求永远在事务之外**：抓取发生在 `applyBatch` 返回之后，执行体自己开短事务；
- 调度回调不等待任何外部请求（生产实现里只有 `queue.enqueue()`，同步返回）；
- 抓取失败**不会**改变已经完成的同步结果（HTTP 早已返回 200，队列只写本地派生表）；
- HTTP 同步接口**不等待**元数据补全完成（有测试断言：Resolver 卡在网络上时
  apply 仍在 1s 内返回）；
- 抓取结束后由 `records:metadata-updated` 通知 Renderer 刷新。

### 哪些情况抓，哪些不抓

| 记录状态 | 派生行 | 处理 |
|---|---|---|
| 新的 link | 无 | 建 `pending` → 抓 |
| URL 变了 | 有（旧 URL） | 删旧行 + 建 `pending` → 抓 |
| 同一 URL，`pending` | 有 | 抓（上次没跑完，例如应用被关掉） |
| 同一 URL，`ok` / `failed` | 有 | **不抓**（失败后由用户手动刷新，避免无限重试） |
| 不是 link / 没有 URL | 有 | 直接删行 |
| 同步结果 `skipped` / `conflict` / `failed` | — | 不入队 |

### 队列

`src/main/metadata/resolve-queue.ts`：

- 并发上限 **2**（首轮导入几十条链接时不会同时打外部平台）；
- 幂等键 `recordId + urlString`：排队中/执行中的同一任务不重复入队；
- 只有「真到执行时 URL 仍是入队时那个」才会写入（`expectedUrl` + `applyResolvedMetadata`
  的读写同事务校验双重保护）；
- 失败不重试，状态落 `failed`；`onSettled` 广播 `records:metadata-updated`。

### 应用重启恢复

启动时扫描 `record_metadata.status = 'pending'` 且 `url_string` 与记录当前 URL 一致、
记录仍是 `link` 的行，逐条入队。**不会**恢复 `failed`（那是用户手动刷新的职责）。

### 界面刷新

主进程每次任务结束（成功或失败）都 `webContents.send('records:metadata-updated')`；
Records 页面订阅后重新拉取列表 → 卡片与详情自动更新，不需要切页或重启。

### 搜索

`listRecords()` 的搜索用 **EXISTS 子查询**接入 `record_metadata`：

```sql
exists (
  select 1 from record_metadata
   where record_metadata.record_id = records.id
     and record_metadata.url_string = records.url_string   -- URL 必须一致
     and (title like ? or description like ? or source_name like ? or author_name like ?)
)
```

- 不用 JOIN：关系不唯一时 JOIN 会让同一条记录出现多行，分页跟着错；
- URL 不一致的旧派生行**不参与搜索**；
- 搜索只读，不写 `change_log`、不影响指纹。

### 展示优先级（详情与卡片共用同一份组装结果）

| 展示项 | 顺序 |
|---|---|
| 标题 | `records.title` → `record_metadata.title` → 摘要首行 → 载体名 |
| 作者 / 来源 | `records.*` → `record_metadata.*`（同一项只显示一次） |
| 语言 / ★ / Fork | `records.*` → `record_metadata.*` |
| 摘要 | `records.summary` → `record_metadata.description` |
| 封面 | `records.thumbnail_url_string` → `record_metadata.thumbnail_url` |
| 抓取状态 | `record_metadata.status` → `records.metadata_status`（iOS 原值） |

自动标题在 Inspector 里只作输入框的 **placeholder**；用户不输入，保存时回传
`records.title` 的原值，不会被「顺手保存」升级成用户数据。
