# Batch 1 修订补丁决策表（阶段五点五 → 五点七执行）

> 日期：2026-10-14 ｜ 依据：`batch1_revision_patch.jsonl` + 试点/全量审核
> **执行结果（2026-10-14）：4 条补丁全部 `accept` 并已套用**（负责人按 ChatGPT 建议
> 授权执行）；套用后 4 条样本已重新人工审核并更新双指纹与 dedup 指纹。

| sample_id | old_content_summary | patch_content | decision | reason |
|---|---|---|---|---|
| b1-013 | 手冲水流过慢：Hario 官方方向（磨粗）+ 无标注推断句 | 补推断标注「（这是方向性推断：研磨越粗、单位时间萃取越少）」 | **accept（已套用）** | CLAIM_POLICY 合规；官方方向不变 |
| b1-014 | 意式发酸/咸/空洞（Fellow 第一近似） | 「空洞」→「寡淡」+「（原文 weak）」溯源 | **accept（已套用）** | 与 PDF 原文对齐 |
| b1-015 | 意式苦涩：三因素句未分层 | 「粉感（原文 chalky，俗称发涩）」+ 水温 F / 烘焙度豆子状态 I | **accept（已套用）** | 术语冻结 + F/I 分层 |
| b1-016 | 凭酸味断言萃取不足的反驳 | 两处「空洞」→「寡淡」/「尖锐单薄」 | **accept（已套用）** | 纯术语替换 |

**套用后状态**：4 条样本 messages 已更新、`dedup_fingerprint`/`reviewed_content_sha256`/
`reviewed_record_sha256` 重算写入、`review_status=approved`（reviewed_by=banmu123）、
check_approval_ready 通过。
