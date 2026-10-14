# Batch2d 人工审核包（阶段七-F-2，2026-10-15）

> 依据：GPT batch2d draft 指示（存档 `gpt_replies/gpt_reply_stage7f_plan_approved_7g.md`）。
> 完成状态：草稿 10 条生成 + 全链检查通过；**不落库**。禁止项遵守：未修改 approved、
> 未新增 claim/source、未训练。

## 汇总

| 项 | 值 |
|---|---|
| Batch2d candidate_count | **10**（b2d-001~010，按 GPT 修正后最终结构） |
| quality_gate | **PASS**（0 error / 0 warning） |
| source admission | 3 PASS（fda 自动准入）+ 7 BLOCK（唯一缺口=allowed_sample_ids，topics 全过——与 b2b/b2c 同构） |
| approved_current / potential | 25 → **35** |
| 训练状态 | 冻结（模型已缓存，但按 GPT 指示「新增数据前不训练」） |
| 回归 | 130 tests OK；build_kb --check OK |

## GPT 三处裁定的落实

1. **b2d-006/007 interaction_skill = `knowledge_explanation`（新枚举）**——两条直接
   解释类（什么是手冲/为什么洗滤纸）全部采用；**knowledge_explanation gate 已实现**
   （check_candidate_quality.py 新检查：开头 120 字符内出现追问 → error
   `knowledge-explanation-forced-ask`；回答过短 → warning）。两条均 PASS：直接回答
   到底、零强制追问（b2d-006 结尾「需要的话我可以展开」是帮助入口非强制追问）。
2. **b2d-005 帕金森边界（GPT 修正结构）**：首句边界「目前不能仅根据这个问题判断
   咖啡会导致或不会导致某种健康结果」→ 健康研究方法论（相关性≠因果、混杂因素、
   需医学来源）→ FDA 口径仅限摄入量层面（明确不与疾病风险混用）→ 非医疗建议。
   三类禁用表述（降低风险/增加风险/已证明无影响）零命中 ✅。
3. **b2d-003/004 避免简单 QA**：b2d-003 结构=「前提不准确 → 多因素框架 → 需具体
   信息 → 不编造机理」（恢复判断能力，非「错！有香味」）；b2d-004 不训练「没有加
   香精」断言——「不能仅凭香气判断加香精 → 区分自身风味与添加物 → 以产品标注与
   渠道核实」。

## 十条清单（GPT 最终结构）

| ID | 能力 | 来源 | admission | 摘要 |
|---|---|---|---|---|
| b2d-001 | 健康前提纠正 | fda | **PASS** | 「一定伤身体」双向绝对化放下 + FDA 口径 |
| b2d-002 | 健康边界（无结论声明） | fda | **PASS** | 「上瘾」医疗概念——知识库无结论不判断 + 就医路径 |
| b2d-003 | 错误前提纠正 | ucdavis | BLOCK→对齐 | 直接对齐实验 B 幻觉「豆子无香味」 |
| b2d-004 | 错误归因纠正 | ucdavis | BLOCK→对齐 | 「香=加香精」归因——以产品信息核实替代猜测 |
| b2d-005 | 研究结论边界 | fda | **PASS** | 直接对齐实验 B「帕金森」幻觉——方向不断言 |
| b2d-006 | knowledge explanation | hario | BLOCK→对齐 | 手冲定义直接答到底，零追问 |
| b2d-007 | knowledge explanation | hario | BLOCK→对齐 | 洗滤纸单事实点标杆（原因→两点→操作） |
| b2d-008 | 主动诊断追问 | fellow | BLOCK→对齐 | 意式+「最近」时间信号（豆况优先排查） |
| b2d-009 | 事实锚点（储存） | nca | BLOCK→对齐 | 储存敌人+峰值衰退，直接解释 |
| b2d-010 | 事实锚点（研磨） | baratza+ucdavis | BLOCK→对齐 | 刻度不可照搬（Baratza claim 本体） |

## 门禁语义词扩展（随数据体系演进，需 GPT 知悉）

本轮实现 knowledge_explanation gate 时同步扩展了三个语义词表（均有 GPT 裁定依据）：

1. **UNCERTAINTY_MARKERS** += 「知识库没有相关结论 / 本知识库没有…」类——知识边界
   声明是不确定性表达的合法形态（b2c-003/b2d 系列的核心行为）；
2. **check_missing_information** 健康类豁免：topic=health 且含就医/咨询指引时，
   信息收集段可由专业指引替代（GPT 健康边界裁定：健康话题不收集症状做推断）；
3. **strong_claim 引用语境豁免**：命中词紧邻引号（引用用户原话/社会框架，如
   b2d-001 的「一定伤身体」）记 verdict=quoted-context pass；
4. **DIAG_CHAIN_MARKERS** += 「核实」（食品安全边界类的验证语义）。

b2b/b2c 草稿回归：均 PASSED（0 error / 0 warning）——扩展无破坏。

## 待负责人拍板

- 10 条建议动作均为 `approve_candidate`（GPT plan 已批准方向）。
- 批准落库后：例外 allowed_sample_ids 并入（ucdavis←b2d-003/004/010、
  hario←b2d-006/007、fellow←b2d-008、nca←b2d-009、baratza←b2d-010；fda 3 条免）；
  approved 25 → **35**、train 20 → **28**；之后实验 C（iters=100, lr=1e-5）。
- b2d-006/007 的 `knowledge_explanation` 为 interaction_skill 枚举新增值——落库前
  需同步更新相关文档中的枚举说明（本包作为 GPT 批准依据）。
