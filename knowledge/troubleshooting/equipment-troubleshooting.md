# 41 Equipment Troubleshooting — 设备故障

> status: filled ｜ authorityTier: 2 ｜ lastVerified: 2026-09-30 ｜ topic: troubleshooting

## Summary

**必须优先引用官方手册。** 本节把已核验的机型级故障条目集中列出（来自厂商资料原文口径的独立改写）。

## 咖啡机（已核验）

| symptom | 官方可能的检查项 | sourceId | 型号 |
|---|---|---|---|
| 咖啡不流出 | 水箱是否有水；滤网是否被**过细粉或过度填压**堵住；分水网是否需清洁 | `gaggia-classic-manual` | Gaggia Classic |
| 流速过快 | 粉太粗；未填压 | `gaggia-classic-manual` | Gaggia Classic |
| 泵噪音大 | 水箱无水；泵未引水 | `gaggia-classic-manual` | Gaggia Classic |
| 把手处漏水过多 | 把手未装好；冲煮头垫圈脏/磨损；把手边缘有粉 | `gaggia-classic-manual` | Gaggia Classic |
| 意式几乎无 crema | 粉太粗；未填压；豆太老/过干 | `gaggia-classic-manual` | Gaggia Classic |
| 意式太凉 | 机器未预热（6 分钟） | `gaggia-classic-manual` | Gaggia Classic |
| 奶泡不足 | 蒸汽嘴/进气孔堵塞；奶温过高 | `gaggia-classic-manual` | Gaggia Classic |
| 滴水盘快速积水 | De'Longhi 列出该 FAQ 条目 | `delonghi-bco430-support` | BCO430 |
| 冲煮头有蒸汽/烟 | De'Longhi 列出该 FAQ 条目 | `delonghi-bco430-support` | BCO430 |
| 咖啡出得太慢 | De'Longhi 列出该 FAQ 条目 | `delonghi-bco430-support` | BCO430 |
| 滴水盘快速充满 | Philips/Saeco 列出该故障项 | `philips-saeco-support` | Saeco 系列 |
| 咖啡出水太淡（watery） | Philips/Saeco 列出该故障项 | `philips-saeco-support` | Saeco 系列 |
| 水箱无水流出 | Philips/Saeco 列出该故障项 | `philips-saeco-support` | Saeco 系列 |
| 水温不够热 | Philips/Saeco 列出该故障项 | `philips-saeco-support` | Saeco 系列 |
| 不出咖啡 | Philips/Saeco 列出该故障项 | `philips-saeco-support` | Saeco 系列 |
| 机器有异响 | Philips/Saeco 列出该故障项 | `philips-saeco-support` | Saeco 系列 |
| 冲泡组件下方出现咖啡粉 | Philips/Saeco 列出该故障项 | `philips-saeco-support` | Saeco 系列 |
| 丢弃粉而不冲煮 | Philips/Saeco 列出该故障项 | `philips-saeco-support` | Saeco 系列 |
| 粉饼是湿的 | Philips/Saeco 列出该故障项 | `philips-saeco-support` | Saeco 系列 |
| 无法取出冲泡组件 | Philips/Saeco 列出该故障项 | `philips-saeco-support` | Saeco 系列 |
| 奶泡打不好 | Philips/Saeco 列出该故障项 | `philips-saeco-support` | Saeco 系列 |
| 机器不启动 | Philips/Saeco 列出该故障项 | `philips-saeco-support` | Saeco 系列 |
| 显示「清空渣盒」但实际为空 | Philips/Saeco 列出该故障项 | `philips-saeco-support` | Saeco 系列 |
| 屏幕上出现**错误码** | Philips/Saeco 有「I see an error code」条目 | `philips-saeco-support` | Saeco 系列 |
| 不磨豆 | Philips/Saeco 列出该故障项 | `philips-saeco-support` | Saeco 系列 |
| 冲泡系统无法从机身取出 | Philips/Saeco 列出该故障项 | `philips-saeco-support` | Saeco 系列 |

> 说明：上表把 Philips/Saeco 官方**故障项的标题**做了译写与归并——**没有**抓取其逐项解决步骤正文（未核验）。逐项解决方案见 REVIEW_QUEUE（P1）。

## 磨豆机（已核验）

| symptom | 官方信息 | sourceId |
|---|---|---|
| 清洁不足 | 属**保修除外**情形 | `baratza-documents` |
| 想定位具体零件 | 用官方**部件爆炸图**（每型号提供） | `baratza-documents` |
| 「设定 18 卡豆/堵」类问题 | 存在于社区/支持 Q&A（**anecdotal**，不可作为事实） | `baratza-documents`（页面含 Q&A 模块） |

## 其它部件的维护性事实

| 部件 | 事实 | sourceId |
|---|---|---|
| 泵压 | Rancilio Silvia 手册有「调整泵压」章节 → 泵压可调、需维护 | `rancilio-silvia-manual` |
| 安全温控 | Silvia 手册有「安全温控复位」章节 | `rancilio-silvia-manual` |
| 分水网 | 应定期拧下清洁 | `gaggia-classic-manual` |
| 冲煮头垫圈 | 需清洁，磨损需更换 | `gaggia-classic-manual` |
| 水滤芯 | 按周期更换（Sage：3 个月/40L） | `sage-bes875-ug-i23` |

## Practical Guidance

- **一律以「该型号官方手册」为第一引用**；无官方资料的机型，回「建议联系授权服务」。
- 涉及拆机/带电/带压 → 见 `safety/safety.md`，标记专业服务。

## Exceptions / Limitations

- **错误代码（error codes）的逐机型含义未核验** → REVIEW_QUEUE（P0，与安全相关）。
- Nespresso 的「闪烁灯模式」官方文档被第三方描述为「记录薄弱且因机型而异」，本知识库不转录第三方推测。

## Applicability

`specific_model`, `specific_brand`

## Evidence Type

`manufacturer`（Tier 2）

## Source

`gaggia-classic-manual`、`delonghi-bco430-support`、`philips-saeco-support`、`baratza-documents`、`rancilio-silvia-manual`、`sage-bes875-ug-i23`

## License

`proprietary-free`。独立改写。

## Last Verified

2026-09-30
