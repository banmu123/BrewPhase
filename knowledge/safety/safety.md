# 43 Safety — 安全

> status: filled ｜ authorityTier: 1+2 ｜ lastVerified: 2026-09-30 ｜ topic: safety

## Summary

安全是**优先级最高**的知识域。原则（规格 §43）：涉及拆机/带电/带压操作时，**必须标记 Professional Service Recommended**，不得指导用户进行可能导致触电、压力释放或设备损坏的拆解。

## Facts

| claim id | 事实 | sourceId |
|---|---|---|
| claim.safety.service-center | Sage 明确：**任何手册未列出的操作，都应在授权服务中心执行**；非清洁类维护须由授权服务中心进行。 | `sage-bes875-manual-en` |
| claim.safety.unplug-before-clean | Sage 明确：清洁/搬动/存放前须**关机、拔插头、待冷却**。 | `sage-bes875-manual-en` |
| claim.safety.no-portafilter-removal | Sage 明确：**冲煮过程中绝不可取下把手**，因机器处于带压状态。 | `sage-bes875-manual-en` |
| claim.safety.water-only | Sage 明确：除冷自来水外不要用其它液体；**不推荐高度过滤/去矿化/蒸馏水**。 | `sage-bes875-manual-en` |
| claim.safety.no-immerse | Sage 明确：**不得**把电源线、插头或整机浸入水或任何液体。 | `sage-bes875-manual-en` |
| claim.safety.water-tank-descale | Sage 明确：除垢过程中**不得**取下或完全清空水箱。 | `sage-bes875-ug-i23` |
| claim.safety.descale-steam-burn | Sage 明确：除垢时会释放**热蒸汽**，操作须小心烫伤。 | `sage-bes875-manual-en` |
| claim.safety.gaggia-user-limit | Gaggia 明确：**用户不应尝试其它任何维修**；结垢导致的故障不在保修范围内。 | `gaggia-classic-manual` |
| claim.safety.lamarzocco-safeguards | La Marzocco 在手册开头给出标准电器安全须知（勿触热表面、勿浸电气部件、儿童看护等）。 | `lamarzocco-linea-mini-manual` |
| claim.safety.aeropress-hot | AeroPress 官方安全提示：**热液体可致严重烫伤**；压出时须握稳奶缸与腔体，**勿用密封不良状态加压**（热水可能喷溅），勿压入易碎/窄容器。 | `aeropress-manual-inverted` |
| claim.safety.aeropress-no-bleach | AeroPress 明确清洁**不要用漂白剂等强化学品**。 | `aeropress-flow-control-recipes` |
| claim.safety.delonghi-no-vinegar-implied | （跨厂商一致方向）除垢只用**厂商指定**产品——Gaggia 明文禁醋；其它厂商均限定专用除垢剂。 | `gaggia-classic-manual`、`philips-saeco-support` |
| claim.safety.nca-children | 关于儿童咖啡因的安全建议须引用 FDA/NCA 等官方来源（见 `health/`），不由本知识库自行判定。 | `fda-caffeine` |

## 必须标记 Professional Service Recommended 的场景

- 拆开机器外壳 / 触碰锅炉与电气部件
- 泵压调整、安全温控复位（Silvia 手册有章节，但属**维护范畴**；面向普通用户的输出应提示专业服务）
- 压力系统维修
- 电路板、PID、电磁阀更换

## 食品安全（独立小节）

| claim id | 事实 | sourceId |
|---|---|---|
| claim.safety.food.coldbrew | 冷萃的食品安全是 UC Davis Coffee Center 的**研究方向之一（food safety issues, especially in cold brew）**。 | `ucdavis-coffee-center` |
| claim.safety.food.php | CQI 强调处理环节的食品安全价值。 | `cqi-php` |
| claim.safety.food.milk-path | 奶路需按厂商周期清洁（JURA 逐型号提供「清洁奶路」说明）。 | `jura-product-support` |

## Practical Guidance

- 任何涉及**加热、加压、带电、化学品**的回答，首先检查它是否在**该型号手册**里；不在手册里的，一律回「建议联系授权服务」。
- 除垢化学品的**稀释、接触时间、冲洗**必须按厂商说明，不得自创。

## Exceptions / Limitations

- 各型号码的**错误代码含义**未核验（REVIEW_QUEUE P0）。
- 「保修条款」类结论只在本文件引用厂商明文；具体保修范围须查该厂商条款页。

## Applicability

`specific_model`, `specific_brand`, `generic`

## Evidence Type

`manufacturer`（Tier 2）+ `standard`（Tier 1）

## Source

`sage-bes875-manual-en`、`sage-bes875-ug-i23`、`gaggia-classic-manual`、`lamarzocco-linea-mini-manual`、`aeropress-manual-inverted`、`aeropress-flow-control-recipes`、`philips-saeco-support`、`jura-product-support`、`ucdavis-coffee-center`、`cqi-php`、`fda-caffeine`

## License

`proprietary-free` / `see-source-terms`。独立改写。

## Last Verified

2026-09-30
