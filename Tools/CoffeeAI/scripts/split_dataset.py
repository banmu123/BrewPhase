#!/usr/bin/env python3
"""split_dataset.py — CommitBrew Coffee AI 数据集划分（可复现、防泄漏）。

设计（对应任务验收 2/3）：
  1. 只划分「已审核（approved）且许可明确」的样本；未经审核默认排除。
     --include-unreviewed 需要显式传入才包含（仍然会打警告，仅供管线演练）。
  2. 按题组（group_id）整体划分：同一题组的改写样本永远落在同一集合。
  3. 高相似（>= --sim-threshold）但 group_id 不同的样本对，用并查集自动并组，
     杜绝近似改写跨集合泄漏；并组结果写入 split_report.json。
  4. 固定随机种子（默认 42），同输入同种子输出逐字节一致。
  5. 有效样本不足时明确拒绝并提示，绝不伪造数据量凑比例。

输出（--out 目录，默认 Tools/CoffeeAI/data/splits/）:
  train.jsonl / valid.jsonl / test.jsonl        # 纯 {"messages":[...]}，MLX-LM chat 格式
  train.meta.jsonl / valid.meta.jsonl / test.meta.jsonl   # 审计用（sample_id/group_id）
  split_report.json                             # 种子、比例、题组归属、并组记录、语料指纹
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from coffeeai_common import (  # noqa: E402
    COFFEEAI_ROOT, DEFAULT_CORPUS_GLOB, DEFAULT_META_GLOB,
    LICENSES_ALLOW_TRAIN, REVIEW_APPROVED, corpus_sha256, expand_globs,
    load_jsonl, load_registry, message_texts, near_duplicate_pairs,
    text_similarity,
)
from validate_data import validate  # noqa: E402


class DSU:
    def __init__(self):
        self.p = {}

    def find(self, x):
        self.p.setdefault(x, x)
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[rb] = ra


def allocate(n_groups, ratios):
    """最大余数法分配组数，n_groups>=3 时保证每个集合至少 1 组。"""
    raw = [n_groups * r for r in ratios]
    base = [int(x) for x in raw]
    seats = n_groups - sum(base)
    order = sorted(range(3), key=lambda i: (-(raw[i] - base[i]), -ratios[i], i))
    for k in range(seats):
        base[order[k]] += 1
    if n_groups >= 3:
        for i in range(3):
            while base[i] == 0:
                donor = max((j for j in range(3) if j != i and base[j] > 1),
                            key=lambda j: base[j], default=None)
                if donor is None:
                    break
                base[donor] -= 1
                base[i] += 1
    return base


def main(argv=None):
    p = argparse.ArgumentParser(description="CommitBrew Coffee AI 数据集划分")
    p.add_argument("--corpus", nargs="+", default=[f"Tools/CoffeeAI/{DEFAULT_CORPUS_GLOB}"])
    p.add_argument("--meta", nargs="+", default=[f"Tools/CoffeeAI/{DEFAULT_META_GLOB}"])
    p.add_argument("--out", default=f"Tools/CoffeeAI/data/splits")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--train", type=float, default=0.8)
    p.add_argument("--valid", type=float, default=0.1)
    p.add_argument("--test", type=float, default=0.1)
    p.add_argument("--sim-threshold", type=float, default=0.92)
    p.add_argument("--min-train-warn", type=int, default=8,
                   help="训练集少于此样本数时打印明确不足警告")
    p.add_argument("--include-unreviewed", action="store_true",
                   help="显式包含未审核样本（仅供管线演练，正式训练禁止）")
    args = p.parse_args(argv)

    ratios = [args.train, args.valid, args.test]
    if abs(sum(ratios) - 1.0) > 1e-9 or any(r < 0 for r in ratios):
        print(f"[CoffeeAI] 错误: 划分比例 train/valid/test = {ratios} 必须非负且和为 1", file=sys.stderr)
        sys.exit(1)

    # ---- 先完整校验语料（结构性 error 直接拒绝）
    issues, summary = validate(args.corpus, args.meta, None,
                               for_training=not args.include_unreviewed)
    structural = [i for i in issues
                  if i.get("level") == "error"
                  and i.get("code") not in ("not-approved", "license-blocked",
                                            "license-unclear", "missing-fingerprint")]
    if structural:
        print("[CoffeeAI] 语料存在结构性错误，拒绝划分：", file=sys.stderr)
        for i in structural[:20]:
            print(f"  [{i['code']}] {i.get('sample_id', '')} {i['message']}", file=sys.stderr)
        sys.exit(1)

    # ---- 选取可划分样本
    corpus_paths = expand_globs(args.corpus)
    meta_paths = expand_globs(args.meta)
    corpus_recs, _ = load_jsonl(corpus_paths)
    meta_recs, _ = load_jsonl(meta_paths)
    meta_by_id = {m["data"]["sample_id"]: m["data"] for m in meta_recs
                  if isinstance(m["data"].get("sample_id"), str)}

    eligible, excluded = [], []
    for rec in corpus_recs:
        d = rec["data"]
        sid = d.get("sample_id")
        meta = meta_by_id.get(sid, {})
        ok_review = meta.get("review_status") == REVIEW_APPROVED or args.include_unreviewed
        ok_license = str(meta.get("license_status", "")).lower() in LICENSES_ALLOW_TRAIN
        if ok_review and ok_license:
            eligible.append(rec)
        else:
            excluded.append(sid)

    if not args.include_unreviewed and excluded:
        print(f"[CoffeeAI] 已排除未审核/许可不明的样本 {len(excluded)} 条: {sorted(excluded)[:10]}"
              f"{'...' if len(excluded) > 10 else ''}")
    if args.include_unreviewed and excluded:
        print(f"[CoffeeAI] 警告: --include-unreviewed 已包含 {len(excluded)} 条未审核样本，"
              "结果只能用于管线演练，禁止正式训练。")

    if not eligible:
        print("[CoffeeAI] 错误: 没有可用样本（真实训练数据尚未准备好——"
              "请先人工审核样本并把元数据 review_status 置为 approved）。", file=sys.stderr)
        sys.exit(1)

    # ---- 题组 + 高相似自动并组（并查集）
    # 先按 group_id 并组：同一题组的样本（无论是否高相似）必须同集合。
    dsu = DSU()
    by_group = {}
    for rec in eligible:
        dsu.find(str(rec["data"].get("sample_id")))
        gid = rec["data"].get("group_id")
        if gid:
            by_group.setdefault(str(gid), []).append(str(rec["data"].get("sample_id")))
    for gid, sids in by_group.items():
        for s in sids[1:]:
            dsu.union(sids[0], s)
    # 再把高相似但 group_id 不同的样本对并入同组（防止漏标的近似改写跨集合）。
    pairs = near_duplicate_pairs(eligible, threshold=args.sim_threshold)
    merged_pairs = []
    if pairs is None:
        print("[CoffeeAI] 警告: 样本过多，跳过高相似自动并组扫描。")
    else:
        for ida, idb, r in pairs:
            dsu.union(ida, idb)
            merged_pairs.append([ida, idb, round(r, 3)])

    groups = {}
    for rec in eligible:
        d = rec["data"]
        root = dsu.find(str(d.get("sample_id")))
        members = groups.setdefault(root, {"group_ids": set(), "records": []})
        if d.get("group_id"):
            members["group_ids"].add(d["group_id"])
        members["records"].append(d)

    n_groups = len(groups)
    if n_groups < 3:
        print(f"[CoffeeAI] 错误: 可用题组只有 {n_groups} 个（{sum(len(g['records']) for g in groups.values())} 条样本），"
              "不足以同时覆盖 train/valid/test 三个集合而不泄漏。"
              "请继续补充并审核数据——本工具不会伪造数据量凑比例。", file=sys.stderr)
        sys.exit(1)

    # ---- 洗牌 + 分配
    keys = sorted(groups.keys())  # 先排序保证可复现，再洗牌
    rng = random.Random(args.seed)
    rng.shuffle(keys)
    n_train, n_valid, n_test = allocate(n_groups, ratios)
    assignment = {}
    for idx, k in enumerate(keys):
        if idx < n_train:
            assignment[k] = "train"
        elif idx < n_train + n_valid:
            assignment[k] = "valid"
        else:
            assignment[k] = "test"

    # ---- 写文件
    out = Path(args.out)
    if not out.is_absolute():
        out = COFFEEAI_ROOT.parent / out  # 相对路径一律基于仓库根
    out.mkdir(parents=True, exist_ok=True)

    counts = {"train": 0, "valid": 0, "test": 0}
    warnings = []
    for split in ("train", "valid", "test"):
        records = []
        for k in keys:
            if assignment[k] != split:
                continue
            for d in groups[k]["records"]:
                records.append(d)
        records.sort(key=lambda d: str(d.get("sample_id")))
        with (out / f"{split}.jsonl").open("w", encoding="utf-8") as f:
            for d in records:
                f.write(json.dumps({"messages": d["messages"]}, ensure_ascii=False) + "\n")
        with (out / f"{split}.meta.jsonl").open("w", encoding="utf-8") as f:
            for d in records:
                sid = d.get("sample_id")
                meta = meta_by_id.get(sid, {})
                f.write(json.dumps({
                    "sample_id": sid,
                    "group_id": d.get("group_id"),
                    "merged_group_root": dsu.find(str(sid)),
                    "topic": meta.get("topic"),
                    "review_status": meta.get("review_status"),
                    "license_status": meta.get("license_status"),
                    "data_version": meta.get("data_version"),
                }, ensure_ascii=False) + "\n")
        counts[split] = len(records)

    if counts["train"] < args.min_train_warn:
        warnings.append(f"训练集仅 {counts['train']} 条（< {args.min_train_warn}），"
                        "不足以支撑有效微调——真实训练数据尚未准备好，本次结果仅可用于验证流程。")

    group_to_split = {}
    for k in keys:
        for gid in groups[k]["group_ids"]:
            group_to_split[gid] = assignment[k]

    report = {
        "tool": "split_dataset",
        "seed": args.seed,
        "ratios": {"train": args.train, "valid": args.valid, "test": args.test},
        "sim_threshold": args.sim_threshold,
        "corpus_sha256": corpus_sha256(corpus_paths),
        "eligible_samples": len(eligible),
        "excluded_samples": len(excluded),
        "n_groups_after_merge": n_groups,
        "merged_near_duplicate_pairs": merged_pairs,
        "counts": counts,
        "group_assignment": group_to_split,
        "insufficient_data": counts["train"] < args.min_train_warn,
        "warnings": warnings,
        "outputs": {s: str(out / f"{s}.jsonl") for s in counts},
    }
    (out / "split_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # ---- 自检：跨集合泄漏复核
    self_issues = []
    from validate_data import check_splits_dir
    s_issues, _ = check_splits_dir(out, args.sim_threshold)
    self_issues = [i for i in s_issues if i["level"] == "error"]
    if self_issues:
        for i in self_issues:
            print(f"[CoffeeAI] 自检失败 [{i['code']}]: {i['message']}", file=sys.stderr)
        sys.exit(1)

    print("=" * 62)
    print("CommitBrew Coffee AI — 数据集划分完成")
    print("=" * 62)
    print(f"种子       : {args.seed}   比例: {ratios}")
    print(f"可用样本   : {len(eligible)} 条 / {n_groups} 组（并组对 {len(merged_pairs)} 对）")
    print(f"排除样本   : {len(excluded)} 条（未审核或许可不明）")
    print(f"train/valid/test: {counts['train']} / {counts['valid']} / {counts['test']}")
    for w in warnings:
        print(f"⚠️  {w}")
    print(f"输出目录   : {out}")
    print(f"划分报告   : {out / 'split_report.json'}")
    if warnings:
        print("结论: 划分已生成，但数据量不足——请继续准备真实训练数据。")
    else:
        print("结论: 划分完成且自检通过（无跨集合泄漏）。")
    sys.exit(0)


if __name__ == "__main__":
    main()
