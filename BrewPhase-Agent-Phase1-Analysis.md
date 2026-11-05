# BrewPhase Agent Evolution — Phase 1 分析

> 基线：`70b2355`（2026-11-03 工作区，含未提交的版本号改动 `1.1 / build 3`）
> 性质：只读研究。未修改任何 Swift 文件、未训练、未下载模型、未引入依赖。
> 参考仓库：`pguso/ai-agents-from-scratch`（examples 07 / 08 / 09 / 11 / 15，代码 + `CONCEPT.md` + `CODE.md`）

---

## 0. 结论先行

1. **BrewPhase 现在不是 Agent，但已经具备 Agent 最难的半截：确定性工具。**
   `StructuredRetriever`、`BrewDiagnosticEngine`、`PersonalBaselineBuilder`、`KnowledgeSearchService` 都是"输入结构化、输出可引用"的纯 Swift 计算，天然适合包成工具。

2. **最大的阻塞不是工具层，而是回答层没有 LLM。**
   `AnswerComposer.chain(settings:)` 只返回 `ExtractiveLLMProvider`（`AnswerComposer.swift:62-64`），设置页里的 Ollama / Apple 端侧模型偏好（`RAGSettings.preferredEngine`，`RAGSettings.swift:47`）**从未参与选链**。没有生成式模型，就没有 Function Calling 的载体。

3. **BrewPhase 的"记忆"已经分层，而且比参考仓库更正确。**
   长期事实在 SwiftData（Bean / Brew / Tasting / PhaseRule），工作状态在 `ConversationContext`（`ConversationContext.swift:239`），二者职责清晰。**不需要**再引入 JSON 文件式 AgentMemory。

4. **ReAct 不该成为默认路径。**
   现有 `QueryAnalyzer` 已把问题分成 9 类意图（`QueryPlan.swift:8-21`），大多数问题一次检索就能答。多步推理只应服务"跨对象、需要多工具"的少数问题，且必须有步数上限与确定性兜底。

5. **Tool Routing 现在不需要独立模块。**
   工具目录在 Phase 2 只有 6–8 个，`QueryIntent → 工具集合`的确定性映射足够；embedding 路由是工具数超过约 15 个、或意图命中率实测不足时的优化，不是起点。

6. **一处必须如实报告的产品-代码不一致**：设置页允许选择三种回答引擎，但当前回答永远是抽取式；选择 Ollama / 系统端侧模型不会改变结果。这不是本文的修复范围，但它是 Agent 化的前置条件。

---

## 1. 参考仓库技术解读

### 1.1 Simple Agent — Function Calling（07）

**要解决的问题**：让模型从"只会说话"变成"能取到它不知道的实时数据"。

**工作原理**：
- 工具用 `{description, params(JSON Schema), handler}` 三件套声明（`simple-agent.js:31-40`）。
- 模型在生成时看到工具目录，自己决定调用哪个、传什么参数。
- 库（`node-llama-cpp`）拦截模型的工具调用意图、执行 `handler`，把返回值作为 `tool` 消息塞回上下文，再让模型续写（`CODE.md:89-103`）。
- 应用层只写 `session.prompt(prompt, {functions})`（`simple-agent.js:46`），循环由运行时负责。

**关键代码位置**：
| 内容 | 位置 |
|---|---|
| 工具声明 + JSON Schema | `examples/07_simple-agent/simple-agent.js:31-40` |
| 注册与调用 | 同文件 `:42-46` |
| 调用时序（LLM→工具→LLM） | `CODE.md:89-103`、`CONCEPT.md:17-31` |

**核心流程**：用户问题 → 模型看到 system prompt + 工具目录 → 生成调用意图 → 运行时执行 → 结果回填 → 模型生成最终回答。

**优点**：契约清晰、模型自主选工具、易扩展到多工具。
**缺点**：把"选工具"完全交给模型，小模型容易选错；工具多时 schema 占满上下文；参数错误只能靠模型自觉。

**适用**：工具少（<10）、参数简单、失败可重试的查询型场景。

#### 任务 1 的七个问题（直接回答）

1. **原理**：模型输出结构化的 "调用意图"（函数名 + 参数 JSON），由宿主执行真实函数，再把结果作为一条特殊消息放回对话。模型本身不执行任何代码。
2. **如何决定调用**：靠工具 `description` 与用户语义的匹配，加上 system prompt 的指令。这是概率判断，不是规则匹配。
3. **三者的作用**：`description` 决定"要不要选它"；`parameters` 决定"能传什么"；JSON Schema 是机器可校验的契约，用于约束类型、必填项、枚举，宿主可据此拒绝非法参数。
4. **执行与生成的交互**：模型暂停生成 → 宿主执行 → 结果入上下文 → 模型继续。一次用户请求可能包含 0..N 次这种往返。
5. **结果如何回到上下文**：作为 `tool` 角色的消息（或等价结构）追加到消息列表，模型在下一轮生成时能看到。
6. **失败处理**：工具抛错应转成结构化错误结果返回给模型（让它解释或换路），而不是让整个请求崩掉；不可重试的错误直接终止并给用户可读信息。
7. **与普通 RAG 的区别**：RAG 是"先检索、再一次性生成"，检索策略由应用固定；Function Calling 是"模型决定查什么、查几次"，应用只提供能力边界。RAG 的证据是文本片段，工具的结果可以是任意结构化数据。

---

### 1.2 Agent Memory（08）

**要解决的问题**：跨会话记住用户信息，而不是每次从零开始。

**工作原理**：
- `MemoryManager` 把记忆存成 JSON：`{type: fact|preference, key, value, source, timestamp}`（`memory-manager.js:63-100`）。
- 启动时读全部记忆，格式化成一段文本塞进 system prompt（`simple-agent-with-memory.js:24-49`）。
- 模型通过 `saveMemory` 工具写入；prompt 里明确要求"先比对、相同则不要重复保存、变了才更新"（同文件 `:29-37`）。
- 去重逻辑在代码里也做了一层：按 `type + key` 归一化后查找，存在则比较 value（`memory-manager.js:66-97`）。

**关键代码位置**：
| 内容 | 位置 |
|---|---|
| 记忆结构与去重写入 | `memory-manager.js:63-100` |
| 记忆摘要注入 prompt | `memory-manager.js:102-124` |
| `saveMemory` 工具 | `simple-agent-with-memory.js:57-75` |
| 写入纪律（防重复） | `simple-agent-with-memory.js:29-37` |

**优点**：简单、可读、跨会话；"模型决定记什么"符合直觉。
**缺点**：全量记忆塞 prompt 会膨胀；key 由模型自由生成，容易同义不同名；没有冲突仲裁与过期；JSON 文件不是事务存储。

**适用**：个人助手类的少量偏好/事实；不适合已经有结构化数据库的应用（会形成第二事实源）。

---

### 1.3 ReAct Agent（09）

**要解决的问题**：多步任务中，模型需要"想一步、做一步、看结果、再想"。

**工作原理**：
- 用 system prompt 强制输出格式：`Thought → Action → Observation → ... → Answer`（`react-agent.js:22-53`）。
- 外层循环最多 `maxIterations` 次，每次把"继续推理"作为下一轮输入（`:165-213`）。
- 终止条件：响应中出现 `Answer:`（`:202-208`）；否则到上限后返回已有文本（`:211-212`）。
- **注意**：这个实现并没有用原生 function calling，而是让模型在文本里写 `Action: add(5,3)`，再由运行时解析。它演示的是模式，不是生产级协议。

**关键代码位置**：
| 内容 | 位置 |
|---|---|
| ReAct 格式约束 | `react-agent.js:22-53` |
| 迭代循环 / 上限 | `:165-213` |
| 终止判定 | `:202-208` |
| 工具集合 | `:61-160` |

**优点**：多步任务可分解、过程可观测、失败可定位到某一步。
**缺点**：每步一次模型调用，延迟与 token 成本线性增长；文本协议解析脆弱；模型可能绕圈；"Thought" 是模型自述，不等于真实推理，产品里不应直接展示为思维链。

**适用**：确实需要 ≥2 次工具调用的任务；简单查询不该走这条路。

---

### 1.4 Error Handling（11）

**要解决的问题**：Agent 编排多条不可靠链路（模型、工具、工作流），失败方式远多于普通 App。

**工作原理**：
- 统一错误分类：`ValidationError` / `LLMCallError` / `ToolExecutionError` / `AgentWorkflowError`，每个都带 `code`、`userMessage`、`retryable`、`details`、`cause`（`error-handling.js:22-95`）。
- 恢复阶梯：超时（`:105-123`）→ 按 `retryable` 重试（指数退避 + 抖动，`:149-191`）→ 主工具失败换备用工具 → 模型整体不可用则走确定性降级（`:409-463`）→ 仍失败则给用户可读信息 + correlation id（`:193-199`）。
- 关键设计：**用户消息与技术细节分离**；未知错误先归一化再分类（`:125-143`）。

**关键代码位置**：
| 内容 | 位置 |
|---|---|
| 错误类型 | `error-handling.js:22-95` |
| 超时 / 重试 | `:105-191` |
| 降级路径 | `:409-463` |
| 总编排 | `:465-546` |

**优点**：失败可分类、可重试、可降级；用户永远看到一句人话。
**缺点**：重试会放大延迟；降级路径本身也要维护与测试。

**适用**：任何要上线的 Agent。BrewPhase 的 `AnswerComposer` 已有"链式降级"雏形，可直接对齐这套语义。

---

### 1.5 Tool Routing with Embeddings（15）

**要解决的问题**：工具目录变大后，把所有 schema 塞进 prompt 既贵又容易选错。

**工作原理**：
- 每个工具准备若干"示例意图句"（exemplars，`:324-372`），离线算好 embedding。
- 用户输入也 embedding，对每个工具取"与其所有 exemplar 的最大余弦相似度"（`:32-41`）。
- 取 Top-K，再并入 `alwaysInclude` 的关键工具（不占 K 名额，`:51-60`）。
- 只把选中的工具传给 chat 模型（`:467-468`）。

**关键代码位置**：
| 内容 | 位置 |
|---|---|
| 打分 / 选择 | `tool-routing-embeddings.js:32-60` |
| exemplars | `:324-372` |
| 运行与对照 | `:440-507` |
| 失败模式 | `CONCEPT.md:44-57` |

**优点**：工具规模可扩展；成本低（小 embedding 模型）；可与规则路由叠加。
**缺点**：召回失败时模型可能编造或拒答；多意图 + K 过小会漏工具；exemplar 质量决定上限。

**适用**：工具 ≥15 个、或跨领域工具混在一起时。BrewPhase Phase 2 的工具数远低于此。

---

## 2. BrewPhase 当前架构评估

### 2.1 现有问答链路（按代码实际行为）

```
AskView
  └─ AskEngine.ask(question, focusBeanID, conversation, beans, brews, tastings, …)   AskEngine.swift:71
       ├─ HybridRetriever.retrieve(...)                                              HybridRetriever.swift:37
       │    ├─ QueryAnalyzer.plan()  → QueryPlan（9 类意图 + 豆子/方式/时间/条数）      QueryAnalyzer.swift:179
       │    ├─ ConversationQueryPlanner.apply() → 继承上下文                          HybridRetriever.swift:72
       │    ├─ IndexCoordinator.sync() → 向量索引增量更新                              HybridRetriever.swift:88
       │    ├─ BrewDiagnosisService.diagnose() → BrewDiagnosis（确定性，无 LLM）        HybridRetriever.swift:102
       │    ├─ StructuredRetriever.facts() → 结构化事实（日期/评分/配方/状态/诊断）      HybridRetriever.swift:114
       │    └─ 向量检索 + 元数据过滤                                                  HybridRetriever.swift:120+
       ├─ ContextBuilder.build() → 去重、分组、6000 字符预算、稳定编号                  ContextBuilder.swift:20
       ├─ AnswerComposer.compose() → chain = [ExtractiveLLMProvider]                  AnswerComposer.swift:21, 62
       └─ ConversationStateUpdater.next() → 下一轮状态                                 ConversationStateUpdater.swift:17
```

**关键事实（代码确认）**：

| 事实 | 证据 |
|---|---|
| 回答引擎链只有抽取式，Ollama / Apple 端侧模型未挂载 | `AnswerComposer.swift:62-64` |
| 设置页仍允许选择三种引擎，偏好被读取但未使用 | `RAGSettings.swift:47, 75`；`AnswerComposer.chain` 忽略 `settings` |
| 诊断完全确定性（规则 + 个人统计），无模型 | `BrewDiagnosticEngine.swift`；`BrewDiagnosisService.swift:18` |
| 证据已有分组、编号、预算控制 | `ContextBuilder.swift:18-51` |
| Prompt 有三条硬纪律：只用资料、必须标引用、不足要直说 | `PromptBuilder.swift:15-26` |
| 全仓无 function calling / JSON Schema / tool 注册表 | 全仓检索 `tool|function_call|arguments` 无命中（`arguments` 仅 `CommandLine`） |
| Ollama 请求体没有 `tools` 字段 | `OllamaClient.swift:82-91` |
| 端侧 Foundation Models 仅 iOS 26+ 可用（部署目标 18.0） | `FoundationModelLLMProvider.swift:24-32` |

### 2.2 已实现 / 部分实现 / 不存在

**已实现（可直接作为工具底座）**
- 意图识别与对象锁定：9 类 `QueryIntent` + 豆子匹配 + 条数/时间解析（`QueryAnalyzer.swift:192-248`）。
- 结构化事实计算：库存、评分、时间、配方、状态、诊断（`StructuredRetriever.swift:31-55`）。
- 冲煮诊断：候选结论 + 置信度 + 逐条自然语言证据 + 单一调整建议 + 知识引用（`DiagnosticResult.swift:148-255`）。
- 个人基线：仅统计高评分记录，三层回退（豆+方法 → 豆 → 方法），样本量封顶置信度（`PersonalBaseline.swift:40, 158`）。
- 知识检索：词法 + 语义 + 按豆/实体/范围/方法/器具（`KnowledgeSearchService.swift:43-136`）。
- 豆→知识实体翻译与关联（`BeanContextResolver.swift:25`；`EntityGraph.swift:12`）。
- 多轮状态：焦点豆、方法、器具、参数、话题、建议、证据窗口（`ConversationContext.swift:239-290`；`ConversationStateUpdater.swift:17-106`）。

**部分实现（有壳无实）**
- LLM 层：协议与三个 provider 齐全（`LLMProvider.swift:12-26`），但生产链只挂抽取式。
- 回答引擎偏好：UI / 设置 / 存储齐全，运行时未消费。
- 相似历史与能力推荐：`RecommendationEngine` 有实现，但 `similarHistory`、`capability` 在 App 内无调用方（Explore 盘点结论）。

**不存在**
- 工具契约（name / description / JSON Schema / 执行器）。
- 模型驱动的工具选择与多步循环。
- 工具结果回填与终止判定。
- Agent 级错误分类（现有只有 `LLMError` 与 `AskAnswer.failureNote`）。
- 写入类工具（当前唯一写路径是 `BrewRecorder`，与问答无关）。

---

## 3. 技术映射表

| Agent 能力 | 参考实现 | BrewPhase 现有模块 | 是否需要新增 |
|---|---|---|---|
| Function Calling | 07 Simple Agent | 无；`OllamaClient.chat` 无 `tools` 字段 | **需要**：`AgentTool` 契约 + 注册表 + 参数解码 |
| 工具执行底座 | 07 handler | `StructuredRetriever` / `BrewDiagnosisService` / `PersonalBaselineBuilder` / `KnowledgeSearchService` | **不需要重写**，只加薄包装（DTO + 截断） |
| Memory（长期） | 08 MemoryManager | SwiftData：`Bean` / `Brew` / `Tasting` / `PhaseRule` | **不需要**新增存储 |
| Memory（工作态） | 08 conversationHistory | `ConversationContext` + `ConversationStateUpdater` | 复用；必要时扩展字段 |
| ReAct 循环 | 09 ReAct Agent | `AskEngine` 只有单轮"检索→回答" | **需要**：`AgentLoop`（步数上限、终止、轨迹） |
| Error Handling | 11 error-handling | `AnswerComposer` 链式降级 + `AskAnswer.failureNote` + `LLMError` | **需要**：统一 `AgentError` 分类（工具/参数/循环/超时） |
| Tool Routing | 15 embeddings | `QueryAnalyzer` 已产出 9 类意图 + 对象锁定 | **Phase 2 不需要**；先走意图→工具确定性映射 |
| 证据纪律 | 07/15 均未涉及 | `PromptBuilder` + `BuiltContext` 编号 + `ContextBuilder` 预算 | 复用，工具结果必须并入同一套引用体系 |
| 降级回答 | 07 无 | `ExtractiveLLMProvider` | 复用为 Agent 失败兜底 |

---

## 4. 推荐目标架构

### 4.1 分层

```
┌────────────────────────────────────────────────────────────┐
│ UI: AskView（现有）/ 可选 Agent 模式开关                     │
└──────────────────────────┬─────────────────────────────────┘
                           ↓
┌────────────────────────────────────────────────────────────┐
│ AgentOrchestrator（新增，@MainActor）                        │
│  ├─ 0. 意图门控：复用 QueryAnalyzer → QueryPlan               │
│  │     简单问题直接走现有 AskEngine（不进入 Agent）           │
│  ├─ 1. 工具选择：QueryIntent → 工具集合（确定性映射）          │
│  ├─ 2. 规划器：LLM 只在需要时决定"先调哪个、参数是什么"        │
│  ├─ 3. 执行器：ToolRegistry → 只读工具（纯 Swift）            │
│  ├─ 4. 循环控制：最多 N 步；命中终止条件即停                   │
│  └─ 5. 成文：工具结果 → BuiltContext → AnswerComposer        │
│         （LLM 可用则生成，不可用则抽取式兜底）                 │
└───────┬──────────────────────────────┬─────────────────────┘
        ↓                              ↓
┌───────────────────┐        ┌───────────────────────────────┐
│ ToolRegistry      │        │ 现有确定性能力（不改）          │
│ getBeanDetails    │───────→│ SwiftData: Bean/Brew/Tasting   │
│ getBrewHistory    │───────→│ StructuredRetriever            │
│ diagnoseBrew      │───────→│ BrewDiagnosisService           │
│ getPersonalBase…  │───────→│ PersonalBaselineBuilder        │
│ searchKnowledge   │───────→│ KnowledgeSearchService         │
│ compareBrews      │───────→│ PersonalBestAnalyzer           │
└───────────────────┘        └───────────────────────────────┘
        ↓
┌────────────────────────────────────────────────────────────┐
│ 证据层（现有）：BuiltContext 编号 + PromptBuilder 纪律        │
└────────────────────────────────────────────────────────────┘
```

**三条硬边界**：
1. **工具只读，且只返回 Swift 计算的真实数据**；模型不能直接拼 SQL / 访问 SwiftData。
2. **模型只决定"调谁、传什么"**，不决定"数据是什么"。任何一个数字都必须来自工具返回值。
3. **Agent 是可选路径**：意图门控判定为简单问题时，仍走现有 `AskEngine`，行为不变。

### 4.2 工具契约（Swift 原生，无第三方依赖）

```swift
protocol AgentTool: Sendable {
    static var name: String { get }            // 稳定标识，如 "get_brew_history"
    static var description: String { get }     // 给模型看，决定是否选择
    static var schema: ToolSchema { get }      // 参数契约（Codable 结构，序列化成 JSON Schema）
    func call(_ arguments: ToolArguments, in context: AgentToolContext) async throws -> ToolResult
}

struct ToolResult: Sendable {
    let summary: String          // 给模型看的一行结论（可截断）
    let citations: [ToolCitation] // 指向 Bean/Brew/Tasting/知识条目的稳定 ID
    let payload: Data            // 结构化 JSON，供成文层按需取用
}
```

**参数校验**：`ToolArguments` 用 `JSONDecoder` 解成每个工具自己的 `Codable` 参数类型；失败返回 `ToolError.invalidArguments(field:)`，由编排层决定"让模型重试一次"还是"直接拒绝"。**不允许** untyped `[String: Any]` 直接进业务层。

### 4.3 候选工具目录（只读）

| 工具 | 复用现有实现 | 现状 | 需要新增的部分 |
|---|---|---|---|
| `getBeanDetails` | `Bean` 模型 + `BeanContextResolver.context`（`BeanContextResolver.swift:25`） | 数据齐全，无单一 DTO | Bean 快照 DTO（字段白名单）+ 图片不返回 |
| `getBrewHistory` | `Bean.brewsNewestFirst`（`Bean.swift:140`）+ `StructuredRetriever.recipeFact` | 有文本结论，无结构化列表 | 最近 N 条 DTO（参数、评分、日期） |
| `getTastingHistory` | `Tasting` 模型 + `StructuredRetriever.ratingFact` | 有统计，无逐条 | 最近 N 条 DTO |
| `getPersonalBaseline` | `PersonalBaselineBuilder.baseline`（`PersonalBaseline.swift:160`） | 已有 | 包装 + 明确"样本不足"语义 |
| `diagnoseBrew` | `BrewDiagnosisService.diagnose`（`BrewDiagnosisService.swift:18`） | 已有，确定性 | 输出转 `ToolResult`（候选/证据/建议/知识） |
| `searchCoffeeKnowledge` | `KnowledgeSearchService.search`（`:43`） | 已有 | Top-K + 截断 + 来源标注 |
| `compareBrewRecords` | `PersonalBestAnalyzer.analyze`（`:48`）+ `ParameterDeviation` | 有零件，无组合 API | 新组合函数（纯 Swift，不调模型） |
| `getInventory` | `StructuredRetriever.inventoryFact`（`:97`） | 已有 | DTO 化 |

**不建议**在第一阶段提供的工具：任何写操作（新增/修改/删除记录）、任意文本搜索数据库、图片读取、通知排程。理由：写操作需要确认与回滚语义，属于 Phase 3+。

### 4.4 路由策略：先确定性，后 embedding

**Phase 2 采用：`QueryPlan → 工具集合` 确定性映射。**

依据：
- `QueryIntent` 只有 9 类，且已能覆盖用户问题的主要形态（`QueryPlan.swift:8-21`）。
- 工具只有 6–8 个，schema 总长度可控（每个工具描述 < 200 字，总计 < 2k tokens）。
- 规则路由可测、可解释、零延迟；embedding 路由需要额外模型与阈值调参，收益在工具数增长后才出现。

**何时引入 embedding 路由**（明确触发条件，写进 Phase 3 门槛）：
1. 工具数 > 15；或
2. 确定性路由的"该选未选"率 > 10%（用 Phase 2 的评测集统计）；或
3. 出现跨领域工具（如营养、购物）导致意图词表冲突。

`alwaysInclude` 对应 BrewPhase 的候选：`getBeanDetails`（对象锁定后几乎所有问题都需要）与 `getPersonalBaseline`（诊断类必备）。

### 4.5 记忆策略：不新增 AgentMemory

**结论：Phase 2 不引入新的记忆存储。**

| 信息类型 | 归属 | 理由 |
|---|---|---|
| 豆子、冲煮、风味、规则、提醒 | **SwiftData** | 已是事实源；再存一份必然不一致 |
| 默认参数、提醒开关、问答设置 | **UserDefaults**（已有白名单备份） | 已有读写路径与恢复语义 |
| 本轮焦点豆、方法、参数、话题、建议、证据窗口 | **ConversationContext** | 纯值类型、可测、随轮次推进 |
| "用户偏好浅烘 / 不喜欢酸"这类语义偏好 | **暂不新增**；由 Tasting/Brew 数据 + `PersonalBaseline` 推导 | 现有数据已隐含偏好；单独存会与记录冲突 |
| 对话原文 | **不持久化** | 现有设计明确不把回答文本当事实源（`ConversationStateUpdater.swift:3-12`） |

如果未来确实需要语义记忆，约束应为：
- 只存**用户显式确认过**的偏好，由确定性代码写入，不让模型自由写；
- 每条记忆带来源（哪次对话/哪条记录）与时间戳；
- 与 SwiftData 冲突时以记录为准，记忆只能作为提示。

### 4.6 回答与证据纪律（不变的部分）

- 工具结果必须转成 `RetrievedPassage` / `BuiltContext.Block`，沿用同一套 `[n]` 编号（`ContextBuilder.swift:12-51`）。
- `PromptBuilder.system()` 的三条纪律（只用资料、必须标引用、不足直说）继续适用于 Agent 成文。
- 抽取式必须保留为最终兜底：Agent 失败、模型不可用、工具无结果时，返回"有依据的检索结果"而不是空白或道歉。

---

## 5. 技术风险

| 风险 | 具体表现 | 缓解 |
|---|---|---|
| **本地小模型工具调用不稳定** | 1.7B–3B 模型可能选错工具、漏参数、输出非法 JSON；CoffeeAI 的历史实验已表明 3B 在行为对齐上不稳定 | 工具数控制在 8 个以内；参数 schema 尽量扁平；失败重试上限 1 次；确定性路由兜底 |
| **JSON 参数解析失败** | 模型输出多余文字、字段名拼错、类型错误 | 严格 `Codable` 解码；错误回传模型一次；仍失败则降级为"只做检索" |
| **多步调用延迟** | 每步一次本地推理；3 步在 iPhone 上可能 10s+ | 步数上限 3；首屏先流式/先给"正在查…"；超时取消 |
| **上下文长度** | 工具结果 + 证据 + 对话状态叠加，超过 6000 字符预算 | 每个工具结果按条数/字符截断；只在必要时注入完整历史 |
| **设备内存** | 模型 + 推理中间态 + 工具结果 | 复用现有索引的内存策略；工具结果用 DTO 而非全量对象图 |
| **电量与发热** | 连续多轮推理 | 限制单次会话的模型调用次数；低电量模式下降级为抽取式 |
| **多轮状态污染** | 换豆子后仍带上一包的冲法/参数 | 复用 `ConversationStateUpdater` 的"换豆即清"规则（`:36-56`） |
| **隐私** | 工具参数可能包含用户备注 | 全部本地；日志只记工具名/耗时/字段名，不记内容；不新增上传 |
| **Agent 错误决策** | 选错工具、给出与记录不符的建议 | 只读；所有数字来自工具；回答必须带引用；无法完成时明确说"做不到" |

---

## 6. Phase 2 实施建议（只设计，不执行）

**目标：最小可用 Function Calling 工具层，先支持少量只读工具。**

| 编号 | 任务 | 产出 | 验收 |
|---|---|---|---|
| P2-0 | 冻结工具契约与评测集 | `AgentTool` 协议草案；20 条真实问题的"期望工具 + 期望参数"标注 | 人工评审通过；问题覆盖 6 类意图 |
| P2-1 | 实现工具注册表与参数解码 | `ToolRegistry`、`ToolSchema`、`ToolArguments`、错误类型；纯单测 | 非法参数/未知工具/重复注册均有测试 |
| P2-2 | 包装 3 个只读工具 | `getBeanDetails`、`getBrewHistory`、`diagnoseBrew` | 输出与现有诊断/记录一致；DTO 字段白名单 |
| P2-3 | 确定性路由（无 LLM） | `QueryPlan → [AgentTool]`；单工具执行 | 20 条评测集上工具选择准确率 ≥ 90%（规则可解释） |
| P2-4 | 接入模型工具调用（开关控制） | 选定 runtime 的 tool-calling 适配层 | 模型能输出合法工具调用；非法输出降级 |
| P2-5 | Agent 循环（最多 3 步） | `AgentLoop` + 终止条件 + 轨迹（工具名/参数摘要/耗时） | 无死循环；超时/失败有明确结论；抽取式兜底可用 |
| P2-6 | 成文与证据 | 工具结果 → `BuiltContext` → 回答 | 每个数字可回溯到工具/记录；引用编号正确 |
| P2-7 | 评测与回归 | 指标：工具选择准确率、参数准确率、答案有据率、P50 延迟 | 达到门槛才允许进入 Phase 3 |

**明确不做**：写操作、跨会话语义记忆、embedding 路由、ReAct 自由循环、云端调用。

---

## 7. 需要人工确认的技术决策

1. **回答层是否先恢复 LLM？** 当前 `chain` 只有抽取式（`AnswerComposer.swift:62-64`）。没有生成式模型，Function Calling 无从谈起。需要决定：先修这条链，还是 Agent 走独立开关。
2. **工具调用的模型载体**：Ollama（开发期可用，但要求用户装服务）/ Apple Foundation Models（零配置，但 iOS 26+ 且设备受限）/ 内置 GGUF（体积与内存成本最高）。三者对 Agent 的可行性差异很大。
3. **Agent 的入口形态**：作为"问一问"里的自动升级路径（用户无感），还是独立模式/开关（用户可选）。
4. **是否允许任何写操作**：Phase 2 建议全只读；若要支持"帮我记一杯"，需要确认与回滚设计。
5. **是否引入语义记忆**：建议不引入；若引入，必须限定为用户显式确认的偏好。
6. **工具数量上限与路由切换点**：建议 8 个以内用规则路由，>15 个再评估 embedding 路由。
7. **证据展示粒度**：是否在 UI 展示"调用了哪些工具"（可解释性 vs 技术感过重）。

---

## 附录 A：能力缺口清单

| 能力 | 状态 | 缺口 |
|---|---|---|
| 意图识别 | ✅ 已实现 | 无（可扩展词表） |
| 对象锁定（豆/方法/参数） | ✅ 已实现 | 无模糊匹配/别名/拼音 |
| 结构化事实 | ✅ 已实现 | 产物是本地化文本，不是稳定 DTO |
| 冲煮诊断 | ✅ 已实现 | 证据是自然语言，无字段级引用（brewID + 字段名） |
| 个人基线 | ✅ 已实现 | 仅高评分样本；无"为什么"解释 |
| 知识检索 | ✅ 已实现 | 知识库仅 19 篇；无设备/水质实体 |
| 多轮状态 | ✅ 已实现 | 无跨会话持久化（设计如此） |
| 工具契约 | ❌ 不存在 | 全新 |
| 模型工具调用 | ❌ 不存在 | 全新（且当前无 LLM 在链上） |
| Agent 循环 | ❌ 不存在 | 全新 |
| Agent 错误分类 | ⚠️ 部分 | 只有 `LLMError`，缺工具/参数/循环错误 |
| 工具路由 | ⚠️ 部分 | 有意图，无工具映射 |
| 写入工具 | ❌ 不存在 | Phase 3+ |

## 附录 B：代码证据索引

- 问答编排：`BrewPhase/RAG/AskEngine.swift:71-179`
- 检索：`BrewPhase/RAG/Retrieval/HybridRetriever.swift:37-120`
- 意图：`BrewPhase/RAG/Retrieval/QueryAnalyzer.swift:179-268`；`QueryPlan.swift:8-21, 97-183`
- 结构化事实：`BrewPhase/RAG/Retrieval/StructuredRetriever.swift:14-64`
- 上下文：`BrewPhase/RAG/Answering/ContextBuilder.swift:18-51`
- 提示词：`BrewPhase/RAG/Answering/PromptBuilder.swift:15-34`
- 回答链：`BrewPhase/RAG/Answering/AnswerComposer.swift:21-64`
- 抽取式：`BrewPhase/RAG/Answering/ExtractiveLLMProvider.swift:16-68`
- LLM 协议：`BrewPhase/RAG/Answering/LLMProvider.swift:12-26`
- 诊断：`BrewPhase/RAG/Diagnostic/BrewDiagnosisService.swift:18-39`；`DiagnosticResult.swift:148-255`
- 基线：`BrewPhase/RAG/Diagnostic/PersonalBaseline.swift:40, 158-193`
- 知识检索：`BrewPhase/RAG/Linking/KnowledgeSearchService.swift:43-136`
- 实体解析：`BrewPhase/RAG/Linking/BeanContextResolver.swift:25`；`EntityGraph.swift:12-28`
- 对话状态：`BrewPhase/RAG/Conversation/ConversationContext.swift:239-290`；`ConversationStateUpdater.swift:17-106`
- 设置：`BrewPhase/RAG/Core/RAGSettings.swift:47, 75`
- Ollama 请求：`BrewPhase/RAG/Providers/OllamaClient.swift:82-91`
- 端侧模型可用性：`BrewPhase/RAG/Answering/FoundationModelLLMProvider.swift:24-32`
