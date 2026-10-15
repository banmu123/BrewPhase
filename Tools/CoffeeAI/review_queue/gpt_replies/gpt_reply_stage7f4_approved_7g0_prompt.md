# GPT 阶段七-F-4 核验回复 → 阶段七-G-0 提示词（2026-10-15 18:45 前后提取）

> 提取方式：main 对话区 lastIndexOf 锚点「以上，等待你的核验与下一步指示。」
> 页面末尾出现「消息传输超时。请重试。」为 UI chrome，回复主体完整。
> 对应我方报告：/tmp/gpt_stage7f4_done.txt（67442a2）

---

我已直接读取 GitHub 上的 main 分支相关文件。先给结论：

阶段七-F-4 的数据落库结果通过静态核验，可以继续阶段七-G。但我发现训练启动器存在一个需要先解决的配置解析风险，因此不建议立即启动实验 C。

另外，我从远程提交列表中读到，67442a2 是阶段七-F-4 的完成提交，之后 main 还有 ba745e6 交接文档更新。下面的判断基于当前 main 中实际读取的文件，而不只是你的执行摘要。

## 一、阶段七-F-4 核验结果

| 项目 | 结论 |
|---|---|
| 训练数据规模：35 条 approved；train 28、valid 4、test 3 | 通过 |
| 数据治理与泄漏检查：审计文档记录 leakage=0，且各批次已有准入记录 | 通过 |
| LoRA 数据转换：转换脚本已包含 batch2d，行级 skill 元数据也进入了转换逻辑 | 通过 |
| 正式实验启动器：需要确认 YAML 数组经过解析、写回后仍保持列表类型 | 先修复 |

核验依据包括 Training Data Audit v2、数据转换脚本和训练启动器。

需要说明：这些是对远程代码和报告的静态核验，不代表我在本地重新运行了 130 项测试或 MLX 训练。

## 二、实验 C 前必须解决的配置问题

我检查了目前远程 main 中的 run_train.py 和 lora_dry_run_config.yaml，发现一个值得优先排除的问题。

配置文件包含：

```yaml
lora_parameters:
  keys: ["self_attn.q_proj", "self_attn.v_proj"]
```

但启动器里的 _scalar() 解析逻辑目前处理的是引号字符串、布尔值、空值和数字，没有明确解析以 [ 开头的数组。

这意味着，当 run_train.py 解析配置、再生成有效配置时，lora_parameters.keys 可能从列表变成普通字符串。这与阶段七-D 报告提到的 YAML 数组问题属于同一类风险。

这并不代表已经确认实验 B 使用了错误配置，也不代表实验 C 一定会失败。但是，在依赖启动器进行正式实验之前，必须用测试证明解析后的类型正确。

另外，现有 lora_dry_run_config.yaml 仍然是 20 iterations 的历史配置。实验 C 应使用单独的配置文件，不能直接覆盖实验 A 的记录。

## 三、下一步：阶段七-G-0，实验 C 启动前检查

先让编码模型完成以下工作。这个小阶段只处理配置可靠性和评测可比性，不重新审核数据，也不修改已批准样本。

**阶段七-G-0：Experiment C 启动前配置核验与评测冻结**

目标：在运行 Experiment C（Qwen2.5-3B-Instruct-4bit，LoRA 100 iterations，learning rate 1e-5）前，确保训练配置的解析、写回、数据准入和评测输入完全可靠。当前 approved 数据为 35 条，split 为 train 28 / valid 4 / test 3。本阶段不启动训练、不下载模型、不修改 approved 数据。

### 1. 修复并测试 YAML 数组解析

检查：Tools/CoffeeAI/scripts/run_train.py
重点检查 parse_simple_yaml()、_scalar() 和 dump_yaml()。

要求：
- lora_parameters.keys 解析后必须是 Python list，而不是字符串。
- 合法的 JSON 风格数组应能正确解析。
- 对声明为数组却无法解析的值，必须明确报错，不能静默降级为普通字符串。
- 增加单元测试，覆盖解析、写回、再次解析的往返一致性。
- 明确测试结果必须满足：keys == ["self_attn.q_proj", "self_attn.v_proj"]
- 保留其他现有配置行为和测试。

如果发现当前 main 与阶段七-D 报告所称修复不一致，请在报告中明确记录，不要假定修复已经存在。

### 2. 创建独立的 Experiment C 配置

新增：Tools/CoffeeAI/training/lora_experiment_C_config.yaml

参数：
- model：mlx-community/Qwen2.5-3B-Instruct-4bit
- fine_tune_type：lora
- iters：100
- learning_rate：1e-5
- batch_size：1
- num_layers：8
- lora rank：8
- max_seq_length：沿用已经验证的 2048
- data：Tools/CoffeeAI/training/data/lora
- adapter_path：Tools/CoffeeAI/runs/lora_experiment_C_adapter

保持原始 lora_dry_run_config.yaml 不变，避免覆盖 Experiment A 的历史配置。

不要更改其他训练参数，除非发现明确的兼容性错误；如需更改，记录原因并等待复核。

### 3. 核验数据转换文档一致性

检查：Tools/CoffeeAI/training/prepare_lora_dataset.py

文件说明应与实现一致。当前实现保留完整 messages，包含 system 消息；文档中不能再声称 system 消息不会进入训练。

只修正文档说明，不要删除 system 消息，不要重算审核指纹，不要修改 approved 语料。

然后验证生成数据包含 35 条，split 为 28/4/3，所有 approved 样本的 interaction_skill 元数据映射正确。

### 4. 冻结 Experiment C 评测方案

参考：
- Tools/CoffeeAI/training/dry_run_eval_set.md
- Tools/CoffeeAI/training/evaluation/natural_behavior_eval.md
- Tools/CoffeeAI/training/lora_experiment_B_report.md

确保训练前、Experiment B、Experiment C 使用可比的评测题、相同推理参数与相同的 system-prompt / chat-template 策略。

特别修正此前跑题的 V60 测试：题目必须明确处于手冲咖啡语境。新旧题目不同的结果不能直接混作严格的分数对比。

评测必须覆盖：
- 绝对化控制
- 主动追问
- 不知道能力
- knowledge_explanation：应答时不过度追问
- 健康边界
- Experiment B 出现的两个事实错误：「咖啡豆本身没有香味」、关于咖啡与帕金森风险的反向断言

如评测脚本目前没有向基座模型和 adapter 传递一致的 system-prompt / chat-template，先修复并加入测试，不要直接开始 Experiment C。

保留历史评测文件和 Experiment B 原始记录，不要覆盖。

### 5. 运行只读验证

修复完成后运行：

```
python3 Tools/CoffeeAI/tests/test_coffeeai.py
python3 Tools/knowledge/build_kb.py --check
python3 Tools/CoffeeAI/training/prepare_lora_dataset.py
python3 Tools/CoffeeAI/training/check_training_leakage.py
python3 Tools/CoffeeAI/scripts/run_train.py --dry-run --config Tools/CoffeeAI/training/lora_experiment_C_config.yaml --deployment-purpose noncommercial-research
```

如果命令的实际接口与上述写法不同，先核对 --help 并在报告中记录，不要伪造通过结果。

验收要求：
- YAML 数组解析正确；
- 35 条数据映射完整；
- leakage=0；
- 训练准入无错误；
- dry-run 不训练、不下载模型；
- 全部测试通过。

### 6. 输出报告

新增：Tools/CoffeeAI/training/experiment_C_preflight_report.md

记录修改文件、测试结果、配置摘要、评测一致性检查，以及是否满足启动 Experiment C 的全部条件。

禁止：正式训练、下载模型、修改 approved 数据、修改 source_exceptions.json、修改 train/valid/test 划分、覆盖历史实验报告。

完成后停止，等待负责人确认启动 Experiment C。

## 四、通过 G-0 后如何执行 Experiment C

G-0 的所有硬性检查通过后，再执行 100 iterations / 1×10⁻⁵ 的 Experiment C。

我建议仍采用 run_train.py 这个带训练准入复查的入口，不直接绕过治理检查调用底层命令。训练时不加 --allow-download；如果模型不在本地缓存，应该停止并报告，而不是临时下载。

评测不只比较 loss，还要将三个版本在相同问题上的回答并列：
1. Base model
2. Experiment B（200 iterations，学习率 2e-5）
3. Experiment C（100 iterations，学习率 1e-5）

其中最重要的验收不是 loss 是否继续下降，而是：绝对化纠偏能否保留、追问能力是否真正改善、简单知识问题能否直接回答，以及 Experiment B 的两项事实错误是否消失。

**当前裁定：阶段七-F-4 通过；实验 C 可以继续推进，但先完成 G-0，不要立即启动训练。**
