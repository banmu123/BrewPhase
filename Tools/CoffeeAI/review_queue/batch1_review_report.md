# Batch 1 — 人工审核报告

> 日期：2026-10-14 ｜ 候选 30 条（`b1-001`~`b1-030`）+ 存量示例 10 条审查
> **全部样本 review_status = unreviewed。本报告只是审核辅助，不含任何批准动作。**

## 一、审核方法

每条候选按五项标准核对：事实可追溯（claim/rule/conflict ID 是否真实支撑）、回答完整性、
是否过度确定、训练目标是否明确、是否复制来源原文。所有样本的 ID 已由
`build_batch1.py` 反向校验（230 个知识库 ID + 51 个注册来源），校验器 0 error 0 warning。

## 二、逐条审核要点（30 条新增候选）

| 样本 | 主题 | 核心事实锚点 | 潜在问题 | 建议 |
|---|---|---|---|---|
| b1-001 | 品种基础 | `claim.fundamentals.two-species/robusta-share/robusta-genetic-diversity` | 「四成」为约数，注意不要读成精确值 | 通过 |
| b1-002 | 基础常识 | `claim.fundamentals.bean-is-seed` | 无 | 通过 |
| b1-003 | 品种数据方法 | `claim.varieties.no-absolute-data/fields` | 需确认「20 多个变量」与来源一致 | 通过 |
| b1-004 | Robusta 授粉 | `claim.varieties.robusta-pollination/robusta-mix-transparency` | 因果链两步，核对 WCR 原文支持度 | 通过（重点核对） |
| b1-005 | 标准/CVA | `claim.sensory.cva-four/cva-supersedes-2004` | 「2024-11 起三部分取代」日期口径核对 | 通过（重点核对日期） |
| b1-006 | 冲煮共识 | `claim.pourover.paper-rinse-universal` | 无 | 通过 |
| b1-007 | 多因素归因 | `claim.origin.env-factors` + `claim.varieties.no-absolute-data` | 综合了两处来源，确认没有超出 | 通过 |
| b1-008 | 产区≠风味 | 同上（同组改写） | 与 b1-007 相似度需人工确认不显冗余 | 通过 |
| b1-009 | 研磨刻度 | `claim.grinding.manual-not-recipe/aeropress-grind-ref/fellow-grind-reference` | 三来源拼接，各自表述需核对 | 通过 |
| b1-010 | 滤材 | `claim.aeropress.paper-vs-metal` | 「金属保留油脂与细粉」出自变量表（无独立 claim id），来源已登记 | 通过（弱断言已克制） |
| b1-011 | 处理法比较 | `claim.processing.php-*` + `claim.fermentation.risk-framing` | 刻意不下比较结论——确认这个「不回答」符合预期 | 通过（重点核对） |
| b1-012 | 手冲太淡 | `rule.hario.v60.too-weak` + `claim.pourover.v60-official-tuning` | 无 | 通过 |
| b1-013 | 手冲过慢 | `rule.hario.v60.too-slow` | 「改过头变太淡」为推断，是否保留由你定 | 通过（可接受推断） |
| b1-014 | 意式发酸 | `rule.fellow.shot-sour` + `claim.extraction.channeling-vendor` | 「第一近似」限定语必须保留 | 通过 |
| b1-015 | 意式苦涩 | `rule.fellow.shot-bitter` | 同上 | 通过 |
| b1-016 | 酸≠萃取不足 | 同 b1-014 + 推理 | 「明亮酸质是风格」为行业常识性表述，来源支撑弱 | 通过（重点核对） |
| b1-017 | 单变量原则 | `claim.grinding.manual-not-recipe` | 「一次一变量」为知识库通用建议（无独立 claim id），已在 notes 如实标注 | 通过 |
| b1-018 | 冷萃不足 | `rule.coldbrew.weak` + `claim.coldbrew.roast-dominant/time-least` | 实验条件限定语必须保留 | 通过 |
| b1-019 | 养豆差异 | `claim.freshness.dark-roast-rest-5-7d/light-roast-rest-4-6w/resting-varies-by-roast` | 厂商配方案例数字（5–7 天/4–6 周）需对照 Fellow 原文 | 通过（重点核对数字） |
| b1-020 | 深烘养豆 | 同上 | 明确反对推广，口径安全 | 通过 |
| b1-021 | 烘焙度标准 | `claim.roasting.sca-131/color-curve` | 「制定中」状态有时效性 | 通过 |
| b1-022 | 冷萃时间 | `claim.coldbrew.8h-vs-24h/time-least/hario-mizudashi` | Hario 8–10h 数值来自 partial 来源（第三方托管官方卡） | 通过（重点核对） |
| b1-023 | 品种名→风味期 | `claim.freshness.resting-varies-by-roast` | 无 | 通过 |
| b1-024 | 产区→风味 | `claim.origin.env-factors` | 「埃塞俄比亚常见花香」为 METHODOLOGY §4 允许的最弱表述 | 通过 |
| b1-025 | V60 标准配方 | `conflict.v60.official-recipes-differ` + 两条配方 claim | 两组配方数字需对照 | 通过（重点核对数字） |
| b1-026 | 除垢周期 | `conflict.descaling.no-universal-cycle` + `claim.cleaning.*` | 周期数字较多（60/90 天、2 个月等），逐个核对 | 通过（重点核对数字） |
| b1-027 | 倒置法 | `conflict.aeropress.inverted-method` + `claim.aeropress.inverted-not-recommended` | 立场分层的表述是否平衡 | 通过（重点核对） |
| b1-028 | 意式温度 | `conflict.espresso.brew-temperature-defaults` | 无 | 通过 |
| b1-029 | 咖啡因 | 5 条 health claims | 健康主题：确认无新增数字、无个人建议化表述 | 通过（重点核对） |
| b1-030 | AeroPress 水温 | `conflict.aeropress.water-temperature` + `claim.aeropress.official-temp` | 「设计取向」一句是转述冲突登记的解释文本 | 通过（重点核对） |

**最需要人工核对的 9 条**（数字/日期/立场）：b1-004、b1-005、b1-011、b1-016、b1-019、b1-022、b1-025、b1-026、b1-027、b1-029。

## 三、存量 10 条示例的审查结果（阶段二复核）

文本未改动（保持候选状态），元数据已补充真实来源锚点与审查结论：

| 样本 | 审查发现 | 建议 |
|---|---|---|
| ex-001 / ex-002 | 手冲过萃感官线索无直接 claim；fellow 映射为意式第一近似 | **修改**（弱化确定性） |
| ex-003 | 酸咸空洞→磨粗有 `rule.fellow.shot-sour` 支撑；「余韵短」无来源 | **修改**（补限定语） |
| ex-004 / ex-005 | **「持续释放二氧化碳」机理在知识库无核验 claim**——这是最重要的一处发现 | **修改**（机理补证或改写为 `claim.freshness.resting-varies-by-roast` 的差异事实口径） |
| ex-006 | CVA 描述性(103)/情感性(104)的区分直接支撑「感官描述 vs 喜好」；风味轮仅提名称，CC BY-NC-ND 合规 | 通过（来源已补进 meta） |
| ex-007 | 92°C 起点与 brewing-variables 口径一致；发酵风险框架有 claim 支撑 | 通过 |
| ex-008 | `claim.origin.env-factors` 直接支撑 | 通过（来源已补） |
| ex-009 | 行为规范样本，无外部事实 | 通过 |
| ex-010 | 「矿物质影响萃取口感」的知识库核验点在设备结垢方向；「多项研究支持」表述过强（SCA Water Handbook 为付费墙） | **修改**（弱化或补证） |

汇总：**6 条建议修改、4 条建议通过**。全部保持 `unreviewed`，等你按清单逐条确认。

---

## 阶段三复核（2026-10-14，代码复查与安全修复）

在不改变任何 `review_status` 的前提下，对候选做了事实锚点复核与修订：

| 样本 | 修订 | 说明 |
|---|---|---|
| b1-007 | meta 补 `claim.processing.php-scientific` + 来源 `cqi-php` | 回答中「CQI 把处理视为需风险控制的过程」原无对应 claim 锚点，现已对齐 |
| b1-026 | meta 补 `conflict.gaggia.classic-descale-interval` + `claim.water.gaggia-vinegar-ban` | 「同厂商不同代际手册不一致」「Gaggia 禁醋」两处事实此前缺锚点 |
| b1-028 | meta 补 `claim.espresso.fellow-ratio-1to3` | 「93°C」出自该 claim（94°C 已有 fellow-ratio-example） |
| b1-027 | **文本修订** | 原句「若采用，应确保密封完好、远离易碎容器」可能被读成「照做即安全」；改为「本知识库无法保证任何操作方式的安全，是否采用由你自行判断，采用前自行评估密封、器具与烫伤风险，并以官方安全说明为准」 |
| 全部 30 条 | meta 补 `source_usage = {sourceId: fact-extraction-rewrite}` | 落实来源级准入政策（见 coffeeai_common.EXTERNAL_SOURCE_POLICY） |

**逐条复核结论**：阶段二报告标注的重点样本中，b1-004/005/011/019/022/025/029 的回答文本与知识库 claim 表逐字核对一致，无需修订；b1-016 的「明亮酸质是风格而非缺陷」仍属弱支撑表述（保留在通过项里，靠人工裁决）；b1-017 的「一次一变量」保持无独立 claim 的如实标注。

**残余风险（须人工对照外部原文）**：本环境的网络无法访问 WCR/Fellow/Hario/UC Davis 原始页面，所有 claim 锚点只验证了「知识库内部存在且语义对应」，**未**重新核对知识库对外部来源的转述是否准确。人工审核时请对 b1-019/022/025/026 的具体数字做外部抽查。

---

## 阶段四影响通告（2026-10-14，来源政策默认拒绝）

来源级准入已升级为**默认拒绝**：仅 `fda-caffeine`（public-domain 且 commercialUse/derivatives 均 allowed）可自动准入；其余来源（NC-ND、see-source-terms、proprietary-free、字段 unclear 者）必须先在 `Tools/CoffeeAI/source_exceptions.json` 登记有效人工例外（审批人/日期/范围齐全）。`source_usage` 声明不再能单独放行任何来源。

**当前例外登记表为空（脚本不得代填审批信息），因此以下 39 条候选在训练准入层面被来源政策阻断**（样本本身未删除、未改写、review_status 仍为 unreviewed）：

| 来源 | 受影响候选 |
|---|---|
| wcr-varieties-catalog / -fields | b1-001, b1-003, b1-004, b1-007, b1-008, b1-024, coffee-ex-008 |
| fellow-brew-talks | b1-009, b1-019, b1-020, b1-023, b1-028, coffee-ex-004, coffee-ex-005 |
| fellow-espresso-basics | b1-014, b1-015, b1-016, coffee-ex-001, coffee-ex-002, coffee-ex-003 |
| hario-v60-expert-guide | b1-006, b1-010, b1-012, b1-013, b1-017, b1-025 |
| aeropress-how-to-use | b1-009, b1-010, b1-017, b1-030 |
| sca-coffee-standards / sca-cva | b1-005, b1-021, coffee-ex-006 |
| cqi-php / cqi-home / cqi-q-grader-faq | b1-007, b1-011, coffee-ex-007 |
| ucdavis-coldbrew-2025 / -research-index | b1-018, b1-021, b1-022 |
| 其余（各 1–2 条） | baratza-documents(b1-009/017), stumptown-kalita-guide(b1-006), nca-aboutcoffee(b1-002), hario-v60-hoffmann(b1-025), hario-recipe-cards(b1-022), gaggia-classic-manual(b1-026), sage-bes875-ug-i23(b1-026, coffee-ex-010), aeropress-manual-inverted(b1-027/030), efsa-caffeine-opinion(b1-029) |

不受影响：`coffee-ex-009`（行为规范样本，无外部来源，凭豁免字段通过来源检查；仍为 unreviewed）。

**审核流程含义**：若你决定允许某来源用于独立事实提取，请在 `source_exceptions.json` 按模板登记例外（审批人/日期/范围必填），再继续审核对应候选；未登记来源的候选保持阻断。
