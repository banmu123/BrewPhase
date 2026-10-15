#!/usr/bin/env python3
"""prepare_lora_dataset.py — 阶段七-C：approved 数据 → LoRA chat 格式（只读转换）。

GPT 指示（六点九-C 阶段七-C）：
- 不直接使用 approved jsonl，转换为 chat format。**保留完整 messages（含 system
  消息）**——审核指纹绑定审核时的完整对话，去掉 system 会触发
  admission-content-mismatch（治理红线：不允许自动重算放行）；且 system prompt
  是 BrewPhase 行为对齐核心（区分事实与推断/资料不足时明确说明/不编造来源）。
  阶段七-G-0（GPT 裁定）修正：本文档早期「system 不进训练」的说法与实现不符，
  以实现为准——system 消息确实进入训练；
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
BATCHES = ("batch1_candidates", "batch2a_candidates", "batch2b_candidates",
           "batch2c_candidates", "batch2d_candidates")


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
        rows, metas = [], []
        for line in src.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            r = json.loads(line)
            sid = r["sample_id"]
            m = meta.get(sid, {})
            # 保留完整 messages（含 system）：审核指纹绑定审核时的完整对话，
            # 去掉 system 会导致 admission-content-mismatch（治理红线：不允许
            # 自动重算放行）；且 system prompt 本身就是 BrewPhase 行为对齐核心
            # （「区分事实与推断/资料不足时明确说明/不编造来源」）。
            msgs = r.get("messages", [])
            rows.append({
                "sample_id": sid,
                "interaction_skill": skill_of(m),
                "reasoning_level": m.get("reasoning_level", ""),
                "messages": msgs,
            })
            # 审计 meta（run_train.py 准入复查要求划分产物携带完整审计元数据）
            metas.append({
                "sample_id": sid,
                "group_id": m.get("group_id", f"g-{sid}"),
                "topic": m.get("topic", ""),
                "source_doc": m.get("source_doc", ""),
                "source_ids": m.get("source_ids", []),
                "claim_ids": m.get("claim_ids", []),
                "license_status": m.get("license_status", "own-original"),
                "review_status": m.get("review_status", "approved"),
                "data_version": m.get("data_version", ""),
                "dedup_fingerprint": m.get("dedup_fingerprint", ""),
                "source_usage": m.get("source_usage", {}),
                "reviewed_content_sha256": m.get("reviewed_content_sha256", ""),
                "reviewed_record_sha256": m.get("reviewed_record_sha256", ""),
                "reviewed_by": m.get("reviewed_by", ""),
                "reviewed_at": m.get("reviewed_at", ""),
                "reasoning_level": m.get("reasoning_level", ""),
                "risk_notes": m.get("risk_notes", ""),
                "interaction_skill": skill_of(m),
                "lora_split": split,
            })
        out = OUT / f"{split}.jsonl"
        out.write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in rows) + "\n", encoding="utf-8")
        mout = OUT / f"{split}.meta.jsonl"
        mout.write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in metas) + "\n", encoding="utf-8")
        counts[split] = len(rows)
        print(f"{split}: {len(rows)} 条 → {out}（+ meta）")
    total = sum(counts.values())
    print(f"合计 {total} 条（预期 35：b1 5 + b2a 9 + b2b 8 + b2c 3 + b2d 10）")
    assert total == 35, f"转换后总数异常: {total} != 35"


if __name__ == "__main__":
    convert()
