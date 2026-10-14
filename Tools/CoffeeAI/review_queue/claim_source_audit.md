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
