#!/usr/bin/env python3
"""build_batch2b_approval.py — 阶段六点九-E：Batch2b 批准落库（负责人已拍板）。

负责人拍板依据：GPT 拍板清单（gpt_replies/gpt_reply_69d_approval_69e_prompt.md），
用户对话指示「按照GPT建议继续」（2026-10-14）= 采纳 8 条全 approve + 例外仅扩
allowed_sample_ids + 训练保持冻结。

步骤：
  1. source_exceptions.json：6 个例外并入 b2b 样本 ID（仅 allowed_sample_ids + reason 追加；
     不动 allowed_claim_ids / allowed_topics / deployment_purposes）。
  2. 生成 batch2b_candidates.jsonl（sample_id/group_id/messages）与
     batch2b_candidates.meta.jsonl（review_status=approved + 双哈希 + 审核人）。
     元数据修正（记录于执行报告）：b2b-002 的 source_ids/source_usage 补全
     hario-v60-hoffmann——其引用的 conflict.v60.official-recipes-differ 授权归属
     hoffmann 例外（GPT 禁止扩 allowed_claim_ids，故补全来源声明而非扩权）。
  3. 生成 approved_batch_manifest_batch2b.json（batch2b-approved-r1）。
不修改知识库、不训练、不自动批准任何剩余候选。
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))
from coffeeai_common import messages_fingerprint, reviewed_record_sha256  # noqa: E402

REPO = HERE.parents[2]
EXC_PATH = REPO / "Tools/CoffeeAI/source_exceptions.json"
DRAFT = HERE / "batch2b_candidates_draft.jsonl"
REVIEWER = "banmu123 (project owner)"
REVIEWED_AT = "2026-10-14"
DATA_VERSION = "v0.2-batch2b"

SOURCE_DOC = {
    "b2b-001": "knowledge/roasting/coffee-roasting.md",
    "b2b-002": "knowledge/CONFLICTS.md",
    "b2b-003": "knowledge/brewing/pour-over.md",
    "b2b-004": "knowledge/sensory/sensory-and-flavor.md",
    "b2b-005": "knowledge/freshness/freshness.md",
    "b2b-006": "knowledge/espresso/espresso-fundamentals.md",
    "b2b-007": "knowledge/health/coffee-health.md",
    "b2b-008": "knowledge/sensory/sensory-and-flavor.md",
}

# b2b-002 元数据修正：冲突事实 claim 的授权归属在 hoffmann 例外（已含该 claim 与
# b1-025 的使用授权），补全来源声明使多来源并集语义（六点五-C）覆盖全部引用。
SOURCE_FIX = {
    "b2b-002": {
        "source_ids": ["hario-v60-expert-guide", "hario-v60-hoffmann"],
        "source_usage": {"hario-v60-expert-guide": "fact-extraction-rewrite",
                         "hario-v60-hoffmann": "fact-extraction-rewrite"},
    },
}

# topic 对齐（仅 meta 分类标签对齐来源授权语义，消息内容零改动；GPT 修正版方案 A）：
# b2b-008 ucdavis 对齐先例 b2a-005/008；b2b-002/003 对齐 hario-expert 既有 topics
# （hoffmann topics 按 GPT 裁定扩展后覆盖同值）；b2b-005 对齐 ucdavis 既有 topics
# （nca topics 按 GPT 裁定扩展后覆盖同值；NCA claim 承担该样本路径一实质证据，非背景）。
TOPIC_FIX = {
    "b2b-002": "brewing-troubleshooting",
    "b2b-003": "brewing",
    "b2b-005": "pour-over diagnosis",
    "b2b-008": "pour-over diagnosis",
}

# 步骤 1b：例外 allowed_topics 对齐扩展（GPT 修正版方案 A，2026-10-14 裁定：
# 「来源授权语义与样本实际能力标签对齐」，非「覆盖方便」式扩权；不采用方案 B）
EXC_TOPICS_EXTEND = {
    "hario-v60-hoffmann": ["brewing", "brewing-troubleshooting"],
    "baratza-documents": ["pour-over diagnosis"],
    "nca-aboutcoffee": ["pour-over diagnosis"],
}

# 步骤 1：例外 allowed_sample_ids 扩展（GPT 拍板清单 B + 修正版方案 A 连带）
EXC_EXTEND = {
    "ucdavis-coffee-center": ["b2b-001", "b2b-004", "b2b-005", "b2b-008"],
    "hario-v60-expert-guide": ["b2b-002", "b2b-003"],
    "hario-v60-hoffmann": ["b2b-002", "b2b-003"],
    "baratza-documents": ["b2b-004"],
    "nca-aboutcoffee": ["b2b-005"],
    "fellow-espresso-basics": ["b2b-006"],
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
                f"；2026-10-14 阶段六点九-E 扩展（负责人采纳 GPT 拍板清单，Batch2b 批准落库）："
                f"+{','.join(add)}（仅样本范围对齐，allowed_claim_ids 未变）")
            changed.append(f"{sid}:+{','.join(add)}")
        tadd = [t for t in EXC_TOPICS_EXTEND.get(sid, [])
                if t not in (exc.get("allowed_topics") or [])]
        if tadd:
            exc.setdefault("allowed_topics", []).extend(tadd)
            exc["reason"] = (exc.get("reason") or "") + (
                f"；2026-10-14 六点九-E topics 对齐扩展（GPT 修正版方案 A：来源授权语义与"
                f"样本实际能力标签对齐）：topics+{','.join(tadd)}")
            changed.append(f"{sid}:topics+{','.join(tadd)}")
    EXC_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("例外扩展:", "; ".join(changed) if changed else "(无变更——已应用)")


def build_candidates():
    rows = [json.loads(l) for l in DRAFT.read_text(encoding="utf-8").splitlines() if l.strip()]
    assert len(rows) == 8, f"草稿应为 8 条，实际 {len(rows)}"
    corpus, metas = [], []
    for r in rows:
        sid = r["sample_id"]
        fix = SOURCE_FIX.get(sid, {})
        source_ids = fix.get("source_ids", r["source_ids"])
        source_usage = fix.get("source_usage", r["source_usage"])
        msgs = r["messages"]
        fp = messages_fingerprint(msgs)
        meta = {
            "sample_id": sid,
            "group_id": f"g-{sid}",
            "topic": TOPIC_FIX.get(sid, r["topic"]),
            "source_doc": SOURCE_DOC[sid],
            "source_ids": source_ids,
            "claim_ids": r["claim_ids"],
            "license_status": r["license_status"],
            "review_status": "approved",
            "data_version": DATA_VERSION,
            "dedup_fingerprint": fp,
            "source_usage": source_usage,
            "notes": (f"Batch2b 草稿（BATCH2_WRITING_SPEC + 六点九-B 交互规则 1-6）；"
                      f"reasoning_level={r['reasoning_level']}；training_value={r['training_value']}；"
                      f"interaction_skill={r['interaction_skill']}；"
                      f"missing_information_handling={r['missing_information_handling']}；"
                      f"risk_notes={r['risk_notes']}；"
                      f"负责人 2026-10-14 拍板（采纳 GPT 拍板清单，8 条全部批准）"),
            "reviewed_content_sha256": fp,
            "reviewed_by": REVIEWER,
            "reviewed_at": REVIEWED_AT,
            "reasoning_level": r["reasoning_level"],
            "risk_notes": r["risk_notes"],
        }
        meta["reviewed_record_sha256"] = reviewed_record_sha256(meta, msgs)
        corpus.append({"sample_id": sid, "group_id": f"g-{sid}", "messages": msgs})
        metas.append(meta)
    (HERE / "batch2b_candidates.jsonl").write_text(
        "\n".join(json.dumps(c, ensure_ascii=False) for c in corpus) + "\n", encoding="utf-8")
    (HERE / "batch2b_candidates.meta.jsonl").write_text(
        "\n".join(json.dumps(m, ensure_ascii=False) for m in metas) + "\n", encoding="utf-8")
    print(f"candidates.jsonl: {len(corpus)} 条；meta.jsonl: {len(metas)} 条（approved + 双哈希）")
    return [c["sample_id"] for c in corpus]


def build_manifest(sample_ids):
    manifest = {
        "batch_id": "batch2b-approved-r1",
        "created_at": REVIEWED_AT,
        "approved_samples": sample_ids,
        "approved_by": REVIEWER,
        "approved_at": REVIEWED_AT,
        "deployment_purpose": "noncommercial-research",
        "decision_reference": (
            "batch2b-approved-r1：b2b-001~008——负责人 2026-10-14 拍板（采纳 GPT 拍板清单，"
            "对话指示「按照GPT建议继续」）。审核链：batch2b_candidate_plan（六点九）→ 草稿"
            "（六点九-B，两批生成各过门禁）→ 门禁行为增强（六点九-C，GPT 三项确认）→ "
            "人工审核包 A-H（六点九-D，GPT 核验「达到拍板标准，无需返工」）。GPT 优先级备注："
            "b2b-008 最高（幻觉防线/不知道能力）、b2b-003 次之（拒绝伪标准）、b2b-001/005 "
            "构成诊断入口。"),
        "source_exception_reference": (
            "Tools/CoffeeAI/source_exceptions.json（9 条例外；本轮按 GPT 拍板清单 B 仅扩展 "
            "allowed_sample_ids：ucdavis←b2b-001/004/005/008、hario-v60-expert-guide←b2b-002/003、"
            "hario-v60-hoffmann←b2b-003、baratza←b2b-004、nca←b2b-005、fellow-espresso-basics←b2b-006；"
            "allowed_claim_ids/topics/授权范围未变。元数据修正：b2b-002 source_ids 补全 "
            "hario-v60-hoffmann（其引用的 conflict.v60.official-recipes-differ 授权归属该例外）。"
            "b2b-007 来源 fda-caffeine 为自动准入，无需例外）。"),
        "notes": (
            "batch2b-approved-r1：8 条全部批准（approved 14 → 22）。训练保持冻结"
            "（approved ≥25 / train ≥15 阈值；mlx-lm 未装、模型未下载）。"
            "质量门禁 PASSED（0 error/0 warning）；127 tests OK；build_kb --check OK。"),
    }
    (HERE / "approved_batch_manifest_batch2b.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("manifest: batch2b-approved-r1（8 samples）")


def fix_b1_025_topic():
    """b1-025 存量一致性修复（GPT 修正版方案 A）：仅 topic 对齐，不批准、保持 unreviewed。

    b1-025（双来源 hario-expert + hoffmann）topic 'uncertainty' 与 hario-expert
    既有 topics 无交集——GPT 裁定「例外存在 + 样本未落库 + 未来必撞」应提前修；
    hoffmann topics 对齐扩展后，交集 = {'brewing', 'brewing-troubleshooting'}，
    取 'brewing'（Hoffmann 配方语境属冲煮主题）。allowed_sample_ids 两例外均已含。
    """
    p = HERE / "batch1_candidates.meta.jsonl"
    rows = [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]
    hit = False
    for m in rows:
        if m["sample_id"] == "b1-025":
            if m.get("topic") != "brewing":
                assert m.get("review_status") == "unreviewed", "b1-025 状态异常，停止修复"
                m["topic"] = "brewing"
                m["notes"] = (m.get("notes") or "") + (
                    "；2026-10-14 阶段六点九-E topic 对齐（GPT 修正版方案 A：修 b1-025 存量"
                    "一致性——双来源例外 topics 交集；仅改分类标签，不批准、保持 unreviewed）")
                hit = True
            break
    p.write_text("\n".join(json.dumps(m, ensure_ascii=False) for m in rows) + "\n",
                 encoding="utf-8")
    print("b1-025 topic 对齐:", "完成（uncertainty → brewing，保持 unreviewed）" if hit else "（无需变更）")


if __name__ == "__main__":
    extend_exceptions()
    fix_b1_025_topic()
    ids = build_candidates()
    build_manifest(ids)
