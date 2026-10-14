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
