# 35 Cold Brew — 冷萃

> status: filled ｜ authorityTier: 1 ｜ lastVerified: 2026-09-30 ｜ topic: cold-brew

## Summary

冷萃＝低温长时间浸泡（immersion）。**本领域有清晰的科研结论可直接引用**（UC Davis 2025，Scientific Reports）：在全浸泡条件下，**烘焙度 > 温度 > 时间**是感官差异的影响力排序。

> 这是一条罕见的「研究直接给出变量权重」的知识点，价值高，但**必须带实验限制**。

## Facts

| claim id | 事实 | sourceId |
|---|---|---|
| claim.coldbrew.roast-dominant | UC Davis 研究：全浸泡冷萃样品中，**烘焙度是感官差异的首要驱动**，其次是温度，再次是较长浸泡时间（在 TDS 趋于平台之后）。 | `ucdavis-coldbrew-2025` |
| claim.coldbrew.time-least | 研究明确：与烘焙度和温度相比，**冲煮时间**在造成感官差异上是**最不显著的因子**。 | `ucdavis-coldbrew-2025` |
| claim.coldbrew.8h-vs-24h | 研究提示：**8 小时**的冷/室温萃取可能提供与常用 **24 小时**相近的风味与感官品质（在其实验条件下）。 | `ucdavis-coldbrew-2025` |
| claim.coldbrew.temperatures | 实验设置：三种温度 **4 / 22 / 92°C**，五种时间间隔；烘焙度用 Agtron **41.8（浅）与 71.8（中深）**；豆源为萨尔瓦多与尼加拉瓜 Arabica。 | `ucdavis-coldbrew-2025` |
| claim.coldbrew.tds-equilibrium | 实验覆盖「快速冷却的热萃」到「浸泡至 TDS 达到平衡」的范围，说明**TDS 平衡**是冷萃的操作边界概念。 | `ucdavis-coldbrew-2025` |
| claim.coldbrew.served-temp | 感官评价时咖啡以约 **6°C** 呈送（品评过程中升至约 12°C）。 | `ucdavis-coldbrew-2025` |
| claim.coldbrew.roast-x-temp-interaction | 交互效应：**深烘**在冰箱/室温萃取中「苦与焦」随时间变化显著，热萃中相对稳定；**浅烘**的「酸与柑橘」在低温萃取中差异更明显。 | `ucdavis-coldbrew-2025` |
| claim.coldbrew.hario-mizudashi | Hario Mizudashi 官方配方：中细研磨，**70–80g / 1150mL、8–10 小时**冷藏；建议 **2–3 天内**用完。 | `hario-recipe-cards` |
| claim.coldbrew.food-safety-research | UC Davis Coffee Center 明确把「**食品安全（尤其 cold brew）**」列为研究方向。 | `ucdavis-coffee-center` |
| claim.coldbrew.bh-immersion | Barista Hustle 的 Immersion 课程覆盖 cold brew（主题级）。 | `barista-hustle` |

## Variables

| 变量 | 影响排序 | 依据 |
|---|---|---|
| 烘焙度 | **第 1** | `ucdavis-coldbrew-2025` |
| 温度（4/22/92°C） | 第 2 | 同上 |
| 时间 | 第 3（TDS 平台后更弱） | 同上 |
| 比例 | 未量化 | Hario 给 70–80g/1150mL（约 1:14–1:16） |
| 研磨 | 未量化 | Hario 用中细 |
| 过滤方式 | 未核验（Hario 用细网滤） | — |

## Practical Guidance

- 面向用户：**优先调烘焙度与温度**，不要在时间上过度投入（研究支持）。
- 常见做法：做浓缩液再稀释；密封冷藏保存（Hario 建议 2–3 天）。
- 食品安全：冷藏储存、注意保存期——引用 `ucdavis-coffee-center` 指向的研究方向，不自行给微生物阈值。

## Exceptions / Limitations

- 研究结论**限定于其实验设计**（特定豆源、Agtron 值、温度与时间点），**不可外推**为「所有冷萃都是 8 小时」。
- 冷萃的**食品安全具体参数（温度/时长/微生物）未核验** → REVIEW_QUEUE（P0/P1，食品安全优先级高）。

## Applicability

`immersion`, `generic`

## Evidence Type

`research`（Tier 1）+ `manufacturer`（Tier 2）

## Source

`ucdavis-coldbrew-2025`、`ucdavis-coffee-center`、`hario-recipe-cards`、`barista-hustle`

## License

`see-source-terms`。独立改写。

## Last Verified

2026-09-30
