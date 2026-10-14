# Batch2b 批准落库执行报告（阶段六点九-E，完成——2026-10-14）

> 负责人拍板：2026-10-14 采纳 GPT 拍板清单（对话指示「按照GPT建议继续」）。
> 中途发现 allowed_topics 层治理冲突（见 git 历史 45b421a 进度报告），GPT 裁定
> **修正版方案 A**（回复存档 `gpt_replies/gpt_reply_69e_topics_ruling.md`）：
> ✅ topics 对齐扩展 + 修复 b1-025 存量一致性 + 新增治理测试；
> ❌ 不修改 check_exception_scope 并集语义（topics 保守语义是 fail-closed 有意设计）；
> ❌ 不 defer b2b-002/003/004/005。
> 本报告为按裁定完成后的最终状态。

## 一、裁定执行明细（GPT 修正版方案 A）

1. **hario-v60-hoffmann**：allowed_topics ['uncertainty'] → + 'brewing'、
   'brewing-troubleshooting'（理由：Hoffmann 来源承担配方语境/参数差异解释/不同方法
   并存，非单纯 uncertainty）；allowed_sample_ids + b2b-002（冲突参数判断包含
   Hoffmann 语境）。
2. **baratza-documents**：allowed_topics + 'pour-over diagnosis'（b2b-004 是
   「同参数不同豆子/多变量对齐」，不是纯 grinding——修正之前过窄分类，非扩大授权）。
3. **nca-aboutcoffee**：allowed_topics + 'pour-over diagnosis'。**GPT 要求先核实
   b2b-005 的 NCA 是否只承担背景**——核实结果：`claim.freshness.nca-lose-freshness-
   immediately` 承担该样本「路径一（同包豆子随时间变化）」的完整实质证据，非背景，
   扩展正当（已按 GPT 判据核实后执行）。
4. **b2b-008** topic 'sensory' → 'pour-over diagnosis'（保持已做处理，GPT 确认正确）。
   另按 topics 对齐：b2b-002 topic → 'brewing-troubleshooting'、b2b-003 topic →
   'brewing'、b2b-005 topic → 'pour-over diagnosis'（仅 meta 分类标签，消息内容零改动；
   标签与内容主旨一致且全部落入来源既有授权语义）。
5. **b1-025 存量修复**：meta topic 'uncertainty' → 'brewing'（双来源例外 topics
   对齐扩展后的交集）；**不批准、保持 unreviewed**（GPT 明确）；allowed_sample_ids
   两例外此前已含。
6. **治理测试**：新增 `ExceptionTopicCoverageTests`（GPT 指定
   test_exception_topic_coverage_multi_source）：case1 交集 PASS / case2 无交集
   BLOCK（固化 fail-closed）/ case3 扩 topics 后 PASS。

## 二、校验链结果（全部通过）

| 检查 | 结果 |
|---|---|
| check_approval_ready（manifest batch2b-approved-r1，8 条） | **READY（errors=0, warnings=0）** |
| validate --for-training（batch2b 8 条，noncommercial-research） | **0 error / 0 warning，通过**（corpus 指纹 1fa0c38f…） |
| split_dataset（合并 22 条 approved，seed=42） | **train 18 / valid 2 / test 2，无跨集合泄漏** |
| test_coffeeai.py | **130 tests OK**（127 + 3 治理测试） |
| check_candidate_quality（batch2b 8 条） | PASSED（0/0） |
| build_kb --check | OK（只读模式） |

## 三、数量状态（GPT 预期 vs 实际）

- approved：14 → **22**（batch1 5 + batch2a 9 + batch2b 8）✅ 与 GPT 预期一致
- train：**18**（GPT 预估 ≈15，实际更优）——**train ≥15 阈值已达成**
- approved ≥25 阈值：还差 3 条（GPT 路线：补 3–5 条高价值样本）
- **训练仍冻结**（mlx-lm 未安装、模型未下载、无任何训练动作）；splits/ 不入 Git
  （可随时以 seed=42 重建，逐字节一致）

## 四、修改文件清单

- `Tools/CoffeeAI/source_exceptions.json`（3 例外 topics 对齐扩展 + hoffmann/b2b-002；
  reason 字段追加裁定依据）
- `Tools/CoffeeAI/review_queue/batch2b_candidates.jsonl` / `batch2b_candidates.meta.jsonl`
  （8 条 approved + 双哈希）
- `Tools/CoffeeAI/review_queue/approved_batch_manifest_batch2b.json`
  （batch2b-approved-r1）
- `Tools/CoffeeAI/review_queue/build_batch2b_approval.py`（落库脚本，含裁定执行逻辑）
- `Tools/CoffeeAI/review_queue/batch1_candidates.meta.jsonl`（仅 b1-025 topic 对齐 +
  notes 追加；保持 unreviewed）
- `Tools/CoffeeAI/tests/test_coffeeai.py`（+3 治理测试）
- 未修改：知识库（knowledge/**）、训练配置、draft 原稿（batch2b_candidates_draft.jsonl
  保持六点九-B 原样作为审计基线；落库产物由脚本从 draft 派生）。

## 五、下一步（按 GPT 路线）

- approved 22 / train 18：距训练阈值还差 3 条 approved——GPT 建议补 3–5 条高价值
  样本后进入**第一次 mlx-lm dry-run**（先装 mlx-lm + 下基座 + LoRA dry-run，
  不直接训练）；不要再扩 Batch2c。
- 等待 GPT 对本报告的核验与下一步指示。
