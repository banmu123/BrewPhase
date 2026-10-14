# Batch 2 数据扩展规划（阶段五点八）

> 日期：2026-10-14 ｜ 依据：GPT 阶段五点八提示词 + 第一批 5 条 approved 的经验
> 目标：Batch2 新增 **20–40 条 approved**（总量 25–45）后再启动第一次训练。
> 本文件只是规划——不生成样本、不改例外、不动 batch1、不训练。

## 一、推荐主题与数量（按训练价值排序）

| 优先 | 主题 | 计划数量 | 训练什么能力 | 来源依赖 |
|---|---|---|---|---|
| P0 | **意式 dial-in 诊断**（输入参数+症状→诊断路径） | 8–10 | 结构化诊断：18g/36g/25s/酸 → 多证据分析，不是「酸=研磨粗」单因反射 | fellow-espresso-basics（已核验，剩余条目：shot-slow、milk 系列、双壁滤杯）+ gaggia/sage 手册（待核验） |
| P0 | **手冲诊断**（症状→原因→证据→调整） | 6–8 | 与意式对称的手冲故障树；苦/涩/寡淡分别归因 | hario-v60-expert-guide（已核验）+ stumptown-kalita-guide（待核验，解锁 b1-006 同类） |
| P1 | **新鲜度与储存** | 4–6 | 按烘焙度/包装/萃取方式解释风味变化，拒绝「统一天数」 | fellow-brew-talks 养豆系列（待核验：具体批次文章） |
| P1 | **配方语境化**（如 b1-025 模式） | 3–4 | 「某配方来自谁、什么语境」——防教条化 | hario-v60-hoffmann（已核验）+ hario-recipe-cards（待核验） |
| P2 | **冷萃研究结论转述** | 2–3 | 研究结论的适用范围表述（不夸大） | ucdavis-coldbrew-2025（待核验） |
| P2 | **健康口径**（FDA 已核验扩展） | 2–3 | 官方参考值 vs 个人建议的边界 | fda-caffeine（已核验）+ efsa 正文（sleep-100 待核） |
| P2 | **磨豆与设备迁移** | 2–3 | 刻度不可换算、基准重建方法 | baratza-documents + aeropress（待核验） |
| P2 | **不确定性/拒答示范** | 2–3 | 信息不足时诚实拒答+追问（延续 b1-023/024 能力线） | 已核验来源即可 |

**合计规划：29–40 条候选 → 审核 → 目标 20–40 approved。**

## 二、来源规划与核验顺序

1. **已核验可直接用**（4 个）：hario-v60-expert-guide、fellow-espresso-basics、fda-caffeine、
   hario-v60-hoffmann（+ WCR 首页框架）——P0 意式/手冲主题可立即开工。
2. **下一轮需核验**（按候选依赖）：
   - stumptown-kalita-guide（解锁 b1-006 + Kalita 新候选）
   - fellow-brew-talks 养豆批次文章（b1-019/020 佐证 + 新鲜度扩展）
   - UC Davis 冷萃研究原文（b1-018/022 佐证）
   - efsa opinion 正文（b1-029 sleep-100）
   - sage/gaggia 手册（意式维护类）
3. **例外需求**：stumptown-kalita-guide、hario-v60-hoffmann、fellow-brew-talks、
   ucdavis-coldbrew-2025 等将需要各自的方案 A 提案（每来源单独走审批）。

## 三、风险点

1. **同组冗余**：诊断类容易写成同一故障树的换皮——每条必须验证「训练能力不同」
   （参照 b1-008/024 的教训，冗余候选在审核阶段会被砍）。
2. **数字类 claim**：所有具体数字（水温/比例/时长）必须逐个外部核验后才可写成 F 层；
   核验不到 → P/I 层带标注（CLAIM_POLICY）。
3. **术语纪律**：weak→寡淡、chalky→粉感、astringent→涩感不得混用（term_decision_freeze）。
4. **厂商近似**：Fellow/Hario 口径必须保留「第一近似」限定语，不得写成普适规律。
5. **来源许可**：新来源（stumptown/ucdavis 等）准入前需各自例外提案——写作时优先选
   已核验+已准入来源，减少例外审批压力。

## 四、预计训练价值

- **最高**：意式 dial-in 与手冲诊断（BrewPhase 产品核心场景——用户拍照/输入参数，
  模型给有边界的诊断路径）；
- **高**：配方语境化与新鲜度（模型学会「来源+语境」表达，防教条）；
- **中**：健康/冷萃/磨豆（覆盖面补充）。

## 五、批次节奏（建议）

1. **Batch2a（6–10 条）**：仅用已核验来源（hario/fellow PDF/fda/hoffmann）——可立即写作，
   审核后批准，把 train 集从 3 条扩到 8–12 条；
2. **Batch2b（10–15 条）**：待 stumptown/fellow-brew-talks/UC Davis 核验 + 例外批准后开工；
3. **训练决策点**：总量 ≥25 条 approved 且 train ≥15 条时，启动第一次 QLoRA 实验
   （安装 mlx-lm、下载模型需届时另行确认）。

## 六、等待人工决策

1. 本规划是否认可（主题/数量/优先级）；
2. stumptown-kalita-guide 与 hario-v60-hoffmann 的例外提案是否批准（解锁 b1-006/025）；
3. b1-029 的 EFSA sleep 句改写方案（GPT 建议：改为不带具体数字的敏感度表述）是否采纳；
4. Batch2 写作由谁执行（编码模型按本规划起草 → 负责人逐条审核）。
