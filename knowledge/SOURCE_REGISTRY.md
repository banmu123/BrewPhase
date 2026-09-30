# Source Registry — 人类可读版

> 机器可读版本：`knowledge/SOURCE_REGISTRY.json`。本文件只做概览与引用纪律说明，任何条目以 JSON 为准。
> 核验日期（accessedAt）均为 **2026-09-30**。

## 0. 引用纪律（先读这条）

1. 本注册表里的每条来源，都在本轮通过 WebSearch 命中或 WebFetch 读取过。**`url: null` + `status: pending-verification` 表示尚未取得官方可访问 URL —— 禁止在知识文档里拿它当事实来源。**
2. `license.status = unknown` 表示来源没有自述许可。**不许默认可复制。** 这类来源只能做「事实提取 + 独立改写 + 署名」，不得搬运原文。
3. 权威等级高 ≠ 免费。SCA 的多本 Handbook 是付费数字产品（`proprietary-paywalled`），只能引用其存在与书目，不得复制正文。

## 1. 统计

| 项 | 数量 |
|---|---|
| 注册来源总数 | 50 |
| Tier 1（官方/标准/学术/政府） | 20 |
| Tier 2（设备厂商官方） | 25 |
| Tier 3（专业教育机构/署名专家/烘焙商） | 3 |
| Tier 4（社区） | 2 |
| status = active | 42 |
| status = paywalled | 2 |
| status = restricted（许可受限） | 1 |
| status = pending-verification | 5 |

## 2. 关键许可结论（规格 §五 的硬约束）

| 来源 | 许可 | 对 BrewPhase 的含义 |
|---|---|---|
| `wcr-varieties-catalog` | **CC BY-NC-ND 4.0** | 可分享、可非商业分发；**不得改动数据、不得出售**。品种知识只能独立改写，不能复制目录表格。 |
| `sca-flavor-wheel-2016` | **CC BY-NC-ND 4.0** | 可展示/分享，**不得改编、不得商用**。禁止把原始数字文件改造后作为产品资产。 |
| `sca-digital-store`（含 Water Quality / Freshness / Brewing / Sensory & Cupping Handbook） | **付费数字产品** | 只能记录书目与「其存在」；正文不得复制。 |
| 各厂商手册（Sage / De'Longhi / Gaggia / La Marzocco / JURA / Philips / Nespresso / Rancilio / Baratza / Comandante） | 免费下载，但版权归厂商 | 只能**事实提取 + 独立改写 + 标注型号**，不得整份复制。 |
| `barista-hustle` | 订阅制 | 只能取课程主题骨架；正文不得复制。 |
| `fda-caffeine` | 美国政府作品（公有领域） | 可引用；仍应署名。 |
| `efsa-caffeine-opinion` | EFSA 复用政策（需署名） | 可引用结论；须署名并注明为 2015 年意见。 |

## 3. Tier 1 — 官方 / 标准 / 学术 / 政府

| sourceId | 标题 | URL | 许可 | status |
|---|---|---|---|---|
| `sca-coffee-standards` | SCA Standards | sca.coffee/research/coffee-standards | see-source-terms | active |
| `sca-cva` | Coffee Value Assessment | sca.coffee/value-assessment | see-source-terms | active |
| `sca-digital-store` | SCA Digital Products（Handbooks） | sca.coffee/store | **paywalled** | paywalled |
| `sca-flavor-wheel-2016` | Coffee Taster's Flavor Wheel (©2016) | sca.coffee/store | **CC BY-NC-ND 4.0** | restricted |
| `wcr-varieties-catalog` | Coffee Varieties Catalog | varieties.worldcoffeeresearch.org | **CC BY-NC-ND 4.0** | active |
| `wcr-varieties-catalog-fields` | WCR 品种字段说明 | worldcoffeeresearch.org/news/2023/robusta-variety-catalog | see-source-terms | active |
| `wcr-sensory-lexicon` | WCR Sensory Lexicon v2.0 | *(未取得)* | unknown | pending-verification |
| `cqi-home` | Coffee Quality Institute | coffeeinstitute.org | see-source-terms | active |
| `cqi-php` | CQI Post-Harvest Processing | coffeeinstitute.org | see-source-terms | active |
| `cqi-q-grader-faq` | CQI Q Grader FAQ（CVA 过渡） | coffeeinstitute.org/post/faqs-regarding-q-grader-certification | see-source-terms | active |
| `ucdavis-coffee-center` | UC Davis Coffee Center | coffeecenter.ucdavis.edu | see-source-terms | active |
| `ucdavis-coldbrew-2025` | Cold Brew Timing（Scientific Reports） | coffeecenter.ucdavis.edu/news/... | see-source-terms | active |
| `ucdavis-research-index` | Coffee Center Research index | coffeecenter.ucdavis.edu/articles/research | see-source-terms | active |
| `nca-aboutcoffee` | About Coffee（消费者教育） | aboutcoffee.org | see-source-terms | active |
| `nca-main` | National Coffee Association | ncausa.org | see-source-terms | active |
| `ico-main` | International Coffee Organization | icocoffee.org | see-source-terms | active |
| `ico-cdr-2022-23` | Coffee Development Report 2022-23 | icocoffee.org/documents/... | see-source-terms | active |
| `fda-caffeine` | Spilling the Beans（咖啡因） | fda.gov/consumers/... | **public-domain** | active |
| `efsa-caffeine-opinion` | Safety of caffeine（2015） | efsa.europa.eu/en/efsajournal/pub/4102 | see-source-terms | active |
| `efsa-caffeine-topic` | Caffeine（EFSA 主题页） | efsa.europa.eu/en/topics/topic/caffeine | see-source-terms | active |

## 4. Tier 2 — 设备厂商官方

| sourceId | 品牌 | 覆盖型号 | URL | status |
|---|---|---|---|---|
| `breville-sage-bes875-hub` | Sage/Breville | Barista Express BES875/SES875 | sageappliances.com/en-se/producthub/bes875 | active |
| `sage-bes875-manual-en` | Sage/Breville | BES875 | breville.com/content/dam/...BES875-instruction-manual.pdf | active |
| `sage-bes875-ug-i23` | Sage | BES875（I23 修订） | assets.sageappliances.com/BES875/... | active |
| `delonghi-support` | De'Longhi | 通用入口 | delonghi.com/en-us/delonghi-support | active |
| `delonghi-manuals` | De'Longhi | 按型号 | delonghi.com/en-us/manuals | active |
| `delonghi-bco430-support` | De'Longhi | BCO430 | delonghi.com/en-us/manuals/.../BCO430 | active |
| `gaggia-classic-manual` | Gaggia | Classic (2019) | gaggia.com/app/uploads/2023/07/... | active |
| `lamarzocco-home-service` | La Marzocco | Linea Mini/Micra/GS3/Leva/Strada/Pico | home.lamarzoccousa.com/service/ | active |
| `lamarzocco-linea-mini-manual` | La Marzocco | Linea Mini | lamarzoccousa.com/wp-content/uploads/... | active |
| `lamarzocco-linea-micra-zh` | La Marzocco | Linea Micra（中文） | lamarzocco.com/tw/zh-hans/linea-micra-... | active |
| `jura-product-support` | JURA | E8 / J8 twin / C9 / X8 | jura.com/en/support/products-support/... | active |
| `philips-saeco-support` | Philips/Saeco | Xelsis / Incanto / Intelia / Syntia | usa.philips.com/c-p/.../support | active |
| `nespresso-faq` | Nespresso | Original / Vertuo | contact.nespresso.com/faq-3/fr/en | active |
| `nespresso-manuals-index` | Nespresso | 多机型 | *(未在官方域核实)* | pending-verification |
| `rancilio-silvia-manual` | Rancilio | Silvia | ranciliogroupna.com/wp-content/uploads/... | active |
| `rancilio-silvia-product` | Rancilio | Silvia | ranciliogroupna.com/equipment-type/rancilio-silvia/ | active |
| `baratza-documents` | Baratza | Encore/ESP/Virtuoso+/Sette/Vario/Forte | baratza.com/en-au/documents | active |
| `comandante-official` | Comandante | C40 Mk4 / C60 | comandantegrinder.com | active |
| `hario-v60-expert-guide` | Hario | V60 02 | hario.co.uk/pages/brew-guides-v60-expert | active |
| `aeropress-how-to-use` | AeroPress | Original/Go/Clear | aeropress.com/pages/how-to-use | active |
| `aeropress-flow-control-recipes` | AeroPress | Flow Control Cap | aeropress.com/pages/...recipes-site | active |
| `aeropress-manual-inverted` | AeroPress | Original | *(第三方托管官方文本)* | active |
| `fellow-brew-talks` | Fellow | Series 1 / Stagg X / Ode / Opus / Aiden | fellowproducts.com/blogs/brew-talks | active |
| `fellow-espresso-basics` | Fellow | Series 1 | help.fellowproducts.com/hc/... | active |
| `kalita-official` | Kalita | — | *(未取得)* | pending-verification |

## 5. Tier 3 — 专业教育 / 署名专家 / 烘焙商

| sourceId | 标题 | 说明 |
|---|---|---|
| `barista-hustle` | Barista Hustle 课程体系 | 订阅制；只能取主题骨架。课程含 Advanced Espresso(80)、Percolation(46/47)、Immersion(70)、The Water Course(45)、Advanced Coffee Making(81/87)、Milk Science(38)、The Espresso Machine(22)、Processing(82)、Terroir(52)、Roasting Science(58)、Latte Art(45)。 |
| `hario-v60-hoffmann` | James Hoffmann 官方署名 V60 配方 | 托管在 Hario 官方站，但内容署名为 2007 WBC 冠军，故记 Tier 3 professional_practice。 |
| `stumptown-kalita-guide` | Stumptown Kalita Wave 指南 | Kalita 原厂未取得，用烘焙商指南替代。 |

## 6. Tier 4 — 社区（仅用于发现争议与常见问题）

| sourceId | 状态 | 用途限制 |
|---|---|---|
| `home-barista-forum` | pending-verification | 只能作 anecdotal 证据；不得形成科学事实。 |
| `reddit-r-coffee` | pending-verification | 同上；引用时必须标 `evidenceType = anecdotal`。 |

## 7. 条目格式（规格 §71）

`SOURCE_REGISTRY.json` 里每条即为此形状（示例为真实条目）：

```json
{
  "sourceId": "wcr-varieties-catalog",
  "title": "Coffee Varieties Catalog (Arabica + Robusta)",
  "publisher": "World Coffee Research",
  "url": "https://varieties.worldcoffeeresearch.org/",
  "authorityTier": 1,
  "evidenceType": "research",
  "license": { "status": "cc-by-nc-nd", "commercialUse": "not-allowed", "derivatives": "not-allowed" },
  "language": "en",
  "status": "active",
  "lastVerified": "2026-09-30"
}
```

## 8. 待验证厂商清单（规格 §64 未覆盖部分，绝不假装已覆盖）

`SOURCE_REGISTRY.json` 的 `pendingManufacturers` 字段列出：Rocket Espresso、ECM、Profitec、Lelit、Nuova Simonelli、Victoria Arduino、Ascaso、Flair、Cafelat、Timemore、1Zpresso、Kalita（原厂）、Clever、Chemex、Origami、Orea、Tricolate、April、Kono、Melitta、Bee House、Mugen。

这些品牌在本知识库中**没有任何事实条目引用**。补录需要先实际抓取官方域并确认许可。
