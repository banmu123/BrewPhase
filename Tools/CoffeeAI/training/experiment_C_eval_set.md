# Experiment C 评测方案冻结（阶段七-G-0，2026-10-15）

> 依据：GPT 阶段七-F-4 核验回复（gpt_reply_stage7f4_approved_7g0_prompt.md）
> 第 4 节——「冻结 Experiment C 评测方案：确保训练前、Experiment B、Experiment C
> 使用可比的评测题、相同推理参数与相同的 system-prompt / chat-template 策略」。
> 本文档由 test_coffeeai.py 的 EvalPromptConsistencyTests 锁定（题目/系统提示/
> 模板结构改动会让测试变红）。

## 一、评测输入策略（对实验 A/B 的修复，GPT 预判命中）

实验 A/B 的旧脚本（run_eval_generation.py / run_eval_generation_b.py）用裸
`--prompt` 生成，两处与训练分布不一致：

| 项 | 实验 A/B 旧策略 | Experiment C 修复策略 |
|---|---|---|
| system-prompt | 未传（训练数据 35 条全部带统一 system） | 传入与训练数据逐字一致的 system（run_eval_generation_c.SYSTEM_PROMPT，测试锁定） |
| chat template | 依赖 mlx_lm.generate 隐式默认（不可控不可测） | build_chat_prompt() 显式构造 Qwen ChatML + `--ignore-chat-template`；运行时 tokenizer.apply_chat_template 交叉校验（已实测 True），结构由单元测试锁定 |
| 推理参数 | 未显式（mlx-lm 默认 greedy） | 显式 `--temp 0`（greedy）、max_tokens=350、单次生成 |
| N5 题面 | 「推荐一个 V60 参数」——base 答华为耳机、adapterB 答 60Ah 电池（双双跑题） | v2：「手冲咖啡用 Hario V60 滤杯，参数上有什么推荐？」 |

## 二、对照策略（严格可比性边界）

- **严格对比（主验收）**：本脚本重跑的 base（对齐输入：system + ChatML + greedy）
  vs adapterC——同脚本、同输入策略、同参数。
- **与实验 B 对比**：仅作**趋势参考**。A/B 的 /tmp 产物为无 system 的旧输入策略
  （50 份文件保留于 /tmp/eval_q*、/tmp/nat_q*，不覆盖），与 C 产物不可直接混作
  严格分数对比——输入策略不同的分数变化不能归因于训练强度（GPT 裁定）。
- **N5 特别规则**：N5 v2 只对比「C 策略下 base vs adapterC」；实验 B 报告中 N5
  的 0/0 记录为跑题产物（题面缺语境），不参与任何严格对比。

## 三、评测集与能力覆盖（GPT 指定 6 项）

| 能力 | 对应题 | 通过口径 |
|---|---|---|
| 绝对化控制 | gov q1/q2、nat N2 | 开篇拆解变量，不用「一定/当然」 |
| 主动追问 | gov q5/q6 | 信息不足时先追问关键变量（仍不得万事追问） |
| 不知道能力 | gov q7/q8 | 明确知识边界，不编造机理/关系 |
| knowledge_explanation 防过问 | nat N3/N6/N7/N8/N9/N10（直接解释类） | 信息完整的解释题直接回答，不过度追问 |
| 健康边界 | gov q9/q10、nat N4 | 参考口径+个体差异+就医指引，无医疗断言 |
| 实验 B 两项事实错误消失 | **gov q8**（茉莉花香→不得答「豆子本身没有香味」）、**nat N4**（健康→不得出现帕金森风险反向断言） | 专项逐题人工核对 |

评分口径沿用：治理五能力 behavior_score（/10，达标线 ≥7/10，GPT E-4 门线）+
自然度 natural_score（/20）。**主验收不是 loss，而是行为**（GPT：绝对化纠偏保留、
追问真正改善、简单知识题直接回答、两项事实错误消失）。

## 四、执行流程（ Experiment C 训练完成后）

1. `python3 Tools/CoffeeAI/training/run_eval_generation_c.py --base-only`
   → /tmp/evalC_gov_q{1..10}_base.txt、/tmp/evalC_nat_q{1..10}_base.txt
2. `python3 Tools/CoffeeAI/training/run_eval_generation_c.py`
   → /tmp/evalC_gov_q{1..10}_adapterC.txt、/tmp/evalC_nat_q{1..10}_adapterC.txt
3. 三版并列（base[C策略] / adapterB[趋势参考] / adapterC）逐题人工评分；
   gov q8 与 nat N4 单独专项核对事实错误。
4. 结果写入 experiment_C_report.md（不覆盖本文件与实验 B 报告）。

## 五、评测脚本一致性测试（防止回退）

test_coffeeai.py → `EvalPromptConsistencyTests`（6 用例）：
system 与训练数据逐字一致 / ChatML 结构 / base-adapter 同生成路径 / N5 v2 语境 /
事实错误核对题在集 / 题面与文档冻结一致。任何一项改动都会让全量测试变红。
