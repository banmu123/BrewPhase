# 术语决策冻结（阶段五点三）

> 日期：2026-10-14 ｜ 依据：`knowledge/_method/translation_decisions.json`（阶段五点二）
> 本文件把 weak/chalky 的中文处理方案**冻结**为后续候选生成与审核的强制规则。
> 决策依据与完整理由见 translation_decisions.json；本文件不修改其内容。

## 1. weak（Fellow espresso 语境）

| 项 | 内容 |
|---|---|
| 推荐 | **寡淡**（首选）；浓度不足、风味强度不足（解释性表述可用） |
| 避免 | **空洞**；亦避免「无力」单独使用 |
| 原文锚点 | "If your shot tastes sour, salty, or **weak**, try grinding your coffee slightly finer." |
| 使用范围 | 所有引用 `fellow-espresso-basics` 的候选/知识文档/检索展示；用户口语「空洞」出现时，回答用「寡淡」并可视情况注明「你说的空洞，英文原文是 weak，指风味强度不足」 |

## 2. chalky（Fellow espresso 语境）

| 项 | 内容 |
|---|---|
| 推荐 | **粉感**（首选）；粉笔感、干燥粉质口感（解释性表述可用） |
| 避免 | **发涩**（作为 chalky 的对应词） |
| 原文锚点 | "If your shot tastes **chalky** or bitter, try grinding your coffee slightly coarser." |
| 使用范围 | 同上。用户口语「发涩」出现时，回答用「粉感」并注明「俗称发涩，严格说是粉感（chalky），与收敛性涩感不同」 |

## 3. astringent / astringency（区分用参照）

| 项 | 内容 |
|---|---|
| 保留 | **涩感、收敛感** |
| 规则 | 不与 chalky 混用；涩感=口腔收敛性刺激，粉感=颗粒/干燥质地。候选中三者（bitter/chalky/astringent）不得混写 |

## 4. 冻结后的强制规则

1. 新生成或修订任何候选时，weak 语境只允许「寡淡」系表述；chalky 语境只允许「粉感」系表述。
2. 引用旧转述的历史文档（含 REVIEW_QUEUE 的待查行）不回溯改写，但新内容必须遵守本冻结。
3. 若未来证据要求推翻本冻结：在 `translation_decisions.json` 新增带新日期的记录并更新本文件，不删除历史。
