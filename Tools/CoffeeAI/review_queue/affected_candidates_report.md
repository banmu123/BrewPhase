# 受影响候选扫描报告（阶段五点三）

> 日期：2026-10-14 ｜ 扫描范围：`batch1_candidates.jsonl`（30 条）+ meta
> 触发条件：引用 `fellow-espresso-basics` / Fellow 相关 claim，或文本含旧转述词「空洞/发涩」

## 扫描结论

| sample_id | 当前问题 | 命中 | 影响类型 | 是否需要重新审核 |
|---|---|---|---|---|
| b1-013 | 手冲水流过慢（Hario 官方方向正确，但含无标注推断句） | 无术语命中；GPT 提示词指定的推断分层核查 | **B**（回答逻辑：补 CLAIM_POLICY 标注） | 是（修订补丁已备） |
| b1-014 | 意式发酸/咸/**空洞** | 文本「空洞」×2（问题+回答）+ `rule.fellow.shot-sour` 引用 | **B**（术语替换 + weak 溯源说明） | 是（修订补丁已备） |
| b1-015 | 意式又苦又**涩** | 文本「发涩」+ `rule.fellow.shot-bitter` 引用 + 三因素推断未分层 | **B**（术语替换 + F/I 分层） | 是（修订补丁已备） |
| b1-016 | 凭酸味断言萃取不足 | 回答「酸/咸/**空洞**」×1 + `rule.fellow.shot-sour` 引用 | **A**（单点术语替换：空洞→寡淡；「尖锐空洞」→「尖锐单薄」） | 是（修订补丁已备） |
| b1-028 | 意式标准温度 | 命中 `claim.espresso.fellow-ratio-*`（温度/配方 claim，来源 fellow-brew-talks） | **无影响**（与 weak/chalky 转述无关，fellow-brew-talks 未修改） | 否 |

其余 25 条：无命中，不受影响。

## 分类汇总

- **A 类（只需术语替换）**：b1-016
- **B 类（回答逻辑需重新审核/修订）**：b1-013（推断标注）、b1-014（weak 溯源）、b1-015（粉感 + F/I 分层）
- **C 类（需重新生成候选）**：无
- 修订补丁：`batch1_revision_patch.jsonl`（4 条，`needs_manual_review: true`，原候选零修改）
