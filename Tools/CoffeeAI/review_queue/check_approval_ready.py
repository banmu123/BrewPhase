#!/usr/bin/env python3
"""check_approval_ready.py — Approved 落库前 dry-run 校验（阶段五点六）。

只读校验，禁止任何修复或状态修改：
  1. manifest 字段完整性（batch_id/approved_by/approved_at/deployment_purpose…）
  2. 每个 approved 样本：candidate/meta 存在、review_status=approved、
     reviewed_content_sha256 / reviewed_record_sha256 与实际内容重算一致
  3. 来源准入：样本引用的每个 sourceId 自动准入或存在有效例外（含部署用途判定）
  4. unresolved issue 提示（admission proposal 中该样本的 evidence_status）

用法：
  python3 check_approval_ready.py --manifest approved_batch_manifest.json [--json]
退出码：0 = 全部 ready；1 = 存在阻断项（详见输出）。
"""
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))

from coffeeai_common import (  # noqa: E402
    KNOWN_DEPLOYMENT_PURPOSES, REVIEW_APPROVED, load_registry,
    load_source_exceptions, messages_fingerprint, reviewed_record_sha256,
    source_admission_issues,
)


def load_jsonl(p):
    rows = {}
    if not Path(p).is_file():
        return rows
    for line in Path(p).read_text(encoding="utf-8").splitlines():
        if line.strip():
            d = json.loads(line)
            rows[d.get("sample_id")] = d
    return rows


def main():
    ap = argparse.ArgumentParser(description="Approved 落库前 dry-run 校验（只读）")
    ap.add_argument("--manifest", required=True, help="approved manifest JSON 路径")
    ap.add_argument("--corpus", default=None,
                    help="候选 corpus jsonl 路径（默认 review_queue/batch1_candidates.jsonl；"
                         "Batch2a 用 review_queue/batch2a_candidates.jsonl）")
    ap.add_argument("--meta", default=None,
                    help="候选 meta jsonl 路径（默认 review_queue/batch1_candidates.meta.jsonl）")
    ap.add_argument("--registry", default=None, help="SOURCE_REGISTRY.json 路径（默认正式注册表）")
    ap.add_argument("--json", action="store_true", help="JSON 输出")
    args = ap.parse_args()

    issues, checked = [], 0
    mpath = Path(args.manifest)
    if not mpath.is_file():
        print(f"[error] manifest 不存在: {mpath}")
        sys.exit(1)
    m = json.loads(mpath.read_text(encoding="utf-8"))

    # ---- 1) manifest 完整性
    for field in ("batch_id", "approved_by", "approved_at", "deployment_purpose"):
        if not str(m.get(field) or "").strip():
            issues.append({"level": "error", "code": "manifest-field-missing",
                           "message": f"manifest.{field} 未填写（不得使用模板空值）"})
    if m.get("deployment_purpose") and m["deployment_purpose"] not in KNOWN_DEPLOYMENT_PURPOSES:
        issues.append({"level": "error", "code": "manifest-purpose-invalid",
                       "message": f"deployment_purpose 非法: {m.get('deployment_purpose')!r}"})
    samples = m.get("approved_samples")
    if not isinstance(samples, list) or not samples:
        issues.append({"level": "error", "code": "manifest-samples-empty",
                       "message": "approved_samples 为空——没有可校验的样本"})

    registry = load_registry(args.registry) if args.registry else load_registry()
    exceptions, exc_rejected = load_source_exceptions()
    for r in exc_rejected:
        issues.append({"level": "warning", "code": "exception-invalid",
                       "message": f"例外条目无效（未生效）: {r.get('sourceId')}: {r['reason']}"})

    corpus_path = Path(args.corpus) if args.corpus else HERE / "batch1_candidates.jsonl"
    meta_path = Path(args.meta) if args.meta else HERE / "batch1_candidates.meta.jsonl"
    candidates = load_jsonl(corpus_path)
    metas = load_jsonl(meta_path)

    # ---- 2/3/4) 逐样本校验
    for sid in samples or []:
        checked += 1
        c = candidates.get(sid)
        meta = metas.get(sid)
        if c is None or meta is None:
            issues.append({"level": "error", "code": "sample-missing",
                           "sample_id": sid,
                           "message": f"{sid}: 候选或元数据不存在于指定队列（{corpus_path.name}）"})
            continue
        if meta.get("review_status") != REVIEW_APPROVED:
            issues.append({"level": "error", "code": "not-yet-approved",
                           "sample_id": sid,
                           "message": f"{sid}: review_status={meta.get('review_status')!r}，"
                                      f"须先完成人工批准步骤（approval_execution_template.md 第 6 步）"})
        msgs = c.get("messages")
        if not isinstance(msgs, list):
            issues.append({"level": "error", "code": "messages-unreadable",
                           "sample_id": sid, "message": f"{sid}: messages 不可读"})
            continue
        # 内容指纹
        fp = messages_fingerprint(msgs)
        if meta.get("reviewed_content_sha256") != fp:
            issues.append({"level": "error", "code": "reviewed-content-mismatch",
                           "sample_id": sid,
                           "message": f"{sid}: reviewed_content_sha256 与实际 messages 不一致"
                                      "（须人工重审后显式更新）"})
        # 审核记录指纹
        fp_rec = reviewed_record_sha256(meta, msgs)
        if meta.get("reviewed_record_sha256") != fp_rec:
            issues.append({"level": "error", "code": "reviewed-record-mismatch",
                           "sample_id": sid,
                           "message": f"{sid}: reviewed_record_sha256 与当前记录不一致"
                                      "（messages 或准入元数据在审核后被动过）"})
        # 审核人
        if not str(meta.get("reviewed_by") or "").strip():
            issues.append({"level": "error", "code": "reviewer-missing",
                           "sample_id": sid,
                           "message": f"{sid}: meta 缺少 reviewed_by（审批人必须实名）"})
        # 来源准入
        purpose = m.get("deployment_purpose") if m.get("deployment_purpose") in KNOWN_DEPLOYMENT_PURPOSES else None
        src_issues = source_admission_issues(
            meta.get("source_ids") or [], registry or {}, meta.get("source_usage"),
            exceptions=exceptions, deployment_purpose=purpose,
            sample={"sample_id": sid, "topic": meta.get("topic"),
                    "claim_ids": meta.get("claim_ids") or []})
        for si in src_issues:
            issues.append({"level": "error", "code": si["code"],
                           "sample_id": sid, "message": f"{sid}: {si['message']}"})

    ready = not any(i["level"] == "error" for i in issues)
    report = {"manifest": str(mpath), "checked": checked, "ready": ready,
              "errors": sum(1 for i in issues if i["level"] == "error"),
              "warnings": sum(1 for i in issues if i["level"] == "warning"),
              "issues": issues,
              "note": "本脚本只读；不做任何修复、不修改 review_status、不写入任何文件。"}
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=1))
    else:
        print("=" * 66)
        print(f"Approved 落库 dry-run：{'READY' if ready else 'NOT READY'}"
              f"（checked={checked}, errors={report['errors']}, warnings={report['warnings']}）")
        for i in issues:
            print(f"  [{i['level'].upper():7}] {i['code']}: {i['message']}")
        if ready and checked:
            print("全部通过——可进入 split_dataset 划分流程（仍需人工执行）。")
    sys.exit(0 if ready else 1)


if __name__ == "__main__":
    main()
