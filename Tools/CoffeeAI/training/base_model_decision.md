# Base Model Decision（阶段七-C，2026-10-14）

> 依据：GPT 阶段七-C 指示（存档 `review_queue/gpt_replies/gpt_reply_stage7b_approved_7c_prompt.md`）。

## 决定

**base_model = Qwen2.5-3B-Instruct**（mlx-community 4bit 量化版：
`mlx-community/Qwen2.5-3B-Instruct-4bit`）

## 理由（GPT 方案 A）

1. **实验目标匹配**：第一次 dry-run 不是提升知识量，而是观察行为变化——是否主动
   追问、是否减少绝对化回答、是否保持不确定性、是否遵守 F/P/I。3B 足够观察行为变化。
2. **硬件适配**：M2 / 16 GB RAM 可运行；下载体积小；LoRA 训练压力低；迭代速度快。
3. **方案 B（Qwen2.5-7B-Instruct）暂缓**：16GB 下加载压力更高、batch 调整空间小、
   实验周期长——适合第一次实验验证有效后再用。

## 量化说明

- 选 mlx-community 4bit 量化版：与现有 smoke.yaml（Qwen3-4B-4bit）同生态，
  16GB 内存下加载与 LoRA 训练余量更足；HF 上由 mlx-community 官方转换，可信来源。
- 模型文件**阶段七-D 才下载**（本阶段 selected but not downloaded）。

## 风险与边界

- 第一次实验目标不是得到可用模型，而是验证「F/P/I + interaction 数据结构是否真的
  能改变模型行为」（GPT 原话）。
- 若 3B 行为变化不可观察，再评估 7B / 更多数据，而不是先加大 iters。
