# 阶段六点三 — Batch2a 写作质量门禁增强报告

> 日期：2026-10-14 ｜ 约束遵守：batch1 approved 数据零修改、未批准任何候选、
> 例外表未动、未训练、全部改动已推送（可在远程 main 回滚）。

## 一、新增/修改文件

| 文件 | 类型 | 内容 |
|---|---|---|
| `Tools/CoffeeAI/review_queue/check_candidate_quality.py` | 新增 | 质量门禁 CLI（只读）：四类检查，JSON/文本输出，error 时 exit 1 |
| `Tools/CoffeeAI/tests/test_coffeeai.py` | 修改 | 新增 `QualityGateTests` 9 项测试 |
| `knowledge/_method/translation_decisions.json` | 修改（数据修正） | chalky 条目 `avoid_translation` 从「发涩（作为 chalky 的对应词）」改为纯词「发涩」——原内嵌注释导致门禁纯词匹配失效（发现的实现 bug，注释已并入 reason） |

## 二、检查规则（4 类）

1. **术语冻结扫描**：avoid 词动态读取自 `translation_decisions.json`（当前：weak→避免「空洞」；
   chalky→避免「发涩」）。命中 → **error**，输出 sample_id/原句/推荐替代表达/理由。
   豁免：解释性上下文（「俗称发涩」「原文」「严格说」前后 8 字符内）——b1-015 补丁模式。
2. **F/P/I 表达检查**：`reasoning_level` 含 F 但 claim_ids 为空 → **error**（f-without-claim）；
   含 I 但回答无限定词（可能/通常/往往/推断/尚未核验…）→ **error**（i-without-qualifier）；
   出现「必然/一定是/肯定/永远」→ warning（fact-impersonation-risk，人工确认）。
3. **诊断链检查**：诊断类主题（espresso/brewing/brewing-troubleshooting 等）回答缺少
   验证/观察/对比/排查语义 → **warning**（diagnostic-chain-incomplete）。
4. **数字风险扫描**：回答含数字+单位（°C/g/ml/秒/比例）→ claim_ids 为空 → **error**
   （numeric-claim-missing-context）；有 claim 但无适用范围说明 → **warning**
   （numeric-scope-missing）。

## 三、测试（118 项 = 109 + 9 新增，全部通过）

GPT 要求的 7 类用例全部落地：①「空洞」失败；②「发涩」误译失败；③「粉感」正确通过；
④ F 无 claim 失败；⑤ I 无限定词失败；⑥ 诊断链缺失=warning 不阻断；⑦ 数字无上下文=error。
另加：解释性「俗称发涩」豁免用例、真实 Batch2a 草稿回归用例（b2a-002/003 通过门禁）。

## 四、数据未影响证明

- `batch1_candidates.jsonl`/`.meta.jsonl`：指纹与批准前一致（5 approved / 25 unreviewed）；
- `batch2a_candidates_draft.jsonl`：内容未改（门禁对其只读扫描，passed）；
- `source_exceptions.json`：2 条例外未变；
- `review_status`、`data/corpus`、训练状态：无任何变化；
- `Ran 118 tests, OK` + `build_kb --check` 通过。

## 五、门禁使用方式

```
python3 Tools/CoffeeAI/review_queue/check_candidate_quality.py --input <draft.jsonl> --json
```
Batch2a 后续候选（b2a-001/004/005…）生成时必须先过本门禁（errors=0）再交人工审核。
