# STATS — 知识库统计

> 规格 §72。统计口径为 **2026-09-30** 的快照。可用 `python Tools/knowledge/build_kb.py --check` 复现校验。

## 来源统计

| 项 | 数量 |
|---|---|
| Total sources | **51** |
| Tier 1（官方/标准/学术/政府） | 20 |
| Tier 2（设备厂商官方） | 26 |
| Tier 3（专业教育机构/署名专家/烘焙商） | 3 |
| Tier 4（社区） | 2 |

来源状态：

| status | 数量 | 含义 |
|---|---|---|
| active | 42 | 已验证可访问 |
| paywalled | 2 | 付费数字产品（SCA Handbooks、Barista Hustle） |
| restricted | 1 | 许可受限（SCA Flavor Wheel，CC BY-NC-ND） |
| partial | 1 | 内容官方但托管在第三方域（HARIO 配方卡） |
| pending-verification | 5 | 未取得官方 URL，**禁止作为事实来源** |

## 内容统计

| 项 | 数量 |
|---|---|
| Total knowledge documents（编译产物，可 embedding） | **15** |
| 领域 Markdown 文档（研究层） | **33** |
| ├─ status: filled | 17 |
| ├─ status: partial | 12 |
| └─ status: skeleton | 4 |
| Total knowledge claims（已声明 `claim.*`） | **203** |
| Total terminology（三语） | **47** |
| Total recipes | **14** |
| Total equipment models（已核验官方来源） | **21** |
| Total equipment pending（挂起） | **29** |
| Total troubleshooting rules（结构化） | **20** |
| Total conflict records | **7** |

## 领域覆盖（规格 §01–§50）

| 领域 | 文件 | 状态 | claims |
|---|---|---|---|
| 01 Fundamentals | `fundamentals/coffee-fundamentals.md` | filled | 8 |
| 02 Origin | `origins/coffee-origins.md` | partial | 9 |
| 03 Varieties | `varieties/coffee-varieties.md` | partial | 8 |
| 04 Processing | `processing/coffee-processing.md` | partial | 7 |
| 05 Fermentation | `fermentation/fermentation.md` | skeleton | 4 |
| 06 Green Coffee | `green-coffee/green-coffee.md` | partial | 5 |
| 07 Roasting | `roasting/coffee-roasting.md` | partial | 5 |
| 08 Freshness | `freshness/freshness.md` | partial | 5 |
| 09 Storage | `storage/storage.md` | partial | 4 |
| 10–11 Grinding / Grinder Types | `grinding/grinding.md` | filled | 8 |
| 12 Water | `water/water.md` | partial | 11 |
| 13 Extraction Science | `extraction/extraction-science.md` | skeleton | 5 |
| 14 Brewing Variables | `brewing/brewing-variables.md` | filled | 0（变量表 + 配方表） |
| 15–16 Pour Over / V60 | `brewing/pour-over.md` | filled | 8 |
| 17–18 Immersion / AeroPress | `brewing/immersion-aeropress.md` | filled | 11 |
| 19 Espresso Fundamentals | `espresso/espresso-fundamentals.md` | filled | 9 |
| 20 Espresso Dial-In | `espresso/espresso-dial-in.md` | filled | 0（故障树表） |
| 21–22 Machine Architecture & Types | `espresso-machines/machine-architecture-and-types.md` | partial | 0（部件 + 机型表） |
| 31–32 Milk / Latte Art | `milk/milk-and-latte-art.md` | partial | 8 |
| 33–34 Brew Methods / Moka | `brewing/brew-methods-and-moka.md` | skeleton | 1 |
| 35 Cold Brew | `brewing/cold-brew.md` | filled | 10 |
| 36–37 Sensory / Flavor | `sensory/sensory-and-flavor.md` | filled | 10 |
| 38 Cupping | `cupping/cupping.md` | filled | 10 |
| 39 Defects | `defects/coffee-defects.md` | partial | 5 |
| 40 Brewing Troubleshooting | `troubleshooting/brewing-troubleshooting.md` | filled | 0（规则表） |
| 41 Equipment Troubleshooting | `troubleshooting/equipment-troubleshooting.md` | filled | 0（规则表） |
| 42 Cleaning & Maintenance | `cleaning-maintenance/cleaning-maintenance.md` | filled | 4 |
| 43 Safety | `safety/safety.md` | filled | 16 |
| 44 Coffee + Health | `health/coffee-health.md` | filled | 16 |
| 45–46 Industry / Sustainability | `industry/industry-and-sustainability.md` | filled | 16 |
| 47 Terminology | `terminology/terminology.json` | filled | 47 条 |
| 48 Recipes | `recipes/recipes.json` | filled | 14 条 |
| 49–50 Equipment / Manual DB | `equipment/equipment.json` | partial | 21 型号 |
| 51 Source Registry | `SOURCE_REGISTRY.json` | filled | 51 来源 |
| 52 Claims | 散布在各领域文档的 Facts 表 | filled | 203 |
| 53–55 Document / Chunk 结构 | `_build/documents.json` + Schema | filled | 15 |
| 56–58 Quality / Evidence / Applicability | Schema + 各条 `authorityTier`/`evidenceType`/`applicability` | filled | — |
| 59–61 Search Strategy / Update cadence | `_method/METHODOLOGY.md` | filled | — |
| 62 Web Research 工作流 | `_method/METHODOLOGY.md` | filled | — |
| 63–66 核心来源与优先级 | `SOURCE_REGISTRY.md` §3–§7 | filled | — |
| 73 REVIEW_QUEUE | `REVIEW_QUEUE.md` | filled | 20 项待办 |

## License 情况

| license.status | 数量 | 关键处置 |
|---|---|---|
| proprietary-free（厂商手册） | 26 | 仅事实提取 + 独立改写 |
| see-source-terms | 17 | 仅引用 + 独立改写 |
| cc-by-nc-nd | 2 | **禁止改编、禁止商用**（WCR 品种目录、SCA Flavor Wheel） |
| proprietary-paywalled | 2 | 不得复制正文（SCA Handbooks、Barista Hustle） |
| public-domain | 1 | FDA（仍署名） |
| unknown | 3 | **不默认可复制** |

## 未完成项（诚实清单）

1. 29 个设备品牌/型号未核验（P1）。
2. 4 个领域为 skeleton：fermentation、extraction-science、brew-methods-moka、（部分）machine-types。
3. 5 个来源 pending-verification（Kalita 原厂、Nespresso 机型手册页、WCR Sensory Lexicon、Home-Barista、r/coffee）。
4. REVIEW_QUEUE 共 20 项待办，其中 P0 五项。
5. 尚未接入 App：`BrewPhase/Resources/knowledge_base.json` **未被替换**（有意为之，见 `REPORT.md`）。
