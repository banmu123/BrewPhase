#!/usr/bin/env python3
"""check_candidate_quality.py — Batch2 候选写作质量门禁（阶段六点三，只读）。

检查维度：
  1. 术语冻结扫描：avoid 词（来自 knowledge/_method/translation_decisions.json）命中
     → error（输出 sample_id / 原句 / 推荐替代表达）；解释性提及（如「俗称发涩」）豁免。
  2. F/P/I 表达检查：reasoning_level 声明 F 时必须非空 claim_ids；声明 I 时回答必须
     含限定词；F 层句子出现推断词 → warning 提醒（不自动改）。
  3. 诊断链检查：诊断类主题的回答须含验证/观察/对比/排查语义 → 缺失 warning。
  4. 数字风险扫描：回答含数字+单位/比例时，须有 claim_ids 支撑与适用范围说明。

用法：
  python3 check_candidate_quality.py --input <draft.jsonl> [--json]
退出码：0 = passed（无 error）；1 = 存在 error。本脚本只读，不修改任何文件。
"""
import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]

DIAGNOSTIC_TOPICS = {"espresso", "brewing", "brewing-troubleshooting",
                     "pour-over diagnosis", "espresso-dial-in", "cold-brew",
                     "grinding", "cleaning-maintenance"}
DIAG_CHAIN_MARKERS = ["验证", "对比", "观察", "排查", "记录", "流速", "尝", "对比冲煮"]
INFERENCE_MARKERS = ["可能", "通常", "往往", "可以尝试", "推断", "尚未核验", "未核验",
                     "常识级", "方向性推断", "因豆而异"]
FACT_IMPERSONATION_MARKERS = ["必然", "一定是", "肯定是", "永远"]
SCOPE_MARKERS = ["取决于", "因豆而异", "因人而异", "语境", "适用", "不是唯一", "起点",
                 "大致", "约", "范围", "目标风味", "参考"]
NUMERIC_PATTERN = re.compile(r"\d+(?:\.\d+)?\s*(?:°C|℃|g|ml|mL|毫升|克|秒|分钟|min\b)|\d+\s*:\s*\d+")


def load_term_rules():
    """从 translation_decisions.json 构建避免词 → (推荐词, 理由) 映射。"""
    src = REPO / "knowledge" / "_method" / "translation_decisions.json"
    rules = []
    if not src.is_file():
        return rules
    data = json.loads(src.read_text(encoding="utf-8"))
    for d in data.get("decisions", []):
        avoids = d.get("avoid_translation") or []
        recs = d.get("recommended_translation") or []
        if avoids:
            rules.append({"term": d.get("term"), "context": d.get("coffee_context"),
                          "avoids": avoids, "recommended": recs,
                          "reason": d.get("reason", "")})
    return rules


def sentence_of(text, pos, span=45):
    return text[max(0, pos - span):pos + span].replace("\n", " ")


def check_terms(text, issues, sid):
    """avoid 词扫描；「俗称X」解释性上下文豁免。"""
    for rule in load_term_rules():
        for avoid in rule["avoids"]:
            start = 0
            while True:
                pos = text.find(avoid, start)
                if pos < 0:
                    break
                context = text[max(0, pos - 8):pos + len(avoid) + 8]
                if "俗称" in context or "原文" in context or "严格说" in context:
                    start = pos + len(avoid)
                    continue  # 解释性提及豁免
                issues.append({
                    "level": "error", "code": "term-freeze-violation",
                    "sample_id": sid,
                    "message": (f"出现 avoid 词「{avoid}」（术语 {rule['term']}，"
                                f"{rule['context']} 语境）→ 推荐用：{rule['recommended']}；"
                                f"原句：…{sentence_of(text, pos)}…；理由：{rule['reason'][:60]}"),
                })
                start = pos + len(avoid)


def check_fpi(d, text, issues):
    level = str(d.get("reasoning_level") or "")
    claims = d.get("claim_ids") or []
    if "F" in level and not claims:
        issues.append({"level": "error", "code": "f-without-claim",
                       "sample_id": d.get("sample_id"),
                       "message": "reasoning_level 声明含 F，但 claim_ids 为空——"
                                  "source-backed fact 必须可回溯 claim"})
    if "I" in level:
        if not any(m in text for m in INFERENCE_MARKERS):
            issues.append({"level": "error", "code": "i-without-qualifier",
                           "sample_id": d.get("sample_id"),
                           "message": "reasoning_level 声明含 I，但回答未发现限定词"
                                      f"（{'/'.join(INFERENCE_MARKERS[:6])}…）——推断不得写成事实"})
    for m in FACT_IMPERSONATION_MARKERS:
        if m in text:
            issues.append({"level": "warning", "code": "fact-impersonation-risk",
                           "sample_id": d.get("sample_id"),
                           "message": f"回答出现强断言词「{m}」——请人工确认是否为 I 层伪装 F"})


def check_diag_chain(d, text, issues):
    topic = str(d.get("topic") or "")
    if topic not in DIAGNOSTIC_TOPICS:
        return
    if not any(m in text for m in DIAG_CHAIN_MARKERS):
        issues.append({"level": "warning", "code": "diagnostic-chain-incomplete",
                       "sample_id": d.get("sample_id"),
                       "message": f"诊断类主题（{topic}）回答未发现验证/观察/对比/排查类步骤"
                                  "——诊断链「现象→原因→验证→调整」可能不完整"})


def check_numeric(d, text, issues):
    if not NUMERIC_PATTERN.search(text):
        return
    sid = d.get("sample_id")
    if not (d.get("claim_ids") or []):
        issues.append({"level": "error", "code": "numeric-claim-missing-context",
                       "sample_id": sid,
                       "message": "回答含数字/单位，但 claim_ids 为空——数字必须有可回溯来源"})
    elif not any(m in text for m in SCOPE_MARKERS):
        issues.append({"level": "warning", "code": "numeric-scope-missing",
                       "sample_id": sid,
                       "message": "回答含数字但未发现适用范围说明"
                                  f"（{'/'.join(SCOPE_MARKERS[:6])}…）——数字不得表达唯一答案"})


def main():
    ap = argparse.ArgumentParser(description="Batch2 候选写作质量门禁（只读）")
    ap.add_argument("--input", required=True, help="候选草稿 JSONL")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    in_path = Path(args.input)
    if not in_path.is_file():
        print(f"[error] 输入不存在: {in_path}")
        sys.exit(1)
    rows = [json.loads(l) for l in in_path.read_text(encoding="utf-8").splitlines() if l.strip()]

    samples, all_issues = [], []
    for d in rows:
        sid = d.get("sample_id")
        issues = []
        text = " ".join(m["content"] for m in d.get("messages", []) if m.get("role") != "system")
        check_terms(text, issues, sid)
        check_fpi(d, text, issues)
        check_diag_chain(d, text, issues)
        check_numeric(d, text, issues)
        samples.append({"sample_id": sid,
                        "issues": [{"level": i["level"], "code": i["code"],
                                    "message": i["message"]} for i in issues]})
        all_issues.extend(issues)

    errors = [i for i in all_issues if i["level"] == "error"]
    warnings = [i for i in all_issues if i["level"] == "warning"]
    report = {"input": str(in_path), "checked": len(rows), "passed": not errors,
              "errors": len(errors), "warnings": len(warnings), "samples": samples,
              "note": "只读质量门禁；不修改任何文件、不改变审核状态。"}
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=1))
    else:
        print("=" * 66)
        print(f"候选质量门禁：{'PASSED' if report['passed'] else 'FAILED'}"
              f"（checked={len(rows)}, errors={len(errors)}, warnings={len(warnings)}）")
        for i in all_issues:
            print(f"  [{i['level'].upper():7}] {i['code']} [{i['sample_id']}]: {i['message']}")
    sys.exit(0 if report["passed"] else 1)


if __name__ == "__main__":
    main()
