# 19 Espresso Fundamentals — 意式浓缩基础

> status: filled ｜ authorityTier: 2 ｜ lastVerified: 2026-09-30 ｜ topic: espresso

## Summary

意式浓缩是**高压穿透粉饼**的萃取方式。核心变量：dose（粉量）、yield（出品量）、brew ratio、shot time、pressure、temperature、pre-infusion，以及 puck preparation（distribution / tamping / WDT / puck screen / basket）。

> 注：规格 §19 中「约 9 bar」这一常见表述，**本轮未在任何已核验来源中取得可引用的官方数字**（La Marzocco / Fellow 官方资料未给出统一 9 bar 说法）。故本文档**不写 9 bar 为通用标准**，只记录已核验的机型层面事实。

## Facts

| claim id | 事实 | sourceId |
|---|---|---|
| claim.espresso.linea-micra-yield | La Marzocco 官方（Linea Micra）：萃取 **25–35 秒**；出液克重**应为粉重的两倍**；流速过快/过慢则调整磨豆机粗细。 | `lamarzocco-linea-micra-zh` |
| claim.espresso.linea-micra-basket | Linea Micra 官方建议：**14g 滤杯做意式**，17/21g 滤杯做主流 espresso；填压后粉面应对齐滤杯内刻痕。 | `lamarzocco-linea-micra-zh` |
| claim.espresso.linea-micra-puck-check | 官方提示：锁上把手后可再取下，检查粉饼是否因触碰分水网螺丝留下**压痕**；若有，则加大填压力度、磨更细或换更大滤杯。 | `lamarzocco-linea-micra-zh` |
| claim.espresso.fellow-dose-tamp | Fellow 官方：每杯量 **18g** 豆（约 3.5 汤匙）；用双壁滤杯；分布出平整表面；以 90° 手臂角度填压形成水平粉床。 | `fellow-espresso-basics` |
| claim.espresso.fellow-ratio-example | Fellow 配方样例：18g 进、36g 出、比例 **1:2**、94°C、30 秒。 | `fellow-brew-talks` |
| claim.espresso.fellow-ratio-1to3 | Fellow 另一配方为 18g → 55g（**1:3**）、93°C、22–25 秒，含 5 秒/3 bar 预浸泡与 17 秒 9 bar 主萃取。 | `fellow-brew-talks` |
| claim.espresso.paddle-preinfusion | Linea Mini 的拨杆（paddle）为手动起停，**带电子预浸泡**（electronic pre-infusion）。 | `lamarzocco-linea-mini-manual` |
| claim.espresso.rancilio-silvia-specs | Rancilio Silvia：**0.3L 黄铜热交换（HX）锅炉**、2L 内置水箱、商用黄铜冲煮头、**58mm** 手柄。 | `rancilio-silvia-product` |
| claim.espresso.pump-pressure-adjust | Rancilio Silvia 手册含「调整泵压（Adjusting pump pressure）」与「安全温控复位」章节，说明泵压是**可调且需维护**的机内部件。 | `rancilio-silvia-manual` |

## Variables

| 变量 | 说明 | 来源 |
|---|---|---|
| dose | 粉量（14 / 17 / 18 / 21g 等，随滤杯） | `lamarzocco-linea-micra-zh` |
| yield | 出品克重（常为粉重 2 倍，也有 1:3 配方） | `lamarzocco-linea-micra-zh`、`fellow-brew-talks` |
| ratio | 粉:液 | 同上 |
| shot time | 25–35s（官方）；配方可 22–30s | `lamarzocco-linea-micra-zh`、`fellow-brew-talks` |
| pressure | 机型变量；Fellow 配方用 3 bar 预浸 + 9 bar 主萃 | `fellow-brew-talks` |
| temperature | 随机型/配方，93–94°C（Fellow 配方） | `fellow-brew-talks` |
| pre-infusion | Linea Mini 电子预浸泡；Fellow 5s/3bar | `lamarzocco-linea-mini-manual`、`fellow-brew-talks` |
| basket | 单/双、加压（双壁）/精密 | `fellow-espresso-basics`、`lamarzocco-linea-micra-zh` |

## Practical Guidance

- 面向用户：先固定 dose 与 ratio，再调研磨（这是厂商口径下收敛最快的一步）。
- 粉饼问题（压痕、通道）有**官方检查法**（Linea Micra 取下把手看压痕）。

## Exceptions / Limitations

- 「9 bar 是意式标准」**未在已核验来源中确认**，不写入。
- WDT、puck screen、bottomless portafilter、精密滤杯的**效果结论未核验** → REVIEW_QUEUE。

## Applicability

`espresso`, `specific_model`（Linea Mini/Micra、Silvia、Fellow Series 1）

## Evidence Type

`manufacturer`（Tier 2）

## Source

`lamarzocco-linea-micra-zh`、`lamarzocco-linea-mini-manual`、`fellow-espresso-basics`、`fellow-brew-talks`、`rancilio-silvia-product`、`rancilio-silvia-manual`

## License

`proprietary-free`。独立改写。

## Last Verified

2026-09-30
