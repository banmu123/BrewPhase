# 04 Coffee Processing — 处理法

> status: partial ｜ authorityTier: 1 ｜ lastVerified: 2026-09-30 ｜ topic: processing

## Summary

处理法（post-harvest processing）是从咖啡果实到干燥种子的转化过程。CQI 的 **Post-Harvest Processing（PHP）** 教育体系把这一环节视为**可以决定商业咖与精品咖分野**的关键：良好实践能保住品质与食品安全，进阶技术则用来**定向创造风味**。核心方法族包括：natural、honey / pulped natural、washed、wet hulled（Giling Basah），以及发酵方向（anoxic / anaerobic、carbonic maceration、接种酵母/细菌等）。

> **写法红线（规格 §04）：** 处理法**本身**与**市场营销叙述**必须分开。不得写「某处理法必然产生某风味」。

## Facts

| claim id | 事实 | sourceId |
|---|---|---|
| claim.processing.php-importance | PHP 是「从果实到待烘种子」的转化；基础实践可决定咖啡属于商业级还是精品级。 | `cqi-php` |
| claim.processing.php-flavor-creation | 进阶处理技术可用于**定向创造特定风味**、提升品质并形成差异化产品组合。 | `cqi-php` |
| claim.processing.php-scientific | CQI 的处理教育强调**理解关键理论、降低风险、建立标准作业程序**，并以科学+实践方法进行。 | `cqi-php` |
| claim.processing.course-coverage | CQI 处理课程覆盖 natural、honey、washed、wet hulled 及发酵。 | `cqi-home`、`cqi-php` |
| claim.processing.fermentation-chemistry | 入门级 Q Processing 课程内容含**发酵化学**与标准处理法导论。 | `cqi-q-grader-faq`（课程描述） |
| claim.processing.food-safety | PHP 的潜在价值包含**保住品质与食品安全**。 | `cqi-php` |
| claim.processing.robusta-wet-process | Robusta 目录的构建者包括 CCRI（印度）、ICCRI（印尼）、EMBRAPA（巴西）、NaCORI（乌干达）、WASI 等研究机构，说明处理与品种研究在产咖国并行推进。 | `wcr-varieties-catalog-fields` |

## Variables

| 变量 | 影响方向 | 说明 |
|---|---|---|
| 果肉/果胶去除程度 | 从 natural（全果）到 washed（去净） | 决定发酵基质多少 |
| 发酵环境（有氧/无氧） | 影响微生物群落与代谢路径 | anaerobic / carbonic maceration 属无氧方向 |
| 是否接种 | 接种酵母/细菌 vs 自然发酵 | 用于增加可重复性 |
| 干燥方式与时长 | 影响水分活度、缺陷风险 | 见 `green-coffee/` |
| 温度 | 影响发酵速率 | 与时间耦合 |

## Practical Guidance

- 面向用户的解释应写成「处理法 → **在常见条件下**常与某类感官描述相关联」，并**同时**说明：产地、品种、烘焙、冲煮都会介入。
- 对市场的「实验性处理法」叙述（如 co-fermentation、thermal shock）应标注为**产业实践/营销叙述**，`evidenceType = professional_practice`，不是科学事实。

## Exceptions / Limitations

- CQI 课程正文为**付费/受限内容**，本文档只确立**方法族清单、教育体系的立场与覆盖范围**。
- 各处理法的**定义、关键变量、典型感官关联**需要后续基于 CQI 公开材料逐条补证。见 REVIEW_QUEUE（P2）。
- 「湿刨法（wet hulled / Giling Basah）」在本轮来源中由 CQI 课程覆盖描述确认，但具体工艺细节未取得公开可引用材料。

## Applicability

`generic`, `specific_region`

## Evidence Type

`standard`（Tier 1，CQI 教育体系）

## Source

`cqi-home`、`cqi-php`、`cqi-q-grader-faq`、`wcr-varieties-catalog-fields`

## License

CQI 材料 `see-source-terms`。本文档为教育体系与事实性摘要的独立改写。

## Last Verified

2026-09-30
