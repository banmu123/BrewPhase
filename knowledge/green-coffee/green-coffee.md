# 06 Green Coffee — 生豆

> status: partial ｜ authorityTier: 1 ｜ lastVerified: 2026-09-30 ｜ topic: green-coffee

## Summary

生豆（green coffee）是从果实处理、干燥后、尚未烘焙的种子。SCA 正在制定的 **SCA-110「Green Coffee: Grading, Specifications, and Test Methods (for the Purpose of Trading)」** 说明了这一领域的标准化对象：分级、规格与测试方法。分类（classification）与分级（grading）需要同时看**物理指标**（缺陷、粒径/筛网、水分、密度）与**感官指标**（杯测）。

## Facts

| claim id | 事实 | sourceId |
|---|---|---|
| claim.green.sca-110 | SCA-110（Green Coffee: Grading, Specifications, and Test Methods）处于**制定中**（Standards in Development），尚未发布。 | `sca-coffee-standards` |
| claim.green.sca-biology-glossary | SCA 提供《Coffee Biology Field Glossary 2018》（付费数字产品，$35）。 | `sca-digital-store` |
| claim.green.defects-research | UC Davis Coffee Center 与 Coffee Science Foundation 合作研究**绿咖啡物理缺陷如何影响风味**，目标是为缺陷识别建立**感官阈值**，以改进分级标准。 | `ucdavis-research-index` |
| claim.green.cqi-q-scope | CQI 的 Q 课程考核包含**绿咖啡缺陷识别**（green coffee defect identification）与绿/熟豆分级。 | `cqi-q-grader-faq` |
| claim.green.warehouse | NCA 的描述：采收后绿咖啡经干燥、仓储、跨洋运输到港口（历史上纽约港是重要绿咖啡进口中心）。 | `nca-aboutcoffee` |

## Variables

| 变量 | 说明 | 状态 |
|---|---|---|
| moisture / water activity | 影响储存与安全 | 需补证（见 REVIEW_QUEUE） |
| density | 与烘焙、品种、海拔相关 | 需补证 |
| screen size | 粒径分级 | SCA-110 制定中 |
| defects | 物理缺陷 → 风味影响有**研究阈值** | `ucdavis-research-index` |
| quakers | 未熟豆 | 需补证 |

## Practical Guidance

- 对用户：生豆知识主要用于解释「为什么同一品种会有不同批次品质」，以及缺陷（见 `defects/`）。
- 分级标准引用时**必须注明 SCA-110 尚在制定中**，不能说「SCA 生豆标准规定……」。

## Exceptions / Limitations

- 本轮**未取得** SCA 绿咖啡分级的具体数值（该标准未发布，且 SCA-910 之类分类资料为会员制）。
- 水分、密度、水分活度、仓储与运输的具体参数**均未核验**，不写入。

## Applicability

`generic`, `specific_region`

## Evidence Type

`standard`（Tier 1）+ `research`（Tier 1）

## Source

`sca-coffee-standards`、`sca-digital-store`、`ucdavis-research-index`、`cqi-q-grader-faq`、`nca-aboutcoffee`

## License

`see-source-terms` / `proprietary-paywalled`（SCA）。本文档为独立改写。

## Last Verified

2026-09-30
