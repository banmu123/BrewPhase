# Batch2b 批准落库执行报告（阶段六点九-E，进行中——2026-10-14）

> 负责人拍板：2026-10-14 采纳 GPT 拍板清单（对话指示「按照GPT建议继续」）
> = 8 条全部 approve + 例外仅扩 allowed_sample_ids + 训练保持冻结。
> 执行进行至 check_approval_ready dry-run，**发现 GPT 清单 B 与例外表现实的冲突**，
> 按纪律暂停并请求 GPT 裁定（未 push split、未宣称落库完成）。

## 一、已完成步骤

1. **例外 allowed_sample_ids 扩展**（按 GPT 清单 B，仅样本 ID）：ucdavis←b2b-001/004/005/008、
   hario-v60-expert-guide←b2b-002/003、hario-v60-hoffmann←b2b-003、baratza←b2b-004、
   nca←b2b-005、fellow-espresso-basics←b2b-006。allowed_claim_ids / allowed_topics /
   deployment_purposes 未动。
2. **元数据修正（补全来源声明，非扩权）**：b2b-002 source_ids += hario-v60-hoffmann——
   其引用的 `conflict.v60.official-recipes-differ` 授权归属 hoffmann 例外（GPT 禁止扩
   allowed_claim_ids，故补全来源声明使六点五-C 并集语义覆盖全部引用）。连带需求：
   hoffmann 例外的 allowed_sample_ids 需 +b2b-002（GPT 清单 B 只列了 b2b-003）。
3. **topic 对齐（仅 meta 分类标签，消息内容零改动）**：b2b-008 topic 'sensory' →
   'pour-over diagnosis'（对齐 ucdavis 既有 allowed_topics 与 b2a-005/008 先例）。
4. **落库产物已生成**：batch2b_candidates.jsonl（8 条）+ batch2b_candidates.meta.jsonl
   （review_status=approved、双哈希、reviewed_by/at）+ approved_batch_manifest_batch2b.json
   （batch2b-approved-r1）。

## 二、check_approval_ready 结果：NOT READY（errors=6）

| 样本 | 状态 | 卡点 |
|---|---|---|
| b2b-001 | ✅ READY | — |
| b2b-006 | ✅ READY | — |
| b2b-007 | ✅ READY | — |
| b2b-008 | ✅ READY | —（topic 对齐后） |
| b2b-002 | ❌ | hario-expert topics ✗ + hoffmann allowed_sample_ids 缺 b2b-002 |
| b2b-003 | ❌ | hario-expert topics ✗ + hoffmann topics ✗ |
| b2b-004 | ❌ | baratza topics ✗ |
| b2b-005 | ❌ | ucdavis topics ✗ |

## 三、冲突详情：allowed_topics 层（GPT 清单 B 制定时不存在的约束）

例外表除 allowed_sample_ids 外还有 **allowed_topics** 限制器，且多来源样本的 topic
必须同时落在**每个**命中例外的 topics 内（`check_exception_scope` 逐例外独立检查）。
GPT 清单 B 的「不增加 allowed_topics」是在不知道这一层的情况下制定的。

四个例外 topics 与 b2b 样本需求：

| 例外 | 既有 topics | 需要覆盖的 b2b 样本 topic |
|---|---|---|
| hario-v60-expert-guide | brewing-troubleshooting, brewing | b2b-002/003（可通过改 topic 对齐，见下） |
| hario-v60-hoffmann | uncertainty | b2b-002/003（无论 topic 怎么选都必须扩） |
| baratza-documents | grinding, brewing | b2b-004（ucdavis∩baratza 交集为空，必须扩其一） |
| nca-aboutcoffee | freshness | b2b-005（ucdavis∩nca 交集为空，必须扩其一） |
| ucdavis-coffee-center | pour-over diagnosis | b2b-004/005（同上，两端必扩其一） |

**存量同病**：b1-025（topic=uncertainty，双来源 hario-expert+hoffmann，3 claim 与
b2b-003 完全相同）从未落库（至今 unreviewed，仅登记了例外）——这正是 topics 交集
问题未在 batch1/2a 暴露的原因。若未来批准 b1-025 会撞同一堵墙。

## 四、请 GPT 裁定的选项

- **方案 A（推荐）——恢复性/对齐性 topics 扩展（3 个例外动 topics，2 个例外动 topics 后 b2b-002/003 的 meta topic 对齐既有范围）**：
  1. hario-v60-hoffmann topics: ['uncertainty'] → + 'brewing-troubleshooting'、'brewing'
     （b2b-002 topic 改 'brewing-troubleshooting'、b2b-003 topic 改 'brewing'——两者内容
     本就是故障诊断/冲煮配方主题，标签更贴合）；hoffmann allowed_sample_ids + b2b-002；
  2. baratza-documents topics: + 'pour-over diagnosis'（b2b-004 topic 不变）；
  3. nca-aboutcoffee topics: + 'pour-over diagnosis'（b2b-005 topic 改 'pour-over
     diagnosis'——其内容主体是「感知变化的诊断分流」）；
  4. ucdavis / hario-expert topics 不动。
  理由：扩的都是「样本实际主题且来源核验内容真实覆盖该主题」；b1-025 存量一致性
  同时修复（hoffmann topics 扩后 b1-025 仍 uncertainty ✓）。
- **方案 B**：check_exception_scope 的 topics 检查改并集语义（同 claim 六点五-C 先例）——
  治理工具语义变更，影响所有样本校验，改动面大。
- **方案 C**：b2b-002/003/004/005 defer，本轮只落 b2b-001/006/007/008（4 条，
  approved 14→18），其余等例外治理专项。
- （备选组合：方案 A 仅对 002/003，004/005 走 C。）

## 五、当前状态

- 落库产物（8 条）已生成但**未宣称完成**；splits 未重建；训练保持冻结。
- 下一步完全按 GPT 裁定执行；裁定后重跑 check_approval_ready 至 READY，
  再 validate --for-training → split → 数量报告。

以上，等待你的裁定与下一步指示。
