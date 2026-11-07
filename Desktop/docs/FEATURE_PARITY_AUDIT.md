# iOS ⇄ Desktop 功能对齐审计（Phase 2 前置）

依据：本机真实代码。iOS 侧为 `BrewPhase/Models/*.swift` 的 @Model 存储属性，
Desktop 侧为 `src/main/database/schema.ts` 与 `src/shared/contracts/entities/*`。
逐字段核对，不做「名字像就对齐」的假设。

## 结论总表

| 实体 | 判定 | 说明 |
|---|---|---|
| Bean | ⚠️ 差 1 列 | Desktop 缺 `is_sample`；其余 20 字段全部对应 |
| Brew | ✅ 完整对应 | 含关键的 `stock_deducted_g`（实扣库存，非 coffeeG）；无 `updatedAt`（两端一致） |
| Tasting | ✅ 完整对应 | 含 `brew_id`（镜像关联）与 `source`（sourceRaw） |
| PhaseRule | ✅ 完整对应 | **但同步必须按 roastLevel 匹配**（两端默认规则 UUID 各自生成） |
| PhaseReminder | ❌ Desktop 缺表 | iOS 有完整模型（kind/fireDate/enabled + 系统通知 identifier）；需新建表，identifier 不同步 |
| Record | ⚠️ 差 4 列 | Desktop 缺 `content_kind` / `link_page` / `repository_issues` / `repository_license` |
| RecordTag | ✅ 完整对应 | 多对多经 `record_tag_links`，ID 保留 |
| Canvas | ⚠️ 差 1 列 | Desktop 缺 `is_sample` |
| CanvasNode | ✅ 完整对应 | 世界坐标/尺寸/zIndex/annotation 全齐 |
| CanvasStroke | — 不参与 | iOS 无此业务模型；Desktop 表保留但不同步 |
| RAG Embedding | — 不参与 | 派生索引，桌面端可重建 |

## 逐项细节与语义差异

### 1. UUID
两端全部是端上生成的 UUID（SwiftData `UUID` / Desktop `text PRIMARY KEY`），
**可原样跨端保留**，禁止重新生成。

### 2. 时间
iOS `Date` → Desktop `epoch 毫秒`（better-sqlite3 integer）。iOS 备份格式历史上
用秒（`timeIntervalSince1970`），同步 DTO **统一毫秒**并做 >1e12 防御（秒值×1000），
避免把秒当毫秒写入。

### 3. 关系与级联
- Brew.beanID → beans.id（Desktop 外键 cascade；iOS 是 SwiftData 关系）。
- Tasting.beanID / Tasting.brewID：brewID **可空**，镜像品鉴来自冲煮自动生成
  （iOS `source = brewMirror`），同步必须带 sourceRaw，否则桌面端会把手写与
  镜像混在一起、重复同步时产生多余品鉴。
- PhaseReminder.beanID：级联随 Bean。
- RecordTag ↔ Record：**纯多对多**，`record_tag_links` 双外键 cascade。
- CanvasNode：canvasID/recordID 双引用（cascade），annotation 是画布专属，
  **不写回 Record.note**（与 iOS 同一约定）。
- 删除 Bean 时：iOS 级联删 brews/tastings/reminders；Desktop 靠外键 ON DELETE
  CASCADE 达成同一结果，快照导入按 beans → brews → tastings → reminders 顺序写。

### 4. 库存一致性
`stockDeductedG` 是唯一事实（袋里不够时 ≠ coffeeG）。同步原样搬运，桌面端
**不做任何重算**；`remainingG` 同样按 iOS 现值落库。`stockCountedAt` 语义
（盘点后旧冲煮不参与退粉）在导入时随字段一起保留。

### 5. PhaseRule 唯一性
两端首装各自生成五档默认规则 → UUID 必然不同。合并策略：**按 roastLevel 找
现有规则则更新其数值字段，找不到才插入**；同一烘焙度只保留一份有效规则。

### 6. 媒体
- ImageStore：bean imagePath、record mediaPath（图）、previewPath（封面/预览）。
- MediaStore：record 视频本体（.mov/.mp4/.m4v）——**iOS 完整备份的 JPG 附件
  清单不含视频**，同步清单必须单独枚举 MediaStore。
- Desktop media 目录按文件名存（哈希名 + 严格校验），`bpmedia://` 协议已做
  sender/路径校验；视频第一版只落盘 + 列表展示信息，不做播放。

### 7. UI 缺口（数据结构已在、界面未做）
- Desktop Coffee 页不展示：bean 图片、origin/process/channel、五维感官、
  PhaseRule 管理、提醒意图。
- Records 页不展示：视频信息块、repository 统计/license、metadataStatus。
- Settings 无设备管理。→ Phase 2 一并补齐（见实现）。

### 8. 需要的 Desktop 追加迁移（002）
- `beans` + `is_sample`；`canvases` + `is_sample`
- `records` + `content_kind` / `link_page` / `repository_issues` / `repository_license`
- 新表 `phase_reminders`
- 同步基建：`sync_devices` / `sync_baseline` / `sync_conflicts` / `sync_state`
