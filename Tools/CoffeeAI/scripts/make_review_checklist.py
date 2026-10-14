#!/usr/bin/env python3
"""make_review_checklist.py — 生成供人工逐条确认的 Markdown 审核清单。

只读 corpus+meta，输出 Markdown。它不会也不能：
  - 修改任何样本的 review_status；
  - 把候选写进 data/corpus 或 data/splits；
  - 触发训练、下载或任何自动批准。
「通过/修改/拒绝」仅为人工勾选框，审核动作由人完成后手工把样本迁入正式语料。

用法:
  python3 Tools/CoffeeAI/scripts/make_review_checklist.py \
      --corpus Tools/CoffeeAI/review_queue/batch1_candidates.jsonl \
      --meta Tools/CoffeeAI/review_queue/batch1_candidates.meta.jsonl \
      --out Tools/CoffeeAI/review_queue/batch1_checklist.md [--title "..."]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from coffeeai_common import expand_globs, load_jsonl  # noqa: E402


def main(argv=None):
    p = argparse.ArgumentParser(description="生成人工审核清单（只读）")
    p.add_argument("--corpus", required=True)
    p.add_argument("--meta", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--title", default="人工审核清单")
    args = p.parse_args(argv)

    corpus_recs, _ = load_jsonl(expand_globs([args.corpus]))
    meta_recs, _ = load_jsonl(expand_globs([args.meta]))
    meta_by_id = {m["data"]["sample_id"]: m["data"] for m in meta_recs}

    out = Path(args.out)
    if not out.is_absolute():
        out = Path.cwd() / out
    out.parent.mkdir(parents=True, exist_ok=True)

    lines = [
        f"# {args.title}",
        "",
        f"> 生成自 `{args.corpus}`，共 {len(corpus_recs)} 条。**全部为 unreviewed 候选。**",
        ">",
        "> 审核规则：",
        "> 1. 逐条核对「事实是否与来源一致 / 口径是否过度确定 / 是否复制了受保护原文」。",
        "> 2. 在下方勾选：通过 / 修改 / 拒绝。**本清单的勾选只是记录，不产生任何自动效果。**",
        "> 3. 「通过」的样本由人工复制进 `data/corpus/` 与 `data/meta/` 并将 `review_status` 改为 `approved`（在 notes 里记审核人与日期），再运行划分脚本。本流程没有任何脚本会替你完成这一步。",
        "> 4. 「拒绝」的样本留在本目录或删除；不要改元数据绕过校验。",
        "",
    ]

    for rec in corpus_recs:
        d = rec["data"]
        sid = d["sample_id"]
        meta = meta_by_id.get(sid, {})
        msgs = d["messages"]
        q = next((m["content"] for m in msgs if m.get("role") == "user"), "")
        a = next((m["content"] for m in reversed(msgs) if m.get("role") == "assistant"), "")
        sources = "、".join(f"`{s}`" for s in meta.get("source_ids", [])) or "（无）"
        claims = "、".join(f"`{c}`" for c in meta.get("claim_ids", [])) or "（无）"
        lines += [
            f"## {sid} ｜ {meta.get('topic', '?')} ｜ 组 `{meta.get('group_id', '?')}`",
            "",
            f"**问：** {q}",
            "",
            f"**答：** {a}",
            "",
            f"- 来源：{sources}",
            f"- 事实锚点：{claims}",
            f"- 来源文档：`{meta.get('source_doc', '?')}`",
            f"- 审核要点：{meta.get('notes', '（无）')}",
            "",
            "- [ ] 通过（原文保留）  - [ ] 修改后通过（改动：____）  - [ ] 拒绝（原因：____）",
            "",
            "---",
            "",
        ]

    out.write_text("\n".join(lines), encoding="utf-8")
    print(f"[OK] 审核清单已生成: {out}（{len(corpus_recs)} 条）")


if __name__ == "__main__":
    main()
