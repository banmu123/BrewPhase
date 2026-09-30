# 17–18 Immersion & AeroPress — 浸泡式与爱乐压

> status: filled ｜ authorityTier: 2 ｜ lastVerified: 2026-09-30 ｜ topic: immersion

## Summary

浸泡式（immersion）是**全浸泡**萃取：水与粉共同静置。AeroPress 是「浸泡 + 加压」的混合体，官方文档是**首选来源**（规格 §17/§18）。**型号必须区分**：AeroPress Original / Go / Clear / Premium 等。

## Facts

| claim id | 事实 | sourceId |
|---|---|---|
| claim.aeropress.official-temp | AeroPress 官方 how-to 基准水温 **185°F / 85°C**（并称若无温度计，烧开亦可）。 | `aeropress-how-to-use` |
| claim.aeropress.official-grind | 官方基准：中细研磨（`sample: Baratza Encore 11–13`）；粉量 12–14g「略少于一满勺」。 | `aeropress-how-to-use` |
| claim.aeropress.official-steps | 官方流程：注水到腔体 #3 刻度 → 轻搅 3 秒 → 插入压杆约 0.5 英寸并略微上提形成真空止漏 → 静置 30–60 秒 → 缓压至听到嘶声 → 弹饼。 | `aeropress-how-to-use` |
| claim.aeropress.paper-vs-metal | 官方说明：纸微滤消除细粉带来顺滑；压力萃取「减少苦味」；总时长约 1 分钟。 | `aeropress-how-to-use` |
| claim.aeropress.crema-recipe | 官方配方（Flow Control Cap + 纸滤 + 深烘细磨 15g、近沸水约 210°F/99°C、搅拌 20 次、1 分钟）：可做「类似 crema」。 | `aeropress-flow-control-recipes` |
| claim.aeropress.iced-recipe | 官方日式冰咖啡（金属滤）：20g 细磨、100ml / 92°C、搅 5s、1 分钟，兑 100g 冰。 | `aeropress-flow-control-recipes` |
| claim.aeropress.inverted-not-recommended | 官方说明书明确：**倒置法不被推荐**，原因是稳定性与倾覆风险（见 conflict.aeropress.inverted-method）。 | `aeropress-manual-inverted` |
| claim.aeropress.espresso-style | 官方旧版说明书给出 espresso 风格做法（1 勺细滴滤研磨、80°C、搅 10 秒）。 | `aeropress-manual-inverted` |
| claim.aeropress.cleaning | 官方：日常只需冲洗；深洁可用温和皂液或洗碗机上层；**不要用漂白剂等强化学品**。 | `aeropress-flow-control-recipes` |
| claim.aeropress.store-seal | 官方：存放时把压杆推到底或完全分离，避免长期压缩硅胶密封圈。 | `aeropress-manual-inverted` |
| claim.frenchpress.immersion-general | Barista Hustle 有专门的 **Immersion** 课程（70 课），覆盖 French press、AeroPress、syphon、cold brew、Ibrik，并研究「时间与研磨设置如何影响萃取速率」。 | `barista-hustle` |

## 型号区分（规格 §18）

| 型号 | 来源状态 |
|---|---|
| AeroPress Original | ✅ 官方 how-to 与说明书（`aeropress-how-to-use`、`aeropress-manual-inverted`） |
| AeroPress Go | ✅ 官方 how-to 含 Go Mug 描述 |
| AeroPress Clear | ✅ 官方 Flow Control 页提及 |
| AeroPress Premium / 其它 | ❌ 未核验 → REVIEW_QUEUE |

## Practical Guidance

- 面向用户：先确认型号；「官方基准」与「社区常用配方」分开呈现。
- French press / Clever / Switch / Siphon / cold brew immersion 的**逐器官方配方本轮未全部取得**，只有 Barista Hustle 的**主题级**覆盖。

## Exceptions / Limitations

- French Press、Clever、Switch、Siphon 的具体配方未核验（REVIEW_QUEUE P2）。
- 官方 80–85°C 与第三方更高水温之间是配方取向差异（见 conflict.aeropress.water-temperature）。

## Applicability

`immersion`, `specific_model`（AeroPress Original/Go/Clear）

## Evidence Type

`manufacturer`（Tier 2）+ `expert_education`（Tier 3，主题级）

## Source

`aeropress-how-to-use`、`aeropress-flow-control-recipes`、`aeropress-manual-inverted`、`barista-hustle`

## License

`proprietary-free`。独立改写，未复制说明书正文。

## Last Verified

2026-09-30
