# Batch 1 决策包（阶段五点五汇总）

> 日期：2026-10-14 ｜ 汇总：试点+全量审核 → 全部人工决策文件已备齐，**全部 pending，等待负责人拍板**。

## 1. 决策文件清单（本阶段新增）

| 文件 | 内容 | 状态 |
|---|---|---|
| `batch1_patch_decision.md` | 4 条修订补丁逐条决策表（b1-013/014/015/016） | 全部 pending |
| `term_freeze_decision.md` | weak（寡淡）/chalky（粉感）/astringent 边界最终确认 | pending |
| `source_exception_decision.md` | hario / fellow 两来源三方案分析 + 推荐（方案 A） | 推荐，未登记 |
| `batch1_admission_proposal.json` | 30 条候选准入提案（内容决策/来源状态/证据状态/建议动作/置信度） | 已生成 |
| `redundancy_decision.md` | b1-008/024 冗余处理（A 保留两个 / B 合并 / C 删除一个） | 待人工选 |
| 本文件 | 决策包汇总 | — |

## 2. 准入提案统计（batch1_admission_proposal.json）

- **30 条候选全部 `needs-review` 路径，其中 1 条（b1-012）内容+证据双满、
  建议 `approve_candidate`**（但仍受 hario 来源准入阻断——例外批准是它的唯一闸门）；
- 其余 29 条缺外部核验（22 条 needs-source-check + 7 条部分核验）或待补丁采纳；
- 无一条当前可实际进入训练（来源准入 + 审核状态 unreviewed 双重把关仍在）。

## 3. 当前阻塞项（按依赖顺序）

1. **负责人拍板 4 条补丁**（accept/reject/modify）→ 套用补丁 → 重算审核记录 → 重新人工审核；
2. **weak/chalky 冻结最终确认**（影响所有后续数据）；
3. **两来源例外方案 A 批准**（负责人填 approved_by/approved_at）→ b1-012 及 fellow/hario
   引用候选解除来源阻断；
4. **b1-008/024 冗余处理**（保留两个 / 合并 / 删除一个）；
5. **EFSA/Hoffmann/SCA 等关键外部证据补核**（b1-029/025/005）。

## 4. 安全边界确认（本阶段结束状态）

`batch1_candidates.jsonl`、`.meta.jsonl` 未修改；30 条 `review_status` 全 `unreviewed`；
`data/corpus|meta` 未写入；`source_exceptions.json` = schemaVersion 3、exceptions []；
未安装 mlx-lm、未下载模型、未训练。

## 5. 回归验证

```
python3 Tools/CoffeeAI/tests/test_coffeeai.py → Ran 109 tests, OK（Python 3.13.12）
python3 Tools/knowledge/build_kb.py --check → 通过
```

## 6. 建议的负责人决策顺序（承接 GPT 建议）

① 4 条补丁 → ② weak/chalky 冻结 → ③ Hario/Fellow 例外（方案 A）→ ④ b1-008/024 →
⑤ 生成第一批 approved 子集 → ⑥ 讨论划分与准入复查 → ⑦ 才谈训练。
