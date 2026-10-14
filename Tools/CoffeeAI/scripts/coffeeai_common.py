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

# ---------------------------------------------------------------- 来源级训练准入政策（阶段三）
# 依据 knowledge/SOURCE_REGISTRY.md 的项目纪律：
#   - pending-verification 来源未取得官方可访问 URL，禁止作为事实来源（注册表 §0.1）；
#   - license unknown = 来源没有自述许可，不许默认可复制（§0.2）；
#   - 付费数字产品正文不得复制（§2）；
#   - restricted 资产（如 SCA 风味轮）不得改编；
#   - 其余外部来源只允许「事实提取 + 独立改写 + 署名」——样本必须显式声明该用法。
SOURCE_STATUS_BLOCKED = {"pending-verification"}
SOURCE_LICENSE_BLOCKED = {"unknown", "proprietary-paywalled"}
ALLOWED_SOURCE_USAGE = {"fact-extraction-rewrite"}  # 外部来源唯一允许的用法
EXTERNAL_SOURCE_POLICY = (
    "外部来源仅允许「事实提取 + 独立改写 + 署名」；训练样本须在元数据 "
    "source_usage 中为每个引用来源显式声明 usage=fact-extraction-rewrite，"
    "并提供 claim 关联。pending-verification / license unknown / 付费墙来源禁止引用。"
)


def source_admission_issues(source_ids, registry, source_usage):
    """对一条样本引用的外部来源做训练准入检查。返回 issue 列表（均为 error 级）。"""
    issues = []
    usage = source_usage or {}
    for sid in source_ids:
        info = registry.get(sid)
        if info is None:
            issues.append({"level": "error", "code": "unknown-source-id",
                           "message": f"引用了未注册来源: {sid}"})
            continue
        if info.get("status") in SOURCE_STATUS_BLOCKED:
            issues.append({"level": "error", "code": "source-blocked-pending",
                           "message": f"来源 {sid} 状态为 pending-verification，禁止作为事实来源"})
            continue
        if info.get("status") == "restricted":
            issues.append({"level": "error", "code": "source-license-blocked",
                           "message": f"来源 {sid} 为 restricted 资产（禁止改编），禁止用于训练样本"})
            continue
        lic = str(info.get("license_status") or "").lower()
        if lic in SOURCE_LICENSE_BLOCKED:
            issues.append({"level": "error", "code": "source-license-blocked",
                           "message": f"来源 {sid} 许可为 {lic}，禁止用于训练样本"})
            continue
        declared = usage.get(sid)
        if declared not in ALLOWED_SOURCE_USAGE:
            issues.append({"level": "error", "code": "source-usage-undeclared",
                           "message": f"来源 {sid} 未显式声明用法（source_usage.{sid} 必须为 "
                                      f"fact-extraction-rewrite）。{EXTERNAL_SOURCE_POLICY}"})
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
    """返回 {sourceId: {status, license_status}}；文件不存在返回 None。"""
    path = Path(path)
    if not path.is_file():
        return None
    try:
        reg = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    out = {}
    for s in reg.get("sources", []):
        out[s.get("sourceId")] = {
            "status": s.get("status"),
            "license_status": (s.get("license") or {}).get("status"),
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
