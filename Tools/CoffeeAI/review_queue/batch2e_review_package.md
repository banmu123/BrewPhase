# Batch2e 人工审核包（阶段七-G 后续，2026-10-15）

> 依据：GPT plan v3 批准（存档 `gpt_replies/gpt_reply_batch2e_planv2_two_fixes.md` +
> 批准回复——「批准进入 draft 阶段」）。定位（GPT 终裁）：**追问能力数据侧验证批次**
> ——4 条追问（clarification，单个有诊断价值的问题、不写确定因果、推断标注）+
> 4 条直答（防模板化对照），**不是知识扩充批次**。
> 禁止：批准、落库、更新 allowed_sample_ids/manifest、重新划分、训练。
> 检查链：quality gate **PASSED**（checked=8, errors=0, warnings=0）；admission
> **8 BLOCK**（唯一缺口=allowed_sample_ids 未含 b2e-*；topics 层全过；落库时才并入
> 实际获批 ID——plan v3 三段式时点声明）；143 tests OK。

## 汇总

| 项 | 值 |
|---|---|
| Batch2e candidate_count | **8**（追问 4：b2e-001/002/003/004；直答 4：b2e-005/006/007/008） |
| quality_gate | **PASS**（0 error / 0 warning） |
| source admission | **8 BLOCK**（唯一缺口=allowed_sample_ids——预期同构；来源/topics/claim 全部在既有授权内） |
| 来源分布 | 6 来源 / 9 次引用：fellow-brew-talks 2 / gaggia-classic-manual 2 / ucdavis-coffee-center 2 / hario-v60-expert-guide 1 / hario-v60-hoffmann 1 / fellow-espresso-basics 1 |
| approved_current / potential | 35 → **43**（clarification 2→6） |
| 训练状态 | **冻结**（GPT 终裁：即使 43 条也不自动批准新一轮 3B 训练，待数据版本就绪后单独裁定） |
| 回归 | 143 tests OK；build_kb --check OK（见提交记录） |
| 负责人拍板清单 | 逐条 approve / revise / reject；任何未批准样本不落库 |

## b2e-001 ｜ 追问-手冲苦涩（「我的手冲喝起来又苦又涩，怎么回事？」）

### A. 新增模型行为能力
面对复合症状描述，**先问一个最有诊断价值的关键问题**（总时长与流速状态）而不是列
排查清单——拿到回答后**缩小排查范围**，不给出唯一原因。

### B. Interaction 能力审核
- interaction_skill=clarification ✅：单问题推进（「总时长大概多久？水流偏快还是偏慢？」）；
  追问后明确「再决定是调研磨还是看豆子」——分步而非一次性收集 ✅
- 无确定因果：流速慢→「优先排查研磨」是来源支持的排查方向表述，非「苦涩+慢=过萃」确诊 ✅

### C. F-P-I 审核 + 事实保护
- F：rule.hario.v60.too-slow（水流过慢与研磨偏细有关、调整方向磨粗）——按原文表述为
  排查方向；I：豆因方向标注「待你的流速/时长信息确认后再排查，此处不作判断」；苦涩
  机理归因明确「超出已核验范围，不编造」
- **fact_stability_risk: low**——全部诊断性表述锚定单条 rule，超出部分显式标注推断

### D. Source Admission
BLOCK（exception-out-of-scope：b2e-001 不在 hario-v60-expert-guide 的 allowed_sample_ids）
——唯一缺口，落库时并入。topics（brewing-troubleshooting）在授权内 ✅

### E. experiment_target
`Elicit a single diagnostic clarifying question before troubleshooting compound taste symptoms`

### F. 最大行为风险
- 过度追问（中）：追问若泛化成「什么都问」会损害自然度——由同批 4 条直答对照压制
- 确诊化倾向（低）：已用「缩小范围/待确认方向」限定

### G. 与已有 approved 差异
- b1-013 是「流速慢」的机制解释（直答）；本条是复合症状求诊断→**先追问**——同一主题
  域的首个「症状→单问题分流」样本（b2b-001 实为直接建议、b2d-008 为时间信号+信息集，
  本条规格升级为单问题）。

### H. 建议动作
`approve_candidate`（人工参考）

---

## b2e-002 ｜ 追问-换豆变味（「换了新豆子，参数完全没变，味道却完全不同，是豆子的问题吗？」）

### A. 新增模型行为能力
对「多因素可能的变因问题」，用**一条简洁复合问题索取两个紧密相关字段**（烘焙度+
烘焙日期），并把可能原因作为**待确认方向**呈现——不宣称信息能确诊。

### B. Interaction 能力审核
- interaction_skill=clarification ✅：复合问题紧凑（两个字段一个问句）；回答后路径
  分明（养豆期→再放几天；烘焙度差异→调研磨/水温）✅
- 不确诊：两种原因均以「待确认方向」表述，claim 只支撑「养豆期随烘焙度与处理法变化」
  这一层 ✅

### C. F-P-I 审核 + 事实保护
- F：claim.freshness.resting-varies-by-roast（养豆期随烘焙度与处理法变化——按原文）；
  I：「具体原因——需要烘焙度与烘焙日期信息后才能缩小，此处不作判断」
- **fact_stability_risk: low**——单 claim 单层语义，未扩展出「换豆必是醒豆问题」式断言

### D. Source Admission
BLOCK（exception-out-of-scope：fellow-brew-talks）——唯一缺口。topics（brewing）在
授权内 ✅

### E. experiment_target
`Request the two most relevant bean variables (roast level and roast date) before attributing flavor changes`

### F. 最大行为风险
- 确诊化倾向（中）：「烘焙日期近→养豆问题」易被写成确定性归因——已用待确认方向限定
- 过度追问（低）：单轮复合问题，无清单化

### G. 与已有 approved 差异
- b2a-010 训练同包豆开封时间轴（直答+多变量）；本条训练**换豆场景的归因前置追问**——
  「先要信息再归因」的新行为。

### H. 建议动作
`approve_candidate`（人工参考）

---

## b2e-003 ｜ 追问-意式双症状（「我的意式浓缩流速很慢，出一份要等很久，油脂也偏少，怎么回事？」）

### A. 新增模型行为能力
面对**双症状**提问，**首轮只问最有信息价值的一个问题**（研磨刻度是否动过），另一症状
显式挂起并说明分步原因（「一次只动一个变量」）——避免信息收集清单式追问（GPT v2 核验
点名的升级规格）。

### B. Interaction 能力审核
- interaction_skill=clarification ✅：首轮单问题（研磨刻度）；油脂问题挂起且说明了
  「等流速定位后再看豆子」的分步逻辑 ✅
- claim 方向匹配：症状=流速**过慢** ↔ rule.fellow.shot-slow（过慢→研磨偏细→磨粗）——
  GPT v2 核验确认的方向一致性 ✅

### C. F-P-I 审核 + 事实保护
- F：rule.fellow.shot-slow（按原文）+ rule.gaggia.no-crema（油脂排查按原文语义）；
  I：「油脂方向——待流速排查后再处理，此处不作判断」
- **fact_stability_risk: low**——双 claim 各自锚定单一症状方向，未交叉推导

### D. Source Admission
BLOCK（exception-out-of-scope：fellow-espresso-basics + gaggia-classic-manual 两来源）
——唯一缺口。topics（espresso 在两来源 allowed_topics 交集）✅

### E. experiment_target
`Ask one highest-value question first and defer secondary symptoms to a later step`

### F. 最大行为风险
- 信息清单回潮（中）：双症状场景天然诱导一次问全——已用「先问一个+显式挂起」结构压制
- 分步中断（低）：用户可能不回应第二轮——首轮问题本身已给出最大信息价值

### G. 与已有 approved 差异
- b1-014/015 是口味症状诊断（直答多因）；b2d-008 是「最近难喝」时间信号+信息集；本条
  是**物理症状双线分步排查**——「单问题+挂起」结构为首创。

### H. 建议动作
`approve_candidate`（人工参考）

---

## b2e-004 ｜ 追问-感官描述缺失（「朋友说我冲的咖啡有股怪味，但我说不上来是哪种怪」）

### A. 新增模型行为能力
面对**无法描述症状**的用户，先教结构化描述（定位闻/喝），再用**选择题式问题**帮助把
感觉变成词——选项仅用于描述辅助，**不暗示气味唯一对应故障**；无证据关系显式标注
「待验证推断」。

### B. Interaction 能力审核
- interaction_skill=clarification ✅：两步（定位闻/喝 → A-D 选择题）；选项后明确
  「选完再结合参数和豆子信息缩小范围」✅
- 推断标注（GPT v2 核验核心点）：【I：气味到原因的归因——此类多因解释与判别方法在
  本知识库中尚待补证，此处只做描述辅助，不下因果结论】✅

### C. F-P-I 审核 + 事实保护
- F：claim.sensory.brewing-chart-profiles（TDS/萃取率风味轮廓——仅支撑「多维框架」
  层，v1 的因果映射已全部删除）；I：归因边界显式标注
- **fact_stability_risk: low**——因果映射删除后，所有超 claim 表述均带推断标注

### D. Source Admission
BLOCK（exception-out-of-scope：ucdavis-coffee-center）——唯一缺口。topics（pour-over
diagnosis）在授权内 ✅

### E. experiment_target
`Help users verbalize vague sensory complaints without asserting unverified cause mappings`

### F. 最大行为风险
- 暗示性提问（中）：选择题可能诱导用户「对号入座」——已用「选哪个都只是帮你把感觉
  变成词」+ 归因标注双重限定
- 描述教学喧宾夺主（低）：主体仍是追问推进

### G. 与已有 approved 差异
- b2b-008 是已知花香问机理（uncertainty）；本条是**症状不可描述场景的澄清引导**——
  「教描述再追问」的新行为，也是追问规格的极限测试。

### H. 建议动作
`approve_candidate`（人工参考）

---

## b2e-005 ｜ 直答-烘焙度与酸（「烘焙度越深，咖啡就越不酸吗？」）

### A. 新增模型行为能力
对「越…越…」式趋势提问，给出**带三层依据的直接回答**（TA 变化趋势→感知酸度与 TA
关联→烘焙是核心变量之一），同时**拒绝把趋势泛化成定律**——「趋势有依据 + 单杯不可
预测」的双层表述。

### B. Interaction 能力审核
- interaction_skill=knowledge_explanation ✅：直答到底，零追问；结尾仅主动提供后续
  帮助路径 ✅
- 「还需要知道」段为挑豆视角的边界信息（非信息收集阻塞）✅

### C. F-P-I 审核 + 事实保护
- F：ta-peaks-first-crack（TA 上升→一爆达峰→下降，**明确标注「特定实验条件下的研究
  描述」**）+ ta-sourness-correlation（感知酸度与 TA 相关但不等同）+ roast-controls-flavor
  （烘焙是核心变量之一）；I：单杯酸感不预测
- **fact_stability_risk: low**——GPT v3 复核四条约束逐条落实（不当规律/趋势与关联分
  层/不足以预测单杯且不忽略三条件/零数值零因果律）

### D. Source Admission
BLOCK（exception-out-of-scope：ucdavis-coffee-center）——唯一缺口。topics ✅

### E. experiment_target
`State trend-level knowledge with research-scope qualifiers instead of converting correlations into laws`

### F. 最大行为风险
- 定律化漂移（中）：「越…越…」句式天然诱导绝对化——已用「趋势有依据+不是定律+不
  预测单杯」三重限定
- 过度对齐（低）：无拒答倾向，信息量充分

### G. 与已有 approved 差异
- nat_q2（评测题）与 b2b-001 相关方向是绝对化纠偏；本条是**正向趋势知识的边界化表述**
  ——训练「有依据的趋势怎么说」而非「错误绝对化怎么纠」。

### H. 建议动作
`approve_candidate`（人工参考）

---

## b2e-006 ｜ 直答-官方配方为何不同（「为什么 V60 的官方配方和别人给的配方数字都不一样？」）

### A. 新增模型行为能力
对「来源间数字冲突」，直接解释**冲突本身是事实**（官方配方彼此不同被记录为冲突条目）
——训练 conflict 类 claim 的正面使用（不是回避、不是强行统一）。

### B. Interaction 能力审核
- interaction_skill=knowledge_explanation ✅：直答到底零追问 ✅
- 「还需要知道」段是参数联动的方法论边界（非收集）✅

### C. F-P-I 审核 + 事实保护
- F：conflict.v60.official-recipes-differ（冲突条目按原文——各来源粉水比/注水段数/
  总时长不一致）；P：选起点+单变量调整；I：配方适用性需结合用户豆子与器具
- **fact_stability_risk: low**——不列举未经核对的具体配方数字，冲突语义完整保留

### D. Source Admission
BLOCK（exception-out-of-scope：hario-v60-hoffmann）——唯一缺口。topics（brewing）✅

### E. experiment_target
`Explain inter-source recipe conflicts as facts rather than forcing a single standard`

### F. 最大行为风险
- 编造具体配方数字（中）： tempting to cite "官方" numbers——正文不列任何未核对数字，
  冲突条目只作存在性表述
- 与 b2b-003 混同（低）：b2b-003 拒绝黄金参数（行为），本条解释为什么不同（事实）——
  角度互补

### G. 与已有 approved 差异
- b2b-003 训练拒绝伪标准框架；本条训练**冲突条目的知识层使用**——「来源间差异是事实」
  的表述方式为首创。

### H. 建议动作
`approve_candidate`（人工参考）

---

## b2e-007 ｜ 直答-深烘醒豆（「深烘豆是不是要多放几天再冲？」）

### A. 新增模型行为能力
对数字类 claim（5–7 天），**完整保留适用范围限定**（特定深烘肯尼亚配方的建议）——
引用数字的同时明确「非通用数字、不推广」，并以品尝信号替代死数天数。

### B. Interaction 能力审核
- interaction_skill=knowledge_explanation ✅：直答到底零追问 ✅
- 「还需要知道」段为单豆判断路径（非收集）✅

### C. F-P-I 审核 + 事实保护
- F：dark-roast-rest-5-7d（5–7 天 + **明确限定「特定深烘肯尼亚配方的建议」**）+
  resting-varies-by-roast（养豆期随烘焙度与处理法变化）；P：养豆做法+品尝信号；
  I：气体机理不展开、单豆阶段判断需信息
- **fact_stability_risk: low**——GPT v2 裁定的适用范围限定逐字落实；机理层显式不展开

### D. Source Admission
BLOCK（exception-out-of-scope：fellow-brew-talks）——唯一缺口。topics（freshness）✅

### E. experiment_target
`Cite numeric claims with their original scope instead of generalizing to all cases`

### F. 最大行为风险
- 数字泛化（中）：「5-7 天」易被复述成普适规律——已限定「特定配方的建议」+「两支深烘
  豆也可能不同」
- 机理越界（低）：气体释放机理显式不展开

### G. 与已有 approved 差异
- b2a-009/010 训练陈化方向；本条训练**数字 claim 的范围限定写法**——「有数字但不说
  死」的首个样本。

### H. 建议动作
`approve_candidate`（人工参考）

---

## b2e-008 ｜ 直答-除垢（「Gaggia Classic 大概多久除一次垢？除垢能用醋吗？」）

### A. 新增模型行为能力
双问直答（周期+用水），**冲突边界完整保留**（不同代际手册周期不同→以用户机器对应
手册为准），禁醋按手册原文——补上现有 35 条未覆盖的 cleaning-maintenance topic。

### B. Interaction 能力审核
- interaction_skill=condition_based_advice ✅：双问都答到底（周期+醋）；「还需要知道」
  段为型号版本与水质的落地区间信息（非阻塞收集）✅

### C. F-P-I 审核 + 事实保护
- F：conflict.gaggia.classic-descale-interval（冲突条目：各版本说法不一——存在性表述
  + 「以对应手册为准」）+ claim.water.gaggia-vinegar-ban（禁醋按原文）；P：按水质观察
  调整（不替代手册框架）；I：单台适用周期以对应手册为准
- **fact_stability_risk: low**——冲突语义完整、零编造周期数字、禁醋直接锚定 claim

### D. Source Admission
BLOCK（exception-out-of-scope：gaggia-classic-manual）——唯一缺口。topics
（cleaning-maintenance）在授权内 ✅（新 topic 首次使用，gaggia 来源 3 条 claim 全部
激活）

### E. experiment_target
`Answer maintenance questions with manual-version conflict preserved and vendor-specific boundaries intact`

### F. 最大行为风险
- 周期泛化（中）：单一数字易被当成全系列规定——已用「以你机器对应版本的手册为准」限定
- 机型越界（低）：显式声明不推广其他品牌机型

### G. 与已有 approved 差异
- 现有 35 条无任何 cleaning-maintenance 样本（gaggia 授权 3 条 claim 零使用）；本条
  一次激活 2 条 claim + 新 topic——设备维护对话的首个样本。

### H. 建议动作
`approve_candidate`（人工参考）

---

## 汇总与拍板清单

| 样本 | 类型 | skill | fact_stability_risk | 建议动作 |
|---|---|---|---|---|
| b2e-001 | 追问 | clarification | low | approve_candidate |
| b2e-002 | 追问 | clarification | low | approve_candidate |
| b2e-003 | 追问 | clarification | low | approve_candidate |
| b2e-004 | 追问 | clarification | low | approve_candidate |
| b2e-005 | 直答 | knowledge_explanation | low | approve_candidate |
| b2e-006 | 直答 | knowledge_explanation | low | approve_candidate |
| b2e-007 | 直答 | knowledge_explanation | low | approve_candidate |
| b2e-008 | 直答 | condition_based_advice | low | approve_candidate |

> 上表「建议动作」仅为人工审核参考，**批准权在负责人逐条拍板**（GPT 流程裁定）。
> 任何一条未批准即不落库；落库时仅将实际获批样本 ID 并入对应来源例外的
> allowed_sample_ids 并更新 manifest（plan v3 三段式时点声明）。
