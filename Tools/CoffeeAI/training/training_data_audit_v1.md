# Training Data Audit v1（阶段七-A，2026-10-14）

> 依据：GPT 阶段七-A 指示（回复存档 `review_queue/gpt_replies/gpt_reply_69h_approved_stage7a_prompt.md`）。
> 目标：第一次 LoRA dry-run 前的数据审计最终版。**本阶段不安装 mlx-lm、不下载模型、
> 不修改 approved 数据。**

## 1. 数据统计

| 项 | 值 |
|---|---|
| approved_total | **25** |
| train | **20** |
| valid | **3** |
| test | **2** |
| 排除（未审核/许可不明） | 25（batch1 未批准候选，永不入训练集） |
| 划分方式 | split_dataset.py，seed=42，按 group_id 整组划分 + 近似并组，无跨集合泄漏 |
| 语料指纹 | 见 `data/splits/split_report.json`（逐字节可复现） |

## 2. 行为能力覆盖矩阵（25 条类型分布）

| 能力类别 | 样本 | 数量 | 占比 |
|---|---|---|---|
| 知识事实类（单症状→来源映射/术语） | b1-012/013/014/015/016 | 5 | 20% |
| F/P/I 推理诊断类（dial-in/手冲诊断/新鲜度） | b2a-001/002/003/004/005/006/008/009/010 | 9 | 36% |
| clarification 类（主动追问） | b2b-001、b2c-001 | 2 | 8% |
| multi_variable_reasoning 类（参数矛盾/变化诊断/期望管理） | b2b-002、b2b-005、b2c-002 | 3 | 12% |
| boundary_setting 类（拒绝伪标准/时间读数/健康边界） | b2b-003、b2b-006、b2b-007 | 3 | 12% |
| uncertainty_handling 类（不知道能力/价格边界） | b2b-008、b2c-003 | 2 | 8% |
| condition_based_advice 类（条件化对齐） | b2b-004 | 1 | 4% |
| **合计** | | **25** | 100% |

GPT 要求的行为能力覆盖矩阵核对：

| 能力 | 样本（批次） | 状态 |
|---|---|---|
| 直接知识回答 | batch1 | ✅ |
| 参数边界控制 | b2a/b2b | ✅ |
| 主动追问 | b2b/b2c | ✅ |
| 不确定性表达 | b2b-008、b2c-003 | ✅ |
| 健康边界 | b2b-007 | ✅ |
| 多变量诊断 | b2c-001/002 | ✅ |

**结论**：不是「25 条重复知识」——知识事实类仅占 20%，交互/边界/不确定性类合计 40%
（clarification + multi_variable + boundary + uncertainty + condition），符合
「从咖啡知识问答数据转向咖啡领域 Agent 行为数据」的阶段目标。

## 3. 泄漏检查（check_training_leakage.py）

- 脚本：`Tools/CoffeeAI/training/check_training_leakage.py`（只读）
- 检查维度（GPT 指定）：① 相同 user prompt；② 相同 answer fingerprint（assistant
  消息 sha256）；③ 同 claim_ids 组合 + 同 interaction_skill 完全重复——均按
  train/valid/test 两两交叉检查
- **运行结果：leakage=0**（train=20 / valid=3 / test=2；三类检查均未跨集合出现）

## 4. 前置校验链（落库时已通过，此处汇总）

| 检查 | 结果 |
|---|---|
| check_candidate_quality（b2b 8 + b2c 3） | PASSED（0 error / 0 warning） |
| check_approval_ready（batch2b-approved-r1 / batch2c-approved-r1） | READY（0 error） |
| validate --for-training（batch2b / batch2c） | 0 error（noncommercial-research） |
| source_exceptions.json | 9 条例外，六点九-E/H 仅扩展 allowed_sample_ids 与 topics 对齐，claim/授权范围未变 |
| 130 tests OK / build_kb --check OK | 通过 |

## 5. 阶段七后续（GPT 顺序，本审计完成后）

- **阶段七-B 环境准备**：environment_report.md（macOS/Python/Metal/RAM/磁盘）→
  `pip install mlx-lm` → `mlx_lm --help` 确认（**仍不训练**）
- **阶段七-C 基座选择**：小模型优先（验证数据格式与 LoRA pipeline）
- **阶段七-D LoRA dry-run**：验收标准 = pipeline 可运行 / 数据格式无问题 / loss
  正常下降 / 无明显过拟合 / behavior sample 有变化（不是模型效果；失败也有价值）
- 最终决定是否正式训练
