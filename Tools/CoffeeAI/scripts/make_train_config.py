#!/usr/bin/env python3
"""make_train_config.py — 生成 MLX-LM 训练 YAML 配置（含 dry-run 预览）。

字段名严格对照 mlx-lm 官方示例 examples/lora_config.yaml（main 分支，2026-10 核对）：
  model / train / fine_tune_type / optimizer / data / seed / num_layers /
  batch_size / iters / val_batches / learning_rate / steps_per_report /
  steps_per_eval / grad_accumulation_steps / adapter_path / save_every /
  test / test_batches / max_seq_length / grad_checkpoint / lora_parameters

不引入本文件自造的字段。量化模型（如 *-4bit）官方按 QLoRA 训练，无需额外开关
（见官方 LORA.md: "If --model points to a quantized model, then the training
will use QLoRA, otherwise it will use regular LoRA"）。

用法:
  python3 Tools/CoffeeAI/scripts/make_train_config.py                 # 生成默认配置
  python3 Tools/CoffeeAI/scripts/make_train_config.py --dry-run       # 只打印不写盘
  python3 Tools/CoffeeAI/scripts/make_train_config.py --profile smoke # 烟测配置
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

COFFEEAI = Path(__file__).resolve().parents[1]
REPO_ROOT = COFFEEAI.parent.parent

PROFILES = {
    # 16GB Apple Silicon + Qwen3-4B 4bit QLoRA 的保守起点：
    # batch=1、只调 8 层、grad_checkpoint 开、短序列，先验证管线再放开。
    "m2-16gb-conservative": {
        "model": "mlx-community/Qwen3-4B-Instruct-2507-4bit",
        "train": True,
        "fine_tune_type": "lora",
        "seed": 42,
        "num_layers": 8,
        "batch_size": 1,
        "iters": 300,
        "val_batches": 25,
        "learning_rate": 1.0e-4,
        "steps_per_report": 10,
        "steps_per_eval": 100,
        "grad_accumulation_steps": 4,
        "adapter_path": "Tools/CoffeeAI/runs/adapters",
        "save_every": 100,
        "test": False,
        "test_batches": 100,
        "max_seq_length": 1024,
        "grad_checkpoint": True,
        "lora_parameters": {
            "keys": ["self_attn.q_proj", "self_attn.v_proj"],
            "rank": 8,
            "scale": 20.0,
            "dropout": 0.0,
        },
    },
    # 烟测：只验证「数据→训练循环→适配器保存」整条管线能跑通，不代表质量。
    "smoke": {
        "model": "mlx-community/Qwen3-4B-Instruct-2507-4bit",
        "train": True,
        "fine_tune_type": "lora",
        "seed": 0,
        "num_layers": 2,
        "batch_size": 1,
        "iters": 2,
        "val_batches": 1,
        "learning_rate": 1.0e-4,
        "steps_per_report": 1,
        "steps_per_eval": 100,
        "grad_accumulation_steps": 1,
        "adapter_path": "Tools/CoffeeAI/runs/smoke_adapter",
        "save_every": 1000,
        "test": False,
        "test_batches": 100,
        "max_seq_length": 512,
        "grad_checkpoint": True,
        "lora_parameters": {
            "keys": ["self_attn.q_proj", "self_attn.v_proj"],
            "rank": 4,
            "scale": 10.0,
            "dropout": 0.0,
        },
    },
}

# 官方示例 YAML 中出现过的全部字段（用于自检：不允许生成未知字段）
OFFICIAL_FIELDS = {
    "model", "train", "fine_tune_type", "optimizer", "optimizer_config",
    "data", "seed", "num_layers", "batch_size", "iters", "val_batches",
    "learning_rate", "report_to", "project_name", "steps_per_report",
    "steps_per_eval", "grad_accumulation_steps", "resume_adapter_file",
    "adapter_path", "save_every", "test", "test_batches", "max_seq_length",
    "grad_checkpoint", "lora_parameters", "lr_schedule", "hf_dataset",
    "prompt_feature", "completion_feature", "text_feature", "chat_feature",
}


def yaml_value(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if v is None:
        return "null"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list):
        return "[" + ", ".join(yaml_value(x) for x in v) + "]"
    raise TypeError(f"unsupported: {type(v)}")


def dump_yaml(cfg):
    lines = []
    for k, v in cfg.items():
        if isinstance(v, dict):
            lines.append(f"{k}:")
            for k2, v2 in v.items():
                lines.append(f"  {k2}: {yaml_value(v2)}")
        else:
            lines.append(f"{k}: {yaml_value(v)}")
    return "\n".join(lines) + "\n"


def build_config(args):
    cfg = dict(PROFILES[args.profile])
    cfg["data"] = args.data_dir
    for field in ("model", "iters", "batch_size", "num_layers", "learning_rate",
                  "max_seq_length", "adapter_path", "seed"):
        v = getattr(args, field, None)
        if v is not None:
            cfg[field] = v
    return cfg


def main(argv=None):
    p = argparse.ArgumentParser(description="生成 MLX-LM 训练配置")
    p.add_argument("--profile", choices=sorted(PROFILES), default="m2-16gb-conservative")
    p.add_argument("--out", default=None,
                   help="输出 YAML 路径（默认 configs/generated_<profile>.yaml）")
    p.add_argument("--data-dir", default="Tools/CoffeeAI/data/splits",
                   help="含 train/valid/test.jsonl 的目录")
    p.add_argument("--model", default=None)
    p.add_argument("--iters", type=int, default=None)
    p.add_argument("--batch-size", dest="batch_size", type=int, default=None)
    p.add_argument("--num-layers", dest="num_layers", type=int, default=None)
    p.add_argument("--learning-rate", dest="learning_rate", type=float, default=None)
    p.add_argument("--max-seq-length", dest="max_seq_length", type=int, default=None)
    p.add_argument("--adapter-path", dest="adapter_path", default=None)
    p.add_argument("--seed", type=int, default=None)
    p.add_argument("--dry-run", action="store_true", help="只打印配置与等价命令，不写盘")
    args = p.parse_args(argv)

    cfg = build_config(args)
    unknown = set(cfg) - OFFICIAL_FIELDS
    if unknown:
        print(f"[CoffeeAI] 内部错误: 生成了官方 schema 之外的字段 {sorted(unknown)}", file=sys.stderr)
        sys.exit(1)

    text = dump_yaml(cfg)
    data_dir = cfg["data"]
    cmd = ("mlx_lm.lora --config <config.yaml>"
           f"   # 等价 CLI: mlx_lm.lora --model {cfg['model']} --train --data {data_dir}"
           f" --iters {cfg['iters']} --batch-size {cfg['batch_size']}"
           f" --num-layers {cfg['num_layers']} --learning-rate {cfg['learning_rate']}"
           f" --max-seq-length {cfg['max_seq_length']}"
           + (" --grad-checkpoint" if cfg["grad_checkpoint"] else "")
           + f" --adapter-path {cfg['adapter_path']}")

    if args.dry_run:
        print(text)
        print("# " + cmd)
        sys.exit(0)

    out = Path(args.out) if args.out else COFFEEAI / "configs" / f"generated_{args.profile}.yaml"
    if not out.is_absolute():
        out = REPO_ROOT / out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    print(f"[CoffeeAI] 配置已写入: {out}")
    print(f"[CoffeeAI] {cmd}")
    sys.exit(0)


if __name__ == "__main__":
    main()
