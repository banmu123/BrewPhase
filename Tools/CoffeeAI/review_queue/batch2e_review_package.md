# Batch2e 人工审核包 v4（阶段七-G 后续，2026-10-15）

> **v4 修订依据**：GPT 对 draft v3 的终复核（存档
> `gpt_replies/gpt_reply_batch2e_draftv3_review.md`）——b2e-004 元数据问题**通过**；
> F/P/I 实际标层**未通过**（远程文件 P/I 成对 0 对、单独注释 18 处——v3 的自查脚本
> 存在「全 0 也判对称」的漏洞，正是 GPT 上轮警告的「不要只让成对标记脚本通过」）。
> v4 按 GPT 示例把标层改为**包住实际内容**的成对标记（【P】实践正文【/P】、【I】推断
> 正文【/I】），并修复自查脚本（成对计数必须 >0 且相等 + 单独注释残留 = 0）——8 条
> 全部通过（F/P/I 逐条有实际标记，b2e-004 补 P 层「先记录出现阶段」实践句使声明与
> 正文对齐）。
> **v3 修订**：b2e-004 删混入 claim 句（通过）。**v2 修订**：8 条事实语义。
> 定位（GPT 终裁）：**追问能力数据侧验证批次**。禁止：批准、落库、更新
> allowed_sample_ids/manifest、重新划分、训练。
> 检查链（v4 重跑）：quality gate **PASSED**（checked=8, errors=0, warnings=0）；标记
> 严格自查 **ALL_OK**（8 条成对、零残留）；admission **8 BLOCK**（唯一缺口=
> allowed_sample_ids，同构预期）；143 tests OK。

## 汇总

| 项 | 值 |
|---|---|
| Batch2e candidate_count | **8**（追问 4：b2e-001/002/003/004；直答 4：b2e-005/006/007/008） |
| quality_gate | **PASS**（0 error / 0 warning；v1 首跑 2 ERROR+1 WARNING → 补「还需要知道」段+限定词后全绿） |
| source admission | **8 BLOCK**（唯一缺口=allowed_sample_ids——预期同构；来源/topics/claim 全部在既有授权内） |
| 来源分布 | 6 来源 / 9 次引用：fellow-brew-talks 2 / gaggia-classic-manual 2 / ucdavis-coffee-center 2 / hario-v60-expert-guide 1 / hario-v60-hoffmann 1 / fellow-espresso-basics 1 |
| approved_current / potential | 35 → **43**（clarification 2→6） |
| 训练状态 | **冻结**（GPT 终裁：即使 43 条也不自动批准新一轮 3B 训练） |
| 回归 | 143 tests OK；build_kb --check OK |
| v1→v3 正文修订 | 8/8 条落实 GPT 两轮修订要求（v1 事实语义 8 条 → v2 逐条修订 → v3 两处闭环：b2e-004 删混入 claim 句、F/P/I 全量标层无混层）；标记自查：8 条成对标记全对称+单独注释残留为零（脚本验证） |

## fact_stability_risk 重新定级（GPT 复核要求：反映实际正文并写明理由）

| 样本 | v1 定级 | v2 定级 | 理由（修订前→修订后） |
|---|---|---|---|
| b2e-001 | low | **low** | 修订前风险点：流速正常分支预设「归因豆子」。修订后：删除该归因——「时长正常时不能确定原因，下一步问豆子信息」，全程无端别预设 |
| b2e-002 | low | **low** | 修订前风险点：「最常改变风味的两个变量」超出 claim 语义。修订后：降为「起始信息，帮助区分可能方向」；养豆期判断标【I】待确认推断 |
| b2e-003 | low | **low** | 修订前风险点：首轮双问；「第一变量」带 F 标；油脂机理越界。修订后：首轮单问题；F 仅锚 shot-slow；油脂挂起「只按 Gaggia 手册排查方向展开」 |
| b2e-004 | low | **low** | 修订前风险点：「闻到/喝到→环节不同」暗示诊断映射。修订后：改「记录出现阶段，有助于描述和后续排查」；A–D 选项仅辅助描述 |
| b2e-005 | low | **low**（修订前实际应为 **medium**） | 修订前风险点：起句「总体趋势上可以说『是的』」易被学成宽泛结论（GPT 点名趋势泛化）。修订后：起句「不能简单概括为越深就越不酸」+三层依据各带边界（特定研究条件/相关非等同/与豆子冲煮共同决定）+「很可能不足以预测单杯」限定词 + 【I】标注。定级理由：泛化入口已封死，F 句全部锚定 claim 且带范围限定词 |
| b2e-006 | low | **low**（修订前实际应为 **medium**） | 修订前风险点：发布方动机推测（「基于自己的豆子、研磨标准与目标口感」无来源依据）+「官方配方」统称混淆两类来源。修订后：动机显式声明不推测；区分品牌官方指南（Hario）与署名专家配方（Hoffmann）；冲突条目仅存在性表述 |
| b2e-007 | low | **low**（修订前实际应为 **medium**） | 修订前风险点：深烘普遍性结论（「一般比浅烘更需要放置」）+气体/烘烤气味机理句，均超出 claim 且与「机理不作断言」自我约束不一致（GPT 点名）。修订后：两处全删；仅剩养豆期因豆而异 + 5–7 天限定特定配方 + 品尝判断做法 |
| b2e-008 | low | **low**（修订前实际应为 **medium**） | 修订前风险点：水质驱动自行调整手册周期 +「醋对部件有风险」机理句超出 claim。修订后：周期决定权全在手册（水质仅背景+【I】不给量化对应）；禁醋按来源原文直接陈述 |

## b2e-001 ｜ 追问-手冲苦涩（「我的手冲喝起来又苦又涩，怎么回事？」）

### A. 新增模型行为能力
面对复合症状，**先问一个单句关键问题**（总时长），拿到回答后按信息**决定下一步收集
方向**——v2 修订后：时长正常时明确「不能确定原因、下一步问豆子信息」，全程不预设
端别。

### B. Interaction 能力审核
- interaction_skill=clarification ✅：单句追问；追问后路径开放（调研磨 or 看豆子由
  回答决定）✅
- 无确定因果 ✅：F 仅「水流过慢与研磨偏细有关、磨粗」排查方向；豆因方向标【I】不判断

### C. F-P-I 审核 + 事实保护
- F：rule.hario.v60.too-slow（按原文，排查方向）；I：原因方向「冲煮端信息排除后再
  继续收集豆子信息，此处不作归因判断」
- **fact_stability_risk: low**（理由见定级表）

### D. Source Admission
BLOCK（exception-out-of-scope：hario-v60-expert-guide）——唯一缺口。topics ✅

### E. experiment_target
`Elicit a single diagnostic clarifying question and avoid premature attribution`

### F. 最大行为风险
- 过度追问（中）：由同批直答对照压制
- 端别预设（低）：v2 已删除，全程「不能确定→继续收集」

### G. 与已有 approved 差异
- b1-013 为机制解释（直答）；本条为复合症状→单问题分流且**不预设端别**。

### H. 建议动作
`approve_candidate`（人工参考）

---

## b2e-002 ｜ 追问-换豆变味（「换了新豆子，参数完全没变，味道却完全不同，是豆子的问题吗？」）

### A. 新增模型行为能力
用**一条复合问题索取两个紧密相关字段**，可能原因以「待确认方向」呈现；养豆期判断
显式标注为**方向性推断**（claim 只支撑「养豆期随烘焙度与处理法变化」）。

### B. Interaction 能力审核
- interaction_skill=clarification ✅：复合问句紧凑；两条路线（静置观察 vs 调参数）
  在信息到位前不作选择 ✅

### C. F-P-I 审核 + 事实保护
- F：resting-varies-by-roast（按原文）；I：「养豆期判断——方向性推断，不作确诊」+
  「具体原因待信息后缩小」
- **fact_stability_risk: low**（理由见定级表）

### D. Source Admission
BLOCK（exception-out-of-scope：fellow-brew-talks）——唯一缺口。topics ✅

### E. experiment_target
`Collect the two most relevant starting facts before attributing flavor changes`

### F. 最大行为风险
- 确诊化倾向（中）：已用待确认方向+推断标注压制
- 过度追问（低）：单轮复合问题

### G. 与已有 approved 差异
- b2a-010 训练同包豆时间轴；本条训练**换豆归因的信息前置**。

### H. 建议动作
`approve_candidate`（人工参考）

---

## b2e-003 ｜ 追问-意式双症状（「我的意式浓缩流速很慢，出一份要等很久，油脂也偏少，怎么回事？」）

### A. 新增模型行为能力
双症状场景下**首轮只问一个问题**（研磨刻度最近动过吗？），另一症状显式挂起且**只
承诺按 Gaggia 手册的排查方向展开**（不引入未核验机理）。

### B. Interaction 能力审核
- interaction_skill=clarification ✅：首轮严格单问题（GPT v1 复核点名的双问已删）✅
- 分步逻辑显式（「一次只动一个变量」）✅

### C. F-P-I 审核 + 事实保护
- F：rule.fellow.shot-slow（过慢→研磨偏细→磨粗，与症状方向一致——GPT v1 核验确认）；
  「第一变量」已去 F 标（归 P 层排查做法）；I：油脂方向「仅按 Gaggia 手册排查范围展开」
- **fact_stability_risk: low**（理由见定级表）

### D. Source Admission
BLOCK（exception-out-of-scope：fellow-espresso-basics + gaggia-classic-manual）——唯一
缺口。topics（espresso 交集）✅

### E. experiment_target
`Ask one highest-value question first and defer secondary symptoms to manual-guided steps`

### F. 最大行为风险
- 信息清单回潮（中）：已用「首轮单问题+挂起说明」压制
- 手册范围外推理（低）：油脂段显式限定手册范围

### G. 与已有 approved 差异
- 首个「单问题+分步挂起」样本；与 b1-014/015（口味症状直答）、b2d-008（信息集）差异化。

### H. 建议动作
`approve_candidate`（人工参考）

---

## b2e-004 ｜ 追问-感官描述缺失（「朋友说我冲的咖啡有股怪味，但我说不上来是哪种怪」）

### A. 新增模型行为能力
对不可描述症状：**先记录出现阶段 → 选择题辅助描述**；选项仅帮用户把感觉变成词，
归因关系显式标注「待补证、不下因果结论」。

### B. Interaction 能力审核
- interaction_skill=clarification ✅：两步推进（阶段记录 → A–D 选择）✅
- v2 修订：「指向的环节不同」已改为「有助于描述和后续排查」——无诊断映射暗示 ✅
- v3 修订（GPT 裁定方案一）：删除「同一批豆子改变研磨与萃取方式…不同位置」句（混入
  未列入 claim_ids 的 same-bean-different-brew 内容）——F 层仅保留 chart-profiles
  框架句，落点判断移入【I】

### C. F-P-I 审核 + 事实保护
- F：brewing-chart-profiles（仅框架层口径「风味表现由 TDS 与萃取率划分」——与
  claim_ids 完全对齐）；I：气味归因「尚未核验…可能无法立即给出因果结论」+ 落点判断
  「待参数信息，不作定论」
- **fact_stability_risk: low**（理由见定级表）

### D. Source Admission
BLOCK（exception-out-of-scope：ucdavis-coffee-center）——唯一缺口。topics ✅

### E. experiment_target
`Help users verbalize vague sensory complaints without asserting unverified cause mappings`

### F. 最大行为风险
- 暗示性提问（中）：已用「只是帮你把感觉变成词」+归因标注双重限定
- 描述教学喧宾夺主（低）：主体仍是追问推进

### G. 与已有 approved 差异
- 首个「症状不可描述」场景样本——追问规格的极限测试。

### H. 建议动作
`approve_candidate`（人工参考）

---

## b2e-005 ｜ 直答-烘焙度与酸（「烘焙度越深，咖啡就越不酸吗？」）

### A. 新增模型行为能力
对趋势类提问，**起句即拒绝简单概括**（GPT 指定起句「不能简单概括为越深就越不酸」），
再分层陈述：研究观察的 TA 趋势（带研究条件限定）→ 感知酸度与 TA 关联（相关非等同）
→ 烘焙与豆子/冲煮共同决定——**单杯不预测**。

### B. Interaction 能力审核
- interaction_skill=knowledge_explanation ✅：直答到底零追问；「还需要知道」为挑豆
  视角边界信息 ✅
- 限定词：v1 复核曾抓「缺限定词」——v2 补「很可能不足以预测」并通过门禁 ✅

### C. F-P-I 审核 + 事实保护
- F：ta-peaks-first-crack（明确「特定实验条件下的研究描述」）+ ta-sourness-correlation
  （相关非等同）+ roast-controls-flavor（核心变量之一，与豆子/冲煮共同决定）；
  I：单杯酸感不预测（基于现有证据范围的推断）
- **fact_stability_risk: low**（修订前 medium——理由见定级表）

### D. Source Admission
BLOCK（exception-out-of-scope：ucdavis-coffee-center）——唯一缺口。topics ✅

### E. experiment_target
`Open trend answers by rejecting over-generalization, then state research-scoped evidence with explicit boundaries`

### F. 最大行为风险
- 定律化漂移（中）：起句拒绝+三层限定+推断标注三重压制
- 限定词缺失（低）：门禁 i-without-qualifier 已覆盖（v1 抓到并修复）

### G. 与已有 approved 差异
- 训练「有依据的趋势怎么说」而非「错误绝对化怎么纠」——与 nat_q2/b2d-003 互补。

### H. 建议动作
`approve_candidate`（人工参考）

---

## b2e-006 ｜ 直答-配方差异（「为什么 V60 的官方配方和别人给的配方数字都不一样？」）

### A. 新增模型行为能力
对来源间冲突：**区分两类来源性质**（品牌官方指南 vs 署名专家配方）+ **存在性表述**
（差异被记录为冲突条目）+ **动机显式不推测**（来源原文没交代）。

### B. Interaction 能力审核
- interaction_skill=knowledge_explanation ✅：直答到底零追问 ✅

### C. F-P-I 审核 + 事实保护
- F：conflict.v60.official-recipes-differ（存在性表述，不列未核对数字）；I：发布方
  动机不推测；起点选择取决于用户豆子与口味，不指定
- **fact_stability_risk: low**（修订前 medium——理由见定级表）

### D. Source Admission
BLOCK（exception-out-of-scope：hario-v60-hoffmann）——唯一缺口。topics ✅

### E. experiment_target
`Distinguish source types and avoid fabricating motives when explaining inter-source conflicts`

### F. 最大行为风险
- 动机编造回潮（中）：显式「我不去推测」压制
- 标准化倾向（低）：「统一标准不存在」直说

### G. 与已有 approved 差异
- 首个「来源分类 + 冲突存在性」样本；与 b2b-003（拒伪标准行为层）互补。

### H. 建议动作
`approve_candidate`（人工参考）

---

## b2e-007 ｜ 直答-养豆期（「深烘豆是不是要多放几天再冲？」）

### A. 新增模型行为能力
对「是不是」类问题先给**范围化回答**（养豆期因豆而异），数字 claim（5–7 天）**限定
到特定配方的建议**并给出更可靠的替代判断方法（品尝信号）——v2 删除普遍性结论与
机理句。

### B. Interaction 能力审核
- interaction_skill=knowledge_explanation ✅：直答到底零追问 ✅

### C. F-P-I 审核 + 事实保护
- F：resting-varies-by-roast（养豆期随烘焙度与处理法变化）+ dark-roast-rest-5-7d
  （明确限定「特定深烘肯尼亚配方的建议」）；P：品尝观察替代数天数；I：静置期机理
  不作断言
- **fact_stability_risk: low**（修订前 medium——理由见定级表：普遍性结论与机理句删除）

### D. Source Admission
BLOCK（exception-out-of-scope：fellow-brew-talks）——唯一缺口。topics（freshness）✅

### E. experiment_target
`Scope numeric claims to their original recipe and replace over-reach with observation-based guidance`

### F. 最大行为风险
- 数字泛化（中）：已限定+品尝替代双压制
- 机理越界（低）：显式不作断言

### G. 与已有 approved 差异
- 首个「数字 claim 范围限定 + 观察法替代」样本；与 b2a-009/010 差异化（养豆期）。

### H. 建议动作
`approve_candidate`（人工参考）

---

## b2e-008 ｜ 直答-除垢（「Gaggia Classic 大概多久除一次垢？除垢能用醋吗？」）

### A. 新增模型行为能力
双问直答 + **冲突边界完整保留**（不同代际手册周期不同→以对应手册为准）+ **拒绝
水质驱动的自行调整**（周期决定权在手册，水质仅背景）+ 禁醋按原文直接陈述（无机理
发挥）。

### B. Interaction 能力审核
- interaction_skill=condition_based_advice ✅：双问都答到底；「还需要知道」为版本
  确认的落地信息 ✅

### C. F-P-I 审核 + 事实保护
- F：descale-interval 冲突条目（存在性+以对应手册为准）+ vinegar-ban（禁醋按原文）；
  P：确认型号版本对应手册、按手册联系厂商；I：水质与周期的量化对应来源未提供——
  不给自行调整建议
- **fact_stability_risk: low**（修订前 medium——理由见定级表）

### D. Source Admission
BLOCK（exception-out-of-scope：gaggia-classic-manual）——唯一缺口。topics
（cleaning-maintenance 新 topic 首次覆盖，gaggia 3 claim 激活 2）✅

### E. experiment_target
`Keep manual-version conflicts authoritative and refuse to let users self-adjust vendor-specified intervals`

### F. 最大行为风险
- 周期泛化（中）：「以你机器对应版本的手册为准」限定
- 自行调整建议（低）：v2 已删，水质仅背景+【I】标注

### G. 与已有 approved 差异
- cleaning-maintenance 新 topic 首个样本；冲突条目+禁用项的双 claim 结构。

### H. 建议动作
`approve_candidate`（人工参考）

---

## 汇总与拍板清单

| 样本 | 类型 | skill | fact_stability_risk（v2 重定级） | 建议动作 |
|---|---|---|---|---|
| b2e-001 | 追问 | clarification | low | approve_candidate |
| b2e-002 | 追问 | clarification | low | approve_candidate |
| b2e-003 | 追问 | clarification | low | approve_candidate |
| b2e-004 | 追问 | clarification | low | approve_candidate |
| b2e-005 | 直答 | knowledge_explanation | low（v1 实为 medium，已修） | approve_candidate |
| b2e-006 | 直答 | knowledge_explanation | low（v1 实为 medium，已修） | approve_candidate |
| b2e-007 | 直答 | knowledge_explanation | low（v1 实为 medium，已修） | approve_candidate |
| b2e-008 | 直答 | condition_based_advice | low（v1 实为 medium，已修） | approve_candidate |

> 上表「建议动作」仅为人工审核参考，**批准权在负责人逐条拍板**（GPT 流程裁定）。
> 任何一条未批准即不落库；落库时仅将实际获批样本 ID 并入对应来源例外的
> allowed_sample_ids 并更新 manifest（plan v3 三段式时点声明）。
> GPT 复核目标（原文）：「让每条训练样本的事实、实践和推断在语义上也经得起审查」。
