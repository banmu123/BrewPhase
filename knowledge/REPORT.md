# REPORT — BrewPhase Coffee Knowledge Base 交付报告

> 规格 §79 的 14 项。日期 **2026-09-30**。所有数字可复现（`python Tools/knowledge/build_kb.py --check`）。

---

## 1. 知识库总体架构

```text
knowledge/
├── README.md                  编排与铁律
├── SOURCE_REGISTRY.json/.md   51 条来源（机器可读 + 人读）
├── CONFLICTS.md               7 条冲突登记
├── REVIEW_QUEUE.md            20 项待办（P0–P4）
├── STATS.md                   统计快照
├── REPORT.md                  本文件
├── _schema/                   7 份 JSON Schema（source/claim/document/recipe/equipment/terminology/conflict）
├── _method/METHODOLOGY.md     采集·验证·改写·引用·更新流程
├── _build/
│   ├── documents.json         15 篇双语可检索文档（§53/§55 结构）
│   └── knowledge_base.v2.json 编译产物（app 格式，尚未接入）
└── 25 个领域目录              33 篇 Markdown 知识文档
```

流水线：`来源 → 事实提取 → 来源验证 → 结构化 → claims → documents → （待）embedding`。
**与既有 RAG 管线兼容**：app 的 `KnowledgeBase.swift` 只读 `id/category/source/title/content`，额外元数据被安全忽略。

## 2. 来源列表

完整 51 条见 `SOURCE_REGISTRY.json`。已核验的代表性来源：

- **Tier 1**：SCA Standards / CVA / Digital Store、WCR Varieties Catalog、CQI（Home/PHP/Q FAQ）、UC Davis Coffee Center（含 cold brew 研究）、NCA（ncausa.org + aboutcoffee.org）、ICO（icocoffee.org + CDR 2022-23）、FDA（caffeine）、EFSA（caffeine opinion + topic）。
- **Tier 2**：Sage/Breville（BES875 hub + 2 份手册）、De'Longhi（support/manuals/BCO430）、Gaggia（Classic 2019 手册）、La Marzocco（Home service + Linea Mini 手册 + Micra 官方中文）、JURA（逐型号）、Philips/Saeco（Xelsis/Incanto）、Nespresso（FAQ）、Rancilio（Silvia 手册 + 产品页）、Baratza（docs 库）、Comandante、Hario（V60 Expert + Hoffmann + 配方卡）、AeroPress（how-to + Flow Control + 说明书）、Fellow（Brew Talks + Espresso Basics）。
- **Tier 3**：Barista Hustle（课程体系）、Hario 署名专家配方、Stumptown Kalita 指南。
- **Tier 4**：Home-Barista、r/coffee（均挂起，仅用于发现争议）。

## 3. 来源权威等级

| Tier | 数量 | 占比 |
|---|---|---|
| 1 | 20 | 39% |
| 2 | 26 | 51% |
| 3 | 3 | 6% |
| 4 | 2 | 4% |

状态：active 42 ｜ paywalled 2 ｜ restricted 1 ｜ partial 1 ｜ **pending-verification 5**。

## 4. 各知识领域覆盖情况

- **filled（17）**：Fundamentals、Grinding、Brewing Variables、Pour Over/V60、Immersion/AeroPress、Espresso Fundamentals、Espresso Dial-In、Cold Brew、Sensory/Flavor、Cupping、Brewing Troubleshooting、Equipment Troubleshooting、Cleaning & Maintenance、Safety、Health、Industry/Sustainability、Terminology。
- **partial（12）**：Origin、Varieties、Processing、Green Coffee、Roasting、Freshness、Storage、Water、Machine Architecture/Types、Milk/Latte Art、Defects、Equipment DB。
- **skeleton（4）**：**Fermentation、Extraction Science、Brew Methods & Moka**（+ 机器类型的部分小节）。

skeleton 是刻意的：只确立主题骨架与所需来源，**不含未经核验的数字**（规格 §二/§77）。

## 5. 已采集知识量

| 项 | 数量 |
|---|---|
| 领域文档 | 33 篇 |
| 已声明 knowledge claims | **203** |
| 可 embedding 文档（双语） | 15 篇 |
| 术语（中英日） | 47 |
| 配方 | 14 |
| 故障规则（结构化） | 20 |
| 冲突记录 | 7 |
| 来源 | 51 |

## 6. 设备型号覆盖情况

**已核验 21 个型号**（含官方 URL）：Sage BES875、Rancilio Silvia、La Marzocco Linea Mini / Micra / GS3、Gaggia Classic、De'Longhi BCO430 / EAM3200、JURA E8 / X8、Philips Saeco Xelsis / Incanto、Nespresso Vertuo / Original、Baratza Encore / Forte BG、Comandante C40 Mk4、Hario V60 02、AeroPress Original/Go/Clear、Fellow Series 1、Kalita Wave 185（原厂来源缺）。

**挂起 29 项**（见 `equipment.json` → `pendingEquipment`）：Rocket、ECM、Profitec、Lelit、Nuova Simonelli、Victoria Arduino、Ascaso、Flair、Cafelat、Timemore、1Zpresso、Kalita 原厂、Chemex、Origami、Orea、Tricolate、April、Kono、Melitta、Bee House、Clever、Hario Switch/Mugen、Bialetti 等。

> 关键纪律已落地：**Breville = Sage** 命名差异被显式记录；**禁止品牌级清洁知识**。

## 7. Recipe 数量

**14 条**（`recipes/recipes.json`），全部带 `sourceId` / `author` / `equipment` / `context`。含 V60×4、Kalita、Mizudashi 冷萃、AeroPress×3、Linea Micra、Fellow×3，以及 1 条**「Gaggia 官方不给配方」的元数据条目**——记录「没有配方」本身也是知识。

## 8. Troubleshooting 数量

**20 条结构化规则**（`troubleshooting.json`）+ 两张 Markdown 故障表（冲煮 / 设备）。每条含 `symptom / causes / evidence / test / adjustment / risk / confidence / sourceIds`。

## 9. Source Registry

`SOURCE_REGISTRY.json`（51 条，字段：sourceId/title/publisher/url/publishedAt/updatedAt/accessedAt/authorityTier/evidenceType/license/language/country/topics/modelScope/status/verification）+ `SOURCE_REGISTRY.md`（人读 + §71 格式示例 + 引用纪律）。

## 10. License 情况

| 许可 | 数量 | 处置 |
|---|---|---|
| proprietary-free | 26 | 事实提取 + 独立改写 |
| see-source-terms | 17 | 引用 + 独立改写 |
| **cc-by-nc-nd** | 2 | **WCR catalog / SCA Flavor Wheel —— 禁改编、禁商用** |
| proprietary-paywalled | 2 | SCA Handbooks / Barista Hustle —— 不复制正文 |
| public-domain | 1 | FDA |
| unknown | 3 | 不默认可复制 |

**无任何受限制正文被复制**；两份 CC BY-NC-ND 来源只做结构性独立改写。

## 11. 冲突知识

**7 条**（`CONFLICTS.md`）：

1. `conflict.aeropress.inverted-method` — 官方不推荐 vs 社区广泛使用（立场分层）
2. `conflict.gaggia.classic-descale-interval` — 2 个月 vs 4 个月（代际差异）
3. `conflict.descaling.no-universal-cycle` — 五品牌周期互不相同（**这本身就是结论**）
4. `conflict.v60.official-recipes-differ` — 同一品牌官方配方就不止一套
5. `conflict.coldbrew.time` — 研究 vs 常规做法
6. `conflict.espresso.brew-temperature-defaults` — 厂商默认值不一致
7. `conflict.aeropress.water-temperature` — 官方 80–85°C vs 第三方更高温

## 12. 待审核知识

`REVIEW_QUEUE.md` 共 **20 项**：P0 五项（错误码、冷萃食品安全、拆机边界、摩卡壶安全阀、意式水温依据）｜ P1 八项（清洁步骤完整性、水质区间、萃取机制、烘焙事件定义、发酵机制、绿咖啡分级、机型规格表、泵压值）｜ P2 七项（处理法定义、器具配方、器具覆盖、滤杯材料、磨豆机 seasoning、WDT/puck screen、多因解释树）。

## 13. 数据质量问题

| 问题 | 影响 | 处置 |
|---|---|---|
| 三个领域为 skeleton | 用户问发酵/萃取机制/摩卡壶时会缺答案 | 已在文档顶部与 REVIEW_QUEUE 明示；宁可缺答案也不编 |
| 5 个来源 pending-verification | 无法作为事实来源 | 编译脚本会**拒绝**引用它们的文档（已实测拦截 1 例） |
| 产地国家级风味描述缺失 | 产地解释只能给层级结构 | 依规格 §02 禁令，未从模型常识补写 |
| 部分来源仅 search-result 级核验 | 未逐页 WebFetch 原文 | `verification.method` 字段如实标注为 `search-result-only` |
| HARIO 配方卡托管在第三方域 | 来源权威性打折 | 注册为 `partial`，文档中标注 |
| 无 `.gitignore`，`.DS_Store` 被跟踪 | 仓库卫生（历史遗留） | 本轮未处理（超出范围），建议单独处理 |

## 14. 推荐下一批采集内容

按投入产出比排序：

1. **P0 先做**：各机型错误代码表 + 冷萃食品安全（`ucdavis-coffee-center` / FDA）。
2. **补全 3 个 skeleton**：发酵机制（CQI PHP）、萃取科学（UC Davis 新版 Brewing Control Chart）、摩卡壶（Bialystok→Bialetti 官方）。
3. **设备扩容**：先补 Rocket / Profitec / Lelit / ECM / Ascaso（家用意式主力），再补 Chemex / Origami / Orea（手冲主力）。
4. **产地结构化**：从 ICO + 各国协会采集 `Country → Region → Harvest Season`，**不做国家级风味承诺**。
5. **WCR 品种逐条抓取**：在 CC BY-NC-ND 约束下独立改写血统/抗病/海拔字段。
6. **水质区间**：需付费来源（SCA Water Handbook / BH Water Course）或公开论文替代。
7. **审核通过后再谈 embedding**：当前 15 篇可检索文档已就绪，但规格 §78 要求先做好知识质量与来源体系。

---

## 关于「已接入 App 吗」——明确回答

**没有。** `BrewPhase/Resources/knowledge_base.json`（16 条旧条目）**未被替换**，一行代码也未改。原因：

1. 规格 §78 明确「不要一开始就批量 embedding，先把知识质量与来源体系做好」。
2. 替换 app 资源会触发产品决策（旧 16 条去留、`source` 字段展示方式、许可署名位置）。
3. 编译产物已就绪并可一键生成，但**是否上线应由你决定**：

```bash
python Tools/knowledge/build_kb.py            # 生成 _build/knowledge_base.v2.json
# 若决定接入：
# cp knowledge/_build/knowledge_base.v2.json BrewPhase/Resources/knowledge_base.json
```

接入后还需（超出本轮范围）：在 `KnowledgeBase.swift` 暴露 `applicability` 以支持 §58 的型号优先排序；在引用展示处加入许可署名。

## 本轮的边界（诚实声明）

- 这是一个**可用的地基 + 已核验的核心**，不是「整理好了」。
- 51 个来源、203 条 claim、21 个型号、14 条配方是**真实核验过的数量**；29 个挂起型号、3 个 skeleton、20 项待办是**真实的未完成项**。
- 所有 URL 均来自本轮 WebSearch 核验；未在任何字段填入未经核验的 URL 或 license。
