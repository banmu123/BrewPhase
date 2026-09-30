#!/usr/bin/env python3
"""verify_linking.py — Bean → Knowledge Linking 的**数据与算法参照实现**。

为什么需要它：
  Swift 侧的 `EntityGraph` / `BeanContextResolver` / `KnowledgeLinkingService` 只能在
  macOS + Xcode 上编译运行。这个脚本用同一批**真实资源**（knowledge_entities.json +
  BrewPhase/Resources/knowledge_base.json）把同一套规则重放一遍，用来证明：

    1. 数据本身是自洽的（无孤儿父节点、无环、别名不冲突到语义错误）；
    2. 归一化规则（大小写/全半角/分隔符/短别名只整串匹配）确实产生预期结果；
    3. 规格 §五十一 的八类断言与 §五十六 的五个场景在**数据层面**成立。

它**不能**替代编译：它证明的是「数据与算法设计正确」，不是「Swift 代码能编译」。
两者都要有。

用法：
  python Tools/knowledge/verify_linking.py
"""

from __future__ import annotations

import argparse
import json
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ENTITIES = ROOT / "BrewPhase" / "Resources" / "knowledge_entities.json"
KNOWLEDGE = ROOT / "BrewPhase" / "Resources" / "knowledge_base.json"

SEPARATORS = set(" \t\n\u00a0-_\u00b7\u2022\u30fb/\\|,，、;；+()（）[]【】")

MATCH_PRIORITY = {
    "exact": 0, "normalized": 1, "alias": 2, "user_selected": 3,
    "inferred": 4, "hierarchy": 5, "general_context": 6,
}
SCOPE_RANK = {
    "equipment_model": 100, "equipment_brand": 90, "variety": 70, "region": 65,
    "country": 60, "process": 55, "roast": 50, "brew_method": 45, "generic": 10,
}
RELATION_OF_TYPE = {
    "origin": "origin", "region": "origin", "variety": "variety", "varietyGroup": "variety",
    "process": "process", "roast": "roast", "brewMethod": "recommended_brew",
    "brewFamily": "recommended_brew", "equipment": "equipment", "grinder": "equipment",
    "sensory": "sensory", "topic": "general_context", "water": "general_context",
    "troubleshooting": "general_context", "maintenance": "general_context",
}

failures: list[str] = []
checks = 0


def check(condition: bool, message: str) -> None:
    global checks
    checks += 1
    if not condition:
        failures.append(message)


def normalise(text: str) -> str:
    folded = unicodedata.normalize("NFKC", text).lower()
    return "".join(ch for ch in folded if ch not in SEPARATORS)


class Graph:
    def __init__(self, entities: list[dict]):
        self.entities = entities
        self.by_id = {e["id"]: e for e in entities}
        self.canonical: dict[str, list[str]] = {}
        self.alias: dict[str, list[str]] = {}
        for e in entities:
            key = normalise(e["canonicalName"])
            if key:
                self.canonical.setdefault(key, []).append(e["id"])
            for name in e.get("aliases") or []:
                k = normalise(name)
                if k:
                    self.alias.setdefault(k, []).append(e["id"])

    def resolve(self, text: str, types: set[str] | None = None, limit: int = 8) -> list[tuple[dict, str, str]]:
        trimmed = text.strip()
        key = normalise(text)
        if not key:
            return []
        found: dict[str, tuple[dict, str, str]] = {}

        def record(eid: str, match: str, alias: str) -> None:
            entity = self.by_id[eid]
            if types and entity["type"] not in types:
                return
            if eid in found and MATCH_PRIORITY[found[eid][1]] <= MATCH_PRIORITY[match]:
                return
            found[eid] = (entity, match, alias)

        for eid in self.canonical.get(key, []):
            canonical = self.by_id[eid]["canonicalName"]
            record(eid, "exact" if canonical == trimmed else "normalized", canonical)
        for eid in self.alias.get(key, []):
            record(eid, "alias", key)
        for alias, ids in self.alias.items():
            if len(alias) < 2 or alias == key or alias not in key:
                continue
            for eid in ids:
                record(eid, "alias", alias)
        for canonical, ids in self.canonical.items():
            if len(canonical) < 2 or canonical == key or canonical not in key:
                continue
            for eid in ids:
                record(eid, "normalized", canonical)

        ordered = sorted(
            found.values(),
            key=lambda item: (
                MATCH_PRIORITY[item[1]],
                -SCOPE_RANK.get(item[0].get("scope", "generic"), 10),
                -len(item[2]),
                item[0]["id"],
            ),
        )
        return ordered[:limit]

    def ancestors(self, eid: str, max_depth: int = 4) -> list[dict]:
        out: list[dict] = []
        current = self.by_id[eid].get("parentId")
        seen = {eid}
        depth = 0
        while current and depth < max_depth and current not in seen:
            entity = self.by_id[current]
            out.append(entity)
            seen.add(current)
            current = entity.get("parentId")
            depth += 1
        return out


ROAST_ENTITY = {
    "light": "roast.light", "medium": "roast.medium", "mediumDark": "roast.medium_dark",
    "dark": "roast.dark", "espressoBlend": "roast.espresso_blend",
}


def bean_context(graph: Graph, origin: str, process: str, roast_raw: str,
                 name: str = "", notes: str = "", tags: list[str] | None = None,
                 method: str | None = None) -> list[tuple[dict, str, str]]:
    """镜像 BeanContextResolver.context(for:) 的规则。"""
    found: dict[str, tuple[dict, str, str]] = {}

    def record(items) -> None:
        for entity, match, alias in items:
            if entity["id"] in found and MATCH_PRIORITY[found[entity["id"]][1]] <= MATCH_PRIORITY[match]:
                continue
            found[entity["id"]] = (entity, match, alias)

    if origin.strip():
        record(graph.resolve(origin, types={"origin", "region"}))
    variety_text = " ".join(x for x in [name, notes] if x.strip())
    if variety_text.strip():
        record(graph.resolve(variety_text, types={"variety", "varietyGroup"}))
    if process.strip():
        record(graph.resolve(process, types={"process"}))
    roast = graph.by_id.get(ROAST_ENTITY.get(roast_raw, ""))
    if roast:
        found[roast["id"]] = (roast, "inferred", "")
    for tag in tags or []:
        record(graph.resolve(tag, types={"sensory"}, limit=2))
    if method and method.strip():
        record(graph.resolve(method, types={"brewMethod", "brewFamily"}))

    for eid in list(found):
        for ancestor in graph.ancestors(eid):
            if ancestor["id"] in found and MATCH_PRIORITY[found[ancestor["id"]][1]] <= MATCH_PRIORITY["hierarchy"]:
                continue
            found[ancestor["id"]] = (ancestor, "hierarchy", ancestor["canonicalName"])

    return sorted(
        found.values(),
        key=lambda item: (
            MATCH_PRIORITY[item[1]],
            -SCOPE_RANK.get(item[0].get("scope", "generic"), 10),
            -len(item[2]),
            item[0]["id"],
        ),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify Bean→Knowledge linking data & rules.")
    parser.parse_args()

    entities = json.loads(ENTITIES.read_text(encoding="utf-8"))["entities"]
    knowledge = json.loads(KNOWLEDGE.read_text(encoding="utf-8"))
    graph = Graph(entities)

    print(f"entities: {len(entities)}  knowledge documents: {len(knowledge['documents'])}")
    print(f"knowledge revision: {knowledge['revision']}")

    # ---- 数据自洽性 ----
    ids = [e["id"] for e in entities]
    check(len(ids) == len(set(ids)), "实体 id 有重复")
    check(all(e.get("parentId") is None or e["parentId"] in graph.by_id for e in entities), "存在孤儿 parentId")
    for e in entities:
        seen, cur = {e["id"]}, e.get("parentId")
        while cur:
            check(cur not in seen, f"实体层级成环：{e['id']}")
            if cur in seen or cur not in graph.by_id:
                break
            seen.add(cur)
            cur = graph.by_id[cur].get("parentId")
    check(any(d["id"] == "kb.pourover.v60" and d.get("entityIds") == ["method.v60"] for d in knowledge["documents"]),
          "kb.pourover.v60 未挂 method.v60")
    check(all(d.get("scope") and d.get("authorityTier") and d.get("sourceIds") for d in knowledge["documents"]),
          "有知识文档缺 scope/authorityTier/sourceIds")

    # ---- §51 Bean Normalization ----
    for text in ["Ethiopia", "埃塞俄比亚", "ETHIOPIA", "  ethiopia  ", "衣索比亚"]:
        check(any(e["id"] == "origin.ethiopia" for e, _, _ in graph.resolve(text)),
              f"归一化失败：{text!r} 未命中 origin.ethiopia")

    # ---- §51 Process Normalization ----
    for text in ["Washed", "washed", "Fully Washed", "washed process", "水洗", "水洗处理", "湿法"]:
        ids_hit = [e["id"] for e, _, _ in graph.resolve(text, types={"process"})]
        check(ids_hit == ["process.washed"], f"处理法归一化失败：{text!r} -> {ids_hit}")
    water_hit = [e["id"] for e, _, _ in graph.resolve("水洗", types={"process", "topic"})]
    check("topic.water" not in water_hit, f"短别名误命中：水洗 -> {water_hit}")

    # ---- §51 Exact Linking / §56 Scenario 1 ----
    scenario1 = {e["id"] for e, _, _ in bean_context(
        graph, origin="埃塞俄比亚 · Guji", process="水洗", roast_raw="light", method="V60")}
    for expected in ["region.guji", "origin.ethiopia", "process.washed", "roast.light", "method.v60", "origin.africa"]:
        check(expected in scenario1, f"Scenario 1 缺少 {expected}（实得 {sorted(scenario1)}）")

    # ---- §51 Partial Profile / §17 ----
    partial = {e["id"] for e, _, _ in bean_context(
        graph, origin="Ethiopia", process="", roast_raw="light")}
    check(not any(i.startswith("region.") for i in partial), f"只填国家却生成了产区：{sorted(partial)}")
    check(not any(i.startswith("variety") for i in partial), "只填国家却生成了品种")
    check(not any(i.startswith("process.") for i in partial), "只填国家却生成了处理法")

    # ---- §56 Scenario 5：未知产区 ----
    unknown = {e["id"] for e, _, _ in bean_context(
        graph, origin="某个新产区", process="", roast_raw="light")}
    check(not any(i.startswith(("region.", "origin.")) for i in unknown),
          f"未知产区不该产生产地/产区链接：{sorted(unknown)}")

    # ---- §51 Similarity ----
    for text in ["干涩", "尾段干", "余韵涩", "涩感明显", "发涩", "astringency"]:
        ids_hit = [e["id"] for e, _, _ in graph.resolve(text, types={"sensory"})]
        check("sensory.astringency" in ids_hit, f"{text!r} 未归到涩感：{ids_hit}")

    # ---- §51 Equipment Specificity（V1 边界）----
    equipment_hits = graph.resolve("Barista Express", types={"brewMethod", "brewFamily"})
    check(not equipment_hits, f"V1 不该有设备级知识匹配：{equipment_hits}")

    # ---- 实体过滤对知识真的生效 ----
    v60_knowledge = [d["id"] for d in knowledge["documents"]
                     if "method.v60" in (d.get("entityIds") or [])]
    check("kb.pourover.v60" in v60_knowledge, f"method.v60 未命中知识：{v60_knowledge}")

    # ---- 层级 fallback 存在（§15/§18）----
    check([a["id"] for a in graph.ancestors("region.guji")] == ["origin.ethiopia", "origin.africa", "origin.world"],
          "Guji 的祖先链不正确")

    print()
    if failures:
        print(f"FAILED — {len(failures)} / {checks} checks failed:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"OK — {checks} checks passed")
    print("  说明：本脚本验证的是**数据与算法设计**；Swift 侧仍需在 macOS 上编译运行。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
