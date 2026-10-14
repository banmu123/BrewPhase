# Batch 1 人工审核清单（阶段五点六 → 五点七执行后状态）

> 日期：2026-10-14 ｜ **执行结果：第一批 5 条已 approved**
> （b1-012/013/014/015/016；reviewed_by=banmu123；双指纹+dedup 重算；
> check_approval_ready errors=0；validate --for-training 0 error；split 3/1/1 生成——
> 明确警告数据量不足以训练，仅验证流程）。
> **★ = GPT 指定的重点决策样本**。

## 重点决策样本（★）——执行后状态

| sample_id | 状态 | 执行结果 |
|---|---|---|
| ★ b1-012 | **approved** | 内容+证据双满，直接批准（hario 例外已登记） |
| ★ b1-013 | **approved** | 补丁 accept 套用 + 重新审核（推断标注） |
| ★ b1-014 | **approved** | 补丁 accept 套用 + 重新审核（weak→寡淡） |
| ★ b1-015 | **approved** | 补丁 accept 套用 + 重新审核（粉感 + F/I 分层） |
| ★ b1-016 | **approved** | 补丁 accept 套用 + 重新审核（术语替换） |
| ★ b1-025 | unreviewed | **进第二批**：内容可保留（Hoffmann 已核验），但被 `hario-v60-hoffmann` 来源阻断——需为该来源另提例外提案 |
| ★ b1-005 | unreviewed | 暂缓：SCA CVA 引用细节待核 |
| ★ b1-008 | unreviewed | **暂缓**（GPT 建议：第一批求净，第二轮处理） |
| ★ b1-024 | unreviewed | **暂缓**（同上） |
| b1-006 | unreviewed | **进第二批**：内容已核验，但被 `stumptown-kalita-guide` 阻断——需为该来源另提例外提案 |

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
