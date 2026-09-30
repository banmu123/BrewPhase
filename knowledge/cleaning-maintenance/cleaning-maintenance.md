# 42 Cleaning & Maintenance — 清洁与维护

> status: filled ｜ authorityTier: 2 ｜ lastVerified: 2026-09-30 ｜ topic: cleaning-maintenance

## Summary

**这是本知识库最重要的一条纪律（规格 §42）：禁止生成「通用咖啡机清洁/除垢周期」然后套所有品牌。** 必须区分 **Generic Recommendation** 与 **Manufacturer-specific Instruction**。

已核验的各品牌官方周期如下——**它们彼此不同，这本身就是结论**。

## 各品牌官方周期（已核验）

| 品牌 / 型号 | 官方周期 | 关键约束 | sourceId |
|---|---|---|---|
| Sage Barista Express BES875 | 水滤芯 **每 3 个月或 40L**（硬度 4；硬度 2 可 60L）；除垢 **硬度 4 → 90 天 / 硬度 6 → 60 天** | 除垢时取出水滤芯；**不要用瓶装水**；机器不会自动提醒除垢 | `sage-bes875-ug-i23` |
| Sage BES875 清洗循环 | CLEAN ME 灯亮时执行 backflush，约 **5 分钟** | 清洗循环与除垢**是两件事** | `sage-bes875-ug-i23` |
| Gaggia Classic | **每 2 个月**除垢 | **只用 GAGGIA 除垢剂；绝不用醋** | `gaggia-classic-manual` |
| Nespresso（Original/Vertuo） | **每 600 粒或每 6 个月**（按水硬度与饮用量调整）；Vertuo 建议**每周清洁一次** | 两系统除垢与引水流程完全不同 | `nespresso-faq` |
| Philips/Saeco（AquaClean 机型） | 用 AquaClean 滤芯时「**最长 5000 杯不需除垢**」；需给冲泡组件**润滑** | 需用专用除垢剂 CA6700/47 | `philips-saeco-support` |
| JURA | 按型号提供**除垢 / 换滤芯 / 清洗机身 / 清洗奶路**四份独立分步说明 | 逐型号文档 | `jura-product-support` |
| De'Longhi | 未给统一周期；按机型页的 FAQ 与手册 | 逐型号 | `delonghi-support` |
| La Marzocco | 按型号提供**预防性维护**文档（如 GS3 6 Month / 1 Year、Linea Micra Preventative Maintenance） | 逐型号 | `lamarzocco-home-service` |
| Rancilio Silvia | 手册含**日常清洁**与**蒸汽棒日常清洁**章节 | 逐型号 | `rancilio-silvia-manual` |
| Baratza（磨豆机） | 清洁不足是**保修除外**情形；每型号有部件爆炸图 | 磨豆机维度 | `baratza-documents` |

## 通用建议（`generic`，低风险，仅此几条）

| claim id | 建议 | 依据 |
|---|---|---|
| claim.cleaning.no-universal-cycle | **不存在通用除垢周期**；必须查该型号手册。 | 上表各来源 |
| claim.cleaning.follow-manual | 清洁/除垢用**厂商指定**产品；不确定时以手册为准。 | `gaggia-classic-manual`（禁醋）、`sage-bes875-ug-i23`（禁瓶装水） |
| claim.cleaning.cleaning-vs-descaling | **清洗（backflush）与除垢是两件事**，周期与耗材不同。 | `sage-bes875-ug-i23` |
| claim.cleaning.parts-diagram | 磨豆机维护可用官方部件爆炸图定位零件。 | `baratza-documents` |

## Practical Guidance

- 产品 UI：用户问「怎么清洁」时，若已知机型 → 直接给**该型号**步骤；若未知 → 先问机型，**不要**给通用周期。
- 优先级（§59）：`specific_model` > `specific_brand` > `generic espresso cleaning` > 第三方 > 社区。

## Exceptions / Limitations

- 除垢剂成分、浓度、冲洗次数的**逐型号细节**未全部抓取（Gaggia 给出 4 次水箱冲洗与 20 分钟浸泡，Sage 给出 ~25s/13s/8s 分段除垢）。
- 蒸汽棒/奶路的清洗周期除 JURA 与 Nespresso 外未核验。

## Applicability

`specific_model`, `specific_brand`, `generic`

## Evidence Type

`manufacturer`（Tier 2）

## Source

`sage-bes875-ug-i23`、`gaggia-classic-manual`、`nespresso-faq`、`philips-saeco-support`、`jura-product-support`、`delonghi-support`、`lamarzocco-home-service`、`rancilio-silvia-manual`、`baratza-documents`

## License

`proprietary-free`。独立改写，未复制手册步骤全文。

## Last Verified

2026-09-30
