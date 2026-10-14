# Environment Report（阶段七-B，2026-10-14 23:59）

> 依据：GPT 阶段七-B 执行指令（存档 `review_queue/gpt_replies/gpt_reply_stage7a_approved_7b_prompt.md`）。
> 目标：只建立训练环境，**不训练**；不下载基座模型、不改训练配置、不启动 LoRA。

## 系统

| 项 | 值 |
|---|---|
| OS | macOS 15.7.3（Build 24G419） |
| Architecture | arm64（Apple Silicon） |
| Python | 3.13.12（managed：`~/.workbuddy/binaries/python/versions/3.13.12`） |

## 硬件

| 项 | 值 |
|---|---|
| CPU | Apple M2 |
| Memory | 16 GB |
| GPU/MPS | Apple M2 GPU（Metal 原生，mlx-metal 0.32.3 后端已随 mlx-lm 安装） |
| Disk available | 155 Gi（基座模型 4bit 约 2.4–2.6 GB，充足） |

## Python 环境

- `python3 --version`：Python 3.13.12
- venv：`~/.workbuddy/binaries/python/envs/default`（隔离环境，未污染系统 Python）
- `pip --version`：pip 26.2.1（venv 内）

## mlx-lm 安装记录（B-2）

- 命令：`pip install mlx-lm`（venv 内执行；网络较慢，耗时约 49 分钟完成）
- `pip show mlx-lm`：
  - **Version: 0.32.0**
  - License: MIT
  - Location: `~/.workbuddy/binaries/python/envs/default/lib/python3.13/site-packages`
- 关键依赖（`pip show` / 安装清单）：
  - mlx 0.32.3、mlx-metal 0.32.3（Metal 后端）、mlx-lm 0.32.0
  - transformers 5.19.0、huggingface-hub 2.2.0、tokenizers 0.23.3、safetensors 0.8.0
  - numpy 2.5.3、sentencepiece 0.2.2、protobuf 7.36.2、typer 0.27.3、rich 15.0.0 等

## CLI 验证（B-3）

- `mlx_lm --help`：正常输出，支持子命令：
  `benchmark / cache_prompt / chat / convert / evaluate / fuse / generate / lora / manage / perplexity / awq / dwq / dynamic_quant / gptq / server / upload / share`
- `mlx_lm lora --help`：正常输出 usage（`--model / --train / --data / --fine-tune-type {lora,dora,full} / --optimizer …`）——**仅查看 help，未执行**
- **未执行**：`mlx_lm.lora`（训练）、`mlx_lm.generate`（生成）——遵守 GPT 禁令
