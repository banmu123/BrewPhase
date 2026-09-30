# Bean → Knowledge Linking V1 — 交付报告（规格 §五十七）

> 日期 **2026-09-30**。前置：`Tools/Bean-Linking-Architecture-Review.md`（规格 §五 的 13 项审查）。
> 决策：A1 值类型不落库 ｜ B2 换用 v2 知识库 ｜ C1 设备只做方式级、明确 defer 型号 ｜ D1 不加 `variety` 字段。

---

## 0. 一句话结论

Bean → Knowledge Linking 层已建成并接入两个页面。**203 条本地可执行校验通过**（206 项数据/算法检查 + 667 键本地化 + 20 个 JSON + 11 个新文件括号平衡）。

**但有一件事必须写在最前面：本机是 Windows，没有 Xcode，所以我没能编译 Swift，也没能跑 XCTest。** 15 项新测试已写好但**未执行**。请在有 Xcode 的机器上跑一次（命令见 §14）。

---

## 1. 实际修改的文件

| 文件 | 改动 |
|---|---|
| `BrewPhase/Resources/knowledge_base.json` | **v1（16 篇）→ v2（19 篇）**，每条带 `sourceIds` / `authorityTier` / `applicability` / `scope` / `entityIds` |
| `BrewPhase/RAG/Core/CoffeeKnowledgeDocument.swift` | `DocumentMetadata` 加 `entityIds` / `scope` / `authorityTier`；**`contentHash` 换成 FNV-1a**（原 `Hasher` 每进程随机播种，导致冷启动后增量索引退化为全量重算） |
| `BrewPhase/RAG/Store/MetadataFilter.swift` | 新增 `entityIDs`（集合相交）与 `scopes` 两个过滤维度 |
| `BrewPhase/RAG/Indexing/KnowledgeBase.swift` | `KnowledgeDocument` 加富字段并解析；`documents()` 把 `entityIds/scope/authorityTier` 写进 metadata；`categoryLabel` 补 v2 分类 |
| `BrewPhase/RAG/Indexing/DocumentBuilder.swift` | Bean / Brew / Tasting 三条资料路径都填 `entityIds`（用户记录也能被实体过滤命中） |
| `BrewPhase/Features/Bean/BeanDetailView.swift` | 插入「关于这包豆」区块 + `languageCode` |
| `BrewPhase/Features/Brew/BrewEditorView.swift` | 插入「与本杯相关」区块（在参数之后、评分之前） |
| `Tools/Localization/strings.py` | 新增 62 条英文翻译 |
| `BrewPhase/en.lproj/Localizable.strings`、`zh-Hans.lproj/Localizable.strings` | 由 `generate.py` 重生成（605 → **667 键**） |
| `knowledge/_build/documents.json` | 新增 4 篇**实体级通识**文档（产地层级模型 / 品种目录用法 / 处理法族 / 烘焙度与萃取），并给 19 篇显式声明 `scope` |
| `Tools/knowledge/build_kb.py` | 新增：实体解析 → `entityIds`、显式 scope 优先、**校验引用的实体必须存在** |

**没有改的东西（有意为之）**：任何 `@Model`、`App/BrewPhaseApp.swift` 的 schema、`ExportDTO`、`Insight` / `InsightFormatter`、`HybridRetriever`、`RecommendationEngine`、`VectorIndex`。

## 2. 新增文件

**Swift（10 + 1 测试）**

| 文件 | 职责 |
|---|---|
| `BrewPhase/RAG/Linking/KnowledgeEntity.swift` | `EntityType` / `EntityScope` / `KnowledgeEntity` / `EntityResolution` / `RelationType` / `MatchType` |
| `BrewPhase/RAG/Linking/EntityGraph.swift` | 实体图：索引、resolve、祖先/后代/路径 |
| `BrewPhase/RAG/Linking/BeanContext.swift` | `BeanContext` + `BeanContextField` |
| `BrewPhase/RAG/Linking/BeanContextResolver.swift` | Bean → BeanContext |
| `BrewPhase/RAG/Linking/BeanKnowledgeLink.swift` | `BeanKnowledgeLink` / `KnowledgeEvidence` / `BeanKnowledgeContext` |
| `BrewPhase/RAG/Linking/KnowledgeSearchService.swift` | 规格 §十九 的五类检索 + 语义入口 |
| `BrewPhase/RAG/Linking/KnowledgeLinkingService.swift` | 建边 + 组装四档知识（§十四/§十五） |
| `BrewPhase/RAG/Linking/PersonalKnowledgeService.swift` | Bean ↔ Brew ↔ Tasting 的个人证据（§二十四/§二十五） |
| `BrewPhase/RAG/Linking/BeanKnowledgeInsight.swift` | `EvidenceAuthority` / `InsightResult` / 确定性模板（§二十六/§二十八/§二十九） |
| `BrewPhase/Features/Bean/BeanKnowledgeSection.swift` | `BeanKnowledgeSection` + `RelevantKnowledgeSection` + `InsightResultCard` |
| `BrewPhaseTests/KnowledgeLinkingTests.swift` | 15 项测试（§五十一 八类 + §五十六 五场景） |

**资源（1）**：`BrewPhase/Resources/knowledge_entities.json` — **122 个实体**（topic 19 / origin 25 / region 17 / variety 23 / varietyGroup 5 / process 5 / roast 6 / brewMethod 11 / brewFamily 4 / sensory 7），带别名与 `parentId` 层级。

**工具（1）**：`Tools/knowledge/verify_linking.py` — 数据与算法的 Python 参照实现，**206 项检查**。

## 3. 数据模型

**没有新增任何 `@Model`。** 这是 A1 决策的直接结果：

| 类型 | 是否落库 | 理由 |
|---|---|---|
| `KnowledgeEntity` | 否（随包 JSON） | 词表是数据不是记录，随版本发布更简单 |
| `BeanKnowledgeLink` | 否（值类型） | `Bean.origin`/`process` 可改、图谱随包、推导确定 ⇒ 落库只会引入失效维护 |
| `BeanContext` / `BeanKnowledgeContext` / `KnowledgeEvidence` / `Summary` / `InsightResult` | 否（值类型） | 纯计算结果 |

`DocumentMetadata`（既有 Codable 值类型，存在 `EmbeddingRecord.metadataJSON`）**扩展了 3 个字段** → 旧记录反解为 nil，**零 schema 变更、零迁移**。

## 4. Bean Profile 设计

规格 §六 的字段清单里，App 实际只有：`origin`（「国家 · 产区」合一的本地化串）、`process`（本地化串）、`roaster`、`roastLevel`（稳定枚举）、`roastDate/openDate`、`flavorTags`（稳定英文 id）、`notes`。

**没有** `variety` / `altitude` / `farm` / `producer` / `subRegion` / `fermentation`。
→ 依 §六「不得硬造数据库字段」与决策 D1：**没有加列**。品种从 `name` + `notes` **尽力识别**，识别不到就是 `missingFields` 里的 `.variety`。

`BeanContextField` 让「缺什么」成为一等公民——这是 §十六/§十七 的落地点。

## 5. Bean Context Resolver

`BeanContextResolver.context(for:method:today:)`。七步，全部是**翻译**而非推断：

1. `origin` → 用 `{origin, region}` 类型解析（`"埃塞俄比亚 · Guji"` 一次出两个）
2. `name` + `notes` → `{variety, varietyGroup}`
3. `process` → `{process}`
4. `roastLevel` 枚举 → 直接映射实体 id，标 `.inferred`（枚举无歧义，不走文本匹配）
5. `flavorTags` → `{sensory}`
6. 冲煮方式（入参优先，否则最近一次冲煮）
7. **层级展开**：只向上补祖先，标 `.hierarchy`

**硬规则：只向上，绝不向下。** 只写「Guji」会得到 `region.guji` + 由层级推出的 `origin.ethiopia`（§五十一 明确要求）；但只写「Ethiopia」**不会**生出 Guji / Washed / Heirloom（§十二/§十七）。

## 6. Entity Resolver

`EntityGraph.resolve(_:types:limit:)`，四级：规范名整串（`.exact` / `.normalized`）→ 别名整串（`.alias`）→ 包含匹配（`.alias` / `.normalized`）× 双向 → 层级（`.hierarchy`，由 Resolver 补）。

归一化复用 `LexicalEmbeddingProvider.normalised` + 去分隔符（与 `MetadataFilter`、`build_kb.py` 同一套，避免「过滤命中、链接不命中」）。

**实测评出来的坑**：短别名必须只在整串相等时命中。首版别名「水」让「浅烘水洗」误命中了 `topic.water`；现在归一后不足 2 字符的别名只允许精确匹配，并有一条专门的测试钉住。

## 7. BeanKnowledgeLink

```swift
struct BeanKnowledgeLink { beanID, entity, relation, match, confidence, evidence }
```
`confidence` 只由 `match.priority` 决定（完全匹配 1.0 → 背景关联 0.4），**不做平滑、不做加权叠加**——一个抖动的百分数比一个诚实的「层级匹配」更容易被误读，而且没法写测试。

`directLinks`（exact/normalized/alias/inferred/userSelected）与 `relatedLinks`（hierarchy/generalContext）**分组返回**，§十二 的「不许把泛化当事实」因此是**结构上**保证的，不是靠文案。

## 8. Knowledge Search

`KnowledgeSearchService` — 与既有 `HybridRetriever` 分工明确：

| | 输入 | 用 embedding |
|---|---|---|
| `HybridRetriever`（既有） | 用户的一句**问题** | 是 |
| `KnowledgeSearchService`（新） | 一包**豆子的属性** | 主路径否 |

实现规格 §十九 全部入口：`search(query)`、`searchByBean`、`searchByEntity`、`searchByScope`、`searchByMethod`、`searchByEquipment`，外加 `evidence(forEntityIDs:)` / `genericEvidence` / `semanticEvidence`。

排序是**确定性公式**：基线 0.45 + 命中实体 0.25 + 范围具体度 0.15 + 权威等级 0.10 + 词法重合 0.30（仅查询时）。

## 9. Metadata Filter

新增两个维度：

- `entityIDs` — **集合相交**，不是子串。文档带 `entityIds: [String]`，过滤条件是「豆子解析出的实体」，任一对上即命中。
- `scopes` — 按 `EntityScope` 精确匹配。

这是本次**唯一真正打通的关键一环**：v1 时代知识条目的 `metadata.origin/process` 全是 nil，所以 `MetadataFilter.origins/processes` 对知识**恒不命中**；现在 knowledge_base v2 每条都带 `entityIds`，实体过滤才真的对知识生效（有测试 `testEntityFilterMatchesKnowledgeNotJustUserRecords`）。

## 10. Semantic Search

`semanticEvidence(query:languageCode:entityIDs:provider:index:limit:)`，`@MainActor`。

它做的是**先按实体收窄范围、再算相似度**——正是 §三 反对做法（问题 → embedding → TopK）的反面。`VectorIndex` 与 `EmbeddingProvider` 由调用方注入（`AskEngine` 已持有），本层不造索引、不引依赖。

## 11. Rule Engine

**没有新建 RuleEngine。** 规格 §三十五 要的六条规则里，五条已经存在，本次只做接线：

| 规格要求 | 现状 | 本次动作 |
|---|---|---|
| `FreshnessRule` | `PhaseEngine` + `PhaseRuleBook` | 不动 |
| `PriorityRule` | `Core/PriorityEngine` | 不动 |
| `PersonalBestRule` | `PersonalBestAnalyzer` | `PersonalKnowledgeService` 包一层 |
| `ParameterDeviationRule` | `ParameterDeviationAnalyzer` | 不动 |
| `SimilarHistoryRule` | `RecommendationEngine.similarHistory` | 不动 |
| `EquipmentCompatibilityRule` | — | **V1 不做**（无 Equipment 数据源，见 §16） |

## 12. Recommendation Engine

**没有新建 RecommendationEngine。** 新增的是「知识侧」的推荐组装：
`BeanKnowledgeInsight.brewRelevant` 在个人证据足够时产出**来自用户自己区间**的建议，并把依据标成 `.inference`；证据不足时 `recommendation` 为 `nil`（§四十九）。

优先级按 §二十七：问「我这包豆以前怎么冲最好」时，`personalComesFirst` 为真 → USER_DATA 优先；否则知识兜底。

## 13. UI

- **Bean Detail**：`FlavorWindowCard` 之后插入「关于这包豆」——摘要 + 实体关联事实 + 证据行（每行带**归属标记**：你的记录 / 知识库 / 分析）+ 出处署名 + 局限说明。
- **Brew 页**：参数之后、评分之前插入「与本杯相关」——相关知识与记录 + 个人区间建议 + 「一次只改一个变量」的通用提醒。

`InsightResultCard` 是两处共用的渲染，规格 §二十六 的三种归属在**每一行**上标注。

## 14. 测试结果

**⚠️ 未执行。** 本机是 Windows，没有 Xcode / swiftc，无法编译或运行 XCTest。

**已写好的 15 项**（`BrewPhaseTests/KnowledgeLinkingTests.swift`）：八类 §五十一 断言（归一化 ×2、精确链接、部分档、设备特异性、用户数据优先、相似度、证据不足）+ §五十六 五场景 + 两条结构断言。

**在有 Xcode 的机器上请跑：**

```bash
xcodebuild test -project BrewPhase.xcodeproj -scheme BrewPhase -destination 'platform=iOS Simulator,name=iPhone 16'
python Tools/Localization/check.py
python Tools/knowledge/build_kb.py --check
python Tools/knowledge/verify_linking.py      # 这三条在 macOS 上同样可跑，不依赖 Xcode
```

**已经跑过并通过的（本机）**：

| 检查 | 结果 |
|---|---|
| `verify_linking.py`（数据与算法参照实现） | **206 / 206 通过** |
| `Tools/Localization/check.py` | 667 键，两表完整，占位符一致 |
| `build_kb.py --check` | 51 来源 / 122 实体 / 19 文档，引用完整性通过 |
| JSON 有效性 | 20 个文件全部合法 |
| 11 个新 Swift 文件括号平衡 | 全部通过 |

`verify_linking.py` 证明的是**数据与算法设计**正确，**不能**替代编译——所以 §14 的第一句话是「未执行」，而不是「测试通过」。

## 15. 当前支持的知识关联类型

| `RelationType` | 来源 | 状态 |
|---|---|---|
| `origin`（含 region） | 图谱 | ✅ 有知识 |
| `variety`（含 varietyGroup） | 图谱（WCR 血统分组） | ⚠️ 仅从豆名/备注尽力识别 |
| `process` | 图谱 | ✅ 有知识 |
| `roast` | 枚举直映射 | ✅ 有知识 |
| `recommended_brew`（含 brewFamily） | 图谱 | ✅ 有知识 |
| `sensory` | 图谱（含「干涩/尾段干/余韵涩」等同义） | ⚠️ 靠 flavorTags，覆盖有限 |
| `freshness` | 未做（`daysSinceRoast/Open` 已在 context 里，但未挂知识实体） | ❌ |
| `equipment` | — | ❌ V1 defer |
| `generalContext` | topic 兜底 | ✅ 有知识 |

## 16. 当前支持的设备匹配能力

**这一项是本次最需要说清的能力边界（决策 C1）：**

- **支持**：`searchByEquipment(model)` 会在设备串同时是**冲煮方式**时退到方式级（「V60」→ V60 冲煮知识）。这是诚实且有用的退化。
- **不支持**：品牌级 / 型号级设备知识。仓库里**没有 Equipment 模型**，图谱里也**没有** `equipment_brand` / `equipment_model` 节点——`EquipmentCompatibilityRule`（§三十五）与 `getKnowledgeForEquipment`（§二十三）V1 不提供。
- **保证**：`searchByEquipment("Barista Express")` 返回**空**，而不是拿别的知识凑数（有测试钉住）。

## 17. 当前不足

1. **Swift 未编译、测试未运行**（本机限制）。这是最大的未验证项。
2. **知识面薄**：知识库只有 19 篇，其中只有 13 篇带实体；「埃塞俄比亚」这类国家页不存在 → 大量查询会落到 `generic` 兜底。**但这条路是按设计走的**（§五十：宁可说「没有具体资料」）。
3. **品种识别弱**：没有 `variety` 字段（D1），只能从豆名/备注认。`Gesha`/`SL28` 这类别名能认出，中文俗名靠别名表。
4. **`sensory` 覆盖有限**：图谱只挂了 7 个感官实体，`FlavorLibrary` 的标签多数对不上。
5. **`freshness` 没接入**：`BeanContext` 已经带了 `daysSinceRoast/Open`，但没有对应的知识实体与文档。
6. **`search(query:)` 是词法的**，不是语义——语义路径在 `semanticEvidence`（需注入索引），UI 还没接。
7. **`relatedKnowledge` 的实体集合可能一次全塞进去**：为了不因 limit 截断而漏，我给 `limit` 传的是文档总数——数据量大了要改成带排名的截断。

## 18. 后续建议

1. **第一件事：在 macOS 上编译并跑测试**，把编译错误修掉（我用 `verify_linking.py` 覆盖了数据与算法，但 Swift 的 actor 隔离、类型形态只能靠编译器）。
2. 补 **`freshness` 实体 + 文档**（`BeanContext` 已有数据，只差挂知识）。
3. 扩 **知识库实体覆盖**：优先给常见的国家/产区各写一条有来源的页面（我的 `knowledge/origins/` 已有素材，但**不做国家级风味承诺**）。
4. 接 **`semanticEvidence` 到 UI**：Brew 页在实体范围内做一次语义检索，补「换了说法也能找到」。
5. **`equipment` 从长计议**：先加 `Equipment` 实体（`@Model`）+ 手工录入品牌/型号，再实现 `EquipmentCompatibilityRule`。这是 §二十三 的完整形态。
6. **`contentHash` 变更会导致一次全量重索引**——这是修 bug 的代价，一次性，不用回滚。
