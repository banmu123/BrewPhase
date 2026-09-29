#!/usr/bin/env python3
"""Proves the string tables are complete and safe to ship.

    python3 Tools/Localization/check.py      # exit 1 means something would break

Five things are checked, in order of how badly they bite:

1. **Placeholder counts.** Foundation fills `%@` positionally. A translation with
   one placeholder too many reads past the arguments and crashes with
   `EXC_BAD_ACCESS` — in a branch nobody visits until a reviewer does.
2. **Every key the source uses is in the tables.** A missing key is not a crash,
   it is Chinese text on an English screen.
3. **Both tables list the same keys.** A key in one language only means one
   language quietly falls back to the other.
4. **No key is defined twice.** A duplicated key in `strings.py` silently drops
   one of the two translations.
5. **No localisable literal still interpolates.** `Text("\\(n) 天")` becomes the
   untranslatable key `"%lld 天"`.
"""

from __future__ import annotations

import ast
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from keys import bare_cjk_literals, interpolated_cjk_literals, source_keys  # noqa: E402
from strings import EN  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
APP = ROOT / "BrewPhase"
TABLES = {
    "en": APP / "en.lproj" / "Localizable.strings",
    "zh-Hans": APP / "zh-Hans.lproj" / "Localizable.strings",
}
ENTRY = re.compile(r'^"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;$')
PLACEHOLDER = re.compile(r"%(?:@|lld|d|lf|f)")


def parse_table(path: pathlib.Path) -> dict[str, str]:
    entries: dict[str, str] = {}
    if not path.exists():
        return entries
    for line in path.read_text(encoding="utf-8").split("\n"):
        line = line.strip()
        if not line or line.startswith("/*"):
            continue
        match = ENTRY.match(line)
        if match:
            entries[match.group(1)] = match.group(2)
    return entries


def duplicate_keys_in_table_source() -> list[str]:
    """Keys the same dict literal defines twice — the later one wins silently."""
    tree = ast.parse((pathlib.Path(__file__).parent / "strings.py").read_text(encoding="utf-8"))
    seen: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            names = [k.value for k in node.keys if isinstance(k, ast.Constant)]
            for name in set(names):
                if names.count(name) > 1 and name not in seen:
                    seen.append(name)
    return seen


def main() -> int:
    failures: list[str] = []
    keys = source_keys()
    tables = {name: parse_table(path) for name, path in TABLES.items()}

    # 1 — placeholder counts.
    mismatched = []
    for key, english in EN.items():
        expected, actual = len(PLACEHOLDER.findall(key)), len(PLACEHOLDER.findall(english))
        if expected != actual:
            mismatched.append(f'  "{key}"\n    source has {expected}, English has {actual}\n    -> "{english}"')
    if mismatched:
        failures.append(
            "placeholder count differs between source and English "
            f"({len(mismatched)} key(s)) — this crashes at runtime:\n" + "\n".join(mismatched)
        )

    # 2 — coverage of the source.
    missing_en = sorted(keys - set(EN))
    missing_table = {name: sorted(keys - set(table)) for name, table in tables.items()}
    if missing_en:
        failures.append(
            f"{len(missing_en)} key(s) in the source have no English translation:\n"
            + "\n".join(f'  "{key}"' for key in missing_en)
        )
    for name, missing in missing_table.items():
        if missing:
            failures.append(
                f"{len(missing)} key(s) missing from {name}.lproj "
                "(run generate.py):\n" + "\n".join(f'  "{key}"' for key in missing)
            )

    # 3 — the two tables agree.
    if tables["en"] and tables["zh-Hans"]:
        only_en = sorted(set(tables["en"]) - set(tables["zh-Hans"]))
        only_zh = sorted(set(tables["zh-Hans"]) - set(tables["en"]))
        if only_en or only_zh:
            failures.append(
                "the two tables do not list the same keys:\n"
                + "\n".join(f"  en only: {key}" for key in only_en)
                + "\n".join(f"  zh-Hans only: {key}" for key in only_zh)
            )

    # 4 — duplicated definitions.
    duplicates = duplicate_keys_in_table_source()
    if duplicates:
        failures.append(
            "strings.py defines these keys more than once, so one translation is lost:\n"
            + "\n".join(f'  "{key}"' for key in duplicates)
        )

    # 5 — literals that would produce an untranslatable `%lld` key.
    leftovers = interpolated_cjk_literals()
    if leftovers:
        failures.append(
            f"{len(leftovers)} localisable literal(s) still interpolate, which makes a key "
            "no table can hold — use L() with %@ instead:\n"
            + "\n".join(f"  {path}:{line}  {text}" for path, line, text in leftovers)
        )

    # 6 — a real newline in a key or a translation is invalid in a .strings file.
    #     It has to be written `\\n` so the parser turns it into a line break.
    raw_newlines = [key for key in list(EN) + list(EN.values()) if "\n" in key]
    if raw_newlines:
        failures.append(
            f"{len(raw_newlines)} key(s) or translation(s) contain a real newline, which "
            "breaks the .strings format — write it as \\\\n:\n"
            + "\n".join(f"  {key!r}" for key in raw_newlines)
        )

    # 7 — a translatable literal assigned or returned bare. This is how a string
    #     escapes `L()` and reaches `Text(someVariable)` verbatim, which no
    #     screenshot sweep can catch: the branches involved are error paths and
    #     empty states that a normal run never reaches.
    escaped = bare_cjk_literals()
    if escaped:
        failures.append(
            f"{len(escaped)} string(s) are assigned or returned without L(), so they will "
            "not be translated:\n"
            + "\n".join(f"  {path}:{line}\n      {text}" for path, line, text in escaped)
        )

    if failures:
        print("Localisation check FAILED\n")
        for failure in failures:
            print(f"* {failure}\n")
        return 1

    print(f"Localisation check passed — {len(keys)} keys, both tables complete, "
          f"placeholder counts match.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
