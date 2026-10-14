# Batch2b 草稿生成报告（阶段六点九-B，2026-10-14）

> 输出：`Tools/CoffeeAI/review_queue/batch2b_candidates_draft.jsonl`（8 条，b2b-001~008）
> 依据：`batch2b_candidate_plan.md` + `BATCH2_WRITING_SPEC.md` + GPT 六点九-B 附加规则 1–6。
> 纪律：**不批准、不写 approved 文件、不更新 review_status、不改 source_exceptions.json、
> 不 split、不训练。** 分两批生成（先低风险后高风险），每批各跑门禁。

## 一、8 条生成情况

| id | 选题 | interaction_skill | 批次 | 门禁 | 特殊规则落实 |
|---|---|---|---|---|---|
| b2b-001 | 咖啡很酸——先澄清再判断 | clarification | 批1 | ✅ 0/0 | 规则1/2：首句「仅凭『酸』还不能判断」+ 最小信息集清单 |
| b2b-002 | 参数矛盾（比例正常×流速异常） | multi_variable_reasoning | 批1 | ✅ 0/0 | 规则3：验证顺序条件化（粉床通道 → 研磨） |
| b2b-003 | 黄金参数请求纠偏 | boundary_setting | 批2 | ✅ 0/0 | 规则4：不答「推荐 X:1」；两个已核验起点（Hario 15g/250g、Hoffmann 30g/500mL）带来源语境；Hoffmann 标注非行业标准 |
| b2b-004 | 同参数不同豆子 | condition_based_advice | 批1 | ✅ 0/0 | 规则1/2：「参数相同≠结果相同」+ 四方向对齐清单 |
| b2b-005 | 花香消失——感知到诊断 | multi_variable_reasoning | 批2 | ✅ 0/0 | 禁单操作回答：先问基线（同包随时间 vs 换豆/换参数）再分流；花香机理零归因 |
| b2b-006 | 意式时间迷信（25 秒） | boundary_setting | 批1 | ✅ 0/0 | 时间定位为「读数」；Fellow 1:3/22–25s 带完整配方语境 |
| b2b-007 | 每天喝咖啡健康吗 | boundary_setting | 批2 | ✅ 0/0 | 规则5：参考信息（FDA 400mg）+ 个体差异 + 非医疗建议边界三要素齐备；只用 fda-* claim，未引用 efsa-* |
| b2b-008 | 茉莉花香成因 | uncertainty_handling | 批2 | ✅ 0/0 | 规则6：明确「当前信息不足」+ 列产地/处理法/烘焙度/干香湿香；**零化合物/温度/萃取率机理表述**；「不知道」表述为能力 |

- 全部 8 条使用 A（直接结论）→ B（原因解释）→ C（条件限制）→ D（下一步建议）结构；
- 全部 8 条含「还需要知道」信息收集段（规则 2）；
- 新增元数据字段 100% 落位：`interaction_skill`（枚举内取值）/ `missing_information_handling` /
  `reasoning_level` / `risk_notes` / `training_value`；
- claim_ids 与 plan 完全一致（逐条比对 PASS），共引用 14 个不同 claim，全部已核验存在于知识库；
- 术语冻结：weak→寡淡、chalky→粉感、astringent→涩感/收敛感，全程无 avoid 词
  （「空洞」「发涩」零出现）。

## 二、门禁与回归结果

| 检查 | 结果 |
|---|---|
| `check_candidate_quality.py --input batch2b_candidates_draft.jsonl` | **PASSED（checked=8, errors=0, warnings=0）** |
| `Tools/CoffeeAI/tests/test_coffeeai.py` | **Ran 118 tests — OK** |
| `Tools/knowledge/build_kb.py --check` | **OK — validation passed**（51 sources / 122 entities / 19 docs） |

批 1（b2b-001/002/004/006）单独跑门禁时曾出现 1 条 warning
（b2b-002「不必然」命中强断言词扫描），已改写为「研磨只是待验证的方向之一」后清零。
批 2 追加后全量复跑同为 0 error / 0 warning。

**禁用表述自检**：`黄金参数/最佳比例/一定有效/唯一原因` 四词全文扫描，3 处命中均为
**否定/边界语境**且与已验收 plan 原文措辞一致——b2b-003「没有……黄金参数」
（plan answer_structure 原句）、b2b-001/008「无法判断唯一原因」（plan 规则原文
「允许『当前信息不足，无法判断唯一原因』」）。无一处作为肯定答案使用。

## 三、风险分类（与 plan 一致）

- **高幻觉风险**：b2b-003（黄金参数）、b2b-008（花香机理）——均已按特殊规则处理，
  人工复检通过；
- **高健康风险**：b2b-007——健康三要素齐备，无承诺/无诊断/无未核验阈值；
- **中风险（单因归因惯性）**：b2b-001/002/004/005/006——首句均为判断边界或多因分流。

## 四、未修改文件证明

本轮**只新增**以下 3 个文件（`git status` 全记录）：

1. `Tools/CoffeeAI/review_queue/batch2b_candidates_draft.jsonl`（新建，8 条草稿）；
2. `Tools/CoffeeAI/review_queue/build_batch2b_draft_batch1.py`（新建，批1 生成脚本，可复跑）；
3. `Tools/CoffeeAI/review_queue/build_batch2b_draft_batch2.py`（新建，批2 追加脚本，可复跑）。

未触碰：`approved_batch_manifest*.json`、`batch2a_candidates*.jsonl`（含 meta）、
`source_exceptions.json`、`knowledge/**`、任何 review_status 与 split 文件。
`build_kb --check` 以「no file written」模式运行，未产生知识库写入。

## 五、遗留事项（登记时处理，非本轮动作）

- b2b-002 / b2b-003 落库批准时，需把样本 ID 并入
  `hario-v60-expert-guide` / `hario-v60-hoffmann` 例外表的 `allowed_sample_ids`
  （plan 已注明：属既有例外的样本范围对齐，非新授权）。

## 六、建议下一步（待 GPT 指令）

按 GPT 六点九-B 预告：**阶段六点九-C 门禁规则增强复盘**——为
`check_candidate_quality.py` 新增检查维度：① 是否存在无信息追问；② 是否直接给参数；
③ 是否缺少下一步建议；④ 是否出现过度确定词。本报告提交后等待 GPT 确认方案再动工。
