# 阶段五点三 — 候选同步修订与人工决策落地报告

> 日期：2026-10-14 ｜ 依据：ChatGPT 阶段五点三提示词 + 阶段五点二产出
> 结果：**原候选文件、元数据、审核状态、正式语料、例外表零修改**；训练保持阻断。
> 本阶段完成后，「知识库 → claim → 候选 → 审核标准」链路首次形成闭环（修订待人工确认生效）。

## 一、术语冻结

`term_decision_freeze.md` 已生成并冻结：

| 原文 | 推荐 | 避免 |
|---|---|---|
| weak | 寡淡（浓度不足/风味强度不足） | 空洞 |
| chalky | 粉感（粉笔感/干燥粉质口感） | 发涩（作为 chalky 对应词） |
| astringent | 涩感、收敛感 | 不与 chalky 混用 |

含使用范围（引用 fellow-espresso-basics 的全部候选/文档/展示）与用户口语映射规则
（用户说「空洞/发涩」时回答用冻结词并注明原文）。`translation_decisions.json` 未改动。

## 二、受影响候选扫描

`affected_candidates_report.md`：**b1-013/014/015/016 受影响**（B×3 + A×1）；
b1-028 命中为温度类 claim（fellow-brew-talks，未修改的知识来源），排除；其余 25 条无命中。

## 三、修订补丁（不覆盖原候选）

`batch1_revision_patch.jsonl`：4 条，每条含
`sample_id / old_issue / knowledge_reference / revision_reason / new_messages / needs_manual_review: true`。

- **b1-013（B）**：推断句补 CLAIM_POLICY 标注（「这是方向性推断：研磨越粗、单位时间萃取越少」）；
  避免必然性表述，保留官方方向。
- **b1-014（B）**：问题与回答「空洞」→「寡淡」，回答补「（原文 weak）」溯源。
- **b1-015（B）**：回答改「发苦/粉感（原文 chalky，俗称发涩）」；三因素分层——
  水温方向标为知识库有支持（F），烘焙度/豆子状态标为常识级推断（I）。
- **b1-016（A）**：两处「空洞」→「寡淡」/「尖锐单薄」。

原 `batch1_candidates.jsonl` / `.meta.jsonl` **未修改**（等待人工确认后统一套用补丁）。

## 四、b1-013/014/015 新审核结论（按修订稿预审，仍待人工确认）

| 样本 | 修订后预审结论 | 依据 |
|---|---|---|
| b1-013 | F/P/I 分层完整；无必然性表述 | CLAIM_POLICY §3 模板逐句套用 |
| b1-014 | weak→寡淡 与 PDF 原文一致；第一近似限定保留 | Fellow PDF 2026-10-14 比对 |
| b1-015 | bitter/chalky/astringent 三词不再混写；水温 F、烘焙度与豆子状态 I | 同上 + brewing-variables 行 |
| b1-016 | 仅术语替换，推理结构未动 | term_decision_freeze |

## 五、来源例外待决（决策选项已补齐）

`source_exception_proposal.md` 新增人工决策选项：**方案 A**（批准 noncommercial-research +
claim 清单限定）、**方案 B**（暂不批准，继续阻断）、**方案 C**（申请 licensor-grant 用于未来
commercial-product）。建议先 A 后 C。`source_exceptions.json` 未改动（schemaVersion 3、exceptions []）。

## 六、测试与验证

```
python3 Tools/CoffeeAI/tests/test_coffeeai.py → Ran 109 tests, OK（Python 3.13.12）
python3 Tools/knowledge/build_kb.py --check → 通过
```
（注：GPT 提示词中 `Tools/CoffeeAI/build_kb.py` 为路径笔误，实际执行 `Tools/knowledge/build_kb.py`。）

零修改校验：候选 30 条 `review_status` 全 `unreviewed`；`data/corpus/` 无写入；
`source_exceptions.json` 无新增；未下载模型、未训练、未装 mlx-lm。

## 七、需人工确认的事项

1. 4 条修订补丁是否采纳（采纳后统一套用 → 生成新内容指纹 → 重新人工审核并显式更新审核记录）；
2. 两份例外提案走方案 A/B/C 的哪条；
3. `weak`/`chalky` 冻结方案最终确认；
4. b1-012（建议保留）与 b1-016 之外，是否把试点扩展到其余 26 条候选。
