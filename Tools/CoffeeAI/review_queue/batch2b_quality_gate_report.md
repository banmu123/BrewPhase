# Batch2b Quality Gate 行为能力增强报告（阶段六点九-C，2026-10-14）

> 任务来源：GPT 六点九-C 执行提示词（回复全文存档 `/tmp/gpt_next25.md`）。
> 目标达成：**不修改任何候选内容、不批准任何样本、不修改 approved 数据**——
> 只增强审核工具（check_candidate_quality.py）与测试（test_coffeeai.py）。

## 一、新增规则（GPT 指定 5 项，全部落地）

| # | 检查 | code | 级别 | 触发条件 |
|---|---|---|---|---|
| 1 | missing_information_check | `missing-information-collection` | error | interaction_skill ∈ {clarification / uncertainty_handling / multi_variable_reasoning / condition_based_advice}（GPT 三类「clarification/uncertainty/diagnosis」映射到本项目枚举），回答缺「还需要知道」或等价信息收集段 |
| 2 | direct_parameter_answer_check | `direct-parameter-answer` | error | 用户消息含参数请求信号（黄金比例/参数多少/多少度/卡在…共 20 模式）且回答无来源语境/条件限制/多方案标记 |
| 3 | next_step_recommendation_check | `next-step-missing` | warning | 诊断类 topic 回答只解释原因、无下一步行动建议 |
| 4 | uncertainty_expression_check | `uncertainty-expression-missing` | error | interaction_skill=uncertainty_handling 但回答无「当前信息不足/需要更多信息/无法判断唯一原因」等限定表达 |
| 5 | overconfidence_check（strong_claim_context_check） | `strong-claim-assertion`（error）/ `fact-impersonation-risk`（warning） | error/warning | 强断言词表扩展至 11 个（一定是/肯定是/唯一原因/一定有效/黄金参数/黄金比例/最佳参数/最佳比例/必然/永远/一定）：**肯定句式推荐（「黄金参数是 X」）→ error 阻断**；否定/纠偏语境 → pass 并输出上下文；无语境限定 → warning 交人工 |
| 附 | health_boundary_check（GPT case5 需要的独立规则） | `health-boundary-missing` | error | topic=health 但回答无非医疗建议边界声明 |

**strong_claim_context_check 的语境判定逻辑**（按 GPT 指定「命中禁词 → 判断上下文 →
否定/纠偏语境放行 → 肯定式错误表达阻断」，在 `--json` 输出
`samples[].strong_claim_contexts`：每条命中含 `keyword / context / severity / verdict`，
verdict ∈ {negation-context(pass) / assertion(error) / unqualified(warning)}，
避免以后每次人工解释）。

兼容性设计：行为类检查（规则 1/2/4/5）只对**声明了 `interaction_skill` 字段的样本**
生效（Batch2b 起），Batch2a 及更早样本自动跳过，保证历史数据回归不受影响。

## 二、测试数量变化

- 基线：118 tests → 现状：**127 tests OK**（新增 `TestBatch2bInteractionQuality` 9 个用例）：
  - case1 缺少追问 → error ✅
  - case2 参数问题直接给答案 → error ✅
  - case3 含条件建议 → pass ✅
  - case4 不知道能力表达 → pass ✅（含 strong_claim_contexts negation-context 断言）
  - case5 健康回答无医疗边界 → error ✅
  - case6 否定黄金参数 → pass ✅（含 strong_claim_contexts negation-context 断言）
  - case7 黄金参数作为推荐 → error ✅（`strong-claim-assertion` 阻断）
  - case8 诊断类缺下一步建议 → next-step-missing warning（不阻断）✅
  - case9 真实 Batch2b 草稿 8 条 0 error 回归 + 禁止任何肯定式伪标准 ✅

## 三、b2b-001~008 检查结果（增强后门禁）

`check_candidate_quality.py --input batch2b_candidates_draft.jsonl --json`：
**PASSED（checked=8, errors=0, warnings=0）**

| 样本 | issues | strong_claim_contexts |
|---|---|---|
| b2b-001（澄清） | 0 | 唯一原因 → negation-context（pass） |
| b2b-002（冲突参数） | 0 | — |
| b2b-003（黄金参数纠偏） | 0 | 黄金参数 → negation-context（pass） |
| b2b-004（条件化） | 0 | — |
| b2b-005（花香诊断） | 0 | — |
| b2b-006（时间读数） | 0 | — |
| b2b-007（健康边界） | 0 | — |
| b2b-008（不知道能力） | 0 | 唯一原因 → negation-context（pass） |

六点九-B 报告中请求 GPT 确认的 3 处否定语境禁用词，现在已被
strong_claim_context_check 自动判定为 pass（negation-context），无需人工解释。

**Batch2a 历史草稿回归**：仍 PASSED（0 error）；新增检查在历史数据上发现 1 条
warning——b2a-006 诊断类回答缺下一步行动建议（`next-step-missing`）。该样本已是
approved 历史数据，本轮不改任何数据，仅在此报备供 GPT 决定是否需要回溯补写规则。

## 四、未修改文件证明

本轮**只修改**以下 2 个工具/测试文件 + 1 个工作日志：

1. `Tools/CoffeeAI/review_queue/check_candidate_quality.py`（门禁增强，只读工具本身）；
2. `Tools/CoffeeAI/tests/test_coffeeai.py`（+9 测试）；
3. `.workbuddy/memory/2026-10-14.md`（工作日志，非工程数据）。

未触碰：`batch2b_candidates_draft.jsonl`（候选内容零改动）、approved 文件、
`approved_batch_manifest*`、`source_exceptions.json`、review_status、split、
`knowledge/**`。`build_kb --check` 通过且为只读模式（no file written）。

## 五、待 GPT 指示

六点九-C 完成，等待确认后进入 **六点九-D：Batch2b 人工审核包生成**
（gate → review package → 负责人批准 → approved ≈22 → 补 3~5 条高价值样本 →
approved ≥25 / train ≥15 → 第一次 mlx-lm dry-run；目前不训练）。
