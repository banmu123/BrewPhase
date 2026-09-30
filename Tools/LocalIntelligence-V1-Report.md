# BrewPhase Local Intelligence V1 — 交付报告

> 结论一句话：**V1 闭环完成——结构化查询 + 语义检索 + 规则引擎 + 模板化推荐，全链路
> 不用 LLM、不用服务器、不用账号；220 项测试全绿，演示规模一次分析 291 ms。**

---

## 1–3. 修改 / 新增 / 删除的文件

**新增（41 个文件，约 5,300 行）**

| 路径 | 职责 |
|---|---|
| `RAG/Core/CoffeeKnowledgeDocument.swift` | 统一可检索文档抽象（§9）：id / sourceType / sourceId / title / content / metadata / updatedAt，metadata 带类型化过滤字段 |
| `RAG/Core/RAGSettings.swift` | 偏好值类型；V1 强制回答引擎 = 本地抽取式（§二红线），枚举与 provider 保留为接口 |
| `RAG/Indexing/DocumentBuilder.swift` | 用户数据 → 自然语言 representation（§10）：Bean/Brew/Tasting/偏好 → 可读句子，不是字段转储；处理 Brew↔Tasting 镜像去重 |
| `RAG/Indexing/KnowledgeBase.swift` + `Resources/knowledge_base.json` | 本地静态知识库（§26）：16 篇双语条目（V60/研磨/水温/粉水比/休息期…），source 恒为 App 自制 |
| `RAG/Embedding/EmbeddingProvider.swift` | 抽象（§11）：embed/embedBatch/dimension/modelIdentifier，业务层不碰具体 SDK |
| `RAG/Embedding/AppleSentenceEmbedding.swift` | 默认实现：NLEmbedding 端侧句向量（中文 640 维 / 英文 512 维，离线） |
| `RAG/Embedding/LexicalEmbedding.swift` | 词法兜底：无模型也能跑，确定性匹配 |
| `RAG/Embedding/EmbeddingProviderFactory.swift` | 按设置解析 provider；换模型/语言自动作废重建向量空间 |
| `RAG/Store/*`（VectorIndex/SwiftDataVectorIndex/EmbeddingRecord/VectorMath/MetadataFilter） | 向量存储（§12–13）：挂在既有 SwiftData 上，不引入任何向量数据库；Accelerate 余弦 + L2 归一化；支持 beanId/sourceType/method/device/dateRange/score 过滤（§16） |
| `RAG/Indexing/IndexCoordinator.swift` | 索引生命周期（§14）：内容哈希增量同步、provider 变更自动重建、`rebuildIndex()` |
| `RAG/Retrieval/*`（QueryPlan/QueryAnalyzer/StructuredRetriever/HybridRetriever/RetrievedPassage）+ `Resources/query_rules.json` | 混合检索（§15）：结构化直查 + 向量检索 + 元数据过滤；意图识别规则放 JSON（避免被本地化流水线收编）；融合权重集中在 `IntelligenceConfig`（§17） |
| `RAG/Rules/IntelligenceConfig.swift` | **全部可调参数集中一处**（§17）：样本阈值 N=3、高评分线=4、相似度权重 0.62/质量 0.16/时效 0.16、展示容差 |
| `RAG/Rules/PersonalBestAnalyzer.swift` | Rule 2 个人最佳（§19）：高评分记录的参数统计 + 最佳单次；只存值类型，不持有 @Model |
| `RAG/Rules/ParameterDeviation.swift` | Rule 3 参数偏离（§20）：当前冲煮 vs 个人常用区间，措辞红线「和你常用的不一样」，从不说「错」 |
| `RAG/Recommend/Insight.swift` | 可解释结论结构（§29）：result + reasons + evidence + confidence，值类型 |
| `RAG/Recommend/RecommendationEngine.swift` | 推荐引擎（§22）：todayPick（纯规则，不用 embedding，§23）/ personalBest / deviation / similarHistory（唯一语义入口，§21） |
| `RAG/Recommend/InsightFormatter.swift` | 模板层（§28）：模板只管措辞，**禁止字面量数字**；措辞跟着紧急程度走 |
| `RAG/Recommend/IntelligenceCapability.swift` | 能力状态（§36）：structuredQuery / semanticSearch / knowledgeBase / recommendation 各自可用性 |
| `RAG/Answering/*` | V1 回答 = 抽取式模板（AnswerComposer 链上唯一引擎）；LLMProvider 协议与 Ollama / Foundation Models provider **保留为接口但不在链上**（§41/§42 的预留） |
| `RAG/AskEngine.swift` | 问一问的完整链路（保留自上一轮 RAG，回答层已切到 V1） |
| `Features/Insights/InsightsView.swift` | 主界面（§30–32）：非聊天式卡片——今日建议 / 相似冲煮 / 我的最佳参数 / 历史分析 |
| `Features/Settings/AskSettingsSection.swift` | 更多页区块：双入口 + 总开关 + 检索档位 + 索引重建；**LLM 引擎选择与 Ollama 配置已随 V1 移出界面** |
| `BrewPhaseTests/InsightsTests.swift` | 五类验收场景（§44 Case 1–5）+ 能力状态 + 性能门限 + 模板红线 |

**修改**：`MoreView`（+洞察区块）、`DebugLaunch`/`BrewPhaseApp`（+insights 调试屏）、
`DemoData`（冲煮记录补 `brewID` 回链，修孤儿风味记录）、`BrewMath`（trimmed 归位）、
`strings.py`（V1 文案，572 键）、`run.sh`。其余 diff 名单（`LanguageManager`、`ImageStore`、
`PhotoFieldView`、`RoastLevel` 等）属于此前几轮的并发修复与风味模型对接，与 V1 无关。

**删除**：无。

## 4–10. 数据流（五类问题的路径）

```text
Case 3「今天该喝哪包」:  beans → PriorityEngine（既有规则）→ InsightFormatter → 卡片
                         （纯结构化，不碰 embedding，§23）
Case 1「怎么冲最好」:    brews → PersonalBestAnalyzer（高分记录统计）→ 模板 → 卡片
Case 4「区别在哪」:      current + history → ParameterDeviationAnalyzer → 模板 → 卡片
Case 2「类似干涩」:      文本 → EmbeddingProvider → VectorIndex（带 beanID 过滤）
                         → 相似记录 → 分布统计（只报事实，不编因果，§21）
问一问（保留）:          问题 → QueryAnalyzer(意图) → 结构化+向量+知识库 → 证据 → 模板
```

Embedding 流程：数据变更 → 内容哈希比对 → 只重算变化的文档 → 归一化入库（带
modelIdentifier，混空间自动重建）。后台执行不阻塞 UI（§33）；embedding 不可用时
词法兜底，结构化查询与规则不受影响（§35）。

## 11. 测试结果

**220 + 1（性能）= 221 项全绿，`TEST SUCCEEDED`。** 其中 V1 新增 13 项：
Case 1（最佳参数含证据行数字断言）、Case 5（insufficientEvidence 且 N=3 是系统真实值）、
Case 3（排序与 PriorityEngine 一致 + 养豆期不说「优先」）、Case 4（偏离点名 + 方向 +
**「错」字红线** + 范围内不报）、Case 2（词法确定性命中 + beanID 过滤不混包）、
能力状态、性能门限、模板数字全来自真实数据。本地化 `check.py` 通过（572 键，
占位符逐条核对）。

## 12. 性能

演示规模（6 包豆 + 20+ 条记录 + 16 条知识库）：**一次完整分析（同步 + 向量化 + 检索
+ 排版）291 ms**，在测试里有 <2s 的回归门限。向量检索为暴力余弦（Accelerate），
几百条记录在 1ms 量级——单用户规模下不需要 ANN/HNSW（§40）。

## 13. 已知限制

- **语义检索的质量上限是 NLEmbedding 的**：它不是咖啡语料训的模型，「干涩 → 尾段发干」
  级别的近义能中，更抽象的关联（「萃取不足 → 尾段发干」）不保证。词法兜底只认字面。
- **洞察页的相似冲煮框没有截图自动化的输入通道**：Case 2 链路由测试钉住，模拟器上
  人工输入未截图（`AskView` 的自动提问参数只覆盖问一问页）。
- **偏好里残留的旧引擎选择（ollama）不会生效**——这是有意的 V1 行为，测试已钉住。
- `git diff` 里 `.DS_Store` / `xcuserstate` 仍在被跟踪（仓库无 `.gitignore`，前轮已报，
  未在本轮范围内处理）。

## 14. 下一阶段建议

1. **V2 的第一件事不是 LLM**，是把 `InsightsView` 的四张卡片按真实使用频率裁剪——
   规格优先级（§43）里「推荐有用 > 语义搜索 > AI 感」，四张卡全开反而稀释重点。
2. LLM 层挂回时只改 `AnswerComposer.chain`（provider 文件已就位），并把
   `AskEngineTests` 里那条 V1 测试改回「降级并说明原因」。
3. 真实数据攒起来后，`IntelligenceConfig` 的权重与阈值是第一批该按数据重估的参数——
   全部集中在一个文件里，就是为了这一天的迁移成本。
