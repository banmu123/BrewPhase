# BrewPhase 项目长期约定

跨会话都要遵守的项目级事实与规矩。日常流水记在 `YYYY-MM-DD.md`。

## 本地化流水线（`Tools/Localization/`）

* 文案键 = **源码里的中文字面量**，`strings.py` 的 `EN` 给英文；`generate.py` 只把
  `source_keys()` 里出现过的键写进两个 `.lproj` 表，所以**表里没有的键在运行时会
  原样返回键本身**。
* 收集规则（`keys.py`）：字面量含汉字 → 算键；**只含中文标点、但出现在 `L(...)`
  行上**的也算键（`L("、")`、`L("。")`、`L("%@：%@")`）——判据是「在不在 `L(` 调用
  里」，因为 `L()` 的参数按定义就是要翻译的文案，而 `CharacterSet(charactersIn: "。，")`
  这种解析用的字面量不在 `L(` 行，不会被误收。
* 标点也是文案：中文句读不能照搬到英文（列表分隔符 `、`→`", "`、句号 `。`→`". "`、
  括号前留空格）。**不要在 Swift 里写死 `"。"/"，"/"、"/"；"` 再拼进展示文本**——
  走 `L()`，否则英文界面会读到「Washed，Light。」。展示文本的落点是
  `DocumentBuilder`（索引正文，也是回答里显示的那段）、`BeanKnowledgeInsight`、
  `DiagnosticResult`。
* `check.py` 五条：占位符数量、键是否齐全、两表键集一致、同键不重复定义、
  可本地化字面量不能再插值（`Text("\(n) 天")` 会变成不可翻译的键）。
  含插值又含汉字、且同一行没有 `L(` 的字面量会被判违规。
* 改完文案必须跑 `generate.py && check.py`（当前 986 键）。
* 带参数的展示文本**必须** `Text(alreadyLocalized(L("…%@", …)))`——
  `Text("第 %d 步", n)` 这种带参 LocalizedStringKey 重载在本工程编不过
  （会被解析到 `tableName:bundle:` 变体）。计算属性返回的句子同理。

## 冲煮引导链路（2026-10 批次）

* 饮品目录 `Core/DrinkCatalog.swift`（DrinkType/DrinkRecipePlan/DrinkPlanBuilder），
  步骤 `Core/BrewStepBuilder.swift`（目标值全部由配方算出，不写死在视图），
  引导 `Features/Brew/BrewGuideView.swift`（BrewClock 日期算术计时器），
  入口 `Features/Brew/BrewStartView.swift`。
* **waterG 只存冲煮用水**；浓缩液/牛奶/美式加水分别在
  `espressoYieldG`/`milkG`/`addedWaterG`（0 = 不适用）。奶咖粉水比必须保持 0，
  不许把浓缩液或牛奶塞进 waterG 算比例。
* `BrewMath.validate(_:family:)` 按家族给提示（意式→浓缩液、冷萃→浸泡时长）；
  family 由 `MethodRules.family(of:)` 现查——**MethodRules 已无 @MainActor**
  （static let Sendable 字典），写入路径可以直接调。
* 引导不落库：`GuidedBrewSeed` 只把目标值+实测时长带进 QuickBrewLogView，
  写入永远走 `BrewRecorder` 唯一保存路径；引导态下 touchedRecipe=true，
  换豆/换 chips 不许让预填冲掉目标值。
* **sheet(item:) 纪律**：`.sheet(isPresented:)` 闭包里读 @State 传参会拿到旧值
  （brewGuideDemo 实测踩坑）——交接/传参类 sheet 一律用 `.sheet(item:)`，
  且 item 的 id 要由内容派生（重复触发落到同一 id，不重摆不重复保存）。
* 真机迁移验证口径：worktree 旧版 → simctl 装旧灌数据 → sqlite 只读基线 →
  **覆盖安装（不 uninstall）** → 逐行 diff + 新列默认值 + 写入/导出各验一次。
  run.sh 每次 uninstall，迁移演练必须手写 simctl。

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
