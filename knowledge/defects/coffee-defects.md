# 39 Coffee Defects — 咖啡缺陷

> status: partial ｜ authorityTier: 1 ｜ lastVerified: 2026-09-30 ｜ topic: defects

## Summary

缺陷需要回答四个问题（规格 §39）：`cause / when it occurs / how to recognize / whether bean / roast / brew related`。**禁止把所有负面味道都归因于某一个处理法。**

本知识库能确证的最有价值一条：UC Davis 正在为**绿咖啡物理缺陷**建立**感官阈值**，以改进分级标准——也就是说，缺陷对风味的影响是**可测量**的，不是玄学。

## Facts

| claim id | 事实 | sourceId |
|---|---|---|
| claim.defects.sensory-threshold-research | UC Davis Coffee Center 与 Coffee Science Foundation 合作研究**绿咖啡物理缺陷如何影响风味**；目标是**为缺陷识别建立感官阈值**，进而改进分级标准与品质评估。 | `ucdavis-research-index` |
| claim.defects.cqi-training | CQI 的 Q 课程考核包含**绿咖啡缺陷识别**，说明缺陷识别是专业能力的可考项。 | `cqi-q-grader-faq` |
| claim.defects.bh-qc-course | Barista Hustle 有 **Coffee Quality Control** 课程（46 课），从「**熟豆缺陷**」到「班次内饮品质量评估」。 | `barista-hustle` |
| claim.defects.roast-level-acrid | Fellow 官方配方语境的调参方向：意式「发苦/发涩」→ 磨粗（属**冲煮变量**，非豆子缺陷）。 | `fellow-espresso-basics` |
| claim.defects.gaggia-old-bean | Gaggia 故障排除：意式几乎无 crema 的可能原因包含「**咖啡太老或过干**」——这是**豆子状态**导致的缺陷表现。 | `gaggia-classic-manual` |

## 归因边界（本知识库的强制分类）

任何「负面味道」都必须先归档到下面三类之一，**不得跨类随意归因**：

| 归属 | 例子 | 依据 |
|---|---|---|
| **bean-related**（生豆/品种/储存） | 霉味、土豆味、木质、纸板（老化） | 绿咖啡缺陷研究 `ucdavis-research-index`；Gaggia「豆太老」`gaggia-classic-manual` |
| **roast-related**（烘焙） | 发展不足、烤焦、灼伤 | 烘焙主题 `ucdavis-coffee-center` |
| **brew-related**（冲煮/设备） | 发苦（磨太细）、发酸（磨太粗）、通道 | `fellow-espresso-basics` |

## 术语清单覆盖状态（规格 §39）

| 术语 | 状态 |
|---|---|
| quaker | 仅确认 WCR/绿咖啡语境存在该词类（缺陷族），**定义未核验** |
| underdeveloped / baked / scorched / tipped | ❌ 未核验 → REVIEW_QUEUE |
| fermented / moldy / musty / phenolic / earthy / potato defect / rubbery / chemical / woody / papery / stale | ❌ 未核验 |

> **诚实说明：** 本文件不提供上述术语的定义，因为本轮没有取得可引用的权威定义。把它们逐个补证，比编造定义更有价值。

## Practical Guidance

- 面向用户：给出「这是豆子问题 / 烘焙问题 / 冲煮问题」的**分类线索**，并说明识别需要对照（如杯测/或更换变量做排除）。
- 不得写成「你喝到 X 味，说明是 Y 处理法」。

## Exceptions / Limitations

- 大部分缺陷术语定义待补证（REVIEW_QUEUE P1/P2）。建议来源：`ucdavis-research-index`（绿咖啡缺陷阈值论文）、`sca-digital-store`（分类资料）、`cqi-home`（Q 课程材料）。

## Applicability

`generic`, `specific_roast`

## Evidence Type

`research`（Tier 1）+ `standard`（Tier 1）+ `expert_education`（Tier 3）

## Source

`ucdavis-research-index`、`cqi-q-grader-faq`、`barista-hustle`、`fellow-espresso-basics`、`gaggia-classic-manual`

## License

`see-source-terms`。独立改写。

## Last Verified

2026-09-30
