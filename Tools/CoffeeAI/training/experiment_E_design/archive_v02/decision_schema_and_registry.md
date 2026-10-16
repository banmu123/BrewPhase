# Experiment E 交付物①：决策输出 Schema v2 + 变量注册表 v0.2

> **v0.2 修订依据**：GPT 对 v0.1 的终审（存档
> `review_queue/gpt_replies/gpt_reply_experiment_E_v01_review_revision_required.md`）——
> 四项必改之一（注册表渲染与 schema 契约不一致）+ 授权范围问题。v0.1 原件保留于
> `archive_v01/`，本文件变更全部显式记录，不静默改写已批准契约。

## 〇、v0.1 → v0.2 变更记录（GPT 终审逐项落实）

| # | 变更 | 对应裁定 |
|---|---|---|
| 1 | **Schema v1 → v2**：模型输出去除 `question` 字段，问题文本改由代码从注册表渲染；正式版本化并保留 v1 裁定与变更理由（§1.4 治理记录） | 终审问题 2 |
| 2 | 补跨字段校验：`answer` ⇔ `information_sufficient` | 终审问题 2 |
| 3 | 注册表单变量检查：`water_hardness` 拆为 `water_source` + `water_hardness`；`equipment_cleanliness` 拆为 `descale_history` + `cleaning_history`（12 → 14 变量） | 终审问题 2 |
| 4 | claim 锚点授权分级：新增 `anchor_role`（design-only / training-candidate）+ 授权边界节（§2.4）；`light-roast-rest-4-6w` 按 Fellow 例外范围注记（未核验不在范围内）**整体移出锚点** | 终审问题 4 |

## 一、决策输出 Schema v2

### 1.1 正式定义

模型在**决策调用**中的输出是且仅是一个 JSON 对象——**不再包含 `question` 字段**
（问题文本由程序生成，见 §1.3）：

```json
{
  "schema_version": "2",
  "action": "clarify",
  "missing_variable_id": "grind_size",
  "reason_code": "insufficient_diagnostic_information"
}
```

| 字段 | 类型 | 约束 |
|---|---|---|
| `schema_version` | string | 固定 `"2"` |
| `action` | string | 枚举：`clarify` / `answer` |
| `missing_variable_id` | string\|null | **必须 ∈ 注册表（§二）**；`answer` 时必须为 `null` |
| `reason_code` | string | 枚举：`insufficient_diagnostic_information` / `ambiguous_symptom` / `information_sufficient` |

### 1.2 校验规则（DecisionParser 四步，v2 更新）

1. **语法**：JSON 解析成功，否则 fail-closed。
2. **字段**：枚举校验 + 空值规则（`clarify` ⇒ `missing_variable_id` 非空；`answer` ⇒ 为 `null`）。
3. **跨字段（新增）**：`answer` ⇒ `reason_code == "information_sufficient"`；`clarify` ⇒ `reason_code ∈ {insufficient_diagnostic_information, ambiguous_symptom}`——字段各自合法但组合矛盾的输出判无效。
4. **注册表**：`missing_variable_id` 命中注册表条目且该条目 `applicable_methods` 包含当前场景器具。
5. **任一失败 → fail-closed**：不执行追问，回现行 RAG 直答，OSLog 记录异常摘要，App 不崩不空白。

### 1.3 问题文本生成（与模型协议明确分离）

- UI 展示的追问 = 代码用 `missing_variable_id` 从 `DecisionVariableRegistry` 取
  `question_template` 渲染，**模型不生成可展示问题**。
- 每个模板**只问一个关键变量**（单变量纪律，v0.2 全表复核）；可选补充语（如「有刻度的话也可以告诉我」）允许附在句尾，但不得引入第二个必答项。

### 1.4 治理记录（Schema v1 → v2 的正式版本化）

- **v1 原裁定**：GPT Q1（2026-10-16）批准含 `question` 字段的结构化 JSON，存档
  `gpt_replies/gpt_reply_experiment_E_design_ruling.md`。
- **v2 变更理由**：GPT v0.1 终审指出「问题文本由注册表渲染」与「模型输出 question」
  两条规则未对齐，且「语义一致」无法可靠自动校验；精简协议消除歧义并使单变量纪律
  机械可查。
- **v2 效力**：自本文件起以 v2 为准；E1 训练目标 = v2 JSON 字符串本身（E-7b 结论
  不变，仅字段集精简）；v1 保留为历史版本（archive_v01/ 与本节记录）。

## 二、变量注册表 v0.2（14 变量，单变量纪律复核）

### 2.1 anchor_role 授权分级（终审问题 4 落实）

- `design-only`：claim 仅用于**论证该变量为何有诊断意义**（设计文档），不进入训练
  输入、不作为训练目标中的事实、不注入 RAG——无训练授权要求。
- `training-candidate`：事实**可能进入训练轨迹与 RAG 注入**——必须逐条通过
  §2.4 授权核验后才可用于数据生成；核验前一律按未授权处理。

### 2.2 注册表条目

| missing_variable_id | 标准问题（单变量） | 诊断意义锚点（anchor_role） | 适用 |
|---|---|---|---|
| `brew_method` | 你用的是什么器具——手冲 V60、法压、爱乐压、摩卡壶还是意式机？ | `claim.extraction.bh-courses`（design-only：萃取按方式分层） | 全部 |
| `grind_size` | 研磨度大概什么水平——比白砂糖细、接近细盐，还是更粗？（有刻度可顺带告知） | `claim.grinding.aeropress-grind-ref`（training-candidate）、`claim.pourover.v60-official-tuning`（training-candidate）、`claim.extraction.channeling-vendor`（training-candidate） | 全部 |
| `dose` | 每次用多少克咖啡粉？ | `claim.espresso.fellow-dose-tamp`、`claim.pourover.v60-official-expert`（training-candidate） | 手冲/意式 |
| `ratio` | 粉水比大概多少——比如 1:15？ | `claim.espresso.fellow-ratio-example`（training-candidate） | 手冲/意式 |
| `water_temp` | 冲煮水温大概多少度？ | `claim.pourover.v60-official-expert`（training-candidate） | 手冲/意式 |
| `brew_time` | 从开始注水到结束大概多久？ | `claim.espresso.linea-micra-yield`、`claim.pourover.v60-official-expert`（training-candidate） | 全部 |
| `shot_yield` | 最后接了多少克咖啡液？ | `claim.espresso.linea-micra-yield`（training-candidate） | 意式 |
| `bean_roast_level` | 这支豆子是浅烘、中烘还是深烘？ | `claim.roasting.ta-peaks-first-crack`、`claim.roasting.ta-sourness-correlation`、`claim.roasting.roast-controls-flavor`（training-candidate） | 全部 |
| `roast_date` | 包装上的烘焙日期是哪天？ | `claim.freshness.resting-varies-by-roast`、`claim.freshness.dark-roast-rest-5-7d`、`claim.freshness.nca-lose-freshness-immediately`（training-candidate） | 全部 |
| `water_source` | 你用的水是自来水、过滤水还是瓶装水？ | `claim.water.sage-no-bottled`、`claim.water.sage-no-distilled`（training-candidate） | 意式为主 |
| `water_hardness` | 当地水质偏硬吗（容易结水垢吗）？ | `claim.water.scale-mechanism`、`claim.water.rancilio-filtration`（training-candidate） | 意式为主 |
| `descale_history` | 机器上一次除垢是什么时候？ | `claim.water.sage-descale-thresholds`、`claim.cleaning.no-universal-cycle`（training-candidate） | 意式 |
| `cleaning_history` | 磨豆机（或机器）上一次清洁是什么时候？ | `claim.grinding.cleaning-warranty`、`claim.cleaning.parts-diagram`（training-candidate） | 意式/磨豆机 |
| `taste_detail` | 「怪」更像哪一种——发酸发咸、焦苦发涩、青草青涩，还是说不上来的闷味？ | `claim.extraction.ucdavis-brewing-chart`、`claim.extraction.channeling-vendor`（training-candidate） | 全部（症状澄清） |

### 2.3 排除项（不变）

萃取率/TDS（需折射仪，用户不可观测，`claim.extraction.tds-measured` 仅 design-only）；
健康/医疗变量（走现行 boundary 路径）；豆种/产区（v0.2 不进注册表）。

### 2.4 授权边界（终审问题 4 的核心落实）

**现状（2026-10-16 核对 `source_exceptions.json`）**：全部 9 个已授权来源的
`deployment_purposes` 均仅为 **`noncommercial-research`**；例外范围限「已核验
claim 清单」。因此：

1. **E1/E2 训练（noncommercial-research 用途）**：`training-candidate` 锚点在授权
   覆盖内，可用于数据生成——前提是该 claim 在对应来源 `allowed_claim_ids` 内
   （生成时逐条脚本核验，交付物③门 1）。
2. **商业产品部署（训练权重端侧分发）**：现授权**不覆盖**——训练用途≠部署用途，
   需要逐来源重新评估（许可基础、商业条款、负责人与来源方确认）。此项列为
   **交付物⑦发布前置条件**，未完成前 E 产物只标记 noncommercial-research。
3. **`claim.freshness.light-roast-rest-4-6w`**：Fellow 例外 scope 明文
   「未核验，不在范围内」——**从锚点整体移除**（v0.1 误引，已纠正）；浅烘养豆期
   数据在完成核验前不得出现在任何训练样本。
4. 新增训练用途 claim 的流程：知识库补 claim（F 层核验）→ 例外表登记
   （allowed_claim_ids + 用途）→ 注册表更新——顺序不可反。
