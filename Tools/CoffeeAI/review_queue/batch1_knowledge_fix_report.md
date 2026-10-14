# 阶段五点二 — 知识库事实层修复报告

> 日期：2026-10-14 ｜ 依据：试点审核 `batch1_pilot_audit.md` + ChatGPT 阶段五点二提示词
> 结果：**候选、元数据、审核状态、正式语料、例外表全部零修改**；训练保持阻断。

## 一、修改了哪些知识文件

| 文件 | 修改 |
|---|---|
| `knowledge/espresso/espresso-dial-in.md` | 官方故障树表格 1 行：「空洞」→「寡淡（原文 weak，勿译『空洞』）」 |
| `knowledge/troubleshooting/troubleshooting.json` | `rule.fellow.shot-sour` symptom →「发酸/咸/寡淡（原文 weak）」；`rule.fellow.shot-bitter` symptom →「发苦/粉感（原文 chalky，非收敛性涩感）」 |
| `knowledge/troubleshooting/brewing-troubleshooting.md` | 诊断表 2 行同步 |
| `knowledge/extraction/extraction-science.md` | `claim.extraction.channeling-vendor` 行同步 |
| `knowledge/defects/coffee-defects.md` | `claim.defects.roast-level-acrid` 行同步 |
| `knowledge/_build/knowledge_base.v2.json` | 由 `build_kb.py` 重建（产物层自动更新；剩余 1 处「空洞」为多因解释树的**用户口语症状列举**，非 Fellow 转述，保留） |

未改动：`terminology.json`（有独立 schema 与 App 消费链——术语决策改记录在下方新文件中，避免破坏 schema）、`REVIEW_QUEUE.md`（历史待查记录）、候选文件。

## 二、新增文件

1. **`knowledge/_method/translation_decisions.json`** — 术语映射决策记录（GPT 要求的
   审核记录字段：term/coffee_context/source_quote/recommended_translation/avoid_translation/
   reason/decided_by/applied_to）。包含 weak（推荐「寡淡/浓度不足」，avoid「空洞」）与
   chalky（推荐「粉感/粉笔感」，avoid「发涩」）两条正式决策 + astringent 参照条目。
   **落点说明（与提示词的偏差及理由）**：GPT 建议「新增或修改 knowledge/terminology.json」；
   实际新建独立决策文件——因为 terminology.json 有自己的 schema 且可能被 App 消费，
   在其中塞审核字段有破坏 schema 与 App 链路的风险。决策内容完整保留，落点更安全。
2. **`knowledge/_method/CLAIM_POLICY.md`** — 训练回答的三层表达政策：
   **F（source-backed fact）/ P（expert practice）/ I（inference）**，含硬规则
   （每层必须有语言标记、F 必须可回溯 claim ID、厂商近似必须保留限定语）与
   b1-013/b1-015 的拆解应用示例。

## 三、claim 层修正内容（weak/chalky 最终方案）

| 原文 | 旧转述 | 新转述 | 理由 |
|---|---|---|---|
| weak（Fellow） | 空洞 | **寡淡**（浓度不足/风味强度不足） | weak 是浓度维度；「空洞」更像 hollow，语义外溢 |
| chalky（Fellow） | 发涩 | **粉感**（粉笔感/干燥粉质口感） | chalky 是干燥粉质口感，与 astringent（收敛性涩感）是两类感官 |

`REVIEW_QUEUE.md` 与解释树主题列举中的「空洞」保留——那是用户口语症状词（用户会这样问），
未来检索应能把口语「空洞」映射到 weak/寡淡；这属于检索对齐任务，不在本轮。

## 四、b1-013 推断分层

按 `CLAIM_POLICY.md` 模板拆解：磨粗方向（F）+ 萃取率下降（I，无直接 claim）+ 变太淡
（I，链式推论）。合规写法示例已写入政策文件；**候选文本的修订等待人工确认后另行执行**
（候选本轮零修改）。

## 五、来源例外提案

`Tools/CoffeeAI/review_queue/source_exception_proposal.md` 已生成：hario-v60-expert-guide
与 fellow-espresso-basics 两份提案（来源信息/许可/commercialUse/derivatives/使用目的/
拟支持的 claim 清单/拟登记范围/风险说明），均限定 `noncommercial-research` +
fact-extraction-rewrite，明确**非自动授权**。是否写入 `source_exceptions.json` 等待
负责人人工决定；本阶段未登记任何例外。

## 六、测试与验证

```
python3 Tools/CoffeeAI/tests/test_coffeeai.py → Ran 109 tests, OK（Python 3.13.12）
python3 Tools/knowledge/build_kb.py --check → 通过（13 docs，无 schema 错误）
```

校验快照：`batch1_candidates.jsonl`/`.meta.jsonl` 零修改（fingerprint 未变），
30 条候选 `review_status` 全部 `unreviewed`；`data/corpus/` 无写入；
`source_exceptions.json` = schemaVersion 3、exceptions []；未下载模型、未训练。

## 七、仍需人工决定的事项

1. 两份来源例外提案是否批准、由谁审批（`approved_by` 必须真人填写）；
2. `weak`/`chalky` 的最终中文定稿是否认可本报告方案（寡淡/粉感）；
3. b1-014/015 等引用旧转述的候选：例外批准 + 候选修订完成后，需**重新人工审核**
   （修订会产生新内容指纹，按流程由人显式更新审核记录）；
4. 「研磨→萃取率」方向是否补一条带来源的独立 claim；
5. 检索对齐（口语「空洞」→ weak）列入 REVIEW_QUEUE 后续项。
