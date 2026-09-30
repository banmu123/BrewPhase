# 12 Coffee Water — 咖啡水

> status: partial ｜ authorityTier: 1+2 ｜ lastVerified: 2026-09-30 ｜ topic: water

## Summary

**必须区分两个问题**（规格 §12 的核心）：

1. **Water for taste** —— 水里的矿物质如何影响萃取与风味。
2. **Water for machine safety** —— 水的硬度与氯如何影响锅炉、管路、密封件（结垢、腐蚀）。

两者目标不同、甚至可能冲突（例如追求风味所需的矿物质，与防结垢所需的软水）。

## Facts

| claim id | 事实 | sourceId |
|---|---|---|
| claim.water.sca-handbook | SCA 出版《The 2018 SCA Water Quality Handbook》（付费，$45），水是标准机构认可的标准领域。 | `sca-digital-store` |
| claim.water.bh-course | Barista Hustle 的 **The Water Course**（45 课）专门讲水化学，并明确以「诊断与预防咖啡设备的水垢与腐蚀」为目标。 | `barista-hustle` |
| claim.water.scale-mechanism | 厂商一致口径：硬水会在设备内部形成**矿物结垢**，降低冲煮流量、冲煮温度、机器功率与意式风味（Sage 明文）。 | `sage-bes875-ug-i23` |
| claim.water.sage-filter-interval | Sage：水滤芯每 **3 个月或 40L**（基于硬度等级 4；等级 2 可延至 60L）。 | `sage-bes875-ug-i23` |
| claim.water.sage-descale-thresholds | Sage：建议硬度等级 4 时每 **90 天**除垢、等级 6 时每 **60 天**。 | `sage-bes875-ug-i23` |
| claim.water.sage-no-bottled | Sage 明确：**除垢时不要用瓶装水**（多数瓶装水含溶解固体，会留下沉积）。 | `sage-bes875-ug-i23` |
| claim.water.sage-no-distilled | Sage 明确：**不推荐高度过滤、去矿化或蒸馏水**，因为会影响咖啡风味与机器设计功能。 | `sage-bes875-ue-manual`（`sage-bes875-manual-en`） |
| claim.water.gaggia-vinegar-ban | Gaggia 明确：**绝不使用醋或其它除垢剂**，只用 GAGGIA 专用除垢产品。 | `gaggia-classic-manual` |
| claim.water.saeco-aquaclean | Philips/Saeco 的 AquaClean 滤芯宣称「**最长 5000 杯不需除垢**」，并称可「延长机器寿命 2 倍」「改善咖啡风味」。 | `philips-saeco-support` |
| claim.water.rancilio-filtration | Rancilio 支持口径建议：测试水的硬度与**氯离子**，并安装适当过滤（碳滤、离子交换或反渗透）以防结垢与腐蚀。 | `rancilio-silvia-manual`（支持口径） |
| claim.water.lamarzocco-quality-rule | La Marzocco 在开机程序中明确要求水箱注水「须依照 La Marzocco 规定水质」，并把「家用机器水质」单列为独立文章。 | `lamarzocco-linea-micra-zh` |

## Variables

| 变量 | 影响面 | 状态 |
|---|---|---|
| TDS | 总溶解固体 | 需补证（SCA Handbook 付费） |
| GH（总硬度，Ca/Mg） | 结垢 + 萃取 | 需补证 |
| KH（碳酸盐硬度/碱度） | 缓冲能力、结垢主因 | 需补证 |
| pH | 影响萃取与腐蚀 | 需补证 |
| 氯 / 氯离子 | 腐蚀风险（Rancilio 明确点名） | `rancilio-silvia-manual` |
| 温度 | 与萃取耦合 | 见 §13 |

## Practical Guidance

- 面向「我的机器怎么保养」：**永远给型号绑定的厂商说明**（见 `cleaning-maintenance/`、`espresso-machines/`）。
- 面向「水怎么调」：只能给方向性框架，并注明具体目标区间需引用 SCA Water Quality Handbook（付费）或按机器厂商要求。
- 一个反复出现的**厂商共识**（可作 generic 建议）：使用过滤水、定期更换滤芯、不要用蒸馏/去矿化水、除垢用专用产品。

## Exceptions / Limitations

- 具体的 TDS/GH/KH/pH 目标区间本轮**未核验**（SCA Handbook 付费，Barista Hustle 课程付费）→ 见 REVIEW_QUEUE（P1）。
- 「瓶装水 vs 自来水 vs 调配水」的对照结论未核验。

## Applicability

`generic`, `espresso`, `specific_model`

## Evidence Type

`standard`（Tier 1）+ `manufacturer`（Tier 2）+ `expert_education`（Tier 3）

## Source

`sca-digital-store`、`barista-hustle`、`sage-bes875-ug-i23`、`sage-bes875-manual-en`、`gaggia-classic-manual`、`philips-saeco-support`、`rancilio-silvia-manual`、`lamarzocco-linea-micra-zh`

## License

`proprietary-paywalled` / `proprietary-free` / `see-source-terms`。未复制 SCA 手册或课程正文。

## Last Verified

2026-09-30
