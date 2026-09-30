#!/usr/bin/env python3
"""build_kb.py — 把 knowledge/ 的富知识库编译为 BrewPhase 可消费的 knowledge_base.json。

设计原则（规格 §53/§54/§55 + Bean→Knowledge Linking 架构审查 §9）：
  1. 富知识库（knowledge/**）是「研究层」；App 消费的是「编译产物」。
  2. 编译前做三重校验：
     a. 文档引用的 sourceId 必须已注册，且不得引用 pending-verification 来源；
     b. 文档引用的 entityId 必须存在于 knowledge_entities.json；
     c. 必需字段与双语文案完整性。
  3. 编译产物写 `knowledge/_build/knowledge_base.v2.json`；加 `--apply` 时**同时**
     覆写 `BrewPhase/Resources/knowledge_base.json`（决策 B2：换用 v2）。
  4. 输出格式与 `BrewPhase/RAG/Indexing/KnowledgeBase.swift` 的解析器兼容
     （revision / provenance / documents[{id, category, source, title, content}]），
     额外元数据（sourceIds / authorityTier / applicability / entityIds / scope）供
     Bean→Knowledge Linking 与 applicability 排序使用。

用法：
  python Tools/knowledge/build_kb.py            # 校验 + 编译到 _build/
  python Tools/knowledge/build_kb.py --apply    # 额外覆写 App 资源
  python Tools/knowledge/build_kb.py --check     # 只校验
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
KNOWLEDGE = ROOT / "knowledge"
REGISTRY = KNOWLEDGE / "SOURCE_REGISTRY.json"
DOCUMENTS = KNOWLEDGE / "_build" / "documents.json"
OUTPUT = KNOWLEDGE / "_build" / "knowledge_base.v2.json"
APP_RESOURCE = ROOT / "BrewPhase" / "Resources" / "knowledge_base.json"
ENTITIES = ROOT / "BrewPhase" / "Resources" / "knowledge_entities.json"

REQUIRED_DOC_KEYS = {"id", "title", "category", "content", "sourceIds", "authorityTier"}
REQUIRED_LANGS = {"zh-Hans", "en"}

# 分离符：与 Swift 侧 EntityGraph / normalised 保持一致
_SEPARATORS = set(" \t\n\u00a0-_\u00b7\u2022\u30fb/\\|,，、;；+()（）[]【】")

# applicability → scope（规格 §十三 的枚举），仅在文档未显式声明 scope 时作为回退。
# 注意：`specific_model` 表达的是「这条知识按型号而异」，**不等于**「这条知识是关于某型号的」，
# 所以它排在通用档之后，避免把 topic 级知识误标成 equipment_model。
_SCOPE_ENUM = {
    "generic", "country", "region", "variety", "process", "roast",
    "brew_method", "equipment_brand", "equipment_model",
}
_SCOPE_BY_APPLICABILITY = [
    ("specific_region", "region"),
    ("specific_bean", "variety"),
    ("specific_species", "variety"),
    ("specific_roast", "roast"),
    ("pour_over", "brew_method"),
    ("espresso", "brew_method"),
    ("immersion", "brew_method"),
    ("specific_brand", "equipment_brand"),
    ("specific_model", "equipment_model"),
    ("generic", "generic"),
]


def normalise(text: str) -> str:
    """NFKC 归一 + 小写 + 去分离符。与 Swift 侧保持同一语义。"""
    folded = unicodedata.normalize("NFKC", text).lower()
    return "".join(ch for ch in folded if ch not in _SEPARATORS)


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def build_alias_index(entities: list[dict]) -> dict[str, list[str]]:
    index: dict[str, list[str]] = {}
    for entity in entities:
        names = [entity["canonicalName"]] + list(entity.get("aliases") or [])
        for name in names:
            key = normalise(name)
            if not key:
                continue
            index.setdefault(key, [])
            if entity["id"] not in index[key]:
                index[key].append(entity["id"])
    return index


def resolve_entities(text: str, index: dict[str, list[str]]) -> list[str]:
    """短别名（归一后 1 个字符）只允许精确匹配，避免「水洗」误命中别名「水」。"""
    key = normalise(text)
    if not key:
        return []
    found: list[str] = []
    if key in index:
        found.extend(index[key])
    for alias, ids in index.items():
        if len(alias) < 2 or alias == key:
            continue
        if alias in key:
            for entity_id in ids:
                if entity_id not in found:
                    found.append(entity_id)
    return found


def derive_scope(doc: dict) -> str:
    """显式 scope 优先（作者声明最可信）；否则从 applicability 回退推导。"""
    explicit = doc.get("scope")
    if explicit:
        if explicit not in _SCOPE_ENUM:
            raise ValueError(f"{doc.get('id')}: scope 不在枚举内 -> {explicit}")
        return explicit
    applicable = set(doc.get("applicability") or [])
    for key, scope in _SCOPE_BY_APPLICABILITY:
        if key in applicable:
            return scope
    return "generic"


def validate(registry: dict, payload: dict, entities: list[dict], index: dict[str, list[str]]) -> list[str]:
    problems: list[str] = []

    known_sources = {e["sourceId"] for e in registry["sources"]}
    pending_sources = {e["sourceId"] for e in registry["sources"] if e["status"] == "pending-verification"}
    known_entities = {e["id"] for e in entities}
    seen: set[str] = set()

    for doc in payload.get("documents", []):
        doc_id = doc.get("id", "<missing id>")

        missing = REQUIRED_DOC_KEYS - set(doc)
        if missing:
            problems.append(f"{doc_id}: 缺少必需字段 {sorted(missing)}")

        if doc_id in seen:
            problems.append(f"{doc_id}: id 重复")
        seen.add(doc_id)

        if not doc_id.startswith("kb."):
            problems.append(f"{doc_id}: id 必须以 kb. 开头")

        content = doc.get("content", {})
        for lang in REQUIRED_LANGS - set(content):
            problems.append(f"{doc_id}: content 缺少语言 {lang}")
        for lang, text in content.items():
            if not isinstance(text, str) or len(text) < 40:
                problems.append(f"{doc_id}: content[{lang}] 过短或类型错误")

        tier = doc.get("authorityTier")
        if not isinstance(tier, int) or not 1 <= tier <= 4:
            problems.append(f"{doc_id}: authorityTier 必须是 1–4 的整数")

        source_ids = doc.get("sourceIds") or []
        if not source_ids:
            problems.append(f"{doc_id}: sourceIds 为空 —— 规格禁止无来源知识")
        for sid in source_ids:
            if sid not in known_sources:
                problems.append(f"{doc_id}: 引用了未注册来源 {sid}")
            elif sid in pending_sources:
                problems.append(f"{doc_id}: 引用了 pending-verification 来源 {sid}（禁止作为事实来源）")

        for eid in resolved_entity_ids(doc, index):
            if eid not in known_entities:
                problems.append(f"{doc_id}: 引用了不存在的实体 {eid}")

        for fact in doc.get("facts", []):
            if len(fact) < 8:
                problems.append(f"{doc_id}: facts 条目过短 -> {fact!r}")

    return problems


def resolved_entity_ids(doc: dict, index: dict[str, list[str]]) -> list[str]:
    """显式 entityIds 优先，其次从自由文本 entities 解析；合并去重且保序。"""
    out: list[str] = []

    def add(entity_id: str) -> None:
        if entity_id not in out:
            out.append(entity_id)

    for entity_id in doc.get("entityIds") or []:
        add(entity_id)
    for name in doc.get("entities") or []:
        for entity_id in resolve_entities(name, index):
            add(entity_id)
    return out


def compile_payload(registry: dict, payload: dict, index: dict[str, list[str]]) -> dict:
    source_titles = {e["sourceId"]: e["title"] for e in registry["sources"]}
    documents = []

    for doc in payload["documents"]:
        first = doc["sourceIds"][0]
        display = source_titles.get(first, first)
        if len(doc["sourceIds"]) > 1:
            display = f"{display} 等 {len(doc['sourceIds'])} 个来源"

        documents.append(
            {
                "id": doc["id"],
                "category": doc["category"],
                "source": display,
                "title": doc["title"],
                "content": doc["content"],
                # --- 以下为 app 解析层忽略、但 Linking / 排序层需要 ---
                "sourceIds": doc["sourceIds"],
                "authorityTier": doc["authorityTier"],
                "applicability": doc.get("applicability", []),
                "scope": derive_scope(doc),
                "entityIds": resolved_entity_ids(doc, index),
                "summary": doc.get("summary"),
                "keywords": doc.get("keywords", []),
                "entities": doc.get("entities", []),
                "licenseNote": doc.get("licenseNote"),
                "updatedAt": doc.get("updatedAt"),
            }
        )

    return {
        "revision": 2,
        "provenance": {
            "zh-Hans": (
                "BrewPhase 知识库 v2：每条内容都可追溯到 knowledge/SOURCE_REGISTRY.json 中的具体来源，"
                "并标注权威等级、适用范围与知识实体。不是抓取的原文，而是基于来源的独立改写。"
                "涉及设备操作与健康的内容请以该型号官方手册与监管机构信息为准。"
            ),
            "en": (
                "The BrewPhase knowledge base, v2: every entry traces back to a specific source in "
                "knowledge/SOURCE_REGISTRY.json, annotated with an authority tier, applicability and "
                "knowledge entities. Nothing here is scraped text; it is source-backed rewriting. For "
                "device operation and health, defer to that model's official manual and to regulator guidance."
            ),
        },
        "generatedAt": date.today().isoformat(),
        "documents": documents,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Compile the BrewPhase knowledge base.")
    parser.add_argument("--check", action="store_true", help="validate only, write nothing")
    parser.add_argument("--apply", action="store_true", help="also overwrite BrewPhase/Resources/knowledge_base.json")
    args = parser.parse_args()

    registry = load_json(REGISTRY)
    payload = load_json(DOCUMENTS)
    entities = load_json(ENTITIES)["entities"]
    index = build_alias_index(entities)

    problems = validate(registry, payload, entities, index)
    if problems:
        print(f"FAILED — {len(problems)} problem(s):")
        for problem in problems:
            print(f"  - {problem}")
        return 1

    compiled = compile_payload(registry, payload, index)
    tiers: dict[int, int] = {}
    scopes: dict[str, int] = {}
    linked = 0
    for doc in compiled["documents"]:
        tiers[doc["authorityTier"]] = tiers.get(doc["authorityTier"], 0) + 1
        scopes[doc["scope"]] = scopes.get(doc["scope"], 0) + 1
        if doc["entityIds"]:
            linked += 1

    print("OK — validation passed")
    print(f"  sources in registry : {len(registry['sources'])}")
    print(f"  entities in graph   : {len(entities)}")
    print(f"  documents compiled  : {len(compiled['documents'])}")
    print(f"  docs with entities  : {linked}")
    print(f"  by authority tier   : {dict(sorted(tiers.items()))}")
    print(f"  by scope            : {dict(sorted(scopes.items()))}")

    if args.check:
        print("  (--check) no file written")
        return 0

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(compiled, ensure_ascii=False, indent=2) + "\n"
    OUTPUT.write_text(body, encoding="utf-8")
    print(f"  wrote               : {OUTPUT.relative_to(ROOT)}")

    if args.apply:
        APP_RESOURCE.write_text(body, encoding="utf-8")
        print(f"  applied             : {APP_RESOURCE.relative_to(ROOT)}")
    else:
        print("  NOTE: App 资源未改动；加 --apply 才会覆写。")

    return 0


if __name__ == "__main__":
    sys.exit(main())
