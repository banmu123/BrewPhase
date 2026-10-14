# Batch2b 候选设计（阶段六点九，2026-10-14）

> **只出 plan，不写候选**——流程：candidate plan ✓ → source check ✓（全部已有例外/自动准入）
> → draft（待下一轮指令）→ quality gate → human review。
> 目标：补齐 BrewPhase 最重要的「交互能力」（澄清/纠偏/拒答/条件化/不确定性表达），
> 不是扩大主题。预期批准后 approved 14 → 22 左右、train 11 → 17+。
> **本 plan 全部 18 个 claim 引用已验证真实存在（零新增 claim、零编造来源）。**

## 新增写作硬规则（GPT 指定，写入每条 metadata）

1. metadata 增加 `interaction_skill`（训练的交互能力）与 `missing_information_handling`
   （信息不足时的处理方式）字段；
2. 每个回答**强制包含「下一步建议」**：用户现在可以做什么 + 下一次需要提供什么信息；
3. **禁止纯参数答案**（❌「改成 93°C、30 秒」）——必须「可以尝试调整某变量，但需结合
   当前表现判断」；
4. **增加「不知道」能力**：允许「当前信息不足，无法判断唯一原因」；禁止「可能是 X，
   所以一定调整 Y」。

## 来源策略（GPT 指定）

- **Batch2b-A：只用已有来源**（Hario / Fellow / NCA / UC Davis / FDA / Stumptown /
  Baratza / Gaggia）——本 plan 8 条全部满足，**无需新增例外**；
- Batch2b-B（SCA / WCR / Hoffmann 官网）暂不启用；如未来需要，必须先 evidence packet。

---

## b2b-001 ｜ 用户只说「咖啡很酸」——问题澄清

- **id**: b2b-001 ｜ **title**: 咖啡很酸怎么办？先澄清再判断
- **user_scenario**: 用户只给「我的咖啡很酸怎么办？」——未说明器具、豆子、酸的类型
- **training_skill**: 问题澄清（不直接下结论）
- **answer_structure**: A 不直接给调整方向 → B 需要区分的酸类型（果酸 vs 尖锐刺激）与
  缺失信息清单 → C 各类型对应的不同处理方向 → 下一步建议
- **expected_FPI**: F=酸质是固有风味特征且类型多样（ta-sourness-correlation）；
  P=澄清式诊断流程；I=具体原因（需用户补充信息后才能判断）
- **claim_ids**: ["claim.roasting.ta-sourness-correlation"]
- **source_status**: ucdavis-coffee-center（例外已登记，b2a-005 同源）——**可立即写**
- **risk_notes**: 禁止复刻「酸=欠萃」；澄清问题本身不给结论
- **interaction_skill**: 主动追问缺失信息（器具/豆子/酸的类型/冲煮参数）
- **missing_information_handling**: 列出判断所需的最小信息集，说明每项信息能排除什么
- **training_value**: ★★★★★（澄清是交互能力基石）

## b2b-002 ｜ 参数冲突判断

- **id**: b2b-002 ｜ **title**: 用户给出的参数互相矛盾时看什么
- **user_scenario**: 「我 18g 粉、300g 水，但是 30 秒就流完了」——比例合理但时间异常
- **training_skill**: 多变量矛盾时的优先级判断（不抓单参数）
- **answer_structure**: A 指出矛盾点（比例正常但流速异常快）→ B 变量优先级
  （研磨/粉层/器具通道）→ C 验证顺序 → 下一步建议
- **expected_FPI**: F=不存在唯一标准参数、同品牌配方都不同（conflict claim）；
  P=流速是研磨匹配度的直接观察证据；I=具体原因（需看研磨度与粉层）
- **claim_ids**: ["conflict.v60.official-recipes-differ", "rule.hario.v60.too-weak"]
- **source_status**: hario-v60-expert-guide（例外已含 b2b 场景外的样本——需确认
  allowed_sample_ids 登记时加入 b2b-002，或登记时并入）——**可立即写（登记时对齐范围）**
- **risk_notes**: 禁止「最佳参数」；不忽略矛盾信号
- **interaction_skill**: 识别参数间矛盾并排序验证优先级
- **missing_information_handling**: 请用户提供研磨刻度与器具型号
- **training_value**: ★★★★☆

## b2b-003 ｜ 黄金参数请求纠偏

- **id**: b2b-003 ｜ **title**: 「给我一个 V60 黄金比例」的正确回应
- **user_scenario**: 用户直接索要「黄金比例/最佳参数」
- **training_skill**: 拒答/纠偏（不拒绝咖啡问题本身，拒绝「唯一答案」框架）
- **answer_structure**: A 没有适用于所有豆子的黄金参数（F：同品牌配方都不同）→
  B 提供已核验的起点配方（Hario 官方 15g/250g 与 Hoffmann 30g/500mL，注明来源与语境）
  → C 如何根据豆子调整 → 下一步建议
- **expected_FPI**: F=官方与署名配方并存且数值不同 + 两个配方的具体数字；
  P=起点→调整的使用方式；I=用户豆子的适配判断
- **claim_ids**: ["conflict.v60.official-recipes-differ", "claim.pourover.v60-official-expert",
  "claim.pourover.v60-hoffmann-recipe"]
- **source_status**: hario-v60-expert-guide + hario-v60-hoffmann（例外已登记）——**可立即写**
- **risk_notes**: 禁止「黄金比例」表述本身；起点配方必须带来源与语境；禁止把 Hoffmann
  配方说成行业标准
- **interaction_skill**: 把「要答案」转化为「给起点+教调整」
- **missing_information_handling**: 请用户说明豆子烘焙度与器具版本以选起点
- **training_value**: ★★★★★（拒答/纠偏是小模型微调价值最高的能力之一）

## b2b-004 ｜ 同参数不同豆子

- **id**: b2b-004 ｜ **title**: 「别人 15g/250ml 很好，我同样参数为什么不好？」
- **user_scenario**: 用户复制他人参数得不到相同结果
- **training_skill**: 条件化回答（参数不可脱离豆子复制）
- **answer_structure**: A 参数相同≠结果相同 → B 差异来源（烘焙/新鲜度/研磨实际粒度/
  水质）→ C 逐项对齐方法 → 下一步建议
- **expected_FPI**: F=同豆不同萃尚且味道明显不同（same-bean-different-brew）+
  烘焙控制滴定酸（ta-peaks-first-crack）+ 刻度不能跨磨豆机换算（manual-not-recipe）；
  P=逐项对齐对比法；I=用户豆子的具体差异
- **claim_ids**: ["claim.sensory.same-bean-different-brew", "claim.roasting.ta-peaks-first-crack",
  "claim.grinding.manual-not-recipe"]
- **source_status**: ucdavis-coffee-center + baratza-documents（例外均已登记）——**可立即写**
- **risk_notes**: 禁止「照搬参数就行」；禁止编造用户豆子的信息
- **interaction_skill**: 把「复制参数」转化为「对齐条件」
- **missing_information_handling**: 列出需要对齐的变量清单（豆子烘焙度/新鲜度/磨豆机型号/水）
- **training_value**: ★★★★☆

## b2b-005 ｜ 风味描述 → 操作建议

- **id**: b2b-005 ｜ **title**: 「花香没有了怎么办？」——从感知到诊断
- **user_scenario**: 用户报告花香消失，寻求操作建议
- **training_skill**: 从感知描述到诊断路径（不跳到单一操作）
- **answer_structure**: A 先确认基线（原本有没有花香？）→ B 可能因素（豆子新鲜度/
  烘焙/冲法变化）→ C 分支验证 → 下一步建议
- **expected_FPI**: F=风味轮廓由 TDS+EY 划分（chart-profiles）+ 同豆不同萃 +
  失鲜时机（nca-lose-freshness-immediately）；P=分支验证；I=具体归因
- **claim_ids**: ["claim.sensory.brewing-chart-profiles", "claim.sensory.same-bean-different-brew",
  "claim.freshness.nca-lose-freshness-immediately"]
- **source_status**: ucdavis-coffee-center + nca-aboutcoffee（例外均已登记）——**可立即写**
- **risk_notes**: 禁止「提高温度」式单操作回答；花香机制保持核验边界（同 b2a-008）
- **interaction_skill**: 先问基线（原本有没有）再诊断变化
- **missing_information_handling**: 请用户确认豆子开封时长/烘焙日期/冲法是否变化
- **training_value**: ★★★★☆

## b2b-006 ｜ 意式时间迷信

- **id**: b2b-006 ｜ **title**: 「25 秒一定好吗？」
- **user_scenario**: 用户把某个时间数字当作目标
- **training_skill**: 时间是诊断指标不是目标（与 b2a-003 呼应但场景更尖锐）
- **answer_structure**: A 时间是读数 → B 时间与粉量/研磨/比例的联动 → C 用时间定位
  方向的方法 → 下一步建议
- **expected_FPI**: F=Fellow 把 shot 时间当诊断证据（流太慢→磨细）+ 官方比例语境；
  P=联动调整法；I=用户设备的合理窗口
- **claim_ids**: ["rule.fellow.shot-slow", "claim.espresso.fellow-ratio-1to3"]
- **source_status**: fellow-espresso-basics（例外已登记）——**可立即写**
- **risk_notes**: 禁止「25 秒最好」；也禁止「时间没用」的反向绝对化
- **interaction_skill**: 把目标数字转化为观察指标
- **missing_information_handling**: 请用户提供粉量/比例与流速表现
- **training_value**: ★★★☆☆

## b2b-007 ｜ 健康边界

- **id**: b2b-007 ｜ **title**: 「每天喝咖啡一定健康吗？」
- **user_scenario**: 用户寻求健康结论
- **training_skill**: 健康边界（引用官方参考值但不诊断、不承诺）
- **answer_structure**: A 官方参考口径（FDA 400mg + 个体差异）→ B 适用范围与限制
  → C 明确不构成医疗建议 → 下一步建议（咨询医疗人员的情形）
- **expected_FPI**: F=FDA 每日参考值 + 个体差异声明（fda-400/fda-variance，FDA 页逐句
  核验）；P=观察自身反应；I=无（健康话题不推断）
- **claim_ids**: ["claim.health.fda-400", "claim.health.fda-variance"]
- **source_status**: fda-caffeine（**自动准入**，public-domain 全 allowed，无需例外）
  ——**可立即写**；注意不引用 efsa-* claims（efsa-caffeine-opinion 无例外）
- **risk_notes**: 不能诊断；不给「一定健康/不健康」结论；不补未核验阈值
- **interaction_skill**: 用官方参考+边界声明回应健康问题
- **missing_information_handling**: 请用户结合自身用药/健康状况咨询医疗人员
- **training_value**: ★★★★☆（健康边界是高风险高价值能力）

## b2b-008 ｜ AI 不知道时怎么办（GPT：最高价值）

- **id**: b2b-008 ｜ **title**: 「这个豆子为什么有茉莉花香？」——知识不足时的正确行为
- **user_scenario**: 用户问具体豆子的具体风味成因，知识库无对应 claim
- **training_skill**: 不确定性表达 + 不编造（hallucination 防线）
- **answer_structure**: A 如实说明当前信息不足 → B 提供一般性框架（风味表现由多因
  决定——F）→ C 请用户提供产地/处理法/烘焙度 → 下一步建议
- **expected_FPI**: F=风味轮廓多因划分（chart-profiles）+ 同豆不同萃（same-bean-
  different-brew）作一般性框架；I=具体豆子的花香成因（明确标注「当前无法判断」）；
  **禁止编造化学物质/分子来源/阈值**
- **claim_ids**: ["claim.sensory.brewing-chart-profiles", "claim.sensory.same-bean-different-brew"]
- **source_status**: ucdavis-coffee-center（例外已登记）——**可立即写**
- **risk_notes**: 这是幻觉防线样本——任何「茉莉花香来自 X 分子」式回答都违规；
  「不知道」要表述为能力而非缺陷
- **interaction_skill**: 承认边界 + 请求补充信息 + 给出获得答案的路径
- **missing_information_handling**: 产地/处理法/烘焙度/干香湿香描述
- **training_value**: ★★★★★（GPT：最高价值）

---

## 汇总（GPT 要求的三项报告数据）

| 维度 | 结果 |
|---|---|
| **可立即写数量** | **8/8**（全部 claim 已入库、来源全部已有例外或自动准入） |
| **依赖来源数量** | 7 个（ucdavis / hario-expert / hoffmann / baratza / nca / fda / fellow）——全部已有例外或自动准入，无需新增；b2b-002/003 落库时需把 b2b 样本 ID 并入 hario/hoffmann 例外的 allowed_sample_ids（登记时对齐，属既有例外的样本范围对齐而非新授权） |
| **风险分类** | 高幻觉风险：b2b-003/008（黄金参数/花香机制）；高健康风险：b2b-007；中风险：b2b-001/002/004/005/006（单因归因惯性） |

## 流程纪律（GPT 指定）

> 这一轮之后不要急着写 8 条：candidate plan ✓ → source check ✓ → draft → quality gate →
> human review。保持纪律，而不是追求数量。
