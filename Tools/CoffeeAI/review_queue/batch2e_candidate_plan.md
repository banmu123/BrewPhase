# Batch2e 候选设计（阶段七-G 后续，2026-10-15）

> 依据：GPT 阶段七-G 终裁（存档 `review_queue/gpt_replies/gpt_reply_stage7g_experimentC_failed_freeze.md`）——
> Experiment C 不通过、A/B/C 训练线冻结；主动追问 0 分裁定为**优先验证数据侧假设**
> （非提高训练强度）：「准备一组新的候选样本，先建议 8 条左右供审查，而不是立刻把
> 它们加入 approved 数据。其中约一半体现『信息不足时，先问一个能区分诊断方向的关键
> 问题』，另一半体现『已有足够信息时直接回答』，避免模型将追问学成机械模板。」
> **本文件只出 plan，不写候选正文、不落库、不训练。**

## 设计目标（GPT 阶段七-G 终裁）

- 补最大能力缺口：**clarification（主动追问）**——35 条中仅 2 条（b2b-001/b2d-008），
  且实验 A/B/C 三轮评测追问均为 0 分；
- **双侧设计防模板化**：4 条追问（问「能区分诊断方向的关键问题」）+ 4 条直答
  （信息完整时直接回答）——保留实验 C 已验证的优点「直接解释类不转追问」
  （GPT：这是一个需要保留的优点，不能为追问得分而牺牲它）；
- 追问设计规格升级：现有 b2c-001 模式为「列最小信息集」，本轮升级为「先问**单个
  关键问题**，该问题的答案能区分诊断方向」（GPT 原话：真正询问有助于诊断的关键
  信息，而非只列原因）。

## 来源与授权约束（预检全部通过）

- **只用已有 9 例外来源 + fda 自动准入，零新增 claim/source/exception/topics**
  （GPT：任何新实验都应建立在可追溯的新数据版本上；原 35 条 approved、例外记录、
  28/4/3 划分保持不变）；
- 全部 claim 已在对应例外 allowed_claim_ids 内（逐条标注）；
- **topic 预检**：每条 topic 落在来源例外 allowed_topics 内（六点九-E 教训）；
- 与现有 35 条逐条差异化（对照全量 user 提问清单，无同题）。

## 八条设计

### 追问侧（interaction_skill=clarification × 4）

#### b2e-001 ｜ 追问-手冲苦涩分流：「我的手冲喝起来又苦又涩，怎么回事？」

- **user_scenario**：症状（苦+涩复合）求诊断，信息不足——与 b1-013（流速慢的机制
  解释）差异化：本条是症状→需诊断分流
- **追问设计（核心）**：先问**一个关键问题**——「冲煮总时长大概多久、水流是偏快
  还是偏慢？」答案区分两大方向：流速慢/时长长 → 过萃方向（rule.hario.v60.too-slow
  支撑流速慢的后果）；流速正常 → 豆因方向（烘焙度/豆子本身），追问烘焙度
- **claim_ids**: ["rule.hario.v60.too-slow"]｜**source**: hario-v60-expert-guide
  （topic=brewing-troubleshooting ∈ allowed_topics ✓）
- **risk_notes**: 「涩」的细分（过萃涩 vs 粉感 vs 豆因）用常识级表述，不编造机理；
  追问后**不提前下结论**
- **training_value**: ★★★★★（实验 C 评测 q5/nat 类的追问标杆）

#### b2e-002 ｜ 追问-换豆变味分流：「换了新豆子，参数完全没变，味道却完全不同，是豆子的问题吗？」

- **user_scenario**: 换豆后风味异常——与 b2a-010（同包豆开封前后时间轴）差异化：
  本条是豆间差异
- **追问设计（核心）**: 先问「新豆的**烘焙度**和**烘焙日期**？」——答案区分：
  醒豆不足（深烘需更久）vs 烘焙度差异导致参数不适配，两个方向的处理路径不同
- **claim_ids**: ["claim.freshness.resting-varies-by-roast"]｜**source**: fellow-brew-talks
  （topic=brewing ∈ allowed_topics ✓）
- **risk_notes**: 不断言「一定是醒豆问题」；醒豆时长按 claim 原文范围，不编造绝对数字
- **training_value**: ★★★★

#### b2e-003 ｜ 追问-意式双症状：「我的意式浓缩流速很快，油脂也很少，怎么回事？」

- **user_scenario**: 物理症状组合（流速快+油脂少）——与 b1-014/015（口味症状）与
  b2d-008（「最近难喝」时间信号）差异化：本条是**双症状各引一条分流线**
- **追问设计（核心）**: 两个症状各问一个关键问题——流速快 →「研磨刻度最近动过吗？」
  （研磨方向）；油脂少 →「豆子的烘焙日期和烘焙度？」（新鲜度/浅烘方向）——并说明
  两条线分开排查的原因
- **claim_ids**: ["rule.fellow.shot-slow", "rule.gaggia.no-crema"]｜**source**:
  fellow-espresso-basics + gaggia-classic-manual（多来源并集；topic=espresso 在两来源
  allowed_topics 交集 ✓）
- **risk_notes**: 双来源引用按多来源并集语义；追问不给结论；油脂机理不编造
  （no-crema rule 按原文表述）
- **training_value**: ★★★★

#### b2e-004 ｜ 追问-感官描述缺失：「朋友说我冲的咖啡有股怪味，但我说不上来是哪种怪」

- **user_scenario**: 用户无法描述症状——追问的极致场景：**先教结构化描述，再问
  单个选择题式关键问题**（「更接近哪种：纸味/青草味/焦苦味/尖酸味？」）——不同
  选择指向不同环节（滤纸未润洗/烘焙发展不足/过萃/萃取不足）
- **claim_ids**: ["claim.sensory.brewing-chart-profiles"]｜**source**: ucdavis-coffee-center
  （topic=pour-over diagnosis ✓）
- **risk_notes**: 怪味→环节的对应用常识级表述；风味轮廓多维描述以 claim 支撑，
  不编造化合物/机理；与 b2b-008（已知花香问机理）差异化
- **training_value**: ★★★★（追问学成「区分诊断方向」的关键样本）

### 直答侧（防模板化对照 × 4）

#### b2e-005 ｜ 直答-对比类：「冷萃咖啡和冰手冲是一回事吗？」

- **user_scenario**: 概念对比，信息完整——**直接对齐实验 C 评测 nat_q8**（冷萃 vs
  冰咖啡），为下一轮实验提供直答标杆
- **answer_structure**: A 直接回答（不是一回事：冷萃=低温长时间浸滤；冰手冲=热萃+
  冰快冷）→ B 机理差异（温度-烘焙度交互 claim 支撑）→ 下一步
- **claim_ids**: ["claim.coldbrew.roast-x-temp-interaction"]｜**source**: fellow-brew-talks
  （topic=cold-brew ∈ allowed_topics ✓）
- **risk_notes**: **零追问**；对比维度不编造（按 claim 原文范围）
- **interaction_skill**: knowledge_explanation｜**training_value**: ★★★★

#### b2e-006 ｜ 直答-事实锚点：「为什么 V60 的官方配方和别人给的配方数字都不一样？」

- **user_scenario**: 用户观察到「官方配方彼此矛盾」求解释——与 b2b-003（拒绝用户
  要黄金参数）差异化：本条在**事实层**解释「官方配方本来就不同」
- **answer_structure**: A 直接回答（确实不同，不是你的错觉）→ B 证据（官方配方差异
  的 conflict claim 支撑）→ C 含义（配方是起点不是标准答案）→ 下一步
- **claim_ids**: ["conflict.v60.official-recipes-differ"]｜**source**: hario-v60-hoffmann
  （topic=brewing ∈ allowed_topics ✓）
- **risk_notes**: **零追问**；具体数字仅按 claim 原文引用，不自行列举未核对配方
- **interaction_skill**: knowledge_explanation｜**training_value**: ★★★★

#### b2e-007 ｜ 直答-醒豆：「深烘豆是不是要多放几天再冲？」

- **user_scenario**: 信息完整的直接解释（醒豆时长与烘焙度关系）——与 b2a-009/010
  （陈化/开封变化）差异化：本条是「养豆期」
- **answer_structure**: A 直接回答（是，醒豆时长随烘焙度变化）→ B 依据（深烘 rest
  claim + varies-by-roast claim）→ C 实操边界 → 下一步
- **claim_ids**: ["claim.freshness.dark-roast-rest-5-7d", "claim.freshness.resting-varies-by-roast"]｜
  **source**: fellow-brew-talks（topic=freshness ∈ allowed_topics ✓）
- **risk_notes**: **零追问**；时长按 claim 原文（5-7 天范围），不写成绝对数字
- **interaction_skill**: knowledge_explanation｜**training_value**: ★★★★

#### b2e-008 ｜ 直答-维护类：「Gaggia Classic 大概多久除一次垢？除垢能 用醋吗？」

- **user_scenario**: 设备维护双问（周期+用水），信息完整——**cleaning-maintenance
  是现有 35 条未覆盖的新 topic**（gaggia 来源 3 条 claim 至今零使用）
- **answer_structure**: A 直接回答周期（conflict.gaggia.classic-descale-interval 按
  原文，注明与用水硬度相关）→ B 用水边界（claim.water.gaggia-vinegar-ban 禁醋）
  → 下一步
- **claim_ids**: ["conflict.gaggia.classic-descale-interval", "claim.water.gaggia-vinegar-ban"]｜
  **source**: gaggia-classic-manual（topic=cleaning-maintenance ∈ allowed_topics ✓）
- **risk_notes**: **零追问**；周期表述按 manual 原文（冲突语义=不同版本说法不一，
  如实呈现）；不推广到其他机型
- **interaction_skill**: condition_based_advice｜**training_value**: ★★★★

## 汇总

| 维度 | 结果 |
|---|---|
| **数量与双侧比例** | 8 条 = 追问 4（clarification）+ 直答 4（knowledge_explanation 3 + condition_based_advice 1）——符合 GPT「约一半/一半」 |
| **来源分布** | fellow-brew-talks 3 / gaggia-classic-manual 2 / hario-v60-expert-guide 1 / hario-v60-hoffmann 1 / ucdavis-coffee-center 1——**零新增授权** |
| **skill 分布影响** | 落库后（43 条）：clarification 2→**6**、knowledge_explanation 2→5、condition_based_advice 3→4、uncertainty_handling 8、boundary_setting 4、multi_variable_reasoning 2 |
| **topic 覆盖** | 新增 cleaning-maintenance（b2e-008，gaggia 授权内）；其余 brewing-troubleshooting/brewing/espresso/pour-over diagnosis/cold-brew/freshness 均在既有授权内 |
| **风险分级** | 中风险：b2e-001/002/003（诊断分流型追问）；中风险：b2e-004（感官描述教学）；低风险：b2e-005/006/007/008（直答，claim 支撑扎实） |
| **防模板化机制** | 追问侧全部为「单个关键问题区分诊断方向」（非列清单）；直答侧全部零追问直答——两组对照防「万事追问」与「从不追问」两个极端 |
| **与评测的关系** | b2e-005 对齐 nat_q8（冷萃对比）；追问侧对齐 gov_q5/q6 验收指标；b2e-006 对齐 gov_q3（拒伪标准的事实层） |

## 待 GPT 确认项

1. **批次名 batch2e** 是否合适（延续批次序列；或 GPT 指定新命名）；
2. **追问设计规格**：b2e-001/002/004 为「先问单个关键问题」、b2e-003 为「双症状各
   问一个」——是否符合「能区分诊断方向的关键问题」意图（相对 b2c-001 的信息集
   列举模式是规格升级）；
3. **b2e-004 的 claim 支撑强度**：brewing-chart-profiles 支撑「结构化描述框架」是否
   足够（怪味→环节对应为常识级正文）；
4. **流程**：plan ✓ →（待批准）draft → gate → review → 负责人拍板 → 落库（43 条）→
   split 重算（新数据版本）→ 是否做新一轮 3B 实验由 GPT 在数据就绪后再裁定。

## 流程纪律（GPT 终裁原文）

> 「准备一组新的候选样本，先建议 8 条左右供审查，而不是立刻把它们加入 approved
> 数据」「原有 35 条 approved 数据、例外记录和当前 split 都保持不变」「现在不启动
> 新训练、不融合、不部署」「评测也要继续保留『万事追问』的反向检查」。
