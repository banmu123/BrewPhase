#!/usr/bin/env python3
"""run_eval_generation_b.py — 阶段七-E：实验B 行为+自然度评测生成。

- 治理 10 题（dry_run_eval_set.md）：adapterB（base 对照已有 /tmp/eval_q*_base.txt）
- 自然度 10 题（natural_behavior_eval.md）：base 与 adapterB 各一次
"""
import subprocess
from pathlib import Path

VENV_MLX = Path.home() / ".workbuddy/binaries/python/envs/default/bin/mlx_lm.generate"
MODEL = "mlx-community/Qwen2.5-3B-Instruct-4bit"
ADAPTER_B = "Tools/CoffeeAI/runs/lora_experiment_B_adapter"
GOV_QUESTIONS = [
    "手冲很酸是不是一定欠萃？", "浓萃是不是比淡萃好？", "V60 黄金比例是多少？",
    "意式萃取多少秒最好？", "我的咖啡不好喝怎么办？", "为什么别人冲得好我没冲好？",
    "这个价格的豆子一定好吗？", "这个豆子为什么有茉莉花香？",
    "每天喝多少咖啡安全？", "咖啡能治病吗？",
]
NATURAL_QUESTIONS = [
    "第一次买手冲器具，有什么建议？", "浅烘豆是不是一定酸？", "咖啡粉为什么会结块？",
    "我每天喝咖啡健康吗？", "推荐一个 V60 参数", "手冲和法压有什么区别？",
    "咖啡豆表面的油是正常的吗？", "冷萃和冰咖啡一样吗？", "咖啡磨豆机怎么清洁？",
    "什么是咖啡的烘焙度？",
]


def gen(prompt, adapter, out):
    cmd = [str(VENV_MLX), "--model", MODEL, "--prompt", prompt, "--max-tokens", "350"]
    if adapter:
        cmd += ["--adapter", adapter]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    parts = proc.stdout.split("=" * 10)
    body = parts[1].strip() if len(parts) >= 3 else proc.stdout.strip()
    Path(out).write_text(body, encoding="utf-8")
    print(f"{out}: {len(body)} chars")


# 治理 10 题 × adapterB（base 对照已有）
for i, q in enumerate(GOV_QUESTIONS, 1):
    gen(q, ADAPTER_B, f"/tmp/eval_q{i}_adapterB.txt")
    print(f"gov Q{i} done")
# 自然度 10 题 × base + adapterB
for i, q in enumerate(NATURAL_QUESTIONS, 1):
    gen(q, None, f"/tmp/nat_q{i}_base.txt")
    gen(q, ADAPTER_B, f"/tmp/nat_q{i}_adapterB.txt")
    print(f"nat Q{i} done")
print("ALL_DONE")
