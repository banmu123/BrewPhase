# 03 Coffee Varieties — 咖啡品种

> status: partial ｜ authorityTier: 1 ｜ lastVerified: 2026-09-30 ｜ topic: varieties

## Summary

WCR 的 **Coffee Varieties Catalog** 是全球首个开放获取的 Arabica + Robusta 品种汇编：**55 个 Arabica 品种 + 47 个 Robusta 品种**，以 20+ 个变量（期望产量、养分需求、最适海拔、抗病虫害、树形、豆型、血统等）描述每个品种。它是本领域**首选来源**（规格 §03）。

## Facts

| claim id | 事实 | sourceId |
|---|---|---|
| claim.varieties.catalog-scope | 目录覆盖 55 个 Arabica、47 个 Robusta 品种，来自多个产咖国。 | `wcr-varieties-catalog` |
| claim.varieties.fields | 每个品种按 20+ 变量描述：yield potential、stature、bean size、nutrition requirements、lineage、pest/disease susceptibility 等。 | `wcr-varieties-catalog-fields` |
| claim.varieties.no-absolute-data | WCR 明确：因环境/海拔/土壤/天气/树龄/管理影响巨大，**某些变量不可能给出绝对值**（如杯质、产量），故以参照品种（中美洲 Caturra、非洲 SL28）作相对比较。 | `wcr-varieties-catalog` |
| claim.varieties.robusta-pollination | Robusta 需要**多于一个品种且同时开花**才能成功授粉，因此农户通常需种植互补克隆组合。 | `wcr-varieties-catalog-fields` |
| claim.varieties.robusta-mix-transparency | Robusta 常以混合克隆形式分发，且对混合内容的透明度通常较低。 | `wcr-varieties-catalog-fields` |
| claim.varieties.robusta-cwd-gain | 抗咖啡枯萎病（CWD-r）的健康植株，乌干达农户可增收约 **250%**（对比易感病株）。 | `wcr-varieties-catalog-fields` |
| claim.varieties.living-document | 目录是 living document，会随新区域覆盖与新育种成果持续增长。 | `wcr-varieties-catalog` |
| claim.varieties.geisha-panama | 「Geisha (Panama)」在 WCR 目录中以地名限定列出，说明其市场身份与产地绑定。 | `wcr-varieties-catalog` |

## Variables

| 变量 | 说明 |
|---|---|
| species | Arabica / Robusta（目录不混编） |
| lineage / genetic background | WCR 以血统分组：Bourbon-Typica group、Catimor group、Introgressed w/ Congensis、Ethiopian landrace、F1 hybrid、Robusta 等 |
| yield potential | 相对值，需参照品种 |
| disease resistance | 如 leaf rust（叶锈）、coffee berry disease、CWD（Robusta） |
| optimal altitude | 相对值 |
| bean size / stature | 形态 |

**WCR 目录中出现的品种名（节选，用于实体识别）**：Typica、Bourbon、Caturra、Catuai、Mundo Novo、Maragogipe、Pacas、Villa Sarchi、SL14、SL28、SL34、Ruiru 11、Batian、K7、Geisha (Panama)、Java、Catimor 129、Catisic、Lempira、IHCAFE 90、Centroamericano、Marsellesa、Parainema、Pacamara、Maragogipe、Starmaya、Milenio、Oro Azteca、Costa Rica 95、RAB C15、Nemaya（*C. canephora*）等。

## Practical Guidance

- **品种 ≠ 产地。** BrewPhase 已有别名表识别「瑰夏 / 艺伎 / Gesha / geisha」。品种是独立字段（规格 §03）。
- 当用户填了品种但没填产地时，不要把品种当作产地推断风味。
- 品种知识在 UI 上只做**解释性**用途（「SL28 是肯尼亚代表性品种之一」），不做确定性风味承诺。

## Exceptions / Limitations

- **本轮未逐个抓取** WCR 目录中 102 个品种的完整字段表。本文档只确立**目录结构、字段维度、来源与许可**。
- 用户提示中提到的品种（Gesha、SL28、Pacamara、Castillo、Colombia、Laurina、Rume Sudan、Ethiopian landraces 等）已确认**在该目录的选单中出现**，但**逐品种的血统/抗病/海拔细节需后续逐条抓取并独立改写**。见 REVIEW_QUEUE。
- 不得从目录 PDF 复制表格（CC BY-NC-ND 禁止改动数据与商用）。

## Applicability

`specific_species`, `specific_region`, `generic`

## Evidence Type

`research`（Tier 1）

## Source

`wcr-varieties-catalog`、`wcr-varieties-catalog-fields`

## License

**CC BY-NC-ND 4.0**（目录 PDF 首页自述）。本文档为结构性与事实性独立改写；**未复制目录表格**。

## Last Verified

2026-09-30
