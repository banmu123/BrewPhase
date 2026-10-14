#!/usr/bin/env python3
"""check_candidate_quality.py — Batch2 候选写作质量门禁（阶段六点三，只读）。

检查维度：
  1. 术语冻结扫描：avoid 词（来自 knowledge/_method/translation_decisions.json）命中
     → error（输出 sample_id / 原句 / 推荐替代表达）；解释性提及（如「俗称发涩」）豁免。
  2. F/P/I 表达检查：reasoning_level 声明 F 时必须非空 claim_ids；声明 I 时回答必须
     含限定词；F 层句子出现推断词 → warning 提醒（不自动改）。
  3. 诊断链检查：诊断类主题的回答须含验证/观察/对比/排查语义 → 缺失 warning。
  4. 数字风险扫描：回答含数字+单位/比例时，须有 claim_ids 支撑与适用范围说明。

阶段六点九-C 新增（Batch2b 行为能力检查，GPT 指定）：
  5. missing_information_check：interaction_skill 属追问/不确定性/诊断类的样本，
     回答必须含「还需要知道」或等价信息收集段 → 缺失 error。
  6. direct_parameter_answer_check：用户请求参数而回答缺来源语境/条件限制/多方案
     → error（阻止唯一参数答案）。
  7. next_step_recommendation_check：诊断类回答缺下一步行动建议 → warning。
  8. uncertainty_expression_check：uncertainty_handling 样本必须含「当前信息不足」
     等限定表达 → 缺失 error。
  9. health_boundary_check：健康类回答必须含非医疗建议边界声明 → 缺失 error。
  10. strong_claim_context_check：强断言词（黄金参数/最佳比例/一定/必然/唯一原因等）
     肯定句式推荐 → error；否定/纠偏语境 → pass（在 --json 输出 contexts 供人工复查，
     避免每次人工解释）。

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

# ---- 阶段六点九-C：行为能力检查常量 ----
# 追问类 interaction_skill（GPT 规则 1：clarification / uncertainty / diagnosis 类）
ASKING_SKILLS = {"clarification", "uncertainty_handling",
                 "multi_variable_reasoning", "condition_based_advice"}
INFO_COLLECT_MARKERS = ["还需要知道", "需要知道", "还需要了解", "需要更多", "请提供",
                        "请补充", "请说明", "请确认", "告诉我", "需要哪些信息",
                        "需要什么信息", "把上面几项信息补齐"]
# 用户参数请求信号（GPT 规则 2：推荐比例/参数多少/时间多少/温度多少类场景）
PARAM_REQUEST_PATTERN = re.compile(
    r"黄金比例|黄金参数|最佳参数|最佳比例|参数多少|比例多少|温度多少|时间多少|"
    r"多少度|多少克|多少秒|几度|几克|推荐比例|推荐参数|推荐配方|推荐温度|推荐时间|卡在")
# 回答侧的语境/条件/多方案标记（有其一即不算唯一参数答案）
PARAM_CONTEXT_MARKERS = ["官方", "指南", "署名", "作者", "来源", "语境", "条件限制",
                         "适用", "取决于", "因豆而异", "因人而异", "起点", "不是唯一",
                         "并非", "不同豆", "多方案", "两个起点", "没有一条",
                         "没有适用于", "不存在唯一", "不同渠道"]
# 下一步行动建议标记（GPT 规则 3）
NEXT_STEP_MARKERS = ["建议的下一步", "下一步", "可以尝试", "可以先", "建议你", "建议从",
                     "再决定", "记录", "行动", "建议每次", "建议先", "验证方法", "排查"]
# 不确定性限定表达（GPT 规则 4）
UNCERTAINTY_MARKERS = ["当前信息不足", "信息不足", "需要更多信息", "还需要更多",
                       "无法判断唯一原因", "无法判断", "当前无法", "需要进一步确认",
                       "尚未核验", "尚无对应", "不能判断唯一"]
# 健康边界声明标记（GPT case5）
HEALTH_MARKERS = ["不构成医疗建议", "非医疗建议", "咨询医疗", "医疗人员", "医生", "就医"]
# 强断言词（GPT 规则 5：扩展扫描；长词在前避免重叠命中）
STRONG_CLAIM_WORDS = ["一定是", "肯定是", "唯一原因", "一定有效", "黄金参数", "黄金比例",
                      "最佳参数", "最佳比例", "必然", "永远", "一定"]
# 否定/纠偏语境标记（命中词前缀窗口内出现 → pass）
NEGATION_MARKERS = ["没有", "不是", "不存在", "无法", "并非", "未必", "拒绝", "禁止",
                    "不得", "不要", "避免", "无需", "谈不上", "不构成", "别", "没",
                    "无", "莫", "勿", "不宜", "不", "未"]
# 肯定句式推荐伪标准（无论前缀一律阻断——「黄金参数是 1:16」式表达）
ASSERTION_PATTERN = re.compile(r"(黄金参数|黄金比例|最佳参数|最佳比例)是|推荐[^。]{0,8}(黄金|最佳)")


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


def _skill(d):
    return str(d.get("interaction_skill") or "").strip()


def check_missing_information(d, assistant_text, issues):
    """六点九-C 规则 1：追问/不确定性/诊断类样本必须含信息收集段。"""
    skill = _skill(d)
    if not skill:
        return  # Batch2a 及更早样本无 interaction_skill 字段，不适用
    if not (skill in ASKING_SKILLS or skill.startswith("uncertainty")
            or skill.startswith("missing_information")):
        return
    if not any(m in assistant_text for m in INFO_COLLECT_MARKERS):
        issues.append({"level": "error", "code": "missing-information-collection",
                       "sample_id": d.get("sample_id"),
                       "message": f"interaction_skill={skill} 的样本必须包含"
                                  "「还需要知道」或等价信息收集段——追问能力是本批训练核心"})


def check_direct_parameter(d, user_text, assistant_text, issues):
    """六点九-C 规则 2：用户请求参数时不得直接输出唯一参数答案。"""
    if not PARAM_REQUEST_PATTERN.search(user_text):
        return
    if not any(m in assistant_text for m in PARAM_CONTEXT_MARKERS):
        issues.append({"level": "error", "code": "direct-parameter-answer",
                       "sample_id": d.get("sample_id"),
                       "message": "用户请求参数，但回答缺少来源语境/条件限制/多方案比较"
                                  "——禁止直接输出唯一参数答案"})


def check_next_step(d, assistant_text, issues):
    """六点九-C 规则 3：诊断类回答必须含下一步行动建议（缺失 warning）。"""
    topic = str(d.get("topic") or "")
    if topic not in DIAGNOSTIC_TOPICS:
        return
    if not any(m in assistant_text for m in NEXT_STEP_MARKERS):
        issues.append({"level": "warning", "code": "next-step-missing",
                       "sample_id": d.get("sample_id"),
                       "message": "诊断类回答只解释原因、缺少下一步行动建议"
                                  "（行为质量：应给出可执行的验证/调整动作）"})


def check_uncertainty_expression(d, assistant_text, issues):
    """六点九-C 规则 4：uncertainty_handling 样本必须含限定表达。"""
    skill = _skill(d)
    if not (skill == "uncertainty_handling" or skill.startswith("uncertainty")
            or skill.startswith("missing_information")):
        return
    if not any(m in assistant_text for m in UNCERTAINTY_MARKERS):
        issues.append({"level": "error", "code": "uncertainty-expression-missing",
                       "sample_id": d.get("sample_id"),
                       "message": f"interaction_skill={skill} 的样本必须包含"
                                  "「当前信息不足/需要更多信息/无法判断唯一原因」等限定表达"})


def check_health_boundary(d, assistant_text, issues):
    """六点九-C 规则 5（GPT case5）：健康类回答必须含非医疗建议边界。"""
    if str(d.get("topic") or "") != "health":
        return
    if not any(m in assistant_text for m in HEALTH_MARKERS):
        issues.append({"level": "error", "code": "health-boundary-missing",
                       "sample_id": d.get("sample_id"),
                       "message": "健康类回答必须包含非医疗建议边界声明"
                                  "（参考信息 + 个体差异 + 咨询医疗人员指引）"})


def check_strong_claims(d, assistant_text, issues):
    """六点九-C 规则 6：strong_claim_context_check——强断言词扫描 + 语境判定。

    肯定句式推荐伪标准（「黄金参数是 1:16」）→ error；
    否定/纠偏语境（「没有……黄金参数」「无法判断唯一原因」）→ pass；
    无语境限定 → warning（交人工确认）。全部命中输出 contexts 供复查。
    只扫 assistant 文本——用户口语不算模型输出。
    """
    sid = d.get("sample_id")
    spans = []
    for w in STRONG_CLAIM_WORDS:
        start = 0
        while True:
            p = assistant_text.find(w, start)
            if p < 0:
                break
            spans.append((p, p + len(w), w))
            start = p + len(w)
    spans.sort()
    merged, last_end = [], -1
    for s, e, w in spans:
        if s >= last_end:
            merged.append((s, e, w))
            last_end = e
    contexts = []
    for s, e, w in merged:
        prefix = assistant_text[max(0, s - 24):s]
        window = assistant_text[max(0, s - 24):min(len(assistant_text), e + 10)].replace("\n", " ")
        assertion = bool(ASSERTION_PATTERN.search(assistant_text[s:min(len(assistant_text), e + 8)]))
        if assertion:
            issues.append({"level": "error", "code": "strong-claim-assertion",
                           "sample_id": sid,
                           "message": f"肯定句式推荐伪标准「{w}」——必须拒绝唯一答案框架；"
                                      f"原句：…{window}…"})
            contexts.append({"keyword": w, "context": window, "severity": "error",
                             "verdict": "assertion"})
        elif any(neg in prefix for neg in NEGATION_MARKERS):
            contexts.append({"keyword": w, "context": window, "severity": "pass",
                             "verdict": "negation-context"})
        else:
            issues.append({"level": "warning", "code": "fact-impersonation-risk",
                           "sample_id": sid,
                           "message": f"回答出现强断言词「{w}」且未识别到否定/纠偏语境"
                                      f"——请人工确认是否为 I 层伪装 F；原句：…{window}…"})
            contexts.append({"keyword": w, "context": window, "severity": "warning",
                             "verdict": "unqualified"})
    return contexts


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
        user_text = " ".join(m["content"] for m in d.get("messages", [])
                             if m.get("role") == "user")
        assistant_text = " ".join(m["content"] for m in d.get("messages", [])
                                  if m.get("role") == "assistant")
        text = user_text + " " + assistant_text
        check_terms(text, issues, sid)
        check_fpi(d, text, issues)
        check_diag_chain(d, text, issues)
        check_numeric(d, text, issues)
        # 阶段六点九-C：Batch2b 行为能力检查
        contexts = check_strong_claims(d, assistant_text, issues)
        check_missing_information(d, assistant_text, issues)
        check_direct_parameter(d, user_text, assistant_text, issues)
        check_next_step(d, assistant_text, issues)
        check_uncertainty_expression(d, assistant_text, issues)
        check_health_boundary(d, assistant_text, issues)
        sample_out = {"sample_id": sid,
                      "issues": [{"level": i["level"], "code": i["code"],
                                  "message": i["message"]} for i in issues]}
        if contexts:
            sample_out["strong_claim_contexts"] = contexts
        samples.append(sample_out)
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
