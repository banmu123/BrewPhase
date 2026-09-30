# 21–22 Espresso Machine Architecture & Types — 咖啡机架构与类型

> status: partial ｜ authorityTier: 2 ｜ lastVerified: 2026-09-30 ｜ topic: espresso-machines

## Summary

咖啡机知识必须做到 **Brand → Product Line → Model → Generation → Exact Manual**（规格 §24）。本文档确立**架构词汇**与**已核验机型实例**，其余型号待逐条补录。

## 架构词汇表（规格 §21 清单）与核验状态

| 部件 / 概念 | 已核验依据 | 状态 |
|---|---|---|
| 热交换锅炉（HX） | Rancilio Silvia：0.3L 黄铜 HX 锅炉 | ✅ `rancilio-silvia-product` |
| 内置水箱 / 外接水源 | Silvia 2L 内置水箱；Linea Micra 2.5L 水箱（plumbing 可选） | ✅ |
| 商用冲煮头（group head） | Silvia 商用黄铜冲煮头 | ✅ |
| 可调泵压 | Silvia 手册含「调整泵压」章节 | ✅ `rancilio-silvia-manual` |
| 安全温控（safety thermostat） | Silvia 手册含「安全温控复位」 | ✅ `rancilio-silvia-manual` |
| 拨杆 + 电子预浸泡 | Linea Mini | ✅ `lamarzocco-linea-mini-manual` |
| PID / 温度轮 | Linea Mini：stepped temperature wheel | ✅（产品页） |
| 双锅炉 | Linea Mini：dual boilers | ✅ `lamarzocco-linea-mini-manual` |
| 分水网 / shower screen | Gaggia 手册：需定期拧下清洁 | ✅ `gaggia-classic-manual` |
| 冲煮头垫圈 | Gaggia 手册：冲煮头内垫圈需清洁/更换 | ✅ |
| 蒸汽嘴 / 进气孔 | Gaggia：蒸汽嘴与进气孔需保持畅通 | ✅ |
| 滴水盘 / drip tray | Gaggia：取下用温皂水清洗 | ✅ |
| OPV / 电磁阀 / 旋转泵 / 振动泵 / 流量控制 | 未核验 | ❌ REVIEW_QUEUE |

## 已核验机型实例

| 品牌 | 型号 | 类型要点 | 来源 |
|---|---|---|---|
| Rancilio | Silvia | 单锅炉 + HX、0.3L 黄铜锅炉、2L 水箱、58mm、可调泵压、安全温控 | `rancilio-silvia-product`、`rancilio-silvia-manual` |
| La Marzocco | Linea Mini | 双锅炉、集成冲煮头、拨杆 + 电子预浸泡、PID 温度轮、66 lbs | `lamarzocco-linea-mini-manual`、`lamarzocco-linea-mini-manual` |
| La Marzocco | Linea Micra | 家用、2.5L 水箱、配 14/17/21g 滤杯 | `lamarzocco-linea-micra-zh` |
| Gaggia | Classic (2019) | 手动意式、可换分水网、蒸汽嘴 | `gaggia-classic-manual` |
| Sage/Breville | Barista Express BES875 | 一体机（含锥刀磨豆机）、CLEAN ME 提示、可编程温度模式 | `sage-bes875-ug-i23` |
| Fellow | Series 1 | 意式机，触摸屏 profile、可调 preinfusion/pressure | `fellow-brew-talks` |
| De'Longhi | BCO430 / EAM3200 | 组合机与超级自动 | `delonghi-bco430-support` |
| JURA | E8 / J8 twin / C9 / X8 | 超级自动，J.O.E. App | `jura-product-support` |
| Philips/Saeco | Xelsis / Incanto / Intelia / Syntia | 超级自动，AquaClean | `philips-saeco-support` |
| Nespresso | Original / Vertuo | 胶囊系统两大系列 | `nespresso-faq` |

## 类型覆盖状态（规格 §22）

| 类型 | 状态 |
|---|---|
| Manual Lever | ❌ 未核验（La Marzocco Leva 仅见文档条目） |
| Semi-Automatic | ✅（Linea Mini/Micra、Silvia、Gaggia Classic） |
| Automatic / Super-Automatic | ✅（JURA、Saeco、De'Longhi） |
| Capsule | ✅（Nespresso Original/Vertuo） |
| Single Boiler | ✅（Silvia 单锅炉 + HX） |
| Heat Exchanger | ✅ |
| Dual Boiler | ✅（Linea Mini） |
| Thermoblock / Thermocoil | ❌ 未核验 |
| Commercial / Home / Portable | 部分（Home ✅；Commercial 见 La Marzocco Strada 条目；Portable ❌） |

## Practical Guidance

- **不要生成品牌级知识**（规格 §24）：「某品牌所有咖啡机都这么清洁」**通常不成立**。每条设备知识必须绑定型号。
- 品牌命名差异必须记录：**Breville（澳/美）= Sage（欧）**。这直接影响用户按型号搜索。

## Exceptions / Limitations

- OPV、PID 参数、流量控制、旋转泵 vs 振动泵等在本轮**无来源**，不写入。
- 各类型（manual lever / thermoblock）的官方定义需补证。

## Applicability

`specific_model`, `specific_brand`, `espresso`

## Evidence Type

`manufacturer`（Tier 2）

## Source

见上表各行。

## License

`proprietary-free`。独立改写。

## Last Verified

2026-09-30
