# BrewPhase —— 记录 → 分析 → 诊断 → 下一杯建议（第一版）分析与交付报告

对象：`github.com/banmu123/BrewPhase`
本阶段解决：**CP-005 冲出好咖啡却忘记参数**、**CP-009 家里冲不出咖啡馆的味道**。
本阶段明确不做：数据导入（CP-012 只预留）、账号/服务器（CP-011 只落实为原则）、
LLM、Muse、云同步、社区。

---

## 第一部分：编码前的架构分析（规格 §三）

### 1. 当前 Brew Log 数据模型

`@Model Brew`（`BrewPhase/Models/Brew.swift`），一张表装三件事：

| 组 | 字段 |
|---|---|
| 身份 | `id` / `date` / `createdAt` |
| 配方 | `method` / `grinder` / `grindSize` / `waterTemp` / `coffeeG` / `waterG` / `timeSeconds` |
| 评价 | `score`(0–5，0 = 没打分) / `acidity` / `sweetness` / `bitterness` / `body` / `aftertaste` / `flavorTagsRaw` / `notes` |
| 归属 | `bean: Bean?` |

派生而不存储：`ratio`、`ratioText`、`timeText`、`doseLine`、`dayAfterRoast`、
`hasTasteDetail`、`recipe: BrewRecipe`（值类型）、`makeTasting()`、`hasTimelineMaterial`。
**没有** `source` / `externalID` 之类来源字段（CP-012 的落点，见第 12 条）。

### 2. 当前 Tasting 数据模型

`@Model Tasting`：`date` / `dayAfterRoast`（创建时冻结）/ `flavorTagsRaw` / `score` /
`notes` / `sourceRaw`(manual \| brew) / `brewID` / `bean`。

两件事值得记住：

* 记录一次冲煮会**顺手镜像**一条 `source: .brew` 且带 `brewID` 的风味记录
  （`Brew.makeTasting()`），`BrewEditorView.updateLinkedTasting` 保持它与冲煮同步；
* **Tasting 不携带味觉轴**（酸/甜/苦/醇厚/余韵只在 `Brew` 上）。所以诊断的输入是
  Brew 的轴 + Tasting 的风味标签/备注，不需要新的数据结构。

### 3. 「个人最佳」目前做到什么程度

`PersonalBestAnalyzer.analyze(brews:)`（`@MainActor`，入参是**任意一组** `Brew`）：

```
Analysis {
  scoredCount, highRatedCount,
  bestScore, bestDate, bestRecipe, bestFlavorTags, bestNotes,
  averageScore,                                  // 全部打过分记录的平均
  temperature / timeSeconds / ratio / dose: FieldStats?   // 只统计高分记录
}
hasEnoughData = highRatedCount >= IntelligenceConfig.minimumSamplesForComparison (=3)
highRatingThreshold = 4
```

它**不做分组**：同一包豆、同一种冲法、全库混在一起，都是调用方先筛好再传进来。
`FieldStats` 给了 average/min/max/count——`min/max` 就是「你的高分区间」，诊断要用。

### 4. PersonalBestAnalyzer / ParameterDeviation 的实际能力

`ParameterDeviationAnalyzer.analyze(current:history:)` 比较四个数值参数
（水温 / 萃取时间 / 粉水比 / 粉量），词汇在 `BrewParameter`（label、展示格式、容差）：

```
Analysis { verdict: withinPersonalRange | outsidePersonalRange | insufficientEvidence,
           fields: [DeviationField(parameter, current, typical, delta)], 
           shortcoming: noBrews | notEnoughSamples, personalBest }
```

`isOutside` 用 `IntelligenceConfig` 的容差（1.5°C / 15s / 0.5 / 1.5g）——**展示**判据，
不是咖啡标准。措辞永远是「和你常用的不一样」，不说「错了」。这两个类型本次**不重写**，
继续服务 Insight 路径（见第 8/9 条对分工的说明）。

### 5. 当前 RecommendationEngine 能做什么

`@MainActor final class RecommendationEngine`，五个入口：

| 入口 | 走什么路 |
|---|---|
| `todayPick(beans:book:weather:)` | 结构化 + `PriorityEngine`（首页那套规则），天气只做同档 tie-break |
| `methodSuggestion(for:weather:allBrews:)` | 天气给方向 × 用户做法历史给依据 |
| `personalBest(for:)` | 纯统计（`PersonalBestAnalyzer`） |
| `deviation(for:)` | 「这次 vs 我的高分区间」 |
| `similarHistory(...)` | 唯一的语义入口 |
| `capability(settings:languageCode:)` | 能力自检（索引/引擎可用性） |

出口统一是 `Insight{kind, headline, reasons, evidence, confidence, beanID}`，
文案由 `InsightFormatter` 组装，界面在 `InsightsView`。**它没有「下一杯怎么改」这个出口**——
这正是本次要加的一层。

### 6. 当前 Ask / RAG 如何访问 Brew 历史

两条互不干扰的路：

* **结构化直查**（`StructuredRetriever.facts(plan:)`）：按意图产出结论型事实
  （库存 / 评分 / 时间线 / 最近 N 次参数 / 当前状态）。「最近三次怎么冲的」就是它答的。
* **向量检索**：`DocumentBuilder` 把 Brew/Tasting/Bean 映射成 `CoffeeKnowledgeDocument`
  （metadata 带 `beanID` / `method` / `score` / `dayAfterRoast` / 可选 `entityIds`），
  进 `SwiftDataVectorIndex`；`HybridRetriever` 融合事实与向量命中。

**没有任何地方做「这一杯 vs 我的历史」的逐参数诊断**：`deviation` 只是 Insight 文案，
不成体系、也不产出「下一杯改什么」。这是 CP-009 的缺口，补的方式是新增一层，
而不是改检索层。

### 7. 可以直接复用的东西（不重造）

| 层 | 直接复用 |
|---|---|
| 数学 | `BrewMath`（ratio / parseTime / formatTime / validate / clampScore / remainingAfter）、`BrewRecipe`（值类型配方 + summaryParts） |
| 默认值 | `BrewDefaults.current()`（读用户的 @AppStorage 偏好）、`BrewCatalog`（方式/磨豆机/温度/粉量候选） |
| 统计 | `PersonalBestAnalyzer`、`ParameterDeviationAnalyzer`、`FieldStats`、`BrewParameter`、`IntelligenceConfig` |
| 知识 | `BeanContextResolver`、`EntityGraph`、`KnowledgeSearchService`（确定性词法检索 + 实体过滤）、`KnowledgeEvidence` |
| 结论形状 | `Insight`（headline / reasons / evidence / confidence / kind）与 `InsightFormatter` 的写法 |
| 对话 | `ConversationContext`（focusBean / activeMethod / activeParameter）+ `QueryPlan` + `ConversationQueryPlanner` |
| 记录写入 | `BrewEditorView` 的「复制上次冲煮」`autoCopyLast`、库存扣减、镜像 Tasting 的既有逻辑 |
| UI | `Card` / `SectionHeader` / `EditorRow` / `EditorChipsRow` / `NumberField` / `StarRatingInput` / `TasteScale` / `SelectableTag` / `Chip` / `FlowLayout` / `PrimaryButton` / `SecondaryButton` / `RelevantKnowledgeSection` |

### 8. CP-005 最小实现要改哪些文件

| 文件 | 动作 |
|---|---|
| `Core/BrewPrefill.swift` | 新增：最近一次相关冲煮 → 预填（值类型 + 纯函数） |
| `Core/BrewDelta.swift` | 新增：这一杯与上一杯的参数差异（值类型 + 纯函数） |
| `Services/BrewRecorder.swift` | 新增：**唯一的写入路径**（校验、库存扣减、镜像风味记录、保存、重建提醒） |
| `Features/Brew/BrewEditorView.swift` | 改：保存/提醒走 `BrewRecorder`（去重，不改行为） |
| `Features/Brew/QuickBrewLogView.swift` | 新增：30 秒快记（第一层只有豆/方式/评分/味觉，参数折叠） |
| `Features/Home/HomeView.swift` | 改：加「记一杯」入口（不必先挑豆） |
| `Features/Bean/BeanDetailView.swift` | 改：入口接快记（已有「复制参数再来一次」保留） |
| `Models/Brew.swift` | **不改**（预填与差异全靠已有字段派生） |

### 9. CP-009 最小实现要改哪些文件

| 文件 | 动作 |
|---|---|
| `RAG/Diagnostic/BrewObservation.swift` | 新增：一次冲煮的**值类型**视图（诊断层只吃值类型，见第 12 条） |
| `RAG/Diagnostic/PersonalBaseline.swift` | 新增：个人基线（三层回退 + 最小样本 + 「还差几条」） |
| `RAG/Diagnostic/DiagnosticResult.swift` | 新增：诊断候选 / 证据 / 置信度 / 下一杯建议的值类型 |
| `RAG/Diagnostic/BrewDiagnosticEngine.swift` | 新增：确定性规则集合（4 类）+ 建议选择 |
| `Resources/diagnostic_rules.json` | 新增：干涩/水感这类**匹配词表**与知识检索用的查询串（中文词表进 Swift 会被本地化流水线收键） |
| `RAG/Rules/IntelligenceConfig.swift` | 改：诊断阈值集中在这里 |
| `Features/Brew/BrewDiagnosticCard.swift` | 新增：「本次表现」+「下一杯建议」卡片 |
| `Features/Bean/BeanDetailView.swift` | 改：在冲煮记录上方放一张「最近这杯」诊断卡 |
| `RAG/Retrieval/StructuredRetriever.swift` | 改：新增诊断事实（让「为什么这杯分低」有结构化答案） |
| `RAG/Retrieval/QueryAnalyzer.swift` + `Resources/query_rules.json` | 改：新增 `diagnosis` 意图与关键词 |
| `RAG/Conversation/*` | 改：把「上一轮的建议」作为**结构化状态**带进下一轮 |

### 10. 是否需要新增 SwiftData Model

**不需要，本次零迁移。** 诊断是纯计算（输入已有字段 + 知识库），建议不落库
（随时可由记录重算）。CP-012 需要的来源字段**本阶段不加**：规格 §23 说得很清楚——
「除非当前需求确实需要，否则不要为了 CP-012 提前增加数据库复杂度」。本次的需求确实不需要：
预填、差异、基线、诊断全部可以从现有字段派生。

### 11. 可以先不新增的东西

数据导入与 Data Vault UI、账号/同步、LLM 表达层、图表化 dashboard、社区/分享、
自动知识库更新、编辑器之外的新页面（冲煮详情页不做，诊断卡挂在豆子详情与快记结果里）。

### 12. 如何避免未来 CP-012 导入数据时重新设计 Brew 数据层

三条具体做法，都在本次实现里落地：

1. **诊断层只吃值类型**：`BrewDiagnosticEngine` 的入参是 `BrewObservation`
   （date / recipe / 味觉轴 / 评分 / 标签 / 备注 + 一个 `BrewRecordSource` 预留位），
   `@Model Brew` 只在**一处**映射（`BrewObservation(brew:)`）。将来写导入器时，
   只需再写一个 `BrewObservation(imported:)`，基线、诊断、建议、Ask 集成全部原样复用。
2. **不动既有字段、不删字段、不改派生不变量**：`ratio` 仍然不存（存了就会和
   粉量/水量互相打架），导入器将来也必须遵守这条。
3. **`BrewRecordSource` 先作为值类型上的标签存在**（`manual` / `imported` / `device`），
   不写进数据库。将来真的需要区分来源时，加字段是一次单独的迁移，而那时**读取侧
   已经全部准备好**（诊断与统计不关心来源）。

---

## 第二部分：实现（规格 §33 的第 2–14 项）

### 2 / 3. 修改与新增文件

**新增（12 个文件）**

| 文件 | 作用 |
|---|---|
| `Core/BrewDelta.swift` | 这一杯与上一杯的差异（数值参数算差值，自由文本只报「从什么改成什么」） |
| `Core/BrewPrefill.swift` | 预填：同豆同法 → 任何豆子 → 用户默认值 三档 |
| `Services/BrewRecorder.swift` | **唯一写入路径**：校验、库存、镜像风味记录、保存、提醒 |
| `Resources/diagnostic_rules.json` | 干涩/水感这类**匹配词表** + 知识检索查询串（数据，不是界面文案） |
| `RAG/Diagnostic/BrewObservation.swift` | 一次冲煮的**值类型**视图 + `TasteAxis` + `BrewRecordSource`（CP-012 落点） |
| `RAG/Diagnostic/PersonalBaseline.swift` | 个人基线（三层回退、最小样本、置信度上限、轴分布） |
| `RAG/Diagnostic/DiagnosticResult.swift` | 候选结论 / 置信度 / 建议的值类型（含 `AdjustmentParameter/Direction`） |
| `RAG/Diagnostic/BrewDiagnosticEngine.swift` | 四条确定性规则 + 知识依据选择 |
| `RAG/Diagnostic/AdjustmentPlanner.swift` | 诊断 → 「只改一件事」的建议（含保持不变与留意什么） |
| `RAG/Diagnostic/BrewDiagnosisService.swift` | 把库里的记录喂给引擎（并保证「这一杯不给自己当基线」） |
| `Features/Brew/QuickBrewLogView.swift` | 30 秒快记（表单 → 结果页，含诊断） |
| `Features/Brew/BrewDiagnosticCard.swift` | 「本次表现」+「下一杯建议」+「知识库怎么说」 |
| `BrewPhaseTests/BrewDiagnosticTests.swift` / `BrewLoopTests.swift` | 见第 15 项 |
| `Tools/Brew-Loop-V1-Report.md` | 本文件 |

**修改（11 个文件）**

| 文件 | 改什么 |
|---|---|
| `Services/BrewRecorder.swift`（被引用） | — |
| `Features/Brew/BrewEditorView.swift` | 保存与提醒改走 `BrewRecorder`（行为不变，去掉重复实现） |
| `Features/Bean/BeanDetailView.swift` | 诊断卡（放在风味窗口卡之后）；记录入口改为「记一杯 / 完整表单」；补一个跨豆查询 |
| `Features/Home/HomeView.swift` | 工具栏加「记一杯」；今日卡的主操作改成快记 |
| `App/BrewPhaseApp.swift` | 调试路由加 `quickLog` / `brewDiagnosis`；补一个 brews 查询 |
| `Services/DebugLaunch.swift` | 两个调试入口 + 一个「打开就记一杯」的演示开关 |
| `Services/DemoData.swift` | 演示数据补一杯「不太满意的最近记录」，让诊断有东西可说 |
| `RAG/Rules/IntelligenceConfig.swift` | 诊断阈值集中在这里（参考记录数、时间显著差、味觉兜底阈值） |
| `RAG/Retrieval/QueryPlan.swift` | 新增 `diagnosis` 意图；`suggestion` 字段（结构化建议进对话状态） |
| `RAG/Retrieval/QueryAnalyzer.swift` | 诊断意图压过「知识型问法」的绑定规则；`isAboutThisBag` 补 diagnosis |
| `RAG/Retrieval/StructuredRetriever.swift` | 新增诊断事实（`fact:diagnosis:<bean>`） |
| `RAG/Retrieval/HybridRetriever.swift` | 诊断只算一次：喂给结构化事实，也写进计划 |
| `RAG/Conversation/*` | `SuggestionState` + 状态推进 + 「上一轮的建议」说明行；「这杯」在锁定豆子时不再报缺对象 |
| `Resources/query_rules.json` | 诊断意图关键词 |
| `Tools/Localization/strings.py` | 122 条新文案；`Tools/run.sh` 加 `--quick-demo` |

### 4. 有没有改 SwiftData

**没有。零迁移。** 新增的「诊断」是纯计算，建议不落库（随时可由记录重算）；
预填与差异全部从现有字段派生（`ratio` 仍然不存，保持既有的不变量）。
CP-012 需要的来源字段本次没加，理由与落点见第 13 项。

### 5. Quick Brew Log

`Features/Brew/QuickBrewLogView.swift`。第一屏只有四件事——**哪包豆、怎么冲、几分、
什么味道**；粉量/水量/水温/时间/研磨/磨豆机/日期全部收在「更多参数」折叠里。

* 入口：首页工具栏「记一杯」（不必先挑豆）、今日卡「开始冲煮」、豆子详情的「记一杯」；
* 顶部一张卡说明这次预填从哪来（「沿用这包豆上一次的参数 · 9月27日 · V60 · 18g/300g ·
  92°C · 2:28」），**用户动过参数之后就不再自动覆盖**；
* 任何参数被改动，卡片里立刻多出「这次改了：水温 92°C → 91°C」——差异是算出来的，
  不是让用户事后回忆的；
* 保存后**不退出**，就地换成结果页：记下了 → 本次表现 → 下一杯建议 → 「再记一杯 / 完成」。
  这一条是闭环的关键：如果保存后就关掉，用户永远看不到诊断。

### 6. Auto Prefill

`Core/BrewPrefill.swift`（纯函数）。三档回退，越具体越优先：

```
同一包豆 + 同一冲法 → 同一包豆 → 任何豆子的同一冲法 → 任何豆子 → 用户默认值
```

* 换豆时沿用**习惯的那套参数**（器具/粉量/水温），但从零开始记味道；
* 用户已经选定的冲法不会被预填改掉（预填只补参数）；
* 里没有复制任何数据：预填是**读**上一次的记录，写下去仍然只写一条新的 `Brew`；
* 依据的那一杯连同日期一起展示，用户知道「沿用」的是哪一次。

### 7. Personal Baseline

`RAG/Diagnostic/PersonalBaseline.swift`。**只统计用户打过高分（≥4）的记录**——
基准要来自你自己满意的杯子，低分记录掺进来只会把常用值往坏的方向拉。

* 三层回退：`这包豆 + 冲法` → `这包豆` → `同一冲法（别的豆子）`，第一层达标即停；
* 每层记着 `scoredCount / highRatedCount / requiredHighRated`，不够就**不编基线**，
  只报「目前有 N 次带评分的记录，还差 M 次」；
* 除了四个数值参数，还算五条**味觉轴**在高分记录里的分布——「甜感偏低」因此是
  「比你自己的好杯子低」，而不是拿一个外部标准卡；
* `confidenceCeiling`：高分记录 1 条 → 最多低置信；2 条 → 最多中；≥3 条（与
  `minimumSamplesForComparison` 同一个数）→ 才允许高置信。样本量直接封住口气。

### 8. Diagnostic Engine

`RAG/Diagnostic/BrewDiagnosticEngine.swift`，`@MainActor`，**全部是确定性规则**：

```
输入：BrewObservation(current) + 这包豆的历史 + 全库历史 + 词表 + 知识服务
  ① PersonalBaselineBuilder → PersonalBaseline（不够就到此为止，不猜）
  ② Signals：把「偏高/偏低/偏快/偏慢」这些判断集中算出来（个人优先、绝对兜底）
  ③ 四条规则 → [DiagnosticCandidate]（含证据行）
  ④ 排序：萃取不足/过萃 → 时间 → 症状 → 参数偏离
  ⑤ AdjustmentPlanner → 一条建议（或没有）
  ⑥ DiagnosticKnowledge → 知识依据（不参与判断）
```

输出 `BrewDiagnosis{ candidates, baseline, suggestion?, notes, knowledge }`。
`notes` 里永远写着依据（「依据：这包豆 + V60 的 3 次高评分记录。」）与样本量提醒。

### 9. Diagnostic Rules

| 规则 | 触发条件（全部要真数据） | 结论 |
|---|---|---|
| 疑似萃取不足 | 本次时间短于个人区间 ≥10s（`diagnosticTimeMarginSeconds`）**且**（酸偏高 或 甜偏低） | `suspectedUnderExtraction`，1–3 个信号 → 低/中/高 |
| 疑似过萃 | 本次时间长于个人区间 ≥10s **且**（苦偏高 或 备注/标签命中干涩词） | `suspectedOverExtraction` |
| 冲得偏快 / 偏慢 | 时间偏离个人区间 ≥10s；**只在上面两条都没成立时报** | `fastFlow` / `slowFlow`，最高中置信 |
| 参数偏离 | 水温/粉水比/粉量超出个人区间 ±容差；**不含时间**（上面已经说过） | `parameterDeviation`，两三项偏离给高置信 |
| 症状单报 | 甜偏低 / 苦偏高 / 醇厚偏低（或备注命中水感），**只在没有方向性结论时报** | `lowSweetness` / `highBitterness` / `thinBody` |

**「偏高/偏低」先用你自己的高分记录判断**（高于你自己最高 / 低于你自己最低），
没有个人轴数据时才退到绝对兜底阈值（≥4 / ≤2）。干涩词表刻意不收单字「干」——
中文里「干净」是好评，按单字匹配会把好喝的记录判成干涩（这条写在 JSON 的注释里）。

### 10. Adjustment Suggestion

`RAG/Diagnostic/AdjustmentPlanner.swift`。整个功能最重要的一条纪律在这里：

> **一次只改一个主要变量**——所以返回的是单数的一个旋钮 + 一个方向。

| 结论 | 旋钮 | 方向 | 为什么是它 |
|---|---|---|---|
| 疑似萃取不足 / 冲得偏快 | 研磨度 | 细一档 | 最直接的补救 |
| 疑似过萃 / 苦偏高 / 冲得偏慢 | 研磨度 | 粗一档 | 少萃一点 |
| 甜感偏低（时间正常） | 水温 | 调高一点 | 时间没偏时升温比磨细更有效 |
| 口感偏薄 | 粉量 | 多加一点粉 | 水量不变、加粉即变浓 |
| 参数偏离 | 水温 / 粉量 | 朝个人区间 | 回到你自己表现更好的地方 |

每条建议都带：`reason`（来自诊断的证据）、`expectedEffect`、`keep`（**保持不变的是
你能拧的旋钮**——时间不属于这里，它是结果）、`observe`（下一杯留意什么）、
`referenceRange`（你自己的区间，唯一可以写出来的精确数字）。
不硬算数值：只有「细一档」「调低一点」这种相对措辞。

### 11. 知识库怎么参与诊断

**它不参与判断，只负责把说法补上出处**（规格 §十九）。判断全在规则里，所以
知识库读不到内容时，结论与建议一行都不会变（`BrewDiagnosticTests` 里有一条测试
专门守这个顺序）。

* 结论 → `diagnostic_rules.json` 里的查询串 → `KnowledgeSearchService.search`
  （确定性词法检索，不走 embedding）；
* 还有位置就补一条**冲法本身**的知识（例如 V60 那篇「官方配方本来就各不相同」），
  因为知识库目前没有一篇通用萃取条目，症状类常常命中别的冲法；
* 卡片固定声明一句「知识库说的是通常情况，你的记录说的是这包豆的实际情况；
  两者不一致时以你的记录为准」。

### 12. Conversation 怎么调用诊断

新增 `QueryIntent.diagnosis`（关键词：为什么 / 下一杯 / 怎么改 / 太酸 / 太苦 / 干涩…）。
链路是现成的，只补了两处接线：

```
「为什么这杯不好喝？」
  → 分析器：diagnosis 意图 + 锁定豆子（诊断意图压过「知识型问法不绑豆」那条规则）
  → 检索层：BrewDiagnosisService 算一次诊断
       ├── 结构化事实：fact:diagnosis:<bean>（结论 + 逐条证据 + 下一杯建议 + 保持不变）
       └── plan.suggestion → SuggestionState(研磨度, 细一档)
  → 抽取式回答（不需要 LLM）+ 引用编号
  → ConversationStateUpdater：建议写进对话状态（只存旋钮与方向，**不存回答原文**）
```

下一轮「那水温呢？」的脚注里因此会多一行「上一轮的建议：研磨度：细一档」，
换豆子时这条建议自动作废（它是针对上一包豆子说的）。

### 13. CP-012 预留了什么

不承诺功能，只承诺**结构**：

1. 诊断层只吃 `BrewObservation`（值类型），`@Model → 值类型` 只在一处映射；
   将来导入器只要再写一个 `BrewObservation(imported:)`，基线/规则/建议/Ask 集成
   全部复用同一批代码与同一批测试。
2. `BrewRecordSource`（`manual` / `imported` / `device`）已经存在，只是暂时都取
   `manual`；将来要按来源筛选时，改动集中在映射与筛选，不动规则。
3. 没有任何字段被删、被改语义；`ratio` 仍然派生不存——导入器将来也必须遵守这条。
4. 值类型里没有 `@Model` 引用，所以导入器可以离线跑（不需要 SwiftData 上下文）。

### 14. CP-011 怎么落实

没有登录页、没有账号、没有服务器、没有强制同步——这一条是**没做什么**，所以它需要
被证明：本次新增的每一层都在本机完成（规则、统计、知识库随包、抽取式回答），
`QuickBrewLogView → BrewRecorder → BrewDiagnosticEngine` 全程不触网；
会话与诊断状态都不落盘、不上传。这条与既有架构一致，本次没有引入任何例外。

---

## 第三部分：验收

### 15. 新增测试

| 文件 | 数量 | 覆盖 |
|---|---|---|
| `BrewDiagnosticTests.swift` | 14 | 基线三层回退与最小样本、置信度封顶、核心场景（可能萃取不足 + 磨细一档）、过萃、时间正常不算过萃、参数偏离、只改一个旋钮、无味觉证据不给强结论、正常一杯不给建议、知识不参与判断 |
| `BrewLoopTests.swift` | 12 | 预填（同豆同法优先、换豆沿用习惯、无历史退默认值）、差异话术（降温 1°C / 延长 8 秒）、保存扣库存 + 留时间线、编辑只补差、无粉量被拒、删除还粉、诊断进「问一问」、下一轮记得建议、换豆作废建议、只有一杯时如实说还差多少 |

两组合计 26 项，加上既有的 269 项 = **295 项**。

### 16. xcodebuild test 结果

```
xcodebuild test -project BrewPhase.xcodeproj -scheme BrewPhase \
  -destination "platform=iOS Simulator,id=810C6408-DCAB-469B-8D4B-5018BCC9C0FD"

Executed 295 tests, with 0 failures (0 unexpected) in 73.960 (74.110) seconds
** TEST SUCCEEDED **
```

本地化：`generate.py` 810 键（+122），`check.py` 通过。

**真实界面**（模拟器，`--demo`）：

* `--screen quickLog`：表单首屏是「Ethiopia Guji / Day 16 / 沿用这包豆上一次的参数 ·
  9月27日 · V60 · 18g / 300g · 92°C · 2:28 / 评分 / 酸苦醇厚」
* `--screen quickLog --quick-demo`：按下「记下这一杯」后停在结果页——
  「本次表现：甜感偏低（可以参考）」+「依据：这杯的甜是 2/5，你较好记录里最低 4」+
  「下一杯建议：水温：调高一点」+「保持不变：研磨 22 格 / 粉量 18g / 水量 300g / 器具 V60」
* `--screen brewDiagnosis`：规格 §29 的完整场景——「可能萃取不足（证据较足）」+
  四条依据（2:08 对 2:28–2:35、酸 5/5 对最高 4、甜 2/5 对最低 4、醇厚 2/5）+
  「研磨度：细一档」+ 保持不变 + 下一杯留意
* `--screen ask --ask "为什么这杯不好喝？"`：OSLog `intents=diagnosis,knowledge`，
  回答里是上面那批**结构化事实**（带 [1] 引用），末尾「依据：这包豆 + V60 的 3 次高评分记录」

### 17. 已知限制

1. **评分是基线的锚**：没有打分（`score = 0`）的记录不参与基线。用户只填参数不评分时，
   诊断会说「还差几次」而不是硬给结论——这是有意的，但确实要求用户至少评分。
2. **规模仍是 1–5 星**（不是规格示例里的 10 分制）：改成 10 分制要动 Bean/Brew/Tasting
   三个模型与全部界面，与本阶段「不改数据模型」冲突。判定逻辑与刻度无关。
3. **研磨度不参与数值比较**：它是自由文本（「22 格」/「中细」），只出现在差异与
   「保持不变」里；「细一档」是相对措辞，系统不知道你的磨豆机一档是多少微米。
4. **四条规则覆盖的是最常见的几类**：发酵味、水味、设备故障、水质问题都没有规则；
   它们会落到「没有明显异常」（如果参数与味觉都正常）——这是诚实的，不是完整的。
5. **样本量小时结论只是方向性的**：一次参考记录 → 低置信；两次 → 中。界面上写明了。
6. **诊断只针对最近一杯**：豆子详情与「问一问」都看最新那次；历史某一杯的诊断要把它
   变成「当前这一杯」才行（`BrewDiagnosisService` 支持传 `brew:`，界面还没有入口）。
7. **知识库对萃取的覆盖很薄**：19 篇里没有一篇通用萃取条目，所以症状类常常命中
   espresso 文档；已用「再补一条冲法知识」缓解，但根本解法是补知识库（下一阶段）。
8. **`「为什么…」+ 从豆子页面进入**时会同时跑诊断与知识检索，回答里两段都在。
   对这个产品来说用户数据优先是对的，但用户若只想问通用知识，会多看到一段自己的记录。
9. **演示数据里那杯「不太满意」的记录是刻意的**：它让首次打开的人看得见诊断；
   真实用户的数据不会有这一杯。

### 18. 下一阶段建议

1. **补知识库的萃取与水两篇**（本阶段最明显的短板）：有通用条目之后，症状类知识
   就不再命中 espresso 文档。
2. **把「验证」这一环做成正式动作**：下一次记完同一包豆时，把「上一杯的建议 + 这次
   改了什么 + 分数变化」摆成一句话（「磨细一档之后甜感 2→4，时间 2:08→2:31」）。
   数据都在，缺的只是一个对比视图。
3. **`BrewObservation` 的导入映射**（CP-012）：先做 CSV 导入 + 一个来源筛选，
   诊断层已经准备好，改动量集中在映射与一个导入界面。
4. **把诊断接到风味时间线上**：同一包豆的诊断历史（哪天开始变酸）比单杯诊断更像
   「我家为什么冲不出咖啡馆的味道」的答案。
5. **LLM 只做措辞**（可选）：把 `DiagnosticResult` 的候选 + 证据交给本地模型写成一段
   自然语言，仍然由确定性逻辑决定「改什么」。现在不做，是因为抽取式的语气虽然朴素，
   但它不会编。

### 重点说明：每句话分别来自哪里

| 来源 | 内容 | 例子 |
|---|---|---|
| **确定性规则** | 结论、建议、保持不变/留意 | 「时间短于个人区间 ≥10s 且 酸高/甜低 → 可能萃取不足 → 磨细一档」 |
| **你自己的历史** | 区间、典型值、味觉基线、依据句 | 「你的较好记录在 2:28–2:35」「你较好记录里最低 4」 |
| **知识库** | 「这种表现通常意味着什么」+ 出处 | 「知识库里的说法：意式浓缩…——官方参数」 |
| **将来可以交给 LLM** | 把上面三段合成一段连贯的话、换个说法、回答「为什么」里的追问 | 现在由 `ExtractiveLLMProvider` 按固定结构排列证据，可读但不润色 |

优先级始终是：**用户自己的真实数据 > 结构化计算/规则 > BrewPhase 知识库 > 通用知识 >
未来的 LLM 表达**。没有任何一条结论来自模型。

