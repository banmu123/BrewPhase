# 10–11 Grinding & Grinder Types — 研磨与磨豆机

> status: filled ｜ authorityTier: 2 ｜ lastVerified: 2026-09-30 ｜ topic: grinding / grinders

## Summary

研磨度是影响萃取**最直接**的变量：它决定水流穿过粉层的阻力与颗粒表面积。磨豆机类型（锥刀 conical / 平刀 flat、手摇 / 电动、单次投料 / 豆仓）决定**颗粒分布**，而分布往往比「研磨度数字」更重要。

> **红线（规格 §11）：** 不写「平刀一定比锥刀好」。两者是**设计取向差异**，各有用途。

## Facts

| claim id | 事实 | sourceId |
|---|---|---|
| claim.grinding.manual-not-recipe | Baratza 明确：**手册里不含针对具体冲煮方式的研磨刻度**，因为正确数值取决于你的豆子与器具。 | `baratza-documents` |
| claim.grinding.cleaning-warranty | 在 Baratza 的支持口径中，**清洁不足是明确的保修除外情形**（"lack of cleaning is a named warranty exclusion"）。 | `baratza-documents`（第三方汇总转述官方口径，见下） |
| claim.grinding.parts-diagram | Baratza 为每个在售磨豆机提供**操作手册 + 部件列表/爆炸图**，支持用户自行维护。 | `baratza-documents` |
| claim.grinding.aeropress-grind-ref | AeroPress 官方配方直接给出第三方磨豆机基准（"e.g. Baratza® Encore™ Setting of 11–13"），说明**刻度只有相对意义**。 | `aeropress-how-to-use` |
| claim.grinding.fellow-grind-reference | Fellow 的官方配方用自家磨豆机刻度标注（Ode + SSP、Ode Gen 2、Opus、Opus 2），并注明「每台磨豆机略有差异，仅作基准」。 | `fellow-brew-talks` |
| claim.grinder.comandante-burr | Comandante C40 Mk4 使用 **Nitro Blade® 七边形锥刀**（heptagonal conical burr），宣称是为精品咖啡专门开发。 | `comandante-official` |
| claim.grinder.comandante-beanjars | C40 Mk4 随附两个 40g Bean Jar（一玻璃、一聚合物），德国制造。 | `comandante-official` |
| claim.grinder.baratza-flat-vs-conical | Baratza 产品线同时提供锥刀（Encore/Sette/Virtuoso）与平刀（Forte BG 为 Flat Steel Burr 冲煮磨），说明两种刀型在同一品牌内并存、各有定位。 | `baratza-documents` |

## Variables

| 变量 | 方向（在其它条件不变时） | 备注 |
|---|---|---|
| 研磨度（细→粗） | 细：阻力大、接触时间倾向变长；粗：流速快 | 不等同于「细=过萃」，见 §13 |
| 颗粒分布 | 分布越窄通常越均匀 | fine/booulders 的双峰分布会导致同杯内酸苦并存 |
| 刀型（锥/平） | 影响分布形态与口感取向 | **不是优劣排序** |
| 刀盘尺寸 | 通常越大产能越高、热量分布越缓 | 需补证 |
| 转速 RPM | 影响热量与静电 | 需补证 |
| 校准 / 零点 | 决定刻度可复现性 | 需补证 |

## Practical Guidance

- 跨磨豆机比较时**不要直接换算刻度**。正确做法是「以萃取结果（时间/风味）为准反推」。
- 磨豆机常见维护项（本轮来源支持的部分）：清洁（Baratza 明文与保修挂钩）、部件更换（爆炸图可查件号）。
- 手摇磨（Comandante）与电动磨的差异主要在使用场景与颗粒分布，不在「谁更专业」。

## Exceptions / Limitations

- 静电、seasoning（磨合）、alignment（刀盘对齐）等**具体行为与定量影响本轮未核验**，见 REVIEW_QUEUE（P2）。
- Baratza 的「清洁与保修」条款来自**第三方汇总页转述**，建议后续在 baratza.com 官方保修条款页直接确认（已列 REVIEW_QUEUE）。

## Applicability

`generic`, `espresso`, `pour_over`, `specific_brand`（Baratza / Comandante / Fellow）

## Evidence Type

`manufacturer`（Tier 2）

## Source

`baratza-documents`、`comandante-official`、`aeropress-how-to-use`、`fellow-brew-talks`

## License

`proprietary-free`（厂商材料）。独立改写，未复制手册正文。

## Last Verified

2026-09-30
