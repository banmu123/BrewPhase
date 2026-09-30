# 14 Brewing Variables — 冲煮变量模型

> status: filled ｜ authorityTier: 2+3 ｜ lastVerified: 2026-09-30 ｜ topic: brewing

## Summary

统一变量模型（规格 §14）：`dose / water / ratio / grind / temperature / time / flow / agitation / pour structure / pressure / filter / brew geometry`。每个变量记录 **definition / effect / tradeoff / typical direction / exceptions / source**。

**措辞强制**：只用「可能 / 通常 / 在其它条件不变时」；禁止绝对化。

## 变量表

| 变量 | 定义 | 典型方向（其它条件不变时） | 代价 / 例外 | 来源 |
|---|---|---|---|---|
| **研磨度 grind** | 颗粒尺寸 | 更细 → 阻力增大、接触时间倾向变长 | 过细易堵、易出涩；刻度不可跨磨豆机换算 | `baratza-documents`、`aeropress-how-to-use` |
| **水温 temperature** | 冲煮用水温度 | 更高 → 单位时间萃取能力通常增强 | 过高可能带入更多苦/涩；AeroPress 官方基准反而偏低（80–85°C） | `hario-v60-expert-guide`、`aeropress-how-to-use` |
| **比例 ratio** | 粉 : 水（重量） | 水更多 → 更淡、香气更突出 | 水量 ≠ 杯中液重（粉吸水） | `hario-v60-expert-guide` |
| **时间 time** | 总冲煮时长 | 更长 → 萃取通常更多 | 冷萃研究中**时间并非主导变量** | `ucdavis-coldbrew-2025` |
| **粉量 dose** | 咖啡粉克重 | 影响粉层厚度与比例 | 与器具容量耦合 | `lamarzocco-linea-micra-zh`（14/17/21g 滤杯） |
| **注水结构 pour structure** | 分段/连续、注水位置 | 影响搅动与均匀度 | 官方配方之间差异大（同品牌亦不同） | `hario-v60-expert-guide`、`hario-v60-hoffmann` |
| **搅动 agitation** | 搅动强度 | 增强时倾向提高萃取 | 过度搅动可能降低均匀度 | `aeropress-how-to-use` |
| **压力 pressure** | 意式专用（bar） | 见 §19 | 机型变量 | `fellow-brew-talks` |
| **滤材 filter** | 纸/金属 | 金属保留更多油脂与细粉 | 口感与透明度取向不同 | `hario-v60-expert-guide`（纸）、AeroPress（纸/金属） |
| **器具几何 brew geometry** | 锥形/平底/单孔/三孔 | 影响流速与通道倾向 | 见 `brewing/pour-over.md` | 见 §15 来源 |

## 参数示例（来自真实来源，**不是唯一正确答案**）

| 方法 | 参数 | 来源 | 等级 |
|---|---|---|---|
| V60（Expert） | 15g / 250g、中细、92–96°C、≈2.5 min | `hario-v60-expert-guide` | Tier 2 |
| V60（署名专家） | 30g / 500mL、97°C、闷蒸 45s | `hario-v60-hoffmann` | Tier 3 |
| Kalita Wave | 21g / 345g、≈205°F、2:45–3:00 | `stumptown-kalita-guide` | Tier 3 |
| AeroPress（官方） | 85°C、中细、浸泡 30–60s | `aeropress-how-to-use` | Tier 2 |
| AeroPress（crema 风格） | 15g 细磨深烘、近沸水、搅拌 20 次、1 min | `aeropress-flow-control-recipes` | Tier 2 |
| Espresso（Fellow 配方） | 18g → 36g、94°C、30s | `fellow-brew-talks` | Tier 2 |
| Linea Micra（官方建议） | 25–35s、出液≈粉重 2 倍 | `lamarzocco-linea-micra-zh` | Tier 2 |

## Practical Guidance

- 调参时**一次只改一个变量**（BrewPhase 知识库的通用建议，`generic`）。
- 任何参数展示都必须带 **source + author + equipment + context**（规格 §48）。

## Exceptions / Limitations

- 「参数随豆子变化」是行业共识，因此本表所有数字都是**起点**不是答案。
- 缺少统一量化的「变量 → 结果」函数；不要伪造曲线。

## Applicability

`generic`, `espresso`, `pour_over`, `immersion`

## Evidence Type

`manufacturer` + `professional_practice`

## Source

见上表各行 sourceId。

## License

`proprietary-free` / `see-source-terms`。独立改写。

## Last Verified

2026-09-30
