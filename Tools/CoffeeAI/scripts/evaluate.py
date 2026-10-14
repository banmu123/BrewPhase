#!/usr/bin/env python3
"""evaluate.py — CommitBrew Coffee AI 评测（对应任务验收 8）。

对同一批独立测试问题，分别用「未微调基础模型」与「基础模型+自有适配器」生成回答，
保存两组回答与运行配置，产出便于人工审核的报告。

红线（刻意设计，不要移除）：
  - 本工具只生成「待人工审核」的回答对，不做任何自动打分；
  - 不依据训练损失或自动指标宣称模型变好——是否更好由人工按报告中的
    评测维度清单审核判定；
  - 测试集必须与训练集分离（默认读 data/splits/test.jsonl，该文件由
    split_dataset.py 保证未参与训练）。

用法:
  python3 Tools/CoffeeAI/scripts/evaluate.py \
      --base-model mlx-community/Qwen3-4B-Instruct-2507-4bit \
      --adapter-path Tools/CoffeeAI/runs/adapters \
      --questions Tools/CoffeeAI/data/splits/test.jsonl --limit 10
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import env_check  # noqa: E402
from coffeeai_common import COFFEEAI_ROOT as COFFEEAI  # noqa: E402

REVIEW_DIMENSIONS = [
    "知识准确性：回答与可靠咖啡资料是否一致，有无事实错误",
    "冲煮分析与推理：诊断与参数建议是否合理、有无因果倒置或绝对化",
    "对资料来源的使用：是否引用了真实存在的来源/承认来源边界",
    "事实与推断的区分：是否把推断、经验说成事实",
    "面对未知问题：是否编造资料或给出无依据的确定结论",
    "总体判断：微调版回答质量是否真的优于基础模型（逐题给出你的结论）",
]


def first_user_prompt(messages):
    for m in messages:
        if isinstance(m, dict) and m.get("role") == "user":
            return str(m.get("content", ""))
    return None


def generate(entry, model, prompt, adapter, max_tokens, temp, seed):
    cmd = list(entry) + [
        "--model", model, "--prompt", prompt,
        "--max-tokens", str(max_tokens), "--temp", str(temp), "--seed", str(seed),
    ]
    if adapter:
        cmd += ["--adapter-path", adapter]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    return proc.returncode, (proc.stdout or ""), (proc.stderr or "")


def main(argv=None):
    p = argparse.ArgumentParser(description="CommitBrew Coffee AI 评测")
    p.add_argument("--base-model", required=True, help="基础模型 HF id 或本地路径")
    p.add_argument("--adapter-path", default=None, help="微调适配器目录；不给则只评测基础模型")
    p.add_argument("--questions", default="Tools/CoffeeAI/data/splits/test.jsonl")
    p.add_argument("--limit", type=int, default=10)
    p.add_argument("--max-tokens", type=int, default=512)
    p.add_argument("--temp", type=float, default=0.2)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--out", default=None, help="输出目录（默认 runs/eval_<ts>）")
    args = p.parse_args(argv)

    # 环境与模型守卫：评测绝不下载
    info = env_check.collect(args.base_model if "/" in args.base_model else None)
    if info["mlx_lm_version"] is None or str(info["mlx_lm_version"]).startswith("import-failed"):
        print('[CoffeeAI] 错误: 评测需要先安装 mlx-lm: pip install "mlx-lm[train]"', file=sys.stderr)
        sys.exit(1)
    if "/" in args.base_model and not env_check.model_cached(args.base_model):
        print(f"[CoffeeAI] 错误: 模型 {args.base_model} 不在本地缓存。评测工具绝不下载，"
              "请先完成模型下载（见 README）。", file=sys.stderr)
        sys.exit(1)

    qpath = Path(args.questions)
    if not qpath.is_absolute():
        qpath = COFFEEAI.parents[1] / qpath
    if not qpath.is_file():
        print(f"[CoffeeAI] 错误: 测试集不存在: {qpath}（先运行 split_dataset.py）", file=sys.stderr)
        sys.exit(1)

    questions = []
    for line in qpath.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        d = json.loads(line)
        prompt = first_user_prompt(d.get("messages") or [])
        if prompt:
            questions.append(prompt)
    if args.limit:
        questions = questions[: args.limit]
    if not questions:
        print("[CoffeeAI] 错误: 测试集中没有可用问题。", file=sys.stderr)
        sys.exit(1)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out = Path(args.out) if args.out else COFFEEAI / "runs" / f"eval_{ts}"
    if not out.is_absolute():
        out = COFFEEAI.parents[1] / out
    out.mkdir(parents=True, exist_ok=True)

    exe = sys.executable
    import shutil as _sh
    gen_entry = ([_sh.which("mlx_lm.generate")] if _sh.which("mlx_lm.generate")
                 else [exe, "-m", "mlx_lm.generate"])

    runs = [("base", args.base_model, None)]
    if args.adapter_path:
        runs.append(("finetuned", args.base_model, args.adapter_path))
    else:
        print("[CoffeeAI] 提示: 未提供 --adapter-path，只评测基础模型（无对比意义，仅供基线采写）。")

    meta = {
        "timestamp": ts,
        "base_model": args.base_model,
        "adapter_path": args.adapter_path,
        "questions_file": str(qpath),
        "n_questions": len(questions),
        "max_tokens": args.max_tokens, "temp": args.temp, "seed": args.seed,
        "mlx_lm_version": info["mlx_lm_version"],
        "host": {"chip": info["chip"], "memory_gb": info["memory_gb"]},
        "policy": "回答仅供人工审核；本工具不做自动打分，不宣称微调优于基础模型。",
    }
    (out / "eval_config.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n",
                                          encoding="utf-8")

    answers = {}
    for tag, model, adapter in runs:
        rows = []
        for i, q in enumerate(questions, 1):
            print(f"[CoffeeAI] ({tag}) {i}/{len(questions)}: {q[:40]}...")
            code, stdout, stderr = generate(gen_entry, model, q, adapter,
                                            args.max_tokens, args.temp, args.seed)
            rows.append({
                "idx": i, "prompt": q,
                "answer_raw_stdout": stdout,
                "exit_code": code,
                "stderr_tail": stderr[-500:] if code else "",
            })
        answers[tag] = rows
        with (out / f"answers_{tag}.jsonl").open("w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")

    # 人工审核报告
    md = ["# CommitBrew Coffee AI — 评测回答（待人工审核）", "",
          f"- 时间: {ts}",
          f"- 基础模型: `{args.base_model}`",
          f"- 适配器: `{args.adapter_path or '（未提供，仅基础模型）'}`",
          f"- 测试集: `{qpath}`（独立于训练集）",
          f"- 参数: max_tokens={args.max_tokens}, temp={args.temp}, seed={args.seed}",
          "",
          f"> {meta['policy']}", "",
          "## 人工审核维度", ""]
    for i, d in enumerate(REVIEW_DIMENSIONS, 1):
        md.append(f"{i}. {d}")
    md += ["", "## 逐题回答", ""]
    for i, q in enumerate(questions):
        md.append(f"### Q{i + 1}: {q}")
        for tag, _m, _a in runs:
            row = answers[tag][i]
            body = (row["answer_raw_stdout"] or "").strip()
            if row["exit_code"] != 0:
                body = f"（生成失败 exit={row['exit_code']}）"
            md += ["", f"**[{tag}]**", "", "```text", body or "（空回答）", "```"]
        md.append("")
    (out / "eval_report.md").write_text("\n".join(md) + "\n", encoding="utf-8")

    print("=" * 62)
    print("评测完成（回答已保存，等待人工审核）")
    print(f"输出目录: {out}")
    print(f"  - eval_config.json / answers_*.jsonl / eval_report.md")
    print("结论口径: 是否比基础模型更好，须由人工按报告维度审核后判定；")
    print("          本工具与训练损失均不构成质量结论。")
    sys.exit(0)


if __name__ == "__main__":
    main()
