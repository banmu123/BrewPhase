#!/usr/bin/env python3
"""check_training_leakage.py — 阶段七-A：训练集泄漏检查（只读）。

检查 train/valid/test 之间（GPT 指定 train vs test 为主，本脚本同时覆盖 valid）：
  1. 相同 user prompt（user 消息文本完全一致，跨集合出现即泄漏）；
  2. 相同 answer fingerprint（assistant 消息 sha256 一致，跨集合出现即泄漏）；
  3. 同 claim_id 组合 + 同 interaction_skill 完全重复（跨集合即疑似泄漏）。

输出 leakage 计数与明细；exit 0 = 无泄漏，1 = 存在泄漏。
"""
import hashlib
import json
import re
import sys
from pathlib import Path

SPLITS = Path(__file__).resolve().parents[1] / "data" / "splits"


def user_prompt(record):
    for m in record.get("messages", []):
        if m.get("role") == "user":
            return m.get("content", "").strip()
    return ""


def answer_fp(record):
    for m in record.get("messages", []):
        if m.get("role") == "assistant":
            return hashlib.sha256(m.get("content", "").encode("utf-8")).hexdigest()
    return ""


def interaction_skill_of(meta_row):
    text = meta_row.get("interaction_skill") or ""
    if text:
        return text
    m = re.search(r"interaction_skill=([a-z_]+)", meta_row.get("notes") or "")
    return m.group(1) if m else ""


def load_split(name):
    corpus = {}
    p = SPLITS / f"{name}.jsonl"
    if p.is_file():
        for line in p.read_text(encoding="utf-8").splitlines():
            if line.strip():
                r = json.loads(line)
                corpus[r.get("sample_id")] = r
    meta = {}
    mp = SPLITS / f"{name}.meta.jsonl"
    if mp.is_file():
        for line in mp.read_text(encoding="utf-8").splitlines():
            if line.strip():
                m = json.loads(line)
                meta[m.get("sample_id")] = m
    return corpus, meta


def main():
    if not (SPLITS / "train.jsonl").is_file():
        print(f"[error] 未找到 {SPLITS / 'train.jsonl'}——请先运行 split_dataset.py")
        sys.exit(1)
    splits = {n: load_split(n) for n in ("train", "valid", "test")}
    pairs = [("train", "test"), ("train", "valid"), ("valid", "test")]
    issues = []

    for a, b in pairs:
        ca, ma = splits[a]
        cb, mb = splits[b]
        # 1) 相同 user prompt
        prompts_a = {sid: user_prompt(r) for sid, r in ca.items()}
        prompts_b = {sid: user_prompt(r) for sid, r in cb.items()}
        for sa, pa in prompts_a.items():
            for sb, pb in prompts_b.items():
                if pa and pa == pb:
                    issues.append({"type": "same-user-prompt", "a": f"{a}/{sa}", "b": f"{b}/{sb}"})
        # 2) 相同 answer fingerprint
        fp_a = {sid: answer_fp(r) for sid, r in ca.items()}
        fp_b = {sid: answer_fp(r) for sid, r in cb.items()}
        for sa, fa in fp_a.items():
            for sb, fb in fp_b.items():
                if fa and fa == fb:
                    issues.append({"type": "same-answer-fingerprint", "a": f"{a}/{sa}", "b": f"{b}/{sb}"})
        # 3) 同 claim_ids 组合 + 同 interaction_skill 完全重复
        for sa, ra in ma.items():
            for sb, rb in mb.items():
                same_claims = sorted(ra.get("claim_ids") or []) == sorted(rb.get("claim_ids") or []) and bool(ra.get("claim_ids"))
                same_skill = interaction_skill_of(ra) and interaction_skill_of(ra) == interaction_skill_of(rb)
                if same_claims and same_skill:
                    issues.append({"type": "same-claims-and-skill", "a": f"{a}/{sa}", "b": f"{b}/{sb}"})

    print("=" * 66)
    print("训练集泄漏检查（train/valid/test 交叉）")
    print(f"  样本数: train={len(splits['train'][0])} valid={len(splits['valid'][0])} test={len(splits['test'][0])}")
    if issues:
        print(f"  leakage={len(issues)}")
        for i in issues:
            print(f"  [LEAK] {i['type']}: {i['a']} <-> {i['b']}")
        print("结论: 存在泄漏，禁止训练。")
        sys.exit(1)
    print("  leakage=0")
    print("结论: 无泄漏（相同 user prompt / answer fingerprint / claim+skill 组合均未跨集合出现）。")
    sys.exit(0)


if __name__ == "__main__":
    main()
