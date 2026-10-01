# BrewPhase 项目长期约定

跨会话都要遵守的项目级事实与规矩。日常流水记在 `YYYY-MM-DD.md`。

## 本地化流水线（`Tools/Localization/`）

* 文案键 = **源码里的中文字面量**，`strings.py` 的 `EN` 给英文；`generate.py` 只把
  `source_keys()` 里出现过的键写进两个 `.lproj` 表，所以**表里没有的键在运行时会
  原样返回键本身**。
* **只由标点组成的键进不了表**：`keys.py` 的收集条件是「字面量含 `\u4e00-\u9fff`」，
  所以 `"："`、`"、 "`、`"%@：%@"` 这类键会被静默跳过（`check.py` 也不会报，因为
  它同样从 `source_keys()` 出发）。后果是英文界面下露出中文的全角冒号。
  → 做法：把标点连同它前后**至少一个汉字**写进同一个键（`"保持不变：%@"`），
  或者用不翻译的排版符号（`" · "`）拼接。`AdjustmentSuggestion.headline` 的
  `L("%@：%@")` 就是这条坑的现存样例（英文下会显示全角冒号）。
* `check.py` 五条：占位符数量、键是否齐全、两表键集一致、同键不重复定义、
  可本地化字面量不能再插值（`Text("\(n) 天")` 会变成不可翻译的键）。
  含插值又含汉字、且同一行没有 `L(` 的字面量会被判违规。
* 改完文案必须跑 `generate.py && check.py`（当前 806 键）。

## 测试与模拟器

* 真实验收口径是 `xcodebuild test` 全量 + 模拟器截图 + OSLog，三者对得上才算过。
* 单测**必须**在 `setUp` 里 `LanguageManager.pinForTesting(.simplifiedChinese)`：
  语言偏好存在 App 的 UserDefaults 里，测试宿主与 App 共用容器，
  `Tools/run.sh --lang en` 会把它改成 en，之后断言中文文案的测试就会红。
* `Tools/run.sh` 的截图与 `xcodebuild test` **不能同时跑**：测试宿主会抢走模拟器
  并重启 App，截图会拍到别的界面。先截图，再跑全量。
* `xcodebuild` 一律带 `CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO`，
  并显式指定模拟器 `platform=iOS Simulator,id=810C6408-DCAB-469B-8D4B-5018BCC9C0FD`。

## 代码风格

* 阈值集中在 `RAG/Rules/IntelligenceConfig.swift`；中文词表放 `Resources/*.json`
  （词表进 Swift 会被本地化流水线当成文案收键）。
* 纯逻辑放 `Core/`（Foundation），视图放 `Shared/Components/` 与 `Features/`。
* 结构化事实（`fact:*`）可以自带 `AnswerMarkup` 排版标记，界面按它分层渲染；
  引用编号由回答层统一加，事实本身不写 `[n]`。
