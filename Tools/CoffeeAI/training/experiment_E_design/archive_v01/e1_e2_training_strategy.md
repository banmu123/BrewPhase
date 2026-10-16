# Experiment E 交付物⑤：E1/E2 训练策略

> 依据：GPT Q5 裁定（两阶段、E1 达标 ≠ E2 授权）+ E-7a/E-7b 裁定（方案②编排、
> E1 目标 = 纯决策 JSON）+ E-7 三条补充约束（每回合重新决策 / E2 目标按调用职责
> 分开 / MLX-LM mask-prompt 与轨迹拆分）。v0.1 草案；**训练未批准，本文件只定义
> 计划**；超参数不在本文件冻结（批准训练时另出实验配置走既有 preflight 门禁）。

## 一、数据单位定义（E-7 约束③的落实）

- **轨迹（trace）**：一个完整交互场景，元数据七字段（见交付物③）。
- **训练记录（record）**：一条 MLX-LM chat 样本 `{"messages": [...]}`，目标明确——
  **一条轨迹拆成多条训练记录**，绝不把完整多轮轨迹塞进一条记录。
- 每条记录携带 `trace_id` + `split_group_id`；划分时**整组同集合**（check_training_leakage
  按 split_group_id 扩展）。

### 决策记录（E1 全部、E2 保留）

```json
{"messages": [
  {"role": "system", "content": "<决策任务模板 E1-DECISION-v1：说明当前任务=输出决策 JSON、schema 定义、变量注册表枚举>"},
  {"role": "user", "content": "我的手冲最近又苦又涩，怎么办？"},
  {"role": "assistant", "content": "{\"schema_version\":\"1\",\"action\":\"clarify\",\"missing_variable_id\":\"grind_size\",\"question\":\"…\",\"reason_code\":\"insufficient_diagnostic_information\"}"}
]}
```

- 目标 = **最后一条 assistant 消息（纯 JSON）**，训练用 `--mask-prompt` 只对它计损。
- 多轮决策轨迹（A/B 类）按「每个用户新回合重新决策」拆成多条决策记录：第 1 轮
  （→clarify）、第 2 轮（带补充信息 →answer 或再 clarify）、跳过轮（→answer）各自成记录。
- A/B/C/D 四类都要有决策记录（Q5：数据同时包含应追问与应直答的例子）。

### 回答记录（仅 E2）

```json
{"messages": [
  {"role": "system", "content": "<回答任务模板 E2-ANSWER-v1：说明当前任务=生成回答正文、F/P/I 分层惯例、引用 claim 边界>"},
  {"role": "user", "content": "…首轮问题…"},
  {"role": "assistant", "content": "<决策 JSON（保持 E1 学到的能力）>"},
  {"role": "user", "content": "…用户补充…"},
  {"role": "assistant", "content": "<纯正文回答，F/P/I 分层>"}
]}
```

- 目标 = **最后一条 assistant（纯正文）**，同样 `--mask-prompt`。
- 倒数第二条 assistant 放决策 JSON——输入侧呈现真实编排状态（E-7a 方案②），让模型在
  上下文中见到自己此前的决策，**但损失只落在正文上**。
- 正文沿用 Batch2e 的 F/P/I 对称标记惯例（脚本三层检查沿用，含「全 0 不判通过」）。

## 二、E1：结构化决策行为

| 项 | 计划 |
|---|---|
| 训练目标 | 纯决策 JSON（E-7b） |
| 数据 | 轨迹拆分的决策记录；300–500 轨迹 ≈ 350–700 决策记录（每轨迹 1–3 轮决策）；四类行为覆盖 A≈40%/B≈15%/C≈35%/D≈10% |
| 输入模板 | system 明确「只输出决策 JSON」；对话历史注入（多轮记录含此前轮次） |
| 评测 | 开发集决策指标（合法率/正确追问/误追问/变量相符）+ **Product Eval v1（验收）** + C/D 20 题回归（事实不劣化） |
| 通过条件 | 门线全过（正确追问 ≥85%、误追问 ≤10%、接续 ≥85%、跳过 ≥90%、编造 0、自然度降幅 ≤1）→ 才申请 E2 |
| 超参数 | **不复制 D**：待 E1 数据定稿后按数据量重算 iters/epochs；lr、rank 等以 LLMs-from-scratch appendix-E 的 LoRA 机制理解 + 小规模扫描方案**单独提交 GPT 审批**；早停锚定开发集决策指标 |

## 三、E2：完整多轮行为与回答质量

| 项 | 计划 |
|---|---|
| 前提 | E1 全门线通过 + GPT 批准 E2（E1 达标 ≠ 自动授权） |
| 训练目标 | 双记录混合：**决策记录（保留 E1 能力）+ 回答记录（新能力）**，混合比例在 E1 结果出来后定（初稿建议决策:回答 ≈ 3:7，防遗忘优先） |
| 输出路径 | **独立 E2 目录**（lora_experiment_E2_*），E1 适配器原样保留用于回退与对比（Q5 裁定） |
| 继续训练策略 | 首选 **E1 adapter 续训**（省算力、保留决策能力）；对照路径「从 base 重训双目标」仅在续训出现决策遗忘且混合比例调不平再评估——两条路径都需 GPT 批准 |
| 评测 | Product Eval v1 全量 + C/D 回归 + **E1 决策指标复测**（遗忘检查，GPT 补充约束②）；正文走 L3 裁判协议 |
| 通过条件 | 门线全过且决策指标无显著回退 → 才进入 App 运行方案验证（交付物⑦） |

## 四、失败归因设计（Q5 裁定的动机）

E1/E2 拆开使得失败可归因：E1 失败 = 决策行为学不出（回到「假设本身有问题」）；
E1 过、E2 失败 = 决策已可学、多轮正文质量是瓶颈。对照 C/D 混合训练「败因不可分」
的核心教训。任一阶段失败：封存该阶段产物、更新审计包、GPT 裁定下一步——**不自动
重试、不加训练强度**。

## 五、训练前门禁（沿用既有管线）

1. `validate_data.py --for-training`（E 数据集独立版本 + --deployment-purpose）
2. split（seed 固定、split_group_id 整组同集合）+ `check_training_leakage.py`（扩展版）
3. `run_train.py --dry-run`（preflight：数据指纹、模型来源 hf-cache、无下载）
4. 训练 manifest 双哈希 + 审计包入库（C/D 惯例）
5. **未获 GPT 训练授权前，1–4 全部只做只读演练（dry-run），不启动真实训练**
