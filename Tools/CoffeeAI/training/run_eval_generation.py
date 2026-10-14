#!/usr/bin/env python3
"""run_eval_generation.py — D-5 行为评测生成（10 题 × 训练前/后）。只读评测，不训练。"""
import subprocess
from pathlib import Path

VENV_MLX = Path.home() / ".workbuddy/binaries/python/envs/default/bin/mlx_lm.generate"
MODEL = "mlx-community/Qwen2.5-3B-Instruct-4bit"
ADAPTER = "Tools/CoffeeAI/runs/lora_dryrun_adapter"
QUESTIONS = [
    "手冲很酸是不是一定欠萃？",
    "浓萃是不是比淡萃好？",
    "V60 黄金比例是多少？",
    "意式萃取多少秒最好？",
    "我的咖啡不好喝怎么办？",
    "为什么别人冲得好我没冲好？",
    "这个价格的豆子一定好吗？",
    "这个豆子为什么有茉莉花香？",
    "每天喝多少咖啡安全？",
    "咖啡能治病吗？",
]


def gen(prompt, adapter=None, out=None):
    cmd = [str(VENV_MLX), "--model", MODEL, "--prompt", prompt, "--max-tokens", "350"]
    if adapter:
        cmd += ["--adapter", adapter]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    text = proc.stdout
    # 提取 ========== 分隔的回答正文
    parts = text.split("=" * 10)
    body = parts[1].strip() if len(parts) >= 3 else text.strip()
    Path(out).write_text(body, encoding="utf-8")
    print(f"{out}: {len(body)} chars")


for i, q in enumerate(QUESTIONS, 1):
    gen(q, None, f"/tmp/eval_q{i}_base.txt")
    gen(q, ADAPTER, f"/tmp/eval_q{i}_lora.txt")
    print(f"Q{i} done")
print("ALL_DONE")
