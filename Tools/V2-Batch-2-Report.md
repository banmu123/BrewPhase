# BrewPhase V2 第二批 —— 闭环验证 / Insights 与 Ask 分工 / 设置信息架构 报告

本批只做产品层：**记录 → 理解 → 建议 → 验证** 闭环的最后一环（上一杯建议 →
下一杯验证），以及 Insights / Ask / 设置页的职责与信息架构。零新模型、零迁移、
零新 AI 能力；`PhaseEngine` / `PriorityEngine` / `RecommendationEngine` /
`BrewDiagnosisService` / `BrewRecorder` 的算法与数据结构一字未动。

---

## 1. 修改文件清单

App（13 个）：

| 文件 | 类型 |
| --- | --- |
| `BrewPhase/RAG/Diagnostic/SuggestionFollowUp.swift` | **新增** |
| `BrewPhase/Features/Brew/QuickBrewLogView.swift` | 改（+上一杯卡 +上次建议卡） |
| `BrewPhase/Models/Brew.swift` | 改（+`tasteLine`） |
| `BrewPhase/Models/Tasting.swift` | 改（manual 文案→「手动记录」） |
| `BrewPhase/Features/Bean/TastingTimelineView.swift` | 改（来源标识） |
| `BrewPhase/Features/Insights/InsightsView.swift` | 重排（四层结构） |
| `BrewPhase/Features/Ask/AskView.swift` | 改（统一入口化） |
| `BrewPhase/Features/Settings/AskSettingsSection.swift` | 重写（+高级设置屏） |
| `BrewPhase/Features/Settings/MoreView.swift` | 改（四组信息架构） |
| `BrewPhase/Features/Settings/LanguageSection.swift` | 改（+showsHeader 参数） |
| `BrewPhase/Features/Settings/PhaseRulesView.swift` | 改（普通/高级两层） |
| `BrewPhase/Features/Bean/FlavorWindowCard.swift` | 改（视觉降级） |
| `BrewPhase/Features/Home/HomeView.swift` | 改（工具栏收敛） |
| `BrewPhase/Services/DebugLaunch.swift` / `BrewPhaseApp.swift` | 改（+2 个调试屏） |
| `BrewPhase/Services/DemoData.swift` | 改（+1 条手动风味记录） |
| `BrewPhase/en.lproj` / `zh-Hans.lproj/Localizable.strings` | 重新生成（852 键） |
| `Tools/Localization/strings.py` | 改（+52 新键，−32 死键） |
| `BrewPhaseTests/BrewLoopTests.swift` | 改（+2 个测试） |
| `Tools/V2-Batch-2-Report.md` | **新增**（本文件） |

## 2. 每个文件改了什么

### SuggestionFollowUp.swift（新）—— 闭环的「验证」一环

纯值类型，比较「上一杯 → 这一杯」：

* `suggestionHeadline`：上一杯当时真正给过的建议（由调用方在**插入新记录之前**
  从 `BrewDiagnosisService` 取得）；
* `changes`：时间 / 酸度 / 甜度 / 苦度 / 醇厚 / 余韵中**真的变了**的项，外加
  建议点名的那个参数（水温 / 粉量 / 研磨度）的前后值；
* `followedDirection`：建议的参数这次有没有朝建议的方向动——只对水温 / 粉量 /
  时间下结论（研磨度是自由文本，比不了方向，诚实返回 nil）；
* `scoreDelta` / `scoreText`：两杯都有评分时才有「这次评分比上一杯高 / 低」。

措辞自律写进了类型注释：只允许「与上次相比」「变化与建议方向一致」这类比较级，
永远不出现「证明」「已验证」「AI 确认」。

### QuickBrewLogView.swift —— 两张新卡

* **上一杯卡（表单）**：prefill 卡下方一行摘要——`上一杯 · 10月6日 / 2:08 ★★ /
  酸 5 · 甜 2 / 本次将沿用上次参数 / [查看变化]`。「查看变化」展开上次 → 本次的
  参数与味觉对照表（变了用 roast 色标出，没变安静显示），默认折叠。
* **上次建议卡（结果页）**：紧跟「记下了」之后——`上次建议 / 研磨度：细一档 /
  这次：时间 2:08 → 2:28 · 酸度 5 → 4 · 甜度 2 → 3 / 调整方向与上次建议一致。
  这次评分比上一杯高。`上一杯没给过建议时整卡不出现。
* 调试入口 `--quick-demo` 改为记一杯「照建议调整过」的咖啡，让闭环可截图。

### Brew.swift —— `tasteLine`

「酸 4 · 甜 3 · 苦 2」的展示口径收进模型一处；最近一杯摘要、Quick Log 的
上一杯卡共用。

### TastingTimelineView.swift + Tasting.swift —— 来源可见性

每个节点显示轻量来源标签：`.brew → 冲煮记录`、`.manual → 手动记录`
（`TastingSource.label` 一处定义；manual 文案由「风味记录」改为「手动记录」）。
micro 字号 + inkFaint，在场不抢焦点。演示数据补了一条手动记录，两种来源都有例子。

### InsightsView.swift —— 四层重构

1. **Today**：今天喝哪包（原「今日建议」，PriorityEngine 结论 + 天气微调）→
   手冲还是意式；
2. **Recent Brew**：新增「最近一杯」摘要卡（参数 + 评分 + 味觉 + 与上一杯的差，
   复用 `SuggestionFollowUp`）+ 「和平时比」偏离卡（原「历史分析」）；
3. **Personal Pattern**：我的最佳参数（不变）；
4. **Action**：新增「下一步」——只给一条建议（直接取诊断链的
   `AdjustmentSuggestion`，不新造）。
* 移除「相似冲煮」搜索框：它是第二个提问入口，与 Ask 职责重叠；检索能力
  保留在 `RecommendationEngine.similarHistory`（测试仍覆盖），入口归 Ask。
* 删除技术性脚注（语义模型 / 词法匹配 / 引擎状态），只留一句「建议与分析只
  来自你记录里的数字和既定规则」。

### AskView.swift —— 统一入口

* 顶部标题改为「问问你的咖啡」（从豆子页进入时仍是「正在问「X」」）；
* 删除「本次回答引擎：X」「已降级」「耗 N 秒」技术行——engine/provider 字样
  不再出现在普通 UI；引用列表（你的记录 / 知识库）保留；
* 推荐问题收敛为 4 条：今天喝哪包？/ 下一杯怎么调？/ 最近哪杯最好？/
  我最近的参数有什么变化？（豆子页进入时第一条换成「「X」现在是什么阶段？」）。

### AskSettingsSection.swift —— 两层暴露

* 第一层：洞察 / 问一问两个入口 + 「开启本地智能」总开关 + 一句
  「BrewPhase 会结合你的咖啡记录和本地知识进行分析，数据不会上传到服务器。」；
* 新增 `AskAdvancedSettingsView`（「高级设置」）：向量模型 / 每次取条数 /
  重建索引全部移到这里，附「这些选项影响问一问与洞察的检索方式；不改也完全
  能用。」配置能力零删减。

### MoreView.swift —— 四组信息架构

`咖啡`（默认冲煮参数 / 阶段规则 / 提醒）→ `本地智能`（入口 + 开关 + 高级设置
入口）→ `数据`（导出 / 图片清理）→ `应用`（语言 / 实验功能 / 关于）。
组头是小号 tracked 标题，组内块用加粗小标题区分层级；Tab 名保持「更多」。
「风味窗口规则」入口更名「阶段规则」，页面标题同步。

### PhaseRulesView.swift —— 普通 / 高级两层

* 普通模式：每个烘焙度一张三行卡——`养豆期 3–7 天 / 黄金风味期 7–28 天 /
  风味衰减 28 天后`（数字直接来自既有 `PhaseRuleData`，只换说法）；
* 「高级阶段规则」默认折叠，展开才是原来的五个 stepper（含各烘焙度阶段轨道
  预览），上方一句「修改这些参数会影响 BrewPhase 对咖啡阶段的判断。」；
* `PhaseEngine` 零改动。

### FlavorWindowCard.swift —— 视觉降级

标题从 17pt 大字降为 15pt 中字、「预计最佳 Day N」从 24pt 降为 15pt、颜色从
ink 降为 inkSoft；「实验预测」成为常驻小标签（原「实验」chip 移除）。曲线图保留。
它不在任何页面顶部（豆子页排在冲煮记录之后），也不参与任何核心提醒。

### HomeView.swift —— 工具栏收敛

右侧只剩「+」；问一问 / 洞察图标移除（入口：更多页、豆子页、Today 卡路径）。
首页第一眼只回答一件事：今天冲哪包。

### DebugLaunch / DemoData

新增 `--screen askAdvanced`、`--screen flavorPrediction` 两个调试屏；
演示库新增一条手动风味记录（时间线两种来源都有例子）。

---

## 3. UX 信息架构变化

* **Insights = 主动汇报**（不问也说），**Ask = 被动问答**（问了才答）——
  两者不再各自养一个输入框；Insights 的相似检索入口让位给 Ask。
* **设置**：技术调参（向量模型 / 条数 / 重建索引）从第一层下沉到
  「高级设置」；普通用户看到的设置页只有「咖啡 / 本地智能 / 数据 / 应用」
  四组、零术语。
* **首页**：工具栏从 4 个动作收敛为 2 个（记一杯 / +），第一眼 = 今天冲哪包。
* **阶段规则**：从五个数学参数变成三段生命周期；高级参数保留但折叠。
* **实验预测**：从与阶段卡等重降为轻一档的参考卡。

## 4. 「上一杯 → 下一杯」验证闭环实现方式

```
上一杯（2:08 · 酸5 甜2 · 评分3）
  ↓ 保存前从既有诊断链取当时的建议
BrewDiagnosisService.diagnose(上一杯).suggestion = 「研磨度：细一档」
  ↓ BrewRecorder.save（唯一写入路径，库存/时间线/提醒照旧）
这一杯（2:28 · 酸4 甜3 · 评分4）落库
  ↓ SuggestionFollowUp.between(previous:suggestion:current:)  —— 纯函数
结果页新增一张卡：
  上次建议   研磨度：细一档
  这次：时间 2:08 → 2:28 · 酸度 5 → 4 · 甜度 2 → 3
  调整方向与上次建议一致。这次评分比上一杯高。
```

* 不新增任何数据库字段——上一杯与建议都在保存瞬间从现有数据算出；
* 方向判断只对水温 / 粉量 / 时间做（有数值可比），研磨度诚实返回「无法判断」；
* 措辞只有比较级，无因果断言；两杯没有同时打分时不出「更好/更差」的结论；
* 同样的对比逻辑复用在 Insights「最近一杯」的「与上一次相比」行。

---

## 5. 测试结果

```
xcodebuild test -project BrewPhase.xcodeproj -scheme BrewPhase \
  -destination "platform=iOS Simulator,id=810C6408-…" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO

Executed 330 tests, with 0 failures (0 unexpected) in 54.2s
```

新增 2 个测试（`BrewLoopTests`）：
* `testSuggestionFollowUpReportsOnlyWhatChanged` —— 只列变化、评分结论、
  无建议时无方向结论；
* `testSuggestionFollowUpSeesTheAdjustmentDirection` —— 水温 92→94 与
  「调高一点」建议方向一致。

## 6. Clean Build warning 数量

干净构建（清空 SYMROOT/OBJROOT 全量重编）：`** BUILD SUCCEEDED **`，
日志共 1 条 warning —— Xcode 自身的 AppIntents metadata 噪音。**项目代码 0 警告。**

## 7. Localization 检查结果

```
Localisation check passed — 852 keys, both tables complete, placeholder counts match.
```

本批 +52 新键；顺带清理了 32 个已无出处的死键（含本批下线的
「相似冲煮」搜索区与旧推荐问题文案）。

---

## 8. 仍然建议放到下一批处理的问题

1. **「Quick Log 保存失败」无法用 simctl 截图**（不能点击按钮构造非法输入）；
   失败路径由 `BrewRecorder` 单测与第一批的错误处理骨架覆盖，UI 呈现与第一批
   相同（错误卡 + 不退出）。
2. **Insights 的「下一步」与豆子页诊断卡措辞同源**，如果将来觉得重复，
   可以让 Insights 只在「有新建议未验证」时出现。
3. **实验预测卡在豆子页的位置**（冲煮记录之后）本批未动；若要进一步降级，
   可以考虑并入「知识」组。
4. **PhaseRulesView 普通模式是只读的**（改数字需展开高级区）；如果用户反馈
   想在普通模式直接改「窗口结束」，可以加一个受控的 stepper。
5. **「上次建议」卡只在保存后的结果页出现**；历史验证记录（哪些建议被采纳过、
   命中率）没有持久化——那需要新字段，按本批约束不做。

## 9. 产品层自检（规格 §十四）

1. **5 秒内知道今天干什么？** 是——首页只剩「记一杯」和「+」，Today 卡直接
   给出今天冲哪包与开始冲煮按钮。
2. **记一杯与问一问区分开？** 是——前者是动作（首页唯一按钮），后者是问答
   （更多页与豆子页入口，标题「问问你的咖啡」）。
3. **Insights 在主动汇报？** 是——四层固定结构：今天喝哪包 → 最近一杯（含
   与上一杯的差）→ 我的最佳参数 → 下一步，无需用户输入。
4. **Ask 是统一入口？** 是——Insights 的相似检索框已移除，提问能力只剩
   Ask 一处；内部模块名不再出现在界面。
5. **能看到「上次建议有没有帮助」？** 能——保存下一杯后结果页立即给出
   「上次建议 / 这次：变化 / 方向是否一致 / 评分对比」。
6. **实验预测没有压过阶段判断？** 是——豆子页上它排在冲煮记录之后，
   标题与数字都降了一档，且带常驻「实验预测」标签。

## 10. 技术层自检

1. 没有新增 SwiftData Model；2. 没有改任何数据结构（`tasteLine` 是计算属性）；
3. `BrewRecorder` / `PhaseEngine` / 诊断引擎零改动（`BrewRecorder.apply` 仅为
   第一批失败清理的公开化）；4. 没有新的云端依赖；5. 没有新的保存路径——
   本批全部改动都是只读计算 + 展示。
