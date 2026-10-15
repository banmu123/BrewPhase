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
* 改完文案必须跑 `generate.py && check.py`（当前 815 键）。

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

## 工作流程约定（2026-10-14 起）

* **修改完成 → 先 push 远程 → 再询问 GPT**：问 GPT（ChatGPT《检查黄金风味代码》对话）前必须先把改动 commit + push 到 GitHub main，并要求 GPT 先看代码库再结合报告提问。GPT 的提示词按循环执行：执行 → push → 回报 → 问下一步。
* 询问 GPT 时**必须附上仓库地址** https://github.com/banmu123/BrewPhase （GPT 无需搜索即可核对远程 main；仓库对 GPT 可见）。

## CoffeeAI × ChatGPT 循环——会话交接（2026-10-15 晚更新）

* **唯一权威交接文档：`Tools/CoffeeAI/review_queue/GPT_WORKFLOW.md`**（新会话必读）——含交互循环规范、ChatGPT 对话技术与选择器、状态快照、恢复步骤、阶段历史与关键决策。
* 当前状态：**阶段七-G 终裁落地——Experiment C 不通过，A/B/C 训练线冻结**（approved 35 / train 28-4-3 / 143 tests；训练链路验证完成、目标行为局部改善、未过质量验收）。中断点与下一步见交接文档「四」。
* 待负责人决策：是否开展 clarification 候选数据批次（GPT 建议先 8 条：一半「信息不足先问关键问题」、一半「信息足够直答」防模板化，走现有候选→审核→批准流程，35 条 approved/例外/划分不变）。
* 关键坑：**run_train.py 训练/烟测必须用隔离 venv python**（`~/.workbuddy/binaries/python/envs/default/bin/python3`，系统 python 无 mlx-lm，preflight 会拦截）；评测脚本（run_eval_generation_c.py）用系统 python 跑即可（内部 subprocess 调 venv 的 mlx_lm.generate）。
* ChatGPT 免费版额度每日 16:03（GMT+8）重置；发送验证必须查 **main 对话区独有词 + 输入框清空**（不能只看 body.innerText）；「Model not found」= 服务端故障消息不持久化，等额度刷新后重发。
* ego-browser 任务空间纪律：单空间复用（taskSpace("chatgpt-coffeeai")）+ 每轮结束 `task.finish({ keep: [] })`。
