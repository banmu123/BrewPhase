# Batch2d 人工审核包（阶段七-F-3，2026-10-15）

> 依据：GPT 阶段七-F-3 指示（存档 `gpt_replies/gpt_reply_stage7f2_approved_7h.md`）。
> 定位（GPT）：**稳定性补强批次**——修复实验 B 暴露的三问题（事实稳定性下降/过度
> 对齐幻觉/追问不足），**不是知识扩充批次**。禁止：批准、落库。
> 检查链：quality gate PASSED（10, 0/0）；admission 3 PASS + 7 BLOCK（allowed_sample_ids，
> topics 全过）；130 tests OK。

## 汇总

| 项 | 值 |
|---|---|
| Batch2d candidate_count | **10** |
| quality_gate | **PASS**（0 error / 0 warning） |
| source admission | **3 PASS**（fda 自动准入）+ **7 BLOCK**（唯一缺口=allowed_sample_ids；topics 层全过；不提前扩 exception） |
| approved_current / potential | 25 → **35**（train 20 → ~28） |
| 训练状态 | 冻结（模型已缓存；新增数据前不训练） |
| 回归 | 130 tests OK；build_kb --check OK |

## b2d-001 ｜ 健康前提纠正（「每天喝咖啡一定伤身体吗？」）

### A. 新增模型行为能力
面对带绝对化前提的健康提问，**同时放下「一定伤」与「一定没问题」两个方向**，以参考口径替代绝对结论——而不是顺着任一方向回答。

### B. Interaction 能力审核
- interaction_skill=boundary_setting：能力边界明确（「本回答是公开健康机构的参考口径，不构成医疗建议」）✅；无医疗/因果断言 ✅
- 信息处理：健康类就医指引替代信息收集（六点九-F 门禁豁免）✅

### C. F-P-I 审核 + 事实保护
- F：fda-400（400 mg 口径）+ fda-variance（个体差异），明确标注「群体统计口径 ≠ 对所有人无害的承诺」；I：无健康阈值推断（「个体反应方向——健康话题不推断具体阈值」）
- **fact_stability_risk: low**——全部陈述锚定 FDA claim，无知识库外扩展

### D. Source Admission
**PASS**（fda-caffeine 自动准入）。

### E. experiment_target
`Prevent health-fact drift under behavioral fine-tuning (protect FDA-anchored answers)`

### F. 最大行为风险
- medical overclaim（中）：FDA 口径被误读为「安全承诺」——已用「一般不相关 ≠ 无害承诺」限定
- refusal tendency（低）：未出现拒答，给了观察与就医路径

### G. 与已有 approved 差异
- b2b-007 是中立健康提问的口径回答；本条训练**纠正带绝对化前提的健康提问**——双向放下（「一定伤」与「一定没问题」）是新增行为。

### H. 建议动作
`approve_candidate`（人工参考）

---

## b2d-002 ｜ 健康边界（「咖啡喝多了会上瘾吗？」）

### A. 新增模型行为能力
面对知识库**无结论的医疗概念**（成瘾），明确声明「知识库没有相关结论，不作肯定或否定判断」——**不把没有依据的说法包装成答案**；同时给边界内的有用信息（个体差异口径 + 记录建议）。

### B. Interaction 能力审核
- interaction_skill=uncertainty_handling ✅：信息不足表达明确（「本知识库没有相关结论」）；零编造（依赖/戒断机理不作猜测）✅
- 信息处理：不向用户收集症状做依赖判断（医疗评估范畴）→ 引导记录 + 就医 ✅

### C. F-P-I 审核 + 事实保护
- F：fda-variance + fda-400（边界内信息）；I：明确声明无成瘾判断
- **fact_stability_risk: low**

### D. Source Admission
**PASS**（fda-caffeine 自动准入）。

### E. experiment_target
`Maintain refusal-to-fabricate on medical concepts absent from the knowledge base`

### F. 最大行为风险
- medical overclaim（低）：「上瘾」判断完全外包给医疗人员 ✅
- refusal tendency（中）：「没有结论」若泛化成健康话题一律拒答会损害帮助性——已用 FDA 边界内信息平衡（GPT 七-F 对 b2d-005 的同类关注）

### G. 与已有 approved 差异
- 首个「医疗概念 + 知识库无结论」样本：训练**承认不知道的边界声明**而非猜测——直接补实验 B 暴露的认知边界弱点。

### H. 建议动作
`approve_candidate`（人工参考）

---

## b2d-003 ｜ 错误前提纠正（「咖啡豆本身没有香味，对吗？」）

### A. 新增模型行为能力
面对用户带**错误前提**的问题：**先检查前提、再解释原因**——「这个前提不准确」开头，接多因素框架（豆子特性/处理方式/烘焙/冲煮条件），不为回答而接受错误假设，也不编造机理。

### B. Interaction 能力审核
- interaction_skill=uncertainty_handling ✅：信息不足表达（「本知识库没有相关的机理结论，我不编造化学解释」）+ 需要的信息列明（产地/处理法/烘焙度/干香湿香）✅
- **保留「不能仅凭当前信息判断」** ✅（GPT C 节重点——未写成「强行纠正用户」）

### C. F-P-I 审核 + 事实保护
- F：chart-profiles + same-bean-different-brew（多维框架）；I：香气归因明确标注「需要结合豆子信息与专业资料，此处不作判断」
- **fact_stability_risk: medium**——纠正行为本身是训练目标，但需防止模型学成「条件反射式纠正」（GPT 警告的记忆化风险）；已用「不编造机理 + 需专业资料」缓冲

### D. Source Admission
**BLOCK→对齐**：ucdavis allowed_sample_ids 未含 b2d-003（claim 零缺口）。

### E. experiment_target
`Reduce hallucination after stronger LoRA alignment (correct the "beans have no aroma" premise)`

### F. 最大行为风险
- factual hallucination（已缓解）：本条即修复实验 B 的「豆子无香味」幻觉 ✅
- overconfidence（中）：纠正语气可能过强——已用「需要专业资料」限定 ✅
- over-questioning（低）：结尾给干香/湿香对比的可执行动作，非空洞追问 ✅

### G. 与已有 approved 差异
- **新增行为：错误前提检查**——实验 B 证明强对齐会让模型牺牲常识迎合训练模式；本条训练「面对错误前提先检查再回答」，是稳定性补强的核心样本。

### H. 建议动作
`approve_candidate`（人工参考）

---

## b2d-004 ｜ 错误归因纠正（「咖啡的香味是加了香精吗？」）

### A. 新增模型行为能力
面对**错误归因预设**（香=加香精）：不训练「没有加香精」的断言（食品安全事实、知识库无 claim），而是**把判断从主观感受转到客观信息**（产品标注与渠道核实）。

### B. Interaction 能力审核
- interaction_skill=uncertainty_handling ✅：「本知识库没有相关 claim，我不作任何肯定或否定的判断」✅
- 信息收集：引导看产品标注/渠道（判断依据=信息而非猜测）✅

### C. F-P-I 审核 + 事实保护
- F：same-bean-different-brew（香气可来自豆子自身）；I：「香与加香精之间没有必然联系」+「香气强度与加香无可靠对应关系」均标注推断
- flavored coffee 品类存在为事实陈述（非编造）✅
- **fact_stability_risk: medium**——食品安全话题敏感，「不判断」立场必须稳定

### D. Source Admission
**BLOCK→对齐**：ucdavis allowed_sample_ids 未含 b2d-004。

### E. experiment_target
`Prevent unsupported attribution (do not infer flavoring from aroma intensity)`

### F. 最大行为风险
- factual hallucination（中）：「加香精」判断无 claim 支撑——回答全程不作判断 ✅
- overconfidence（低）：已声明「判断交给信息与渠道」✅

### G. 与已有 approved 差异
- **新增行为：食品安全话题的「不判断」边界**——把「疑似加香」类问题引导到产品信息核实路径，与 b2c-003（价格边界）构成「知识库外断言一律不判断」的行为族。

### H. 建议动作
`approve_candidate`（人工参考）

---

## b2d-005 ｜ 研究结论边界（「喝咖啡会增加帕金森风险吗？」）

### A. 新增模型行为能力
面对**健康因果研究问题**：按 GPT 修正结构——首句边界（「目前不能仅根据这个问题判断咖啡会导致或不会导致某种健康结果」）→ 健康研究方法论（相关性≠因果、混杂因素、需医学来源）→ FDA 口径仅限摄入量层面（明确不与疾病风险混用）→ 非医疗建议。**不是简单「知识库没有」拒答**。

### B. Interaction 能力审核
- interaction_skill=uncertainty_handling ✅
- 方向断言：三类禁用（降低风险/增加风险/已证明无影响）**零命中** ✅
- 引导路径：权威公共卫生机构（FDA/WHO）+ 医疗人员 ✅

### C. F-P-I 审核 + 事实保护
- F：仅 FDA 摄入量口径（明确声明「不与疾病风险的结论混用」）；I：研究方向标注「需要专业文献支持，此处不作判断」
- **fact_stability_risk: high**——健康因果是最易幻觉的领域（实验 B 的「帕金森风险增加」即此类）；本条以「零方向断言」为硬约束，风险已压至边界声明内

### D. Source Admission
**PASS**（fda-caffeine 自动准入）。

### E. experiment_target
`Eliminate direction-assertion hallucination on health-causation questions (Parkinson case)`

### F. 最大行为风险
- medical overclaim（已压至最低）：零方向断言 ✅
- refusal tendency（中）：结构含方法论说明与查询路径，非空拒答 ✅（GPT 确认此结构「比简单拒答强很多」）

### G. 与已有 approved 差异
- **新增行为：健康因果问题的「研究解释边界」**——实验 B 的帕金森幻觉直接对应物；训练「区分摄入量口径与疾病风险结论、相关性≠因果」，从 QA 数据向「知道自己的知识边界在哪」的 Agent 行为演进。

### H. 建议动作
`approve_candidate`（人工参考）

---

## b2d-006 ｜ knowledge explanation（「什么是手冲咖啡？」）

### A. 新增模型行为能力
**有些问题应该直接回答**——定义类问题零追问、一答到底（定义→穿滤/浸滤对比→器具族→通用步骤→上手路径），防止实验 B 后可能形成的「咖啡问题→先问用户信息」错误泛化（GPT 确认的错误泛化）。

### B. Interaction 能力审核
- interaction_skill=**knowledge_explanation**（GPT 批准的新枚举）✅
- **knowledge_explanation gate PASS**：直接回答核心问题、开头零强制追问 ✅；解释完整（定义/对比/器具/步骤/上手）✅
- 结尾「需要的话我可以展开某个环节」= 帮助入口，非强制追问 ✅

### C. F-P-I 审核 + 事实保护
- F：paper-rinse-universal（跨来源共识）+ v60-official-expert（Hario 官方起点参数）；P：上手路径；I：参数适配标注推断
- **fact_stability_risk: low**——定义与参数均锚定知识库正文与 claim

### D. Source Admission
**BLOCK→对齐**：hario allowed_sample_ids 未含 b2d-006。

### E. experiment_target
`Prevent over-questioning behavior (answer definition questions directly)`

### F. 最大行为风险
- over-questioning（已缓解）：gate 验证零强制追问 ✅
- overconfidence（低）：参数引用带官方来源 ✅

### G. 与已有 approved 差异
- **新增行为类别：knowledge explanation**——interaction_skill 枚举的第六类（GPT 批准）；此前五类全部是「谨慎类」，本类训练「该直接回答时直接回答」，补齐行为光谱的另一端。

### H. 建议动作
`approve_candidate`（人工参考）

---

## b2d-007 ｜ knowledge explanation（「手冲之前为什么要冲洗滤纸？」）

### A. 新增模型行为能力
「为什么」类单事实问题的**标杆回答**：直接答（去纸味+预热）→ 两点展开（纸味对浅烘的影响/温度与可重复性）→ 操作建议 → 流程固化建议——单事实点答到底。

### B. Interaction 能力审核
- interaction_skill=**knowledge_explanation** ✅；gate PASS（零追问）✅
- 解释完整（原因/影响/操作）✅

### C. F-P-I 审核 + 事实保护
- F：paper-rinse-universal（「跨来源共识——Hario 与 Kalita 资料均列为标准流程」）；I：温度损失幅度标注「取决于实际条件需观察」
- **fact_stability_risk: low**

### D. Source Admission
**BLOCK→对齐**：hario allowed_sample_ids 未含 b2d-007。

### E. experiment_target
`Reinforce direct factual answering (single-fact "why" questions)`

### F. 最大行为风险
- over-questioning（已缓解）✅；overconfidence（低）：温度影响已标推断 ✅

### G. 与已有 approved 差异
- **新增行为：单事实点「为什么」的完整解释范式**——与 b2d-006（是什么）构成 knowledge explanation 的两个子型。

### H. 建议动作
`approve_candidate`（人工参考）

---

## b2d-008 ｜ 主动诊断追问（「我的浓缩最近很难喝」）

### A. 新增模型行为能力
追问侧的**意式深化**：识别「最近」时间信号（之前好→现在差 = 变量变化），把豆况变化列为优先排查项；给出「味道方向+流速」配对判断法（酸/寡淡+流速快→偏粗方向；苦+慢→偏细方向）。

### B. Interaction 能力审核
- interaction_skill=clarification ✅：不直接诊断（信息未齐只给分流框架）✅；信息收集四项清单+配对判断法 ✅
- 与「过度追问」的边界：给每项信息的分流意义（不是空洞清单）✅

### C. F-P-I 审核 + 事实保护
- F：Fellow 三 rule 联用（shot-sour/bitter/slow 映射表完整）；I：「厂商第一近似非绝对对应」标注 ✅
- **fact_stability_risk: low**——全部锚定 Fellow claim

### D. Source Admission
**BLOCK→对齐**：fellow allowed_sample_ids 未含 b2d-008。

### E. experiment_target
`Preserve clarification entry even after alignment (espresso + temporal signal)`

### F. 最大行为风险
- over-questioning（低）：信息项均附分流意义 ✅
- overconfidence（低）：映射表标注「厂商第一近似」✅
- factual hallucination（低）：三 rule 均为 Fellow claim ✅

### G. 与已有 approved 差异
- b2c-001 手冲零线索 vs 本条意式+时间信号——「最近」触发豆况优先排查是新增决策分支；实验 B 后模型若倒向「永远不诊断」，本条保持诊断入口。

### H. 建议动作
`approve_candidate`（人工参考）

---

## b2d-009 ｜ 事实锚点（「咖啡豆应该怎么储存？」）

### A. 新增模型行为能力
信息完整的直接解释类：储存要点一答到底（四大敌人→做法→冷冻边界→购买习惯），并把话题锚回 BrewPhase 主线（「储存做得好，参数微调才有意义」）。

### B. Interaction 能力审核
- interaction_skill=condition_based_advice ✅（含条件化建议与下一步规划）
- 零追问 ✅（knowledge_explanation 式答到底）

### C. F-P-I 审核 + 事实保护
- F：nca-storage-enemies（四大敌人）+ nca-peak-decline-stale（峰值衰退曲线）；P：具体做法；I：冷冻影响「因豆而异可自行对比」
- **fact_stability_risk: low**——不编造保质期数字（duration-table claim 未引用故不给天数表）

### D. Source Admission
**BLOCK→对齐**：nca allowed_sample_ids 未含 b2d-009。

### E. experiment_target
`Anchor freshness facts (prevent fact drift on storage knowledge)`

### F. 最大行为风险
- factual hallucination（低）：全部锚定 NCA claim ✅
- overconfidence（低）：冷冻标注「可自行对比」✅

### G. 与已有 approved 差异
- b2a-009/010 已有新鲜度样本——本条差异化在**「直接解释+把储存与诊断主线连接」**的完整范式（信息完整问题的标准答法）。

### H. 建议动作
`approve_candidate`（人工参考）

---

## b2d-010 ｜ 事实锚点（「研磨刻度可以直接照搬别人的吗？」）

### A. 新增模型行为能力
「能不能照搬」类问题的直接回答：不能——Baratza claim 本体（手册不含具体冲煮刻度，正确数值取决于豆子与器具）+ 校准方法论（起点→冲煮→记录→微调）。

### B. Interaction 能力审核
- interaction_skill=condition_based_advice ✅（含校准路径）
- 零追问 ✅（「还需要知道你的型号」以帮助口吻出现于中部，非开头强制）✅

### C. F-P-I 审核 + 事实保护
- F：manual-not-recipe（Baratza 本体）+ same-bean-different-brew（研磨是核心变量）；I：同型号偏差「因设备而异需对比验证」
- **fact_stability_risk: low**——双 claim 锚定

### D. Source Admission
**BLOCK→对齐**：baratza + ucdavis allowed_sample_ids 未含 b2d-010（双来源 topics 交集已验证）。

### E. experiment_target
`Anchor grinding facts (parameter-copying refusal with methodology)`

### F. 最大行为风险
- factual hallucination（低）：双 claim 锚定 ✅
- overconfidence（中）：「两台同型号也有差异」为合理推断，已标注「需对比验证」✅

### G. 与已有 approved 差异
- b2b-004 训练多来源差异拆解；本条把「刻度不可照搬」训练成**单点直接解释**（自然度评测 N9 同型——直接解释类的研磨领域覆盖）。

### H. 建议动作
`approve_candidate`（人工参考）

---

## 完成状态

- ✅ quality gate 复跑 PASSED（10, 0/0）／ ✅ source admission 复跑（3 PASS + 7 BLOCK 同构）
- ✅ review package 生成（本文件，含 fact_stability_risk 与 experiment_target 新字段）
- ❌ approval_execution 未执行 ❌ manifest 未更新 ❌ split 未执行 ❌ 训练未启动

## 批准后的执行顺序（GPT 预先确认，负责人批准后执行）

人工批准 → check_candidate_quality → source_admission → allowed_sample_ids 对齐
（ucdavis←b2d-003/004/010、hario←b2d-006/007、fellow←b2d-008、nca←b2d-009、
baratza←b2d-010；fda 3 条免）→ check_approval_ready → validate --for-training →
split_dataset → 重新生成 audit → **实验 C**（Qwen2.5-3B-4bit，35 approved/~28 train，
iters=100, lr=1e-5, rank=8, batch=1——不直接 300 iter；7B 暂缓至 approved ≥100）。
