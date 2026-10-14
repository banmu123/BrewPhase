#!/usr/bin/env python3
"""prepare_lora_dataset.py — 阶段七-C：approved 数据 → LoRA chat 格式（只读转换）。

GPT 指示（六点九-C 阶段七-C）：
- 不直接使用 approved jsonl，转换为 chat format（仅 user/assistant，system 不进训练
  ——GPT 给出的格式不含 system）；
- metadata（sample_id / interaction_skill / reasoning_level）**保留为行级字段但不进
  prompt**——避免模型学习「看到标签所以表演行为」而非自然产生行为；
- 输出 Tools/CoffeeAI/training/data/lora/{train,valid,test}.jsonl。

本脚本只读 approved 语料（review_queue 的落库产物），不修改任何 approved 数据。
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
Q = HERE.parent / "review_queue"
SPLITS = HERE.parent / "data" / "splits"
OUT = HERE / "data" / "lora"
BATCHES = ("batch1_candidates", "batch2a_candidates", "batch2b_candidates", "batch2c_candidates")


def load_meta():
    meta = {}
    for name in BATCHES:
        p = Q / f"{name}.meta.jsonl"
        if not p.is_file():
            continue
        for line in p.read_text(encoding="utf-8").splitlines():
            if line.strip():
                m = json.loads(line)
                if m.get("review_status") == "approved":
                    meta[m["sample_id"]] = m
    return meta


def skill_of(m):
    if m.get("interaction_skill"):
        return m["interaction_skill"]
    # b1/b2a 无独立字段，从 notes 提取
    import re
    mt = re.search(r"interaction_skill=([a-z_]+)", m.get("notes") or "")
    return mt.group(1) if mt else ""


def convert():
    OUT.mkdir(parents=True, exist_ok=True)
    meta = load_meta()
    counts = {}
    for split in ("train", "valid", "test"):
        src = SPLITS / f"{split}.jsonl"
        rows = []
        for line in src.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            r = json.loads(line)
            sid = r["sample_id"]
            m = meta.get(sid, {})
            msgs = [mm for mm in r.get("messages", []) if mm.get("role") in ("user", "assistant")]
            rows.append({
                "sample_id": sid,
                "interaction_skill": skill_of(m),
                "reasoning_level": m.get("reasoning_level", ""),
                "messages": msgs,
            })
        out = OUT / f"{split}.jsonl"
        out.write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in rows) + "\n", encoding="utf-8")
        counts[split] = len(rows)
        print(f"{split}: {len(rows)} 条 → {out}")
    total = sum(counts.values())
    print(f"合计 {total} 条（预期 25）")
    assert total == 25, f"转换后总数异常: {total} != 25"


if __name__ == "__main__":
    convert()
