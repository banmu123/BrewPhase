# 08 Coffee Freshness — 新鲜度 / Resting

> status: partial ｜ authorityTier: 1 ｜ lastVerified: 2026-09-30 ｜ topic: freshness

## Summary

这是 BrewPhase 的**核心领域之一**（规格 §08）。烘焙后咖啡豆会持续**排气（degassing）**，二氧化碳释放会干扰均匀萃取；排气减缓后香气开始**氧化流失**。因此「新鲜度」是一条**先升后降的曲线**：峰值既不在烘焙当天，也不在无限远的将来。

> **写法红线：** 不得写「烘焙后 X 天最好」作为绝对科学规律。必须区分 **Roast Date / Open Date / Best Before / Peak Flavor Window / Practical Drinkability**，并保留 brew method、roast style、bean、packaging、storage、personal preference 的差异。

## Facts

| claim id | 事实 | sourceId |
|---|---|---|
| claim.freshness.sca-handbook-exists | SCA 出版《Coffee Freshness Handbook》（付费数字产品，$45），表明新鲜度是标准机构认可的独立研究主题。 | `sca-digital-store` |
| claim.freshness.storage-research | UC Davis Coffee Center 的研究方向包含**绿色豆储存期间的化学与生物退化**，以及 best storage/shipping methods。 | `ucdavis-coffee-center`、`ucdavis-coffee-center`（原文列举） |
| claim.freshness.dark-roast-rest-5-7d | 在具体批次语境下，深烘肯尼亚豆的**峰值风味推荐养豆期为烘焙后 5–7 天**（Fellow × Counter Culture 配方备注）。 | `fellow-brew-talks` |
| claim.freshness.light-roast-rest-4-6w | 在同一厂商配方库中，某些浅烘/实验处理豆的峰值被标为**烘焙后 4–6 周**（People Possession Arcadia / Elysium 备注）。 | `fellow-brew-talks` |
| claim.freshness.resting-varies-by-roast | 上述两条并列出现，说明**养豆期随烘焙度与处理法差异可达数周量级**，不存在统一天数。 | `fellow-brew-talks` |
| claim.freshness.nca-lose-freshness-immediately | NCA 指出**咖啡在烘焙后几乎立即开始失去新鲜度**，建议小批量频繁购买（一至两周量）。 | `nca-aboutcoffee` |
| claim.freshness.nca-storage-enemies | NCA 归纳储存的四大敌人：**空气、湿气、热、光**；建议：取出零售包装改用**密封容器**、使用**不透明**容器、置于**阴凉避光**处、**即磨即冲**。 | `nca-aboutcoffee` |
| claim.freshness.nca-peak-decline-stale | NCA：新鲜度峰值之后，多数烘焙豆**并不会变得不安全**（除非受潮霉变），但品质会持续下降——香气明显流失、颜色变浅、冲煮后风味不足、口感陈化（stale）。 | `nca-aboutcoffee` |
| claim.freshness.nca-freeze-divergent | NCA：**冷冻/冷藏存在分歧观点**；咖啡吸湿且吸附异味（hygroscopic），家用容器仍会透入少量氧气；若冷冻须真正密封，并按周取用避免冷凝。 | `nca-aboutcoffee` |
| claim.freshness.nca-duration-table | NCA 保鲜期参考（**密封容器前提下，取决于形态、包装与储存方式**）：烘焙豆室温 1–3 周、冷藏 2 周、冷冻 3–4 个月、研磨粉 1–2 周；未开封包装至 best-by 日期。 | `nca-aboutcoffee` |

## Variables

| 变量 | 影响 | 依据 |
|---|---|---|
| 烘焙度 | 深烘排气更快、峰值更早；浅烘结构致密、峰值更晚 | `fellow-brew-talks`（5–7 天 vs 4–6 周） |
| 处理法 | 实验处理（co-ferment 等）可能需更长养豆 | `fellow-brew-talks` |
| 包装（单向阀/密封） | 影响排气与氧化速率 | 需补证 |
| 研磨（整豆 vs 粉） | 粉状表面积大，劣化更快 | 需补证 |
| 储存条件（光/温/氧/湿） | 影响香气流失 | 需补证 |

## Practical Guidance

- 五段时间概念的区分（本知识库操作定义，用于产品 UI 文案）：
  - **Roast Date**：烘焙日期（客观）。
  - **Open Date**：开封日期（客观）。
  - **Best Before**：厂商/渠道标注（商业承诺，非科学结论）。
  - **Peak Flavor Window**：个人化区间，应由**用户自己的评分记录**推断（这正是 BrewPhase 的 `PhaseRuleBook` 机制）。
  - **Practical Drinkability**：仍可接受饮用的范围。
- 不要向用户断言「第 X 天最好」。产品应用用户数据走。

## Exceptions / Limitations

- 本轮**未取得** SCA Freshness Handbook 的正文（付费），故不写入其具体结论。
- 排气速率的定量描述、包装材料对氧化的定量影响**均未核验**，见 REVIEW_QUEUE（P1）。

## Applicability

`generic`, `specific_roast`, `specific_bean`

## Evidence Type

`standard`（Tier 1，书目）+ `manufacturer`（Tier 2，配方备注）+ `research`（Tier 1）

## Source

`sca-digital-store`、`ucdavis-coffee-center`、`fellow-brew-talks`

## License

`proprietary-paywalled`（SCA Freshness Handbook 未复制正文）、`see-source-terms`。

## Last Verified

2026-09-30
