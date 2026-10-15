# LoRA Experiment D Report（Batch2e 追加数据验证，2026-10-15）

> 实验设计（GPT 批准，gpt_replies/gpt_reply_batch2e_approved_experiment_D.md）：
> 验证追加 Batch2e（clarification 4 + 直答 4）后，3B 模型能否更好处理信息不足
> （主目标：治理 Q5/Q6 有效信息澄清），同时避免「万事追问」。**只允许一轮**，
> 参数冻结沿用 Experiment C。验收标准在生成 adapterD 结果前已锁定（见下）。

## 一、训练参数与过程（GPT 前置三步全部完成后执行）

| 项 | 值 |
|---|---|
| 前置 1 基线归档 | /tmp/experiment_D_batch2e_baseline/（20 题 + SHA256SUMS + METADATA.json：模型/commit/脚本 SHA/推理参数） |
| 前置 2 评测隔离 | run_eval_generation_c.py 参数化（--adapter-path/--out-prefix，向后兼容默认不变）；D 用 --out-prefix evalD |
| 前置 3 训练前门禁 | tokenizer 交叉校验 **True**；dry-run Preflight 通过（数据 35/4/4、hf-cache 无下载） |
| run_id | train_20261015_230830（exit 0，4m00s） |
| 参数冻结核验 | iters=100 / lr=1e-5 / batch=1 / layers=8 / rank=8 / seed=0；**keys=list**；admission errors=0；data=lora-v3-batch2e（35/4/4） |
| train/val loss | train 3.296 / val 3.302（量级与 C 相当——数据+8 条，梯度步同 100） |
| adapter | Tools/CoffeeAI/runs/lora_experiment_D_batch2e_adapter |

## 二、冻结验收标准逐项裁定（结果生成前已锁定）

| 验收项 | 通过要求 | 实际结果 | 裁定 |
|---|---|---|---|
| **主目标 Q5/Q6** | 两题都表现出有效信息澄清（先抓关键缺失信息，不猜原因、不冗长问卷） | **q5/q6 均为 7 条建议清单式回答，零澄清追问**——与 base/C 行为相同 | **未达成** |
| 总体行为分 | ≥ 7/10 | **6.0/10**（分项：拒伪 1.5 + 追问 0 + 不知道 0.5 + 健康边界 2 + 多变量 2 = 6.0——v1 报告误写 6.5，按 GPT 终审核对的算术修正） | **未达标** |
| 自然度 | 相对 D 同策略基座下降 ≤1 | base 18/20 → D ≈ **15.5/20（-2.5）** | **未达标** |
| 历史事实错误 | 不重现实验 B 两项错误 | q8 无「豆子无香味」、nat_q4 无帕金森断言 | ✓ |
| 新增重大事实错误 | 不出现新回归 | **gov_q8 编造「人工添加茉莉花香/茉莉花精油/香料」因果链；gov_q4 编造「国际咖啡组织（ICO）规范」来源**；nat_q4 糖脂失实与 nat_q7 豆油「成熟/发酵」机理编造沿用 C | **未达标** |
| 防过度追问 | N3/N6-N10 直接回答、N1/N5 有帮助回应 | 全部直接回答，无「万事追问」 | ✓ |

**总判定：Experiment D 未通过冻结验收——主目标未达成 + 新增重大事实编造。**

## 三、关键观察（诊断性试验的价值）

1. **追问能力依然零学出**：追加 4 条 clarification（clarification 2→6，占比 14%）+
   100 iters，q5/q6 行为与 base/C 完全相同（清单式回答）。四轮实验记录中，A/B 仅供
   趋势参考（评测输入策略不同），C/D 为同一策略下的严格对比——两者一致表明：**在本方案（Qwen2.5-3B-4bit + ≤43 条数据 + 100-200 iters LoRA）范围内，学不出主动追问行为**——瓶颈更可能在数据规模/方法（如需要数量级更多的澄清对话、或不同的训练目标），而非迭代强度；此结论限定于本次方案与数据范围，不外推到所有模型/数据规模/方法。
2. **事实回归持续存在且内容漂移**：C 的编造（豆油成熟/发酵、糖脂失实）在 D 重现；
   D 还新增 q8「人工添加香精/精油」编造链与 q4「ICO 规范」来源编造——小数据微调对
   3B 事实可靠性的扰动是系统性的，不随追加 8 条对齐数据消失。
3. **保持的优点**：绝对化纠偏（q1/nat_q2 开篇拆变量）、拒伪标准（q3）、健康边界、
   防过度追问（全部直答题直接回答）——与 C 相同的正面行为全部保留。
4. **归因表述**（GPT 要求）：以上是「Batch2e 这组新增数据（clarification+直答混合）
   带来的行为变化」，不能单独归因于 clarification 样本。

## 四、与 Experiment C 对比

| 维度 | C（35 条） | D（43 条 = 35 + Batch2e 8） |
|---|---|---|
| 行为分 | 7/10 | 6.0/10（q8 编造加重「不知道」维度扣分；v1 误写 6.5 已按分项复算修正） |
| 自然度 | 16.5/20（-1.5） | ≈15.5/20（-2.5） |
| 追问 | 0 | 0 |
| 两项历史错误 | 消失 | 消失 |
| 新增编造 | nat_q7 豆油机理、nat_q4 糖脂 | 沿用 + **q8 香精编造链、q4 ICO 来源** |

## 五、结论与建议（供 GPT 裁定）

- **Experiment D 未通过冻结验收**（行为分 6.0/10，v1 报告算术误写 6.5 已修正——无论 6.0 或 6.5 均低于 7 分门线，终裁不变）——与 C 一样未判成功，且新增编造说明「同参数重训+追加 8 条」不改善追问，反而引入新的事实回归风险。
- 三个实验（C/D）一致的证据链：**3B + ≤43 条数据的 LoRA 微调无法学出主动追问**，
  且每次训练都伴随事实回归——支持 GPT「不恢复参数搜索线」的裁定，也提示追问能力
  的实现路径需要重新评估（更大规模澄清数据集、RAG/规则层实现追问逻辑、或更强基座），
  属于产品方案决策而非训练参数问题。
- 建议议题（供 GPT 裁定）：① 3B 微调线是否正式关闭（数据侧已验证到 43 条规模）；
  ② 追问能力是否转产品层实现（BrewPhase 现有规则/IntelligenceConfig 层）；③ 后续
  是否冻结 LoRA 管线为「链路验证完成」归档。

## 六、边界遵守

只训练一次（无参数搜索/追加迭代）；未覆盖 C 的配置/适配器/评测产物/历史报告
（evalD 独立前缀 + 独立 adapter/runs 目录）；未融合、未部署；approved/例外/split
历史版本未动；143 tests OK（落库提交时点）。

## 附：产物

- **可远程审计包（已入库）**：training/experiment_D_audit_pack/——
  METADATA.json（模型/commit/脚本 SHA/推理参数）、baseline_SHA256SUMS.txt、
  answers/（20 题 base + 20 题 D 原始回答）+ answers_SHA256SUMS.txt、
  effective_config.yaml（实际生效配置）、manifest_summary.json（训练 manifest 摘要，
  完整 manifest 与日志本地保留于 runs/train_20261015_230830/）、scoring.md（逐题
  评分依据）。
- 本地完整产物（模型权重与日志不入库）：/tmp/experiment_D_batch2e_baseline/、
  /tmp/evalD_{gov,nat}_q*_base.txt、/tmp/evalD_{gov,nat}_q*_adapter.txt、
  runs/train_20261015_230830/{run_manifest.json, effective_config.yaml}、
  runs/logs/train_20261015_230830.log、runs/lora_experiment_D_batch2e_adapter/
