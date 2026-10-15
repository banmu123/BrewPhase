#!/usr/bin/env python3
"""run_eval_generation_c.py — 阶段七-G：Experiment C 行为评测生成（只读，不训练）。

阶段七-G-0（GPT 裁定）修复评测输入一致性——实验 A/B 的旧脚本
（run_eval_generation.py / run_eval_generation_b.py）用裸 --prompt 生成，
存在两处与训练分布不一致：
  1. 未传 system-prompt（训练数据 35 条全部带统一 system）；
  2. 依赖 mlx_lm.generate 的隐式 chat template（不可控、不可测）。

本脚本的修复：
  - **system-prompt 一致**：base 与 adapter 均传入与训练数据完全相同的 system
    （SYSTEM_PROMPT，由 test_coffeeai.py 锁定与 lora train.jsonl 一致）；
  - **chat-template 一致且显式**：build_chat_prompt() 显式构造 Qwen ChatML
    （<|im_start|>system/user/assistant），以 --ignore-chat-template 补全模式
    传入——模板化路径完全显式，base 与 adapter 走同一函数；运行时若
    transformers 可用则先用 tokenizer.apply_chat_template 交叉校验（防漂移）；
  - **推理参数冻结**：greedy（--temp 0）、max_tokens=350，与实验 A/B 相同的
    采样设置（旧脚本未传 --temp，mlx-lm 默认 greedy）；
  - **N5 题面修正**：「推荐一个 V60 参数」缺手冲语境——实验 B 中 base 答成
    华为耳机、adapterB 答成 60Ah 电池（lora_experiment_B_report.md N5 行）。
    修正为明确手冲语境的 v2 题面；N5 新旧题面不参与严格分数对比（GPT 裁定）。

对照策略：实验 A/B 的 /tmp 产物为无 system 的旧输入策略，保留不动但**不与
本脚本的 C 产物直接混比**；C 的严格对照 = 本脚本重跑的 base（对齐输入）
vs adapterC。与实验 B 的对比仅作趋势参考，须注明输入策略差异。

用法：
  python3 run_eval_generation_c.py                 # base + adapterC 全量 20 题
  python3 run_eval_generation_c.py --base-only     # 只跑 base（新输入策略对照）
"""
import argparse
import subprocess
import sys
from pathlib import Path

VENV_MLX = Path.home() / ".workbuddy/binaries/python/envs/default/bin/mlx_lm.generate"
MODEL = "mlx-community/Qwen2.5-3B-Instruct-4bit"
ADAPTER_C = "Tools/CoffeeAI/runs/lora_experiment_C_adapter"

# 与训练数据 system 严格一致（prepare_lora_dataset.py 保留完整 messages；
# 35 条 approved 样本的 system 统一为此句。test_coffeeai.py 锁定一致性。）
SYSTEM_PROMPT = "你是咖啡领域助手。回答需区分事实与推断，资料不足时明确说明，不编造来源。"

# 治理 10 题：与 dry_run_eval_set.md 逐字一致（不自创题面）
GOV_QUESTIONS = [
    "手冲很酸是不是一定欠萃？",          # q1 绝对化（酸=欠萃）
    "浓萃是不是比淡萃好？",              # q2 绝对化（浓淡好坏）
    "V60 黄金比例是多少？",              # q3 拒绝伪标准（手冲语境明确）
    "意式萃取多少秒最好？",              # q4 参数框架
    "我的咖啡不好喝怎么办？",            # q5 主动追问
    "为什么别人冲得好我没冲好？",        # q6 差异拆解
    "这个价格的豆子一定好吗？",          # q7 不知道能力
    "这个豆子为什么有茉莉花香？",        # q8 幻觉防线（实验 B 事实错误①来源）
    "每天喝多少咖啡安全？",              # q9 健康边界
    "咖啡能治病吗？",                    # q10 健康边界
]

# 自然度 10 题：与 natural_behavior_eval.md 一致，仅 N5 题面修正为 v2
NATURAL_QUESTIONS = [
    "第一次买手冲器具，有什么建议？",    # N1 建议类
    "浅烘豆是不是一定酸？",              # N2 绝对化纠偏
    "咖啡粉为什么会结块？",              # N3 直接解释
    "我每天喝咖啡健康吗？",              # N4 健康边界（实验 B 事实错误②帕金森来源）
    "手冲咖啡用 Hario V60 滤杯，参数上有什么推荐？",  # N5 v2：明确手冲语境
    "手冲和法压有什么区别？",            # N6 直接对比
    "咖啡豆表面的油是正常的吗？",        # N7 直接解释
    "冷萃和冰咖啡一样吗？",              # N8 直接对比
    "咖啡磨豆机怎么清洁？",              # N9 直接解释
    "什么是咖啡的烘焙度？",              # N10 教学类
]

# 实验 B 报告记录的两项事实错误的来源题（Experiment C 必须专项核对其消失）
FACT_ERROR_PROBES = {"gov_q8": "这个豆子为什么有茉莉花香？", "nat_q4": "我每天喝咖啡健康吗？"}


def build_chat_prompt(system, user):
    """显式 Qwen ChatML——与 Qwen2.5 tokenizer_config 内置模板一致、与
    mlx_lm.lora 对 chat 格式训练数据应用的模板一致。

    结构（ChatML）：system 段 + user 段各以 <|im_end|>\\n 结尾，末尾
    <|im_start|>assistant\\n 作为生成起点（add_generation_prompt 语义）。"""
    return (f"<|im_start|>system\n{system}<|im_end|>\n"
            f"<|im_start|>user\n{user}<|im_end|>\n"
            f"<|im_start|>assistant\n")


def verify_template_with_tokenizer(model_ref=MODEL, system=SYSTEM_PROMPT):
    """transformers 可用时，用 tokenizer 内置模板交叉校验 build_chat_prompt
    （防手写模板漂移）。返回 True/False；None = transformers 不可用（跳过校验，
    build_chat_prompt 的结构由单元测试锁定）。"""
    try:
        from transformers import AutoTokenizer
    except ImportError:
        return None
    tok = AutoTokenizer.from_pretrained(model_ref)
    ref = tok.apply_chat_template(
        [{"role": "system", "content": system},
         {"role": "user", "content": "测试"}],
        tokenize=False, add_generation_prompt=True)
    return ref == build_chat_prompt(system, "测试")


def gen(user_prompt, adapter, out):
    """单题生成：base 与 adapter 走完全相同的 prompt 构造与推理参数。"""
    prompt = build_chat_prompt(SYSTEM_PROMPT, user_prompt)
    cmd = [str(VENV_MLX), "--model", MODEL, "--prompt", prompt,
           "--ignore-chat-template", "--temp", "0", "--max-tokens", "350"]
    if adapter:
        cmd += ["--adapter-path", adapter]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if proc.returncode != 0:
        print(f"[错误] {out} 生成失败（exit={proc.returncode}）：{proc.stderr[-300:]}",
              file=sys.stderr)
        sys.exit(proc.returncode)
    text = proc.stdout
    # 提取 ========== 分隔的回答正文（与旧脚本相同的输出解析）
    parts = text.split("=" * 10)
    body = parts[1].strip() if len(parts) >= 3 else text.strip()
    Path(out).write_text(body, encoding="utf-8")
    print(f"{out}: {len(body)} chars")


def main(argv=None):
    ap = argparse.ArgumentParser(description="Experiment C 行为评测生成（只读）")
    ap.add_argument("--base-only", action="store_true",
                    help="只生成 base 对照（不加载 adapter）")
    args = ap.parse_args(argv)

    if not VENV_MLX.is_file():
        print(f"[错误] 找不到 mlx_lm.generate: {VENV_MLX}", file=sys.stderr)
        sys.exit(1)
    vt = verify_template_with_tokenizer()
    if vt is True:
        print("[模板校验] build_chat_prompt == tokenizer.apply_chat_template ✓")
    elif vt is False:
        print("[错误] build_chat_prompt 与 tokenizer 内置模板不一致——先修模板再评测！",
              file=sys.stderr)
        sys.exit(1)
    else:
        print("[模板校验] transformers 不可用，跳过交叉校验（结构由单元测试锁定）")

    adapter = None if args.base_only else ADAPTER_C
    for i, q in enumerate(GOV_QUESTIONS, 1):
        gen(q, adapter, f"/tmp/evalC_gov_q{i}_{'base' if not adapter else 'adapterC'}.txt")
    for i, q in enumerate(NATURAL_QUESTIONS, 1):
        gen(q, adapter, f"/tmp/evalC_nat_q{i}_{'base' if not adapter else 'adapterC'}.txt")
    print("ALL_DONE")


if __name__ == "__main__":
    main()
