# Approved 落库人工批准执行模板（阶段五点六）

> 本模板规定「负责人确认之后、样本真正落库之前」的逐步执行顺序。
> 每一步都必须由负责人或其明确授权的人执行；脚本（check_approval_ready.py）
> 只做 dry-run 校验，不做任何修改。

## 批准步骤（按序执行）

1. **审核 sample_id**：在 `batch1_human_checklist.md` 中确认该样本的人工决策已完成
   （补丁采纳、术语无冲突、冗余处理完毕）。
2. **确认 candidate 文本版本**：若该样本有修订补丁，先确认补丁已按 `batch1_patch_decision.md`
   的 accept 决定套用到 `batch1_candidates.jsonl`（套用本身须另行人工确认执行）。
3. **确认 `reviewed_content_sha256`**：对最终 messages 重算 `messages_fingerprint`，
   写入该样本 meta（由人工显式执行，脚本不得代写）。
4. **确认 `reviewed_record_sha256`**：对「messages + 准入元数据」重算
   `reviewed_record_sha256`（REVIEWED_RECORD_FIELDS），同样人工显式写入。
5. **确认 source 状态**：该样本引用的每个 sourceId 要么自动准入（public-domain 全 allowed），
   要么在 `source_exceptions.json` 已有负责人登记的有效例外（含 approved_by）。
6. **更新 `review_status = approved`**：在该样本 meta 行人工修改。
7. **写入审核人与时间**：meta 增补 `reviewed_by` / `reviewed_at`（真实姓名与日期）。
8. **执行 admission check**：运行
   `python3 Tools/CoffeeAI/scripts/validate_data.py --corpus … --meta … --for-training --deployment-purpose …`
   与 `check_approval_ready.py --manifest …`，确认零 error 后方可进入
   `split_dataset.py` 划分流程。

## 检查清单（每条样本批准前逐项勾选）

- [ ] 候选文本版本 = 人工确认版本（补丁已套用或原文未改）
- [ ] reviewed_content_sha256 与 messages 一致
- [ ] reviewed_record_sha256 与（messages + 准入元数据）一致
- [ ] 全部引用来源已准入（自动准入或有效例外）
- [ ] review_status = approved 且 reviewed_by / reviewed_at 已写入
- [ ] validate --for-training 零 error
- [ ] check_approval_ready.py 报告 ready
