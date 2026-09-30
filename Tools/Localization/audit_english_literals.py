#!/usr/bin/env python3
"""补 check.py 的一个盲区：**纯英文**的用户可见文案。

`keys.py` 定义的「一个键」是「含中文的字符串字面量」，于是 generate.py 把 zh-Hans
写成恒等表、en 承载真正的翻译。这套设计对中文优先的代码很顺，但有一个后果：

    一个**不含中文**的字面量，永远不会成为键，永远不会进表，
    于是在**任何一个**语言里都原样显示。

如果它恰好是给用户看的（Text / Label / 按钮标题 / section 标题……），那么英文界面里它
看起来是对的，中文界面里就露出一串英文——而 check.py 不会报，因为它只找中文。

这个脚本反过来找：**出现在用户可见位置的、不含中文的字面量**。

    python3 Tools/Localization/audit_english_literals.py

退出码 1 表示发现了需要人工判断的项（有些是有意为之，见下面的白名单说明）。
"""

from __future__ import annotations

import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from keys import CJK, LITERAL, ROOT, SOURCES, strip_comments  # noqa: E402

# 会直接落到屏幕上的调用点。只查这些，避免把日志、UserDefaults 键、SF Symbol 名
# 这类内部字符串一起捞进来。
USER_FACING = re.compile(
    r"(?:"
    r"Text\(|Label\(|Button\(|bullet\(|"
    r"Chip\(\s*text:|SecondaryButton\(\s*title:|PrimaryButton\(\s*title:|"
    r"EditorRow\(\s*title:|EditorToggleRow\(\s*title:|SectionHeader\(\s*title:|"
    r"EditorTextField\(\s*placeholder:|"
    r"navigationTitle\(|accessibilityLabel\(|"
    r"LocalizedStringKey\(|alert\(|confirmationDialog\("
    r")"
)

# 有意不翻译的，连同理由。跟 keys.py 的 BARE_ALLOWED 一个性质：短，且每条都能说清。
ALLOWED: dict[str, str] = {
    "BrewPhase": "产品名，各国都写 BrewPhase",
    "V60": "器具型号，是专有名词",
    "M2M": "烘焙商名，用户自己填的专有名词",
    "Eureka Mignon": "磨豆机型号",
    "SL28": "品种代号",
}

# 「看起来像文案」的判据：去掉插值之后，至少要有两个由空白分出的、含字母的词。
#
# 这条是为了压掉噪声。实测下来，用户可见位置上的非中文短字面量绝大多数根本不是文案：
#   systemImage: "camera" / "plus" / "trash"      —— SF Symbol 名
#   " · " / "/ "                                  —— 标点
#   "+\(Int(delta))g" / "\(Int(t))°C" / "2:35"     —— 单位与示例
# 它们都不含「两个词」，所以被排除；而真正的句子（含空格、含字母）会留下来。
# 一个审计工具一旦有噪声就会被忽略，所以这里宁可漏报也不误报。
INTERPOLATION = re.compile(r"\\\([^)]*\)")
WORD = re.compile(r"[A-Za-z]{2,}")


def looks_like_prose(text: str) -> bool:
    stripped = INTERPOLATION.sub(" ", text)
    words = [chunk for chunk in stripped.split() if WORD.search(chunk)]
    return len(words) >= 2


def is_symbol_name(line: str, end: int) -> bool:
    """字面量前面紧跟着 systemImage: / systemName: —— 那是 SF Symbol 名，不是文案。"""
    return bool(re.search(r"(?:systemImage|systemName|image)\s*:\s*$", line[:end]))


def is_internal(text: str, line: str) -> bool:
    if "AppLog." in line:
        return True
    if text.startswith("brewphase."):
        return True
    return False


def main() -> int:
    findings: list[tuple[str, int, str, str]] = []

    for path in sorted(SOURCES.rglob("*.swift")):
        for number, line in enumerate(strip_comments(path.read_text(encoding="utf-8")).split("\n"), 1):
            if not USER_FACING.search(line):
                continue
            # verbatim 是有意绕过本地化的，单独看
            verbatim = "verbatim" in line
            for match in LITERAL.finditer(line):
                text = match.group(1)
                if CJK.search(text) or is_internal(text, line):
                    continue
                if text in ALLOWED or not text.strip():
                    continue
                if is_symbol_name(line, match.start()):
                    continue
                # verbatim 的本来就是有意为之，不套「像文案」这一层
                if not verbatim and not looks_like_prose(text):
                    continue
                tag = "verbatim" if verbatim else "可翻译"
                findings.append((str(path.relative_to(ROOT)), number, tag, text))

    if not findings:
        print("没有发现「用户可见但不含中文」的字面量。")
        return 0

    verbatim_items = [f for f in findings if f[2] == "verbatim"]
    plain_items = [f for f in findings if f[2] == "可翻译"]

    if plain_items:
        print(f"* {len(plain_items)} 处用户可见文案不含中文 —— 在中文界面里会露出英文：\n")
        for path, number, _, text in plain_items:
            print(f'  {path}:{number}\n      "{text}"')
        print()

    if verbatim_items:
        print(f"* {len(verbatim_items)} 处 Text(verbatim:) —— 有意不本地化，确认一下是否都该如此：\n")
        for path, number, _, text in verbatim_items:
            print(f'  {path}:{number}\n      "{text}"')
        print()

    print("判据：这些字面量不会成为本地化键，因此在任何语言下都原样显示。")
    print("要么改用 L() 并补上英文/中文两份翻译，要么加进本脚本的 ALLOWED 并写明理由。")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
