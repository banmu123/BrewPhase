# Training Data Audit（阶段七-A v1，2026-10-14；v2/v3 增量更新 2026-10-15）

> 依据：GPT 阶段七-A 指示（回复存档 `review_queue/gpt_replies/gpt_reply_69h_approved_stage7a_prompt.md`）；
> v2 更新依据：GPT 阶段七-F-4 冻结顺序（gpt_replies/gpt_reply_stage7f3_approved_7f4.md）——
> Batch2d 批准落库后更新本审计。
> v3 更新依据：GPT 阶段七-G 终裁（gpt_replies/gpt_reply_stage7g_experimentC_failed_freeze.md）
> ——Batch2e 批准落库后更新本审计。

## 0.4 v3 增量（2026-10-15，Batch2e 落库后——clarification 批次）

- **依据**：GPT 阶段七-G 终裁（Experiment C 不通过、追问能力走数据侧）——Batch2e
  8 条候选经 plan v1→v3 + draft v1→v6 六轮 GPT 复核收敛后，负责人拍板 8 条全部批准。
- **落库**：build_batch2e_approval.py → batch2e-approved-r1（manifest + 双哈希
  messages_fingerprint / reviewed_record_sha256，reviewed_at=2026-10-15）。
- **新数据版本**：`data/splits-v3-batch2e/`（43 条 → **train 35 / valid 4 / test 4**，
  seed=42，仅收 approved；历史 `data/splits/` 28/4/3 保留不覆盖）→ LoRA 转换
  `training/data/lora-v3-batch2e/`（43 条，skill 全就位）。
- **能力矩阵（43 条）**：clarification **2→6**（本轮主目标）、knowledge_explanation
  2→5、condition_based_advice 3→4、boundary_setting 4、uncertainty_handling 8、
  multi_variable_reasoning 2、（b1/b2a 早期无标记 14）。追问能力为实验 C 未学出的
  最大缺口，本批为数据侧验证准备。
- **来源准入**：admission 8 BLOCK→allowed_sample_ids 并入后 8/8 PASS；6 来源 / 9 次
  引用零新增授权；新 topic cleaning-maintenance 首次覆盖（gaggia 来源激活 2 claim）。
- **治理**：check_approval_ready READY（8, 0/0）；P0 准入复查（splits-v3）全部通过；
  leakage=0（train 35/valid 4/test 4）；143 tests OK；build_kb --check OK。
- **训练边界**：GPT 终裁——即使 43 条也不自动批准新一轮 3B 训练，待本审计与评测
  目标就绪后单独裁定。

## 0. v2 增量（2026-10-15，Batch2d 落库后）

- Batch2d（b2d-001~010，稳定性补强批次）批准落库：**approved 25 → 35**。
- split 重建（seed=42）：**train 28 / valid 4 / test 3**（GPT 预期「approved 25→35、
  train 20→约28」达成）。
- 泄漏检查重跑：**leakage=0**（train=28 / valid=4 / test=3）。
- 新增能力枚举 `knowledge_explanation`（GPT 批准保留：防止「过度产品经理化」——
  简单知识问题直接解释，复杂问题才澄清）。
- lora 训练数据重生成：35 条 chat 格式（含 system 消息，审核指纹一致），b2d 的
  interaction_skill 全部就位。
- 训练保持冻结直到本审计更新完成（GPT 冻结顺序）；下一步实验 C 配置已由 GPT 预先
  冻结：iters=100 / lr=1e-5 / rank=8 / layers=8 / batch=1（不直接 300 iter；
  7B 暂缓至 approved ≥100）。

## 1. 数据统计（v2）

| 项 | 值 |
|---|---|
| approved_total | **35**（batch1 5 + batch2a 9 + batch2b 8 + batch2c 3 + batch2d 10） |
| train | **28** |
| valid | **4** |
| test | **3** |
| 排除（未审核/许可不明） | 25（batch1 未批准候选，永不入训练集） |
| 划分方式 | split_dataset.py，seed=42，按 group_id 整组划分 + 近似并组，无跨集合泄漏 |
| 语料指纹 | 见 `data/splits/split_report.json`（逐字节可复现） |

## 2. 行为能力覆盖矩阵（35 条类型分布）

| 能力类别 | 样本 | 数量 | 占比 |
|---|---|---|---|
| 知识事实类（单症状→来源映射/术语） | b1-012/013/014/015/016 | 5 | 14% |
| F/P/I 推理诊断类（dial-in/手冲诊断/新鲜度） | b2a-001/002/003/004/005/006/008/009/010 | 9 | 26% |
| clarification 类（主动追问） | b2b-001、b2c-001、b2d-008 | 3 | 9% |
| multi_variable_reasoning 类（参数矛盾/变化诊断/期望管理） | b2b-002、b2b-005、b2c-002 | 3 | 9% |
| boundary_setting 类（拒绝伪标准/时间读数/健康边界） | b2b-003、b2b-006、b2b-007、b2d-001 | 4 | 11% |
| uncertainty_handling 类（不知道能力/价格边界/错误前提/食品安全/研究方向边界） | b2b-008、b2c-003、b2d-002/003/004/005 | 6 | 17% |
| condition_based_advice 类（条件化对齐） | b2b-004、b2d-009、b2d-010 | 3 | 9% |
| knowledge_explanation 类（直接解释知识问题，v2 新增枚举） | b2d-006、b2d-007 | 2 | 6% |
| **合计** | | **35** | 100% |

交互/边界/不确定性/条件化/直接解释类合计 **21 条（60%）**，知识事实类降至 14%
（v1 为 20%）——行为数据占比进一步提升，符合 GPT「稳定性补强批次」定位
（Batch2d 不增加咖啡答案，修复 LoRA 实验暴露的行为副作用）。

Batch2d 新增行为类别（GPT 七-F-3 核验确认）：

| 新行为 | 样本 | fact_stability_risk | experiment_target |
|---|---|---|---|
| 错误前提检查（温和纠正，保留「不能仅凭当前信息判断」） | b2d-003 | medium | Reduce hallucination after stronger LoRA alignment |
| 食品安全不判断（变质判断不猜，给客观检查方法） | b2d-004 | medium | Reduce factual hallucination |
| 研究方向边界（不能证明 X ≠ X 不存在） | b2d-005 | **high** | Maintain factual humility without refusal |
| 该直接回答时直接回答 | b2d-006/007 | low | Prevent over-questioning behavior |
| 模糊问题先澄清再条件化建议 | b2d-008/009/010 | low | Improve clarification before advice |

GPT 要求的行为能力覆盖矩阵核对（v2 追加）：

| 能力 | 样本（批次） | 状态 |
|---|---|---|
| 直接知识回答 | batch1 + b2d-006/007（knowledge_explanation） | ✅ |
| 参数边界控制 | b2a/b2b | ✅ |
| 主动追问 | b2b/b2c/b2d-008 | ✅ |
| 不确定性表达 | b2b-008、b2c-003、b2d-002/003/004/005 | ✅ |
| 健康边界 | b2b-007、b2d-001/002/005 | ✅ |
| 多变量诊断 | b2c-001/002 | ✅ |
| 错误前提检查 | b2d-003 | ✅（v2 新增） |
| 过度追问防护 | b2d-006/007 | ✅（v2 新增） |

## 3. 泄漏检查（check_training_leakage.py）

- 脚本：`Tools/CoffeeAI/training/check_training_leakage.py`（只读）
- 检查维度（GPT 指定）：① 相同 user prompt；② 相同 answer fingerprint（assistant
  消息 sha256）；③ 同 claim_ids 组合 + 同 interaction_skill 完全重复——均按
  train/valid/test 两两交叉检查
- **v1 运行结果：leakage=0**（train=20 / valid=3 / test=2）
- **v2 重跑结果：leakage=0**（train=28 / valid=4 / test=3；Batch2d 加入后三类检查
  均未跨集合出现）

## 4. 前置校验链（落库时已通过，此处汇总）

| 检查 | 结果 |
|---|---|
| check_candidate_quality（b2b 8 + b2c 3 + b2d 10） | PASSED（0 error / 0 warning；b2d 含 knowledge-explanation gate） |
| check_approval_ready（batch2b/2c/2d-approved-r1） | READY（0 error；b2d 为 10/10） |
| validate --for-training（batch2b / batch2c / batch2d） | 0 error（noncommercial-research） |
| source_exceptions.json | 9 条例外，六点九-E/H 与七-F-4 仅扩展 allowed_sample_ids 与 topics 对齐，claim/授权范围未变 |
| 130 tests OK / build_kb --check OK | 通过（v2 落库后回归见提交记录） |

## 5. 阶段七后续（GPT 顺序）

- ~~阶段七-B 环境准备~~ ✅（mlx-lm 0.32.0，隔离 venv）
- ~~阶段七-C 基座选择~~ ✅（Qwen2.5-3B-Instruct-4bit）
- ~~阶段七-D LoRA dry-run~~ ✅（iters=20，behavior_score 5/10，Δ0）
- ~~阶段七-E 训练强度敏感性实验~~ ✅（实验 B：iters=200，behavior_score 6/10，
  绝对化控制增强 + 幻觉劣化信号——25 条规模不足以稳定认知边界）
- ~~阶段七-F Batch2d 稳定性补强~~ ✅（plan → 草稿 10 条 → 增强审核包 → 落库 35 条）
- **阶段七-G 实验 C（下一步）**：GPT 预先冻结配置（iters=100 / lr=1e-5 / rank=8 /
  layers=8 / batch=1；不直接 300 iter；7B 暂缓至 approved ≥100）。实验目标不是最低
  loss，而是找到「行为改善但事实稳定」的训练窗口。评测重点：① 绝对化控制是否保持；
  ② 主动追问是否提升；③ 不知道能力是否保持；④ knowledge_explanation 是否避免过问；
  ⑤ 实验 B 的两个事实错误（q8「豆子本身没有香味」、nat_q4 帕金森反例）是否消失。
  新增评测集：`evaluation/natural_behavior_eval.md`（自然度 10 题）+ 治理 10 题。
