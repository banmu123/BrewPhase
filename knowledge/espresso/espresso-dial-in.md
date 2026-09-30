# 20 Espresso Dial-In — 意式调参与故障树

> status: filled ｜ authorityTier: 2 ｜ lastVerified: 2026-09-30 ｜ topic: espresso

## Summary

意式调参需要**故障树**而非单一答案（规格 §20）。最有价值的可核验素材来自**厂商官方故障排除口径**：Fellow Series 1 的官方快速指南直接给出了「现象 → 动作」映射，La Marzocco 与 Sage 也给出一致方向。

> **红线：** 每个问题输出 `symptom / possible causes / evidence / test / adjustment / risk`，不直接给唯一答案。

## 官方故障树（已核验）

| symptom | 官方 possible cause | 官方 adjustment | sourceId |
|---|---|---|---|
| Shot 流得太快 | 研磨偏粗 | **磨细** | `fellow-espresso-basics` |
| Shot 流得太慢 | 研磨偏细 | **磨粗**（微调即有很大差别） | `fellow-espresso-basics` |
| Shot 发酸 / 咸 / 空洞 | 研磨偏粗 | 磨细 | `fellow-espresso-basics` |
| Shot 发苦 / 发涩 | 研磨偏细 | 磨粗 | `fellow-espresso-basics` |
| 奶泡太多、太蓬 | 进气过多 / 卷入时机不对 | 确保形成漩涡，**更早把奶缸上提** | `fellow-espresso-basics` |
| 出液过快 / 过慢（通用） | 研磨 | 调整研磨细度 | `lamarzocco-linea-micra-zh` |
| 粉饼被分水网螺丝压出印痕 | 填压不足 / 研磨过粗 / 滤杯过小 | 加大填压 / 磨更细 / 换大滤杯 | `lamarzocco-linea-micra-zh` |
| 咖啡不流出 | 水箱有水；**滤网堵塞（粉太细或压太紧）**；分水网需清洁 | 检查水箱、清洁分水网、调整研磨/填压 | `gaggia-classic-manual` |
| 流速过快（Gaggia） | 粉太粗 / 未填压 | 磨细 / 填压 | `gaggia-classic-manual` |
| 泵噪音大（Gaggia） | 水箱无水 / 泵未引水 | 加水 / 引水 | `gaggia-classic-manual` |
| 把手处漏水量过大 | 把手未装好 / 冲煮头垫圈脏或磨损 / 把手边缘有粉 | 清洁/更换垫圈、清洁边缘 | `gaggia-classic-manual` |
| 意式几乎无 crema | 粉太粗 / 未填压 / 豆太老或干 | 调整研磨与填压、换新鲜豆 | `gaggia-classic-manual` |
| 意式太凉 | 机器未预热（**6 分钟**） | 充分预热 | `gaggia-classic-manual` |
| 奶泡不足 | 蒸汽嘴或进气孔堵塞 / 奶温过高 | 清洁蒸汽嘴 | `gaggia-classic-manual` |

## 统一故障树框架（规格 §20 要求的形态）

```text
Shot too fast
    ↓ possible causes
    ├── grind too coarse        （Tier 2：Fellow）
    ├── dose too low            （待补证）
    ├── distribution issues     （待补证）
    ├── channeling              （待补证）
    └── bean / grinder differences （Tier 2：Baratza「刻度依豆与器具」）
                                            ↓
                                test（味觉 + 时间 + 流速）
                                            ↓
                                adjustment（先调研磨）
                                            ↓
                                risk（连续改多项 → 无法归因）
```

## Practical Guidance

- 调参顺序（厂商口径收敛路径）：**先研磨 → 再看时间/流速 → 最后动粉量/温度/压力**。
- 一次只改一个变量；记录改动前的结果。

## Exceptions / Limitations

- 「dose 偏低」「distribution 问题」「channeling」等作为独立致因，**本轮未取得制造商级别的直接表述**，因此标为待补证而非事实。
- 咖啡机「错误代码（error codes）」的逐型号含义**未核验** → REVIEW_QUEUE（P1，与型号绑定）。

## Applicability

`espresso`, `specific_model`（Gaggia Classic、Fellow Series 1、Linea Micra）

## Evidence Type

`manufacturer`（Tier 2）

## Source

`fellow-espresso-basics`、`lamarzocco-linea-micra-zh`、`gaggia-classic-manual`

## License

`proprietary-free`。独立改写。

## Last Verified

2026-09-30
