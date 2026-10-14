# b2a-005 / b2a-008 候选恢复报告（阶段六点六-C，2026-10-14）

> **不是批准、不是草稿**——本报告固化两条高价值候选的恢复路径与写作约束。
> 流程（GPT 规定，不得跳步）：claim ✓ → source exception proposal ready ✓（本轮）→
> **候选 draft（待六点六-D 例外批准后）** → quality gate → 人工审核。

## 一、流程状态

| 步骤 | b2a-005 手冲酸诊断 | b2a-008 花香/风味强度 |
|---|---|---|
| claim 基础 | ✓（六点六-A：5 条新 claim 中 3 条 roasting + 复用 brewing 方向） | ✓（brewing-chart-profiles + same-bean-different-brew） |
| 来源例外提案 | ✓（ucdavis_exception_proposal.md，待批准） | ✓（同左） |
| 候选 draft | ⏸ 待六点六-D 例外批准后生成 | ⏸ 同左 |
| quality gate | ⏸ | ⏸ |
| 人工审核 | ⏸ | ⏸ |

## 二、b2a-005 写作约束（GPT 要求，冻结）

- **禁止**写成「手冲酸就是欠萃」——单因归因是本条要训练模型避免的坏习惯；
- 结构（GPT 给定）：
  - **A（结论层）**：酸味明显不一定代表失败，需要结合其他表现判断；
  - **B（多因层）**：可能因素 = 豆子风味特点 × 烘焙程度 × 萃取状态；
  - **C（验证层）**：流速、粉层状态、口感平衡；
- F/P/I 映射（六点六-A 审计）：
  - F：明亮酸质是固有特征 + 杯测打分类别（ta-sourness-correlation）；
    烘焙度影响酸感（ta-peaks-first-crack + roast-controls-flavor）；
  - P：「酸↔欠萃」方向（无 ucdavis F 支持）——用厂商口径表述并注明层级；
  - I：具体到用户豆子的判断——带限定词；
- 计划引用来源：hario-v60-expert-guide（已准入，太淡→磨细方向）+ ucdavis-coffee-center
  （例外提案待批）。

### ⚠️ 新证据记录（2026-10-14，待六点六-D 决策）

核验 Stumptown Kalita 指南时，其 FAQ 逐字给出：
> "Bitter usually means over-extraction, so go coarser or pour a little faster.
> **Sour or weak usually means under-extraction, so go finer** or slow your pour down."

——这是「酸/淡 → 欠萃 → 磨细」方向的**厂商逐字口径**（此前 Hario 页只有「太淡→磨细」
无「酸」）。可选路径（六点六-D 由负责人决定）：
- 路径 1：把该 FAQ 句入库为独立 claim（如 `rule.stumptown.sour-under-extraction`），
  b2a-005 增加 stumptown-kalita-guide 来源并把「酸↔欠萃」从 P 升为 F；
- 路径 2：维持 P 层（不追加来源），b2a-005 用「厂商经验一般认为（P）」表述。
两条路径都合规；路径 1 证据更强但需扩展 stumptown 例外范围（当前提案只含
paper-rinse-universal）。

## 三、b2a-008 写作约束（GPT 要求，冻结）

- **禁止**写成「萃取越高，花香越明显」——单变量线性因果，无来源支持；
- 核心表述（GPT 给定）：「萃取方式会影响同一咖啡中不同风味表现，但具体结果取决于
  咖啡豆、烘焙和冲煮条件」；
- 结构要点：感知 = 豆子芳香物质 × 烘焙 × 萃取状态 × 个体感知（多因框架，P 层组织），
  骨架 F = brewing-chart-profiles（TDS+EY 划分风味轮廓）+ same-bean-different-brew
  （同豆不同萃味道明显不同）；
- 花香物质阈值：needs-source-check，不得作为 F 出现；
- 训练价值（GPT）：非常好的「避免单变量解释」样本。

## 四、质量门禁预检清单（草稿生成时逐项执行）

1. 术语冻结：avoid 词（空洞/发涩）零出现；chalky→粉感、weak→寡淡；
2. F/P/I：F 有 claim 引用；I 带限定词（可能/通常/推断/尚未核验…）；强断言词零出现；
3. 诊断链：现象→多因→验证→调整 完整；
4. 数字：必须有 claim 支撑 + 范围说明；健康/水质数字禁止出现；
5. 来源：全部在已批准例外范围内（ucdavis 例外批准后 b2a-005/008 才能引用其 claim）。

## 五、状态确认

- approved = 12（batch1 5 + batch2a 7），例外 = 6，118 tests OK——全部不变；
- 本轮未生成草稿、未登记例外、未批准、未 split、未训练。
