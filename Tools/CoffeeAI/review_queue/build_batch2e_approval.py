#!/usr/bin/env python3
"""build_batch2e_approval.py — Batch2e 批准落库（GPT 终复核通过 + 负责人授权）。

GPT 终复核（gpt_replies/gpt_reply_batch2e_draftv6_approved.md）：Batch2e draft v6 通过，
进入负责人逐条拍板；负责人 2026-10-15 拍板（8 条全部批准）。执行顺序（GPT 裁定）：
allowed_sample_ids 对齐（仅并入实际获批样本 ID）→ 落库（双哈希）→ manifest
batch2e-approved-r1 → 准入验证 → 新数据版本重新 split → leakage 检查与回归评测。
只允许：新增 b2e sample id、对已有 exception 增加 allowed_sample_ids；
禁止：修改已有 approved / 历史 Batch1~2d / claim_id / 扩大 source exception 范围 /
修改 28/4/3 历史划分（新划分以新数据版本生成）。
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))
from coffeeai_common import messages_fingerprint, reviewed_record_sha256  # noqa: E402

REPO = HERE.parents[2]
EXC_PATH = REPO / "Tools/CoffeeAI/source_exceptions.json"
DRAFT = HERE / "batch2e_candidates_draft.jsonl"
REVIEWER = "banmu123 (project owner)"
REVIEWED_AT = "2026-10-15"
DATA_VERSION = "v0.2-batch2e"

SOURCE_DOC = {
    "b2e-001": "knowledge/brewing/pour-over.md",
    "b2e-002": "knowledge/freshness/freshness.md",
    "b2e-003": "knowledge/espresso/espresso-fundamentals.md",
    "b2e-004": "knowledge/sensory/sensory-and-flavor.md",
    "b2e-005": "knowledge/roasting/coffee-roasting.md",
    "b2e-006": "knowledge/brewing/pour-over.md",
    "b2e-007": "knowledge/freshness/freshness.md",
    "b2e-008": "knowledge/espresso/espresso-fundamentals.md",
}

EXC_EXTEND = {
    "hario-v60-expert-guide": ["b2e-001"],
    "fellow-brew-talks": ["b2e-002", "b2e-007"],
    "fellow-espresso-basics": ["b2e-003"],
    "gaggia-classic-manual": ["b2e-003", "b2e-008"],
    "ucdavis-coffee-center": ["b2e-004", "b2e-005"],
    "hario-v60-hoffmann": ["b2e-006"],
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
                f"；2026-10-15 Batch2e 扩展（GPT 终复核 draft v6 通过，负责人拍板 8 条全部批准）："
                f"+{','.join(add)}（仅样本范围对齐，claim/topics/授权范围未变）")
            changed.append(f"{sid}:+{','.join(add)}")
    EXC_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("例外扩展:", "; ".join(changed) if changed else "(无变更——已应用)")


def build_candidates():
    rows = [json.loads(l) for l in DRAFT.read_text(encoding="utf-8").splitlines() if l.strip()]
    assert len(rows) == 8, f"草稿应为 8 条，实际 {len(rows)}"
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
            "notes": (f"Batch2e 草稿（GPT 终裁 clarification 批次：追问能力数据侧验证，"
                      f"追问 4 + 直答 4 防模板化；plan v1→v3 + draft v1→v6 经 GPT 六轮复核"
                      f"收敛：claim 方向对齐/因果映射删除/来源归属修正/语义标层成对化）；"
                      f"reasoning_level={r['reasoning_level']}；"
                      f"training_value={r['training_value']}；"
                      f"interaction_skill={r['interaction_skill']}；"
                      f"missing_information_handling={r['missing_information_handling']}；"
                      f"risk_notes={r['risk_notes']}；"
                      f"负责人 2026-10-15 拍板（8 条全部批准）"),
            "reviewed_content_sha256": fp,
            "reviewed_by": REVIEWER,
            "reviewed_at": REVIEWED_AT,
            "reasoning_level": r["reasoning_level"],
            "risk_notes": r["risk_notes"],
        }
        meta["reviewed_record_sha256"] = reviewed_record_sha256(meta, msgs)
        corpus.append({"sample_id": sid, "group_id": f"g-{sid}", "messages": msgs})
        metas.append(meta)
    (HERE / "batch2e_candidates.jsonl").write_text(
        "\n".join(json.dumps(c, ensure_ascii=False) for c in corpus) + "\n", encoding="utf-8")
    (HERE / "batch2e_candidates.meta.jsonl").write_text(
        "\n".join(json.dumps(m, ensure_ascii=False) for m in metas) + "\n", encoding="utf-8")
    print(f"candidates.jsonl: {len(corpus)} 条；meta.jsonl: {len(metas)} 条（approved + 双哈希）")
    return [c["sample_id"] for c in corpus]


def build_manifest(sample_ids):
    manifest = {
        "batch_id": "batch2e-approved-r1",
        "created_at": REVIEWED_AT,
        "approved_samples": sample_ids,
        "approved_by": REVIEWER,
        "approved_at": REVIEWED_AT,
        "deployment_purpose": "noncommercial-research",
        "decision_reference": (
            "batch2e-approved-r1：b2e-001~008——负责人 2026-10-15 拍板（8 条全部批准）。"
            "审核链：batch2e_candidate_plan（GPT 终裁 clarification 批次：追问能力数据侧验证，"
            "追问 4 + 直答 4 防模板化；plan v1→v3 经 GPT 两轮核验收敛）→ draft v1→v6 经 GPT "
            "四轮复核收敛（事实语义 8 条修订 → claim 元数据闭环 → F/P/I 成对标层 → 逐句语义"
            "标层）→ 终复核通过（gpt_reply_batch2e_draftv6_approved.md）。"
            "GPT 定位：验证追问能力的数据设计，不是为了继续训练而赶进度。"),
        "source_exception_reference": (
            "Tools/CoffeeAI/source_exceptions.json（本轮仅扩展 allowed_sample_ids："
            "hario-v60-expert-guide←b2e-001、fellow-brew-talks←b2e-002/007、"
            "fellow-espresso-basics←b2e-003、gaggia-classic-manual←b2e-003/008、"
            "ucdavis-coffee-center←b2e-004/005、hario-v60-hoffmann←b2e-006；"
            "claim/topics/授权范围未变）。b2e-003 双来源 topic 交集 {'espresso'} 非空。"
            "冷萃题（claim.coldbrew.roast-x-temp-interaction）因实际来源 "
            "ucdavis-coldbrew-2025 许可状态 see-source-terms 而暂缓，未纳入本批次。"),
        "notes": (
            "batch2e-approved-r1：8 条全部批准（approved 35 → 43；clarification 2 → 6）。"
            "训练保持冻结——GPT 终裁：即使 43 条也不自动批准新一轮 3B 训练，待新数据版本"
            "（重新 split）就绪、质量门禁通过后单独裁定。落库后：新数据版本重新 split（"
            "seed=42，6 批合并）→ leakage 检查 → audit 更新 → 回归评测。历史 35 条与 "
            "28/4/3 划分保留为历史版本，不覆盖。"),
    }
    (HERE / "approved_batch_manifest_batch2e.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("manifest: batch2e-approved-r1（8 samples）")


if __name__ == "__main__":
    extend_exceptions()
    ids = build_candidates()
    build_manifest(ids)
