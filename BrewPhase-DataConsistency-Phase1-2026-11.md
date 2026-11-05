# BrewPhase Phase 1：数据一致性与可靠性修复

日期：2026-11-04 · 分支 main（工作区改动，未提交）

## 结论

修复了四类已确认的数据一致性风险：库存流水、烘焙天数、通知生命周期、
迁移/恢复出口。全量测试 **450 条 / 0 失败**（新增 21 条），本地化 **922 键**
通过。真机与真实系统通知队列未验证（见第 6 节）。

---

## 1. 问题根因与代码位置

### 1.1 库存：扣减与退还用的不是同一个数

| # | 根因 | 位置（修复前） |
|---|---|---|
| A | 创建时按 `consume(粉量)` **夹紧**扣减（袋里 5g 记 18g，只扣 5g），删除时按 `brew.coffeeG` 退还 18g | `BrewRecorder.swift` 创建分支 / `delete()` |
| B | 编辑时用 `delta = 新粉量 - 旧粉量` 再 `consume(delta)`，夹紧之后的差额语义失效 | `BrewRecorder.save(existing:)` |
| C | 模型里没有任何「这次实际扣了多少」的记录，撤销路径只能从粉量猜 | `Brew`（缺字段） |
| D | 手动盘点只改 `remainingG`，不留下「账已经重新数过」的痕迹，之后删旧记录仍会退粉 | `Bean.setRemaining` |

复现路径（修复前）：

1. 豆子总重 200g，剩余改成 5g；
2. 记一杯 18g → 剩余 0（被夹紧，扣了 5g）；
3. 删除这条冲煮 → 剩余 **18g**。进出不相等，凭空多 13g。
4. 变体：剩余 5g，记 18g 后编辑成 12g → 剩余 **6g**（0 −(12−18)）。
5. 变体：剩 200g，记 15g（余 185g），手动把剩余改成 100g，再删除那条冲煮
   → 剩余 **115g**，一个用户从没称过的数字。

### 1.2 烘焙天数：同一笔记在两处写不同的一天

| # | 根因 | 位置 |
|---|---|---|
| E | `Tasting.dayAfterRoast` 是创建时冻结的 `Int`；没有烘焙日期时写死 `?? 0` | `Tasting.swift`、`TastingEditorView.swift`、`Brew.makeTasting()` |
| F | 时间线读冻结值、豆子详情页读现算值；改了烘焙日期之后两者必然分叉 | `TastingTimelineView.swift` |
| G | 导出 CSV/JSON 与 RAG 索引也读冻结值，会写出「烘焙后第 0 天」这种具体但不成立的话 | `ExportManager`、`DocumentBuilder` |

### 1.3 通知：库删了，系统队列还在

| # | 根因 | 位置 |
|---|---|---|
| H | 示例数据整批删除只删库；级联删除不碰 `UNUserNotificationCenter`，旧提醒仍会弹 | `DemoData.removeInstalled` + `MoreView` |
| I | 提醒开关只刷新状态，不重排；关掉后已排程的通知会留到下次启动 | `MoreView.reminderBlock` |
| J | 删除冲煮不重排提醒（「预计喝完」依赖冲煮样本） | `BrewHistoryView.delete` |

（豆子删除、备份恢复两条路径原本就有清理，本次未改：`BeanDetailView.deleteBean`、
`NotificationManager.reconcileAfterRestore`。）

### 1.4 迁移与恢复：打不开时没有出口

| # | 根因 | 位置 |
|---|---|---|
| K | 没有 Schema 版本管理；实体清单在 App 与测试里各写一份（`PersistenceTests` 那份少了 `EmbeddingRecord`） | `BrewPhaseApp.swift`、各测试 `setUp` |
| L | 数据库打不开时恢复页只有一个「重试」；记录在沙盒里，用户拿不出来 | `PersistenceRecoveryView` |

---

## 2. 设计决策

### 2.1 库存是一本台账，不是一条公式

**规则（全部落在模型层，界面只读结果）：**

1. 创建：扣 `min(粉量, 剩余)`，把**实扣量**写进 `Brew.stockDeductedG`；
2. 编辑：以「实扣量」为基准算差额，`consume` 夹紧后把实扣量同步修正为
   `旧实扣量 − 实际变动`；
3. 删除：只退 `stockDeductedG`，不是粉量；
4. 手动改剩余量 = **盘点**，记 `Bean.stockCountedAt`；盘点之前创建的冲煮记录
   视为已结算，编辑/删除都不再改库存；盘点之后记的冲煮照常扣减与退还；
5. 旧数据（`stockDeductedG == nil`）按粉量退 —— 与升级前一致，不会更差。

为什么不是 `剩余 = 总重 − Σ粉量`：那会把用户每次称重、每次撒粉、每次
「其实还剩一点」全部抹掉。台账只回答一个问题：**这次撤销该退多少**。

为什么盘点要「结算」旧记录：剩余量是用户把袋子放上秤读出来的数，它已经
包含盘之前的每一杯。再退一次粉，得到的是没人称过的数字——物理上也说不通，
粉不会因为删了一条记录而回到袋子里。

### 2.2 天数是算出来的，不是存下来的

`Tasting.resolvedDayAfterRoast` 现算（烘焙日期，记录日期），界面、CSV/JSON
导出、RAG 索引统一读它。存下来的 `dayAfterRoast` 降级为「豆子已经不在时的
兜底」——正常数据里不会发生（删豆级联带走风味记录）。

没有烘焙日期时返回 `nil`（界面显示「—」），不再写 0。「Day 0」是一句具体的
话（烘焙当天），不知道就是不知道。

### 2.3 通知：先取 ID，删库成功，再清系统

级联删除不会碰通知中心，所以删除路径必须自己收尾。顺序固定为：
**记下标识符 → 数据库确认删除 → 撤系统请求 → 按新数据重排**。
先清后删会在删库失败时留下「豆子还在、提醒没了」。

### 2.4 Schema：只允许轻量迁移，恢复页留出口

`BrewPhaseSchema` 成为唯一实体清单（App 与测试共用）。约定写在文件头：
只允许新增实体、新增可选/带默认值的属性；改类型、改名、删字段属于破坏性
变更，必须先确认旧库能打开或用户能先导出原始数据库。

恢复页新增「导出数据文件」：把 `default.store` 与 `-wal` / `-shm` **复制**
到临时目录再交给系统分享面板。只复制、不移动、不删除；导出失败不改变任何
现状。

备份格式（`schemaVersion` 2）只新增两个可选键（`bean.stockCountedAt`、
`brew.stockDeductedG`）。旧备份解出来是 nil，语义正好等于「没盘点过 /
旧记录」，因此**没有提升版本号**；旧版本读新备份会忽略未知键。

---

## 3. 修改文件

| 文件 | 改动 |
|---|---|
| `Models/Bean.swift` | 新增 `stockCountedAt`、`deduct(_:)`、`refund(_:)`；`setRemaining` 记盘点时刻 |
| `Models/Brew.swift` | 新增 `stockDeductedG`、`appliedStockDeductedG`、`isSettledForStock(in:)` |
| `Models/Tasting.swift` | 新增 `resolvedDayAfterRoast`，`dayText` 改读它；存储字段降级为兜底 |
| `Services/BrewRecorder.swift` | 创建写实扣量；编辑按实扣量求差；删除只退实扣量、已结算不退；`delete` 返回豆子 |
| `Services/DemoData.swift` | 新增 `sampleBeans(context:)`（删除前取 ID） |
| `Services/NotificationManager.swift` | `unschedule(identifiers:)` 补写调用顺序约定 |
| `Services/StoreRecovery.swift`（新） | 复制 `.store`/`-wal`/`-shm`；目录已存在时拒绝覆盖 |
| `Services/Backup/BackupFormat.swift` | 备份行新增两个可选字段 |
| `Services/Backup/BackupManager.swift` | 快照/校验带上新字段 |
| `Services/Backup/BackupRestorer.swift` | 恢复写回新字段 |
| `Services/ExportDTO.swift` / `ExportManager.swift` | `TastingDTO.dayAfterRoast` 改为可选、取现算值；CSV 空值留空 |
| `App/BrewPhaseSchema.swift`（新） | 唯一实体清单 + 迁移约定 |
| `App/BrewPhaseApp.swift` | 改用 `BrewPhaseSchema.schema` |
| `App/PersistenceRecoveryView.swift` | 新增「导出数据文件」与分享面板；版面改为可滚动 |
| `Features/Brew/BrewEditorView.swift` | 「保存后剩余」用实扣量计算；已结算时显示不变量说明 |
| `Features/Brews/BrewHistoryView.swift` | 删除文案按是否已结算分叉；删除后重排提醒 |
| `Features/Bean/TastingTimelineView.swift` | 天数/阶段/间隔改出现算值，缺烘焙日期时中性显示 |
| `Features/Bean/TastingEditorView.swift` | 天数改为可选，保存只写兜底快照 |
| `Features/Bean/BeanDetailView.swift` | 盘点说明文案；失败回滚补 `stockCountedAt` |
| `Features/Bean/BeanEditorView.swift` | 改剩余量即盘点；`BeanOriginalValues` 带上该字段 |
| `Features/Settings/MoreView.swift` | 示例数据安装/移除后重排与清理；提醒开关后重排 |
| `RAG/Indexing/DocumentBuilder.swift` | 风味资料里的天数改现算；无烘焙日期用另一句文案 |
| `Tools/Localization/strings.py` + 两个 `.strings` | 7 条新文案；922 键 |

未改动：AI / RAG 算法、Core ML、评分与优先级引擎、备份的恢复事务顺序。

---

## 4. 新增测试（`BrewPhaseTests/DataConsistencyTests.swift`，21 条）

| 测试 | 钉住的事实 |
|---|---|
| `testAShortBagDeductsOnlyWhatItHadAndDeleteReturnsExactlyThat` | 5g 袋记 18g：扣 5、删退 5 |
| `testEditingTheDoseOnAShortBagNeverInventsStock` | 夹紧状态下改粉量不会长出库存 |
| `testCreateEditDeleteRoundTripReturnsToTheStartingStock` | 创建→编辑→删除回到起点 |
| `testALegacyBrewWithoutARecordedDeductionFallsBackToItsDose` | 旧记录按粉量退（不回退行为） |
| `testEditingALegacyBrewAdjustsStockByItsOriginalDose` | 旧记录编辑按**改前粉量**算差额（先 apply 再读会永远差 0） |
| `testDeletingABrewRecordedBeforeAManualCountLeavesStockAlone` | 盘点后删旧记录库存不动，记录照删 |
| `testABrewRecordedAfterAManualCountStillDeductsAndReturns` | 盘点后新记录照常扣/退 |
| `testEditingASettledBrewChangesTheRecordButNotTheStock` | 已结算记录：字段改、库存不动、实扣量归零 |
| `testDeletingASettledBrewDoesNotReactivateAFinishedBag` | 已结算 + 已喝完：删记录不复活 |
| `testTastingDayFollowsTheBeanAfterTheRoastDateIsCorrected` | 改烘焙日期，天数跟着改 |
| `testTastingWithoutARoastDateHasNoDayAtAll` | 无烘焙日期 → nil / 「—」，不是 Day 0 |
| `testBrewAndItsMirrorTastingAgreeOnTheDay` | 冲煮与其镜像风味天数一致 |
| `testRemovingSampleDataClearsEveryPendingReminderForIt` | 删示例数据清掉全部待送达 |
| `testRemovingSampleDataLeavesRealBeanRemindersAlone` | 真实豆的提醒不被带走 |
| `testTurningAReminderKindOffClearsItsPendingRequests` | 关开关后系统里那条被撤 |
| `testBackupRoundTripKeepsTheStockLedgerAndTheCount` | 备份→恢复：实扣量/盘点时刻保留，行为一致 |
| `testStoreArchiveCopiesTheStoreAndItsSidecars` | 导出三个文件、原件不动 |
| `testStoreArchiveWithoutAStoreThrows` | 没有库时明确失败 |
| `testStoreArchiveRefusesToOverwriteAnExistingExport` | 同秒导出两次不覆盖旧副本 |
| `testTheSharedSchemaHoldsEveryPersistedEntity` | 共享 Schema 含全部 6 个实体 |
| `testTheStockLedgerSurvivesACloseAndReopen` | 落盘再打开，新字段与 nil 兜底都正确 |

运行结果（iPhone 16 Pro 模拟器 `C7C7F583-…`）：

```
Executed 450 tests, with 0 failures (0 unexpected)
** TEST SUCCEEDED **
Localisation check passed — 922 keys, both tables complete, placeholder counts match.
```

### 额外的真实迁移检查（模拟器，非真机）

设备上留有一份**旧 schema** 的真库（无 `ZSTOCKDEDUCTEDG` / `ZSTOCKCOUNTEDAT`），
直接覆盖安装新构建并启动：

```
启动前 PRAGMA table_info(ZBREW) → 无 ZSTOCKDEDUCTEDG
启动前 PRAGMA table_info(ZBEAN) → 无 ZSTOCKCOUNTEDAT
启动后 ZBREW → 14|ZSTOCKDEDUCTEDG|FLOAT
启动后 ZBEAN → 10|ZSTOCKCOUNTEDAT|TIMESTAMP
```

截图确认进入的是正常豆仓页（空库），不是「无法打开本地数据」恢复页。
这证明可选属性的轻量迁移在这份真实旧库上成功，但**没有**证明更复杂的
迁移（改类型、改名）可用。

### 回归测试确实会红（红 → 绿）

「旧记录编辑按改前粉量算差额」这条测试写完后，把 `previousApplied` 的读取
顺序**临时改回**错误版本（先 `apply` 再读），单跑该测试：

```
XCTAssertEqualWithAccuracy failed: ("185.0") is not equal to ("182.0")
Test Case ... failed
```

恢复正确顺序后转绿。它钉住的是本次实现里真实踩到的一次顺序错误，不是
写完就算的装饰。

---

## 5. 仍然存在的风险

1. **「盘点」是一个新概念**，靠一句说明文案传达。用户如果把剩余量当成
   「随手改个数」而不是「称重」，之后删旧记录时库存不动会显得反直觉。
   目前没有「撤销盘点 / 清除盘点标记」的入口。
2. **旧记录（无实扣量）仍可能虚增库存**：袋里不够时记的那一杯，删除时按
   粉量退。这是无法还原的历史，只能保证不比升级前更差。
3. **实扣量是写入时算的**：如果之后有人把 `weightG` 调小到低于剩余量，
   再删除记录，退款会被总容量夹住，实际退得比记录的少。
4. **盘点用设备时钟比较**（`createdAt < stockCountedAt`）。用户手动改系统
   时间、或跨时区且时钟回拨时，边界可能判错。
5. **备份格式没有升版本**：新库导出给旧版本 App 时，旧版本会忽略这两个键，
   恢复后回到「无实扣量 / 无盘点」的旧行为。这是可接受的降级，但没有在
   旧版本二进制上实测过。
6. **示例数据安装后立即重排提醒**：会请求通知权限（与首次添加豆子同一路径），
   如果用户此时拒绝，示例豆将没有提醒，直到下次启动且授权。
7. **恢复页的导出是原始 SQLite 文件**，App 内没有「重新导入原始库」的入口；
   拿回来需要重装后走 `.brewphasebackup`，或人工处理。
8. **UI 没有自动化测试**（工程无 UI Test target），删除确认文案的分叉、
   「保存后剩余」的提示都只经过编译与人工阅读。

---

## 6. 尚未验证的真实设备行为

1. 真机上的 SwiftData 迁移：只在模拟器的一份旧库上验证过，没有在真机、
   大库（数千条）或低存储空间下验证耗时与失败路径。
2. 真实 `UNUserNotificationCenter` 队列：所有通知测试都注入 `FakeScheduler`。
   「删除示例数据后系统里真的没有待送达请求」只在假替身上成立；真机上
   `removePendingNotificationRequests` 的时序没有实测（模拟器点不到删除确认框）。
3. 分享面板导出数据库文件：`UIActivityViewController` 在真机「存储到文件」
   的落盘结果、以及大库（几十 MB）导出的耗时没有实测。
4. 英文界面：新增 7 条文案已进 `en.lproj`，但没有逐屏目测；长句
   （「这次冲煮早于你最后一次盘点…」）在窄屏上的换行未验证。
5. 真实用户行为：没有做可用性测试，无法确认「盘点」的语义能被正确理解。
