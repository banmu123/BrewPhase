# 数据模型映射：iOS SwiftData ↔ Android Room

三条贯穿全表的约定：

1. **主键就是 iOS 的业务 UUID 字符串**。同步时原样保留，任何情况下都不重新生成。
2. **时间一律 `Long`（epoch milliseconds）**，与 `SYNC_PROTOCOL.md` 一致，不用秒。
3. **枚举存 `*Raw` 字符串**，未知值有回退——与 iOS 存 `rawValue` 同理。

Android 侧的表名/字段名可能不同（SQL 习惯），但语义必须一一对应。下表是唯一依据。

## 1. Bean → `beans`

| iOS `Bean` | Android `BeanEntity` | 说明 |
|---|---|---|
| `id: UUID` | `id: String` (PK) | 原样保留 |
| `name` / `roaster` / `origin` / `process` | 同名 | |
| `roastLevelRaw` | `roastLevelRaw` | `light` / `medium` / `mediumDark` / `dark` / `espressoBlend` |
| `roastDate: Date?` | `roastDateMillis: Long?` | 存当天 00:00 |
| `purchaseDate` / `openDate` | `purchaseDateMillis` / `openDateMillis` | |
| `weightG` / `remainingG` / `price` | 同名 | |
| `channel` / `imagePath` | 同名 | 图片存**文件名**，不是绝对路径 |
| `flavorTagsRaw` | `flavorTagsRaw` | **U+001F 分隔**，与 iOS `Bean.tagSeparator` 相同 |
| `notes` / `statusRaw` | 同名 | `active` / `finished` |
| `createdAt` / `updatedAt` | `createdAtMillis` / `updatedAtMillis` | |
| `stockCountedAt: Date?` | `stockCountedAtMillis: Long?` | 盘点时刻；早于它的冲煮不再自动退粉 |
| `isSample` | `isSample` | 示例数据标记 |
| `brews` / `tastings` / `reminders`（cascade） | 外键 `beanId` + `onDelete = CASCADE` | 删豆带走冲煮/品鉴/提醒 |

**派生字段不存**：`isFinished`、`dayAfterRoast`、`currentDayAfterRoast` 全部现算。

## 2. Brew → `brews`

| iOS `Brew` | Android `BrewEntity` | 说明 |
|---|---|---|
| `id` | `id` (PK) | |
| `bean` 关系 | `beanId` (FK, CASCADE, index) | |
| `date` | `dateMillis` | |
| `method` / `grinder` / `grindSize` | 同名 | |
| `waterTemp` / `coffeeG` / `waterG` | 同名 | |
| `timeSeconds` | `timeSeconds` | 存秒；显示 `2:35` |
| `score` / `acidity` / `sweetness` / `bitterness` / `body` / `aftertaste` | 同名 | 0…5，0 = 没填 |
| `flavorTagsRaw` | `flavorTagsRaw` | U+001F |
| `notes` / `createdAt` | 同名 / `createdAtMillis` | |
| `stockDeductedG: Double?` | `stockDeductedG: Double?` | **不等于 `coffeeG`**；null = 旧记录 |

`ratio` 是派生值，两端都不存。

## 3. Tasting → `tastings`

| iOS | Android | 说明 |
|---|---|---|
| `id` | `id` | |
| `bean` | `beanId` (FK, CASCADE) | |
| `date` | `dateMillis` | |
| `dayAfterRoast` | `dayAfterRoast` | 创建时冻结；豆子还在时界面现算 |
| `flavorTagsRaw` / `score` / `notes` | 同名 | |
| `sourceRaw` | `sourceRaw` | `manual` / `brew` |
| `brewID: UUID?` | `brewId: String?` | 镜像指向的冲煮 |
| `createdAt` | `createdAtMillis` | |

`brewId` 有索引：删冲煮时按它**精确**带走镜像，而不是按日期猜。

## 4. PhaseRule → `phase_rules`

| iOS | Android | 说明 |
|---|---|---|
| `roastLevel`（唯一） | `roastLevelRaw` (**PK**) | 用烘焙度做主键，不用 UUID |
| `restMinDays` / `restMaxDays` | 同名 | |
| `peakStartDay` / `peakEndDay` / `declineStartDay` | 同名 | |
| `enabled` | `enabled` | |

主键选烘焙度是刻意的：同一档规则在三端必须是同一条，拿数据库 UUID 对齐会在第二台
设备上直接分叉。

## 5. PhaseReminder → `phase_reminders`

| iOS | Android | 说明 |
|---|---|---|
| `id` | `id` | |
| `bean` | `beanId` (FK, CASCADE) | |
| `kindRaw` | `kindRaw` | 五种：`restComplete` / `windowOpens` / `windowHalfway` / `windowEnding` / `brewPriority` |
| `scheduledAt` | `scheduledAtMillis` | 意图时间 |
| `enabled` / `lastFiredAt` | 同名 / `lastFiredAtMillis` | |

**Android 通知 ID 不进同步**：`NotificationPlanner.notificationId(beanId, kind)` 用本机
hash 生成，重排时精确覆盖。

## 6. Record → `records`

| iOS | Android | 说明 |
|---|---|---|
| `id` / `carrierRaw` | 同名 | `link` / `image` / `video` / `text` |
| `urlString` / `sourceName` | 同名 | |
| `previewPath` / `mediaPath` | 同名 | **文件名** |
| `canonicalURL` | `canonicalURL` (index) | 去重键 |
| `providerRaw` / `contentKindRaw` | 同名 | `youtube`/`bilibili`/`x`/`github`/`generic`；`video`/`socialPost`/`repository`/`webpage` |
| `platformContentID` / `linkPage` | 同名 | 内容 ID + 分 P |
| `authorName` / `summary` / `thumbnailURLString` | 同名 | |
| `metadataStatusRaw` | 同名 | `idle`/`loading`/`loaded`/`failed` |
| `repositoryStars/Forks/Issues/Language/License` | 同名 | GitHub 专用，其它平台留 0/空 |
| `title` / `note` | 同名 | |
| `tags`（多对多） | `record_tag_links` 关联表 | |
| `createdAt` / `updatedAt` / `isSample` | `createdAtMillis` / `updatedAtMillis` / `isSample` | |

**不存 embed URL**：播放地址每次由 `LinkResolver.embed(provider, contentID, page)` 现拼。

## 7. RecordTag / RecordTagLink

| iOS | Android | 说明 |
|---|---|---|
| `RecordTag.id` / `name` / `createdAt` | `record_tags.id` / `name`(unique) / `createdAtMillis` | 名称唯一 |
| 关系（SwiftData 隐式 join） | `record_tag_links(recordId, tagId)` **复合主键** | 确定性标识 `recordId:tagId` |

标签与载体解耦：一条链接可以同时是「开发」和「随记」。

## 8. Canvas → `canvases`

| iOS | Android |
|---|---|
| `id` / `name` / `note` | 同名 |
| `createdAt` / `updatedAt` / `isSample` | `createdAtMillis` / `updatedAtMillis` / `isSample` |

## 9. CanvasNode → `canvas_nodes`

| iOS | Android | 说明 |
|---|---|---|
| `id` | `id` | |
| `canvasID` / `recordID` | `canvasId` / `recordId`（FK，CASCADE） | |
| `positionX` / `positionY` | 同名 | **世界坐标**，不是屏幕坐标 |
| `width` / `height` | 同名 | 逻辑尺寸；屏幕上 = 它 × scale |
| `zIndex` / `annotation` | 同名 | 备注不写回 `Record.note` |
| `createdAt` / `updatedAt` | `createdAtMillis` / `updatedAtMillis` | |

唯一索引 `(canvasId, recordId)`：同一块画布上同一条记录只能有一个节点。

## 10. 不在同步范围内

- Embedding / 向量索引 / 缩略图临时索引：可重建的派生数据，不冒充用户数据。
- Android 的 `notification_state`：本机调度记录，跨端无意义。
- `CanvasStroke`：iOS 当前没有这个模型，Android 也不增加兼容性声明。

## 11. 迁移政策

- 当前 `version = 1`，无历史迁移。
- `BrewPhaseDatabase.MIGRATIONS` 是唯一的升级路径，**没有** `fallbackToDestructiveMigration()`。
- schema 导出到 `app/schemas/`，每个版本都要进版本库。
- 数据库打不开时应提供恢复入口，而不是悄悄换成内存库——当前版本尚未实现该恢复 UI，
  这也是 `KNOWN_LIMITATIONS.md` 里的一条。
