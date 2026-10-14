# Batch 1 剩余 26 条候选全量质量审核报告（阶段五点四）

> 日期：2026-10-14 ｜ 对象：b1-001~011、b1-016~030（b1-012~015 已有试点审核）
> 性质：**只读审查与建议**——不采纳任何待决建议、不修改候选/知识库/例外表、不批准。
> 本轮外部核验：fda-caffeine ✅（逐字一致）、wcr-varieties-catalog 首页 ✅（部分）、
> hario-v60-expert-guide ✅（承试点轮）、fellow-espresso-basics PDF ✅（承试点轮）。
> 其余来源本轮未核验，逐条标注 needs-source-check（不做冒充核验）。

## 1. 总体结论

| 内容结论 | 数量 | 样本 |
|---|---|---|
| 建议保留 | 22 | b1-001/002/004/006/007/008/009/010/011/017/018/019/020/021/022/023/024/026/027/028/029/030 |
| 建议轻度修改 | 1 | b1-016（「空洞」→「寡淡」×2，修订补丁已备） |
| 建议结构性重写 | 0 | — |
| 建议拒绝 | 0 | — |
| 证据不足，暂缓决定 | 2 | b1-005（SCA CVA 四部分与 2024-11 采纳日期未核验）、b1-025（Hoffmann 配方细节未核验——两份配方对比是答案核心） |

**这些是审查建议数量，不是批准数量。** 总体质量高于预期：候选普遍自带语境限定、
不编造数字、把厂商口径标为第一近似——批次构建器的方法论有效。

## 2. 逐条审核表（紧凑版，字段顺序：训练价值 → 主要证据 → F/P/I → 问题与风险 → 结论 → 准入）

| ID | 训练价值 | 主要证据（本轮核验状态） | F/P/I 要点 | 问题与风险 | 内容结论 | 来源准入 |
|---|---|---|---|---|---|---|
| b1-001 | 咖啡基础：两个栽培种 | claim.fundamentals.*；WCR 首页✅（起源/类型/多样性） | F：两分法、多样性；**「约四成产量」未在首页核到→P，needs-source-check** | 无；数字待佐证 | 保留 | 阻断（wcr 两源） |
| b1-002 | 基础纠偏：豆=种子 | claim.fundamentals.bean-is-seed；nca-aboutcoffee 未核验 | F（带来源限定） | 无；NCA 页面 needs-source-check | 保留 | 阻断（nca） |
| b1-003 | 方法论：相对参照 vs 绝对值 | claim.varieties.*；WCR 首页✅方法学未直接展示 | F（目录方法）；细节 needs-source-check | 无 | 保留 | 阻断 |
| b1-004 | 品种知识：Robusta 授粉 | claim.varieties.robusta-*；未核验 | F | 无；页面细节 needs-source-check | 保留 | 阻断 |
| b1-005 | 标准动态：CVA 体系 | claim.sensory.cva-*；SCA 文档未核验 | F（四部分/取代 2004） | **2024-11 采纳日期与四文件编号需外部核验** | 暂缓（待补证据） | 阻断（sca 两源，see-source-terms） |
| b1-006 | 手冲步骤：洗滤纸 | claim.pourover.paper-rinse-universal；**Hario 页✅原文「remove papery taste…warm」** | F（跨来源一致）+P（幅度无量化，已自带标注） | 无 | 保留 | 阻断 |
| b1-007 | 综合：三标签各自说明什么 | env-factors✅；cqi-php 未核验 | F + P（处理法风险框架） | 无 | 保留 | 阻断（含 cqi） |
| b1-008 | 反推断：产区≠风味 | env-factors✅ | F | **与 b1-024 高度同质**（见 §3） | 保留（冗余待决） | 阻断 |
| b1-009 | 磨豆机迁移：刻度不可换算 | claim.grinding.*；三家来源均未核验 | F（manual-not-recipe）+P（AeroPress/Fellow 基准） | 数字（Encore 11–13）needs-source-check | 保留 | 阻断（含 fellow-brew-talks） |
| b1-010 | 器具：纸滤 vs 金属滤 | claim.aeropress.paper-vs-metal；未核验 | F（取舍）+P（风格选择） | 无 | 保留 | 阻断 |
| b1-011 | 处理法：拒绝排序比较 | claim.processing.*；CQI 三页未核验 | F（课程覆盖）+P（风险框架） | 无；「诚实不足」定位正确 | 保留 | 阻断（含 cqi-home） |
| b1-016 | 意式故障树：酸≠萃取不足 | rule.fellow.shot-sour✅（PDF 核验） | F（第一近似）+P（多证据验证法） | **「空洞」×2 需按术语冻结改「寡淡」** | 轻改（补丁已备） | 阻断 |
| b1-017 | 方法论：单变量原则 | claim.grinding.manual-not-recipe✅（Baratza 口径未核验） | P（通行做法）+F（变量模型） | 无 | 保留 | 阻断 |
| b1-018 | 冷萃：打破「时间不足」直觉 | rule.coldbrew.weak 等；UC Davis 研究未核验 | F（研究结论，带语境限定） | 排序结论依赖研究原文，needs-source-check | 保留 | 阻断（ucdavis） |
| b1-019 | 养豆：窗口差异案例 | claim.freshness.*；fellow-brew-talks 文章未核验 | F（批次案例，非规律——已自带限定） | 数字 5–7d/4–6w needs-source-check | 保留 | 阻断 |
| b1-020 | 养豆：反「深烘一周够了」 | 同上 | F（案例限定）+I（偏离可能） | 无 | 保留 | 阻断 |
| b1-021 | 标准：烘焙度无统一标尺 | claim.roasting.sca-131/color-curve；SCA-131 与 UC Davis 色曲线未核验 | F（标准状态）+P（讨论建议） | SCA-131「制定中」状态需外部核验 | 保留 | 阻断（含 ucdavis-research-index） |
| b1-022 | 冷萃：8h vs 24h | claim.coldbrew.*；UC Davis + Hario 配方卡未核验 | F（各自语境）+P（实验范围） | 8–10h 数字 needs-source-check | 保留 | 阻断（含 hario-recipe-cards） |
| b1-023 | 不确定性：品种名→风味期 | resting-varies-by-roast；未核验 | F（案例）+I（无法判断的诚实表述） | 无 | 保留 | 阻断 |
| b1-024 | 不确定性：产地→风味 | env-factors✅ | F + I（最弱表述边界清晰） | 无 | 保留 | 阻断 |
| b1-025 | 不确定性：V60 无标准配方 | conflict.v60.official-recipes-differ；Hario✅、**Hoffmann 配方未核验** | F（两配方对比=答案核心） | **Hoffmann 30g/500mL/97°C/45s 未核验前不宜训练** | 暂缓（待补证据） | 阻断（含 hario-v60-hoffmann） |
| b1-026 | 维护：无通用除垢周期 | conflict.descaling.*；Sage/Gaggia 手册未核验 | F（conflict 记录）+P（按手册） | 周期数字（60–90天/2月）needs-source-check | 保留 | 阻断（sage/gaggia） |
| b1-027 | 安全：倒置法立场分层 | conflict.aeropress.inverted-method；手册未核验 | F（官方立场）+P/I（社区实践=轶事，已标注） | 无；安全免责表述得当 | 保留 | 阻断 |
| b1-028 | 不确定性：无标准萃取温度 | conflict.espresso.brew-temperature-defaults；Fellow 94/93°C 未核验 | F（机型绑定事实）+I（反普适化） | 无 | 保留 | 阻断 |
| b1-029 | 健康：400mg 官方口径 | **fda-caffeine✅逐字一致**（400mg/2–3杯12oz/个体差异/孕期refer）；EFSA 未核验 | F（FDA 逐字）+F（EFSA 口径待核验） | EFSA 单次 100mg 睡眠条 needs-source-check | 保留 | **部分阻断**（fda-caffeine 自动准入✅，efsa-caffeine-opinion 阻断） |
| b1-030 | 器具：AeroPress 低温基准 | conflict.aeropress.water-temperature；185°F 未核验 | F（官方基准）+P（偏离属个人配方） | 无 | 保留 | 阻断 |

## 3. 跨样本问题（按严重度）

1. **外部核验覆盖率不足（本轮最重要发现）**：26 条中 22 条的关键来源本轮未核验
   （b1-002/005/009/010/011/017/018/019/020/021/022/023/026/027/028/030 全量 +
   b1-003/004 部分细节 + b1-025 的 Hoffmann 半边 + b1-029 的 EFSA 半边）。
   内容表述质量普遍合格，但「表述合格 ≠ 事实已核验」。
2. **来源准入近乎全面阻断**：除 b1-029 引用的 fda-caffeine（public-domain 自动准入）外，
   26 条引用的所有来源均处于默认拒绝阻断状态（含 b1-029 的 EFSA 半边）。
   **当前没有任何一条候选可以直接通过训练准入**——解除只能靠方案 A 例外（人工批准）
   或改用已准入来源。
3. **同组冗余**：b1-008 与 b1-024 同为「产区名→风味」反驳，论证结构高度同质
   （同一 claim.origin.env-factors），训练能力重复；建议合并保留其一或明确差异化
   （b1-024 加「埃塞俄比亚花香」弱表述示例）。b1-019/020 同组但角度不同（解释 vs 反推广），
   无冗余；b1-018/022 冷萃两条能力不同，无冗余。
4. **F/P/I 边界偶有含糊**：b1-001「约四成产量」、b1-009「Encore 11–13」等数字级表述
   需在核验后决定保持 F 还是降级 P；候选文本本身没有把 I 伪装成 F 的情况。
5. **术语冻结遗留**：b1-016 的「空洞」残留已备补丁；其余 25 条无冻结词命中。

## 4. 下一轮建议（五分类）

| 类别 | 内容 |
|---|---|
| 局部改写可解决 | b1-016（补丁已备）；补丁 b1-013/014/015 待人工采纳后统一套用 |
| 需回知识库 claim 层 | 暂无新增——weak/chalky 已修；若 robusta-share「四成」核验后出入大，回 claim 层修数字 |
| 需补充外部证据 | 优先级 1：b1-025 Hoffmann 配方（答案核心）；优先级 2：b1-005 SCA CVA 日期与文件编号；优先级 3：fellow-brew-talks 养豆两篇（b1-019/020）、UC Davis 冷萃两篇（b1-018/022）、Sage/Gaggia 手册（b1-026）、EFSA 口径（b1-029）；其余按准入解除后的用途排序 |
| 需人工许可决定 | hario-v60-expert-guide / fellow-espresso-basics 例外提案（方案 A/B/C）；其余阻断来源（wcr/cqi/nca/ucdavis/sca/efsa/baratza/aeropress/sage/gaggia/stumptown/hario-recipe-cards/hario-v60-hoffmann）若要用于训练，同样需要走提案→人工批准流程 |
| 建议淘汰 | 0 条；b1-008/024 二选一或差异化由人工决定 |

**推荐处理顺序**：① 人工采纳 4 条修订补丁（含 b1-016）→ ② 人工批准例外方案 A（先
hario + fellow 两个，因试点与全量审查中证据最扎实、核验最充分）→ ③ 按「候选引用的
已准入来源」筛选出可训练子集重新跑准入 → ④ 对仍缺外部证据的高价值候选（b1-025/005）
做针对性来源核验 → ⑤ 再讨论 approved 与训练集构建。

## 5. 待决事项（本轮不做决定）

4 条补丁采纳；weak/chalky 冻结最终确认；两个例外提案批准；b1-008/024 冗余处理；
候选 approved 标记时机。

## 6. 合规声明

本轮零修改：`batch1_candidates.jsonl`、`.meta.jsonl`、`batch1_revision_patch.jsonl`、
已有审核报告、`review_status`（30 条全 unreviewed）、`data/corpus|meta`、
`source_exceptions.json`（schemaVersion 3、exceptions []）、知识库全部文件——均未改动。
未安装 mlx-lm、未下载模型、未执行训练。本轮唯一新增文件即本报告。
