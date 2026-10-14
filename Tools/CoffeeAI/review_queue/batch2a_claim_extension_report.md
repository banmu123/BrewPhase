# Batch2a Claim 扩展报告（阶段六点六-A，2026-10-14）

> 依据 GPT 指示：仅执行 b2a-005 与 b2a-008 的 claim 补全与来源核验准备。
> **禁止生成候选、禁止修改 approved 数据、禁止登记例外——全部遵守。**

## 一、执行摘要

- 新核验来源：**UC Davis Coffee Center 两篇文章**（2025-01-02 Brewing Control Chart、
  2024-08-22 Grounds for Discovery），关键句全部逐字记录；
- 新增入库 claim：**5 条**（`claim.roasting.ta-sourness-correlation`、
  `claim.roasting.ta-peaks-first-crack`、`claim.roasting.roast-controls-flavor`、
  `claim.sensory.brewing-chart-profiles`、`claim.sensory.same-bean-different-brew`），
  全部挂 `ucdavis-coffee-center`（active/see-source-terms）；逐句证据见
  `claim_source_audit.md` 阶段六点六-A 节；
- **严格 F/P/I 纪律**：b2a-005 的「萃取不足→尖锐酸感」与 b2a-008 的「萃取越高花香越明显」
  在已核验文本中**均无逐字支持 → 不硬补成 F**。前者保持 P 层（咖啡师经验）+ chart 分区
  细节 needs-source-check（论文原图未核验）；后者直接列为候选禁止项（与
  same-bean-different-brew 的多变量语义相悖）。

## 二、对两个选题的能力影响

### b2a-005 手冲酸诊断（价值 ★★★★★）

| 诊断分支 | 原层级 | 现层级 | 依据 |
|---|---|---|---|
| 明亮酸质 ≠ 缺陷（固有特征） | I（推断） | **F** | ta-sourness-correlation（杯测专门打分类别 + TA 强相关） |
| 烘焙度影响酸感 | I（推断） | **F** | ta-peaks-first-crack（一爆峰值后 TA 下降）+ roast-controls-flavor |
| 萃取不足 → 尖锐酸 | P | **P（不变）** | 无逐字支持；chart 分区标注 needs-source-check |
| 对比冲煮诊断法 | P | P（不变） | — |

→ 候选写作时：多因归因结构不变，但「豆子酸质」「烘焙度」两支从「标注为推断」
升级为「有核验来源的 F 层」；「欠萃→酸」必须保留 P 层表述（经验/常见判断）。

### b2a-008 花香/风味强度（价值 ★★★★☆）

| 表述 | 层级 | 依据 |
|---|---|---|
| 风味轮廓由 TDS 与萃取率共同划分 | **F（新）** | brewing-chart-profiles |
| 同批豆子不同研磨/萃取 → 味道明显不同 | **F（新）** | same-bean-different-brew（Ristenpart 原话） |
| 感知 = 豆子芳香物 × 烘焙 × 萃取状态 × 个体感知（多因框架） | P（组织层） | 由两条 F 支撑，不引入线性因果 |
| 「萃取越高 → 花香越明显」 | **禁止** | 无来源支持且与 F 层语义相悖 |

→ 候选写作时：以两条 F 为骨架建立「非单因」回答；花香物质阈值仍 needs-source-check
（不作为 F 出现）。

## 三、验证

```
python3 Tools/knowledge/build_kb.py --check → 通过
python3 Tools/knowledge/build_kb.py → _build 重建完成
python3 Tools/CoffeeAI/tests/test_coffeeai.py → Ran 118 tests, OK
```

## 四、边界与遗留

1. `ucdavis-coffee-center` 例外**未登记**（GPT 指令禁止）——b2a-005/008 引用新 claim
   时的训练准入例外提案随六点六-D；
2. Brewing Control Chart 论文原图（J Food Sci, doi 10.1111/1750-3841.16531）的欠萃区
   味觉标注：needs-source-check——这是把「酸↔欠萃」升 F 的唯一路径；
3. 本轮零修改：approved 数据（batch1/batch2a）、例外表、review_status、候选 JSONL。
