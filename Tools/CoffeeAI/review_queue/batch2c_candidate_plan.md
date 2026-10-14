# Batch2c 候选设计（阶段六点九-F 第一步，2026-10-14）

> **只出 plan，不写候选正文**——GPT 六点九-F 指示：先设计 b2c-001~003（P0 三条），
> 流程保持 plan → draft → gate → human approve → split → dry-run。
> 目标：approved 22 → 26~27、train 18 → 21~22，达到第一次 LoRA dry-run 安全线。
> 定位：**收尾型数据**——不扩主题、不堆知识，补「真实用户场景下最容易犯错的决策能力」。

## 六点九-E 教训条目（本 plan 全部设计已预检）

1. **单来源优先**：多来源样本需 topic 落在所有命中例外的 allowed_topics 交集
   （fail-closed 语义，GPT 裁定不改）；三条设计全部做到单来源（b2c-002 为三来源，
   见下——六点九-E topics 对齐扩展后交集恰为非空，已验证）。
2. **topic 预检**：每条标注 topic 与来源例外 allowed_topics 的覆盖关系。
3. **claim 零新增**：全部引用既有例外 allowed_claim_ids 内的 claim，无需动例外表。

## 来源策略

- **全部使用已有来源例外**（ucdavis-coffee-center / baratza-documents /
  nca-aboutcoffee），**零新增例外、零 allowed_claim_ids/topics 变更**。

---

## b2c-001 ｜ 用户只说「咖啡不好喝」——开放入口诊断

- **id**: b2c-001 ｜ **title**: 「我自己冲的咖啡不好喝，怎么办？」的开放诊断入口
- **user_scenario**: 用户连问题维度都说不清（真实 App 用户最大量表达）——无器具/豆子/
  参数/症状方向
- **training_skill**: general_diagnosis / clarification（GPT 定级 ★★★★★，BrewPhase
  最核心入口）
- **answer_structure**: A 仅凭「不好喝」无法判断具体原因（判断边界）→ B 诊断需要
  的最小信息集（器具/豆子/烘焙日期/当前参数/具体哪里不好喝）→ C 常见症状方向与其
  分流逻辑（酸/苦/淡/涩各有方向，但不预设）→ 下一步建议
- **expected_FPI**: F=风味轮廓由 TDS 与萃取率划分（chart-profiles）+ 同豆不同萃
  （same-bean-different-brew）——说明「不好喝」是可定位的多维问题而非单一缺陷；
  P=澄清式诊断流程（先收集再判断）；I=用户具体原因（需信息补充后才能判断）
- **claim_ids**: ["claim.sensory.brewing-chart-profiles", "claim.sensory.same-bean-different-brew"]
- **source_status**: ucdavis-coffee-center 单来源（两 claim 均在其例外
  allowed_claim_ids 内）——**可立即写**
- **topic**: pour-over diagnosis（= ucdavis 例外 allowed_topics 唯一值 ✓；
  与 b2b-001/008 同 topic 先例）
- **risk_notes**: 禁止复刻「不好喝→磨细点」式单操作回答；澄清不给结论；与
  b2b-001（酸）差异化：b2b-001 用户已给出症状方向，本条连症状方向都没有
- **interaction_skill**: clarification
- **missing_information_handling**: 五维最小信息集（器具/豆子/烘焙日期/参数/症状方向），
  说明先收集哪一项能最快缩小范围
- **training_value**: ★★★★★（GPT 定级）

## b2c-002 ｜ 「为什么我家冲不出咖啡店的味道？」——期望管理

- **id**: b2c-002 ｜ **title**: 复制咖啡店味道的期望管理与差异拆解
- **user_scenario**: 用户拿商业出品当基准，隐含「我家设备/技术不行」的自责预设
- **training_skill**: expectation_management（GPT 定级 ★★★★★，产品定位强相关）
- **answer_structure**: A 差异是多元的，先拆解再归因（不能直接说「你参数不对」）→
  B 五类差异来源（豆子差异/设备差异/水质/技术/新鲜度——各附 F 证据）→
  C 逐类确认方法 → 下一步建议（先确认哪种差异导致）
- **expected_FPI**: F=同豆不同萃（same-bean-different-brew，豆子与冲法维度）+
  刻度不能跨磨豆机换算（manual-not-recipe，设备维度）+ 咖啡烘焙后几乎立即失去
  新鲜度（nca-lose-freshness-immediately，新鲜度维度）；P=逐类确认的差异拆解法；
  I=用户个案的主导因素（需逐项排除后才能判断）
- **claim_ids**: ["claim.sensory.same-bean-different-brew", "claim.grinding.manual-not-recipe",
  "claim.freshness.nca-lose-freshness-immediately"]
- **source_status**: 三来源 ucdavis + baratza + nca——**六点九-E topics 对齐扩展后
  三者 allowed_topics 交集 = {'pour-over diagnosis'} 非空（已验证）**，三 claim 均在
  各自例外 allowed_claim_ids 内——**可立即写（多来源并集语义，六点五-C）**
- **topic**: pour-over diagnosis（三例外交集，预检通过 ✓）
- **risk_notes**: 禁止「参数不对」式单因归因；不贬低家庭冲煮（期望管理≠劝退）；
  水质/环境维度知识库无 claim——只作清单项列出、不展开机理（b2b-004 同边界）
- **interaction_skill**: multi_variable_reasoning（差异拆解 + 逐类确认）
- **missing_information_handling**: 请用户提供豆子信息（购买渠道/烘焙日期）、
  器具型号与磨豆机、冲煮参数——按差异类别归组收集
- **training_value**: ★★★★★（GPT 定级）

## b2c-003 ｜ 「贵的咖啡豆一定更好吗？」——价格=质量纠偏

- **id**: b2c-003 ｜ **title**: 「是不是越贵越好」的偏好推理与反线性纠偏
- **user_scenario**: 用户以价格替代品质判断（价格=质量幻觉）
- **training_skill**: preference_reasoning（GPT 定级 ★★★★）
- **answer_structure**: A 品质与价格不是简单线性关系（判断边界）→ B 影响体验的
  实际变量（风味轮廓由冲煮落点决定/偏好因人而异/处理法产区烘焙均影响——F 支撑
  一般性框架）→ C 价格信号的正确解读边界 → 下一步建议（按自己风味偏好选择 +
  用冲煮把豆子潜力发挥出来）
- **expected_FPI**: F=风味轮廓由 TDS 与萃取率划分、研究含消费者偏好测试
  （chart-profiles——偏好因人而异有研究支撑）+ 同豆不同萃（同一豆子冲得好坏
  差异可以大于豆子价格差异）；P=按偏好选豆的经验做法；I=具体豆子的性价比判断
  （「可能」「因人而异」限定）
- **claim_ids**: ["claim.sensory.brewing-chart-profiles", "claim.sensory.same-bean-different-brew"]
- **source_status**: ucdavis-coffee-center 单来源——**可立即写**
- **topic**: pour-over diagnosis（= ucdavis 例外 topics 唯一值 ✓）
- **risk_notes**: **知识库无「价格-质量」直接 claim**——价格维度一律 I 层限定
  （延续 b2b-008 不知道能力：明确「本知识库没有价格与品质关系的结论」，不编造
  定价机理）；禁「贵=智商税」反向绝对化；不推荐具体商品/品牌
- **interaction_skill**: boundary_setting（拒绝伪标准框架：价格不是品质标尺）
- **missing_information_handling**: 请用户说明自己的风味偏好（酸/苦/醇厚/清淡）与
  冲煮方式——把「贵不贵」转化为「适不适合」
- **training_value**: ★★★★（GPT 定级）

---

## 汇总（GPT 要求的三项报告数据）

| 维度 | 结果 |
|---|---|
| **可立即写数量** | **3/3**（claim 全部已在例外 allowed_claim_ids 内，topic 全部预检通过） |
| **依赖来源数量** | 3 个（ucdavis / baratza / nca）——全部已有例外，无需新增；b2c-002 三来源交集 {'pour-over diagnosis'} 非空（六点九-E 扩展成果） |
| **风险分类** | 中风险：b2c-001（澄清流惯性）、b2c-002（多来源 claim 并集）；中高风险：b2c-003（无价格 claim，幻觉防线型样本——价格维度必须 I 层限定） |

## GPT 暂缓项（本 plan 不含）

- 更多健康内容（已有 b2b-007，继续扩会降低咖啡领域数据密度）
- 更多参数配方（模型最大风险是「把参数当答案」，继续加参数收益低）

## 流程纪律（GPT 指定）

> 不改变 approved 文件 / exceptions / split / training config；只新增
> batch2c_candidate_plan.md（本文件）→（下一轮）draft → gate → review package →
> human approve → split → dry-run。b2c-004/005 等本批审核后再设计。
