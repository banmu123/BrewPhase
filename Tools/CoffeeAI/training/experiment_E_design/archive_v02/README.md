# Experiment E 设计包（v0.2，2026-10-16）

> **v0.2 修订依据**：GPT 对 v0.1 七件套的终审（存档
> `review_queue/gpt_replies/gpt_reply_experiment_E_v01_review_revision_required.md`）——
> 方向认可、暂不通过冻结；四项必改（验收集与 E1 闸门分离 / Schema 契约版本化 v2 /
> E2 记录对齐真实调用序列 / claim 授权分级）+ 逐文档修订意见已全部落实。**v0.1 原件
> 保留于 `archive_v01/`**，未静默改写任何已批准契约。
> 依据链：GPT 设计评审裁定（gpt_reply_experiment_E_design_ruling.md）+ E-7a/E-7b
> 裁定 + 负责人决策修订。完成后统一提交 GPT 复核 v0.2。

> 依据：GPT 设计评审终审裁定（`review_queue/gpt_replies/gpt_reply_experiment_E_design_ruling.md`，
> Q1–Q6 全部批准进入设计阶段；**训练尚未批准**）+ 负责人决策修订
> （`review_queue/owner_decision_revision_experiment_E.md`）。
> 本目录收敛 E 的全部设计产物；完成后统一提交 GPT 复核。

## 一、交付物清单与状态

| # | 交付物 | 文件 | 状态 |
|---|---|---|---|
| 1 | 决策输出 schema + 变量注册表 | `decision_schema_and_registry.md` | ✅ **v0.2**（schema v2 去 question 字段+治理记录；14 变量单变量纪律；claim 授权分级 design-only/training-candidate；light-roast-rest-4-6w 移出锚点） |
| 2 | 候选基座选择方案（零样本筛选设计） | `base_model_selection.md` | ✅ **v0.2**（字典序排序+最低门槛防「从不追问」胜出；Qwen3 生成模式一致性） |
| 3 | 人工审核 rubric（GPT 六门框架 → 仓库文档） | `human_review_rubric.md` | ✅ **v0.2**（synthetic_fields 机器可查；双人工终审角色定义+分歧流程） |
| 4 | 冻结评测集规范 + 评分脚本设计（Product Eval v1） | `product_eval_v1_spec.md` | ✅ **v0.2**（评测资产边界表+E1 阶段验证集 40 案例独立闸门；案例唯一目标变量；实际通过数门线；E-e 独立判据；C/D 分型回归） |
| 5 | E1/E2 训练策略 | `e1_e2_training_strategy.md` | ✅ **v0.2**（第二次调用契约冻结：回答上下文不含内部 JSON；决策记录上下文=渲染后历史；新旧脚本字段映射表；泄漏检查以目标消息为准） |
| 6 | 旧样本映射清单（43 条选择性复用） | `legacy_samples_mapping.md` | ✅ v0.1（处置总表/b2e-005~008 复核清单/独立版本溯源；终审未提修改意见） |
| 7 | 目标 App 运行方案 | `app_runtime_plan.md` | ✅ **v0.2**（行为一致性验收替代逐位校验；内存改规划估算+真机实测方案；Qwen3 模式一致性） |

> **七件套全部产出（2026-10-16）。** 均为 v0.1 草案，统一提交 GPT 复核；其 15:28 后
> 恢复文件分析可读全文。复核通过 + 负责人确认评测集冻结后，才进入数据生成与
> 基座筛选执行；训练仍需单独授权。

## 二、GPT 裁定约束速查（设计时逐条对照）

- **Q1 schema v1**：`{schema_version, action: clarify|answer, missing_variable_id, question, reason_code}`；
  answer 时 missing_variable_id/question = null；missing_variable_id 必须来自受控变量枚举；
  校验通过才呈现追问；解析失败/字段不合法/输出为空 → **fail-closed 降级现行 RAG 直答** + 记录异常；
  变量定义建**独立注册表**，IntelligenceConfig 只放阈值与开关。
- **Q2 基座**：Qwen2.5-3B-4bit（历史对照）/ Qwen3-4B-4bit（主候选）/ 7B 级 4-bit（上限候选）零样本筛选；
  **开发集 ≠ 验收集**；最终只选一个进 E1；选型前核验实际模型许可证
  （Qwen2.5-3B = qwen-research；Qwen3-4B / Qwen2.5-7B-Instruct = Apache-2.0，以实际下载版本为准）。
- **Q3 数据**：轻粒度 synthetic 标记 + 事实逐 claim 可追溯；轨迹元数据七字段
  （trace_id / behavior_class / synthetic_scenario / claim_ids / interaction_skill /
  review_* / split_group_id）；样本获批 ≠ 无限制授权。
- **Q4 评测**：三层计分（决策机械判分 / claim-grounding 脚本+人工 / 固定裁判模型+20% 抽检）；
  门线草案：正确追问 ≥85%、误追问 ≤10%、接续成功 ≥85%、跳过处置 ≥90%、严重编造 0、
  自然度（20 分制）降幅 ≤1；报告列分母/通过/失败；**评测集冻结后不得调门线**。
- **Q5 分期**：E1 = 决策行为（schema 合法率/正确追问/误追问/变量选择/事实回归）；
  E2 = 完整多轮（独立输出路径，保留 E1 产物）；E1 达标 ≠ E2 授权。
- **Q6 旧数据**：6 条单轮 clarification 不并入；b2e-005~008 复核后可作 C 类候选；
  其余选择性转换；E 数据集独立版本 + 去重 + split_group_id 防泄漏。
- **E-7a 推理编排（方案②，裁定 2026-10-16）**：决策与正文**解耦**——
  ① 决策调用：模型只输出决策 JSON，代码解析校验；② 代码编排：clarify → 展示问题
  等用户补充（不提前生成正文）、跳过 → 记录状态、answer → 进正文路径；③ 回答调用：
  代码组装对话历史+补充信息+RAG 上下文 → 第二次调用生成纯正文（不输出 JSON）。
  **两段式 = 决策阶段与回答阶段分开，不是每次追问后连续两次调用**——追问分支必须
  等真实下一轮用户输入。
- **E-7b E1 目标序列**：assistant 训练目标 = 纯决策 JSON（无正文、无 XML/Markdown
  围栏/自然语言包裹）；answer 时 JSON 内 missing_variable_id/question = null。
- **三条补充约束**：① **每个用户新回合重新决策**——收到补充/跳过后基于更新后的
  对话历史再次决策调用，校验得到 answer 后才进正文（旧 clarify ≠ 新 answer）；
  ② E2 训练目标按调用职责分开（决策调用目标 JSON / 回答调用目标纯正文），输入模板
  明确任务，并说明 E2 如何保留 E1 决策能力 + 回归评测检查遗忘；③ **MLX-LM 数据
  构造与目标序列对齐**——chat 数据支持 `{"messages": [...]}` + `--mask-prompt`
  （启用时最后一条 assistant 消息为训练目标）；每条训练记录明确目标 assistant 消息，
  **完整多轮轨迹不得放一条记录**——一条轨迹拆成目标明确的训练记录，保留共同
  轨迹 ID 与分组标识，整组进同一集合防泄漏。

## 三、方法论参考：rasbt/LLMs-from-scratch（负责人指定，2026-10-16）

仓库：<https://github.com/rasbt/LLMs-from-scratch>（Sebastian Raschka，
*Build a Large Language Model (From Scratch)* 官方代码库，PyTorch 从零实现教学）。

定位声明：**方法论与概念参照，不是代码依赖**——本项目训练栈为 MLX-LM，不引入
PyTorch 实现。映射关系：

| LLMs-from-scratch 章节 | 对应 E 设计包工作 | 借鉴点 |
|---|---|---|
| appendix-E（LoRA 参数高效微调） | E1/E2 训练策略 | LoRA 机制从零理解：目标模块选择、rank/alpha 取值逻辑、合并与导出——为 MLX LoRA 超参数选择提供依据 |
| ch07（指令微调）+ ch07/05（数据生成：llama3-ollama 生成 + GPT-4 反思改进） | 数据规划与 AI 辅助生成流程 | 「AI 生成 + 反思改进 + 人工把关」的流水线形态——与我们「AI 辅助扩展场景 + 逐条人工审核 + 六门 rubric」同构 |
| ch06（文本分类微调） | E1 决策行为 | clarify/answer 决策的类比：受限输出空间的行为学习；分类微调的数据平衡与评估思路 |
| ch07/03 模型评测 + 姊妹库 reasoning-from-scratch chF/04（LLM-as-a-Judge） | Product Eval v1 第三层 | 固定裁判 prompt、隐藏身份、分层人工抽检的裁判协议 |
| ch07/04（DPO 偏好微调，bonus） | 远期备选 | 若 E2 后行为仍不稳，偏好微调是备选路径（记录为远期，不在 E 范围） |

**v0.2 增补（GPT 终审第三节裁定）**：
- ch07 指令样本格式、训练/验证划分与训练目标构造部分 → 补入 E1/E2 数据构造参照；
- **MLX-LM 官方文档（chat 数据格式、--mask-prompt、训练命令与版本约束）为实施规范的
  唯一权威来源**——教学仓库只作机制理解，不作实施依据；
- ch06 分类微调类比有限决策空间，但**分类任务 ≠ 生成式 JSON 决策**，不照搬训练头
  与评测形式。

已识别差距：该仓库以单轮 instruction-response 为主，**多轮对话组织无专门章节**——
E 的多轮 ChatML 轨迹 schema 以 MLX-LM 的 chat 格式约定为准，GPT 裁定的七字段元数据
由我方自行设计（其中 P/I 语义分层沿用既有 Batch2e 惯例）。

## 四、红线（贯穿设计包全程）

1. 训练未批准：不下载新基座用于训练、不启动 E1/E2、不覆盖 C/D 适配器与历史产物。
2. 基座筛选只做零样本推理评测，不含下载豁免。
3. 评测集与开发集分离；评测集冻结后门线不得调整。
4. E 数据集独立版本管理；不批量搬入旧 43 条。
