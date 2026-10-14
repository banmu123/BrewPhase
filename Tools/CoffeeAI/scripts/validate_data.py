#!/usr/bin/env python3
"""validate_data.py — CommitBrew Coffee AI 数据验证。

检查项（对应任务验收 1/3/8）：
  - JSONL 可解析、每行是对象、文件非空
  - sample_id/group_id 存在且 sample_id 全局唯一
  - messages：合法角色、非空 content、含 user 提问、最后一条为 assistant 回答
  - 空回答/过短回答、异常长文本
  - 完全重复（messages 指纹）与高相似样本（近似改写）
  - 元数据齐全：topic/license/review_status/data_version/dedup_fingerprint
  - 来源注册表核对（source_ids 必须已注册）
  - --for-training：review_status 非 approved、许可不明/受限、指纹缺失 → 一律拒绝
  - --check-splits：训练/验证/测试集 sample_id 与 group_id 不得跨集合，高相似不得跨集合

用法:
  python3 Tools/CoffeeAI/scripts/validate_data.py                     # 校验默认语料
  python3 Tools/CoffeeAI/scripts/validate_data.py --for-training      # 训练前置严格校验
  python3 Tools/CoffeeAI/scripts/validate_data.py --check-splits Tools/CoffeeAI/data/splits
  python3 Tools/CoffeeAI/scripts/validate_data.py --json              # 机器可读输出
退出码: 0 = 无 error；1 = 有 error。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from coffeeai_common import (  # noqa: E402
    COFFEEAI_ROOT, DEFAULT_CORPUS_GLOB, DEFAULT_META_GLOB,
    LICENSES_ALLOW_TRAIN, LICENSES_BLOCK_TRAIN, REVIEW_APPROVED,
    check_messages, check_meta, corpus_sha256, expand_globs, load_jsonl,
    load_registry, message_texts, messages_fingerprint, near_duplicate_pairs,
    source_admission_issues,
)


def build_arg_parser():
    p = argparse.ArgumentParser(description="CommitBrew Coffee AI 数据验证")
    p.add_argument("--corpus", nargs="+", default=[f"Tools/CoffeeAI/{DEFAULT_CORPUS_GLOB}"],
                   help="语料 JSONL（文件或 glob）")
    p.add_argument("--meta", nargs="+", default=[f"Tools/CoffeeAI/{DEFAULT_META_GLOB}"],
                   help="元数据 JSONL（文件或 glob）")
    p.add_argument("--for-training", action="store_true",
                   help="训练前置模式：仅接受 review_status=approved 且许可明确的样本")
    p.add_argument("--check-splits", metavar="DIR",
                   help="检查 train/valid/test.jsonl 的跨集合泄漏")
    p.add_argument("--check-admission", metavar="DIR",
                   help="P0：对已生成 splits 做正式训练准入复查（审核状态/许可/来源级）")
    p.add_argument("--max-chars", type=int, default=12000)
    p.add_argument("--min-answer-chars", type=int, default=20)
    p.add_argument("--sim-threshold", type=float, default=0.92)
    p.add_argument("--registry", default=None, help="SOURCE_REGISTRY.json 路径（默认自动）")
    p.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    return p


def validate(corpus_patterns, meta_patterns, registry_path=None,
             max_chars=12000, min_answer_chars=20, sim_threshold=0.92,
             for_training=False):
    """核心校验。返回 (issues, summary_dict)。"""
    issues = []

    corpus_paths = expand_globs(corpus_patterns)
    meta_paths = expand_globs(meta_patterns)
    if not corpus_paths:
        issues.append({"level": "error", "code": "no-corpus",
                       "message": "未找到任何语料文件"})
    if not meta_paths:
        issues.append({"level": "error", "code": "no-meta",
                       "message": "未找到任何元数据文件"})

    reg = load_registry(registry_path) if registry_path else load_registry()
    if reg is None:
        issues.append({"level": "warning", "code": "registry-missing",
                       "message": "knowledge/SOURCE_REGISTRY.json 不可读，跳过来源核对"})

    corpus_recs, load_errors = load_jsonl(corpus_paths)
    meta_recs, meta_load_errors = load_jsonl(meta_paths)
    issues.extend(load_errors + meta_load_errors)

    # ---- 语料结构
    seen_ids = {}
    corpus_recs2 = []
    for rec in corpus_recs:
        issues.extend(check_messages(rec, max_chars, min_answer_chars))
        sid = rec["data"].get("sample_id")
        if isinstance(sid, str) and sid:
            if sid in seen_ids:
                issues.append({**{"file": rec["path"], "line": rec["line_no"], "sample_id": sid},
                               "level": "error", "code": "duplicate-sample-id",
                               "message": f"sample_id 重复（首次出现于 {seen_ids[sid]}）"})
            else:
                seen_ids[sid] = f"{rec['path']}:{rec['line_no']}"
        corpus_recs2.append(rec)

    # ---- 完全重复（指纹）
    by_fp = {}
    for rec in corpus_recs2:
        msgs = rec["data"].get("messages")
        if isinstance(msgs, list) and len(msgs) >= 2:
            fp = messages_fingerprint(msgs)
            if fp in by_fp:
                issues.append({**{"file": rec["path"], "line": rec["line_no"],
                                  "sample_id": rec["data"].get("sample_id")},
                               "level": "error", "code": "exact-duplicate",
                               "message": f"与 {by_fp[fp]} 的 messages 完全相同"})
            else:
                by_fp[fp] = rec["data"].get("sample_id")

    # ---- 高相似（近似改写）
    pairs = near_duplicate_pairs(corpus_recs2, threshold=sim_threshold)
    if pairs is None:
        issues.append({"level": "warning", "code": "sim-scan-skipped",
                       "message": "样本过多，跳过高相似扫描"})
    else:
        for ida, idb, r in pairs:
            issues.append({"level": "warning", "code": "near-duplicate",
                           "sample_id": ida, "related": idb,
                           "message": f"高相似样本对（ratio={r:.3f}>= {sim_threshold}）："
                                      f"{ida} <-> {idb}；应同组（group_id）或去重"})

    # ---- 元数据
    meta_by_id = {}
    for rec in meta_recs:
        meta_issues, meta = check_meta(rec, reg, for_training=for_training)
        issues.extend(meta_issues)
        sid = (meta or {}).get("sample_id")
        if isinstance(sid, str) and sid:
            if sid in meta_by_id:
                issues.append({**{"file": rec["path"], "line": rec["line_no"], "sample_id": sid},
                               "level": "error", "code": "duplicate-meta",
                               "message": "元数据 sample_id 重复"})
            meta_by_id[sid] = meta

    corpus_ids = {r["data"].get("sample_id") for r in corpus_recs2
                  if isinstance(r["data"].get("sample_id"), str)}
    for sid in sorted(corpus_ids - set(meta_by_id)):
        issues.append({"level": "error", "code": "missing-meta",
                       "sample_id": sid,
                       "message": f"语料样本 {sid} 没有对应元数据"})

    # ---- 指纹一致性
    for rec in corpus_recs2:
        sid = rec["data"].get("sample_id")
        meta = meta_by_id.get(sid)
        msgs = rec["data"].get("messages")
        if meta and isinstance(msgs, list):
            fp_meta = meta.get("dedup_fingerprint")
            if fp_meta is None:
                if meta.get("review_status") == REVIEW_APPROVED:
                    issues.append({"level": "error", "code": "missing-fingerprint",
                                   "sample_id": sid,
                                   "message": "已审核样本缺少 dedup_fingerprint（去重标识必需）"})
            elif fp_meta != messages_fingerprint(msgs):
                issues.append({"level": "warning", "code": "fingerprint-mismatch",
                               "sample_id": sid,
                               "message": "元数据指纹与 messages 不一致（样本可能已改动，需重算）"})

    # ---- 训练模式
    approved = [sid for sid, m in meta_by_id.items()
                if m.get("review_status") == REVIEW_APPROVED and sid in corpus_ids]
    if for_training:
        for sid, m in meta_by_id.items():
            if sid not in corpus_ids:
                continue
            if m.get("review_status") != REVIEW_APPROVED:
                issues.append({"level": "error", "code": "not-approved",
                               "sample_id": sid,
                               "message": f"review_status={m.get('review_status')!r}，未经审核禁止训练"})
                continue  # 未审核样本以 not-approved 为唯一阻断项，不再叠加来源噪音
            lic = str(m.get("license_status", "")).lower()
            if lic in LICENSES_BLOCK_TRAIN:
                issues.append({"level": "error", "code": "license-blocked",
                               "sample_id": sid,
                               "message": f"license_status={lic}，禁止用于训练"})
            elif lic not in LICENSES_ALLOW_TRAIN:
                issues.append({"level": "error", "code": "license-unclear",
                               "sample_id": sid,
                               "message": f"license_status={lic!r} 不在许可白名单，需人工确认"})
            if m.get("dedup_fingerprint") is None:
                issues.append({"level": "error", "code": "missing-fingerprint",
                               "sample_id": sid,
                               "message": "训练样本缺少去重指纹"})
            # ---- 阶段三：来源级准入（不因样本自身 own-original 而豁免来源限制）
            src_ids = m.get("source_ids") or []
            src_issues = source_admission_issues(src_ids, reg or {}, m.get("source_usage"))
            for si in src_issues:
                issues.append({"level": "error", "code": si["code"],
                               "sample_id": sid, "message": si["message"]})
            if src_ids:
                if not m.get("claim_ids"):
                    issues.append({"level": "error", "code": "missing-claim-linkage",
                                   "sample_id": sid,
                                   "message": "样本引用了外部事实来源但缺少 claim 关联（claim_ids 为空）"})
            elif not (m.get("source_waiver") or "").strip():
                issues.append({"level": "error", "code": "missing-source-waiver",
                               "sample_id": sid,
                               "message": "无外部来源的样本必须提供 source_waiver（豁免原因），"
                                          "说明为何不需要事实来源"})

    summary = {
        "corpus_files": [str(p) for p in corpus_paths],
        "meta_files": [str(p) for p in meta_paths],
        "corpus_sha256": corpus_sha256(corpus_paths) if corpus_paths else None,
        "total_samples": len(corpus_recs2),
        "approved_samples": len(approved),
        "unreviewed_or_rejected": len(corpus_recs2) - len(approved),
        "errors": sum(1 for i in issues if i.get("level") == "error"),
        "warnings": sum(1 for i in issues if i.get("level") == "warning"),
        "issues": issues,
    }
    return issues, summary


def check_splits_dir(d, sim_threshold=0.92):
    """检查已生成 splits 的跨集合泄漏。返回 (issues, summary)。"""
    issues = []
    d = Path(d)
    splits = {}
    for name in ("train", "valid", "test"):
        f = d / f"{name}.jsonl"
        if not f.is_file():
            issues.append({"level": "error", "code": "split-file-missing",
                           "message": f"缺少 {f}"})
            splits[name] = []
            continue
        recs, errs = load_jsonl([f])
        issues.extend(errs)
        meta_f = d / f"{name}.meta.jsonl"
        ids, groups = [], {}
        if meta_f.is_file():
            meta_recs, _ = load_jsonl([meta_f])
            for m in meta_recs:
                sid = m["data"].get("sample_id")
                gid = m["data"].get("group_id")
                if sid:
                    ids.append(sid)
                if sid and gid:
                    groups[sid] = gid
        else:
            # 回退：从 messages 文件本身取 sample_id（若有）
            for r in recs:
                sid = r["data"].get("sample_id")
                if sid:
                    ids.append(sid)
        splits[name] = {"ids": ids, "groups": groups,
                        "texts": {sid: message_texts(r["data"].get("messages") or [])
                                  for sid, r in zip(ids, recs)}}

    names = [n for n in ("train", "valid", "test") if splits.get(n, {}).get("ids")]
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            a, b = names[i], names[j]
            sa, sb = set(splits[a]["ids"]), set(splits[b]["ids"])
            inter = sa & sb
            if inter:
                issues.append({"level": "error", "code": "sample-cross-split",
                               "message": f"sample_id 跨集合: {a}/{b} 共 {len(inter)} 条，例: {sorted(inter)[:5]}"})
            ga = {splits[a]["groups"][x] for x in sa if x in splits[a]["groups"]}
            gb = {splits[b]["groups"][x] for x in sb if x in splits[b]["groups"]}
            ginter = ga & gb
            if ginter:
                issues.append({"level": "error", "code": "group-cross-split",
                               "message": f"group_id 跨集合: {a}/{b} 共 {len(ginter)} 组，例: {sorted(ginter)[:5]}"})

    # 高相似样本不得跨集合
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            a, b = names[i], names[j]
            ta, tb = splits[a]["texts"], splits[b]["texts"]
            from coffeeai_common import text_similarity
            hit = []
            for ida, txta in ta.items():
                for idb, txtb in tb.items():
                    if text_similarity(txta, txtb) >= sim_threshold:
                        hit.append((ida, idb))
            if hit:
                issues.append({"level": "error", "code": "near-dup-cross-split",
                               "message": f"高相似样本跨集合: {a}/{b}，例: {hit[:5]}"})

    counts = {n: len(splits[n]["ids"]) for n in splits}
    summary = {"splits_dir": str(d), "counts": counts,
               "errors": sum(1 for x in issues if x["level"] == "error"),
               "warnings": sum(1 for x in issues if x["level"] == "warning"),
               "issues": issues}
    return issues, summary


def check_training_admission(splits_dir, registry_path=None):
    """P0：正式训练/烟测前的划分产物准入复查（不信任划分时的标志）。

    独立重读 {train,valid,test}.meta.jsonl 与 {train,valid,test}.jsonl，逐条确认：
      1. 每条 jsonl 样本都有对应元数据（按 sample_id 1:1，数量一致）；
      2. review_status == approved（未审核/拒绝一律阻断）；
      3. license_status 通过严格训练准入；
      4. 来源级准入（pending/unknown/付费墙阻断、usage 声明、claim 关联、豁免）；
      5. sample_id 不跨集合。
    返回 (issues, summary)。任何 error 都应阻断正式训练。
    """
    issues = []
    d = Path(splits_dir)
    reg = load_registry(registry_path) if registry_path else load_registry()
    if reg is None:
        issues.append({"level": "error", "code": "registry-unreadable",
                       "message": "SOURCE_REGISTRY.json 不可读，无法做来源级准入检查（阻断）"})

    seen_ids = {}
    counts = {}
    for split in ("train", "valid", "test"):
        jsonl_f = d / f"{split}.jsonl"
        meta_f = d / f"{split}.meta.jsonl"
        if not jsonl_f.is_file():
            issues.append({"level": "error", "code": "split-file-missing",
                           "message": f"缺少 {jsonl_f}"})
            counts[split] = 0
            continue
        recs, errs = load_jsonl([jsonl_f])
        issues.extend(errs)
        counts[split] = len(recs)
        if not meta_f.is_file():
            issues.append({"level": "error", "code": "admission-meta-missing",
                           "message": f"缺少 {meta_f}：划分产物必须携带审计元数据"})
            continue
        meta_rows, meta_errs = load_jsonl([meta_f])
        issues.extend(meta_errs)
        meta_by_id = {}
        for row in meta_rows:
            m = row["data"]
            sid = m.get("sample_id")
            if not sid:
                issues.append({"level": "error", "code": "admission-meta-incomplete",
                               "message": f"{meta_f.name} 存在缺少 sample_id 的行"})
                continue
            if sid in meta_by_id:
                issues.append({"level": "error", "code": "admission-meta-incomplete",
                               "message": f"{meta_f.name} 中 sample_id 重复: {sid}"})
            meta_by_id[sid] = m

        # jsonl ↔ meta 1:1
        jsonl_ids = [r["data"].get("sample_id") for r in recs]
        if any(not s for s in jsonl_ids):
            issues.append({"level": "error", "code": "admission-jsonl-no-id",
                           "message": f"{jsonl_f.name} 存在缺少 sample_id 的行（需重新运行 split_dataset.py）"})
            jsonl_ids = [s for s in jsonl_ids if s]
        for sid in jsonl_ids:
            if sid in seen_ids:
                issues.append({"level": "error", "code": "sample-cross-split",
                               "message": f"sample_id 跨集合: {sid}（已在 {seen_ids[sid]} 出现过）"})
            else:
                seen_ids[sid] = split
        missing = [s for s in jsonl_ids if s not in meta_by_id]
        if missing:
            issues.append({"level": "error", "code": "admission-meta-missing",
                           "message": f"{split}: {len(missing)} 条样本没有对应元数据，例: {missing[:5]}"})
        extra = [s for s in meta_by_id if s not in set(jsonl_ids)]
        if extra:
            issues.append({"level": "error", "code": "admission-meta-extra",
                           "message": f"{split}: 元数据中有 {len(extra)} 条不在 jsonl 中（过期 meta?），例: {extra[:5]}"})

        # 逐条元数据准入
        for sid in jsonl_ids:
            m = meta_by_id.get(sid)
            if m is None:
                continue
            for field in ("review_status", "license_status", "data_version", "dedup_fingerprint"):
                if not m.get(field):
                    issues.append({"level": "error", "code": "admission-meta-incomplete",
                                   "sample_id": sid,
                                   "message": f"{split}/{sid} 缺少 {field}"})
            if m.get("review_status") != REVIEW_APPROVED:
                issues.append({"level": "error", "code": "admission-not-approved",
                               "sample_id": sid,
                               "message": f"{split}/{sid} review_status="
                                          f"{m.get('review_status')!r}——未经审核，阻断训练"})
                continue  # 未审核样本不再叠加来源检查（避免噪音）
            lic = str(m.get("license_status", "")).lower()
            if lic in LICENSES_BLOCK_TRAIN:
                issues.append({"level": "error", "code": "admission-license-blocked",
                               "sample_id": sid,
                               "message": f"{split}/{sid} license_status={lic}，阻断"})
            elif lic not in LICENSES_ALLOW_TRAIN:
                issues.append({"level": "error", "code": "admission-license-unclear",
                               "sample_id": sid,
                               "message": f"{split}/{sid} license_status={lic!r} 不在白名单，阻断"})
            src_ids = m.get("source_ids") or []
            src_issues = source_admission_issues(src_ids, reg or {}, m.get("source_usage"))
            for si in src_issues:
                issues.append({"level": "error", "code": si["code"],
                               "sample_id": sid,
                               "message": f"{split}/{sid}: {si['message']}"})
            if src_ids and not m.get("claim_ids"):
                issues.append({"level": "error", "code": "missing-claim-linkage",
                               "sample_id": sid,
                               "message": f"{split}/{sid}: 引用外部来源但缺少 claim 关联"})
            if not src_ids and not (m.get("source_waiver") or "").strip():
                issues.append({"level": "error", "code": "missing-source-waiver",
                               "sample_id": sid,
                               "message": f"{split}/{sid}: 无来源样本缺少 source_waiver"})

    summary = {"splits_dir": str(d), "counts": counts,
               "n_samples": sum(counts.values()),
               "errors": sum(1 for x in issues if x["level"] == "error"),
               "warnings": sum(1 for x in issues if x["level"] == "warning"),
               "issues": issues}
    return issues, summary


def main(argv=None):
    args = build_arg_parser().parse_args(argv)

    report = {"tool": "validate_data", "mode": "for-training" if args.for_training else "check"}

    if args.check_admission:
        issues, summary = check_training_admission(args.check_admission)
        report["admission"] = summary
    elif args.check_splits:
        issues, summary = check_splits_dir(args.check_splits, args.sim_threshold)
        report["splits_check"] = summary
    else:
        issues, summary = validate(
            args.corpus, args.meta, args.registry, args.max_chars,
            args.min_answer_chars, args.sim_threshold, args.for_training)
        report["validation"] = summary

    errors = sum(1 for i in issues if i.get("level") == "error")
    warnings = sum(1 for i in issues if i.get("level") == "warning")

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print("=" * 62)
        print("CommitBrew Coffee AI — 数据验证报告")
        print("=" * 62)
        if "validation" in report:
            v = report["validation"]
            print(f"语料文件 : {len(v['corpus_files'])} 个  元数据文件: {len(v['meta_files'])} 个")
            print(f"样本总数 : {v['total_samples']}  已审核: {v['approved_samples']}  未审核/拒绝: {v['unreviewed_or_rejected']}")
            print(f"语料指纹 : {v['corpus_sha256']}")
        if "splits_check" in report:
            print(f"splits   : {report['splits_check']['counts']}")
        if "admission" in report:
            print(f"准入复查 : {report['admission']['counts']}  样本数 {report['admission']['n_samples']}")
        print(f"结果     : {errors} 个 error, {warnings} 个 warning")
        print("-" * 62)
        for i in issues:
            loc = ""
            if i.get("file"):
                loc = f"{Path(i['file']).name}:{i.get('line', '?')} "
            sid = i.get("sample_id", "")
            print(f"[{i['level'].upper():7s}] {i['code']:<24s} {loc}{sid} {i['message']}")
        if errors == 0 and warnings == 0:
            print("全部检查通过。")
        print("-" * 62)
        if errors:
            print("结论: 存在 error，禁止用于训练。")
        elif args.for_training:
            print("结论: 通过训练前置校验（仅 approved + 许可明确样本）。")
        else:
            print("结论: 无 error；warning 项请人工复核。")

    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
