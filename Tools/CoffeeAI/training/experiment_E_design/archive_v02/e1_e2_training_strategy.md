# Experiment E 交付物⑤：E1/E2 训练策略 v0.2

> **v0.2 修订依据**：GPT v0.1 终审——终审问题 3（E2 回答记录与真实调用序列不一致）
> + 问题 1（E1 闸门改用独立阶段验证集）+ ⑤ 节意见（新旧脚本字段映射表、泄漏检查以
> 目标消息为准）。v0.1 原件保留于 `archive_v01/`。

## 〇、v0.1 → v0.2 变更记录

| # | 变更 |
|---|---|
| 1 | **第二次生成调用契约冻结（§1.3）**：回答调用上下文 = 纯用户可见历史（渲染后追问为 assistant 自然语言消息），**不含任何决策 JSON**；回答记录按此构造——修正 v0.1「上下文里放决策 JSON」的设计 |
| 2 | 决策记录同步对齐真实调用输入：第 2 轮决策调用的历史中，上一轮追问以**渲染后的自然语言**出现（UI 展示什么，训练就放什么），内部协议不混入用户可见消息 |
| 3 | E1 闸门改用 **E1 阶段验证集**（交付物④§二）；Product Eval v1 仅为 E2 冻结后的最终验收 |
| 4 | 新增 **§四 字段映射表**：新轨迹模型 → MLX-LM 训练记录 → 既有准入/划分/泄漏脚本的具体扩展 |

## 一、数据单位与调用契约

### 1.1 轨迹 → 训练记录（不变，E-7 约束③）

一条轨迹按调用职责拆成多条记录，每条记录目标是**最后一条 assistant 消息**，
`--mask-prompt` 只对它计损；全部记录携带 `trace_id` + `split_group_id`。

### 1.2 决策记录（v2 schema，上下文对齐真实调用）

```json
{"messages": [
  {"role": "system", "content": "<决策任务模板 E1-DECISION-v2：任务=输出 schema v2 决策 JSON；变量枚举；无 question 字段>"},
  {"role": "user", "content": "我的手冲最近又苦又涩，怎么办？"},
  {"role": "assistant", "content": "你说的『又苦又涩』更像哪一种——焦苦发涩，还是说不上来的闷味？"},   ← 渲染后追问（v0.1 为 JSON，v0.2 修正）
  {"role": "user", "content": "焦苦发涩那种，最近才开始的。"},
  {"role": "assistant", "content": "{\"schema_version\":\"2\",\"action\":\"answer\",\"missing_variable_id\":null,\"reason_code\":\"information_sufficient\"}"}
]}
```

- 上一轮 assistant 消息 = **UI 实际展示的渲染问题文本**（终审问题 3：训练反映真实
  对话历史；内部 JSON 不进入用户可见历史）。
- 第 2 轮及以后每回合一条决策记录（E-7 补充约束①：每回合重新决策）。

### 1.3 回答记录（**第二次生成调用契约，冻结**）

**契约（v0.2 冻结）**：回答调用的输入 = 回答任务模板 + **纯用户可见对话历史**
（用户问题、渲染后的追问、用户补充），**不传入任何决策 JSON**。决策结果通过代码
状态（`DecisionParser` 校验通过 + `pending_variable` 解析）耦合到正文调用，不通过
上下文传递。

```json
{"messages": [
  {"role": "system", "content": "<回答任务模板 E2-ANSWER-v2：任务=生成回答正文；F/P/I 分层惯例；claim 引用边界>"},
  {"role": "user", "content": "我的手冲最近又苦又涩，怎么办？"},
  {"role": "assistant", "content": "你说的『又苦又涩』更像哪一种——焦苦发涩，还是说不上来的闷味？"},
  {"role": "user", "content": "焦苦发涩那种，中细研磨，15g/225g，92 度。"},
  {"role": "assistant", "content": "<纯正文回答，F/P/I 分层>"}
]}
```

- 依据：E-7a 实现中 DecisionParser 持有状态、UI 只展示渲染问题——训练分布必须等于
  推理分布（终审问题 3：「如果实际实现不会传入它，就不要只为了保留决策能力而在
  训练样本中添加它」）。
- E1 决策能力在 E2 的保留方式 = **决策记录作为独立样本混合训练**（§三），不在回答
  上下文里塞 JSON。

## 二、E1：结构化决策行为

| 项 | 计划（v0.2 更新） |
|---|---|
| 目标 | 纯 schema v2 JSON（E-7b，字段集精简） |
| 数据 | 决策记录（四类行为都有）；300–500 轨迹 ≈ 350–700 条决策记录 |
| **闸门** | **E1 阶段验证集**（40 案例，交付物④§二：合法率 ≥38/40、正确追问 ≥16/20、误追问 ≤3/20、变量相符 100%）——**不再使用 Product Eval v1** |
| 阶段验证不通过时 | 修订**下一版数据/训练计划**并重新走 GPT 审批；不得回头改阶段验证集或门线 |
| 超参数 | 不复制 D；数据定稿后单独出实验配置（参考 LLMs-from-scratch appendix-E 的机制理解 + **MLX-LM 官方训练文档为准**）提交 GPT 审批 |

## 三、E2：完整多轮行为

| 项 | 计划（v0.2 更新） |
|---|---|
| 前提 | E1 阶段验证集全门线通过 + GPT 批准 |
| 数据 | 决策记录（保留 E1 能力，独立样本）+ 回答记录（§1.3 冻结契约）混合；初稿比例决策:回答 ≈ 3:7 |
| 输出路径 | 独立 E2 目录；E1 产物保留 |
| **验收** | E2 训练**冻结后**运行 Product Eval v1 一次（最终验收，含 L3 自然度与 C/D 分型回归）；失败 → GPT+负责人裁定，不静默重训 |
| 遗忘检查 | E1 阶段验证集复测（决策指标无显著回退） |

## 四、新数据模型 → 既有脚本的字段映射表（终审 ⑤ 项落实）

| 新字段（E 记录） | 既有脚本字段 | 扩展方案 |
|---|---|---|
| `record_id` | `validate_data.py` 的 `sample_id` | E 记录直接以 `record_id` 作为 `sample_id` 写入（`e2t-a001#d2` 格式，兼容现有校验器） |
| `trace_id` | （新增列） | 校验器新增可选字段检查：同 trace 记录的 `behavior_class`/`split_group_id` 一致性 |
| `split_group_id` | `split_dataset.py` 的 `group_id` | 划分脚本加 `--group-field split_group_id`（默认仍读 group_id，向后兼容） |
| 目标 assistant 消息 | `check_training_leakage.py` 比较 | 泄漏检查扩展：**以各记录的目标消息（mask-prompt 的 completion）为比较对象**，并按 split_group_id 整组检查跨集合出现；不再只看第一条 assistant |
| `deployment_purpose` | `validate_data.py --deployment-purpose` | E 数据集跑非商业研究声明；**商业部署需授权边界完成（交付物①§2.4）后另行走审批** |

## 五、训练前门禁（不变，未授权前全部只读）

validate（E 独立版本 + 部署用途声明）→ split（split_group_id 整组同集合，seed 固定）
→ leakage（扩展版：目标消息粒度 + 整组检查）→ dry-run preflight → manifest 双哈希
+ 审计包。**E1/E2 训练仍未批准。**
