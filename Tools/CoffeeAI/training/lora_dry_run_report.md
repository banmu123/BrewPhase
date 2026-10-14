# LoRA Dry-Run Report（阶段七-D3/D4，2026-10-14）

> GPT 阶段七-D 指示执行记录。目标：验证数据管线可运行、LoRA 流程可闭环——
> **不是收敛、不是模型效果**。

## 环境

| 项 | 值 |
|---|---|
| Mac | macOS 15.7.3，Apple M2，16 GB RAM |
| mlx / mlx-metal / mlx-lm | 0.32.3 / 0.32.3 / 0.32.0 |
| 执行方式 | run_train.py（训练准入复查通过）→ mlx_lm.lora --config effective_config.yaml |

## 数据

- train=20 / valid=3 / test=2（LoRA chat 格式，含 system，metadata 不进 prompt）
- 训练准入复查：**通过**（25 条审核指纹一致、例外覆盖 noncommercial-research）

## 参数

| 项 | 值 |
|---|---|
| model | mlx-community/Qwen2.5-3B-Instruct-4bit（本地缓存，未重复下载） |
| fine_tune_type | lora |
| rank / layers | 8 / 8（num_layers） |
| batch / iters | 1 / **20**（GPT 阶段七-D3 裁定从 50 下调） |
| learning_rate | 1e-5 |
| max_seq_length | 2048 |
| Trainable params | **0.013%**（0.410M / 3,085.939M） |

## 过程

| 项 | 值 |
|---|---|
| start / end | 2026-10-15 01:13:45 → 01:14:57（**约 72 秒**） |
| train_loss | iter1 4.219 → iter20 3.803（波动下行：4.219/5.689/4.127/…/3.803） |
| val_loss | iter1 5.262 → iter20 4.185（下降 ✅） |
| tok/s | ~220 |
| OOM | 无 |
| 中断 | 无 |

## 结果

- **LoRA executed ✅**：20/20 iters 完成，adapter 输出至 `runs/lora_dryrun_adapter`
- loss 正常区间（未收敛——20 iters 本来就不追求收敛）
- 行为评测见 `post_lora_behavior_eval.md`（诚实结论：本轮未产生可观察行为变化）

## 过程中修复的链路 bug（dry-run「验证链路」的直接价值）

1. **run_train.py YAML 解析器不支持 flow 数组**：`lora_parameters.keys` 被读成字符串 →
   effective_config 中 keys 为字符串 → mlx-lm 子串匹配把 TransformerBlock 当转换目标 →
   `ValueError: Can't convert layer of type TransformerBlock to LoRA`。已修（flow 数组按
   JSON 解析）——该存量 bug 在此前的 smoke dry-run（不真跑）中从未暴露。
2. **lora 数据目录缺审计 meta**：run_train.py 准入复查要求划分产物携带
   `*.meta.jsonl`；prepare_lora_dataset.py 已补齐（含审核指纹等完整审计字段）。
3. **训练文本指纹一致性**：初版转换脚本删除了 system 消息 → 与审核指纹不一致
   （治理红线「不允许自动重算放行」）——已改为保留完整 messages（含 system，
   system prompt 本身是 BrewPhase 行为对齐核心）。

## 阶段七-D 禁令遵守

- 未 fuse adapter、未部署测试、未增加 Batch2d、未换 7B、未调 rank/lr、未进行长训练
