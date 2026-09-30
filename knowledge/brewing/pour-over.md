# 15–16 Pour Over & V60 — 手冲与 V60

> status: filled ｜ authorityTier: 2 ｜ lastVerified: 2026-09-30 ｜ topic: pour-over

## Summary

手冲（percolation）是**穿滤式**萃取：水持续穿过粉层。器具几何决定流速与通道倾向——锥形（V60）与平底（Kalita Wave）是两大族。Hario 官方资料是 V60 知识的**首选来源**。

> **红线（规格 §16）：** 不要假设所有 V60 配方效果相同。即便同一品牌，官方配方也因器具尺寸/材质/目标而异。

## Facts

| claim id | 事实 | sourceId |
|---|---|---|
| claim.pourover.v60-official-expert | Hario Expert 指南：15g / 250g、中细研磨、**约 92–96°C**、闷蒸约 30s、总时长约 **2.5 分钟**；滤纸需先用热水淋洗去纸味并预热。 | `hario-v60-expert-guide` |
| claim.pourover.v60-official-tuning | 官方给的调参方向：太淡 → 磨细；水通过太慢 → 磨粗。 | `hario-v60-expert-guide` |
| claim.pourover.v60-double | 做两人份时**成倍增加粉与水**，并重复注水流程、改用咖啡服务器。 | `hario-v60-expert-guide` |
| claim.pourover.v60-hoffmann-recipe | 署名专家配方（Hoffmann）：30g / 500mL 软水、**97°C**、闷蒸 60mL 至 45s；前 30s 注到总水量 60%、1:15 到 300mL；再 30s 内注完；末段做一次双方向小搅动与收尾摇晃让粉床平整。 | `hario-v60-hoffmann` |
| claim.pourover.kalita-geometry | Kalita Wave 为**平底 + 三孔**设计，配波纹滤纸形成空气层；官方指南强调「慢速螺旋注水」是关键。 | `stumptown-kalita-guide` |
| claim.pourover.kalita-forgiving | 因平底三孔与滤纸结构，Kalita Wave 对注水技术要求**低于**锥形单孔器具，适合家用。 | `stumptown-kalita-guide`（烘焙商表述，Tier 3） |
| claim.pourover.paper-rinse-universal | 跨来源共识：**冲洗滤纸**（去纸味 + 预热）是手冲通用步骤。 | `hario-v60-expert-guide`、`stumptown-kalita-guide` |
| claim.pourover.w60-hybrid | Hario W60 是「V60 螺旋肋 + 平底」混合设计，可用平底滤纸、纸滤或两者并用以三种方式冲煮。 | `hario-recipe-cards`（第三方托管官方配方卡） |

## 官方配方对照（同一品牌内部亦不同 → 支撑 conflict.v60.official-recipes-differ）

| 来源 | 器具 | 粉/水 | 水温 | 时间 | 等级 |
|---|---|---|---|---|---|
| `hario-v60-expert-guide` | V60 02 | 15g / 250g | 92–96°C | ≈2.5 min | Tier 2 |
| `hario-recipe-cards` | V60 | 18–20g / 300mL | 93°C | 2–3 min | Tier 2 |
| `hario-recipe-cards` | W60 | 20g / 330mL | 93°C | 4:20–4:45 | Tier 2 |
| `hario-v60-hoffmann` | V60 02 | 30g / 500mL | 97°C | ≈2:00–3:00 | Tier 3 |
| `stumptown-kalita-guide` | Kalita 185 | 21g / 345g | ≈205°F(96°C) | 2:45–3:00 | Tier 3 |

## 器具覆盖状态（规格 §15 清单）

| 器具 | 状态 |
|---|---|
| V60 | ✅ 有官方来源（Hario） |
| Kalita Wave | ⚠️ 无原厂来源，用烘焙商指南替代（`stumptown-kalita-guide`） |
| W60 / Mugen | ⚠️ 官方配方卡有（第三方托管） |
| Origami / Orea / Tricolate / April / Kono / Melitta / Bee House / Chemex / Clever | ❌ 未核验 → REVIEW_QUEUE |

## Practical Guidance

- 面向用户：先问「用哪个器具、哪支豆」，再给配方；把配方标为「来源 X 的起点」。
- 「不同滤纸/不同滤杯材料」的影响：本轮只确认了**纸 vs 金**属的取向差异，材料（塑料/陶瓷/玻璃）的具体影响未核验。

## Exceptions / Limitations

- Chemex、Origami 等未覆盖。
- 滤杯材料对温度的定量影响未核验。

## Applicability

`pour_over`, `specific_model`（V60 02 / Kalita 185）

## Evidence Type

`manufacturer`（Tier 2）+ `professional_practice`（Tier 3）

## Source

`hario-v60-expert-guide`、`hario-v60-hoffmann`、`stumptown-kalita-guide`、`hario-recipe-cards`

## License

`proprietary-free` / `see-source-terms`。独立改写。

## Last Verified

2026-09-30
