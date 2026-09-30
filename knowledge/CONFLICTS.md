# CONFLICTS — 来源冲突登记

> 规则（规格 §四 / §77）：**冲突不许抹平。** 不写「正确答案就是 X」，而是说明各自适用范围、来源等级、以及设备/烘焙/配方差异。
> 每条冲突在 `SOURCE_REGISTRY.json` 里都有对应的 sourceId；在 claims 里通过 `conflictId` 回链。

---

## conflict.aeropress.inverted-method

**claim：** AeroPress 是否推荐使用「倒置法（inverted）」冲煮。

| 立场 | 来源 | 等级 | 适用范围 |
|---|---|---|---|
| 不推荐：倒置法因不稳定、有倾覆烫伤风险，官方说明书不予推荐 | `aeropress-manual-inverted` | Tier 2（厂商） | 官方说明书的**安全立场** |
| 广泛使用：倒置法可避免穿滤、延长浸泡，是社区与实践者默认手法之一 | 社区实践（Tier 4，见 `reddit-r-coffee` / `home-barista-forum`，均 pending-verification） | Tier 4 | 追求浸泡控制与风味的**操作实践** |

**resolution（status: explained）：** 这不是事实冲突，而是**立场分层**。官方立场是安全责任（倒置时若密封不良，热水可能喷溅）；实践者接受该风险以换取控制。知识库应同时呈现两者，标清证据类型：官方条目 `manufacturer`，社区条目 `anecdotal`。**不给出「应该用倒置法」的单一结论**，而是提示：若采用倒置，需使用完好密封并远离易碎容器。

---

## conflict.gaggia.classic-descale-interval

**claim：** Gaggia Classic 的除垢周期。

| 立场 | 来源 | 等级 | 适用范围 |
|---|---|---|---|
| 每 **2 个月** | `gaggia-classic-manual`（2019 版手册） | Tier 2 | Classic（2019 及之后） |
| 每 **4 个月** | Gaggia 更早期 Classic / Classic Coffee 手册（同厂，早期修订） | Tier 2 | 早期 Classic 修订版 |

**resolution（status: resolved-by-scope）：** 这是**同一厂商不同代际手册**的差异，不是矛盾。新版给出更激进（更频繁）的周期。正确做法是**以用户手上那台机器附带的、对应型号与代际的手册为准**。这正是规格 §42 的核心论点：不存在一个通用除垢周期。知识库若录入，必须绑定 `specific_model` + 代际。

---

## conflict.descaling.no-universal-cycle

**claim：** 是否存在一个「通用咖啡机除垢周期」。

| 立场 | 来源 | 等级 | 适用范围 |
|---|---|---|---|
| 用 Sage 水滤芯时每 3 个月或 40L；除垢建议硬度 4 → 90 天、硬度 6 → 60 天 | `sage-bes875-ug-i23` | Tier 2 | Barista Express 系列 |
| 每 2 个月（用 GAGGIA 除垢剂；禁用醋） | `gaggia-classic-manual` | Tier 2 | Gaggia Classic |
| 每 600 粒胶囊或每 6 个月 | `nespresso-faq` | Tier 2 | Nespresso Original/Vertuo |
| AquaClean 滤芯下「最长 5000 杯不需除垢」 | `philips-saeco-support` | Tier 2 | Philips/Saeco 带 AquaClean 机型 |
| 未给出统一周期，按水硬度设置提示 | `delonghi-support` / `delonghi-bco430-support` | Tier 2 | De'Longhi 各型号 |

**resolution（status: explained）：** 官方立场一致指向**不存在通用周期**。周期取决于：水硬度、用水量、是否使用树脂滤芯、机型设计。知识库必须拒绝生成「通用咖啡机清洁/除垢周期」，只输出**型号绑定**的厂商说明。跨品牌的粗略共识（如「关注水硬度」）可以保留，但必须标为 `generic` + `medium confidence`。

---

## conflict.v60.official-recipes-differ

**claim：** V60 的「官方配方」是什么。

| 立场 | 来源 | 等级 | 参数 |
|---|---|---|---|
| Hario Expert 指南 | `hario-v60-expert-guide` | Tier 2 | 15g / 250g、中细、约 92–96°C、约 2.5 min |
| Hario Recipe Card | Hario Asia/Europe 配方卡（第三方托管） | Tier 2 | 18–20g / 300mL、中细、93°C、2–3 min |
| Hario Mugen（单次注水） | 型号专用配方（第三方转述） | Tier 3（转述） | 25g / 300g、中细、93°C、15s 注完、总 3:00–3:30、比例 1:12 |
| 署名专家（Hoffmann） | `hario-v60-hoffmann` | Tier 3 | 30g / 500mL、细中、97°C、闷蒸 45s、2:00 内完成 |

**resolution（status: explained）：** 即便在**同一品牌**内部，V60 配方也随**器具尺寸/材质（01/02、Mugen/W60）、目标浓度、目标风味**而变。规格 §16 / §48 的结论成立：**不存在唯一正确配方**。知识库必须把每条配方当作「来源 + 作者 + 器具 + 语境」四元组，而不是「V60 标准参数」。

---

## conflict.coldbrew.time

**claim：** 冷萃的浸泡时间是否需要 12–24 小时。

| 立场 | 来源 | 等级 | 适用范围 |
|---|---|---|---|
| 全浸泡冷萃中，8 小时与 24 小时的感官差异可很小；**烘焙度 > 温度 > 时间** | `ucdavis-coldbrew-2025` | Tier 1（研究） | 特定实验设计（萨尔瓦多/尼加拉瓜 Arabica，Agtron 41.8 与 71.8，4/22/92°C，多时间点） |
| 常见做法 12–18 小时 | 厂商/教育资料通用区间（例：Hario Mizudashi 官方 8–10 小时） | Tier 2/3 | 家用常规 |

**resolution（status: explained）：** 研究结论是「时间不是主导变量」，而非「时间无所谓」。Hario Mizudashi 官方给 8–10 小时，UCSD 说 8h 可接近 24h——两者方向一致。知识库应写：「在特定实验条件下，缩短浸泡时间对感官影响小于降低烘焙度差异」+ 标注实验限制，而不是断言「冷萃 8 小时即可」。

---

## conflict.espresso.brew-temperature-defaults

**claim：** 意式的「标准萃取温度」。

| 立场 | 来源 | 等级 | 备注 |
|---|---|---|---|
| 厂商默认值不一致：Fellow Series 1 配方默认 93°C（200°F）与 94°C（201°F） | `fellow-brew-talks` | Tier 2 | 随机型/配方变化 |
| 第三方教育资料常给 90–96°C 区间 | Tier 3 教育资料（区间性） | Tier 3 | 未固化为单一官方数字 |

**resolution（status: explained）：** 规格 §四 与 §67 的样板冲突。**不存在单一「正确」意式温度**。若某机型官方规定默认值，可写「该型号默认 X°C」；**不得**写成「意式最佳温度是 X°C」。适用范围受豆子、烘焙度、研磨、目标风味影响。

**（注：本条仅登记已核验的厂商默认值；SCA/学术侧的具体温度数字因未在免费可访问来源中确认，暂不录入，留待 REVIEW_QUEUE 补证。）**

---

## conflict.aeropress.water-temperature

**claim：** AeroPress 官方推荐水温。

| 立场 | 来源 | 等级 | 参数 |
|---|---|---|---|
| 官方说明书与 how-to：约 **80–85°C**（175–185°F） | `aeropress-how-to-use` / `aeropress-manual-inverted` | Tier 2 | 官方基准 |
| 第三方指南给 92°C 等更高温度 | Tier 4 及零售商内容 | Tier 4 | 追求更高萃取 |

**resolution（status: explained）：** 官方基准明显低于手冲常见水温，这是 AeroPress 的设计取向（较低温换取更顺滑、低酸）。高温属于**配方选择**，不是「更正确」。知识库必须写：「官方基准 80–85°C；实际温度是配方变量，可高于此值以改变萃取」。
