# Batch2a 首轮候选选题设计（阶段六点一）

> 日期：2026-10-14 ｜ 依据：BATCH2_WRITING_SPEC.md（冻结）+ GPT 选题方向
> **本文件只设计选题，不生成 JSONL、不修改 Batch1/例外表/准入规则。**
> claim_ids 已逐个对照知识库现有 ID（构建器反向校验标准）；「需新增」标注 = 写作前
> 必须先补 claim（含来源核验），否则构建器会拒绝。

## 意式 dial-in（4 条）

### b2a-001 ｜ 我的浓缩喝起来很酸，是豆子的问题吗？

- topic: espresso ｜ 训练能力: **多因诊断**（酸≠豆子问题≠萃取不足，三路分因）
- 预期 reasoning_level: F（Fellow 酸→磨细映射）+ I（豆子明亮酸质可能性）
- 可能关联 claim_ids: `rule.fellow.shot-sour`、`claim.extraction.channeling-vendor`、
  `claim.roasting.acidity-study`（✅已有——烘焙对酸质的影响，支撑「豆子风味」分路）
- 候选来源: fellow-espresso-basics（✅已准入）；roasting claim 来源待核（acidity-study 的
  UC Davis 研究页）
- 风险点: 与 b1-014/016 同故障树——**必须差异化**（b1-014 单症状调整，本条训练「是不是
  豆子问题」的归因判断）；烘焙 claim 来源未核验
- training_value: **high**

### b2a-002 ｜ 浓缩入口苦，还有明显干涩感，怎么调整？

- topic: espresso ｜ 训练能力: **术语区分**（bitter ≠ chalky 粉感 ≠ astringent 涩感）
- 预期 reasoning_level: F（chalky/bitter→磨粗）+ P（调整幅度：微调）
- 可能关联 claim_ids: `rule.fellow.shot-bitter`、`claim.defects.roast-level-acrid`
- 候选来源: fellow-espresso-basics（✅已准入）
- 风险点: 用户口语「干涩」需按冻结策略 B 处理（保留+解释粉感/涩感区别）
- training_value: **high**

### b2a-003 ｜ 萃取时间 25 秒和 35 秒哪个更好？

- topic: espresso ｜ 训练能力: **反时间崇拜**（时间是指针不是目标，绑定流速/风味证据）
- 预期 reasoning_level: F（shot time 偏长→磨粗的 rule 语境）+ P（时间窗口因配比而异）
- 可能关联 claim_ids: `rule.fellow.shot-slow`（✅已有：evidence=shot time 偏长）、
  `claim.espresso.fellow-ratio-1to3`（✅已有）
- 候选来源: fellow-espresso-basics（✅已准入）
- 风险点: 「哪个更好」必须拒绝单答案——回答框架是「时间告诉你该往哪个方向调，不是好坏」
- training_value: medium

### b2a-004 ｜ 咖啡机压力正常，但通道效应明显，怎么办？

- topic: espresso ｜ 训练能力: **espresso troubleshooting**（布粉/填压/通道效应路径）
- 预期 reasoning_level: F（厂商第一近似）+ I（布粉/填压细节=待补证，知识库已标注）
- 可能关联 claim_ids: `claim.extraction.channeling-vendor`、`rule.gaggia.no-crema`（✅已有，
  豆子状态/crema 语境）
- 候选来源: fellow-espresso-basics（✅已准入）+ gaggia-classic-manual（未准入，需例外提案）
- 风险点: 通道效应的细粒度机理知识库标注「待补证」——回答必须诚实保留该边界
- training_value: **high**

## 手冲诊断（4 条）

### b2a-005 ｜ 手冲很酸怎么办？

- topic: pour-over diagnosis ｜ 训练能力: **经典多因诊断**（酸=萃取不足 or 明亮酸质 or 水温）
- 预期 reasoning_level: F（官方调参方向）+ P（对比冲煮方法）+ I（豆子酸质）
- 可能关联 claim_ids: `claim.pourover.v60-official-tuning`（✅）、`rule.hario.v60.too-weak`（✅，
  弱与酸的萃取方向关联）；**需新增**：「手冲偏酸→萃取不足方向」的显式 claim
  （brewing-variables 有方向性表述，提取成 claim 并核验来源）
- 候选来源: hario-v60-expert-guide（✅已准入）
- 风险点: 与 b1-012（淡）区分——本条是「酸」且要覆盖「明亮酸质≠缺陷」（引用 b1-016 模式）
- training_value: **high**

### b2a-006 ｜ 手冲味道很淡，但粉水比例没有问题

- topic: pour-over diagnosis ｜ 训练能力: **多变量分析**（排除了比例之后还有什么）
- 预期 reasoning_level: F（研磨→太淡）+ P（逐一排查法）+ I（水质/豆况）
- 可能关联 claim_ids: `rule.hario.v60.too-weak`（✅）、`claim.grinding.manual-not-recipe`（✅）、
  `claim.grinding.fellow-grind-reference`（✅）
- 候选来源: hario-v60-expert-guide（✅已准入）+ baratza-documents（未准入，需例外提案）
- 风险点: 「比例没问题」是用户自述——回答应先教验证比例（秤/注水量），再走研磨
- training_value: **high**

### b2a-007 ｜ 为什么同一包豆子换水后味道变化很大？

- topic: pour-over diagnosis ｜ 训练能力: **水变量认知**
- 预期 reasoning_level: I（知识库当前无水质 claim——**需新增**：水硬度/TDS 对萃取的影响，
  来源待核验，如 SCA 水质手册或 UC Davis 研究）
- 可能关联 claim_ids: **缺失**——需新增 `claim.water.*`（写作前先核验来源并补 claim）
- 候选来源: 待定（SCA 水质资料 / 第三方研究——许可与准入需先调查）
- 风险点: 知识库零基础，全部依赖新来源核验；不得凭常识写
- training_value: medium

### b2a-008 ｜ 为什么别人冲出来有花香，我没有？

- topic: pour-over diagnosis ｜ 训练能力: **风味表达与萃取/新鲜度/豆况的关系**
- 预期 reasoning_level: F（萃取不足会压制风味强度——需新增 claim）+ P（豆子新鲜度检查）+ I（豆子本身无花香）
- 可能关联 claim_ids: `claim.freshness.resting-varies-by-roast`（✅部分支持）；
  **需新增**：「萃取不足→风味强度下降」显式 claim
- 候选来源: hario-v60-expert-guide（✅）+ freshness.md 现有 claim（✅已准入来源链）
- 风险点: 「花香」具体描述不可编造——只能做「为什么风味弱」的通用分析 + 建议核对豆子信息
- training_value: medium

## 新鲜度（2 条）

### b2a-009 ｜ 咖啡豆放久了一定不好喝吗？

- topic: freshness ｜ 训练能力: **反黄金期限**（新鲜度≠线性衰减，与烘焙度/包装/储存相关）
- 预期 reasoning_level: F（养豆窗口按烘焙度不同）+ I（「放久了」的感官方向因豆而异）
- 可能关联 claim_ids: `claim.freshness.resting-varies-by-roast`（✅）、
  `claim.freshness.dark-roast-rest-5-7d`（✅案例）、`claim.freshness.light-roast-rest-4-6w`（✅案例）、
  `claim.freshness.storage-research`（✅已有——储存研究条目，核验其内容后引用）
- 候选来源: fellow-brew-talks（未准入，需例外提案）
- 风险点: 禁止给出「X 天后不能喝」类数字；「好喝」是主观判断，回答必须区分客观新鲜度与个人偏好
- training_value: medium

### b2a-010 ｜ 为什么同一包豆子刚开封和一周后味道不同？

- topic: freshness ｜ 训练能力: **新鲜度机理解释**（排气/氧化，带时间语境）
- 预期 reasoning_level: F（养豆窗口案例）+ I（排气/氧化机理——**需新增**机理 claim，
  来源待核验；知识库当前只有窗口案例没有机理）
- 可能关联 claim_ids: `claim.freshness.dark-roast-rest-5-7d`（✅）、
  `claim.freshness.resting-varies-by-roast`（✅）；需新增「二氧化碳排出/氧化」机理 claim
- 候选来源: fellow-brew-talks（未准入）或 SCA handbook（`claim.freshness.sca-handbook-exists` ✅
  已有条目——核验其来源内容）
- 风险点: 机理句容易写成无来源断言（b1-015 教训）——先补 claim 再写
- training_value: medium

## 汇总

| ID | 主题 | 来源准入 | claim 缺口 | training_value |
|---|---|---|---|---|
| b2a-001 | 意式酸·多因归因 | ✅（fellow 已准入） | acidity-study 来源待核 | high |
| b2a-002 | 意式苦/粉感区分 | ✅ | 无 | high |
| b2a-003 | 时间反崇拜 | ✅ | 无 | medium |
| b2a-004 | 通道效应 | ⚠️ 需 gaggia 例外 | 机理待补证（已有标注） | high |
| b2a-005 | 手冲酸·经典诊断 | ✅（hario 已准入） | 需新增「酸→萃取方向」claim | high |
| b2a-006 | 手冲淡·多变量 | ⚠️ 需 baratza 例外 | 无 | high |
| b2a-007 | 水变量 | ❌ 来源未定 | 需新增水质 claim（先核验来源） | medium |
| b2a-008 | 花香·风味强度 | ✅（部分） | 需新增「萃取→风味强度」claim | medium |
| b2a-009 | 反黄金期限 | ⚠️ 需 fellow-brew-talks 例外 | 无（storage-research 已有） | medium |
| b2a-010 | 新鲜度机理 | ⚠️ 需例外/SCA 核验 | 需新增排气/氧化机理 claim | medium |

## 写作顺序建议（按依赖）

1. **立即写作**（来源已准入 + claim 齐全）：b2a-002、b2a-003、b2a-009（若 fellow-brew-talks
   例外暂缓则改引 storage-research，先核验其内容）
2. **补 claim 后写作**：b2a-005、b2a-008、b2a-010（先核验来源补 claim）
3. **补例外后写作**：b2a-001（acidity 来源）、b2a-004（gaggia）、b2a-006（baratza）、
   b2a-007（水质来源调查）
