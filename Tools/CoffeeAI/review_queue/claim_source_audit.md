# Claim 来源核验审计（阶段六点四-A）

> 日期：2026-10-14 ｜ 任务：为 b2a-005/008/010 建立可审核 claim 基础
> 原则：逐字支持才标 verified；仅支持方向要注明；无法核验的**不入库**，标 needs-source-check。
> 厂商建议/作者经验不得升级为行业标准。

## 一、已核验并入库（b2a-010 新鲜度机理与储存）

本轮实际访问：https://www.aboutcoffee.org/beans/storage-and-shelf-life/（"Storage and shelf life - NCA - About Coffee"，2026-10-14）。新增 4 条 claim 至 `knowledge/freshness/freshness.md`：

| claim_id | 原文依据（引用位置） | 逐字支持 | 仅支持方向 | does_not_support |
|---|---|---|---|---|
| claim.freshness.nca-lose-freshness-immediately | "Coffee begins to lose freshness almost immediately after roasting…enough for one or two weeks" | ✅ 逐字 | — | 不支持「烘焙当天最好/无限期新鲜」 |
| claim.freshness.nca-storage-enemies | "protect them from air, moisture, heat, and light (aka their greatest enemies)" + 五条建议（airtight/opaque/dark and cool/grind right before brewing） | ✅ 逐字 | — | 不支持「必须用某品牌容器」；不支持「冷藏一定更好」（页面明说存在分歧） |
| claim.freshness.nca-peak-decline-stale | "won't expire in the sense that they're unsafe to brew…unless…mold. However, over time…will decline in quality…noticeably lose aroma…may taste stale" | ✅ 逐字 | — | 不支持「过期=不能喝」；不支持固定变质天数 |
| claim.freshness.nca-freeze-divergent | "There are differing views on whether freezing (or refrigerating) coffee is a good idea…hygroscopic…truly airtight…no more than a week at a time" | ✅ 逐字 | — | 不支持「冷冻 universally 好/坏」 |
| claim.freshness.nca-duration-table | 保鲜期表：room temp 1–3 weeks / refrigerated 2 weeks / frozen 3–4 months / ground 1–2 weeks / unopened until best-by | ✅（数字为 NCA 原表） | — | 数字**仅限该页条件**（opened→airtight 前提）；不支持推广到所有包装/豆况 |

**F/P/I 边界（b2a-010 应用示例）**：
- F：NCA 上述 5 条（引用时带「NCA 指出」）；
- P：「分周取用、密封分装」的操作习惯（NCA 建议即为 P 化来源）；
- I：**排气（degassing）/CO₂ 机理句**——freshness.md Summary 已有此表述但**无来源 ID、
  NCA 页未提及**→ 未建 claim，标 **needs-source-check**（候选回答中只能作 I 层
  或标注「知识库待补证」）。

## 二、未入库（缺来源核验，fail-closed）

### b2a-005「手冲很酸」所需的萃取方向 claim

- 草案 statement：在其它条件不变时，萃取不足可能表现为尖锐酸感突出；研磨/水温/接触时间
  影响萃取率（方向性）。
- 现状：`brewing-variables.md` 变量表已有「更细→阻力增大、接触时间倾向变长」（来源
  baratza/aeropress），但**「酸感↔萃取不足」的显式关系无任何已核验来源**（Hario/Fellow
  已核验内容均不含手冲酸感归因）。
- 处置：**不入库**。needs-source-check：需找到明确论述「萃取率与酸感」的权威页面
  （如 SCA/Barista Hustle/UC Davis）并核验后，再建 claim。
- 候选影响：b2a-005 推迟写作（除非回答把该方向全部降为 I 层——由人工决定）。

### b2a-008「花香/风味强度」所需的感知关系 claim

- 草案 statement：感官感知受萃取率、浓度与个体感知能力影响；不能建立「萃取越高花香
  越明显」的单因因果。
- 现状：`sensory-and-flavor.md` 为 CVA 词汇与评价体系（filled），**无萃取↔感知关系
  claim**；外部权威页面本轮未核验。
- 处置：**不入库**。needs-source-check（同上）。
- 候选影响：b2a-008 推迟写作。

### b2a-010 机理部分（degassing/CO₂/氧化）

- 现状：freshness.md Summary 已有「排气、CO₂ 干扰萃取、氧化流失」表述，但无来源 ID；
  NCA 页未涉及。→ **needs-source-check**（候选只能把机理作为 I 层）。

## 三、汇总

- 新增入库 claim：**5 条**（全部 nca-aboutcoffee，active 来源；许可字段按注册表——
  准入阻断解除需例外提案，见六点四-B）；
- 暂不入库 claim 草案：3 条（b2a-005/008/010 机理），全部 needs-source-check；
- 未核验来源清单不变：stumptown、fellow-brew-talks、UC Davis、SCA、CQI、baratza、
  aeropress、sage、gaggia、hario-recipe-cards、hario-v60-hoffmann（部分核验于证据包）。

---

## 阶段六点六-A 追加（2026-10-14）：b2a-005 / b2a-008 claim 补全

> 本轮核验来源：UC Davis Coffee Center 两篇文章（下述），均为 `ucdavis-coffee-center`
> （active / see-source-terms / cu:unclear——非商业用途需例外，**本轮按 GPT 指令未登记例外**，
> 例外提案留给下一轮）。

### 已核验并入库（5 条新 claim，build_kb --check 通过）

| claim | 来源页面 | 核验要点（逐句支持） |
|---|---|---|
| `claim.roasting.ta-sourness-correlation` | Grounds for Discovery（2024-08-22） | "the perceived sourness of coffee is strongly correlated to its titratable acidity, or TA"（2021 ACS 论文）；"there's a whole scoring category for it in cupping competitions" |
| `claim.roasting.ta-peaks-first-crack` | 同上 | "TA significantly increased from the beginning of the roast to the 'first crack' phase where it peaked, and then continuously decreased"；"by the onset of the second crack, the TA decreased to approximately its initial value"（7 曲线 × 3 产地/处理法，Nature Sci Rep 2024） |
| `claim.roasting.roast-controls-flavor` | 同上 | "There's only so much you can do to alter the sensory properties of your coffee at the brewing stage... The roasting process offers far greater control over your coffee's flavor."（Anokye-Bempah 原话） |
| `claim.sensory.brewing-chart-profiles` | New Brewing Control Chart（2025-01-02） | "showing different flavor profiles based on the total dissolved solids ... and extraction yield"；12 人品鉴小组 + 消费者偏好数据；SCA/CSF 支持、Breville 资助 |
| `claim.sensory.same-bean-different-brew` | 同上 | Ristenpart 原话："You could take the same pile of coffee beans and then, depending on how you grind them and how you extract them, get them to different corners of the Coffee Brewing Control Chart, which will make those same coffee beans taste differently." |

### 对 b2a-005（手冲酸诊断）的支撑映射（严格 F/P/I）

- **F（新）**：明亮酸质/感知酸度是咖啡固有特征且是杯测打分类别（ta-sourness-correlation
  的后半句）→ 「明亮酸质≠缺陷」从 I 层**升级为 F**；
- **F（新）**：烘焙进程控制滴定酸（一爆峰值后下降）→ 「烘焙度影响酸感」从 I 层
  **升级为 F**（ta-peaks-first-crack + roast-controls-flavor：烘焙对风味的控制力远大于冲煮）；
- **P（保留）**：对比冲煮诊断法（调研磨/水温做两次对比）；
- **仍不是 F**：⚠️「萃取不足→尖锐酸感」的**具体方向**在两篇文章中**均无逐字支持**
  （Brewing Control Chart 文章只说按 TDS/EY 划分风味轮廓，未逐字给出欠萃区的味觉标注；
  经典 chart 的 sour 区标注在原始论文图内，本轮未核验）→ 保持 P（咖啡师经验）并在
  候选中标注「chart 分区的味觉标注细节 needs-source-check（需查 J Food Sci 论文原图）」。
  **不硬补成 F。**

### 对 b2a-008（花香/风味强度）的支撑映射（严格 F/P/I）

- **F（新）**：风味轮廓由 TDS 与萃取率共同划分（brewing-chart-profiles）；
- **F（新）**：同一批豆子，研磨与萃取方式不同 → 味道明显不同（same-bean-different-brew）；
- **仍不是 F**：「萃取越高花香越明显」的单因因果——两篇文章均无此表述，且与
  same-bean-different-brew 的「多变量共同决定」语义相悖 → 候选中必须写成
  「感知 = 豆子芳香物 × 烘焙 × 萃取状态 × 个体感知」的多因框架（P 层组织），
  任何线性因果表述为禁止项。
- 遗留 needs-source-check：「花香类芳香物质的具体来源与感知阈值」仍无核验来源（原草案
  未入库，维持）；个体感知差异（如 TDS 偏好随人而异）在 consumer tasting 描述中有间接
  支持（"consumer preference tasting ... mostly UC Davis college students"），不单独立 claim。

### 来源归属说明

- 5 条 claim 统一挂 `ucdavis-coffee-center`（站级 active 来源，文章 URL 记录于本表）；
  未新注册 sourceId（最小侵入；如后续需要单页粒度可再拆分注册）。
- 该来源 see-source-terms + cu:unclear：**b2a-005/008 若引用这些 claim，训练准入需要
  ucdavis-coffee-center 的例外**——本轮未登记（GPT 指令），例外提案随六点六-D。

## 四、六点六-A 汇总

- 新增入库 claim：**5 条**（ucdavis-coffee-center，全部逐句核验，证据 URL 见上表）；
- b2a-005 的「酸↔欠萃」与 b2a-008 的「花香↔萃取」线性因果：**维持非 F**（无逐字支持）；
- needs-source-check 遗留：Brewing Control Chart 论文原图的欠萃区味觉标注、花香物质
  感知阈值、EFSA sleep 阈值（b1-029 相关，另行处理）；
- approved 数据/例外表/审核状态零修改。
