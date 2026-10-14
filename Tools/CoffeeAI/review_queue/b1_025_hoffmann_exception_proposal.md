# b1-025 Hoffmann 来源例外提案（阶段六点六-B，2026-10-14）

> **只提案，不登记**——`source_exceptions.json` 本轮未改动（GPT 指令）。
> 状态：b1-025 blocked → exception proposal ready；批准与否由负责人决定。

## 一、来源信息

| 字段 | 值 |
|---|---|
| sourceId | `hario-v60-hoffmann` |
| 页面 | Hario UK 官方博客：Hario Ambassador 系列对 James Hoffmann 的 V60 配方访谈 |
| URL | https://www.hario.co.uk/blogs/hario-ambassadors/hario-v60-recipe-interview-with-hario-ambassador-james-hoffmann |
| 注册表状态 | active ｜ license: proprietary-free ｜ commercialUse: **unclear** ｜ derivatives: **not-allowed** |
| 核验记录 | **2026-10-14 逐项核验通过**（external_evidence_packet.md）：30g/500mL、97°C、闷蒸 45s、两分钟内完成主段注水——与 `claim.pourover.v60-hoffmann-recipe` 的数字逐项一致 |
| 质量层级 | Tier 3（厂商博客署名作者内容） |

## 二、使用目的与限定（方案 A 结构）

- 用途：`fact-extraction-rewrite`（唯一允许用法）；
- 部署用途：**仅 `noncommercial-research`**——本来源 derivatives=not-allowed，
  **未来任何商业用途（commercial-product）都必须 licensor-grant 证据**，本提案不预授权；
- 样本范围：`allowed_sample_ids: ["b1-025"]`；
- 主题范围：`allowed_topics: ["uncertainty"]`（b1-025 的 topic）；
- claim 范围：`allowed_claim_ids: ["claim.pourover.v60-hoffmann-recipe",
  "conflict.v60.official-recipes-differ"]`
  （conflict 为 2026-10-14 新补正式 claim 行的跨来源事实，来源含本来源；仅含
  配方数字事实与 Hoffmann 明确表达的步骤，符合提案红线）。

### 禁止包含的表述（写入例外的 scope 条款）

- ❌「最佳比例」「黄金参数」「标准 V60 参数」——提案 scope 明确：Hoffmann 配方是
  **署名作者的语境化配方**（特定器具 02、特定水量 500mL），不得表述为行业标准；
- ❌「行业推荐」——Tier 3 厂商博客内容不升级；
- ❌ 复制原文步骤描述文本——仅独立提取数字与步骤事实后改写。

## 三、连带需求（同一提案包）

b1-025 同时引用 `hario-v60-expert-guide`（现有例外不含本样本与
`claim.pourover.v60-official-expert`）。若批准本提案，需同步扩展现有 hario 例外：

- `allowed_sample_ids` += `b1-025`；
- `allowed_claim_ids` += `claim.pourover.v60-official-expert`（官方配方数字，已核验）
  与 `conflict.v60.official-recipes-differ`（跨来源冲突事实，含该来源）；
- 扩展依据与核验记录同上（official-expert 的 15g/250g/92–96°C/2.5min 在
  external_evidence_packet.md §1 已核验）。

两处一起批准才能解除 b1-025 的来源准入阻断（多来源样本按例外并集核对 claim）。

## 四、批准后的预期效果

- b1-025 来源准入解除（需负责人批准两处例外变更）→ 进入下一批人工审核 →
  approved 12 → 13；
- b1-025 训练价值（GPT 评估）：「配方不是标准答案」的典型样本——训练
  「参数来自谁、适用什么情况」的表达方式，符合 BrewPhase 反黄金参数定位。

## 五、禁止事项确认（本轮遵守）

- ❌ 未登记 `source_exceptions.json`（例外总数仍 6）；
- ❌ 未批准 b1-025（仍 unreviewed）；
- ❌ 未扩 ucdavis 例外；
- ❌ 未新增候选、未训练；approved = 12 不变。
