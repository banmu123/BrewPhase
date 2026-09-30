# 33–34 Brew Methods & Moka Pot — 冲煮方法目录与摩卡壶

> status: skeleton（方法目录）/ skeleton（摩卡壶） ｜ authorityTier: — ｜ lastVerified: 2026-09-30 ｜ topic: brewing

## Summary

规格 §33 要求建立完整方法目录，§34 要求摩卡壶专章。**本文件是骨架**：它列出应覆盖的方法与每个方法需要的字段，并**诚实标注哪些本轮没有来源**。

> 摩卡壶的一个关键纠偏（规格 §34）：**不要把摩卡壶当作真正意义上的 espresso。** 这条是本知识库可以确立的**方法论立场**，但「摩卡壶实际压力约 1–2 bar」这一常见数字**本轮未取得可引用来源**，因此不写入。

## 方法目录覆盖状态（规格 §33）

| 方法 | 状态 | 已有来源 |
|---|---|---|
| Espresso | ✅ | `lamarzocco-linea-micra-zh`、`fellow-espresso-basics`、`gaggia-classic-manual` |
| Pour Over（V60） | ✅ | `hario-v60-expert-guide`、`hario-v60-hoffmann` |
| Pour Over（Kalita） | ⚠️ | `stumptown-kalita-guide`（非原厂） |
| Immersion（AeroPress） | ✅ | `aeropress-how-to-use` |
| Immersion（French Press） | ⚠️（仅主题级） | `barista-hustle` |
| Cold Brew | ✅ | `ucdavis-coldbrew-2025`、`hario-recipe-cards` |
| Siphon | ⚠️（Hario 配方卡有） | `hario-recipe-cards` |
| Percolation（batch brew） | ⚠️（主题级） | `barista-hustle` |
| Moka Pot | ❌ | 见下 |
| Turkish / Ibrik | ⚠️（主题级） | `barista-hustle` |
| Clever / Switch | ❌ | — |
| Phin（越南） | ❌ | — |
| South Indian Filter | ❌ | — |
| Vietnamese Coffee | ❌ | — |
| Drip Machine / Batch Brew | ❌ | — |
| Capsule | ⚠️ | `nespresso-faq` |
| Instant | ❌ | — |
| Cowboy Coffee | ❌ | — |
| Japanese Iced Coffee / Flash Brew | ✅ | `aeropress-flow-control-recipes` |
| Cold Drip（冰滴） | ❌ | — |

## 每个方法的字段模板（§33）

```yaml
method: <name>
principle:        # 萃取原理（percolation / immersion / pressure）
equipment:        # 器具
recipe:           # 有来源的具体配方
variables:        # 可调变量
commonIssues:     # 常见问题
cleaning:         # 清洁
bestUseCases:     # 适用场景
sources:          # sourceIds
```

## 34 Moka Pot（专章骨架）

**可以确立的立场：**

| claim id | 立场 | 依据 |
|---|---|---|
| claim.moka.not-espresso | 摩卡壶**不是**真正意义上的 espresso（不是 9 bar 级的压力萃取体系）。 | 属方法论纠偏；本轮未能引用到官方/学术来源的直接表述，故 `confidence: medium`，列 REVIEW_QUEUE 补证 |

**待补证（**不写数字**）：**

`dose / grind / water / pressure / heat / safety valve / brew endpoint / heat management / cleaning / gasket / funnel / filter`

**建议来源：** Bialetti 官方（本轮未核验）、SCA 相关材料。**在取得来源前，本知识库不提供摩卡壶的任何参数数字。**

## Practical Guidance

- 面向用户：能答的方法给**带来源的配方**；不能答的方法，明确说「还没有可引用的权威配方」，而不是编一个。
- 这是规格 §77「不要编造数据」的直接落地。

## Exceptions / Limitations

- 本文件**没有**任何摩卡壶参数、French Press 参数、Turkish 参数。这既是有意为之，也是当前采集进度的真实反映。

## Applicability

`generic`, `specific_model`

## Evidence Type

混合（见各行）

## Source

见各行 sourceId。

## License

遵守各来源许可；本文档未复制任何受限制正文。

## Last Verified

2026-09-30
