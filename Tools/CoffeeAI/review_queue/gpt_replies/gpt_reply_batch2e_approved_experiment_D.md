# GPT 对 Batch2e 落库的核验回复 → 批准 Experiment D（2026-10-15 22:50 前后提取）

> 提取方式：main 对话区 lastIndexOf 锚点「以上，等待你的核验与下一步指示。」
> 对应我方报告：/tmp/gpt_stage7g2e_approval_done.txt（提交 aaeba79）
> 注：页面末尾「消息传输超时。请重试。」为 UI chrome，回复主体完整。

---

核验结论：Batch2e 已完成落库，新数据版本具备实验准备条件。我批准开展一轮受控的 3B 实验，但必须先归档新基线，再启动训练。

本次只批准验证新增数据的效果，不恢复 A/B/C 参数搜索线，也不批准融合或部署。

## 一、落库与数据版本核验通过

我已确认远程 main 最新提交为 aaeba79，并读取了批准语料、元数据、manifest、来源例外、新旧数据目录、LoRA 转换产物和评测方案。

| 检查项 | 结果 |
|---|---|
| 负责人批准与落库（b2e-001 至 b2e-008） | 通过 |
| 新数据版本（43 条 approved，25 条未审核样本排除） | 通过 |
| Train 35 / Valid 4 / Test 4，seed=42；43 个样本 ID 均唯一；未发现跨集合分组 | 通过 |

我独立重算了 8 条新批准样本的 reviewed_content_sha256、dedup_fingerprint 和 reviewed_record_sha256，全部与存储值一致；同样检查了新 split 的 43 条，内容和审核记录指纹全部匹配。

具体核验结果：
- 批准记录：8 条均为 approved，reviewed_by 与 reviewed_at=2026-10-15 已写入；新 manifest batch2e-approved-r1 中的批准 ID 与负责人批准范围一致。
- 来源授权：6 个来源只增加了对应的 allowed_sample_ids；allowed_topics、allowed_claim_ids 等授权范围字段没有变化。仓库的 _b2e_source_admission_result.json 记录了 8/8 PASS。
- 新 split 与 LoRA 数据：43 条数据和 43 条元数据一一对应，LoRA 转换后的 messages 与 split 输入一致，system 消息全部与冻结评测脚本所用的 system prompt 完全一致。
- 泄漏检查：我根据实际 LoRA 输出重新检查了跨集合相同 user prompt、相同 assistant 答案，以及可用 skill 标签下相同 claim 组合与 skill 的重复，结果均为 0。14 条早期历史数据没有 skill 标签，因此第三个维度无法覆盖它们；这是已披露的历史元数据缺口，不是本批新增样本的问题。
- 回归：仓库报告为 143 tests OK、build_kb --check OK。我没有在你的本地环境独立执行这些测试。

核验边界（如实说明）：当前 GitHub 树中没有 Tools/CoffeeAI/data/splits/ 历史目录，因此无法从远程文件直接验证该目录在本地是否原样保留。不过，此次提交没有改动旧的 training/data/lora/ 训练数据文件，也没有改动 Experiment C 配置；新产物使用独立的 splits-v3-batch2e/ 和 lora-v3-batch2e/ 路径。

## 二、实验裁定：批准一次受控的 Experiment D

目标：验证在原有训练数据上追加 Batch2e 后，3B 模型能否更好地处理信息不足的问题，同时避免变成「万事追问」。

本次批准只允许一轮实验。训练参数沿用已经冻结的 Experiment C，不做强度搜索：

| 项 | 冻结值 |
|---|---|
| 基座模型 | Qwen2.5-3B-Instruct-4bit |
| 训练数据 | training/data/lora-v3-batch2e/ |
| 迭代次数 | 100 |
| 学习率 | 1e-5 |
| LoRA 层数 / rank | 8 / 8 |
| Batch size | 1 |
| Seed | 0 |
| 其他 LoRA 参数 | 与 Experiment C 相同 |

新配置应命名为 **lora_experiment_D_batch2e_config.yaml**，适配器输出使用独立路径 **Tools/CoffeeAI/runs/lora_experiment_D_batch2e_adapter**。不得覆盖 Experiment C 的配置、适配器、评测输出或历史报告。

## 三、训练之前必须完成的步骤

1. **先归档新基线。** 使用未微调基座生成冻结评测集的全部 20 个回答，存入独立目录，例如 /tmp/experiment_D_batch2e_baseline/，并保存回答文件、SHA256SUMS、模型标识、仓库 commit、评测脚本版本及推理参数。必须使用 system + 显式 ChatML + greedy（temp=0）+ max_tokens=350，并先确认 tokenizer 模板交叉校验通过。
2. **隔离评测输出。** 当前 run_eval_generation_c.py 将适配器路径固定为 C，并写入 /tmp/evalC_* 文件。开始 D 实验前，应增加向后兼容的 --adapter-path、输出目录或前缀参数，或者建立 D 专用评测入口；原来的默认行为必须保持不变。这样才能确保 D 的基座与训练后回答可直接比较，又不会覆盖 C 的历史产物。
3. **运行训练前门禁。** 对 D 配置执行 run_train.py --dry-run，明确指定 noncommercial-research，并再次核验 LoRA 数据集的准入、元数据与 split。若基线生成、模板检查或准入任一失败，停止，不启动训练。
4. **只训练一次。** 以上门禁通过后，才可使用独立 D 配置正式训练。不得追加迭代次数、改变学习率、试第二组参数，或把新适配器融合进产品。

## 四、训练后的验收标准先冻结

必须在生成 adapterD 结果前锁定评分口径，不能看完结果后再修改门线。

| 验收项 | 通过要求 |
|---|---|
| 主目标：治理题 Q5 / Q6 | 两题都要表现出有效的信息澄清：先抓关键缺失信息，而不是直接猜原因，也不是一次提出冗长问卷 |
| 总体行为分 | 达到冻结门线 ≥ 7/10 |
| 自然度 | 相对 D 的同策略基座下降不超过 1 分 |
| 历史事实错误 | 不重现 Experiment B 的两项历史错误 |
| 新增重大事实错误 | 不出现新的重大事实回归，尤其复核 Experiment C 的豆油机理与黑咖啡糖脂表述问题 |
| 防过度追问 | 信息足够的 N3、N6、N7、N8、N9、N10 应直接回答；N1、N5 也应保持有帮助的直接回应 |

范围解释：新增的 4 条 clarification 样本都被分入 train；valid/test 没有留出新的 Batch2e clarification 样本。因此，训练后的 Q5/Q6 冻结行为评测是验证泛化的主要依据，不能只看 valid loss 或 test loss。评测只有少数主目标题，所以这一轮属于诊断性试验，不足以单独证明追问能力已经普遍学会。

Batch2e 同时包含 clarification 与直接回答样本，因此即使结果改善，也应表述为「这组新增数据带来的行为变化」，不能把效果单独归因于 clarification 样本。

**最终指示：数据准备与落库核验通过；批准在基线归档、配置隔离和训练前门禁完成后执行一次 Experiment D。训练完成后再按上述冻结标准裁定是否通过；无论结果如何，均不自动批准第二轮训练、参数搜索、融合或部署。**
