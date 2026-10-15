# Batch2e 候选设计 v3（阶段七-G 后续，2026-10-15）

> **v3 修订依据**：GPT 对 plan v2 的复核（存档
> `review_queue/gpt_replies/gpt_reply_batch2e_planv2_two_fixes.md`）——v2 基本通过，
> 进 draft 前两项小修正：① b2e-005 补 claim.roasting.ta-peaks-first-crack（TA 一爆
> 达峰后下降的方向性依据，UC Davis 例外内）+ 四条答案约束；② 来源统计改为
> 6 来源/9 次引用口径（补 fellow-espresso-basics）。v3 逐项落实，**待 GPT 批准后
> 进入 draft**。
> **v2 修订依据**：GPT 对 v1 plan 的核验（存档
> `review_queue/gpt_replies/gpt_reply_batch2e_plan_revision_required.md`）——方向与
> 批次名通过，但暂不批准进 draft，要求修订三项：b2e-003 claim 方向不匹配、
> b2e-004 因果映射超出证据、b2e-005 来源归属与许可问题。v2 逐项落实，并补
> allowed_sample_ids 更新时点声明。
> 总依据：GPT 阶段七-G 终裁（`gpt_reply_stage7g_experimentC_failed_freeze.md`）——
> 主动追问 0 分优先验证数据侧假设；8 条左右候选先供审查；双侧设计防模板化。
> **本文件只出 plan，不写候选正文、不落库、不训练。**

## 设计目标（GPT 阶段七-G 终裁 + plan 核验补充）

- 补最大能力缺口：**clarification（主动追问）**——35 条中仅 2 条，实验 A/B/C 三轮
  评测追问均为 0 分；
- **双侧设计防模板化**：4 条追问 + 4 条直答——保留实验 C 已验证的优点「直接解释
  类不转追问」（GPT：需要保留的优点，不能为追问得分而牺牲）；
- 追问设计规格：**先问单个最有诊断价值的关键问题**，首轮不堆问题清单；拿到回答后
  只能**缩小排查范围**，不能直接给出唯一原因（GPT v2 核验裁定：不要把分支写成
  确定诊断）；无证据支撑的机理关系必须**明确标注为待验证推断**。

## 来源与授权约束（v2 修正后全部通过）

- 只用已有 9 例外来源，零新增 claim/source/exception/topics；全部 claim 在对应
  例外 allowed_claim_ids 内（逐条标注）；topic 逐条预检在 allowed_topics 内；
- **来源分布（v3 修正，GPT 复核确认口径）**：**6 个不同来源、9 次样本—来源引用**：
  fellow-brew-talks 2（b2e-002/007）/ gaggia-classic-manual 2（b2e-008 + b2e-003
  第二来源）/ ucdavis-coffee-center 2（b2e-004/005）/ hario-v60-expert-guide 1
  （b2e-001）/ hario-v60-hoffmann 1（b2e-006）/ **fellow-espresso-basics 1（b2e-003
  第一来源）**——b2e-003 使用两个来源，其余各样本各一个；**零新增授权**；
- **与知识库的 claim 语义核对（GPT v2 核验要点）**：
  - rule.fellow.shot-slow 支撑的是「流速**过慢**→研磨偏细→磨粗」——v1 误用于
    「流速很快」症状，v2 已改题（见 b2e-003）；
  - claim.coldbrew.roast-x-temp-interaction 在知识库实际归于 ucdavis-coldbrew-2025
    （许可 see-source-terms，商业/衍生使用不明确）——**冷萃题暂缓**（v1 的
    b2e-005 已替换，见下）；
  - brewing-troubleshooting.md 将涩感/干涩等的具体多因解释与判别测试列为**待补证
    内容**——涉及症状归因的样本不得绕过此边界。
- **allowed_sample_ids 更新时点（GPT 裁定原文落实）**：
  1. 现在至负责人批准前：不修改 approved 数据、来源例外、allowed_sample_ids 或
     现有划分；
  2. 具体候选获批并准备落库时：仅将实际获批样本 ID 纳入对应既有来源例外，更新
     对应 manifest，保留审计依据；
  3. 不新增来源、claim 或 topic 授权，不借此扩展其他样本使用范围；
  4. 无法证明符合现有 claim 与来源许可的候选，不能仅靠增加 allowed_sample_ids
     获得通过。

## 八条设计（v2）

### 追问侧（interaction_skill=clarification × 4）

#### b2e-001 ｜ 追问-手冲苦涩：「我的手冲喝起来又苦又涩，怎么回事？」

- **user_scenario**：症状（苦+涩复合）求诊断，信息不足——与 b1-013（流速慢的机制
  解释）差异化
- **追问设计（v2 收紧）**：先问**一个**关键问题——「冲煮总时长大概多久、水流偏快
  还是偏慢？」拿到回答后**据此缩小排查范围**（流速偏慢 → 优先看研磨是否偏细，
  rule.hario.v60.too-slow 支撑「水流过慢与研磨偏细有关、调整方向磨粗」）；不宣称
  「苦涩+流速慢=过萃」的确定诊断；流速正常分支不预设「归因豆子」，作为待确认
  方向继续问豆子信息
- **claim_ids**: ["rule.hario.v60.too-slow"]｜**source**: hario-v60-expert-guide
  （topic=brewing-troubleshooting ∈ allowed_topics ✓）
- **risk_notes**: 更具体的苦涩机理若写入，**标注为待验证推断**（GPT v2 裁定）；
  追问后不提前下结论
- **training_value**: ★★★★★

#### b2e-002 ｜ 追问-换豆变味：「换了新豆子，参数完全没变，味道却完全不同，是豆子的问题吗？」

- **user_scenario**: 换豆后风味异常——与 b2a-010（同包豆开封前后时间轴）差异化
- **追问设计（v2 收紧）**: 先问一个简洁复合问题「新豆的**烘焙度**和**烘焙日期**？」
  （GPT：一条简洁复合问题索取两个紧密相关字段可以）——两种可能原因（醒豆不足 /
  烘焙度不适配）作为**待确认方向**呈现，claim 只支撑「养豆期随烘焙度与处理法变化」
  这一层，不宣称信息能确诊
- **claim_ids**: ["claim.freshness.resting-varies-by-roast"]｜**source**: fellow-brew-talks
  （topic=brewing ∈ allowed_topics ✓）
- **risk_notes**: 醒豆时长不编造绝对数字；不断言「一定是醒豆问题」
- **training_value**: ★★★★

#### b2e-003 ｜ 追问-意式双症状（v2 改题）：「我的意式浓缩流速很慢，出一份要等很久，油脂也偏少，怎么回事？」

- **v2 修订说明（GPT 裁定落实）**: v1 题为「流速很**快**」，但 rule.fellow.shot-slow
  支撑的是流速**过慢**方向（过慢→研磨偏细→磨粗）——claim 与症状方向不匹配。
  v2 将症状改为**流速过慢**，与 claim 语义对齐；「油脂偏少」保留（rule.gaggia.no-crema
  在 gaggia 例外内，按原文语义支撑「不出油脂」的排查）。
- **追问设计（GPT v2 裁定：首轮单问题）**: 首轮只问**最有信息价值的一个问题**——
  「研磨刻度最近动过吗？」（流速过慢的最直接方向）；同时说明「油脂偏少与豆子新鲜
  度相关，这个问题我们分开排查，等流速的问题确认后再看」——不堆问题清单，等用户
  回应后再继续第二步
- **claim_ids**: ["rule.fellow.shot-slow", "rule.gaggia.no-crema"]｜**source**:
  fellow-espresso-basics + gaggia-classic-manual（多来源并集；topic=espresso 在两
  来源 allowed_topics 交集 ✓）
- **risk_notes**: 两症状分开排查、单问题推进；研磨调整方向按 shot-slow 原文
  （磨粗）；油脂机理不编造
- **training_value**: ★★★★★（首轮单问题 + 分步排查的标杆样本）

#### b2e-004 ｜ 追问-感官描述缺失（v2 降级映射）：「朋友说我冲的咖啡有股怪味，但我说不上来是哪种怪」

- **user_scenario**: 用户无法描述症状—— clarification 的极致场景
- **追问设计（v2 按 GPT 建议重写）**: 助手先帮助用户**描述感官特征**（干香/湿香/
  入口后的位置与质感），再问一个**选择题式问题**（「更接近纸味/青草味/焦苦味/
  尖酸味中的哪种？」）——**选项仅用于帮助用户描述，不暗示每种气味唯一对应某个
  环节**（GPT v2 裁定：v1 的「纸味→滤纸未润洗」等映射超出 claim.sensory.
  brewing-chart-profiles 的支持范围，且 brewing-troubleshooting.md 已把此类多因
  解释列为待补证内容）；用户回答后按**已有证据**缩小排查方向，无证据的关系以
  「待验证推断」明确标注
- **claim_ids**: ["claim.sensory.brewing-chart-profiles"]｜**source**: ucdavis-coffee-center
  （topic=pour-over diagnosis ✓；claim 支撑「风味轮廓多维、按 TDS/萃取率描述」的
  框架层）
- **risk_notes**: 不绕过 brewing-troubleshooting 的待补证边界；不编造化合物/机理
- **training_value**: ★★★★

### 直答侧（防模板化对照 × 4）

#### b2e-005 ｜ 直答-知识锚点（v2 替换 + v3 按 GPT 复核补 claim）：「烘焙度越深，咖啡就越不酸吗？」

- **v2 修订说明（GPT 裁定落实）**: v1 本条为冷萃对比题，但
  claim.coldbrew.roast-x-temp-interaction 在知识库实际归于 ucdavis-coldbrew-2025
  （许可 see-source-terms、商业/衍生使用不明确）——不能归于 fellow-brew-talks，
  **冷萃题暂缓定稿**（若后续澄清该来源许可可恢复）。v2 替换为 ucdavis 已授权
  claim 正确支撑的直答题。
- **v3 补强（GPT 复核裁定）**: v2 的两条 claim 不足以支撑「烘焙加深时 TA 呈下降
  趋势」的方向性——加入 **claim.roasting.ta-peaks-first-crack**（TA 在烘焙中上升、
  一爆附近达峰、随后下降——UC Davis 例外 allowed_claim_ids 内，零新增授权）。
- **user_scenario**: 信息完整的直接知识解释——与 nat_q2（浅烘一定酸？绝对化纠偏）
  和 b2d-003（豆子无香味？反事实纠错）差异化：本条是 TA-烘焙度关联的**事实锚点
  解释**
- **answer_structure（GPT 复核四条约束）**: A 直接回答，但**不把「深烘必然不酸」
  当成规律** → B 说明研究描述的 TA 变化趋势（ta-peaks-first-crack：上升→一爆达峰
  →下降）以及感知酸度与 TA 的关联（ta-sourness-correlation）→ C **明确这不足以
  预测每一杯的酸感**，不能忽略豆子、烘焙和冲煮条件（roast-controls-flavor 支撑
  烘焙对风味的总体影响）→ 下一步
- **claim_ids**: ["claim.roasting.ta-peaks-first-crack", "claim.roasting.ta-sourness-correlation",
  "claim.roasting.roast-controls-flavor"]｜**source**: ucdavis-coffee-center
  （topic=pour-over diagnosis ∈ allowed_topics ✓）
- **risk_notes**: **零追问**；不编造具体酸度数值；不将关联表述为无条件的因果定律
- **interaction_skill**: knowledge_explanation｜**training_value**: ★★★★

#### b2e-006 ｜ 直答-事实锚点：「为什么 V60 的官方配方和别人给的配方数字都不一样？」

- **GPT v2 裁定**: 保留。conflict.v60.official-recipes-differ 与题目直接相关；
  注意引用的具体配方**保持原来源与适用场景**，不能重新概括成行业唯一标准
- **answer_structure**: A 直接回答（确实不同，不是你的错觉）→ B 证据（官方配方
  差异的 conflict claim 支撑，逐个注明原来源）→ C 含义（配方是起点不是标准答案）
  → 下一步
- **claim_ids**: ["conflict.v60.official-recipes-differ"]｜**source**: hario-v60-hoffmann
  （topic=brewing ∈ allowed_topics ✓）
- **risk_notes**: **零追问**
- **interaction_skill**: knowledge_explanation｜**training_value**: ★★★★

#### b2e-007 ｜ 直答-醒豆（v2 加适用范围限定）：「深烘豆是不是要多放几天再冲？」

- **GPT v2 裁定**: 保留，但 5–7 天建议针对**特定的深烘肯尼亚豆配方**，并非所有
  深烘咖啡的普遍规律——答题方向：醒豆期因豆子、烘焙度和处理法而不同；可提供
  该特定配方的参考范围，但明确**不能直接推广到所有深烘豆**
- **claim_ids**: ["claim.freshness.dark-roast-rest-5-7d", "claim.freshness.resting-varies-by-roast"]｜
  **source**: fellow-brew-talks（topic=freshness ∈ allowed_topics ✓）
- **risk_notes**: **零追问**；不把 5-7 天写成普适数字
- **interaction_skill**: knowledge_explanation｜**training_value**: ★★★★

#### b2e-008 ｜ 直答-维护类：「Gaggia Classic 大概多久除一次垢？除垢能用醋吗？」

- **GPT v2 裁定**: 保留（补上清洁与维护主题）。直答时**完整保留冲突边界**：不同
  代际或版本的手册可能给出不同除垢周期，**以用户机器对应的手册为准**，不能把某
  个版本的周期泛化为所有 Gaggia Classic 的统一规定；醋的问题按适用手册中指定
  清洁剂的要求作答（claim.water.gaggia-vinegar-ban 禁醋按原文）
- **claim_ids**: ["conflict.gaggia.classic-descale-interval", "claim.water.gaggia-vinegar-ban"]｜
  **source**: gaggia-classic-manual（topic=cleaning-maintenance ∈ allowed_topics ✓——
  现有 35 条未覆盖的新 topic）
- **risk_notes**: **零追问**
- **interaction_skill**: condition_based_advice｜**training_value**: ★★★★

## 汇总（v2）

| 维度 | 结果 |
|---|---|
| **数量与双侧比例** | 8 条 = 追问 4（clarification）+ 直答 4（knowledge_explanation 3 + condition_based_advice 1） |
| **来源分布（v3 修正）** | **6 来源 / 9 次引用**：fellow-brew-talks 2 / gaggia-classic-manual 2 / ucdavis-coffee-center 2 / hario-v60-expert-guide 1 / hario-v60-hoffmann 1 / fellow-espresso-basics 1（b2e-003 双来源）——**零新增授权** |
| **v1→v3 修订清单** | ① b2e-003 改题（流速很快→流速过慢，匹配 rule.fellow.shot-slow）+ 首轮单问题；② b2e-004 删除因果映射、降级为描述辅助+推断标注；③ b2e-005 冷萃题替换（来源许可问题，暂缓）；④ b2e-001/002 分流改「缩小排查范围」、机理标注待验证推断；⑤ b2e-007 加适用范围限定；⑥ b2e-008 加冲突边界；⑦ 来源统计补 fellow-espresso-basics；⑧（v3）b2e-005 补 claim.roasting.ta-peaks-first-crack + 四条答案约束、来源统计改为 6 来源/9 次引用口径 |
| **skill 分布影响** | 落库后（43 条）：clarification 2→6、knowledge_explanation 2→5、condition_based_advice 3→4 |
| **风险分级** | 中风险：b2e-001/002/003/004（追问诊断，含推断标注要求）；低风险：b2e-005/006/007/008（直答，claim 支撑扎实） |
| **数据版本语义** | batch2e 是候选批次名；未来获批后 approved 数据作为**新数据版本**重新生成训练划分，原 35 条与 28/4/3 划分保留为历史版本不覆盖（GPT 裁定） |

## 流程与纪律（GPT v2 核验裁定原文）

> 修订通过后流程：plan 复核通过 → draft → candidate quality gate → review package
> → 负责人逐条拍板 → 更新实际获批的来源样本范围与 manifest → 准入验证 → 新数据
> 版本重新 split → leakage 检查与回归评测。
> **即使 8 条全部获批、approved 达 43 条，也不自动批准新一轮 3B 训练**——训练线
> 保持冻结，待数据版本就绪、质量门禁通过后由 GPT 单独裁定。
