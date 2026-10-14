# Batch2c 人工审核包（阶段六点九-G，2026-10-14）

> 依据：GPT 六点九-G 执行提示词（负责人转述，存档
> `gpt_replies/gpt_reply_69f_draft_approved_69g_prompt.md`）。
> 目标：**只生成负责人审核材料**。完成后仅允许 quality gate / source admission 复跑
> 与本审核包生成；**禁止 approval_execution / manifest 更新 / split / mlx-lm**。
> 质量门禁基线：PASSED（checked=3, errors=0, warnings=0）；130 tests OK。

## 汇总

| 项 | 值 |
|---|---|
| Batch2c candidate_count | **3**（b2c-001/002/003，未扩展 004/005） |
| quality_gate | **PASS**（0 error / 0 warning） |
| approved_current | **22**（batch1 5 + batch2a 9 + batch2b 8） |
| potential_after_approval | **25**（达成 approved ≥25 阈值） |
| train_current / potential | 18 → **21+**（达成 train ≥15） |
| 训练状态 | **冻结**（mlx-lm 未安装、基座未下载） |

GPT 总定位：这三条补齐的是「不知道答案时先澄清 / 多变量归因 / 知识边界与拒绝编造」
——**从 QA 数据向 Agent 行为数据的重要变化**（G 节核心），而非新增咖啡知识。

---

## b2c-001 ｜ 「我自己冲的咖啡不好喝，怎么办？」——开放入口诊断

### A. 内容摘要
- **新增模型行为（非新增知识）**：从模糊主观反馈进入**结构化信息收集**，而不是直接给出单一原因。用户连症状方向都没有时，AI 帮用户建立诊断路径。
- 用户问题类型：开放主观反馈（无器具/豆子/参数/症状方向）；预期训练行为：先澄清定位、再进入诊断。

### B. Interaction 能力审核
- interaction_skill=**clarification** ✅（GPT 确认项）
- 三要素核对：① 为什么当前信息不足——首句冻结句「仅凭『不好喝』这个描述，还无法判断具体原因」+「酸、苦、淡、涩……方向和调整路径并不相同」✅；② 需要哪些信息——五维最小信息集（症状方向/器具/豆子/参数/相对描述）✅；③ 用户下一步提供什么——「先回答『具体哪里不好喝』（缩小范围最快的一步），再补器具与豆子信息」✅
- **next_step_recommendation**：有（上句；且说明顺序理由）✅
- claim 边界（GPT 冻结）：F 层仅「风味轮廓由 TDS/EY 划分」+「同豆不同萃」作多维定位框架；**无**「萃取率决定所有风味」「TDS 可诊断所有问题」外推 ✅

### C. F/P/I 审核
- **F**：claim.sensory.brewing-chart-profiles + claim.sensory.same-bean-different-brew（均 ucdavis-coffee-center，例外 allowed_claim_ids 已含）
- **P**：澄清式诊断流程（先症状方向后器具信息、按缩小范围速度排序）
- **I**：「具体哪个变量主导，需要结合你的信息才能判断」——限定词齐备
- 无 I 升级为事实；F 无冒充推断 ✅

### D. Source Admission
- **BLOCK（1 项）**：ucdavis 例外 allowed_sample_ids 未含 b2c-001——**非 claim 缺失**
  （claim 均在 allowed_claim_ids 内），批准阶段做样本范围对齐。不新增 claim/source/exception。

### E. Source scope
- 单来源（ucdavis），topic=pour-over diagnosis ∈ 例外 allowed_topics ✅。

### F. 最大行为风险（GPT 清单核对）
1. **追问过多**：回答在澄清后仍给出「相对描述也有定位价值」的降级路径与各类型方向提示，避免无限反问。
2. **澄清变成模板**：信息收集按「缩小范围速度」排序并说明理由（「先回答症状方向——这是缩小范围最快的一步」），非机械清单。

### G. 与已有 approved 差异
- **新增**：什么时候应该问、怎么把主观描述转化为可定位的信息需求。已有 approved 覆盖「给了症状怎么诊断」（b2a/b2b），本条覆盖「没给症状时先做什么」——QA → Agent 行为的入口样本。

### H. 建议动作
- `approve_candidate`（人工参考，不自动执行）

---

## b2c-002 ｜ 「为什么我家冲不出咖啡店的味道？」——期望管理

### A. 内容摘要
- **新增模型行为**：面对「为什么别人可以我不行」，能够**拆解条件差异**，而不是归因到单一变量（买更好的设备 / 换豆子）。
- 用户问题类型：对照型困惑（自带单因预设）；预期训练行为：多维度拆解 + 逐项确认顺序。

### B. Interaction 能力审核
- interaction_skill=**multi_variable_reasoning** ✅（GPT 确认项）
- **单变量建议检查**：回答的下一步是「先从豆子信息开始确认（最容易核实），再对照磨豆机与器具；如果豆子新鲜度差距明显，先换新鲜豆对比一次」——注意「换新鲜豆」是**对比验证动作**（控制变量实验），非「换了就好」的单变量结论；主导因素明确标注「需要逐项确认后才敢下结论」✅ 不构成 GPT 禁止的单变量建议。
- **next_step_recommendation**：有（含优先顺序与理由）✅
- meta 无独立 next_step_recommendation 字段（正文含完整下一步，六点九-C 门禁 next-step 检查通过）；如需独立字段建议落库登记时统一补——交负责人确认。

### C. F/P/I 审核（GPT 要求的层级表逐项核对）

| 内容 | 层级（GPT 要求） | 草稿现状 |
|---|---|---|
| 豆子/冲法影响差异 | **F** | ✅ same-bean-different-brew（UC Davis），【F】标记 |
| 设备因素 | **F/P（依据 claim 范围）** | ⚠️ Baratza claim（「正确数值取决于你的豆子与器具」→跨设备不可直接复制为直接语义）标【F】；「参数差异是结构性的，不是『谁技术好』的问题」为 claim 直接蕴含的表述，位于【F】块内——**建议人工复核该句是否需拆为 F(claim 本体)+P(推论表述)** |
| 新鲜度变化 | **F** | ✅ nca-lose-freshness-immediately（NCA），【F】标记 |
| 家庭环境影响（水质/手法） | **I** | ✅ 「本知识库暂时没有对应结论，只作为排查清单项列出、不展开【I：需要进一步确认】」——未升级为事实 ✅ |

### D. Source Admission
- **BLOCK（3 项）**：ucdavis / baratza / nca 三例外 allowed_sample_ids 均未含 b2c-002——
  **非 claim 缺失**（三 claim 均在各自 allowed_claim_ids 内），批准阶段样本范围对齐。
  不新增 claim/source/exception。

### E. Source scope（GPT 重点：三来源边界保持）
- **UC Davis → 豆子/冲煮差异** ✅（【F】块仅引用 same-bean claim）
- **Baratza → 设备条件** ✅（【F】块仅引用 manual-not-recipe claim）
- **NCA → 新鲜度** ✅（【F】块仅引用 nca-lose-freshness claim）
- **未合并**成「咖啡店好喝的全部原因」——水质/手法明确标注为知识库无结论的清单项 ✅
- topic=pour-over diagnosis ∈ 三例外 allowed_topics 交集（六点九-E 扩展成果，admission
  topics 层验证通过 ✅）

### F. 最大行为风险（GPT 清单核对）
1. **设备归因过强**：设备段落以 Baratza claim 为锚，「结构性差异」表述含轻度引申（见 C 表 ⚠️）——建议人工复核；无「买更好的设备」式建议 ✅
2. **把咖啡店体验绝对化**：无「咖啡店一定更好」「家庭无法达到」式表述 ✅（六点九-F 硬约束）
3. **给万能排查顺序**：顺序（先豆子后设备）附理由（「最容易核实」），并标注「主导因素因人因豆而异」✅

### G. 与已有 approved 差异
- **新增**：什么时候应该拆变量——「对照型问题」（拿别的基准比较）的处理范式。已有 approved 的诊断样本（b2a/b2b）都以用户自身现状为对象；本条训练「基准迁移场景下先拆条件差异再归因」，且首次在三来源授权组合下完成（六点九-E topics 治理的成果样本）。

### H. 建议动作
- `approve_candidate`（人工参考，不自动执行；落库时：三例外 allowed_sample_ids 并入 + C 表 ⚠️ 句人工复核）

---

## b2c-003 ｜ 「贵的咖啡豆一定更好吗？」——知识边界与拒绝编造

### A. 内容摘要
- **新增模型行为**：面对**知识库不存在的关系**（价格-品质），能够明确未知范围，并提供合理决策框架。
- 用户问题类型：伪标准求助（价格=质量幻觉）；预期训练行为：声明知识边界 + 通用推理框架 + 转化问题。

### B. Interaction 能力审核
- interaction_skill=草稿标注 **boundary_setting**；**GPT 六点九-G 期望 uncertainty_handling**——两者在本条上语义重叠（拒绝伪标准框架 + 明确未知范围）。**审核确认项**：建议落库登记时将 meta 的 interaction_skill 调整为 **uncertainty_handling**（该字段不在 REVIEWED_RECORD_FIELDS 内，调整不影响 reviewed_record_sha256，也不改回答正文）；最终以负责人拍板为准。
- 核心保留项（GPT：「这是本条最大的训练价值」）：「本知识库没有关于价格与品质关系的结论，所以我不编造……」✅ 明确在回答中。
- **next_step_recommendation**：有（「先确认自己的风味偏好方向，再按偏好找描述匹配的豆子，用小包装对比试错」）✅

### C. F/P/I 审核（GPT 特别检查）
- **禁止三类表述核对**：① 「贵豆质量更高」——❌ 未出现（且「价格不是唯一判断标准」被标注为通用选择逻辑、非咖啡领域定价结论）✅；② 「便宜豆品质差」——❌ 未出现（「便宜没好货」被显式列为过度概括并否定）✅；③ 「价格反映等级」——❌ 未出现（「处理法/产区/烘焙同时影响定价与风味，但关系不是单向的，具体到某一款豆子，本知识库无法判断【I】」——明确不作判断）✅
- **F**：chart-profiles（含消费者偏好测试——「偏好因人而异」有研究支撑）+ same-bean-different-brew（ucdavis）
- **P**：按偏好选豆的经验做法
- **I**：价格维度全部 I 层限定（「本知识库无法判断」「因豆而异」「需要进一步确认」）✅ 无 I 升级为事实

### D. Source Admission
- **BLOCK（1 项）**：ucdavis allowed_sample_ids 未含 b2c-003——非 claim 缺失，批准阶段对齐。不新增 claim/source/exception。

### E. Source scope
- 单来源（ucdavis），topic=pour-over diagnosis ∈ 例外 allowed_topics ✅。

### F. 最大行为风险（GPT 清单核对）
1. **编造价格规律**：开篇显式声明知识库无此结论 + 全程 I 层限定 ✅（零命中）
2. **变成消费建议**：回答止于「按偏好选豆的方法论」，无「应该买哪类/买多贵」✅
3. **隐性推荐品牌**：全文无任何品牌/商品/价格数字 ✅

### G. 与已有 approved 差异
- **新增**：什么时候应该承认不知道——b2b-008 训练「具体风味机理不知道」，本条训练「社会性/经济性关系不知道」（价格-品质），把「知识边界声明 + 通用推理框架 + 问题转化」组合成可迁移的行为模式；且是首个**完全无对应主题 claim 仍能给出有价值回答**的样本。

### H. 建议动作
- `approve_candidate`（人工参考，不自动执行；附 B 节 interaction_skill 确认项）

---

## 完成状态（GPT 允许/禁止清单核对）

- ✅ quality gate 复跑：PASSED（checked=3, errors=0, warnings=0）
- ✅ source admission 复跑：3/3 BLOCK（唯一缺口=allowed_sample_ids，topics 层全过）
- ✅ review package 生成（本文件）
- ❌ approval_execution：未执行
- ❌ manifest 更新：未执行
- ❌ split：未执行
- ❌ mlx-lm：未安装/未下载

## 待负责人拍板

1. 三条建议动作均为 `approve_candidate`（GPT 同建议）——批准后落库流程同六点九-E
   （例外 allowed_sample_ids 并入：ucdavis←b2c-001/002/003、baratza←b2c-002、
   nca←b2c-002；topics 无需再动）。
2. b2c-002 C 表 ⚠️ 句（设备维度「结构性差异」表述）是否需拆分 F/P——落库前定。
3. b2c-003 interaction_skill 改标 uncertainty_handling——落库时执行（负责人确认）。
4. 批准后：approved 22 → 25（达成阈值）、train 18 → 21+，进入**阶段七：第一次模型
   实验准备**（GPT 顺序：manifest 检查 → 装 mlx-lm → 下基座 → LoRA dry-run →
   数据格式检查 → 不直接训练）。
