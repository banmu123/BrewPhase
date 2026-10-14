# Batch2b 人工审核包（阶段六点九-D，2026-10-14）

> 依据：GPT 六点九-D 执行提示词（回复存档 `/tmp/gpt_next26.md`）。
> 目标：**只生成负责人审核材料，不做批准**。禁止项全部遵守：未修改
> batch2b_candidates_draft.jsonl / approved 数据 / source_exceptions.json / split / 训练配置。
> 输入：batch2b_candidates_draft.jsonl（8 条）；参考 BATCH2_WRITING_SPEC.md、
> batch2b_quality_gate_report.md。
> 质量门禁基线：PASSED（checked=8, errors=0, warnings=0）；测试 127 OK。

## 汇总（GPT 指定格式的数据）

| 项 | 值 |
|---|---|
| Batch2b candidate_count | **8** |
| quality_gate | **PASS**（0 error / 0 warning） |
| approved_current | **14**（batch1 5 + batch2a 9） |
| potential_after_approval | **22** |
| 训练状态 | **仍冻结**（阈值 approved ≥25 / train ≥15 未达；未装 mlx-lm、未下模型） |

来源准入总览：b2b-007 **PASS**（fda-caffeine 自动准入）；其余 7 条 BLOCK，
**唯一缺口均为例外的 `allowed_sample_ids` 未含 b2b 样本 ID**——全部引用 claim 已在
对应例外的 `allowed_claim_ids` 内（claim 维度零缺口）。属 batch2b_candidate_plan.md
预告的「既有例外的样本范围对齐」，落库批准时随登记流程并入，非新授权。

---

## b2b-001 ｜ 咖啡很酸怎么办？先澄清再判断

### A. 内容摘要
- **用户问题类型**：信息极度不足的模糊症状求助（只说「酸」，无器具/豆子/参数）。
- **模型目标能力**：问题澄清（interaction_skill = clarification）。
- **预期训练行为**：不直接下结论；区分「酸=风味特征」与「酸=问题信号」；列出最小信息集并说明每项能排除什么。

### B. Interaction 能力审核
- interaction_skill=clarification；missing_information_handling=「器具/烘焙度/酸感类型/粉水比与水温」最小信息集 + 各项排除方向。✅ 符合主动追问、条件化、不编造。
- 回答明示「仅凭『酸』这个描述还不能判断具体原因」——首句即判断边界（GPT 规则 1）。

### C. F/P/I 审核
- **F**：感知酸度与滴定酸强相关、酸是固有风味特征且类型多样 → `claim.roasting.ta-sourness-correlation`（ucdavis-coffee-center，UC Davis 2021 ACS Food Science & Technology）。
- **P**：澄清式诊断流程（先收集最小信息集再判断）——带「经验上/常见做法」语义框架。
- **I**：酸感类型与萃取状态的对应方向——已带「需要进一步确认」「推断」限定词。✅ 无 F 冒充 I / I 冒充 F。

### D. 来源准入
- **BLOCK**（唯一缺口：样本范围）。`ucdavis-coffee-center` 例外：deployment_purposes=[noncommercial-research] ✅；allowed_claim_ids 已含本条引用 claim ✅；allowed_sample_ids=[b2a-005, b2a-008] → **落库时并入 b2b-001**。

### E. 行为风险
- 是否真的避免「酸=欠萃」：✅——欠萃未被作为唯一或首选解释；酸首先被定位为固有风味特征（F 层），萃取方向仅在「尖锐刺激+寡淡」条件下以 I 层出现，且要求先看滴滤速度。

### F. 与已有 approved 差异
- **新增能力**：信息不足时的主动澄清行为——batch2a 诊断样本（b2a-001/002）都假定用户已给出可诊断的症状组合，本条训练「描述不足时先追问再诊断」，是交互能力的起点样本。

### G. 最大行为风险
1. 澄清问题流可能被模型学成「永远反问不给方向」——回答仍保留了各类型的条件化方向（C 段），降低此风险。
2. 「果酸=好、尖锐=坏」的二分可能被过度泛化——回答已限定「需要进一步确认」。
3. ucdavis 例外 claim 限定（noncommercial-research）需在落库对齐时保持。

### H. 建议动作
- `approve_candidate`（人工参考；落库时同步样本范围对齐）。

---

## b2b-002 ｜ 用户给出的参数互相矛盾时看什么

### A. 内容摘要
- **用户问题类型**：参数组合矛盾（比例正常 18g/300g × 流速异常 30 秒流完）。
- **模型目标能力**：多变量矛盾时的优先级判断（multi_variable_reasoning）。
- **预期训练行为**：指出矛盾点、不抓单参数；按影响面排序验证（研磨 → 粉层通道）；条件化调整。

### B. Interaction 能力审核
- interaction_skill=multi_variable_reasoning；missing_information_handling=请提供研磨刻度（含磨豆机型号）与滤杯版本，用于区分「研磨偏粗 vs 萃取通道」。✅ 符合。

### C. F/P/I 审核
- **F**：V60 官方配方互不相同（`conflict.v60.official-recipes-differ`，hario-v60-expert-guide）；「寡淡对应研磨偏粗、以滴滤速度为证据」（`rule.hario.v60.too-weak`，同源）。
- **P**：矛盾信号下先研磨后粉层的验证顺序——经验框架表述。
- **I**：通道/注水手法等替代原因——「推断——需结合粉床状态进一步判断」限定。✅ 无层级伪装。

### D. 来源准入
- **BLOCK**（唯一缺口：样本范围）。`hario-v60-expert-guide` 例外：claim 范围已含 `rule.hario.v60.too-weak` ✅（`conflict.v60.official-recipes-differ` 由 hoffmann 例外覆盖——本条仅引用该冲突事实作「无唯一标准」论据）；allowed_sample_ids=[b1-006, b1-012, b1-013, b1-025, b2a-006] → **落库时并入 b2b-002**。

### E. 行为风险
- 是否处理参数冲突：✅——开篇明确「两个信号不同向，不能只看其中一个」，比例与流速分别归位（比例无异常 / 流速待验证），未忽略任何一侧。

### F. 与已有 approved 差异
- **新增能力**：多变量矛盾检测与验证优先级——b2a 系列训练「多因并列」，本条训练「信号互相矛盾时先识别矛盾本身再排序验证」，是诊断链的前置步骤。

### G. 最大行为风险
1. 「先研磨后粉层」的固定顺序可能被学成死规则——回答已给出「若观察到通道先调布粉」的反例分支。
2. 冲突事实（official-recipes-differ）本条只作论据引用、claim 归属 hoffmann 例外——落库时需确认例外并集语义覆盖（六点五-C 已修复为并集）。
3. 「30 秒流完」数字来自用户原话，回答未将其固化为标准——风险低。

### H. 建议动作
- `approve_candidate`（人工参考；落库时同步样本范围对齐）。

---

## b2b-003 ｜ 「给我一个 V60 黄金比例」的正确回应

### A. 内容摘要
- **用户问题类型**：索要唯一标准答案（黄金比例/最佳参数）。
- **模型目标能力**：拒答/纠偏（boundary_setting）——拒绝「唯一答案」框架而非拒绝咖啡问题本身。
- **预期训练行为**：说明配方存在语境；提供带来源与语境的起点；教调整而非给终点。

### B. Interaction 能力审核
- interaction_skill=boundary_setting；missing_information_handling=请说明豆子烘焙度与滤杯版本以选起点。✅ 符合「把『要答案』转化为『给起点+教调整』」。
- 未回答「推荐 X:1」（GPT 规则 4 ✅）；Hoffmann 配方明确标注「署名作者推荐的方法，不是行业标准」。

### C. F/P/I 审核
- **F**：官方配方数值互不相同（`conflict.v60.official-recipes-differ`）；两个起点配方具体数字（Hario 15g/250g/92–96°C → `claim.pourover.v60-official-expert`；Hoffmann 30g/500mL/97°C → `claim.pourover.v60-hoffmann-recipe`）。
- **P**：起点→建立基准→再调整的使用方式；「署名方法 ≠ 行业标准」定位。
- **I**：浅烘/深烘的起点选择方向——带「通常」限定。✅ 无层级伪装。

### D. 来源准入
- **BLOCK**（唯一缺口：样本范围）。`hario-v60-expert-guide` 例外 claim 含 `claim.pourover.v60-official-expert` ✅；`hario-v60-hoffmann` 例外 claim 含 `claim.pourover.v60-hoffmann-recipe` 与 `conflict.v60.official-recipes-differ` ✅；allowed_sample_ids 分别为 [b1-006, b1-012, b1-013, b1-025, b2a-006] / [b1-025] → **落库时并入 b2b-003**。

### E. 行为风险
- 是否拒绝黄金参数：✅——开篇「没有一条适用于所有豆子、所有设备的黄金参数」+「任何单一数字都不适合被冠以『黄金』」；strong_claim_context_check 自动判定 negation-context pass。
- 起点配方带完整来源语境；未出现「最佳比例/一定有效」。

### F. 与已有 approved 差异
- **新增能力**：对「唯一答案请求」的系统性纠偏——b1-025 处理过单个配方语境，本条训练「拒绝伪标准框架 + 同时给出多个带语境起点 + 把请求转化为可执行路径」的完整行为。

### G. 最大行为风险
1. 「给起点」可能被学成变相给标准答案——回答把两个起点的数值差异本身用作「无唯一标准」的论据，结构上抑制此风险。
2. Hoffmann 名称权威性可能被模型强化为「行业标准」——回答已显式否定。
3. 高幻觉风险样本（plan 定级）：所有数字均带 claim，门禁数字扫描通过。

### H. 建议动作
- `approve_candidate`（人工参考；落库时同步样本范围对齐）。

---

## b2b-004 ｜ 同参数不同豆子——条件化回答

### A. 内容摘要
- **用户问题类型**：复制他人参数失败后的困惑（「为什么同样的参数我的不好喝」）。
- **模型目标能力**：条件化回答（condition_based_advice）——参数不可脱离豆子/设备复制。
- **预期训练行为**：把「复制参数」转化为「对齐条件」；列差异来源清单；逐项对齐法。

### B. Interaction 能力审核
- interaction_skill=condition_based_advice；missing_information_handling=四方向对齐清单（烘焙度/新鲜度/磨豆机型号与刻度/水质）+ 对齐顺序。✅ 符合。

### C. F/P/I 审核
- **F**：同豆不同萃味道明显不同（`claim.sensory.same-bean-different-brew`，ucdavis）；TA 随烘焙进程变化一爆达峰（`claim.roasting.ta-peaks-first-crack`，ucdavis）；Baratza 刻度取决于豆子与器具（`claim.grinding.manual-not-recipe`，baratza-documents）。
- **P**：逐项对齐对比法——「经验上」表述。
- **I**：批次与储存条件差异——「因豆而异」「需要进一步确认」限定。✅ 无层级伪装。

### D. 来源准入
- **BLOCK**（唯一缺口：样本范围）。`ucdavis-coffee-center` 例外 claim 已含两条 sensory/roasting claim ✅；`baratza-documents` 例外 claim 含 `claim.grinding.manual-not-recipe` ✅；allowed_sample_ids 分别为 [b2a-005, b2a-008] / [b2a-006, b1-009, b1-017] → **落库时并入 b2b-004**。

### E. 行为风险
- 是否避免单变量归因：✅——差异来源以四方向清单并列，明确「有了信息才能指出差异在哪一项」，未挑选单一替罪羊；不编造用户豆子信息。

### F. 与已有 approved 差异
- **新增能力**：「参数相同≠结果相同」的条件归因——b2a-006 训练过刻度不跨磨豆机换算（单点知识），本条把它整合为完整的多变量对齐方法论。

### G. 最大行为风险
1. 四方向清单可能诱导模型在信息不足时也硬填原因——回答以「需要知道…才能指出差异」封口。
2. 「同一批豆子改变冲法味道明显不同」的强事实可能被泛化为「参数完全不重要」——回答保留「逐项对齐」的可执行路径平衡。
3. 水质方向无 claim 支撑（知识库无水质 claim）——回答仅作清单项列出、不展开机理，风险可控。

### H. 建议动作
- `approve_candidate`（人工参考；落库时同步样本范围对齐）。

---

## b2b-005 ｜ 「花香没有了怎么办？」——从感知到诊断

### A. 内容摘要
- **用户问题类型**：感知变化报告（花香消失）+ 用户自带单因假设（水温）。
- **模型目标能力**：从感知描述到诊断路径（multi_variable_reasoning）——先问基线再分流。
- **预期训练行为**：先确认基线（同包随时间 vs 换豆/换参数）；两条排查路径分别给 F 支撑；拒绝单操作回答。

### B. Interaction 能力审核
- interaction_skill=multi_variable_reasoning；missing_information_handling=确认开封时长/烘焙日期/冲法是否变化以分流。✅ 符合「先收集信息再建议」。
- 未顺着用户的「提高水温」走：开篇「先不要直接动水温」。

### C. F/P/I 审核
- **F**：NCA 烘焙后几乎立即失去新鲜度（`claim.freshness.nca-lose-freshness-immediately`，nca-aboutcoffee）；风味轮廓由 TDS/EY 划分（`claim.sensory.brewing-chart-profiles`）+ 同豆不同萃（`claim.sensory.same-bean-different-brew`），均 ucdavis。
- **P**：分支验证路径（先基线后方向）。
- **I**：香气感知与烘焙度/品种的关系——「需要进一步确认，本知识库未含花香形成的化学机理 claim，不作归因」。✅ 无层级伪装；机理边界显式声明。

### D. 来源准入
- **BLOCK**（唯一缺口：样本范围）。`nca-aboutcoffee` 例外 claim 含 `claim.freshness.nca-lose-freshness-immediately` ✅；`ucdavis-coffee-center` 例外 claim 已含两条 ✅；allowed_sample_ids 分别为 [b2a-009, b2a-010] / [b2a-005, b2a-008] → **落库时并入 b2b-005**。

### E. 行为风险
- 是否先收集信息再建议：✅——路径分流前先要求两项信息；「提高温度」式单操作回答未出现。
- 花香机制保持核验边界（与 b2a-008 同一边界）：零化合物归因。

### F. 与已有 approved 差异
- **新增能力**：「变化类问题」的诊断——batch2a 的新鲜度样本（b2a-009/010）训练静态知识（何时失鲜/储存），本条训练「感知随时间变化时的基线确认与双路径分流」，并与用户自带的错误假设（水温）进行温和纠偏。

### G. 最大行为风险
1. 「先问基线」可能被学成机械反问——回答同时给出两条路径的完整判断依据，反问有实质内容。
2. 「风味变平→换新鲜豆」的建议依赖用户能买到新鲜豆——建议中保留「带着记录来排查」的替代路径。
3. 双来源样本（ucdavis+nca）claim 并集语义依赖六点五-C 修复——门禁已验证通过。

### H. 建议动作
- `approve_candidate`（人工参考；落库时同步样本范围对齐）。

---

## b2b-006 ｜ 「25 秒一定好吗？」——时间是读数不是目标

### A. 内容摘要
- **用户问题类型**：把单一数字当目标（时间迷信）。
- **模型目标能力**：boundary_setting——把目标数字转化为观察指标。
- **预期训练行为**：时间=读数；Fellow 配方带完整语境；拒绝「25 秒最好」同时避免「时间没用」反向绝对化。

### B. Interaction 能力审核
- interaction_skill=boundary_setting；missing_information_handling=请提供粉量/比例、实际时间与味道表现。✅ 符合条件化回答。
- 「还需要知道」段 + 「如果观察到…可以尝试…如果情况不同…重新判断」条件化建议（GPT 规则 3 ✅）。

### C. F/P/I 审核
- **F**：shot 时间作诊断证据、流太慢对应磨粗微调（`rule.fellow.shot-slow`，fellow-espresso-basics）；Fellow 配方 1:3/22–25 秒含预浸泡语境（`claim.espresso.fellow-ratio-1to3`，同源）。
- **P**：时间配合味道定位方向的经验做法。
- **I**：合理窗口因豆因机而异——「需要进一步确认」限定。✅ 无层级伪装。

### D. 来源准入
- **BLOCK**（唯一缺口：样本范围）。`fellow-espresso-basics` 例外 claim 已含两条 ✅；allowed_sample_ids=[b1-014, b1-015, b1-016, b2a-001, b2a-002, b2a-003, b2a-004] → **落库时并入 b2b-006**。

### E. 行为风险
- 是否避免时间崇拜：✅——开篇「把 25 秒当目标，方向就反了」；「时间是多少就记录多少——不必强求 25 秒，也不必把时间当成绩」。
- 反向绝对化同样避免：时间被赋予「诊断证据」的正面定位，未被贬为「无用」。

### F. 与已有 approved 差异
- **新增能力**：「数字目标化」的纠偏——b2a-003 已训练时间=读数（解释型），本条场景更尖锐（用户明确要「卡」在 25 秒），训练「目标→指标」的转化话术，并示范「配方数字与语境绑定」的正确引用方式。

### G. 最大行为风险
1. 「Fellow 配方 22–25 秒」可能被脱语境引用——回答内已绑定粉量/比例/预浸泡完整语境，并显式警告「单独抽出来当标准时间没有意义」。
2. 与 b2a-003 存在主题接近——差异化在于场景（目标化请求 vs 开放提问）与行为（转化 vs 解释），非重复。
3. 中风险定级（plan）：单因归因惯性已在结构上规避。

### H. 建议动作
- `approve_candidate`（人工参考；落库时同步样本范围对齐）。

---

## b2b-007 ｜ 「每天喝咖啡一定健康吗？」——健康边界

### A. 内容摘要
- **用户问题类型**：寻求健康结论（二元化提问）。
- **模型目标能力**：健康边界（boundary_setting）——引用官方参考值但不诊断、不承诺。
- **预期训练行为**：参考信息 + 个体差异 + 非医疗建议边界三要素；引导就医路径；不推断阈值。

### B. Interaction 能力审核
- interaction_skill=boundary_setting；missing_information_handling=健康话题**不**向用户收集代谢细节做推断，而是引导结合自身用药/健康状况咨询医疗人员——这是「信息不足时不编造」在健康场景的正确形态。✅ 符合。

### C. F/P/I 审核
- **F**：FDA 400 mg 参考口径（`claim.health.fda-400`）；「too much 因人而异」声明（`claim.health.fda-variance`），均 fda-caffeine（自动准入，public-domain）。
- **P**：观察自身反应的常见做法（睡眠/心悸/肠胃）。
- **I**：**无健康推断**——reasoning_level 明确 I 层不推断健康结论，仅指向观察与就医路径。✅ 无层级伪装；「一般不与负面影响相关」为 FDA 原文口径的忠实转述。

### D. 来源准入
- **PASS** ✅（fda-caffeine：status=active + public-domain + commercialUse/derivatives allowed，自动准入，无需例外）。
- 未引用任何 efsa-* claim（efsa-caffeine-opinion 无例外，plan 明确禁用）✅。

### E. 行为风险
- 健康边界三要素齐备：✅ 参考信息（FDA 400mg）+ ✅ 个体差异（体重/用药/疾病/敏感性）+ ✅ 非医疗建议边界声明（「不构成医疗建议，也不能替代医生」）。
- 禁止项全规避：无健康承诺、无疾病判断、无「每天喝 X 一定没问题」、无未核验阈值（400mg/2–3 杯/12 fl oz 全部在 FDA claim 语境内）。

### F. 与已有 approved 差异
- **新增能力**：健康话题的边界行为——现有 14 条 approved 无任何健康主题样本；本条是首个「高风险领域拒答式回答」训练样本，其「给参考口径 + 拒绝个人化结论 + 指向专业路径」的结构可迁移到其它高危话题。

### G. 最大行为风险
1. 「400 mg 一般没问题」可能被模型截取为无条件承诺——回答将口径与「多数成人」「一般」限定词绑定，并紧接个体差异段。
2. 用户可能追问个人化剂量——回答已预置「健康话题不推断具体阈值」的边界。
3. FDA 口径为美国权威而非医学诊断——回答定位为「公开健康机构的参考口径」而非医疗意见，准确。

### H. 建议动作
- `approve_candidate`（人工参考；唯一来源准入 PASS，无需例外对齐）。

---

## b2b-008 ｜ 「这个豆子为什么有茉莉花香？」——不知道能力

### A. 内容摘要
- **用户问题类型**：具体豆子的具体风味成因追问（知识库无对应 claim）。
- **模型目标能力**：不确定性表达 + 不编造（uncertainty_handling，幻觉防线）。
- **预期训练行为**：明确「当前信息不足」；列所需信息；给获得答案的现实路径；「不知道」表述为能力。

### B. Interaction 能力审核
- interaction_skill=uncertainty_handling；missing_information_handling=产地/处理法/烘焙度/干香湿香描述 + 三条获答路径（厂商信息/询问烘焙商/对照冲煮）。✅ 符合「信息不足时不编造」。
- uncertainty_expression_check（六点九-C 新门禁）：「当前信息不足，无法判断唯一原因」✅。

### C. F/P/I 审核
- **F**：仅两条一般性框架 claim（`claim.sensory.brewing-chart-profiles` / `claim.sensory.same-bean-different-brew`，ucdavis）——未延伸到花香机理。
- **P**：无（本条刻意不含经验性断言，避免给「听起来专业」的伪解释）。
- **I**：茉莉花香具体成因——「当前信息不足、无法判断唯一原因」「可能与产地和处理法的组合有关，需要进一步确认」「可以推断萃取在其中起了作用」（条件式）。✅ 无 F 冒充 I / I 冒充 F。
- **零编造声明**：回答明示「本知识库中没有能支撑『茉莉花香由某种特定化合物带来』的结论，所以我不编造化学物质名称或机理」（GPT 规则 6 ✅）。

### D. 来源准入
- **BLOCK**（唯一缺口：样本范围）。`ucdavis-coffee-center` 例外 claim 已含两条 ✅；allowed_sample_ids=[b2a-005, b2a-008] → **落库时并入 b2b-008**。

### E. 行为风险
- 不知道能力：✅——「当前信息不足」明确表述；无化合物/温度/萃取率机理（GPT 禁止项零命中）；结尾把「当前不知道」定位为「比接受编造的机理更接近真相」的能力表述。
- strong_claim_context_check：「唯一原因」命中 → negation-context pass。

### F. 与已有 approved 差异
- **新增能力**：信息不足情况下拒绝生成虚假风味解释——b2a-008 已训练「花香机制不归因」（守边界），本条训练「主动承认不知道 + 把不知道转化为可执行的信息收集与获答路径」（进攻性边界），是 GPT 评定最高价值的幻觉防线样本。

### G. 最大行为风险
1. 「不知道」可能被模型泛化为对一切风味问题的回避——回答对一般性框架（TDS/EY/多因）仍给出 F 支撑，边界只落在「具体化合物归因」。
2. 「可能与产地和处理法有关」的 I 层表述可能被当成隐含答案——已绑定「需要进一步确认」与排查清单定位。
3. 最高风险定级（plan/GPT）：任何后续改写都不得引入机理内容；本审核包确认现稿零命中。

### H. 建议动作
- `approve_candidate`（人工参考；落库时同步样本范围对齐）。

---

## 审核包使用说明（给负责人）

- **建议动作仅为参考**，批准与否由负责人拍板；批准后走既有落库流程
  （approval_execution_template + check_approval_ready dry-run + 双哈希登记）。
- 7 条 BLOCK 的处置：落库登记时把对应 b2b 样本 ID 并入既有例外
  `allowed_sample_ids`（claim 维度零缺口，无需新增例外、无需改 allowed_claim_ids）。
- batch2a 落库经验可直接复用；approved 从 14 → 22 后距训练阈值还差 3–5 条高价值
  样本（GPT 路线：补齐后 train ≥15 → 第一次 mlx-lm dry-run，目前训练冻结）。
