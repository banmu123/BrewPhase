# BrewPhase V2 第一批 —— 数据安全 / Quick Log / Bean Detail 报告

本批只做三件事：**本地数据安全与保存可靠性**、**Quick Brew Log 进一步简化**、
**豆子详情页重新突出「当前阶段 → 库存 → 最近一杯 → 下一杯怎么做」**。

不变量自始至终没动：`PhaseEngine`、`PriorityEngine`、`InsightFactory`、`BrewRecorder`
的算法、`BrewPrefill`/`BrewDelta`/`PersonalBaseline`、`BrewDiagnosticEngine`、
`AdjustmentPlanner`、`BrewDiagnosisService`、`BrewObservation` 全部保持原样；
没有新增 SwiftData Model，没有新字段，没有迁移；没有新 AI 能力、服务器、同步、社区。

---

## 1. 修改了哪些文件

App（21 个）：

| 文件 | 类型 |
| --- | --- |
| `BrewPhase/App/BrewPhaseApp.swift` | 改 |
| `BrewPhase/App/PersistenceRecoveryView.swift` | **新增** |
| `BrewPhase/Features/Bean/BeanDetailView.swift` | 改 |
| `BrewPhase/Features/Bean/BeanEditorView.swift` | 改 |
| `BrewPhase/Features/Bean/TastingEditorView.swift` | 改 |
| `BrewPhase/Features/Bean/PhotoFieldView.swift` | 改（注释） |
| `BrewPhase/Features/Brew/QuickBrewLogView.swift` | 改 |
| `BrewPhase/Features/Brew/BrewDiagnosticCard.swift` | 改 |
| `BrewPhase/Features/Brews/BrewHistoryView.swift` | 改 |
| `BrewPhase/Features/Settings/PhaseRulesView.swift` | 改 |
| `BrewPhase/Models/Bean.swift` | 改 |
| `BrewPhase/Services/BrewRecorder.swift` | 改 |
| `BrewPhase/Services/ImageStore.swift` | 改 |
| `BrewPhase/Services/NotificationManager.swift` | 改 |
| `BrewPhase/Services/PhaseRuleBook.swift` | 改 |
| `BrewPhase/Services/DemoData.swift` | 改 |
| `BrewPhase/Services/DebugLaunch.swift` | 改 |
| `BrewPhase/Shared/Theme.swift` | 改（+1 个字号） |
| `BrewPhase/en.lproj/Localizable.strings` | 重新生成 |
| `BrewPhase/zh-Hans.lproj/Localizable.strings` | 重新生成 |
| `Tools/Localization/strings.py` | 改（+18 键） |

测试与工具：

| 文件 | 类型 |
| --- | --- |
| `BrewPhaseTests/PersistenceTests.swift` | 改（+4，替换 1） |
| `BrewPhaseTests/BrewLoopTests.swift` | 改（`try` + 1 个新测试） |
| `Tools/run.sh` | 改（新调试参数 + 修了一个空参数数组的 bug） |

---

## 2. 每个文件改了什么

### BrewPhaseApp.swift — 持久化失败不再降级

- 删掉了「容器打不开就退到 `isStoredInMemoryOnly: true`」的兜底。那是所有选项里
  最坏的一个：用户在一个「关掉 App 就什么都没了」的会话里照常记咖啡，界面上没有
  任何东西提示他。
- 新增 `PersistenceState`（`.ready(ModelContainer)` / `.failed`），App 顶层根据它
  决定渲染 `RootView` 还是恢复页。
- 容器打开抽成 `openStore()`：失败时原始错误只进 `AppLog.lifecycle`，不摆给用户；
  **不触碰任何数据库文件**——打不开的东西绝不靠删除「修复」。
- `retry()` 就是恢复页上的「重新尝试」：重建持久化容器，成功才切回正常界面。
- `bootstrap()`（种子规则 + 演示数据）只在容器真正打开后执行。

### PersistenceRecoveryView.swift（新）— 恢复页

只有三件事：说清楚发生了什么（「无法打开本地数据 / BrewPhase 暂时无法访问已有记录。
为了避免数据丢失，当前不会保存新的数据。」）、一个「重新尝试」、一条克制的建议
（「如果问题持续存在，请先确认设备存储空间正常。」）。没有任何设置项，也没有任何
可以写数据的入口。

### Bean.swift — 生命周期动作只做它自己

- `setRemaining(_:)`：手改库存的三条规则收进模型（负数按 0；剩余 > 总量时抬高总量；
  喝完的袋子改出正数剩余量回到在喝）。逻辑从 `StockAdjustView` 搬出来，可以单测。
- `markFinished()`：**只改状态**。这里原来是 `status = .finished` 外加
  `remainingG = 0`——顺手把库存清零，导致「恢复到在喝」永远恢复不出任何东西。
- `restoreToActive()`：同样只改状态，不凭空恢复库存、不碰历史记录。

### BrewRecorder.swift — 失败必须彻底失败

- `save()` 的 catch：`rollback()` + **手动还原**。实测发现 SwiftData 的 `rollback()`
  只撤得掉插入与删除，**撤不回既有对象的属性改动**（测试里钉住了这条），所以：
  扣掉的粉 `bean.remainingG` 写回原值；编辑场景用 `apply(previousDraft, to:)` 把
  上一版逐字段写回去，并让镜像风味记录跟着回到旧值。不这么做的话，用户重试会扣两次
  粉、插两条记录。
- 新增 `apply(_:to:)`：新建与编辑共用的字段赋值。「写回上一版」复用它，字段清单
  只有一处，不会漏项。
- `delete()` 改成 `throws`：失败时回滚删除、**把还回去的粉与改掉的状态写回原值**
  再抛出。调用方必须把失败说出来。
- `Failure` 增加 `message`，让消息只有一处口径。

### ImageStore.swift — 删掉危险的 `replace`

- 删除 `replace(_:previous:)`。它「写完新的立刻删旧的」发生在数据库落库之前，
  正是本批要消灭的反模式；留着它就是一个随时会被再次误用的陷阱。
- `delete()` 与 `clearOrphans()` 的删除改为：文件不存在跳过、真失败记日志。
  「空间没释放」不再是查无对证的事。

### BeanEditorView.swift — 三段式保存顺序

`save()` 重写为 **1) 写新图片 → 2) 落库 → 3) 删旧图片**：

- 图片写失败：直接说，什么都不改。
- 落库失败：删掉刚写的新文件、`rollback()`、再按 `BeanOriginalValues` 把豆子
  **逐字段写回打开编辑器时的样子**（属性改动不回滚，实测）——旧图片、旧字段、
  用户填的表单全都在，重试即可。
- 只有落库确认成功，被替换/被移除的旧文件才删。
- 新增 `BeanOriginalValues` 快照（打开编辑器那一刻的值）。
- 中途被杀进程最坏留下一个孤儿文件，「清理无用的图片」会收走它；而**记录永远
  不会指向一个不存在的文件**。

### BeanDetailView.swift — 十层信息结构 + 行为修正

- 顺序重排（见第 5 节）。
- 新增「最近一杯」卡：`2:08 · 18g · 300g · 92°C` + 评分星 + 结论一行 + 「下一杯：
  研磨度：细一档」+ `[再记一杯]` + 「展开依据」。完整诊断留在同一张卡的折叠里，
  功能一个没少，只是不再把整张诊断卡铺在页面前半部分。
- 库存之后新增主要行动 `[记一杯]`（还有库存时才显示）。
- 菜单跟状态说话：`status == .active` → 「标记为已喝完」；`.finished` → 「恢复到在喝」。
  两个动作失败都不退出、不改状态，弹「没能保存」。
- 删除路径全部重排为 **先让 SwiftData 删成功、再动图片**；删除失败什么都不碰、
  不 dismiss、告诉用户。删豆子收尾改用 `NotificationManager.unschedule(identifiers:)`
  （库里提醒行已随级联删除走了，系统侧单独清）。
- `StockAdjustView`：剩余 > 总量时提前明确说明（「剩余量 270g / 当前总量 250g /
  保存后总量会调整为 270g。」）；保存失败逐字段写回（remaining/weight/status）
  并留在页面上。

### QuickBrewLogView.swift — 首屏只看常用的

- 风味标签默认折叠为一行 `[添加风味]`，点开才是完整 `FlavorTagEditor`（一组没删、
  一词没少），再点收起；已选中的词在折叠状态下也看得见。
- 「更多参数」摘要行升级为 `18g · 1:16.7 · 92°C · 2:08`（粉量 · 粉水比 · 水温 · 时间）。
- 结果页 `BrewDiagnosticCard(emphasizesSuggestion: true)`——「下一杯建议」成为
  结果页最醒目的一块（见第 4 节）。
- 预填逻辑（`BrewPrefillBuilder`/`BrewPrefill`/`BrewDelta`）一行未动；
  「沿用这包豆上一次的参数 + 这次改了」原样保留。

### BrewDiagnosticCard.swift — 阶段性的视觉权重

新增 `emphasizesSuggestion`：为真时「下一杯建议」用抬高的卡片 + 23pt 标题行；
为假（豆子页、问一问）两段保持等重。只加了一个字号，没有评分大卡、图表或动画。

### TastingEditorView.swift / BrewHistoryView.swift / PhaseRulesView.swift

- 三处保存/删除都从 `try?` 改为 do/catch：失败 → 回滚 + 写回属性 + 明确提示，
  不 dismiss、不静默。BrewHistoryView 的删除改走 `BrewRecorder.delete`（唯一写入路径）。

### NotificationManager.swift — 派生数据的失败口径

5 处 `try? context.save()` 换成 `commit(_:note:)`：失败记日志并回滚。提醒行是派生
数据、每次启动整体重排，一次失败会在下次启动自愈——但不再无声消失。新增
`unschedule(identifiers:)` 给删豆子收尾用。

### PhaseRuleBook.swift / DemoData.swift / run.sh

- `resetToDefaults` 改为 `throws`；`seedIfNeeded` 保存失败时不写「已播种」标记，
  下次启动重试。
- DemoData 的保存失败记日志 + 回滚；演示库新增第 7 包**已喝完**的豆子（Rwanda
  Nyungwe，剩 40g）：首页「已喝完」分组与「恢复到在喝」这条路此前在演示里没有例子。
- `run.sh`：新增 `--bean` / `--bean-action` / `--quick-expand` / `--stock-overshoot`
  四个只读调试参数；修掉 `set -u` 下空参数数组会报 `unbound variable` 的 bug。

---

## 3. 修复了哪些实际问题

1. **数据库打不开时假装正常运行**（内存兜底）——现在进恢复页，拒绝一切写入。
2. **`try? context.save()` 静默吞错**（App 代码共 17 处）——全部改为真实错误处理：
   保存失败保留编辑状态、明确反馈、不 dismiss、不执行依赖成功的后续动作。
3. **保存失败后重试会重复扣粉 / 插重复记录**（`BrewRecorder.save` 失败残留脏状态）。
4. **图片与数据库互相打架**：编辑图片时「先删旧图、后落库」，落库一失败记录指向
   已删除的文件——现在「写新 → 落库 → 删旧」，任何一步失败两边都一致。
5. **删除豆子失败却把图片删了、还 dismiss**——现在先删库成功再删文件，失败不退出。
6. **标记喝完顺手清库存，导致「恢复到在喝」是死路**——现在只改状态；恢复时保留
   用户当前的 `remainingG`，不动历史。
7. **库存调整静默抬高总克数**——现在保存前明确写出「保存后总量会调整为 X g」。
8. **`rollback()` 的语义陷阱**（本轮实测发现）：它只撤插入/删除、不撤属性改动。
   所有失败路径都据此改成「显式写回」，并用测试钉住这条前提。

---

## 4. Quick Log 最终交互流程

**首屏（默认，30 秒那条路）**

```
哪包豆      [当前豆子 ▾]                      ← 默认已选好
沿用这包豆上一次的参数                          ← BrewPrefill，一行依据
10月6日 · V60 · 18g / 300g · 92°C · 2:08
怎么冲的    [V60][爱乐压][聪明杯][法压壶]…     ← 点选即改，参数跟着预填
这杯怎么样  ★★★★★ / 酸 甜 苦 醇厚 余韵        ← 直接可点
风味标签    [添加风味]                          ← 默认折叠
一句话总结  [____________]
更多参数    18g · 1:16 · 92°C · 2:08          ← 默认折叠，摘要行常显
[ 记下这一杯 ]                                 （底部固定，显示保存后剩余）
```

- 「添加风味」展开完整标签库，再点「收起风味」折回；已选标签折叠时也可见。
- 「更多参数」展开：粉量 / 水量 / 水温 / 时间 / 研磨度 / 磨豆机 / 日期。
- 用户改过参数后继续显示「这次改了：水温 92°C → 91°C」。

**保存后（闭环，不直接 dismiss）**

```
✓ 记下了  · 3 星 · Ethiopia Guji · V60 · 18g / 300g · 92°C · 2:08
本次表现   可能萃取不足（证据较足）→ 依据 …
下一杯建议「研磨度：细一档」← 抬高的卡片 + 23pt 标题，结果页最醒目
[再记一杯] [完成]
```

---

## 5. Bean Detail 最终信息顺序

1. **Hero**：图片 / 豆名 / 烘焙商 / 烘焙度 / 产区 / 处理法 / 烘焙日期
2. **PhaseCard**（紧接 Hero）：Day 16 · 黄金窗口 · 现在喝 · 阶段轨道 · 排气期说明
3. **库存**（紧接 PhaseCard）：86g / 200g · 进度条 · 还能冲约 5 次 · 预计还能喝约 17 天 · [调整]
4. **最近一杯**（有记录时）：`2:08 · 18g · 300g · 92°C` + ★★★ + 「可能萃取不足」+
   「下一杯：研磨度：细一档」+ [再记一杯] + [展开依据]（完整诊断折叠）
5. **主要行动**（还有库存时）：整宽 `[记一杯]`
6. **冲煮记录**：最近 3 条 + 查看全部；空态含 [记一杯] / [完整表单]
7. **风味变化**：`TastingTimelineView`
8. **预计风味窗口**（实验卡，可在设置关闭）
9. **知识**：`BeanKnowledgeSection`
10. **问一问**：就这包豆子提问 → **备注**

前五层回答：现在怎么样 → 还剩多少 → 上一杯怎么样 → 下一杯怎么改 → 继续冲。

---

## 6. Persistence Recovery 的行为

- 正常启动：持久化容器打开成功 → 正常界面；失败 → **恢复页，不降级、不写任何数据**。
- 恢复页只有：「无法打开本地数据」+ 两行解释 +「重新尝试」+ 一行建议。
- 「重新尝试」= 重建持久化容器；成功即切回正常界面，失败则留在原地（这本身就是反馈）。
- 底层错误只进日志（`AppLog.lifecycle`），界面不出现任何数据库术语。
- **不删除、不重命名、不触碰任何数据库文件**。
- 恢复状态下 UI 没有任何创建/修改入口——写不进去的东西，不给按的地方。

---

## 7. 有没有新增数据库迁移

**没有。** schema 一字未动（沿用 `Bean/Brew/Tasting/PhaseReminder/PhaseRule/EmbeddingRecord`），
没有新 Model、没有新字段、没有 `VersionedSchema` 变更。已有用户数据不需要任何迁移动作。

---

## 8. 测试结果

```
xcodebuild test -project BrewPhase.xcodeproj -scheme BrewPhase \
  -destination "platform=iOS Simulator,id=810C6408-…" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO

Executed 328 tests, with 0 failures (0 unexpected) in 50.5s
```

本轮新增/重写的测试（`PersistenceTests` + `BrewLoopTests`）：

- `testRollbackDiscardsInsertionsButNotPropertyChanges` —— 把本轮发现钉成前提：
  `rollback()` 撤插入、**不撤属性改动**。
- `testEditBeanImageSequenceKeepsTheOldFileUntilTheStoreCommits` —— 落库前旧图不能删。
- `testImageEditFailureCleanupLeavesTheRecordPointingAtARealFile` —— 失败清理后
  记录必须仍指向存在的文件。
- `testMarkingFinishedTouchesNothingButTheStatus` —— 标记喝完不动库存/历史；
  恢复只恢复状态并保留 `remainingG`。
- `testSetRemainingClampsWidensAndReactivates` —— 手改库存三条规则。
- `testReapplyingTheOriginalDraftRestoresEveryField` —— 失败写回的往返无损。
- `testBrewRecorder.delete` 改为 `try`（签名变化）；另修 `testAnEditedRule…` 的 `try`。

---

## 9. 构建结果

干净构建（清空 `SYMROOT`/`OBJROOT` 全量重编）：

```
** BUILD SUCCEEDED **
项目代码 warning：0   （唯一一条 warning 是 Xcode 自己的 AppIntents metadata 噪音）
```

`python3 Tools/Localization/generate.py && check.py`：

```
Localisation check passed — 831 keys, both tables complete, placeholder counts match.
```

（829 → 831：新增恢复页等文案共 18 键，删除 1 个不再使用的键。）

---

## 10. 仍然存在的已知问题

1. **工具栏菜单弹层截不到图**。`标记为已喝完 / 恢复到在喝` 的菜单项本身是系统
   popover，`simctl` 既不能点也不能展开；验收走的是「动作发生后的页面状态」
   （J1/J2 两张截图的对比：状态词切换、库存保留 40g、行动按钮回来）+ 模型层单测。
2. **恢复页的「重新尝试」在健康设备上无法造出真实失败**。模拟器磁盘是好的，
   真正的容器打开失败无法注入；该路径只验证了「失败进入恢复页 → 界面正确」，
   「重试成功切回」由代码结构保证（与首次打开共用 `openStore()`）。
3. **恢复在喝但 `remainingG == 0` 的袋子仍归入「已喝完」**。`isFinished` 的语义是
   `status == .finished || remainingG <= 0`，袋里确实没有咖啡时不假装还有。这是
   保留的产品语义，不是 bug——但它意味着「恢复到在喝」只对还剩豆的袋子有可见效果。
4. **提醒行的落库失败只进日志**（`NotificationManager.commit`）。提醒是每次启动
   整体重排的派生数据，会在下次启动自愈；这一层没有 UI 反馈是有意为之。
5. **图片提交中途被系统杀进程**最坏留下一个孤儿文件；由「更多 → 清理无用的图片」
   收走。记录本身在任何时刻都不会指向不存在的文件。
6. **RAG 向量索引的保存路径未动**（`SwiftDataVectorIndex` 本就是 `throws` 传播），
   属于本轮范围之外。
7. **风味标签 / 更多参数在真机上仍需点开**——默认折叠是这一批的明确要求；
   `-BrewPhaseQuickLogExpand` 只是给截图用的调试通道。

---

## 验收场景截图

`/tmp/bp-scenes/`（每场景一次干净安装 + 启动，日志在旁，另见 `Tools/run.sh` 参数表）：

A 空豆仓 · B 有豆首页 · C Quick Log 首屏 · D 展开更多参数 · E 展开风味标签 ·
F 保存后结果页 · G Bean Detail（含最近一杯诊断）· H Bean Detail 无 brew ·
J1 已喝完 / J2 恢复到在喝 · K1/K2 调整库存（含超量提示）· L 持久化失败恢复页。
