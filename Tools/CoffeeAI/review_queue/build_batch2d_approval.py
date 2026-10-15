#!/usr/bin/env python3
"""build_batch2d_approval.py — 阶段七-F-4：Batch2d 批准落库（GPT 核验通过 + 负责人授权）。

GPT 核验（gpt_replies/gpt_reply_stage7f3_approved_7f4.md）：Batch2d review package 达到
批准条件；负责人 2026-10-15 拍板（按 GPT 建议 10 条全部批准）。执行顺序冻结（七-F-4）：
gate → admission → allowed_sample_ids 对齐 → check_approval_ready → validate → split →
audit 更新。只允许：新增 b2d sample id、对已有 exception 增加 allowed_sample_ids；
禁止：修改已有 approved / 历史 Batch2a/b/c / claim_id / 扩大 source exception 范围。
fda-caffeine 为 registry 自动准入来源（无需例外）。
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))
from coffeeai_common import messages_fingerprint, reviewed_record_sha256  # noqa: E402

REPO = HERE.parents[2]
EXC_PATH = REPO / "Tools/CoffeeAI/source_exceptions.json"
DRAFT = HERE / "batch2d_candidates_draft.jsonl"
REVIEWER = "banmu123 (project owner)"
REVIEWED_AT = "2026-10-15"
DATA_VERSION = "v0.2-batch2d"

SOURCE_DOC = {
    "b2d-001": "knowledge/health/coffee-health.md",
    "b2d-002": "knowledge/health/coffee-health.md",
    "b2d-003": "knowledge/brewing/pour-over.md",
    "b2d-004": "knowledge/brewing/pour-over.md",
    "b2d-005": "knowledge/health/coffee-health.md",
    "b2d-006": "knowledge/brewing/pour-over.md",
    "b2d-007": "knowledge/brewing/pour-over.md",
    "b2d-008": "knowledge/espresso/espresso-fundamentals.md",
    "b2d-009": "knowledge/freshness/freshness.md",
    "b2d-010": "knowledge/grinding/grinding.md",
}

EXC_EXTEND = {
    "ucdavis-coffee-center": ["b2d-003", "b2d-004", "b2d-010"],
    "hario-v60-expert-guide": ["b2d-006", "b2d-007"],
    "fellow-espresso-basics": ["b2d-008"],
    "nca-aboutcoffee": ["b2d-009"],
    "baratza-documents": ["b2d-010"],
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
                f"；2026-10-15 阶段七-F-4 扩展（GPT 核验 Batch2d 达批准条件，负责人拍板）："
                f"+{','.join(add)}（仅样本范围对齐，claim/topics/授权范围未变）")
            changed.append(f"{sid}:+{','.join(add)}")
    EXC_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("例外扩展:", "; ".join(changed) if changed else "(无变更——已应用)")


def build_candidates():
    rows = [json.loads(l) for l in DRAFT.read_text(encoding="utf-8").splitlines() if l.strip()]
    assert len(rows) == 10, f"草稿应为 10 条，实际 {len(rows)}"
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
            "notes": (f"Batch2d 草稿（七-F 稳定性补强批次 + GPT 三处修正：b2d-006/007 新枚举 "
                      f"knowledge_explanation、b2d-005 帕金森边界 GPT 修正结构、b2d-003/004 "
                      f"避免简单 QA）；reasoning_level={r['reasoning_level']}；"
                      f"training_value={r['training_value']}；"
                      f"interaction_skill={r['interaction_skill']}；"
                      f"missing_information_handling={r['missing_information_handling']}；"
                      f"risk_notes={r['risk_notes']}；"
                      f"负责人 2026-10-15 拍板（按 GPT 建议，10 条全部批准）"),
            "reviewed_content_sha256": fp,
            "reviewed_by": REVIEWER,
            "reviewed_at": REVIEWED_AT,
            "reasoning_level": r["reasoning_level"],
            "risk_notes": r["risk_notes"],
        }
        meta["reviewed_record_sha256"] = reviewed_record_sha256(meta, msgs)
        corpus.append({"sample_id": sid, "group_id": f"g-{sid}", "messages": msgs})
        metas.append(meta)
    (HERE / "batch2d_candidates.jsonl").write_text(
        "\n".join(json.dumps(c, ensure_ascii=False) for c in corpus) + "\n", encoding="utf-8")
    (HERE / "batch2d_candidates.meta.jsonl").write_text(
        "\n".join(json.dumps(m, ensure_ascii=False) for m in metas) + "\n", encoding="utf-8")
    print(f"candidates.jsonl: {len(corpus)} 条；meta.jsonl: {len(metas)} 条（approved + 双哈希）")
    return [c["sample_id"] for c in corpus]


def build_manifest(sample_ids):
    manifest = {
        "batch_id": "batch2d-approved-r1",
        "created_at": REVIEWED_AT,
        "approved_samples": sample_ids,
        "approved_by": REVIEWER,
        "approved_at": REVIEWED_AT,
        "deployment_purpose": "noncommercial-research",
        "decision_reference": (
            "batch2d-approved-r1：b2d-001~010——负责人 2026-10-15 拍板（按 GPT 建议，"
            "10 条全部批准）。审核链：batch2d_candidate_plan（七-F 第一步，GPT 五方向 "
            "F-001~005 + 事实锚点 2 条）→ 草稿（七-F-2，GPT 三处修正落实 + "
            "knowledge_explanation gate 新增）→ 审核包增强版（七-F-3，fact_stability_risk "
            "+ experiment_target 字段）→ GPT 核验通过（gpt_reply_stage7f3_approved_7f4.md）。"
            "GPT 定位：防行为漂移稳定性补强批次（错误前提检查 / 食品安全不判断 / 研究方向"
            "边界 / 该直接回答时直接回答）。"),
        "source_exception_reference": (
            "Tools/CoffeeAI/source_exceptions.json（本轮仅扩展 allowed_sample_ids："
            "ucdavis←b2d-003/004/010、hario-v60-expert-guide←b2d-006/007、"
            "fellow-espresso-basics←b2d-008、nca←b2d-009、baratza←b2d-010；"
            "claim/topics/授权范围未变）。b2d-010 双来源 topic 交集 "
            "{'pour-over diagnosis'} 非空；fda-caffeine 为 registry 自动准入来源。"),
        "notes": (
            "batch2d-approved-r1：10 条全部批准（approved 25 → 35）。训练保持冻结直到 "
            "audit 更新完成。质量门禁 PASSED（0/0，含 knowledge-explanation gate）；"
            "admission 7 BLOCK→例外对齐后消除；GPT 提醒重点样本 b2d-003（温和纠正，保留"
            "「不能仅凭当前信息判断」）与 b2d-005（「不能证明 X ≠ X 不存在」）均已在审核包"
            "确认满足。落库后：split（seed=42）→ audit 更新 → 阶段七-G 实验 C"
            "（iters=100, lr=1e-5, rank=8, layers=8, batch=1；7B 暂缓至 approved ≥100）。"),
    }
    (HERE / "approved_batch_manifest_batch2d.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("manifest: batch2d-approved-r1（10 samples）")


if __name__ == "__main__":
    extend_exceptions()
    ids = build_candidates()
    build_manifest(ids)
