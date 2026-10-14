# Batch2a 人工拍板辅助表（阶段六点五-B）

> 日期：2026-10-14 ｜ 依据：GPT 建议（模型行为风险视角）
> 配合 `batch2a_review_package.md` 使用。**拍板动作只能由负责人执行。**

## 〇、拍板结果（2026-10-14，负责人执行记录）

- **b2a-010：选方案 A**（删除 CO₂/排气/氧化机理细节后批准）——已执行：回答中机理
  I 层标注改为「具体变化路径与速度因豆子、包装与储存而异，尚无核验来源（推断），
  此处不作机理解释」，不含任何 CO₂/排气/氧化字样；reasoning_level / risk_notes 同步更新。
- **b2a-001/002/003/004/006/009：按辅助表建议保留批准**。
- 3 原则随批准确认：F/P/I 划分口径（CLAIM_POLICY）、厂商经验不升级行业标准、
  noncommercial-research 来源范围。
- 执行链已按第四节完成：7 条落库 `batch2a_candidates.jsonl/.meta.jsonl`（approved +
  三指纹 + reviewed_by/at）→ `approved_batch_manifest_batch2a.json`（batch2a-approved-r1）→
  `check_approval_ready` ready=true, errors=0 → 合并 12 条 approved 划分
  （train 10 / valid 1 / test 1，无泄漏；train <15，训练保持冻结）。
- 配套范围修正：fellow-espresso-basics 例外扩展（+b2a-001/002/003/004、+shot-slow/
  ratio-1to3/roast-level-acrid）、hario 例外扩展（+b2a-006、+brewing 主题）；
  `source_admission_issues` 修复多来源样本 claim 并集语义（单来源行为不变）。

## 一、7 条草稿：训练价值 / 最大行为风险 / 批准建议

| sample | 训练价值 | 最大风险（模型可能学成的坏习惯） | 批准建议 |
|---|---|---|---|
| b2a-001 | 高 | 「酸=欠萃」误导 | 保留，限制措辞（多因并列，不得单因归因） |
| b2a-002 | 高 | 苦感单因归因 | 保留 |
| b2a-003 | 中高 | 时间迷信 | 保留 |
| b2a-004 | 高 | 通道效应绝对化 | 保留 |
| b2a-006 | 高 | 参数万能化 | 保留 |
| b2a-009 | 中 | 新鲜度固定周期 | 保留 |
| **b2a-010** | 中 | **机理写成确定事实（CO₂ 排气未外部核验）** | **暂缓或修改——二选一**：A=保留但回答限制为「咖啡烘焙后会随着时间和储存条件发生变化」，不解释 CO₂ 细节；B=补 CO₂ 来源后批准。**GPT 倾向 A。** |

## 二、三处 I 层的人工确认标准（允许 / 不允许的措辞）

| 样本 | 允许（I 层合规范式） | 不允许（I 伪装 F） |
|---|---|---|
| b2a-001 | 「豆子本身的酸质特征也可能影响最终感受到的酸感」 | 「这种酸来自豆子」 |
| b2a-002 | 「深烘焙通常更容易表现出苦味或烘焙风味」 | 「深烘焙一定更苦」 |
| b2a-003 | 「一些经验丰富的品鉴者会结合酸、甜、苦、余韵判断萃取表现」 | 「专业判断标准就是……」 |

## 三、三个原则确认（与逐条批准一并拍板）

1. 是否接受当前 F/P/I 划分（CLAIM_POLICY 口径）？
2. 是否接受「厂商/作者经验不升级行业标准」？
3. 是否接受 noncommercial-research 的当前来源授权范围？

## 四、拍板后的执行链（由负责人确认后触发）

```
approval_execution_template.md（逐条落库：review_status + 双指纹 + reviewed_by）
↓
approved_batch_manifest 更新（batch1-approved-r2 或并入）
↓
check_approval_ready（errors=0）
↓
split_dataset（此时才划分）
```

**不要提前 split。**
