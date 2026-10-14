…
显示更多
ChatGPT 说：

。
…
显示更多
ChatGPT 说：

已核对你描述的流程状态（基于你提供的阶段记录；我当前无法直接拉取 GitHub 远程仓库内容进行实时 diff 核验）。从工程状态和审核纪律来看，阶段六点九-B 的处理方向是正确的，可以进入六点九-C。

先确认几个关键点：

1. b2b 草稿生成策略通过

这批 Batch2b 的价值和 Batch2a 不同：

Batch1：知识正确性
Batch2a：诊断能力
Batch2b：模型行为能力（交互、拒答、不确定性、追问）

所以 b2b-001/003/005/008 这类样本实际上比普通知识问答更重要。

尤其：

b2b-008「不知道能力」

这个应该保留。

因为未来咖啡 AI 最大风险不是不知道，而是：

在信息不足情况下生成一个听起来专业但不可验证的答案。

这个样本训练价值很高。

2. 关于「黄金参数/最佳比例/一定有效」扫描处理

你的处理方式可接受。

原因：

质量门禁不应该简单禁止词，而应该判断语义。

例如：

✅ 合格：

没有适用于所有豆子的黄金参数。

这是在拒绝错误认知。

❌ 不合格：

黄金参数是 1:16。

这是制造伪标准。

所以当前逻辑：

命中禁词
 ↓
判断上下文
 ↓
否定/纠偏语境放行
 ↓
肯定式错误表达阻断

比简单 blacklist 更合理。

建议后续把这个能力正式写入 quality gate：

新增：

strong_claim_context_check

输出：

keyword:
黄金参数

context:
否定纠偏

severity:
pass

避免以后每次人工解释。

3. 六点九-C 应该做什么

我建议不要马上人工审核。

先做一次 Batch2b 行为质量门禁增强。

因为这一批新增能力维度比较多：

能力	对应样本
信息不足追问	b2b-001/005/008
拒绝伪精确参数	b2b-003/006
条件化建议	全部
健康边界	b2b-007
冲突参数处理	b2b-002

现有 gate 偏知识质量，需要增加行为质量。

阶段六点九-C 执行提示词

给编码模型：

任务：
Batch2b Quality Gate 行为能力增强。

目标：
不修改任何候选内容，不批准任何样本，不修改 approved 数据。
只增强审核工具和测试。

读取：
Tools/CoffeeAI/review_queue/batch2b_candidates_draft.jsonl
Tools/CoffeeAI/review_queue/BATCH2_WRITING_SPEC.md
Tools/CoffeeAI/review_queue/check_candidate_quality.py

执行：

一、增加 interaction quality checks

新增检查：

1. missing_information_handling

规则：

对于 interaction_skill 属于：
- clarification
- uncertainty
- diagnosis

必须检查回答是否包含：

「还需要知道」
或等价的信息收集段。

缺失：
error

---

2. direct_parameter_answer_check

目标：
阻止用户请求参数时直接输出唯一答案。

检测场景：

包含：
- 推荐比例
- 参数多少
- 时间多少
- 温度多少

但回答不存在：

- 来源语境说明
- 条件限制
- 多方案比较

则：

error


---

3. next_step_recommendation_check

诊断类回答必须包含下一步行动。

例如：

允许：

"可以先观察流速，再决定是否调整研磨。"

禁止：

只解释原因，没有行动建议。

缺失：

warning

---

4. uncertainty_expression_check

针对：

interaction_skill:
- uncertainty_handling
- missing_information

检查：

必须包含：

- 当前信息不足
- 需要更多信息
- 无法判断唯一原因

等限定表达。

否则：

error

---

5. overconfidence_check

扩展现有强断言扫描：

禁止：

一定
必然
唯一原因
肯定是

但允许：

- 否定语境
- 风险提示
- 引用限制

输出上下文。

---

二、新增测试：

至少增加：

TestBatch2bInteractionQuality：

case1:
缺少追问 → error

case2:
参数问题直接给答案 → error

case3:
含条件建议 → pass

case4:
不知道能力表达 → pass

case5:
健康回答无医疗边界 → error

case6:
否定黄金参数 → pass

case7:
黄金参数作为推荐 → error


---

三、运行：

python3 Tools/CoffeeAI/tests/test_coffeeai.py

python3 Tools/CoffeeAI/review_queue/check_candidate_quality.py \
--input batch2b_candidates_draft.jsonl \
--json

要求：

118 tests → 至少新增测试后全部通过。

---

四、输出报告：

新增：

Tools/CoffeeAI/review_queue/batch2b_quality_gate_report.md

包含：

- 新增规则
- 测试数量变化
- b2b-001~008检查结果
- 未修改文件证明

禁止：

- 修改 candidates
- 修改 approved
- 修改 source_exceptions
- split
- train

完成六点九-C 后，再进入：

六点九-D：Batch2b 人工审核包生成

顺序：

Batch2b gate
↓
review package
↓
负责人批准
↓
approved 22 条左右
↓
补 3~5 条高价值样本
↓
达到：
approved ≥25
train ≥15
↓
第一次 mlx-lm dry-run

目前不要急着训练。

你现在做的方向是正确的：先把「模型不会胡说」这件事做好，再考虑模型能力。对于 BrewPhase 这种垂直领域助手，数据治理价值会明显高于早期微调。

ChatGPT 可能会出错。请核查重要信息。
最新一条回复




思考
