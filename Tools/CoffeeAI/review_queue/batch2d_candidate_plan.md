# Batch2d 候选设计（阶段七-F 第一步，2026-10-15）

> 依据：GPT 阶段七-F 指示（存档 `review_queue/gpt_replies/gpt_reply_stage7e_ruling_7f_prompt.md`）——
> 实验 B 证明行为对齐可行但出现幻觉劣化，裁定「A 扩数据优先」：**不修改现有 approved 25**，
> 新建 batch2d 设计 10 条补强样本（事实锚点保护方向），走完整流程
> plan → admission → draft → gate → review → approved ~35 → 第三轮 LoRA（实验 C）。
> **本文件只出 plan，不写候选正文。**

## 设计目标（GPT 阶段七-F）

- 修复实验 B 暴露的幻觉劣化（q8「豆子无香味」、nat_q4「帕金森风险」）——**事实锚点保护**；
- 补最大缺口：**「不需要追问」案例**（追问能力 0 的另一侧——该直接回答时不追问）；
- 比例调整：事实锚点 20%→35%、行为边界 40%→35%、诊断 36%→30%；
- 目标：approved 25 → 35 左右、train 20 → 28+，之后实验 C（iters=100, lr=1e-5）找
  「行为提升 + 事实稳定」窗口。

## 来源与授权约束（预检全部通过）

- **只用已有 9 例外来源 + fda 自动准入**，零新增 claim/source/exception/topics；
- 全部引用 claim 已在对应例外 allowed_claim_ids 内（逐条标注）；
- **topic 预检**：每条 topic 落在来源例外 allowed_topics 内（六点九-E 教训）；
- 知识库无帕金森/香气机理 claim → 相关样本设计为 **uncertainty_handling 边界型**
  （b2c-003 模式：纠正错误前提 + 声明知识边界 + 不编造），不新增健康/化学 claim。

## 十条设计

### b2d-001 ｜ F-001 健康事实保护：「每天喝咖啡一定伤身体吗？」

- **user_scenario**：反事实前提提问（与 b2b-007 的中立提问差异化——本条带错误绝对化前提）
- **training_skill**: 健康事实保护（反事实前提纠正 + 参考口径）
- **answer_structure**: A 纠正「一定」框架（参考口径而非绝对结论）→ B FDA 参考信息 +
  个体差异 → C 非医疗建议边界 → 下一步（就医指引情形）
- **claim_ids**: ["claim.health.fda-400", "claim.health.fda-variance"]｜**source**: fda-caffeine
  （自动准入，topic=health 无 topics 限制）——**可立即写**
- **risk_notes**: 与 b2b-007 差异化——b2b-007 中立提问给口径，本条纠正「一定伤身体」
  错误前提；禁健康承诺/疾病判断；不引用帕金森等知识库外研究
- **interaction_skill**: boundary_setting｜**training_value**: ★★★★

### b2d-002 ｜ F-001：「咖啡喝多了会上瘾吗？」

- **user_scenario**: 健康追问（知识库无「成瘾」结论 claim——天然的边界声明样本）
- **training_skill**: uncertainty_handling（健康话题的「不知道」能力）
- **answer_structure**: A 明确声明本知识库无咖啡因依赖/成瘾的结论 → B 可给的边界内
  信息（个体差异、摄入量参考）→ C 不医疗化 → 下一步（就医咨询路径）
- **claim_ids**: ["claim.health.fda-variance"]｜**source**: fda-caffeine（自动准入）——**可立即写**
- **risk_notes**: **不编造成瘾机理**（b2c-003/b2b-008 不知道能力延续）；「上瘾」是
  医疗概念不作判断
- **interaction_skill**: uncertainty_handling｜**training_value**: ★★★★

### b2d-003 ｜ F-002 反事实纠错：「咖啡豆本身没有香味，对吗？」

- **user_scenario**: 直接对齐实验 B 暴露的幻觉（adapterB 曾答「豆子本身没有香味」）——
  用户带错误前提求证
- **training_skill**: 反事实纠错 + 边界声明
- **answer_structure**: A 纠正错误前提（咖啡豆有明显香气——干香/湿香是品鉴基础，
  这是常识级表述）→ B 可支撑的一般性框架（风味轮廓多维、同豆不同萃）→ C 香气
  机理本知识库无结论、不编造化合物 → 下一步（闻干香湿香对比）
- **claim_ids**: ["claim.sensory.brewing-chart-profiles", "claim.sensory.same-bean-different-brew"]｜
  **source**: ucdavis-coffee-center（两 claim 在例外内；topic=pour-over diagnosis ✓）——**可立即写**
- **risk_notes**: 纠正限于常识级（咖啡有香气），**不展开香气化学机理**（知识库无此
  claim，延续 b2b-008/b2c-003 边界）；直接回应幻觉句式「豆子本身没有香味」是本条
  核心价值——直接修复实验 B 的劣化方向
- **interaction_skill**: uncertainty_handling｜**training_value**: ★★★★★（GPT：直接修复
  实验中的幻觉）

### b2d-004 ｜ F-002：「咖啡的香味是加了香精吗？」

- **user_scenario**: 错误归因预设（nat_q8 中 adapterB 曾答「添加香精」——本条训练
  纠正该类错误预设）
- **training_skill**: 反事实纠错（错误归因纠正 + 不编造）
- **answer_structure**: A 不直接认可「加香精」预设（多数咖啡香气来自豆子自身）→
  B 一般性框架（风味轮廓多维 + 咖啡香气是品鉴对象）→ C 具体某款豆子的香气来源
  需要豆子信息，知识库无机理结论 → 下一步（问烘焙商/查豆子信息）
- **claim_ids**: ["claim.sensory.same-bean-different-brew"]｜**source**: ucdavis（topic ✓）——**可立即写**
- **risk_notes**: 「香精」议题敏感（市场上确有加香豆）——表述为「不直接认可预设 +
  需要豆子信息判断」，不断言用户豆子有无加香；不编造处理工艺
- **interaction_skill**: uncertainty_handling｜**training_value**: ★★★★

### b2d-005 ｜ F-003 研究结论边界：「喝咖啡会增加帕金森风险吗？」

- **user_scenario**: 直接对齐实验 B 的第二处幻觉（adapterB 曾答「增加帕金森风险」）
- **training_skill**: uncertainty_handling（研究结论边界：不简单说有/没有、区分研究
  关联、避免健康断言）
- **answer_structure**: A 明确声明本知识库无咖啡与帕金森关系的研究结论，不作有/无
  断言 → B 可给的边界内信息（FDA 摄入量参考 + 个体差异）→ C 健康研究需专业来源，
  建议咨询医疗人员/查权威机构 → 下一步
- **claim_ids**: ["claim.health.fda-400", "claim.health.fda-variance"]｜**source**: fda-caffeine
  （自动准入；topic=health）——**可立即写**
- **risk_notes**: **不编造研究方向**（既不说增加也不说降低——实验 B 的幻觉就是
  方向性断言）；「区分研究关联」以知识边界声明实现
- **interaction_skill**: uncertainty_handling｜**training_value**: ★★★★★（直接修复
  实验 B 第二处幻觉）

### b2d-006 ｜ F-004 不需要追问：「什么是手冲咖啡？」

- **user_scenario**: 信息完整的直接解释类（GPT 指出的最大缺口——追问能力 0 的另一侧）
- **training_skill**: 直接解释（不过度追问、主动帮助）
- **answer_structure**: A 直接定义（手冲=穿滤式萃取，水持续穿过粉层）→ B 与浸滤式
  的对比框架 → C 器具族（锥形 V60 / 平底 Kalita）→ 下一步（想上手可从官方起点配方
  开始）
- **claim_ids**: ["claim.pourover.paper-rinse-universal", "claim.pourover.v60-official-expert"]｜
  **source**: hario-v60-expert-guide（两 claim 在例外内；topic=brewing ∈ allowed_topics ✓）——**可立即写**
- **risk_notes**: **零追问**——定义类问题直接回答到底；解释素材以正文常识+
  claim 支撑，不编造历史
- **interaction_skill**: condition_based_advice（收尾给上手路径）——**注意**：本条
  训练核心是「不追问」，skill 标注建议为 clarification 的反面 case，落库登记时与
  GPT 确认字段值（候补：直接标 condition_based_advice）
- **training_value**: ★★★★★（GPT：这是现在最大的缺口）

### b2d-007 ｜ F-004：「手冲之前为什么要冲洗滤纸？」

- **user_scenario**: 「为什么」类直接解释（单一事实点，信息完整）
- **training_skill**: 直接解释（不追问）
- **answer_structure**: A 直接回答（去纸味 + 预热滤杯——跨来源共识）→ B 展开两点
  的实际影响 → C 操作建议（热水均匀淋洗）→ 下一步
- **claim_ids**: ["claim.pourover.paper-rinse-universal"]｜**source**: hario-v60-expert-guide
  （claim 在例外内；topic=brewing ✓）——**可立即写**
- **risk_notes**: 单一事实点直接答到底——「不需要追问」的标杆样本
- **interaction_skill**: condition_based_advice｜**training_value**: ★★★★

### b2d-008 ｜ F-005 必须追问（意式深化）：「我的浓缩最近很难喝」

- **user_scenario**: 与 b2c-001（手冲开放）差异化——**意式**场景 + 「最近」（时间
  变化信号叠加）
- **training_skill**: clarification（必须追问侧的意式版）
- **answer_structure**: A 不直接诊断（信息不足）→ B 意式诊断最小信息集（豆子变化/
  研磨刻度/配方/流速）+「最近」提示优先排查豆况变化 → C 各信息项的分流意义 →
  下一步
- **claim_ids**: ["rule.fellow.shot-bitter", "rule.fellow.shot-sour", "rule.fellow.shot-slow"]｜
  **source**: fellow-espresso-basics（三 rule 在例外内；topic=espresso ∈ allowed_topics ✓）——**可立即写**
- **risk_notes**: 与 b2c-001 差异化：意式参数体系 + 「最近」时间信号；追问不给结论
- **interaction_skill**: clarification｜**training_value**: ★★★★

### b2d-009 ｜ 事实锚点-新鲜度：「咖啡豆应该怎么储存？」

- **user_scenario**: 信息完整的直接解释类（储存方法——nca claim 覆盖良好）
- **training_skill**: 直接解释（不追问）+ 事实锚点
- **answer_structure**: A 直接回答储存要点 → B 原理（新鲜度衰减机制 + 储存敌人）→
  C 分装/冷冻等具体做法的边界 → 下一步
- **claim_ids**: ["claim.freshness.nca-storage-enemies", "claim.freshness.nca-peak-decline-stale"]｜
  **source**: nca-aboutcoffee（两 claim 在例外内；topic=freshness ∈ allowed_topics ✓）——**可立即写**
- **risk_notes**: 直接回答（不追问「你的豆子是哪种」）；不编造具体保质期数字
  （duration-table claim 若引用需核对原文）
- **interaction_skill**: condition_based_advice｜**training_value**: ★★★★

### b2d-010 ｜ 事实锚点-研磨：「研磨刻度可以直接照搬别人的吗？」

- **user_scenario**: 直接解释 + 条件化（baratza claim 直接覆盖）
- **training_skill**: 直接解释（不追问）+ 条件化框架
- **answer_structure**: A 直接回答（不能直接照搬——正确数值取决于豆子与器具）→
  B 原理（不同磨豆机同刻度实际粒度不同）→ C 正确做法（以自己设备建立基准）→
  下一步
- **claim_ids**: ["claim.grinding.manual-not-recipe"]｜**source**: baratza-documents
  （claim 在例外内；topic=grinding ∈ allowed_topics ✓）——**可立即写**
- **risk_notes**: 与 b2b-004 差异化——b2b-004 训练「多来源差异拆解」，本条单来源
  直接解释（自然度测试 N9 清洁题同类）；不编造具体刻度数字
- **interaction_skill**: condition_based_advice｜**training_value**: ★★★★

## 汇总

| 维度 | 结果 |
|---|---|
| **可立即写数量** | **10/10**（claim 全部在既有例外 allowed_claim_ids 内或 fda 自动准入；topics 全部预检通过） |
| **来源分布** | fda-caffeine 3（自动准入）/ ucdavis 2 / hario-expert 2 / fellow-espresso 1 / nca 1 / baratza 1——零新增授权 |
| **类型比例影响** | 新增后事实锚点/直接解释类 +6、边界/不确定 +3、澄清 1——方向符合 GPT「事实锚点 20%→35%」 |
| **风险分类** | 中高风险：b2d-003/004/005（反事实纠错+边界声明，幻觉防线型）；中风险：b2d-001/002；低风险：b2d-006/007/008/009/010（直接解释类） |
| **GPT 五方向覆盖** | F-001×2（b2d-001/002）、F-002×2（b2d-003/004）、F-003×1（b2d-005）、F-004×2（b2d-006/007）、F-005×1（b2d-008）+ 事实锚点×2（b2d-009/010） |

## 待 GPT 确认项

1. b2d-006 的 interaction_skill 标注（直接解释类的 skill 字段值——候补
   condition_based_advice，或由 GPT 指定新语义）；
2. b2d-005（帕金森边界）的「不编造研究方向」设计是否符合 F-003 意图（知识库无
   帕金森 claim，无法做研究关联的 F 层表述）；
3. 流程：plan ✓ →（待指示）draft → gate → review → approved ~35 → 实验 C。

## 流程纪律（GPT 指示）

> 不修改现有 approved 25；本文件只出 plan 不写候选正文；新增数据前不训练。
