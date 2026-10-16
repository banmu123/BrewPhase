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

## CoffeeAI × ChatGPT 循环——会话交接（2026-10-15 深夜更新）

* **唯一权威交接文档：`Tools/CoffeeAI/review_queue/GPT_WORKFLOW.md`**（新会话必读）——含交互循环规范、ChatGPT 对话技术与选择器、状态快照、恢复步骤、阶段历史与关键决策。
* 当前状态：**Experiment E 设计包阶段（2026-10-16）**——GPT 设计评审终审 Q1–Q6 全部批准（裁定存档 gpt_replies/gpt_reply_experiment_E_design_ruling.md）：Q1 JSON schema v1{action/missing_variable_id/question/reason_code}+fail-closed 降级+变量注册表独立于 IntelligenceConfig；Q2 三候选零样本筛选（Qwen2.5-3B 对照/Qwen3-4B 主候选/7B 上限，开发集≠验收集，许可证前置）；Q3 轻粒度 synthetic+事实逐 claim 可追溯+轨迹七字段元数据；Q4 三层计分+门线（追问≥85%/误追问≤10%/接续≥85%/跳过≥90%/编造0/自然度降幅≤1）；Q5 E1 决策行为→E2 完整多轮（E1 达标≠E2 授权）；Q6 6 条单轮 clarification 不并入。设计包目录 `training/experiment_E_design/`（七件套待产出）。**训练仍未批准**；方法论参考 rasbt/LLMs-from-scratch（LoRA/指令微调/分类微调/裁判评测，概念参照非代码依赖，负责人指定）。GPT 额度 15:28 后恢复文件分析。
* 关键坑：**run_train.py 训练/烟测必须用隔离 venv python**（系统 python 无 mlx-lm，preflight 会拦截）；评测脚本用系统 python 跑即可。**评测脚本已参数化**（run_eval_generation_c.py --adapter-path/--out-prefix，D 用 evalD 前缀）。语义标层三层：成对格式/无残留（脚本可查）+ 逐句归属（只能语义审核）。
* ChatGPT 免费版额度每日 16:03（GMT+8）重置；发送验证必须查 **main 对话区独有词 + 输入框清空**；长消息尾部的独有词可能被虚拟列表截断——用消息开头的 commit 号验证。「Model not found」= 服务端故障，等额度刷新重发。
* ego-browser 任务空间纪律：单空间复用（taskSpace("chatgpt-coffeeai")）+ 每轮结束 `task.finish({ keep: [] })`；GPT 回复提取后**立即存档** gpt_replies/（两次漏存档教训）。
* Git 提交：Batch2e 系列 3aa74b6（plan）→ 02afaa9/e05c15d（plan v2/v3）→ 3650c0f/0778eb0/b527561（draft v1-v3）→ c6e6f91（v6 终审通过）→ aaeba79（落库 43 条）→ 74cecfd（Experiment D）→ 22cd5be（终审归档修订）。
