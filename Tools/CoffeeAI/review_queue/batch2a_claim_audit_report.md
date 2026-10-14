# 阶段六点四-A 报告 — Batch2a 前置 claim 补全与来源核验

> 日期：2026-10-14 ｜ 交付：新增 5 条 claim（已入库并核验）、3 条 claim 草案
> （缺来源核验，fail-closed 未入库）、来源核验审计（claim_source_audit.md）。
> **候选零生成、approved 数据零修改、例外表未动、未训练。**

## 一、新增 claim（5 条，全部写入 knowledge/freshness/freshness.md）

来源：nca-aboutcoffee（active，已注册）——本轮实际访问
https://www.aboutcoffee.org/beans/storage-and-shelf-life/（"Storage and shelf life - NCA"，2026-10-14）：

1. `claim.freshness.nca-lose-freshness-immediately`——烘焙后立即失去新鲜度，建议小批量购买
2. `claim.freshness.nca-storage-enemies`——四大敌人（空气/湿气/热/光）+ 四条储存建议
3. `claim.freshness.nca-peak-decline-stale`——峰值后品质下降但非安全问题（除霉变）
4. `claim.freshness.nca-freeze-divergent`——冷冻/冷藏存在分歧 + hygroscopic 特性
5. `claim.freshness.nca-duration-table`——保鲜期参考表（密封前提下：室温 1–3 周/冷藏 2 周/冷冻 3–4 月/粉 1–2 周）

每条的「逐字支持 / 仅支持方向 / does_not_support」记录见 `claim_source_audit.md`。
这组 claim 直接支撑 **b2a-010（新鲜度机理与储存）** 与 **b2a-009（反黄金期限）** 的 F 层。

## 二、未入库的 claim 草案（fail-closed，needs-source-check）

| 主题 | 草案 | 未入库原因 |
|---|---|---|
| b2a-005 手冲酸 | 「萃取不足↔尖锐酸感」方向 + F/P/I 边界示例 | brewing-variables 有研磨→接触时间方向，但**「酸感↔萃取率」无任何已核验来源**（Hario/Fellow 已核验内容均不含） |
| b2a-008 花香/风味强度 | 「感知受萃取/浓度/个体差异影响」，拒绝单因因果 | sensory 文档为 CVA 词汇（无萃取↔感知 claim）；外部权威页未核验 |
| b2a-010 机理句 | degassing/CO₂/氧化 | freshness.md Summary 已有表述但无来源 ID；NCA 页未涉及 → 候选中只能作 I 层 |

按你「不要把知识库内部记录冒充核验」的要求，三条草案**均未写入知识库**，
待找到可核验来源后单独走 claim 流程。

## 三、验证

```
python3 Tools/knowledge/build_kb.py --check → 通过（含新增 5 claim 的文档校验）
python3 Tools/knowledge/build_kb.py → _build 重建完成
python3 Tools/CoffeeAI/tests/test_coffeeai.py → Ran 118 tests, OK
```

未修改证明：batch1_candidates（5 approved + 25 unreviewed 不变）、approved_batch_manifest、
source_exceptions.json（2 条例外不变）、data/corpus、batch2a 草稿——全部零修改。
本轮新增/修改：`knowledge/freshness/freshness.md`（+5 claim 行）、
`knowledge/_build/knowledge_base.v2.json`（重建）、`claim_source_audit.md`（新增）、本报告。

## 四、下一步（承接你的顺序）

- 六点四-B：为 b2a-004（gaggia）/ b2a-006（baratza）/ b2a-009（fellow-brew-talks）生成
  例外提案（不写入 source_exceptions.json）；
- 之后：b2a-002/003 已有草稿 + b2a-010/009 的 F 层已就绪 → 可生成其余草稿 →
  quality gate → 人工审核；
- b2a-005/008 挂起等待来源核验（候选写作时该方向全部降为 I 层或暂缓）。
