# 13 Extraction Science — 萃取科学

> status: skeleton ｜ authorityTier: 1+3 ｜ lastVerified: 2026-09-30 ｜ topic: extraction

## Summary

萃取科学是 BrewPhase 的**核心科学层**：TDS、EY（extraction yield）、strength、diffusion、percolation、immersion、channeling 等。**本文件保持 skeleton**，因为本轮核验的来源只支持**主题框架**与**科学机构的存在**，不支持具体数值与机制公式。

> **红线（规格 §13）：** 必须避免「单一变量万能解释」。不得把「酸 = 萃取不足」「苦 = 萃取过度」写成因果定律。

## 已确立的骨架

| claim id | 事实 | sourceId | confidence |
|---|---|---|---|
| claim.extraction.bh-courses | Barista Hustle 有专门的萃取课程体系：**Percolation**（滤泡）、**Immersion**（浸泡）、**Advanced Coffee Making**（萃取与均匀度），说明萃取按**方式**与**深度**分层教学。 | `barista-hustle` | high |
| claim.extraction.bh-advanced-goal | Advanced Coffee Making 的教学目标是「更深入理解萃取与**均匀度（evenness）**」，并使用**咖啡折射仪（refractometer）**。 | `barista-hustle` | high |
| claim.extraction.ucdavis-brewing-chart | UC Davis Coffee Center 用多年数据**更新了沿用数十年的 Brewing Control Chart**，新版为「Sensory and Consumer Brewing Control Chart」，结合新咖啡科学与消费者研究、更易用。 | `ucdavis-research-index` | high |
| claim.extraction.tds-measured | UC Davis 的冷萃研究用 **TDS、titratable acidity、pH** 三类指标量化样品，说明 TDS 是行业标准测量量。 | `ucdavis-coldbrew-2025` | high |
| claim.extraction.channeling-vendor | Fellow 官方把「shot 风味发酸/咸/空洞」归入**研磨偏粗**一类处理路径，把「发苦/发涩」归入**研磨偏细**，是厂商层面的第一近似（非完整因果模型）。 | `fellow-espresso-basics` | medium |

## 计划覆盖（尚缺来源，见 REVIEW_QUEUE P1）

- solubles / diffusion 的机制描述
- percolation vs immersion vs erosion 的差异
- 接触时间、温度、颗粒尺寸、流速、搅动的定量关系
- bypass、channeling、均匀度的诊断方法
- 「为什么酸 / 涩 / 苦 / 淡 / 浓 / 干 / 空洞」的**多因**解释树

**建议补证来源：** UC Davis Coffee Center 论文与新版 Brewing Control Chart（`ucdavis-research-index`）、Barista Hustle Advanced Coffee Making / Percolation / Immersion（`barista-hustle`，需订阅）、SCA Coffee Brewing Handbook（`sca-digital-store`，付费）。

## 写法红线（强制）

| 禁止 | 允许 |
|---|---|
| 酸 = 萃取不足 | 酸感与萃取程度**相关**，但在某些豆子/烘焙/水温下高酸也可以是设计目标；需与其它证据一起判断 |
| 苦 = 萃取过度 | 苦感也受豆子本身（如 Robusta 比例、深烘）影响 |
| 单一变量决定结果 | 至少同时考虑 研磨 / 水温 / 比例 / 时间 / 搅动 / 器具 |

## Applicability

`generic`, `espresso`, `pour_over`, `immersion`

## Evidence Type

`research`（Tier 1）+ `expert_education`（Tier 3，主题级）

## Source

`ucdavis-research-index`、`ucdavis-coldbrew-2025`、`barista-hustle`、`fellow-espresso-basics`

## License

`see-source-terms` / `proprietary-paywalled`。未复制论文或课程正文。

## Last Verified

2026-09-30
