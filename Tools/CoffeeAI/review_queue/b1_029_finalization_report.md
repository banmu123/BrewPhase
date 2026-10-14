# b1-029 EFSA 健康 claim 最终化报告（阶段六点六-B，2026-10-14）

> GPT 方案 A 执行确认。**结论：b1-029 悬挂状态解除（pending → resolved）。**
> 样本当前 `review_status: unreviewed`（本报告不改变审核状态；批准走正常人工流程）。

## 一、最终文本状态（方案 A，已生效）

- 当前回答文本（上轮改写，本轮核验未再改动）：保留 FDA/EFSA 的每日 400mg 参考、
  个体差异与孕期咨询建议；**不含任何单次摄入阈值数字**；
  结尾明确「不构成个人健康建议」——定位为健康风险提示，非医疗建议。
- 验证：`"100mg" in json.dumps(b1-029) → False`；文本无 sleep-100 相关数字。

## 二、claim 状态表（GPT 要求格式）

| claim | 状态 | 说明 |
|---|---|---|
| daily caffeine reference（`claim.health.fda-400`、`claim.health.efsa-daily-400`） | **F** | FDA 页（2026-10-14 逐句核验：400mg 逐字一致）+ EFSA 摘要页（400mg 非孕成人一致） |
| pregnancy guidance（`claim.health.fda-pregnancy-refer`） | **F** | FDA 页孕期建议（咨询医疗人员）已核验；知识库另有 `claim.health.efsa-pregnancy-200`（200mg，摘要核验一致，本样本未引用） |
| sleep sensitivity（无数字个体差异表述） | **P/I** | 「部分人群即使较低摄入量也可能影响睡眠，具体阈值因人而异」——无数字、有「因人而异」限定词，符合 P/I 层范式 |
| 100mg sleep threshold（`claim.health.efsa-sleep-100`） | **removed** | 三处同步移除：① 知识库 `coffee-health.md` 该 claim 行已删除（留删除线审计痕迹）；② `build_batch1.py` S 表 claim_ids 移除（根修，builder 幂等重建不再复现）；③ 重建后 b1-029 meta claim_ids 无残留 |

## 三、不建议方案的执行确认

**未**为恢复「单次 100mg 影响睡眠」强行补 EFSA 核验。理由（GPT）：健康内容标准应更高——
宁愿少一个知识点，也不留来源不确定的数字。EFSA 摘要页此前核验时该句未直接核到
（仅正文节可能存在，未获逐句证据），保持删除。

## 四、验证

```
python3 Tools/knowledge/build_kb.py --check → 通过（删除线行兼容）
python3 Tools/knowledge/build_kb.py → _build 重建完成
python3 Tools/CoffeeAI/review_queue/build_batch1.py → 30 条重建（approved 5 条保护、b1-016 补丁保留）
b1-029：文本无 100mg；claim_ids 无 efsa-sleep-100；review_status=unreviewed（不变）
```

## 五、剩余事项

- b1-029 仍为 unreviewed：批准需在下一批人工审核时进行（其来源 fda-caffeine 自动准入 +
  efsa-caffeine-opinion 需例外——例外提案随后续批次）；
- 知识库中 `claim.health.efsa-pregnancy-200` / `efsa-children-3mg` / `efsa-exercise` /
  `efsa-alcohol` 均有 EFSA 摘要页逐句支持（此前核验），无悬挂。
