#!/usr/bin/env python3
"""coffeeai_common.py — CommitBrew Coffee AI 共享工具库。

被 validate_data.py / split_dataset.py / run_train.py / evaluate.py / env_check.py 复用。
只依赖 Python 标准库（3.9+）。
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from datetime import date
from difflib import SequenceMatcher
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
COFFEEAI_ROOT = SCRIPTS_DIR.parent
REPO_ROOT = COFFEEAI_ROOT.parent.parent

DEFAULT_CORPUS_GLOB = "data/corpus/*.jsonl"
DEFAULT_META_GLOB = "data/meta/*.jsonl"
DEFAULT_REGISTRY = REPO_ROOT / "knowledge" / "SOURCE_REGISTRY.json"

VALID_ROLES = {"system", "user", "assistant"}

# 训练许可白名单：来源明确允许复制/改编，或为本项目原创。
LICENSES_ALLOW_TRAIN = {
    "approved", "ok", "public-domain", "cc-by", "cc-by-sa", "own-original",
}
# 训练黑名单：许可不明、受限、付费墙、NC-ND 等禁止改编/商用的许可。
LICENSES_BLOCK_TRAIN = {
    "unknown", "restricted", "paywalled", "proprietary", "see-source-terms",
    "cc-by-nc", "cc-by-nc-nd", "cc-by-nc-sa",
}
REVIEW_APPROVED = "approved"
VALID_REVIEW_STATUS = {"approved", "unreviewed", "needs-review", "rejected"}

# ---------------------------------------------------------------- 来源级训练准入政策（阶段三/四）
# 项目来源政策（代码严格执行，非法律意见）——默认拒绝：
#   自动准入（无需人工例外）须同时满足：
#     status == active 且 license.status == public-domain
#     且 commercialUse == allowed 且 derivatives == allowed
#   以下一律阻断（人工例外也不能放行）：
#     status ∈ {pending-verification, restricted, paywalled}
#     或 license.status ∈ {unknown, proprietary-paywalled}
#   其余（see-source-terms / proprietary-free / cc-by-nc-nd / partial /
#   commercialUse 或 derivatives 为 unclear 或 not-allowed 等）
#   → 必须在 source_exceptions.json 登记有效人工例外。
# 有效人工例外要求：usage=fact-extraction-rewrite、approved_by / approved_at /
#   scope 非空、未过期（valid_until）。缺任何一项即视为无效（fail-closed）。
SOURCE_STATUS_BLOCKED = {"pending-verification", "restricted", "paywalled"}
SOURCE_LICENSE_BLOCKED = {"unknown", "proprietary-paywalled"}
ALLOWED_SOURCE_USAGE = {"fact-extraction-rewrite"}  # 外部来源唯一允许的用法
SOURCE_EXCEPTIONS_FILE = COFFEEAI_ROOT / "source_exceptions.json"
# 部署用途（训练准入必须显式声明其一；内部审批不能冒充外部授权）
KNOWN_DEPLOYMENT_PURPOSES = {"noncommercial-research", "commercial-product"}
# 商业用途依赖许可方授权的许可状态（not-allowed/unclear/缺失均视为需要外部授权）
EXTERNAL_GRANT_REQUIRED_LICENSES = {"not-allowed", "unclear"}
# 例外审批日期的合理下限（项目与注册表均晚于此日期；更早视为「日期不合理」）
MIN_REASONABLE_APPROVAL_DATE = date(2020, 1, 1)
EXTERNAL_SOURCE_POLICY = (
    "来源政策（默认拒绝）：仅 public-domain 且 commercialUse/derivatives 均 allowed "
    "的 active 来源可自动用于「事实提取+独立改写」；其余来源必须先在 "
    "Tools/CoffeeAI/source_exceptions.json 登记有效人工例外——字段完整（reason/"
    "approved_by/approved_at/scope/license_basis）、范围结构化（allowed_sample_ids/"
    "allowed_topics/allowed_claim_ids 至少一项）、部署用途显式（noncommercial-research "
    "或 commercial-product）。内部审批不等于外部授权：对 commercialUse/derivatives "
    "not-allowed 或 unclear 的来源做商业用途，必须登记 licensor-grant 及可追溯证据。"
    "本检查执行项目自身政策，不构成法律意见。"
)


def _parse_iso_date(value):
    """严格 ISO 日期解析（YYYY-MM-DD）。返回 date 或 None。"""
    try:
        d = date.fromisoformat(str(value))
        # fromisoformat 在某些版本接受非零填充；强制回写校验格式
        if d.isoformat() != str(value).strip():
            return None
        return d
    except (ValueError, TypeError):
        return None


def _valid_string_list(value):
    return (isinstance(value, list) and len(value) > 0
            and all(isinstance(x, str) and x.strip() for x in value))


def load_source_exceptions(path=None, today=None):
    """读取并校验人工例外登记。返回 (有效例外 dict, 被拒条目 list)。

    阶段四点五：字段与范围全面校验，任何一项不满足即整条无效（fail-closed）：
      sourceId / usage=fact-extraction-rewrite / reason 非空 / approved_by 非空 /
      approved_at 为合理 ISO 日期（非未来、>= 2020-01-01）/ scope 非空 /
      deployment_purposes ⊆ KNOWN_DEPLOYMENT_PURPOSES 且非空 /
      范围限定器 allowed_sample_ids|allowed_topics|allowed_claim_ids 至少一项非空 /
      license_basis = {basis, evidence_ref} 均非空 / valid_until（可选）未过期。
    """
    path = Path(path) if path else SOURCE_EXCEPTIONS_FILE
    valid, rejected = {}, []
    if not path.is_file():
        return {}, rejected
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}, [{"sourceId": None, "reason": "exceptions 文件不是合法 JSON"}]
    if not isinstance(data, dict) or not isinstance(data.get("exceptions", []), list):
        return {}, [{"sourceId": None, "reason": "exceptions 文件结构错误（缺 exceptions 数组）"}]
    for i, e in enumerate(data.get("exceptions", [])):
        sid = e.get("sourceId")
        why = None
        if not sid or not isinstance(sid, str):
            why = "缺少 sourceId"
        elif e.get("usage") not in ALLOWED_SOURCE_USAGE:
            why = f"usage 非法: {e.get('usage')!r}"
        elif not str(e.get("reason") or "").strip():
            why = "缺少 reason（准入理由）"
        elif not str(e.get("approved_by") or "").strip():
            why = "缺少 approved_by（人工审批人）"
        elif not str(e.get("scope") or "").strip():
            why = "缺少 scope（人类可读的适用范围说明）"
        elif not _valid_string_list(e.get("deployment_purposes")) or \
                not set(e["deployment_purposes"]) <= KNOWN_DEPLOYMENT_PURPOSES:
            why = (f"deployment_purposes 非法: {e.get('deployment_purposes')!r}"
                   f"（必须为 {sorted(KNOWN_DEPLOYMENT_PURPOSES)} 的非空子集）")
        elif not any(_valid_string_list(e.get(k)) for k in
                     ("allowed_sample_ids", "allowed_topics", "allowed_claim_ids")):
            why = "范围限定器缺失：allowed_sample_ids / allowed_topics / allowed_claim_ids 至少一项非空"
        lb = e.get("license_basis")
        if why is None and (not isinstance(lb, dict)
                            or not str(lb.get("basis") or "").strip()
                            or not str(lb.get("evidence_ref") or "").strip()):
            why = "license_basis 必须为 {basis, evidence_ref} 且均非空（许可依据与可追溯证据）"
        if why is None:
            approved_at = _parse_iso_date(e.get("approved_at"))
            if approved_at is None:
                why = f"approved_at 不是有效 ISO 日期: {e.get('approved_at')!r}"
            elif approved_at > (today or date.today()):
                why = f"approved_at 晚于今天（日期不合理）: {approved_at}"
            elif approved_at < MIN_REASONABLE_APPROVAL_DATE:
                why = f"approved_at 早于 {MIN_REASONABLE_APPROVAL_DATE}（日期不合理）"
        if why is None:
            vu = e.get("valid_until")
            if vu:
                vud = _parse_iso_date(vu)
                if vud is None:
                    why = f"valid_until 无法解析: {vu!r}"
                elif vud < (today or date.today()):
                    why = f"例外已于 {vu} 过期"
        if why:
            rejected.append({"sourceId": sid, "reason": why, "index": i})
        else:
            valid[sid] = e
    return valid, rejected


def source_auto_allow(info):
    """注册表条目是否满足自动准入（无需人工例外）。"""
    return (info.get("status") == "active"
            and info.get("license_status") == "public-domain"
            and info.get("commercialUse") == "allowed"
            and info.get("derivatives") == "allowed")


def check_exception_scope(exc, registry_info, sample, deployment_purpose):
    """阶段四点五：验证当前样本与训练用途是否落在例外批准的范围内。

    sample: {"sample_id", "topic", "claim_ids"}；deployment_purpose 为当前任务声明的用途。
    返回 (ok, reason)。
    """
    sid = exc.get("sourceId")
    # 1) 部署用途必须显式且被批准
    if deployment_purpose not in KNOWN_DEPLOYMENT_PURPOSES:
        return False, (f"训练用途未显式声明（--deployment-purpose 必须为 "
                       f"{sorted(KNOWN_DEPLOYMENT_PURPOSES)} 之一）")
    if deployment_purpose not in (exc.get("deployment_purposes") or []):
        return False, (f"当前用途 {deployment_purpose} 不在该例外的批准范围 "
                       f"{exc.get('deployment_purposes')} 内")
    # 2) 内部审批不能冒充外部授权：商业用途 + 来源禁/不明商用 → 需 licensor-grant + 证据
    if deployment_purpose == "commercial-product":
        cu = (registry_info or {}).get("commercialUse")
        if cu in EXTERNAL_GRANT_REQUIRED_LICENSES or cu is None:
            lb = exc.get("license_basis") or {}
            if lb.get("basis") != "licensor-grant" or not str(lb.get("evidence_ref") or "").strip():
                return False, (f"来源 {sid} 的 commercialUse={cu!r}：商业用途不能仅凭"
                               f"项目内部审批放行，必须登记 licensor-grant 及可追溯证据"
                               f"（license_basis.evidence_ref）")
    # 3) 样本级范围限定（指定了哪项就检查哪项，多项则同时满足）
    allowed_ids = exc.get("allowed_sample_ids")
    if allowed_ids and sample.get("sample_id") not in allowed_ids:
        return False, (f"样本 {sample.get('sample_id')} 不在例外允许的样本范围 "
                       f"{allowed_ids} 内")
    allowed_topics = exc.get("allowed_topics")
    if allowed_topics and sample.get("topic") not in allowed_topics:
        return False, (f"样本主题 {sample.get('topic')!r} 不在例外允许的主题范围 "
                       f"{allowed_topics} 内")
    allowed_claims = exc.get("allowed_claim_ids")
    if allowed_claims:
        cited = set(sample.get("claim_ids") or [])
        if not cited:
            return False, "样本未引用任何 claim，无法核对例外允许的 claim 范围"
        outside = sorted(cited - set(allowed_claims))
        if outside:
            return False, (f"样本引用的 claim 超出例外允许范围: {outside}")
    return True, ""


def source_admission_issues(source_ids, registry, source_usage, exceptions=None,
                            deployment_purpose=None, sample=None):
    """对一条样本引用的外部来源做训练准入检查（默认拒绝 + 范围约束）。返回 error 级列表。"""
    issues = []
    usage = source_usage or {}
    exceptions = exceptions or {}
    sample = sample or {}
    for sid in source_ids:
        info = registry.get(sid)
        if info is None:
            issues.append({"level": "error", "code": "unknown-source-id",
                           "message": f"引用了未注册来源: {sid}"})
            continue
        if info.get("status") in SOURCE_STATUS_BLOCKED:
            label = ("pending-verification，禁止作为事实来源"
                     if info["status"] == "pending-verification"
                     else f"{info['status']}，禁止用于训练样本")
            issues.append({"level": "error", "code": "source-blocked-status",
                           "message": f"来源 {sid} 状态为 {label}"})
            continue
        lic = str(info.get("license_status") or "").lower()
        if lic in SOURCE_LICENSE_BLOCKED:
            issues.append({"level": "error", "code": "source-license-blocked",
                           "message": f"来源 {sid} 许可为 {lic}，禁止用于训练样本"})
            continue
        declared = usage.get(sid)
        if declared not in ALLOWED_SOURCE_USAGE:
            issues.append({"level": "error", "code": "source-usage-undeclared",
                           "message": f"来源 {sid} 未在样本元数据声明用法"
                                      f"（source_usage.{sid} 必须为 fact-extraction-rewrite）"})
            continue
        if source_auto_allow(info):
            continue
        # 默认拒绝：需要有效人工例外（source_usage 声明不能替代授权）
        exc = exceptions.get(sid)
        if exc is None:
            issues.append({"level": "error", "code": "source-requires-human-exception",
                           "message": f"来源 {sid}（license={lic}, commercialUse="
                                      f"{info.get('commercialUse')!r}, derivatives="
                                      f"{info.get('derivatives')!r}）不在自动准入范围，且无有效"
                                      f"人工例外。{EXTERNAL_SOURCE_POLICY}"})
            continue
        if exc.get("usage") not in ALLOWED_SOURCE_USAGE:
            issues.append({"level": "error", "code": "source-requires-human-exception",
                           "message": f"来源 {sid} 的人工例外 usage 非法"})
            continue
        ok, reason = check_exception_scope(exc, info, sample, deployment_purpose)
        if not ok:
            issues.append({"level": "error", "code": "exception-out-of-scope",
                           "message": f"来源 {sid} 的人工例外不覆盖当前样本/用途: {reason}"})
    return issues

REQUIRED_META_FIELDS = [
    "sample_id", "topic", "license_status", "review_status",
    "data_version", "dedup_fingerprint",
]


# ---------------------------------------------------------------- JSONL 加载

def expand_globs(patterns):
    """把若干 glob 模式展开为确定顺序的文件列表（相对路径基于仓库根）。"""
    files = []
    for pat in patterns:
        p = Path(pat)
        if not p.is_absolute():
            p = REPO_ROOT / p
        if p.is_file():
            files.append(p)
        else:
            files.extend(sorted(p.parent.glob(p.name)))
    # 去重、保序
    seen, out = set(), []
    for f in files:
        r = f.resolve()
        if r not in seen:
            seen.add(r)
            out.append(f)
    return out


def load_jsonl(paths):
    """读 JSONL。返回 (records, load_errors)。records 每项: {path, line_no, data}"""
    records, errors = [], []
    for path in paths:
        text = path.read_text(encoding="utf-8").strip()
        if not text:
            errors.append({
                "level": "error", "code": "empty-file",
                "file": str(path), "message": "文件为空",
            })
            continue
        for i, line in enumerate(text.splitlines(), start=1):
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
            except json.JSONDecodeError as e:
                errors.append({
                    "level": "error", "code": "invalid-json",
                    "file": str(path), "line": i,
                    "message": f"JSON 解析失败: {e}",
                })
                continue
            if not isinstance(data, dict):
                errors.append({
                    "level": "error", "code": "not-object",
                    "file": str(path), "line": i,
                    "message": "每行必须是一个 JSON 对象",
                })
                continue
            records.append({"path": str(path), "line_no": i, "data": data})
    return records, errors


# ---------------------------------------------------------------- 指纹与相似度

def norm_text(s: str) -> str:
    return re.sub(r"\s+", "", (s or "")).lower()


def message_texts(messages) -> str:
    parts = []
    for m in messages:
        if isinstance(m, dict):
            parts.append(str(m.get("content", "")))
    return norm_text("".join(parts))


def messages_fingerprint(messages) -> str:
    payload = json.dumps(messages, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def text_similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def corpus_sha256(paths) -> str:
    h = hashlib.sha256()
    for path in paths:
        h.update(Path(path).read_bytes())
    return h.hexdigest()


# ---------------------------------------------------------------- 结构检查

def check_messages(rec, max_chars=12000, min_answer_chars=20):
    """检查单条语料的 messages 结构。返回 issue 列表。"""
    issues = []
    data = rec["data"]
    sid = data.get("sample_id", f"<line {rec['line_no']}>")
    where = {"file": rec["path"], "line": rec["line_no"], "sample_id": sid}

    if not isinstance(data.get("sample_id"), str) or not data["sample_id"].strip():
        issues.append({**where, "level": "error", "code": "missing-sample-id",
                       "message": "缺少非空 sample_id"})
    if not isinstance(data.get("group_id"), str) or not data["group_id"].strip():
        issues.append({**where, "level": "error", "code": "missing-group-id",
                       "message": "缺少非空 group_id（题组防泄漏必需）"})

    msgs = data.get("messages")
    if not isinstance(msgs, list) or len(msgs) < 2:
        issues.append({**where, "level": "error", "code": "bad-messages",
                       "message": "messages 必须是长度>=2 的数组"})
        return issues

    for i, m in enumerate(msgs):
        if not isinstance(m, dict) or set(m.keys()) - {"role", "content"}:
            issues.append({**where, "level": "error", "code": "bad-message",
                           "message": f"messages[{i}] 必须是仅含 role/content 的对象"})
            continue
        if m.get("role") not in VALID_ROLES:
            issues.append({**where, "level": "error", "code": "bad-role",
                           "message": f"messages[{i}] 非法角色: {m.get('role')!r}"})
        content = m.get("content")
        if not isinstance(content, str) or not content.strip():
            issues.append({**where, "level": "error", "code": "empty-content",
                           "message": f"messages[{i}] content 为空或非字符串"})

    roles = [m.get("role") for m in msgs if isinstance(m, dict)]
    if "user" not in roles:
        issues.append({**where, "level": "error", "code": "no-user",
                       "message": "缺少用户提问（role=user）"})
    if roles and roles[-1] != "assistant":
        issues.append({**where, "level": "error", "code": "no-assistant-answer",
                       "message": "最后一条必须是 assistant 回答（chat 格式约定）"})

    # 空回答 / 异常长文本
    for i, m in enumerate(msgs):
        if isinstance(m, dict) and m.get("role") == "assistant":
            content = m.get("content") or ""
            if isinstance(content, str) and len(content.strip()) < min_answer_chars:
                issues.append({**where, "level": "error", "code": "short-answer",
                               "message": f"assistant 回答过短（<{min_answer_chars} 字符）"})
    total = sum(len((m.get("content") or "")) for m in msgs if isinstance(m, dict))
    if total > max_chars:
        issues.append({**where, "level": "error", "code": "overlong",
                       "message": f"样本过长（{total} > {max_chars} 字符上限）"})
    return issues


def check_meta(rec, registry_sources=None, for_training=False):
    """检查单条元数据。返回 (issues, meta_or_None)。"""
    data = rec["data"]
    sid = data.get("sample_id", f"<line {rec['line_no']}>")
    where = {"file": rec["path"], "line": rec["line_no"], "sample_id": sid}
    issues = []
    for field in REQUIRED_META_FIELDS:
        if field not in data:
            issues.append({**where, "level": "error", "code": "missing-meta-field",
                           "message": f"元数据缺少字段 {field}"})
    review = data.get("review_status")
    if review not in VALID_REVIEW_STATUS:
        issues.append({**where, "level": "error", "code": "bad-review-status",
                       "message": f"review_status 非法: {review!r}（应为 {sorted(VALID_REVIEW_STATUS)}）"})
    lic = data.get("license_status")
    if not isinstance(lic, str) or not lic.strip():
        issues.append({**where, "level": "error", "code": "bad-license-status",
                       "message": "license_status 缺失或为空"})
    fp = data.get("dedup_fingerprint")
    if fp is not None and (not isinstance(fp, str) or len(fp) < 16):
        issues.append({**where, "level": "warning", "code": "bad-fingerprint",
                       "message": "dedup_fingerprint 应为 sha256 十六进制串或 null"})
    # 可选扩展字段（阶段三）：类型检查
    waiver = data.get("source_waiver")
    if waiver is not None and (not isinstance(waiver, str) or not waiver.strip()):
        issues.append({**where, "level": "error", "code": "bad-source-waiver",
                       "message": "source_waiver 必须是非空字符串（豁免原因）"})
    usage = data.get("source_usage")
    if usage is not None and not isinstance(usage, dict):
        issues.append({**where, "level": "error", "code": "bad-source-usage",
                       "message": "source_usage 必须是 {sourceId: usage} 形式的对象"})
    # 来源注册表核对
    if registry_sources is not None:
        for src in data.get("source_ids") or []:
            info = registry_sources.get(src)
            if info is None:
                issues.append({**where, "level": "error", "code": "unknown-source-id",
                               "message": f"source_ids 引用了未注册来源: {src}"})
            elif info.get("status") == "pending-verification":
                # 训练模式：approved 样本引用 pending 来源 → 阻断；
                # 未审核样本只保留 not-approved 阻断（避免噪音），普通模式 → 警告。
                if for_training and review == REVIEW_APPROVED:
                    issues.append({**where, "level": "error", "code": "source-blocked-pending",
                                   "message": f"source_ids 引用了 pending-verification 来源: {src}"
                                              "——训练阻断（不可作为事实来源）"})
                elif not for_training:
                    issues.append({**where, "level": "warning", "code": "pending-source",
                                   "message": f"source_ids 引用了 pending-verification 来源: {src}"
                                              "（不可作为事实来源）"})
    return issues, data


def load_registry(path=DEFAULT_REGISTRY):
    """返回 {sourceId: {status, license_status, commercialUse, derivatives}}；不存在返回 None。"""
    path = Path(path)
    if not path.is_file():
        return None
    try:
        reg = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    out = {}
    for s in reg.get("sources", []):
        lic = s.get("license") or {}
        out[s.get("sourceId")] = {
            "status": s.get("status"),
            "license_status": lic.get("status"),
            "commercialUse": lic.get("commercialUse"),
            "derivatives": lic.get("derivatives"),
        }
    return out


# ---------------------------------------------------------------- 近重复扫描

def near_duplicate_pairs(records, threshold=0.92, max_pairs=3000):
    """返回 [(idA, idB, ratio)]。样本数超过 max_pairs 时返回 (None) 表示跳过。"""
    if len(records) > max_pairs:
        return None
    items = []
    for rec in records:
        d = rec["data"]
        items.append((str(d.get("sample_id")), message_texts(d.get("messages") or [])))
    pairs = []
    n = len(items)
    for i in range(n):
        ida, ta = items[i]
        for j in range(i + 1, n):
            idb, tb = items[j]
            r = text_similarity(ta, tb)
            if r >= threshold:
                pairs.append((ida, idb, r))
    return pairs


def fail(msg, code=1):
    print(f"[CoffeeAI] 错误: {msg}", file=sys.stderr)
    sys.exit(code)
