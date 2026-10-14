#!/usr/bin/env python3
"""run_source_admission_b2b.py — 六点九-D 审核包 D 节：8 条 Batch2b 草稿来源准入检查（只读）。"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))
from coffeeai_common import source_admission_issues, load_registry  # noqa: E402

REPO = HERE.parents[2]
reg = load_registry(REPO / "knowledge/SOURCE_REGISTRY.json")
exc_data = json.loads((REPO / "Tools/CoffeeAI/source_exceptions.json").read_text())
exc_list = exc_data.get("exceptions", exc_data if isinstance(exc_data, list) else [])
exceptions = {e["sourceId"]: e for e in exc_list}

out = {}
rows = [json.loads(l) for l in (HERE / "batch2b_candidates_draft.jsonl").read_text().splitlines() if l.strip()]
for r in rows:
    issues = source_admission_issues(
        r["source_ids"], reg, r.get("source_usage"), exceptions=exceptions,
        deployment_purpose="noncommercial-research",
        sample={"sample_id": r["sample_id"], "topic": r["topic"], "claim_ids": r["claim_ids"]})
    verdict = "PASS" if not issues else "BLOCK"
    out[r["sample_id"]] = {"verdict": verdict, "sources": r["source_ids"],
                           "issues": [{"code": i["code"], "message": i["message"]} for i in issues]}
    print(f"{r['sample_id']}: {verdict} sources={r['source_ids']}")
    for i in issues:
        print("   ", i["code"], ":", i["message"][:120])

(HERE / "_b2b_source_admission_result.json").write_text(
    json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print("saved _b2b_source_admission_result.json")
