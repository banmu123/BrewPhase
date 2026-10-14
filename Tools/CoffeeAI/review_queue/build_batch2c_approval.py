#!/usr/bin/env python3
"""build_batch2c_approval.py — 阶段六点九-H：Batch2c 批准落库（GPT 拍板 + 负责人授权）。

GPT 拍板（gpt_replies/gpt_reply_69g_ruling_69h_prompt.md）：三条全部批准；b2c-002
设备 F/P 拆分与 b2c-003 interaction_skill 改标已在草稿中落实；例外仅扩展
allowed_sample_ids（不新增 claim/source/topic/allowed_claim_ids）。
落库前检查：quality gate / source_admission / check_approval_ready --dry-run。
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))
from coffeeai_common import messages_fingerprint, reviewed_record_sha256  # noqa: E402

REPO = HERE.parents[2]
EXC_PATH = REPO / "Tools/CoffeeAI/source_exceptions.json"
DRAFT = HERE / "batch2c_candidates_draft.jsonl"
REVIEWER = "banmu123 (project owner)"
REVIEWED_AT = "2026-10-14"
DATA_VERSION = "v0.2-batch2c"

SOURCE_DOC = {
    "b2c-001": "knowledge/sensory/sensory-and-flavor.md",
    "b2c-002": "knowledge/sensory/sensory-and-flavor.md",
    "b2c-003": "knowledge/sensory/sensory-and-flavor.md",
}

EXC_EXTEND = {
    "ucdavis-coffee-center": ["b2c-001", "b2c-002", "b2c-003"],
    "baratza-documents": ["b2c-002"],
    "nca-aboutcoffee": ["b2c-002"],
}


def extend_exceptions():
    data = json.loads(EXC_PATH.read_text(encoding="utf-8"))
    changed = []
    for exc in data["exceptions"]:
        sid = exc["sourceId"]
        add = [s for s in EXC_EXTEND.get(sid, []) if s not in (exc.get("allowed_sample_ids") or [])]
        if add:
            exc.setdefault("allowed_sample_ids", []).extend(add)
            exc["reason"] = (exc.get("reason") or "") + (
                f"；2026-10-14 阶段六点九-H 扩展（GPT 拍板 Batch2c 批准落库）："
                f"+{','.join(add)}（仅样本范围对齐，claim/topics/授权范围未变）")
            changed.append(f"{sid}:+{','.join(add)}")
    EXC_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("例外扩展:", "; ".join(changed) if changed else "(无变更——已应用)")


def build_candidates():
    rows = [json.loads(l) for l in DRAFT.read_text(encoding="utf-8").splitlines() if l.strip()]
    assert len(rows) == 3, f"草稿应为 3 条，实际 {len(rows)}"
    corpus, metas = [], []
    for r in rows:
        sid = r["sample_id"]
        msgs = r["messages"]
        fp = messages_fingerprint(msgs)
        meta = {
            "sample_id": sid,
            "group_id": f"g-{sid}",
            "topic": r["topic"],
            "source_doc": SOURCE_DOC[sid],
            "source_ids": r["source_ids"],
            "claim_ids": r["claim_ids"],
            "license_status": r["license_status"],
            "review_status": "approved",
            "data_version": DATA_VERSION,
            "dedup_fingerprint": fp,
            "source_usage": r["source_usage"],
            "notes": (f"Batch2c 草稿（BATCH2_WRITING_SPEC + 六点九-F 交互规则 + GPT 六点九-H "
                      f"裁定修订：b2c-002 设备 F/P 拆分、b2c-003 interaction_skill="
                      f"uncertainty_handling）；reasoning_level={r['reasoning_level']}；"
                      f"training_value={r['training_value']}；"
                      f"interaction_skill={r['interaction_skill']}；"
                      f"missing_information_handling={r['missing_information_handling']}；"
                      f"risk_notes={r['risk_notes']}；"
                      f"负责人 2026-10-14 拍板（采纳 GPT 拍板，3 条全部批准）"),
            "reviewed_content_sha256": fp,
            "reviewed_by": REVIEWER,
            "reviewed_at": REVIEWED_AT,
            "reasoning_level": r["reasoning_level"],
            "risk_notes": r["risk_notes"],
        }
        meta["reviewed_record_sha256"] = reviewed_record_sha256(meta, msgs)
        corpus.append({"sample_id": sid, "group_id": f"g-{sid}", "messages": msgs})
        metas.append(meta)
    (HERE / "batch2c_candidates.jsonl").write_text(
        "\n".join(json.dumps(c, ensure_ascii=False) for c in corpus) + "\n", encoding="utf-8")
    (HERE / "batch2c_candidates.meta.jsonl").write_text(
        "\n".join(json.dumps(m, ensure_ascii=False) for m in metas) + "\n", encoding="utf-8")
    print(f"candidates.jsonl: {len(corpus)} 条；meta.jsonl: {len(metas)} 条（approved + 双哈希）")
    return [c["sample_id"] for c in corpus]


def build_manifest(sample_ids):
    manifest = {
        "batch_id": "batch2c-approved-r1",
        "created_at": REVIEWED_AT,
        "approved_samples": sample_ids,
        "approved_by": REVIEWER,
        "approved_at": REVIEWED_AT,
        "deployment_purpose": "noncommercial-research",
        "decision_reference": (
            "batch2c-approved-r1：b2c-001~003——负责人 2026-10-14 拍板（采纳 GPT 拍板）。"
            "审核链：batch2c_candidate_plan（六点九-F 第一步）→ 草稿（第二步，GPT 硬约束"
            "落实）→ 审核包（六点九-G，A-H + 层级表核对）→ GPT 六点九-H 拍板（三条批准 + "
            "b2c-002 设备 F/P 拆分 + b2c-003 interaction_skill=uncertainty_handling）。"
            "GPT 定位：QA 数据 → Agent 行为数据（什么时候应该问/拆变量/承认不知道）。"),
        "source_exception_reference": (
            "Tools/CoffeeAI/source_exceptions.json（本轮仅扩展 allowed_sample_ids："
            "ucdavis←b2c-001/002/003、baratza←b2c-002、nca←b2c-002；claim/topics/授权"
            "范围未变）。三来源样本 b2c-002 的 topic 交集 {'pour-over diagnosis'} 由"
            "六点九-E topics 对齐扩展覆盖。"),
        "notes": (
            "batch2c-approved-r1：3 条全部批准（approved 22 → 25，达成 approved ≥25 阈值）。"
            "训练保持冻结。质量门禁 PASSED（0/0）；130 tests OK；build_kb --check OK。"
            "落库后进入阶段七：第一次模型实验准备（数据审计最终版 → mlx-lm 安装 → 基座"
            "下载 → LoRA dry-run → loss/overfit/泄漏检查 → 不直接训练）。"),
    }
    (HERE / "approved_batch_manifest_batch2c.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("manifest: batch2c-approved-r1（3 samples）")


if __name__ == "__main__":
    extend_exceptions()
    ids = build_candidates()
    build_manifest(ids)
