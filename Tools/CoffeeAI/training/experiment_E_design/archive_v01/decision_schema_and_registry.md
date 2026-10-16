# Experiment E 交付物①：决策输出 Schema v1 + 变量注册表 v0.1

> 依据：GPT Q1 裁定（schema v1 结构化 JSON + fail-closed）+ E-7a（方案②三步编排）+
> E-7b（E1 目标 = 纯决策 JSON）+ Q3（变量注册表独立于 IntelligenceConfig）。
> 状态：v0.1 草案，随设计包提交 GPT 复核；**冻结前不写代码**。

## 一、决策输出 Schema v1

### 1.1 正式定义

模型在**决策调用**中的输出是且仅是一个 JSON 对象（无正文、无代码围栏、无包裹标记）：

```json
{
  "schema_version": "1",
  "action": "clarify",
  "missing_variable_id": "grind_size",
  "question": "你用的是手磨还是电磨？研磨度大概调到多少（如果磨豆机有刻度）？",
  "reason_code": "insufficient_diagnostic_information"
}
```

| 字段 | 类型 | 约束 |
|---|---|---|
| `schema_version` | string | 固定 `"1"`（未来演进时校验层按版本分派） |
| `action` | string | 枚举：`clarify` / `answer`，缺省非法 |
| `missing_variable_id` | string\|null | **必须 ∈ 变量注册表（§二）**；`answer` 时必须为 `null` |
| `question` | string\|null | 仅 `clarify` 时非空；**只问注册表中该变量的标准问题**；句尾中文问号；长度上限 80 字 |
| `reason_code` | string | 枚举：`insufficient_diagnostic_information`（缺关键变量）/ `ambiguous_symptom`（症状描述含糊）/ `information_sufficient`（信息足够，直答） |

### 1.2 校验规则（解析层，App 侧新组件）

按 E-7a 三步编排，决策调用的产物依次通过：

1. **语法校验**：`JSONDecoder` 解析成功；任何 decode error → fail-closed。
2. **Schema 校验**：`action`/`reason_code` 在枚举内；`clarify` ⇒ `missing_variable_id` 与 `question` 均非空；`answer` ⇒ 两者均为 `null`；违例 → fail-closed。
3. **注册表校验**：`missing_variable_id` 必须命中注册表条目（§二）；`question` 与该条目的 `question_template` 语义一致（初版实现：直接使用模板渲染，模型不自由发挥措辞——**问题文本由代码从注册表生成**，模型只负责选变量；此设计把 Q1「不能自由编造」约束变成机械保证）。
4. **全部通过** → 按 action 路由；**任一失败** → fail-closed。

### 1.3 Fail-closed 降级行为

校验失败时（含输出为空、超时、截断）：**不执行任何追问**，回到现行一问一答 RAG 流程（给有边界的条件化建议 + 说明可补充什么信息）；解析异常写入 OSLog（含原始输出摘要与失败原因码），App 不崩溃、不空白。与既有 `IntelligenceConfig` 的「证据不足」口径一致——追问是增强路径，直答是安全缺省。

### 1.4 目标序列（训练侧，E-7b）

- **E1**：assistant 目标 = 上述 JSON 字符串本身（`question` 字段此时也由模型生成——E1 阶段模型要学「问什么」，注册表模板用于**推理时**的机械替换与校验，两者以注册表校验对齐）。
- **E2**：决策调用目标仍为 JSON；**回答调用**目标是纯自然语言正文（沿用 Batch2e 的 F/P/I 语义分层惯例）；两类调用是**不同样本**，输入模板显式标注任务（见交付物⑤）。

## 二、变量注册表 v0.1

### 2.1 设计原则（GPT Q1/Q3 裁定落实）

- 注册表是**独立类型**（App 侧建议 `RAG/Rules/DecisionVariableRegistry.swift`，与 `IntelligenceConfig` 平级；后者只保留阈值与开关，如 `clarifyEnabled`）。
- 每个 `missing_variable_id` 必须有知识库 claim 锚点——模型追问的每个变量，其诊断意义在库里可追溯（与来源授权体系同构）。
- 变量粒度对齐用户真实可答项：问「研磨度」不问「萃取率」——**用户观测得到**的才进注册表。

### 2.2 注册表条目

| missing_variable_id | 诊断意义（claim 锚点） | 标准问题（question_template） | 主要适用 |
|---|---|---|---|
| `brew_method` | 萃取按方式分层教学：Percolation/Immersion（`claim.extraction.bh-courses`）；各器具参数体系互不通用（V60/AeroPress/意式 claim 表） | 「你用的是什么器具？手冲 V60、法压、爱乐压、摩卡壶还是意式机？」 | 全部 |
| `grind_size` | 研磨是第一近似归因变量：太淡→磨细、太慢→磨粗（`claim.pourover.v60-official-tuning`）；Fellow 把酸/苦症状归入研磨粗细（`claim.extraction.channeling-vendor`）；刻度只有相对意义（`claim.grinding.aeropress-grind-ref`） | 「研磨度大概是什么水平——比白沙糖细、接近细盐，还是更粗？磨豆机有刻度的话是多少？」 | 全部 |
| `dose` | 粉量是配方核心参数：意式 14g/18g（`claim.espresso.linea-micra-basket`、`claim.espresso.fellow-dose-tamp`）；手冲 15g/250g（`claim.pourover.v60-official-expert`） | 「每次用的粉量大概是多少克？」 | 手冲/意式 |
| `ratio` | 粉水比定义浓度方向：意式 1:2、1:3（`claim.espresso.fellow-ratio-example`、`claim.espresso.fellow-ratio-1to3`）；手冲 1:15（`claim.pourover.v60-hoffmann-recipe`） | 「粉和水的比例大概是多少——比如 1:15，或意式 18g 出 36g？」 | 手冲/意式 |
| `water_temp` | 水温是官方配方的固定维度：92–96°C（`claim.pourover.v60-official-expert`）、97°C（`claim.pourover.v60-hoffmann-recipe`）、94°C（`claim.espresso.fellow-ratio-example`） | 「冲煮水温大概多少度（如果壶上有显示）？」 | 手冲/意式 |
| `brew_time` | 时长是萃取深度的主要观测量：手冲总时长约 2.5 分钟（`claim.pourover.v60-official-expert`）；意式 25–35 秒（`claim.espresso.linea-micra-yield`） | 「从开始注水（或按下萃取键）到结束，大概用了多久？」 | 全部 |
| `shot_yield` | 意式出液克重应为粉重两倍（`claim.espresso.linea-micra-yield`）；出液量决定实际比例 | 「最后接了多少克的咖啡液（有秤的话）？」 | 意式 |
| `bean_roast_level` | 烘焙对风味的控制力远大于冲煮（`claim.roasting.roast-controls-flavor`）；TA 随烘焙在一爆达峰后下降（`claim.roasting.ta-peaks-first-crack`）；感知酸度与 TA 相关（`claim.roasting.ta-sourness-correlation`） | 「这支豆子的烘焙度大概是什么——浅烘、中烘还是深烘（包装上有标吗）？」 | 全部 |
| `roast_date` | 养豆期随烘焙度与处理法差异可达数周（`claim.freshness.resting-varies-by-roast`）；深烘 5–7 天、浅烘/实验处理 4–6 周（`claim.freshness.dark-roast-rest-5-7d`、`claim.freshness.light-roast-rest-4-6w`）；烘焙后立即开始失鲜（`claim.freshness.nca-lose-freshness-immediately`） | 「豆子包装上的烘焙日期是哪天（大概几周前买的也行）？」 | 全部 |
| `water_hardness` | 硬水结垢降低流量/温度/功率与意式风味（`claim.water.scale-mechanism`）；建议测试硬度与氯（`claim.water.rancilio-filtration`） | 「你用的水是自来水、过滤水还是瓶装水？当地水质偏硬吗？」 | 意式为主 |
| `equipment_cleanliness` | 水垢/清洁不足影响机器功能：除垢周期因机型而异（`claim.water.sage-descale-thresholds`、`claim.cleaning.no-universal-cycle`）；清洁不足是保修除外（`claim.grinding.cleaning-warranty`） | 「机器/磨豆机上次清洁或除垢是什么时候？」 | 意式/磨豆机 |
| `taste_detail` | 症状词是诊断入口：UC Davis 新版 Sensory Brewing Control Chart 把感官与浓度/萃取率关联（`claim.extraction.ucdavis-brewing-chart`）；Fellow 以酸/苦/寡淡分流归因（`claim.extraction.channeling-vendor`） | 「『怪』具体更像哪一种——发酸发咸、焦苦发涩、青草味，还是说不上来的闷味？」 | 全部（症状澄清） |

### 2.3 注册表边界（防编造的配套约束）

- 上表 12 个变量是 **v0.1 全集**——模型不得输出表外 id；`question` 由模板渲染，防自由发挥。
- 每个变量标注 `applicable_methods`（brew_method 的子集），校验层拒绝向不适用场景路由（如对法压用户问 `shot_yield`）。
- **不含**以下项（有意排除）：萃取率/TDS（用户无法观测，`claim.extraction.tds-measured` 表明需折射仪）；健康相关变量（医疗边界，走现行 boundary 路径不做追问）；豆种/产区（影响风味解释而非「当前这杯为什么不对」的第一优先变量，v0.2 再议）。
- claim 锚点变更流程：新增/修改变量必须先在知识库补 claim（走既有 F 层核验），再改注册表——**顺序不可反**。

## 三、与既有代码的衔接点

| 现有资产 | 衔接方式 |
|---|---|
| `IntelligenceConfig`（阈值集中、证据窗口 conversationEvidenceTurns=3） | 只新增 `clarifyEnabled` 等开关；注册表不进此文件（GPT Q1 明确） |
| 对话状态（只存标识：豆子 id/实体/话题/参数/证据 id） | E-7a 第二步的「记录状态」复用该机制：clarify 后记录 pending_variable_id，用户补充后**重新决策**（E-7 约束①，旧 clarify ≠ 新 answer） |
| `PhaseRuleBook`（用户可编辑的咖啡科学阈值） | 注册表的「标准问题」措辞可考虑与 PhaseRuleBook 参数名对齐（同一变量两处叫法一致性），v0.1 先独立、复核时确认 |
| Batch2e 的 F/P/I 语义分层 | E2 正文目标沿用；决策 JSON 不分层（内部协议） |
