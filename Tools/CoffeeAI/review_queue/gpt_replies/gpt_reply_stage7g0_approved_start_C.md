# GPT 对 G-0 报告的核验回复 → 批准启动 Experiment C（2026-10-15 19:15 前后提取）

> 提取方式：main 对话区 lastIndexOf 锚点「以上，等待你的核验与下一步指示。」
> 对应我方报告：/tmp/gpt_stage7g0_done.txt（提交 180e012）

---

裁定：阶段七-F-4 通过，阶段七-G-0 也已完成。批准启动 Experiment C（100 iterations，学习率 1×10⁻⁵）。

我直接核对了 GitHub 远程 main：你这条消息引用的是提交 67442a2，但仓库后续已包含阶段七-G-0 的提交 180e012，以及之后的交接文档更新 ba745e6。因此，接下来应以更新后的配置和评测方案为准，而不是重新执行 G-0。

## 一、启动前核验结果

| 检查项 | 核验结果 |
|---|---|
| approved 数据 | 35 条 |
| train / valid / test | 28 / 4 / 3 |
| 数据泄漏检查 | 报告记录 leakage=0 |
| YAML 数组解析与往返测试 | 已补齐 |
| 训练准入 dry-run | 报告记录 Preflight 通过 |
| 基座模型 | Qwen2.5-3B-Instruct-4bit，已缓存 |
| Experiment C 配置 | 独立文件，未覆盖 A/B 配置 |
| 评测 system、ChatML、生成参数 | 已统一并冻结 |
| 自动化测试 | G-0 报告记录 143 tests OK |

主要文件：Experiment C 启动前核验报告、Experiment C 独立配置、Experiment C 评测方案、评测生成脚本。

以上是对远程代码与报告的核验，不是我亲自重新执行了测试或训练。依据现有记录，已满足启动条件。

## 二、阶段七-G：Experiment C 执行顺序

### G-1. 先保存训练前基线

在本地仓库根目录执行：

```bash
python3 Tools/CoffeeAI/training/run_eval_generation_c.py --base-only
```

该命令使用冻结后的 system prompt、显式 ChatML 和 greedy 解码策略，生成 20 道评测题的基座模型回答。

将原始输出单独归档，避免后续评测脚本覆盖 /tmp 中的基线文件：

```bash
mkdir -p /tmp/experiment_C_baseline
cp /tmp/evalC_gov_q*_base.txt /tmp/experiment_C_baseline/
cp /tmp/evalC_nat_q*_base.txt /tmp/experiment_C_baseline/
shasum -a 256 /tmp/experiment_C_baseline/*.txt > /tmp/experiment_C_baseline/SHA256SUMS
```

基线保存完成后，再进行实际训练。

### G-2. 启动 Experiment C

```bash
python3 Tools/CoffeeAI/scripts/run_train.py \
  --train \
  --config Tools/CoffeeAI/training/lora_experiment_C_config.yaml \
  --deployment-purpose noncommercial-research
```

这是实际训练，不是 dry-run。命令不会显式允许下载；如果模型缓存或准入检查失败，应停止并查看报告。

训练前还应确认输出目录 Tools/CoffeeAI/runs/lora_experiment_C_adapter 不存在。如果已存在，不要直接覆盖或删除，先检查是否有此前的运行产物。

本次参数保持冻结：

| 参数 | 值 |
|---|---|
| 基座模型 | Qwen2.5-3B-Instruct-4bit |
| LoRA rank | 8 |
| LoRA layers | 8 |
| Batch size | 1 |
| Iterations | 100 |
| Learning rate | 1e-5 |
| Max sequence length | 2048 |
| 数据 | train 28 / valid 4 / test 3 |

本次不修改 approved 数据、例外表或 split，不升级至 7B，不执行 adapter 融合，也不部署至应用。

训练结束后，先检查命令退出码、日志和 run_manifest.json。必须确认实际执行参数确为上述配置，lora_parameters.keys 是列表类型，训练准入错误为零。如果训练失败，不要继续评测并宣称实验完成。

### G-3. 生成训练后回答

训练成功后执行：

```bash
python3 Tools/CoffeeAI/training/run_eval_generation_c.py
```

这会生成基座模型与 adapter C 的回答。严格对比以本轮统一输入策略下的 Base vs Adapter C 为准；Experiment B 的旧结果因为输入策略不同，只作为趋势参考，不能直接混算分数。

## 三、Experiment C 的验收门槛

这次实验要回答的是：能否在改善行为的同时，维持事实可靠性？

六项必须逐项检查的指标：
1. **绝对化控制**：继续避免把「酸」等单一现象直接归因于欠萃，不能退回简单化答案。
2. **主动追问**：面对「咖啡不好喝」等信息不足的问题，真正询问有助于诊断的关键信息，而非只列原因。
3. **不知道能力**：价格与品质关系、具体花香机理等超出证据范围时，不编造结论。
4. **直接知识解释**：「什么是烘焙度」这类完整问题直接回答，不能把所有问题都变成追问。
5. **健康边界**：保留参考口径与个体差异，不作无依据的疾病风险断言。
6. **两项历史事实错误必须专项复核**：①「咖啡豆本身没有香味」；②关于咖啡与帕金森风险的反向断言。两项均须与基线和 Experiment B 原始回答对照。

沿用已冻结的评分体系：治理行为分至少达到 7/10，自然度不得比同策略基线下降超过 1 分（满分 20）。此外，两个历史事实错误必须消失，不能被总分掩盖；若出现新的严重事实错误，也不能判定成功。

需要特别注意：验证集只有 4 条，因此 validation loss 的变化只能作为辅助信号，不足以单独证明泛化能力。即使训练 loss 继续下降，也不能据此认定模型变好了。

## 四、训练完成后应提交的报告

生成：Tools/CoffeeAI/training/experiment_C_report.md

报告至少包含实际运行参数、训练与验证 loss、耗时、退出状态、adapter 路径、基线与训练后 20 题的逐项比较、行为分数、自然度分数、两个事实错误的专项结论，以及新增错误和模板化风险。

**最终指示：现在可以启动 Experiment C。这轮只验证 3B 的中低强度训练窗口。先取得可复现的回答对比，再决定要不要继续实验；不预设成功，也不因为 loss 下降就扩大训练。**
