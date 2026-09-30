# Bean → Knowledge Linking：架构审查（编码前）

> 依据用户规格 §五 的 13 项。**本文档为审查结论，本阶段未修改任何代码。**  
> 审查方式：对 16 个关注面逐文件精读，结论均带 `文件:行号` 证据。日期 2026-09-30。

---

## 0. 一句话结论

仓库**已经存在**一套完整的 Local Intelligence V1（`BrewPhase/RAG/`：文档抽象 → 索引 → 向量存储 → 混合检索 → 规则 → 可解释推荐 → 模板格式化）。规格 §19–§30、§三十五(4/6 条规则) 的大部分**不是待建，而是待接入**。

真正缺失且必须新建的，只有一件事：

> **Bean → Knowledge Entity → BeanKnowledgeLink → 豆子专属知识上下文**。

因此本次工程的重心是**新建 Linking 层 + 打通两个既有断层**，而不是重建检索层。

---

## 1. 当前数据架构

- **持久化 = SwiftData**，无 Core Data 手写栈。`Schema` 注册 6 个 `@Model`：`Bean / Brew / Tasting / PhaseReminder / PhaseRule / EmbeddingRecord`（`BrewPhase/App/BrewPhaseApp.swift:22-39`），构造失败降级为内存库（`:46-49`）。
- **无 `VersionedSchema` / `SchemaMigrationPlan` / migration 代码**（全仓 0 命中）。唯一相关表述是注释：新增实体属 SwiftData 轻量迁移，老数据无需转换（`BrewPhaseApp.swift:28-31`）。
- **分层**：

| 层     | 目录          | 职责                                                                                                 |
| ----- | ----------- | -------------------------------------------------------------------------------------------------- |
| 模型    | `Models/`   | SwiftData 实体 + 少量枚举                                                                                |
| 领域计算  | `Core/`     | `PhaseEngine` / `PriorityEngine` / `BrewMath` / `FlavorLibrary` / `ConsumptionEstimator`           |
| 端侧 ML | `ML/`       | `FlavorFeatureBuilder`(85 维) / `FlavorWindowPredictor`(XGBoost .mlmodelc) / `FlavorModelResources` |
| 检索智能  | `RAG/`      | Core / Indexing / Embedding / Store / Retrieval / Rules / Recommend / Answering / Weather          |
| 服务适配  | `Services/` | `FlavorInputFactory` / `InsightFactory` / `NotificationManager` / `DemoData` / `ExportManager`     |
| UI    | `Features/` | SwiftUI 视图                                                                                         |

- **Source of Truth = SwiftData 的 `Bean` / `Brew` / `Tasting`**。**不存在第二套 Bean 模型**，符合规格 §四 的硬要求。

## 2. 当前 Bean 数据模型

`BrewPhase/Models/Bean.swift:22-63`。`@Model class Bean`，无 `@Attribute`。

| 字段                                        | 类型                       | 说明                               |
| ----------------------------------------- | ------------------------ | -------------------------------- |
| `id`                                      | `UUID`                   |                                  |
| `name`                                    | `String`                 |                                  |
| `roaster`                                 | `String`                 | 烘焙商（自由文本）                        |
| **`origin`**                              | `String`                 | **「国家 · 产区」合一的本地化自由文本**          |
| **`process`**                             | `String`                 | **本地化自由文本**                      |
| `roastLevelRaw`                           | `String`                 | → `RoastLevel`，**稳定英文 rawValue** |
| `roastDate` / `purchaseDate` / `openDate` | `Date?`                  |                                  |
| `weightG` / `remainingG` / `price`        | `Double`                 |                                  |
| `channel` / `notes`                       | `String`                 |                                  |
| `imagePath`                               | `String?`                |                                  |
| `flavorTagsRaw`                           | `String`                 | `␟` 分隔，存**英文 canonical id**（稳定）  |
| `statusRaw` / `createdAt` / `updatedAt`   |                          |                                  |
| `brews` / `tastings` / `reminders`        | `@Relationship(cascade)` |                                  |

**不存在的字段**（规格 §六 的 BeanProfile 里点名但库里没有）：`variety`、`altitude`/`elevation`、`packaging`、`storage`、`farm`、`producer`、`originCountry`(独立)、`originRegion`(独立)、`subRegion`、`fermentation`、`brewPreferences`。  
证据：`ML/FlavorFeatureBuilder.swift:50-61` 把 `varietyText/altitudeM/packagingTypeText/storageMethodText/storageTemperatureC` 明确定义为「App 还没有的字段」。

**三个关键风险：**

1. **`origin` 是合并串**（`"埃塞俄比亚 · Guji"`，见 `Services/DemoData.swift:52-53`），且**随界面语言变化写入**（编辑器是自由输入框，`Features/Bean/BeanEditorView.swift:227-231`）。没有独立 country/region 维度 → 拆解必须靠别名 tokenizer。
2. **`process` 同样本地化**（`L("水洗")`），非稳定标识。对比 `RoastLevel.rawValue` 与 `flavorTags` 是稳定的。
3. **无 `variety` 字段** → §七 示例里的 `Heirloom` 映射目前**无入库路径**（只能从名字/备注里尽力识别）。

## 3. 当前 Brew / Tasting 数据关系

- `Brew`（`Models/Brew.swift:18-47`）：`date / method / grinder / grindSize: String`、`waterTemp / coffeeG / waterG: Double`、`timeSeconds: Int`、`score/acidity/sweetness/bitterness/body/aftertaste: Int`、`flavorTagsRaw / notes`、`bean: Bean?`。
- `Tasting`（`Models/Tasting.swift:12-25`）：`date / dayAfterRoast(创建时冻结) / flavorTagsRaw / score / notes / sourceRaw / brewID: UUID? / bean: Bean?`。
- **镜像关系**：`Brew.makeTasting()` 在每次冲煮后生成一条 `source = .brew`、`brewID = id` 的 Tasting（`Brew.swift:144-154`）。`brewID` 是**普通可选 UUID 字段，不是 `@Relationship`**。
- **已存在镜像去重**：`RAG/Indexing/DocumentBuilder.swift:216-233` 按「score/flavorTags/notes 三者内容相等」判定镜像并跳过索引。
- 消费点：`Features/Brews/BrewHistoryView.swift:162`、`Features/Brew/BrewEditorView.swift:478`。

## 4. 当前 Equipment 数据关系

**结论：不存在 Equipment 模型。** 设备信息只以自由文本散落：

- `Brew.grinder` / `Brew.grindSize`（`String`）
- `Brew.method`（`String`，冲煮方式，非设备）
- `Bean.roaster`（烘焙商，不是设备）

`feature_schema.json` 里有 `packaging_type` / `storage_method` 类目，但 `Bean` 上**没有对应字段**。

**对本任务的影响（必须明确）：** 规格 §二十二 / §二十三（`EquipmentContext` / `getKnowledgeForEquipment` / `EquipmentCompatibilityRule` / §二十二「Breville Barista Express + Espresso」的合并检索）**在 V1 缺少数据源**。可选路线见 §9 决策点 D。

## 5. 当前已有 Freshness 逻辑

**已相当完整，不应重建**（规格 §三十四 的 `BeanFreshnessEngine` 大部分已存在）：

- `Core/PhaseEngine.swift`：阶段推算；`Core/PhaseRuleData.swift` + `Services/PhaseRuleBook.swift` + `Models/PhaseRule.swift`（`@Model`，**按烘焙度持久化可编辑窗口规则**）。
- `Models/BeanPhase.swift`：`resting / opening / peak / declining` + `PriorityTier` + `TrackSegment`。
- `Core/BeanSnapshot.swift`、`Core/ConsumptionEstimator.swift`、`Services/NotificationManager.swift` + `Models/PhaseReminder.swift` + `Core/ReminderKind.swift`。
- **§三十四 的 `FreshnessProfile`（default/light/medium/dark/espresso）≈ 现有 `PhaseRule` 的 5 档烘焙度规则**。阈值来自 `PhaseRuleData` 默认值 + 用户可编辑，**阈值来源与版本已被记录**（满足 §三十四 要求）。
- 已有「无烘焙日期时不猜」的既定行为（`BeanPhase` / `PhaseEngine` 测试 `testMissingRoastDateIsReportedNotGuessed`）。

**结论：FreshnessRule（§三十五）应直接包装既有 `PhaseEngine`/`PriorityEngine`，不新建引擎。**

## 6. 当前已有 Recommendation 逻辑

`RAG/Recommend/RecommendationEngine.swift`：

| 入口                 | 用 embedding？                    | 证据                 |
| ------------------ | ------------------------------- | ------------------ |
| `todayPick`        | 否（纯结构化 + `PriorityEngine`）      | `:35-73`，注释 `:6-9` |
| `methodSuggestion` | 否（`MethodRules.stats` + 天气方向）   | `:86-165`          |
| `personalBest`     | 否（`PersonalBestAnalyzer`）       | `:169-174`         |
| `deviation`        | 否（`ParameterDeviationAnalyzer`） | `:180-185`         |
| `similarHistory`   | **是**（唯一语义入口）                   | `:189-233`         |
| `capability`       | 否                               | `:237-247`         |

配套：`Recommend/Insight.swift`（`headline/reasons/evidence/confidence/beanID` + `Kind{todayPick,personalBest,deviation,similarHistory,methodSuggestion}`）、`Recommend/InsightFormatter.swift`（**禁字面量数字**、禁「错」、相似记录只报分布）、`Rules/IntelligenceConfig.swift`（阈值与权重集中）、`Recommend/IntelligenceCapability.swift`。

**§三十五 RuleEngine 现状对照：**

| 规格要求                         | 现状                                    | 结论           |
| ---------------------------- | ------------------------------------- | ------------ |
| `FreshnessRule`              | `PhaseEngine` + `PhaseRuleBook`       | 已有，需包装       |
| `PriorityRule`               | `Core/PriorityEngine.swift`           | 已有           |
| `PersonalBestRule`           | `Rules/PersonalBestAnalyzer.swift`    | 已有           |
| `ParameterDeviationRule`     | `Rules/ParameterDeviation.swift`      | 已有           |
| `SimilarHistoryRule`         | `RecommendationEngine.similarHistory` | 已有           |
| `EquipmentCompatibilityRule` | —                                     | **缺（且无数据源）** |

## 7. 当前已有 Search 逻辑

- **意图**：`Retrieval/QueryPlan.swift:8-17` 8 个 intent；规则来自 `Resources/query_rules.json`（`QueryAnalyzer.swift:33-41`）。
- **混合检索**：`Retrieval/HybridRetriever.swift:32-92`（结构化 → 向量 → 融合）。权重 0.62/0.16/0.16 在 `Rules/IntelligenceConfig.swift:26-28`；**知识类时效加权为中性 0.5**（`HybridRetriever.swift:189-195`）；`sourceAdjust` 内联在 `:202-208`（未进 Config）。
- **结构化直查**：`Retrieval/StructuredRetriever.swift:14-56` 5 条路径（inventory/rating/timing/recipe/status）。
- **元数据过滤**：`Store/MetadataFilter.swift:11-34` 11 个维度（`sourceTypes/beanID/brewID/methods/devices/processes/origins/dateRange/dayAfterRoast/min-maxScore`），自由文本走归一化子串包含（`:77-88`）。
- **向量**：`Store/SwiftDataVectorIndex.swift`（SwiftData 暴力余弦）+ `Store/VectorMath.swift`（Accelerate `vDSP_dotpr`）+ `Store/EmbeddingRecord.swift`。
- **Embedding**：`Embedding/EmbeddingProvider.swift:11-38` 协议 + `AppleSentenceEmbedding`（NLEmbedding，按语言）+ `LexicalEmbedding`（中英兜底）+ `EmbeddingProviderFactory`（显式降级链）。
- **知识库**：`Indexing/KnowledgeBase.swift` 读 `Resources/knowledge_base.json`（v1，16 篇），**白名单解析 `id/category/source/title/content`，其余字段一律丢弃**（`:82-98`）。
- **编排**：`RAG/AskEngine.swift`。

### 7.1 两个必须修通的断层（否则 linking 无效果）

1. **知识条目当前没有可关联属性。** `KnowledgeBase.documents()` 只写 `metadata(docDate, category, reference)`，`origin/process/variety` **全为 nil**（`KnowledgeBase.swift:116-120`）→ 于是 `MetadataFilter.origins/processes` **对知识条目恒不命中**。也就是说：**现在即使新建了 linking，也无法用它去过滤知识**。
2. **`knowledge/` 目录的富知识库（v51 来源 / 15 篇带 `applicability`）尚未接入 App**——App 仍在读 v1 的 16 篇（`knowledge/README.md:42`）。

### 7.2 既有实现里发现的一个真实缺陷（影响增量索引）

`CoffeeKnowledgeDocument.contentHash` 用 Swift `Hasher`（`RAG/Core/CoffeeKnowledgeDocument.swift:141-146`），而 `Hasher` **每进程随机播种** → 同一 `(title, content)` 跨启动得到不同 hash，却被持久化进 `EmbeddingRecord.contentHash` 并跨启动比较（`IndexCoordinator.swift:130-139`）。后果：**冷启动后增量判断会退化为全量重算**（功能正确、性能退步）。建议在 Linking 动工时顺手换成稳定哈希（如 FNV-1a 或 SHA-256 截断）。

## 8. 最适合的 Bean Context 接入点

**新建** `RAG/Linking/`，输入 `Bean`（+ 可选 `Brew`），输出 **`BeanContext`** 值类型。**不触碰 `Bean` 模型**。

必须复用的既有资产（避免重复造）：

| 需要的能力                       | 已有实现                                  | 位置                                           |
| --------------------------- | ------------------------------------- | -------------------------------------------- |
| 文本归一化（全角→半角、小写）             | `LexicalEmbeddingProvider.normalised` | `Embedding/LexicalEmbedding.swift:64-67`     |
| 「别名 → canonical」+ 整串/分词两级匹配 | `FlavorAliasIndex`                    | `ML/FlavorModelResources.swift:101-147`      |
| 方法家族归一化                     | `MethodRules.family(of:)`             | `RAG/Weather/MethodRules.swift:49-57`        |
| 方法/器具/处理法别名组                | `QueryRules.matchedGroups`            | `Retrieval/QueryAnalyzer.swift:307-313`      |
| 处理法判定样板                     | `IntelligenceConfig.processIs(_:)`    | `Rules/IntelligenceConfig.swift:85-87`       |
| JSON 词表加载（且**避开本地化收键**）     | `BundleResource`                      | `Shared/Utilities/BundleResource.swift:7-41` |

**归一化/实体词表的现成语料**（本节最重要的发现）：

- `Resources/flavor_mapping.json:12-103` 的 `aliases`：**6 国 + 18 产区 + 7 品种 + 4 处理法 + 5 烘焙 + 6 冲煮法**，各带中英别名（如 `Ethiopia ← ethiopia/埃塞俄比亚/埃塞/衣索比亚`、`Washed ← wash/水洗/水洗处理/湿法`、`Gesha ← geisha/瑰夏/艺伎`）。
- `Resources/feature_schema.json:121-212` 的 `onehot_categories`：同一批**规范类别名**（拼写以模型为准）。
- `Resources/query_rules.json:61-84`：methods / devices / processes 的检索别名组。

→ **§八 标准化词典 与 §九 EntityResolver 的「别名表」部分不需要从零建**，但**缺少两样**：  
(a) **产地/品种的层级关系**（国家 → 产区 → 大区，规格 §十五/§十八 的 Guji → Ethiopia → East Africa）——现有数据是**平的**；  
(b) `process` 的层级（Washed → 具体发酵法）与 `equipment` 层级（Breville → Barista Express → BES870）——后者**无数据源**（见 §4）。

## 9. 最适合的 Knowledge Linking 接入点

**新建** `RAG/Linking/KnowledgeLinkingService`，输出 `BeanKnowledgeContext{directLinks, relatedLinks, genericKnowledge, recommendedKnowledge}`（规格 §十四）。

接入方式（**不改 `Bean`**，改动集中在 RAG 索引与元数据三处）：

```
Bean (SwiftData)
   │
   ├─ BeanContextResolver ──→ BeanContext{origin, process, roast, freshness, method, equipment★}
   │                                   │  ★ equipment 暂无数据源
   │
   ├─ EntityResolver + EntityGraph（新，JSON 驱动）
   │        └─→ [KnowledgeEntity]（含层级 parentId）
   │
   ├─ KnowledgeLinkingService
   │        └─→ [BeanKnowledgeLink]（值类型，MatchType: exact/normalized/alias/hierarchy/general_context）
   │
   └─ 检索层（既有）
            ├─ MetadataFilter  ← 新增 entityIds / roastLevel / roaster / applicability 维度
            ├─ HybridRetriever / VectorIndex（既有，不动）
            └─ KnowledgeBase    ← 解析 v2 富字段，写入 entityIds/origin/process/applicability
```


**三个必须同时做的改动**（否则 linking 只是死数据）：

1. `RAG/Core/CoffeeKnowledgeDocument.swift`：给 `DocumentMetadata` **加字段**（`entityIds: [String]?`、`applicability: [String]?`、`scope: String?`）。
   - 依据：该结构自带注释「以后加字段不必动存储层」（`:34-40`），且 `EmbeddingRecord.metadataJSON` 注释明确「JSON 那份留着，以后加过滤维度不必改表」（`EmbeddingRecord.swift:27-35`）。
   - **不新增 @Model、不改表结构。**
2. `RAG/Store/MetadataFilter.swift`：加对应匹配分支（entityIds 集合相交；`roastLevel`/`roaster`/`applicability` 归一化匹配）。
3. `RAG/Indexing/KnowledgeBase.swift`：解析 v2 的 `sourceIds/authorityTier/applicability/entities` 等字段并写入上面两个结构（v1 缺这些字段 → 为 nil，向后兼容）。

**关于 `BeanKnowledgeLink` 是否落库（规格 §十一 有 `createdAt/updatedAt` 字段）：**

- **推荐 V1 不落库**：Bean 的 `origin/process` 可被编辑、图谱数据随包发布、link 是纯确定性推导 → 落库只会引入**失效维护**成本。
- 做法：`BeanKnowledgeLink` 定义为**值类型**（`struct`），由 `KnowledgeLinkingService` 现算 + 进程内缓存（键 = Bean 属性指纹）。这样「核心模型存在」（满足 §十一）但**零迁移风险**。
- 若将来需要「用户手工确认/修正关联」或「跨会话沿用」，再升级为 `@Model`（属「只加实体」的轻量迁移，且仓库已有先例注释）。

## 10. 需要新增的文件

**核心 Linking 层（新建）**

| 文件                                                     | 内容                                                                    |
| ------------------------------------------------------ | --------------------------------------------------------------------- |
| `BrewPhase/RAG/Linking/BeanContext.swift`              | `BeanContext` / `BeanProfile` 值类型（§六/§七）                              |
| `BrewPhase/RAG/Linking/BeanContextResolver.swift`      | Bean → BeanContext（§七）                                                |
| `BrewPhase/RAG/Linking/NormalizationDictionary.swift`  | 读 JSON 词表，提供 `normalise(_:kind:)`（§八）                                 |
| `BrewPhase/RAG/Linking/KnowledgeEntity.swift`          | `KnowledgeEntity` + `EntityType`（§十）                                  |
| `BrewPhase/RAG/Linking/EntityGraph.swift`              | 层级图 + 祖先/后代（§十八、§十五）                                                  |
| `BrewPhase/RAG/Linking/EntityResolver.swift`           | 文本 → 实体（§九）                                                           |
| `BrewPhase/RAG/Linking/BeanKnowledgeLink.swift`        | `BeanKnowledgeLink` + `RelationType` + `MatchType`（§十一）               |
| `BrewPhase/RAG/Linking/KnowledgeScope.swift`           | scope 模型（§十三）                                                         |
| `BrewPhase/RAG/Linking/KnowledgeLinkingService.swift`  | → `BeanKnowledgeContext`（§十四/§十五）                                     |
| `BrewPhase/RAG/Linking/KnowledgeSearchService.swift`   | `search / searchByBean / searchByEntity / searchByScope / …`（§十九/§二十） |
| `BrewPhase/RAG/Linking/PersonalKnowledgeService.swift` | Bean ↔ Brew ↔ Tasting 关联（§二十五）                                        |
| `BrewPhase/RAG/Linking/BeanKnowledgeInsight.swift`     | → `InsightResult`（§二十八），复用 `Insight`/`InsightFormatter`               |

**新增资源（JSON，避开本地化收键）**

| 文件                                              | 内容                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| `BrewPhase/Resources/knowledge_entities.json`   | 实体 + 别名 + `parentId` 层级（origin/region/大区、process、roast、brew_method、equipment、sensory） |
| `BrewPhase/Resources/entity_normalization.json` | 或直接复用 `flavor_mapping.json`（建议复用 + 只补层级）                                              |

**UI（新建）**

| 文件                                                       | 内容                         |
| -------------------------------------------------------- | -------------------------- |
| `BrewPhase/Features/Bean/BeanKnowledgeSection.swift`     | Bean Detail「关于这包豆」区块（§三十一） |
| `BrewPhase/Features/Brew/RelevantKnowledgeSection.swift` | Brew 页「与本杯相关」（§三十二/§三十三）   |

**测试（新建）**

| 文件                                           | 内容                            |
| -------------------------------------------- | ----------------------------- |
| `BrewPhaseTests/KnowledgeLinkingTests.swift` | §五十一 的 8 类测试 + §五十六 的 5 个验收场景 |

## 11. 需要修改的文件

| 文件                                        | 改动                                                   | 风险                                  |
| ----------------------------------------- | ---------------------------------------------------- | ----------------------------------- |
| `RAG/Core/CoffeeKnowledgeDocument.swift`  | `DocumentMetadata` 加 `entityIds/applicability/scope` | 低（Codable 值类型，旧记录反解为 nil）           |
| `RAG/Store/MetadataFilter.swift`          | 加过滤维度                                                | 低                                   |
| `RAG/Indexing/KnowledgeBase.swift`        | 解析 v2 富字段                                            | 低（白名单式，缺字段为 nil）                    |
| `RAG/Indexing/DocumentBuilder.swift`      | `beanDocument` / `brewDocument` 填 `entityIds`        | 低                                   |
| `RAG/Recommend/Insight.swift`             | `Kind` 增 `beanKnowledge`（+ 可选 `equipmentGuidance`）   | 低（枚举加 case，需处理 `switch` exhaustive） |
| `RAG/Indexing/IndexCoordinator.swift`     | （可选）修 `contentHash` 稳定化；加重建触发                        | 中（需重建索引验证）                          |
| `Features/Bean/BeanDetailView.swift`      | 插入知识区块                                               | 低                                   |
| `Features/Brew/BrewEditorView.swift`      | 插入相关知识区块                                             | 低                                   |
| `Tools/Localization/strings.py`           | 新文案的英文                                               | 必须同步，否则 `generate.py` FAIL          |
| `BrewPhase/Resources/knowledge_base.json` | **（可选）换用 v2**                                        | 见决策点 B                              |

## 12. 依赖变化

- **零第三方依赖**。全部复用 Foundation / Accelerate / SwiftData / NaturalLanguage。
- **不需要** SQLite 向量扩展、不需要云端、不需要 LLM（与规格 §二/§三十九 一致）。
- 向量检索维持现有**暴力余弦**：既有性能门限测试 `InsightsTests.testDemoScaleSyncAndSearchStayInteractive` 断言 <2.0s，V1 报告实测 291ms；demo 规模下不需要 ANN。
- 资源增量：`knowledge_entities.json` 约 +30–80KB；若换 v2 知识库约 +100–200KB。
- 工程文件：`Resources/` 使用 `PBXFileSystemSynchronizedRootGroup`（`project.pbxproj:24-35`）→ **文件放进目录即自动纳入，无需手工登记**。

## 13. 数据迁移风险

| 变更                            | 迁移风险            | 说明                                                                                                                                                                                 |
| ----------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **不改 `Bean`**（推荐）             | **零**           | 不新增列、不新增 `@Model` → 无 schema 变更                                                                                                                                                    |
| 给 `DocumentMetadata` 加字段      | **零 schema 变更** | 存在 `metadataJSON`；旧 `EmbeddingRecord` 反解缺字段为 nil。**但需 `rebuildIndex(force: true)` 才能让新 metadata 生效**                                                                               |
| 新增 JSON 资源                    | **零**           | 随包资源                                                                                                                                                                               |
| 新增 UI 区块                      | **零**           |                                                                                                                                                                                    |
| （若采纳）给 `Bean` 加 `variety` 等字段 | **中**           | SwiftData 轻量迁移可加列，但仓库**无 `VersionedSchema` 保护**，且需同步 `ExportDTO`（`formatVersion` 目前只有往返校验、无升级逻辑，`ExportManager.swift:174-181`）→ 需提升 `formatVersion`。**建议 V1 不做**（§六 明确「不得硬造数据库字段」） |
| （若采纳）`BeanKnowledgeLink` 落库   | **低**           | 属「只加实体」轻量迁移，有先例注释；但引入失效维护成本 → **建议 V1 不落库**                                                                                                                                        |
| 换用 v2 `knowledge_base.json`   | **低**           | 需重建索引；且 v2(15 篇) 与 v1(16 篇) 内容不完全重合 → 需逐篇对齐                                                                                                                                        |

---

## 附：本次审查发现、但不属于本任务范围的既有问题

1. **`contentHash` 跨启动不稳定**（§7.2）——功能正确、性能退步。
2. **`MetadataFilter` 缺 `roaster/roastLevel/category/reference/note` 维度**，且 `EmbeddingRecord` 只有单数 `beanID` 热列。
3. **`sourceAdjust` 权重硬编码在 `HybridRetriever`**，未进 `IntelligenceConfig`（与该文件「全部可调参数集中一处」的既定原则不一致）。
4. **`knowledge/` 富知识库未接入**——`applicability`（含 `specific_model`）已在产物里，但 App 读不到，所以 §十三/§五十九 的「型号优先排序」暂时无法实现。

---

## 待确认的决策点（阻塞编码）

| #     | 决策                        | 选项                                                                                               |
| ----- | ------------------------- | ------------------------------------------------------------------------------------------------ |
| **A** | `BeanKnowledgeLink` 是否落库  | A1 值类型、现算不落库（推荐，零迁移）／ A2 建 `@Model` 持久化                                                          |
| **B** | 知识库数据源                    | B1 保持 v1(16 篇) 只在其上做 metadata 增强 ／ B2 换用 v2(15 篇，带 `applicability`/`sourceIds`) ／ B3 先合并再换       |
| **C** | `Equipment` 上下文范围         | C1 V1 明确 defer（无数据源，只做 `Brew.method` 的知识匹配）／ C2 只做「冲煮方式」级（不做 brand/model）／ C3 先补 Equipment 数据源再做 |
| **D** | 是否给 `Bean` 加 `variety` 字段 | D1 不加（推荐，从 name/notes 尽力识别）／ D2 加字段（需同步 ExportDTO + formatVersion）                               |
