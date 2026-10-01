#!/usr/bin/env python3
"""Finds every string the app can put on screen.

One job: walk the Swift sources and return the set of localisation keys. It is
shared by `generate.py` (to write the tables) and `check.py` (to prove the
tables cover the source), so both sides always agree on what "a key" is.

A key is any string literal containing Chinese, with three normalisations:

* text inside a `//` or `/* */` comment is ignored — the code talks about the
  copy in its comments, and none of that is ever displayed;
* `\\(interpolation)` becomes `%@`, so `Text("还有 \\(n) 天")` and
  `L("还有 %@ 天", String(n))` resolve to the same key;
* a literal that is **only** Chinese punctuation (`"、"`, `"。"`, `"%@：%@"`)
  counts when it sits inside an `L(...)` call. Those have no ideograph, so
  requiring one used to drop them silently — and the consequence was visible:
  an English build joined lists with a full-width comma and ended sentences
  with a full-width stop.

Literals that are internal by construction — log messages, `UserDefaults` keys,
file names — are dropped.
"""

from __future__ import annotations

import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCES = ROOT / "BrewPhase"

CJK = re.compile(r"[\u4e00-\u9fff]")
# 中文标点与全角符号（。，、；「」（）…）——它们不含汉字，但同样是文案：
# 列表分隔符中文写「、」、英文写 ", "，句号中文写「。」、英文写 ". "。
PUNCTUATION = re.compile(r"[\u3000-\u303f\uff01-\uff5e]")
LITERAL = re.compile(r'"((?:[^"\\]|\\.)*)"')
INTERPOLATION = re.compile(r"\\\([^)]*\)")


def strip_comments(source: str) -> str:
    """Remove comments, leaving string literals intact."""
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    kept = []
    for line in source.split("\n"):
        index, in_string, escaped, cut = 0, False, False, None
        while index < len(line):
            char = line[index]
            if in_string:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    in_string = False
            else:
                if char == '"':
                    in_string = True
                elif char == "/" and index + 1 < len(line) and line[index + 1] == "/":
                    cut = index
                    break
            index += 1
        kept.append(line[:cut] if cut is not None else line)
    return "\n".join(kept)


def is_internal(text: str, line: str) -> bool:
    if "AppLog." in line:
        return True
    if text.startswith("brewphase."):
        return True
    return False


def source_keys() -> set[str]:
    keys: set[str] = set()
    for path in sorted(SOURCES.rglob("*.swift")):
        for line in strip_comments(path.read_text(encoding="utf-8")).split("\n"):
            for match in LITERAL.finditer(line):
                text = match.group(1)
                if is_internal(text, line):
                    continue
                # 汉字一律算键；只有标点的情况要额外看它在哪——`L("、")` 是要翻译
                # 的列表分隔符，而 `CharacterSet(charactersIn: "。，")` 是解析用的
                # 字符集合，后者永远不该进文案表。判据就是「在不在 `L(` 调用里」，
                # 因为 `L()` 的参数按定义就是给用户看的文案。
                if not CJK.search(text) and not (PUNCTUATION.search(text) and "L(" in line):
                    continue
                keys.add(INTERPOLATION.sub("%@", text))
    return keys


def interpolated_cjk_literals() -> list[tuple[str, int, str]]:
    """Literals that still interpolate *and* are localisable.

    These are a bug in waiting: SwiftUI turns `Text("\\(n) 天")` into the key
    `"%lld 天"`, which no table here can hold, because this project uses `%@`
    with a string argument everywhere else.
    """
    found: list[tuple[str, int, str]] = []
    for path in sorted(SOURCES.rglob("*.swift")):
        for number, line in enumerate(strip_comments(path.read_text(encoding="utf-8")).split("\n"), 1):
            for match in LITERAL.finditer(line):
                text = match.group(1)
                if not CJK.search(text) or is_internal(text, line):
                    continue
                if INTERPOLATION.search(text) and "L(" not in line:
                    found.append((str(path.relative_to(ROOT)), number, text))
    return found


# A literal sitting on the right-hand side of `=` or `return` is the way a
# translatable string escapes `L()` — it ends up in a `String` and then reaches
# `Text(thatString)`, which renders verbatim and is never looked up.
BARE = re.compile(r'(?:\breturn|=)\s*("[^"]*")')

# Deliberately not translated, with the reason. Keep this list short: every entry
# is a string that will read as the wrong language somewhere.
BARE_ALLOWED: dict[str, str] = {
    "简体中文": "a language is named in its own language, in every interface language",
}


def bare_cjk_literals() -> list[tuple[str, int, str]]:
    found: list[tuple[str, int, str]] = []
    for path in sorted(SOURCES.rglob("*.swift")):
        for number, line in enumerate(strip_comments(path.read_text(encoding="utf-8")).split("\n"), 1):
            if "AppLog." in line:
                continue
            for match in BARE.finditer(line):
                text = match.group(1)[1:-1]
                if not CJK.search(text) or text in BARE_ALLOWED:
                    continue
                # Already going through one of the two channels: an `L()` call, or
                # a property whose type is a LocalizedStringKey, which SwiftUI
                # looks up itself.
                if "L(" in line or "LocalizedStringKey" in line:
                    continue
                found.append((str(path.relative_to(ROOT)), number, line.strip()[:110]))
    return found
