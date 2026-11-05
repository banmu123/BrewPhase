# BrewPhase 独立审查报告

> 审查对象：`github.com/banmu123/BrewPhase`，main @ `70b23557d85bf5ef4175ba0fe87defbcb79c9664`（与本地 HEAD 一致）
> 审查日期：2026-11-04
> 方法：直接读源码与原始数据；跑现有测试；用仓库内生成器重建合成数据做独立基线；查外部文献。
> 限制：无真机、无真实用户数据、无 UI Test target；文中「未执行」项均已标注。

---

## 0. 结论摘要

**一句话**：BrewPhase 已经是一个**工程上可信的本地咖啡记录工具**，但它的「智能」部分目前只有**确定性检索与规则诊断**站得住；「风味预测」是一个在合成公式上训练的实验管线，「知识库」的 claim 治理没有进入运行时，回答层没有生成式模型。三者都不能作为对外承诺的产品能力。

| 判断 | 结论 | 证据等级 |
|---|---|---|
| 数据记录、阶段判断、通知、备份 | 可用，测试充分 | **已验证**（源码 + 429 项测试独立通过） |
| 结构化问答（我的记录） | 可用，边界清晰 | **已验证**（行为测试 + 源码） |
| 风味窗口预测 | 学习的是作者手写公式，不是咖啡规律 | **存在反证**（生成器源码 + 独立复算） |
| 知识库 claim 治理 | 212 条 claim、7 条 conflict 未进入 App | **存在反证**（构建脚本 + 产物体检） |
| 检索质量 | 没有任何 Recall/Precision/nDCG 证据 | **尚无证据** |
| 回答生成（LLM） | 生产链只有抽取式；引擎设置被代码强制覆盖 | **已验证**（源码） |
| 个人智能（诊断/基线） | 规则 + 个人统计，可解释、可复算 | **有证据支持但未充分验证**（缺真实用户效度） |
| 产品价值/留存/付费 | 无任何真实用户证据 | **尚无证据** |

---

## 1. BrewPhase 真实技术地图

### 1.1 实际运行链路

```
启动 BrewPhaseApp
 ├─ ModelContainer（SwiftData，磁盘，无 VersionedSchema）
 ├─ bootstrap：seeded PhaseRule + 示例数据
 ├─ refreshAll：遍历现存豆子重排通知
 └─ 视图
     ├─ 首页：全量 @Query beans/brews/tastings → InsightFactory 阶段判断
     ├─ 豆子详情
     │   ├─ PhaseCard：PhaseEngine（规则）→ 养豆/峰值/衰退
     │   └─ FlavorWindowCard：FlavorInputFactory → FlavorFeatureBuilder(85维)
     │        → Core ML brewphase_xgb → 30 次推理 → 峰值/窗口（默认开启，标注“实验预测”）
     └─ 问一问 AskView
         └─ AskEngine → HybridRetriever
             ├─ QueryAnalyzer（9 类意图 + 豆名/方式/条数/时间）
             ├─ ConversationQueryPlanner（多轮继承）
             ├─ 结构化事实（库存/评分/时间/配方/状态/诊断）
             ├─ 向量检索（NLEmbedding，按语言分空间；失败退词法哈希）
             └─ ContextBuilder → AnswerComposer → **只有 ExtractiveLLMProvider**
```

### 1.2 能力四分类（以实际调用链为准）

| 分类 | 能力 | 证据 |
|---|---|---|
| **进入运行链路** | 豆仓/冲煮/风味 CRUD、阶段规则与提醒、导出、完整备份恢复、结构化问答、诊断、个人基线、向量检索 | `BrewPhaseApp.swift:135-165`；`AskEngine.swift:71-179` |
| **实验功能（默认开启但标注实验）** | Core ML 风味窗口预测 | `FlavorWindowCard.swift:20-23,74-77`；卡片常驻「实验预测」+「模型用合成数据训练…不能当成真实规律」 |
| **代码存在但未接入** | Ollama / Apple Foundation Models provider；`RecommendationEngine.similarHistory`/`capability`；`KnowledgeSearchService` 不在 Ask 主链 | `AnswerComposer.swift:62-64`；`RAGSettings.swift:83-87` |
| **仅设计/实验材料** | CoffeeAI LoRA 微调（4 个 1.6MB adapter，全部未集成）；Experiment E 设计包 | `Tools/CoffeeAI/runs/*`；`experiment_E_design/README.md:12` |

### 1.3 五个与直觉不一致的事实

1. **回答层没有 LLM。** `AnswerComposer.chain()` 只返回 `ExtractiveLLMProvider`（`AnswerComposer.swift:62-64`）；`RAGSettings.load()` 直接把 `preferredEngine` 覆盖成 `.onDeviceSummary`（`RAGSettings.swift:83-87`）。设置页的 Ollama / 系统端侧模型选择**不改变任何结果**。
2. **预测模型默认开启**，不是隐藏实验（`PrefKey.experimentalFlavorPrediction` 默认 `true`），但卡片有明确实验/合成数据标注。
3. **知识库有两套体系。** 仓库里有 212 条 claim、7 条 conflict 的治理语料；App 运行时读的是 19 篇文档、92 条 facts 的编译产物，**claims/conflicts 一个都没有进去**。
4. **诊断不是 AI。** `BrewDiagnosticEngine` 是规则 + 个人统计，完全确定性（`BrewDiagnosisService.swift:18-39`），没有模型参与。
5. **CoffeeAI 与 App 无关。** 四次 LoRA 实验全部未通过验收，Experiment D 明确失败（行为分 6.0/10、零追问、新增编造）；adapter 未进入 App，训练数据也未用于 App。

---

## 2. 核心价值验证

### 2.1 咖啡生命周期管理 —— 可用，但“长期正确”有缺口

**已验证**
- 六个 SwiftData 实体、三条级联关系、删除豆子时先提交再删图与通知（`BeanDetailView.swift:556-574`），有测试。
- 阶段判断是规则引擎，用户可编辑，默认窗口与免责声明明确（`DefaultPhaseRules.swift:43-76`）。
- 备份/恢复有版本、双哈希、体积上限、单次提交、失败回删、恢复后通知重建；44 项备份测试。

**存在的问题（有证据，未验证影响面）**
1. **库存可漂移**：粉量大于余量时 `consume` 夹到 0，删除该冲煮却按整份 `coffeeG` 加回（`Bean.swift:199-201`；`BrewRecorder.swift:205-207`）→ 余量凭空增加；编辑器可直接覆写 `remainingG`（`BeanEditorView.swift:478-479`），之后删冲煮二次加回。
2. **风味天数冻结（有意设计，但存在双语义）**：`Tasting.dayAfterRoast` 在创建时冻结（注释说明是为避免改烘焙日期后“历史含义被悄悄改写”，`Tasting.swift:13-16`），而 `Brew.dayAfterRoast` 实时计算（`Brew.swift:131-133`）。两者并存时，同一杯在“风味记录”和“冲煮记录”里可能显示不同的第几天；这是设计取舍，不是崩溃性 bug，但会让人说不清。
3. **无唯一约束、无迁移计划**：全仓无 `@Attribute(.unique)`、无 `VersionedSchema`；schema 变更依赖 SwiftData 轻量迁移，破坏性变更会停在恢复页，而该页没有导出入口。
4. **删除示例豆不取消通知**：`DemoData` 只删库不 unschedule，`refreshAll` 只遍历现存豆 → 系统通知残留（`DemoData.swift:49-66`；`NotificationManager.swift:215`）。

**判定**：记录与提醒的**日常路径**已验证；**长期数据一致性**只有代码层证据表明存在风险，无真实长期使用数据。

### 2.2 风味窗口预测 —— 这是本轮审查的核心反证

#### 2.2.1 材料完整性

| 材料 | 仓库内 | 说明 |
|---|---|---|
| Core ML 模型 | ✅ `Resources/brewphase_xgb.mlmodelc`（180 KB） | 可用 |
| feature_schema / mapping | ✅ 85 维 / 72 类 | 可用 |
| 指标 | ✅ `Tools/Models/metrics.json`（标注 `SYNTHETIC`） | train R² .961 / val .772 / test .765；peak error 1.85 天；window IoU .641 |
| 训练脚本 / 特征工程 / 生成器 | ❌ **不在仓库** | 存在于本机未受版本控制的 `/Users/banmu/Brew/tools/brewphase-model-v1/`，第三方无法复现 |
| 训练数据（CSV/parquet） | ❌ **不存在** | 无法独立重训/复核划分 |
| 划分文件 / 训练日志 / 转换脚本 | ❌ 不在仓库 | 仅 `compile_model.sh` 等辅助脚本 |

**结论**：仓库内的模型**无法被第三方独立复现**；只能做行为验证，不能做训练审计。

#### 2.2.2 真实预测路径与有效信息量

- 输入 85 维 = 11 数值 + 2 二值 + 72 one-hot（9 组）（`feature_schema.json`）。
- App 真实能提供约 **13 个信息槽**：产地国家/产区、处理法、烘焙度、冲煮方式 + 烘焙后天数、开封后天数、粉量、水温、水量、液重、冲煮时间、opened。
- **4 组 one-hot 永远整组 0**：品种、烘焙商、包装、储存方式（`FlavorInputFactory.swift:24-45` 从不传）；烘焙商占位名也必然匹配不上真实名称。
- 常量填充：海拔 1600、发展时间 100、储存温度 15.6、研磨 5.5、单向阀 0。
- 风味标签完全不参与：`flavorTagsRaw` 存在于模型，但 `FlavorInputFactory` 不读取。
- 未知类别整组 0 并记诊断（`FlavorFeatureBuilder.swift:249-255`），UX 上已如实展示「哪些资料没派上用场」。

#### 2.2.3 标签来源：手写公式，不是真实杯测

`generate_synthetic.py`（仓库外）明确写：

- 峰值日 = 处理法先验 + 烘焙度偏移 + 海拔项 + N(0,1.5)（`:63-66`）；
- 峰值分 = 3.4 + 海拔项 + Gesha +0.25 + 厌氧 +0.15 + 噪声（`:67-71`）；
- 曲线 = 峰值分 − 0.055·rise^1.6 − 0.030·rate·decline^1.25 + N(0,0.12)（`:88-107`）；
- 文件头自述：“generated by a hand-coded flavor-curve function… NOT real user data and must NEVER be presented as real coffee-science conclusions”（`:4-8`）。

**因此模型学的是这位作者手写的 4 个处理法先验、5 个烘焙度偏移和两条幂函数，而不是咖啡豆的真实风味演化。** `metrics.json` 里的 R²、peak error、IoU 都是对这条合成曲线的拟合度。

#### 2.2.4 独立复算（我用同一生成器重建 400 袋 / 3784 行，自建 70/15/15 按袋分组）

| 预测器 | MAE | R² | 说明 |
|---|---|---|---|
| 训练集均值 | 0.660 | 0.000 | 最弱基线 |
| 处理法 × 烘焙度 × 天数分桶 查表（100 格） | **0.353** | **0.675** | 不需要任何 ML |
| **XGBoost（作者报告）** | **0.301** | **0.765** | 比查表仅好 0.052 MAE / +0.09 R² |
| 生成器公式（无噪声 oracle） | **0.090** | **0.979** | 标签噪声下限约 sd 0.115 |

**解读**：85 维 XGBoost 相对一张 100 格查表的提升很小；距理论天花板（知道公式）仍有 3 倍差距。模型并没有“发现规律”，只是在逼近一条已知方程。这个结论不依赖作者指标。

#### 2.2.5 训练/推理分布错位（比精度更严重）

| 特征 | 训练分布 | App 实际 | 后果 |
|---|---|---|---|
| `opened` / `days_since_open` | 开封日 1–7 天；`opened=0` 仅占 10.2% 行，且都在第 1–7 天 | 无开封日时**整条 30 天曲线 opened=0** | 第 8–30 天的“未开封”输入是训练中从未出现的组合 |
| `one_way_valve` | 73% 为 1 | 恒 0 | 协变量偏移 |
| `dose` / `water_weight` | N(16,2.5) / N(250,20) | 默认 15 / 240 | 小幅偏移 |
| `storage_method` | Room/Cool/Freezer 三类 | 整组 0 | 4 组之一永远缺失 |
| `variety` / `roaster` / `packaging` | 每组必有一个 1 | 整组 0 | 模型依赖的强特征在推理时缺失 |
| 曲线评估 | 开封日写死第 3 天 | 真实 openDate / 首次冲煮 / 无 | 报告中的 peak error/IoU 与 App 实际路径不同 |

特征重要性前 20 中，约 **23%** 的 gain 来自 App 无法提供的特征（storage 0.061 + variety 0.022 + roaster 0.054 + valve 0.010，合计 0.147 / top20 0.637）。

#### 2.2.6 科学依据

外部文献能支持的：

- 烘焙后 CO₂ 脱气在最初约 20 天最快，之后显著放缓；以脱气为判据，整豆“新鲜”约 3 周（SCA, *Coffee Freshness Handbook* 2018；Smrke et al., *J. Agric. Food Chem.* 2018, DOI 10.1021/acs.jafc.7b03310）。
- 陈旧是多因素过程：温度、氧、水分活度、研磨/表面积都会改变速率；温度每升 10°C 脱气速率约 ×1.5（Labuza et al. 2001，见 SCA 2012 综述）。
- SCA 的文献综述明确说：咖啡风味是“moving target”，陈化的精确速率“experimental control, repeatability, and data analysis all but impossible”（Sage, SCA 2012）。

文献**不能**支持：

- 「每包豆存在一个可由产地/处理法/烘焙度精确算出的峰值日」；
- 「Natural 比 Washed 晚 4.5 天到达峰值」这类具体先验；
- 单一 30 天曲线足以表达风味变化（不同化合物、不同感官维度并不同步）。

**判定：作为科学预测——存在反证（标签是合成公式）；作为工程管线——已验证（端到端可跑、可测）；作为产品卖点——不成立，且团队已在 UI 上标注“实验/合成数据”，这一点值得肯定。**

### 2.3 RAG 与个人智能 —— 结构化查询可信，检索质量无证据

#### 2.3.1 知识链路（源 → App）

```
knowledge/*.md（30 篇领域文档 + 6 个治理/说明文件，212 claim，7 conflict，51 source）
   ↓（人工维护，不自动）
knowledge/_build/documents.json（19 篇，92 facts，generatedAt 2026-09-30）
   ↓ Tools/knowledge/build_kb.py（只读 documents.json）
knowledge/_build/knowledge_base.v2.json（19 篇）
   ↓ 覆盖
BrewPhase/Resources/knowledge_base.json（19 篇 / 58.9 KB）
   ↓
KnowledgeBase.swift（解析 id/category/source/title/content/sourceIds/authorityTier/scope/entityIds）
```

体检结果：

- App 内 JSON 与 v2 的**正文内容逐字节一致**（内容哈希相同），只有 `generatedAt` 不同（09-30 vs 10-14）。
- **212 条 claim、7 条 conflict 没有进入运行时**：`compile_payload()` 只写文档字段，不写 facts/claims/conflictId；App 解析层也没有对应字段。
- 51 个来源中 35 个被文档引用；16 个未使用。
- 构建不读 md，改 md 不会自动进入构建；`--check` 只校验引用完整性，不校验新鲜度。
- 19 篇文档里，用户可感知的高频主题（水质、研磨、萃取、故障排查）没有专条；设备类只有少量。

#### 2.3.2 检索与排序

- 排序公式：`0.62 × 相似度 + 0.16 × 评分 + 0.16 × 时效 + 来源修正`（`IntelligenceConfig.swift:26-28`；`HybridRetriever.swift:267-274`）。
- 这三个权重是**手写常量**，仓库内没有任何调参记录、qrels、Recall/Precision/nDCG/MRR 评测（全仓检索这些关键词为空）。
- 相似度用 min-max 归一化，**最高分恒接近 1.0**，没有绝对阈值，也没有“检索不到就拒答”的机制；只要有任何 passage，抽取式就会给出回答。
- 中英文各建一套索引（NLEmbedding 语言分空间），设备缺模型时退到 256 维词法哈希——语义能力显著下降，但用户不可见（只有日志）。

#### 2.3.3 回答可信度

- 生产链只有抽取式（已确认）；回答由“结构化事实整段 + 每块记录挑 2 句 + 知识挑 2 句”组成。
- 引用编号连续、可回溯到 passage；`PromptBuilder` 的三条纪律只对生成式模型有效，对抽取式不起作用（`ExtractiveLLMProvider.swift:22-23` 明确忽略 prompt）。
- **推断被放在“直接结论”层**：诊断输出（规则推断）被标成 `.structuredFact`，与日期/评分同级展示；`BuiltContext.Block` 没有 authority 字段，F/P/I 在编译期已丢失（`StructuredRetriever.swift:31-33,77-94`）。
- 无生成式模型 → 不存在“模型编造”；但也不存在“综合解释”，复杂问题只能得到证据拼接。

#### 2.3.4 个人智能的真实能力

- **能做的**：库存统计、单豆评分/时间/配方/状态查询、最近一杯诊断、个人基线（仅 score≥4，最少 1 条，比较门槛 3 条）、相似记录向量检索。
- **不能做的**：跨记录趋势（“越来越苦”）、豆子对比、因果判断、无焦点豆的诊断、Tasting 精确事实、设备型号知识。
- 诊断是**候选 + 置信度 + 证据**，措辞克制（“更接近”，不说“就是”），这是全项目最可信的智能能力。

**判定**：结构化事实与多轮状态——**已验证**；检索质量——**尚无证据**；知识治理上线——**存在反证**；个人智能的**用户效度**——**尚无证据**。

### 2.4 CoffeeAI 微调实验 —— 与 App 无关

- 4 个 LoRA adapter（各 1.6 MB）停留在 `Tools/CoffeeAI/runs/`，未进入 App。
- Experiment D 正式判定失败：行为分 6.0/10（门槛 7）、零澄清追问、新增事实编造（`experiment_D_report.md:24-31`）。
- Experiment E 仍是设计包，训练未批准（`experiment_E_design/README.md:12`）。
- 结论：**不能把 CoffeeAI 的任何实验算作 App 的 AI 能力**。

---

## 3. 最重要的五个问题（按可信度影响排序）

### 问题 1：风味预测的标签是手写公式，不是真实咖啡数据

- **观察**：模型在 85 维上学习 `generate_synthetic.py` 的确定性曲线；作者报告 test R² 0.765，而 oracle 公式可达 0.979。
- **原始证据**：生成器 `:63-107`；`metrics.json` 的 `"data_source": "SYNTHETIC"`；UI 卡片自述合成数据。
- **实际影响**：预测可以“看起来合理”，但不具备外推到真实豆子的依据；用它做购买/饮用决策可能误导。
- **为什么重要**：这是项目最大的“智能”卖点，也是用户最容易当成科学结论的部分。
- **反证**：UI 明确标注“实验预测”“不能当成真实规律”，团队没有隐瞒；`experimentalFlavorPrediction` 可关闭。
- **确认实验**：E1（真实纵向品鉴）。

### 问题 2：知识 claim 治理没有进入运行时，知识能力被高估

- **观察**：212 claim / 7 conflict 只存在于 md 与治理文件；App 只有 19 篇文档、0 条 claim、0 条 conflict。
- **原始证据**：`build_kb.py:194-242`（只写文档字段）；`knowledge_base.json` 无 claims 字段；`documents.json` 仍是 09-30。
- **实际影响**：冲突来源、F/P/I 分层、来源级引用在运行时不存在；“知识库”实际是 19 篇百科式摘要。
- **为什么重要**：RAG 的可信度依赖来源治理；没有 claim/conflict，引用只能到文档级，无法回答“谁说的、是否有争议”。
- **反证**：19 篇文档来源权威（SCA/WCR/CQI/FDA/EFSA），内容经过改写与许可标注，并非随意拼凑。
- **确认实验**：E4（构建链路 + 冲突问答）。

### 问题 3：回答层没有 LLM，但产品提供了三种引擎选择

- **观察**：`chain()` 只挂抽取式；`RAGSettings.load()` 强制覆盖偏好；Ollama/Apple provider 是死代码。
- **原始证据**：`AnswerComposer.swift:62-64`；`RAGSettings.swift:83-87`；`OllamaClient.chat` 请求体无 tools。
- **实际影响**：用户选择“Ollama/系统模型”不会生效；所有“AI 回答”实际是检索摘录；Agent 化没有载体。
- **为什么重要**：这是产品承诺与实现的不一致，也是上一份 Agent 分析指出的硬阻塞。
- **反证**：代码注释明确说 V1 不使用 LLM（“协议 §二”），属于阶段性决策，不是隐藏缺陷。
- **确认实验**：E3 的回答质量评测（抽取式 vs 生成式）与设置生效测试。

### 问题 4：个人数据会随编辑/删除漂移

- **观察**：库存夹取后删除回补、编辑器覆写余量、Tasting 天数冻结、无唯一约束/迁移计划。
- **原始证据**：`Bean.swift:199-201`；`BrewRecorder.swift:205-207`；`Tasting.swift:14-16`；`BrewPhaseApp.swift:20-31`。
- **实际影响**：长期使用后“剩多少、第几天喝的、为什么推荐”会说不清；备份恢复只能恢复“当时的样子”，无法修复逻辑漂移。
- **为什么重要**：个人智能的全部价值建立在历史数据可信之上。
- **反证**：核心 CRUD 有 429 项测试；漂移路径属于边界组合，日常单次记录不受影响。
- **确认实验**：E5（1000 条冲煮 + 200 次编辑/删除的不变量 soak）。

### 问题 5：没有任何真实用户证据支撑产品价值

- **观察**：仓库无用户研究、留存、任务完成率、付费意愿数据；所有价值判断来自开发者/AI 推断。
- **原始证据**：全仓无用户研究文件；本报告无法接触真实用户。
- **实际影响**：无法判断“持续记录”是否成立——而这是所有智能能力的数据前提。
- **为什么重要**：记录类产品的死因通常不是算法，而是用户停止记录。
- **反证**：产品设计对记录摩擦做了大量优化（快记、示例数据、三个阶段卡）；但这是设计意图，不是行为证据。
- **确认实验**：E6（4 周日记研究）。

---

## 4. 独立验证实验方案（通过标准在开始前冻结）

| 编号 | 目的 | 数据要求 | 方法 | 通过标准（预注册） |
|---|---|---|---|---|
| **E1** | 真实风味曲线是否存在、能否预测 | ≥30 袋，覆盖 4 烘焙度 × 2 处理法；每袋 ≥10 次盲评（同一冲煮协议），持续 30 天 | 每周 2–3 次杯测，评分 + 描述词；分层模型（袋为随机效应）；与均值/规则基线比较 | 真实曲线峰值日袋间差异显著（ICC>0.3）；模型 peak-day MAE ≤3 天、窗口 IoU ≥0.5，且优于规则基线；否则判定“不可预测” |
| **E2** | 训练/推理分布是否对齐 | App 端 opt-in 采集 100 包豆的特征向量（脱敏） | 对比训练分布：one-hot 组缺失率、opened 天数覆盖、数值均值/方差 | 4 个缺失组降为 0；opened=0 覆盖 1–30 天；PSI<0.1；否则模型不得上线 |
| **E3** | 检索与回答质量 | 100 题评测集（8 类问题各 ≥10），标注 gold passages 与可接受答案 | 离线跑检索，人工判分；计算 Recall@5、MRR、nDCG@5、citation correctness、abstention accuracy | Recall@5 ≥0.80；MRR ≥0.60；引用正确 ≥0.95；该拒答时拒答 ≥0.90 |
| **E4** | 知识治理是否真正上线 | 212 claim / 7 conflict 全量 | 构建产物必须含 claimId/conflictId/authority；抽样 50 条 claim 做“来源—正文—引用”三方核对 | 100% claim 可在 App 引用；7 条 conflict 在问答中可被识别；0 条越权引用 |
| **E5** | 长期数据一致性 | 1000 条冲煮、200 次编辑/删除、50 次恢复 | 不变量检查：`remainingG = weightG − ΣcoffeeG`（允许显式覆写标记）；Tasting 天数与烘焙日一致；PhaseRule 每烘焙度唯一 | 违规数 = 0；恢复后不变量仍成立 |
| **E6** | 真实使用价值 | 12–15 名手冲用户，4 周 | 日记 + 任务测试 + 半结构访谈 + 价格测试 | ≥60% 连续 3 次记录参数与评分；≥70% 能用自己的话解释“窗口”；≥50% 因建议改变过一次决策；价格测试有明确分布（不预设正结论） |

工具：E1 杯测表 + 盲编码；E2 App 内导出 + Python 分布检验；E3 Python/Swift 离线 harness；E5 XCTest soak + 脚本；E6 访谈提纲与编码表。

---

## 5. 下一阶段研发决策（只保留三项）

### 做 1：建立真实数据闭环（替代继续优化合成模型）

- **为什么**：没有真实标签，任何模型改进都不可验证；这是唯一能消除“预测是否有效”不确定性的路径。
- **做什么**：在现有记录流程里降低“冲煮后评分”的摩擦（一次点击 + 可选描述），提供脱敏导出；明确 opt-in 与隐私说明。
- **不做**：不重训、不上新模型、不扩特征。
- **完成即消除**：E1/E2 能否成立的先决条件。

### 做 2：把 claim/conflict 接入运行时，并建立 100 题检索评测

- **为什么**：知识能力目前是“有语料、无治理、无评测”；这是 RAG 可信度的最短板。
- **做什么**：`build_kb` 从 claim 语料生成带 claimId/conflictId/authority 的产物；App 解析并在回答中保留来源级引用；离线评测 harness。
- **不做**：不扩知识条目数量，不调排序权重（先有评测再调）。
- **完成即消除**：知识库是否真的能支撑“有依据的回答”。

### 做 3：修数据一致性不变量与迁移/备份演练

- **为什么**：个人智能的原料是历史数据；漂移会让所有下游结论失效。
- **做什么**：库存改为“记录推导 + 显式调整”二选一；Tasting 天数改为派生或记录时冻结并标注；加唯一约束与迁移计划；恢复演练纳入 CI。
- **不做**：不重构 UI，不引入新实体。
- **完成即消除**：长期使用后数据是否可信。

**为什么不做其他**：Agent/多工具/ReAct 在回答层没有 LLM、检索没有评测、标签不真实的前提下，只会把不可验证性放大；新增知识条目在没有 claim 治理时只是增加文档数。

---

## 6. 最终产品判断

**真正的技术壁垒是什么？**
不是模型，而是「本地优先 + 确定性诊断 + 个人基线 + 结构化事实编排」这套组合：它不依赖云、不依赖大模型、可解释、可测试。再加上备份/恢复/通知这类工程资产，这是竞品短期不容易补齐的部分。

**哪些能力已经具备产品价值？**
豆仓与冲煮记录、阶段判断与提醒、导出/备份、“我的记录”类结构化问答（日期、评分、配方、状态、最近一杯诊断）。这些在 429 项测试与代码层面都站得住。

**哪些能力仍然没有被证明？**
风味窗口预测的科学有效性；RAG 的检索质量与回答忠实度；个人智能能否改变用户决策；用户是否愿意持续记录与付费。

**现在最应该投入的资源？**
真实数据闭环与评测基础设施，而不是模型/Agent/更多功能。E1/E3/E5 是三个“没有它就无法判断”的实验。

**什么情况下应该停止某条技术路线？**
- 风味预测：E1 达不到 peak-day MAE ≤3 天或窗口 IoU ≥0.5 → 停止 ML 路线，保留规则阶段卡。
- 知识问答：E3 Recall@5 <0.6 或引用正确 <0.9 → 停止“知识问答”定位，退回结构化查询。
- 记录产品：E6 中连续记录率 <40% → 停止增加智能功能，先解决记录摩擦。

**哪个核心价值最值得继续深挖？**
**个人冲煮基线与诊断**。它已经有真实数据来源（用户自己的记录）、确定性可复算、措辞克制、对“下一杯怎么调”有直接作用；相比之下，风味曲线是最不牢靠、却最显眼的那一个。

---

## 附录 A：证据索引

| 主题 | 位置 |
|---|---|
| 问答编排 | `BrewPhase/RAG/AskEngine.swift:71-179` |
| 回答链只有抽取式 | `BrewPhase/RAG/Answering/AnswerComposer.swift:62-64` |
| 引擎偏好被强制覆盖 | `BrewPhase/RAG/Core/RAGSettings.swift:83-87` |
| 检索权重 | `BrewPhase/RAG/Rules/IntelligenceConfig.swift:26-28`；`HybridRetriever.swift:267-274` |
| 知识构建只写文档 | `Tools/knowledge/build_kb.py:194-242` |
| App 知识解析字段 | `BrewPhase/RAG/Indexing/KnowledgeBase.swift:106-135` |
| 预测输入工厂 | `BrewPhase/Services/FlavorInputFactory.swift:24-45` |
| 85 维特征 | `BrewPhase/Resources/feature_schema.json` |
| 合成标签公式 | `/Users/banmu/Brew/tools/brewphase-model-v1/src/generate_synthetic.py:63-107`（**不在仓库**） |
| 训练/划分/指标 | 同上 `train.py:41-55, 181-206`；`Tools/Models/metrics.json` |
| 模型指标声明 | `Tools/Models/metrics.json`（`data_source: SYNTHETIC`） |
| 预测卡实验标注 | `BrewPhase/Features/Bean/FlavorWindowCard.swift:74-77, 140-145` |
| 库存漂移 | `BrewPhase/Models/Bean.swift:199-201`；`Services/BrewRecorder.swift:205-207` |
| 无迁移计划 | `BrewPhase/App/BrewPhaseApp.swift:20-31`（无 VersionedSchema） |
| 通知残留 | `BrewPhase/Services/DemoData.swift:49-66`；`NotificationManager.swift:215` |
| 微调实验失败 | `Tools/CoffeeAI/training/experiment_D_report.md:24-31` |

## 附录 B：未执行项

1. 真实 iPhone 上的断网、重启、长期运行、备份恢复手工验收（无真机）。
2. 真实用户访谈、日记研究、价格测试（E6）。
3. 真实杯测数据采集（E1）。
4. 100 题检索评测（E3）——仓库内不存在评测集，本轮未新建（审查不修改项目）。
5. 真机内存/性能 profiling（无 Instruments 会话）。
6. 知识库 claim 与源文档的逐条人工核对（只做了抽样与结构核对）。
