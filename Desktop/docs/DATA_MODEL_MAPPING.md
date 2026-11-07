# 数据模型映射（iOS SwiftData → Desktop SQLite）

桌面端有**自己的** SQLite 库，不直接读写 iOS 的 SwiftData 文件。映射只保证语义一致：
UUID 稳定、字段含义一致、关系与级联一致。物理格式可以不同（时间存 epoch 毫秒、
布尔存 0/1），同步时由适配层转换。

## 1. 字段对照

| iOS | Desktop `beans` | 说明 |
| --- | --- | --- |
| `id: UUID` | `id TEXT PK` | 保持同一个 UUID，跨端可对齐 |
| `name` / `roaster` / `origin` / `process` | 同名列 | 直接映射 |
| `roastLevelRaw` | `roast_level` | 取值 `light/medium/mediumDark/dark/espressoBlend`（**五档，含意式拼配**） |
| `roastDate` / `purchaseDate` / `openDate` | 同名 `*_date INTEGER` | epoch 毫秒，可空 |
| `weightG` / `remainingG` / `price` | `REAL` | 克与金额 |
| `flavorTagsRaw` | `flavor_tags_raw` | **沿用 iOS 的 `\u001F` 分隔**，同步时零转换 |
| `statusRaw` | `status` | `active/finished` |
| `stockCountedAt` | `stock_counted_at` | 人工盘点时刻；决定旧冲煮是否参与自动退粉 |
| `createdAt` / `updatedAt` | `INTEGER` | epoch 毫秒 |

| iOS | Desktop `brews` | 说明 |
| --- | --- | --- |
| `bean`（关系） | `bean_id REFERENCES beans(id) ON DELETE CASCADE` | 删豆子带走它的冲煮（iOS 同一规则） |
| `date` / `method` / `grinder` / `grindSize` / `waterTemp` | 同义列 | |
| `coffeeG` / `waterG` / `timeSeconds` | `REAL/REAL/INTEGER` | 比例是派生的，不存 |
| `score` / 五项感官 | `INTEGER` | |
| `flavorTagsRaw` / `notes` | 同名 | |
| `stockDeductedG` | `stock_deducted_g REAL NULL` | **实际**扣掉的克数；`NULL` = 旧数据，按粉量退 |

| iOS | Desktop `tastings` | 说明 |
| --- | --- | --- |
| `bean` | `bean_id ... ON DELETE CASCADE` | |
| `brewID` | `brew_id TEXT NULL` | 镜像记录指向生成它的冲煮；手动记录为空 |
| `dayAfterRoast` | `day_after_roast` | iOS 存了但界面用 `resolvedDayAfterRoast` 现算；桌面端只在生成镜像时写一次 |
| `sourceRaw` | `source` | `manual/brew` |

| iOS | Desktop | 说明 |
| --- | --- | --- |
| `PhaseRule` | `phase_rules` | 五档各一行；默认值逐个对过 `DefaultPhaseRules` |
| `PhaseReminder` | `phase_reminders` | **只存意图**（豆子、时机、时间、enabled）。iOS 的 `identifier` 是设备本地的通知 id，不同步、不复制 |
| `EmbeddingRecord`（RAG） | 不建表 | 派生索引，不是用户数据；桌面端需要时重建 |

| iOS | Desktop `records` / `record_tags` / `record_tag_links` | 说明 |
| --- | --- | --- |
| `Record` | `records` | 四种载体：`link/image/video/text`；`media_path`/`preview_path` 存**文件名** |
| 标签数组 | `record_tags` + `record_tag_links` | 多对多关系表；同名标签唯一 |
| `RecordTag.records` | 关系表的反向查询 | 不存数组 |

| iOS | Desktop `canvases` / `canvas_nodes` / `canvas_strokes` | 说明 |
| --- | --- | --- |
| `Canvas` | `canvases` | |
| `CanvasNode` | `canvas_nodes` | 字段一一对应：`canvas_id`、`record_id`、世界坐标、尺寸、`z_index`、`annotation`；**唯一索引 (canvas_id, record_id)** 防重复 |
| —（新增） | `canvas_strokes` | 笔迹：`tool_type`、`points`（世界坐标 JSON 数组）、`color`、`width`、`opacity`、`z_index` |

> **CanvasStroke 的现状**：iOS 端没有对应的模型与渲染。桌面端这一版只建表与结构，
> 不宣称两端都能看到笔迹——真正的两端支持要等 iOS 加上模型与画布渲染。

## 2. 关系与级联

```
Bean 1─n Brew      (cascade)
Bean 1─n Tasting   (cascade)
Bean 1─n PhaseReminder (cascade)
Record n─n RecordTag (record_tag_links, 两边 cascade)
Canvas 1─n CanvasNode (cascade)
Record 1─n CanvasNode (cascade)   ← iOS 由应用层 CanvasNodeStore 清理，桌面端用外键
Canvas 1─n CanvasStroke (cascade)
```

桌面端把「删记录要清节点」交给数据库外键（`PRAGMA foreign_keys = ON`），iOS 交给
`CanvasNodeStore`。**语义相同**：删节点永远不删记录；删记录一定清掉引用它的节点。

## 3. 库存语义（与 `BrewRecorder` 逐条对齐）

| 场景 | 规则 | 桌面实现 |
| --- | --- | --- |
| 新建冲煮 | 扣 `min(remaining, coffeeG)`，记实扣量 | `deductStock` |
| 编辑冲煮 | 按「新粉量 − 原实扣量」调整；实扣量按实际变动修正 | `adjustForEdit` |
| 删除冲煮 | 退**实扣量**（不是粉量），并删掉镜像品鉴 | `refundStock` + `appliedDeduction` |
| 人工盘点后 | 盘点前创建的冲煮不再参与退粉 | `isSettledForStock` |
| 删除失败 | 回滚库存与状态 | `db.transaction` |

单测逐条覆盖这些边界（`tests/unit/inventory.test.ts`）。

## 4. 同步元数据（预留）

`sync_meta` 与 `change_log` 不改变业务表，只记录「谁在什么时候改了哪条、改到第几版」。
每次写操作与业务写入**同一个事务**，避免出现「数据改了、日志没记」的洞。

---

## Phase 2 附录：同步对齐后的修订（2026-11-07）

迁移 002（`sync-align-ios`）后，本表的「Desktop 缺失」列已全部补齐：

- `beans.is_sample` / `canvases.is_sample`：示例数据标记随数据同步。
- `records.content_kind / link_page / repository_issues / repository_license`：
  iOS LinkProvider 体系的完整元数据。
- `devices.last_sync_at`：每设备独立 Token（服务端只存哈希），可撤销。
- 新表 `sync_baseline`（内容指纹基线）/ `sync_conflicts`（两端同改的裁决队列）。
- `phase_reminders`：v1 建表，本版纳入同步实体（只同步意图，不同步系统通知
  identifier——每端自行重建通知）。

逐字段核对记录见 `FEATURE_PARITY_AUDIT.md`。
