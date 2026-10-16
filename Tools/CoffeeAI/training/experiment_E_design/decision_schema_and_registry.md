# Experiment E 交付物①：决策输出 Schema v2 + 变量注册表 v0.3

> **v0.3 修订依据**：GPT 对 v0.2 的复核（存档
> `review_queue/gpt_replies/gpt_reply_experiment_E_v02_review_v03_required.md`）——
> claim 授权核验未落实到全部候选。v0.3 新增 **§2.5 锚点准入核验表**（22 锚点逐一
> 对照 `source_exceptions.json` 实测），未获准锚点降级 design-only/blocked 并替换
> 授权内等价锚点；`light-roast-rest-4-6w` 维持移出。v0.1/v0.2 原件保留于
> `archive_v01/`、`archive_v02/`。

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

### 2.2 注册表条目（锚点按 §2.5 核验结果更新，v0.3）

| missing_variable_id | 标准问题（单变量） | 诊断意义锚点（全部 ✅ PASS，详见 §2.5） | 适用 |
|---|---|---|---|
| `brew_method` | 你用的是什么器具——手冲 V60、法压、爱乐压、摩卡壶还是意式机？ | `claim.extraction.bh-courses`（design-only） | 全部 |
| `grind_size` | 研磨度大概什么水平——比白砂糖细、接近细盐，还是更粗？（有刻度可顺带告知） | `claim.pourover.v60-official-tuning`、`rule.hario.v60.too-weak`、`rule.hario.v60.too-slow`、`rule.fellow.shot-sour`、`rule.fellow.shot-bitter`、`claim.extraction.channeling-vendor`（training-candidate） | 全部 |
| `dose` | 每次用多少克咖啡粉？ | `claim.pourover.v60-official-expert`（15g/250g）（training-candidate） | 手冲/意式 |
| `ratio` | 粉水比大概多少——比如 1:15？ | `claim.pourover.v60-official-expert`（1:16.7）、`claim.pourover.v60-hoffmann-recipe`（1:15）、`claim.espresso.fellow-ratio-1to3`（1:3）（training-candidate） | 手冲/意式 |
| `water_temp` | 冲煮水温大概多少度？ | `claim.pourover.v60-official-expert`（92–96°C）、`claim.pourover.v60-hoffmann-recipe`（97°C）（training-candidate） | 手冲/意式 |
| `brew_time` | 从开始注水到结束大概多久？ | `claim.pourover.v60-official-expert`（约 2.5 分钟）（training-candidate） | 手冲为主（意式场景暂缓，见 shot_yield） |
| `shot_yield` | 最后接了多少克咖啡液？ | （原 linea-micra-yield 未获准——**blocked**） | 意式（场景暂缓） |
| `bean_roast_level` | 这支豆子是浅烘、中烘还是深烘？ | `claim.roasting.ta-peaks-first-crack`、`claim.roasting.ta-sourness-correlation`、`claim.roasting.roast-controls-flavor`、`claim.defects.roast-level-acrid`（training-candidate） | 全部 |
| `roast_date` | 包装上的烘焙日期是哪天？ | `claim.freshness.resting-varies-by-roast`、`claim.freshness.dark-roast-rest-5-7d`、`claim.freshness.nca-lose-freshness-immediately`（training-candidate） | 全部 |
| `water_source` | 你用的水是自来水、过滤水还是瓶装水？ | （sage 系未获准且语义仅涉除垢——**design-only**） | 意式为主（场景暂缓） |
| `water_hardness` | 当地水质偏硬吗（容易结水垢吗）？ | （scale-mechanism 等未获准——**design-only**） | 意式为主（场景暂缓） |
| `descale_history` | 机器上一次除垢是什么时候？ | `conflict.gaggia.classic-descale-interval`、`claim.water.gaggia-vinegar-ban`（training-candidate，**限 Gaggia 语境**） | Gaggia 机型 |
| `cleaning_history` | 磨豆机（或机器）上一次清洁是什么时候？ | （cleaning-warranty / parts-diagram 未获准——**design-only**） | 磨豆机（场景暂缓） |
| `taste_detail` | 「怪」更像哪一种——发酸发咸、焦苦发涩、青草青涩，还是说不上来的闷味？ | `claim.sensory.brewing-chart-profiles`、`claim.extraction.channeling-vendor`、`rule.fellow.shot-sour`、`rule.fellow.shot-bitter`（training-candidate） | 全部（症状澄清） |

### 2.3 排除项（不变）

萃取率/TDS（需折射仪，用户不可观测，`claim.extraction.tds-measured` 仅 design-only）；
健康/医疗变量（走现行 boundary 路径）；豆种/产区（v0.2 不进注册表）。

### 2.4 授权边界（终审问题 4 的核心落实；v0.3 授权状态经 §2.5 实测细化）

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

### 2.5 锚点准入核验表（v0.3 新增，GPT v0.2 复核问题 3 落实）

**核验方法**：逐一对照 `source_exceptions.json` 各来源 `allowed_claim_ids` 实测
（2026-10-16 运行脚本核对，与 GPT 复核结论一致）。**规则**：training-candidate
锚点必须 PASS；MISS 锚点降级 design-only 或替换为授权内等价 claim；**无授权锚点
支撑的变量标 blocked——其专项事实场景不进入数据生成**（中性追问行为样本不受限，
因问题文本本身不含 claim 事实）。

#### 2.5.1 逐锚点核验结果

| 锚点 | 来源 | allowed_claim_ids 实测 | 处置 |
|---|---|---|---|
| claim.pourover.v60-official-tuning | hario-v60-expert-guide | ✅ 在清单 | 保留 training-candidate |
| claim.extraction.channeling-vendor | fellow-espresso-basics | ✅ 在清单 | 保留 training-candidate |
| claim.pourover.v60-official-expert | hario-v60-expert-guide | ✅ 在清单 | 保留 training-candidate |
| claim.roasting.ta-peaks-first-crack | ucdavis-coffee-center | ✅ 在清单 | 保留 training-candidate |
| claim.roasting.ta-sourness-correlation | ucdavis-coffee-center | ✅ 在清单 | 保留 training-candidate |
| claim.roasting.roast-controls-flavor | ucdavis-coffee-center | ✅ 在清单 | 保留 training-candidate |
| claim.freshness.resting-varies-by-roast | fellow-brew-talks | ✅ 在清单 | 保留 training-candidate |
| claim.freshness.dark-roast-rest-5-7d | fellow-brew-talks | ✅ 在清单 | 保留 training-candidate |
| claim.freshness.nca-lose-freshness-immediately | nca-aboutcoffee | ✅ 在清单 | 保留 training-candidate |
| **claim.sensory.brewing-chart-profiles** | ucdavis-coffee-center | ✅ 在清单 | **新增替换**：taste_detail 锚点（替代 MISS 的 extraction.ucdavis-brewing-chart——该 claim 属 ucdavis-research-index，不能用 coffee-center 例外替代） |
| **rule.hario.v60.too-weak / too-slow** | hario-v60-expert-guide | ✅ 在清单 | **新增**：grind_size 意义锚点（官方调参规则） |
| **rule.fellow.shot-sour / shot-bitter** | fellow-espresso-basics | ✅ 在清单 | **新增**：grind_size / taste_detail 症状分流锚点 |
| **claim.espresso.fellow-ratio-1to3** | fellow-espresso-basics | ✅ 在清单 | **新增替换**：ratio 意式侧锚点（替代 MISS 的 fellow-ratio-example） |
| **claim.pourover.v60-hoffmann-recipe** | hario-v60-hoffmann | ✅ 在清单 | **新增**：ratio / water_temp 锚点（97°C、1:15） |
| **conflict.gaggia.classic-descale-interval** | gaggia-classic-manual | ✅ 在清单 | **新增**：descale_history 锚点（替代 MISS 的 sage-descale-thresholds） |
| **claim.water.gaggia-vinegar-ban** | gaggia-classic-manual | ✅ 在清单 | **新增**：descale_history 锚点 |
| **claim.defects.roast-level-acrid** | fellow-espresso-basics | ✅ 在清单 | **新增**：bean_roast_level 锚点（深烘焦苦语义） |
| claim.extraction.bh-courses | barista-hustle | ❌ 来源不在例外表 | 维持 design-only（原判不变） |
| claim.grinding.aeropress-grind-ref | aeropress-how-to-use | ❌ 来源不在例外表 | **降级 design-only** |
| claim.espresso.fellow-dose-tamp | fellow-espresso-basics | ❌ 不在该来源清单 | **降级 design-only**（dose 改引 v60-official-expert） |
| claim.espresso.fellow-ratio-example | fellow-brew-talks | ❌ 不在该来源清单 | **移出**（ratio 意式侧改引 fellow-ratio-1to3） |
| claim.espresso.linea-micra-yield | lamarzocco-* | ❌ 来源不在例外表且许可商业不明 | **降级 design-only**（brew_time 手冲侧、shot_yield 变量受影响见下） |
| claim.water.sage-no-bottled / sage-no-distilled | sage-bes875-* | ❌ 来源不在例外表 | **降级 design-only**；且 GPT 指出语义仅涉除垢用水——water_source 锚点整体降级 |
| claim.water.scale-mechanism / rancilio-filtration / sage-descale-thresholds | sage / rancilio | ❌ 来源不在例外表 | **降级 design-only** |
| claim.cleaning.no-universal-cycle / parts-diagram / claim.grinding.cleaning-warranty | 各来源 | ❌ 不在对应来源清单 | **降级 design-only**（cleaning_history 降级） |
| claim.extraction.tds-measured | ucdavis-coldbrew-2025 | ❌ 不适用（本就 design-only） | 维持 |
| claim.freshness.light-roast-rest-4-6w | fellow-brew-talks | ❌ scope 明文未核验 | 维持移出（v0.2 已处理） |

#### 2.5.2 变量级准入状态（v0.3 生效）

| 变量 | 准入状态 | 数据生成约束 |
|---|---|---|
| brew_method / grind_size / dose / ratio / water_temp / brew_time / bean_roast_level / roast_date / taste_detail | **training-candidate**（锚点全 PASS） | 正常生成；RAG 证据仅注入上表 ✅ claim |
| descale_history | **training-candidate（限 Gaggia 场景）** | 仅生成 Gaggia 类机型场景（锚点 conflict.gaggia.* / vinegar-ban 均为 Gaggia 语境）；其他机型暂缓 |
| shot_yield | **blocked** | 唯一锚点 linea-micra-yield 未获准——专项场景不生成，待 lamarzocco 授权审批 |
| water_source / water_hardness / cleaning_history | **design-only** | 锚点未获准 + GPT 指出 Sage 语义仅覆盖除垢用水、不支撑风味诊断——专项事实场景暂不生成；变量保留注册表（问题文本中性），授权与语义核验完成后升 |

**约束重申**：核验表随例外表变更同步更新（脚本重跑）；任何 training-candidate
锚点在使用时仍逐条过交付物③门 1。blocked/design-only 变量**可以出现在对话里**
（用户自然提及），但其**诊断事实不得成为 RAG 证据或训练目标中的事实**。
