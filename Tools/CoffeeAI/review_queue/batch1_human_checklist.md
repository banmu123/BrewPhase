# Batch 1 人工审核清单（阶段五点六）

> 日期：2026-10-14 ｜ 数据来源：`batch1_admission_proposal.json`（30 条）
> **★ = GPT 指定的重点决策样本**。全部候选当前 `review_status: unreviewed`。
> 决策动作说明：`accept 补丁`（套用 batch1_revision_patch.jsonl）→ `重审`（人工审核修订稿并
> 显式更新审核记录）→ `例外`（来源准入解除，见 source_exception_decision.md）→ `approved`。

## 重点决策样本（★）

| sample_id | 当前状态 | 推荐动作 | 人工决策项 |
|---|---|---|---|
| ★ b1-012 | unreviewed | **approve_candidate 建议唯一**（Hario 原文逐句核验） | ① 确认内容定稿；② hario 例外方案 A 批准（填 approved_by）；③ 批准后按模板走落库 |
| ★ b1-013 | unreviewed | 补丁 accept → 重审 | 推断标注措辞是否接受（「这是方向性推断…」） |
| ★ b1-014 | unreviewed | 补丁 accept → 重审 | weak→寡淡 是否定稿 |
| ★ b1-015 | unreviewed | 补丁 accept → 重审 | chalky→粉感 + 水温F/烘焙度豆子状态I 分层是否接受 |
| ★ b1-016 | unreviewed | 补丁 accept → 重审 | 两处术语替换（空洞→寡淡/尖锐单薄） |
| ★ b1-025 | unreviewed | 暂缓（Hoffmann 配方未核验） | 补外部核验（youtube/博客原文）或降级 P/I 后重写 |
| ★ b1-005 | unreviewed | 暂缓（SCA CVA 引用细节未核验） | 补 SCA 官方页面核验（四部分编号/2024-11 日期） |
| ★ b1-008 | unreviewed | 冗余决策 A/B/C | redundancy_decision.md（推荐 A 保留两个：训练「解释能力」） |
| ★ b1-024 | unreviewed | 冗余决策 A/B/C | 同上（若 A：训练「拒答+追问能力」，与 b1-008 差异化） |

## 其余候选（21 条，均 unreviewed）

| sample_id | 推荐动作 | 人工决策项 |
|---|---|---|
| b1-001 | 保留，needs-source-check | robusta-share「约四成」补 WCR 子页核验 |
| b1-002 | 保留，needs-source-check | NCA 页面核验 |
| b1-004 | 保留，needs-source-check | WCR robusta 授粉细节核验 |
| b1-006 | 保留 | Stumptown 洗滤纸口径核验（Hario 已✅）；来源例外 |
| b1-007 | 保留 | CQI PHP 口径核验；来源例外 |
| b1-009 | 保留 | Baratza/AeroPress/Fellow 磨刻度口径核验；来源例外 |
| b1-010 | 保留 | AeroPress 纸/金属滤口径核验；来源例外 |
| b1-011 | 保留 | CQI 三页核验；来源例外 |
| b1-017 | 保留 | Baratza「取决于豆子与器具」口径核验；来源例外 |
| b1-018 | 保留 | UC Davis 冷萃研究原文核验；来源例外 |
| b1-019 | 保留 | Fellow 养豆批次文章核验；来源例外 |
| b1-020 | 保留 | 同上；来源例外 |
| b1-021 | 保留 | SCA-131 状态 + UC Davis 色曲线核验；来源例外 |
| b1-022 | 保留 | UC Davis 8h/24h + Hario Mizudashi 核验；来源例外 |
| b1-023 | 保留 | 同 freshness；来源例外 |
| b1-026 | 保留 | Sage/Gaggia 手册核验；来源例外 |
| b1-027 | 保留 | AeroPress 手册安全立场核验；来源例外 |
| b1-028 | 保留 | Fellow 温度/配比 claim 核验；来源例外 |
| b1-029 | 保留 | EFSA 口径核验（FDA 已✅）；efsa 例外或来源替换 |
| b1-030 | 保留 | AeroPress 185°F 核验；来源例外 |

## 使用方式

负责人按「重点 9 条 → 其余 21 条」的顺序逐条拍板；批准动作按
`approval_execution_template.md` 执行；dry-run 校验用
`python3 Tools/CoffeeAI/review_queue/check_approval_ready.py --manifest <填好的 manifest> --json`。
