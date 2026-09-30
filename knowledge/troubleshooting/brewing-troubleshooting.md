# 40 Brewing Troubleshooting — 冲煮故障树

> status: filled ｜ authorityTier: 2 ｜ lastVerified: 2026-09-30 ｜ topic: troubleshooting

## Summary

统一故障树（规格 §40）。每个现象输出 `symptoms / possible causes / supporting evidence / tests / adjustments` 并**标记 confidence**。

本知识库只写入**有来源的**因果边；未核验的因果边标注为待补证，不猜。

## 已核验的因果边

| symptom | possible cause | 证据/测试 | adjustment | confidence | source |
|---|---|---|---|---|---|
| 手冲**太淡** | 研磨偏粗 | 流速/滴滤速度观察 | 磨细 | high（官方） | `hario-v60-expert-guide` |
| 手冲**水流过慢** | 研磨偏细 | 观察 | 磨粗 | high（官方） | `hario-v60-expert-guide` |
| 意式**流太快** | 研磨偏粗 | shot time | 磨细 | high（官方） | `fellow-espresso-basics`、`lamarzocco-linea-micra-zh` |
| 意式**流太慢** | 研磨偏细 | shot time | 磨粗 | high（官方） | `fellow-espresso-basics` |
| 意式**发酸/咸/空洞** | 研磨偏粗 | 味觉 + 流速 | 磨细 | medium（厂商近似） | `fellow-espresso-basics` |
| 意式**发苦/发涩** | 研磨偏细 | 味觉 + 流速 | 磨粗 | medium（厂商近似） | `fellow-espresso-basics` |
| 意式**太凉** | 机器未预热 | 时间 | 充分预热（Gaggia 给 6 分钟） | high（官方） | `gaggia-classic-manual` |
| 意式**几乎无 crema** | 粉太粗 / 未填压 / 豆太老过干 | 对照更换豆子 | 调研磨填压、换新豆 | medium（官方列举） | `gaggia-classic-manual` |
| 咖啡**不流出** | 滤网堵塞（粉太细/压太紧）/ 分水网需清洁 / 水箱无水 | 逐项排除 | 清洁 + 调研磨 | high（官方） | `gaggia-classic-manual` |
| 冷萃**风味不足** | 误以为时间不足；实际**烘焙度与温度更关键** | 对照实验 | 优先调烘焙度/温度，而非无限延长浸泡 | medium（研究报告） | `ucdavis-coldbrew-2025` |

## 待补证的因果边（**不写结论**，见 REVIEW_QUEUE）

| symptom | 未决问题 |
|---|---|
| too dry / too hollow / too astringent / too muddy / too flat / too thin / too harsh / too vegetal / too fermented | 各自的**多因**解释与判别测试 |
| channeling / spraying / uneven extraction | 诊断方法（WDT、无底把手、puck screen 的实际效果） |

## 统一框架（供后续填充）

```text
symptom
  ├── cause A（来源？confidence？）
  ├── cause B
  └── cause C
        ↓ test（一次只改一个变量）
        ↓ evidence（味觉 + 时间/流速 + 对照）
        ↓ adjustment
        ↓ risk（连续改多项 → 无法归因）
```

## Practical Guidance

- 对用户：先问「用的什么器具、什么豆、什么参数」，再给**排序后的可能原因**，而不是单一答案。
- 强调「一次只改一个变量」——这是跨来源的通用共识。

## Exceptions / Limitations

- 本表**故意留空**大半，因为规格禁止「单一变量万能解释」，而本轮来源只能支撑研磨相关与少数官方列举。
- 「酸=萃取不足」类强因果**不写入**（见 `extraction/extraction-science.md` 红线）。

## Applicability

`generic`, `pour_over`, `espresso`, `immersion`

## Evidence Type

`manufacturer`（Tier 2）+ `research`（Tier 1）

## Source

`hario-v60-expert-guide`、`fellow-espresso-basics`、`lamarzocco-linea-micra-zh`、`gaggia-classic-manual`、`ucdavis-coldbrew-2025`

## License

`proprietary-free`。独立改写。

## Last Verified

2026-09-30
