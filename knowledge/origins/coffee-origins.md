# 02 Coffee Origin — 产地

> status: partial ｜ authorityTier: 1 ｜ lastVerified: 2026-09-30 ｜ topic: origins

## Summary

产地知识必须建立一个**层级模型**：`Origin → Country → Region → Sub-region → Farm → Elevation → Climate → Soil → Processing Infrastructure → Harvest Season`。

> **红线（规格 §02）：** 不得写「Ethiopia = floral」「Brazil = chocolate」「Kenya = acidity」这种绝对化结论。必须写成「常见 / 典型 / 在某些区域或处理法中常见」。

## 产区框架（可溯源部分）

| claim id | 事实 | sourceId |
|---|---|---|
| claim.origin.arabica-distribution | Arabica 是中美洲、南美与东非大部分地区的**主导种**；Robusta 的商业重要性持续上升。 | `wcr-varieties-catalog` |
| claim.origin.robusta-distribution | Robusta 商业栽培约 1870 年始于刚果；1950 年前后产量快速扩张，**主要集中于巴西与越南**。 | `wcr-varieties-catalog` |
| claim.origin.brazil-coe | 巴西精品咖啡协会与 SCA 合作，使 **CVA 成为巴西精品咖啡的官方标准**——说明巴西是精品咖啡标准化的活跃产区。 | `sca-cva` |
| claim.origin.indonesia-coe | 印尼精品咖啡协会与 SCA 合作，将 **CVA 定为印尼精品咖啡的官方协议**。 | `sca-cva` |
| claim.origin.colombia-fnc | SCA 与**哥伦比亚全国咖啡种植者联合会（FNC）**签署协议。 | `sca-cva` |
| claim.origin.robusta-research-institutes | Robusta 目录数据来自多国研究机构：CCRI（印度）、ICCRI（印尼）、EMBRAPA（巴西）、NaCORI（乌干达）、WASI、Nestlé 研究中心——间接标定了主要产国。 | `wcr-varieties-catalog-fields` |
| claim.origin.tree-20-30y | 咖啡树寿命 20–30 年，因此**产地的品种选择会影响长期品质与产量结构**。 | `wcr-varieties-catalog` |
| claim.origin.env-factors | WCR 明确：**环境、海拔、土壤养分、天气、树龄与农场管理**都会显著影响产量、品质与健康。 | `wcr-varieties-catalog` |
| claim.origin.ico-members | ICO 有 75 个成员国，覆盖 **94% 全球产量**与 64% 全球消费。 | `ico-cdr-2022-23` |

## 覆盖状态（规格 §02 清单）

| 区域 | 国家 | 状态 |
|---|---|---|
| Africa | Ethiopia, Kenya, Rwanda, Burundi, Uganda, Tanzania, DR Congo | ⚠️ 仅**间接**确认（WCR 品种、研究机构、ICO 成员）——**逐国产区/海拔/采收季未核验** |
| Central America | Guatemala, Costa Rica, El Salvador, Honduras, Nicaragua, Panama | ⚠️ 部分（Panama 因 Geisha 出现；Caturra 为中美洲参照品种） |
| South America | Colombia, Brazil, Peru, Bolivia, Ecuador | ⚠️ 部分（Brazil/Colombia 有 SCA 协议证据） |
| Asia | Indonesia, Vietnam, India, China, Myanmar, Thailand, Laos, Philippines | ⚠️ 部分（Indonesia/Vietnam/India 有间接证据） |
| Other | Mexico, Hawaii, Jamaica, Yemen | ❌ 未核验 |

> **诚实结论：** 「产地 → 典型风味」的**国家级描述本知识库一律不写**。原因：本轮没有任何来源支持把某国与某风味绑定，而规格恰恰禁止这种写法。逐国产区需要后续从 ICO / 各国协会 / WCR 逐条采集。

## Practical Guidance

- 面向用户解释产地时，只做**层级结构**与**已知事实**（如「瑰夏在巴拿马以特定产区闻名」），不做国家级风味承诺。
- 参考 BrewPhase 现状：模型不识别巴拿马/Boquete 等产地（见 memory `2026-09-30`），补产地数据本身有价值，但**不应期待它改变预测**。

## Exceptions / Limitations

- **逐国产区、子产区、采收季、处理基础设施全部待采集**（REVIEW_QUEUE P1/P2）。
- 「典型风味」只能来自有来源的产区级描述（如 WCR 目录的 cup quality 相对参照），不能来自模型常识。

## Applicability

`specific_region`, `generic`

## Evidence Type

`research`（Tier 1）+ `standard`（Tier 1）

## Source

`wcr-varieties-catalog`、`wcr-varieties-catalog-fields`、`sca-cva`、`ico-cdr-2022-23`

## License

`cc-by-nc-nd`（WCR）/ `see-source-terms`。独立改写。

## Last Verified

2026-09-30
