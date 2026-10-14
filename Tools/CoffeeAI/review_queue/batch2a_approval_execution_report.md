# Batch2a 批准落库执行报告（阶段六点八，2026-10-14）

> 依据：batch2a_round2_review_package.md（第二轮 A-H 审核）+ GPT 阶段六点八批准列表。
> 执行模式与既往一致：负责人授权 GPT 循环执行，approved_by = banmu123 (project owner)。

## 一、批准前后数量变化

| 指标 | 批准前 | 批准后 |
|---|---|---|
| batch2a 落库（batch2a_candidates.jsonl） | 7 条（r1） | **9 条**（+b2a-005、+b2a-008） |
| batch2a approved | 7 | **9** |
| 全局 approved（batch1 5 + batch2a） | 12 | **14** |
| 合并划分（全 approved） | train 10 / valid 1 / test 1 | **train 11 / valid 2 / test 1**（无泄漏） |
| 例外数 | 9 | 9（未动） |

## 二、批准清单与 b2a-010 处置记录

- **本轮真正新增 approved**：b2a-005（手冲酸多因诊断）、b2a-008（花香反单变量解释）
  ——GPT 第二轮批准列表中尚未批准的 2 条。
- **已在 r1 批准、本轮列表重复的 5 条**（b2a-001/002/003/006/009）：状态不变（approved），
  未重复落库；GPT 的逐条确认点（多因归因/术语边界/时间非目标/多变量追问/批次语境）
  与 r1 批准时记录一致，无需改动。
- **b2a-010**：GPT 建议 defer（conditional——A 方案后主要训练谨慎表达，价值待机理来源
  补充后增强）。**处置：保持 approved 不变**——该样本在 r1 已由负责人拍板批准
  （2026-10-14 选方案 A 后批准，三指纹齐全），无 unapprove 机制且批准有效；
  GPT 的 defer 建议已完整记录于 manifest r2 的 decision_reference，
  后续增强（CO₂/排气/氧化/包装影响的可靠来源）作为待办。
- b2a-004：r1 已批准（第一轮审核），本轮清单外，未动。

## 三、落库明细（本轮新增 2 条）

- `batch2a_candidates.jsonl` / `batch2a_candidates.meta.jsonl`：追加 b2a-005、b2a-008
  （标准格式：group_id/source_doc/data_version=v0.2-batch2a/review_status=approved/
  reviewed_by=banmu123 (project owner)/reviewed_at=2026-10-14/
  reviewed_content_sha256 + reviewed_record_sha256 + dedup_fingerprint 三指纹齐全）。
- `approved_batch_manifest_batch2a.json` 更新为 **batch2a-approved-r2**（9 条清单），
  decision_reference 记录 r1/r2 授权链与 b2a-010 处置。

## 四、校验结果

```
check_approval_ready（r2 manifest，9 条）→ ready=true, errors=0
validate --for-training（batch2a 9 条，--deployment-purpose noncommercial-research）→ 0 error
split_dataset（合并 14 条 approved）→ train 11 / valid 2 / test 1，无跨集合泄漏
python3 Tools/CoffeeAI/tests/test_coffeeai.py → Ran 118 tests, OK
python3 Tools/knowledge/build_kb.py --check → 通过
```

## 五、未修改文件证明

- batch1 候选/元数据：零修改（builder 未重跑，approved 5 条与 25 条 unreviewed 原样）；
- b2a-010 草稿与落库内容：零修改（defer 不改变已批准状态与文本）；
- source_exceptions.json：零修改（例外仍 9 条）；
- review_status 分布：batch1 {approved 5, unreviewed 25} + batch2a {approved 9}——
  batch2a draft 文件 9 条仍全部保留为生成记录（其中 005/008 已同步落库）。

## 六、当前状态与下一步

- approved = 14 / train 11 —— 仍未达 25 approved / 15 train 阈值，**训练继续冻结**
  （未安装 mlx-lm、未下载模型）；
- 下一阶段（GPT 预告）：六点九 Batch2b 小规模补齐 6~8 条高价值样本
  （失败案例拒答 / 参数冲突处理 / 信息不足主动追问 / 风味描述→操作建议转换），
  达到阈值后才进入 mlx-lm 安装 + 基座下载 + LoRA dry-run（不直接训练）。
