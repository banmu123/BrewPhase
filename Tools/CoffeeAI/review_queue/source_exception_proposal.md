# 来源例外提案（阶段五点二）——等待人工决定，尚未登记

> 生成日期：2026-10-14 ｜ 依据：试点审核（`batch1_pilot_audit.md`）+ ChatGPT 阶段五点二提示词
> **本文件只是提案。是否写入 `Tools/CoffeeAI/source_exceptions.json` 由项目负责人人工决定；
> 任何脚本都不会自动登记例外。** 在登记之前，下列来源的训练准入持续被默认拒绝政策阻断。

## 提案 1：hario-v60-expert-guide

| 项目 | 内容 |
|---|---|
| 来源信息 | Hario UK 官方 V60 冲煮指南（Tier 2 厂商） |
| URL | https://www.hario.co.uk/pages/brew-guides-v60-expert（2026-10-14 实际访问并逐句比对） |
| 注册状态 | active |
| license.status | proprietary-free |
| commercialUse | unclear ｜ derivatives | unclear（SOURCE_REGISTRY.json） |
| 使用目的 | 仅用于 **fact-extraction-rewrite**（事实提取 + 独立改写 + 署名），**不是复制来源内容** |
| 拟支持的 claim/rule | `claim.pourover.v60-official-expert`、`claim.pourover.v60-official-tuning`、`claim.pourover.paper-rinse-universal`、`rule.hario.v60.too-weak`、`rule.hario.v60.too-slow`（均已在 2026-10-14 与页面原文逐句比对一致） |
| 拟登记范围（建议） | deployment_purposes: ["noncommercial-research"]；allowed_claim_ids 限上述 5 条；allowed_topics: ["brewing", "brewing-troubleshooting"] |
| 风险说明 | ① commercialUse=unclear 意味着若未来训练产物用于商业产品，本例外**不覆盖**，须另行取得许可方授权（licensor-grant）；② 页面内容可能更新，claim 数字（15g/250ml、92–96°C 等）需周期性复核；③ 本例外只放行「独立改写的训练样本」，不构成对 Hario 内容的其他使用权。 |

## 提案 2：fellow-espresso-basics

| 项目 | 内容 |
|---|---|
| 来源信息 | Fellow 官方 Espresso Basics 快速指南 PDF（Tier 2 厂商，Series 1 多语言） |
| URL | https://help.fellowproducts.com/hc/article_attachments/49853941237019（2026-10-14 下载并逐句比对） |
| 注册状态 | active |
| license.status | proprietary-free |
| commercialUse | unclear ｜ derivatives | unclear（SOURCE_REGISTRY.json） |
| 使用目的 | 仅用于 **fact-extraction-rewrite**，不是复制来源内容 |
| 拟支持的 claim/rule | `rule.fellow.shot-sour`、`rule.fellow.shot-bitter`、`claim.extraction.channeling-vendor`、`claim.defects.roast-level-acrid`、`rule.fellow.milk-too-foamy`、`claim.espresso.fellow-dose-tamp`（2026-10-14 与 PDF 原文比对：酸/咸/weak→磨细、chalky/bitter→磨粗、微调提示、18g/90° 填压均一致） |
| 拟登记范围（建议） | deployment_purposes: ["noncommercial-research"]；allowed_claim_ids 限上述 6 条；allowed_topics: ["espresso", "brewing-troubleshooting", "defects"] |
| 风险说明 | ① 同上，商业用途需另行 licensor-grant；② PDF 为多语言快参考卡，措辞简短，claim 层已按 2026-10-14 版本修正转述（weak/chalky），若厂商更新指南需重新比对；③ 同样不构成对 Fellow 内容的其他使用权。 |

## 登记方式（若人工批准）

把每条提案转为 `source_exceptions.json` 的一条例外，必填字段齐全
（sourceId/usage/reason/approved_by/approved_at/scope/deployment_purposes/至少一个范围限定器/license_basis）。
`approved_by` 必须填真实审批人；本提案的任何内容都**不能替代**该字段。

## 未决事项

1. 两来源的例外是否批准（负责人决定）——决策选项见下节「人工决策选项」；
2. deployment_purposes 是否包含 `commercial-product`——按当前政策，两个来源
   commercialUse=unclear，商业用途需要 licensor-grant 证据，**建议本提案仅限非商业研究**；
3. 例外批准后，b1-012~015 等引用候选的准入阻断才会解除；候选文本仍需先按
   `batch1_pilot_audit.md`、`term_decision_freeze.md` 与 `knowledge/_method/CLAIM_POLICY.md`
   完成修订（补丁见 `batch1_revision_patch.jsonl`）并重新人工审核。

## 人工决策选项（阶段五点三补齐）

每个来源独立决策，互不绑定：

### 方案 A：批准（限 noncommercial-research）
- 按「拟登记范围」写入 `source_exceptions.json`：`deployment_purposes: ["noncommercial-research"]`、
  `allowed_claim_ids` 限定上表清单、`allowed_topics` 限定相应主题；
- `approved_by` / `approved_at` 由负责人填写；
- 效果：引用清单内 claim 的候选解除**来源准入阻断**（仍需通过内容审核 + 审核记录校验）。

### 方案 B：暂不批准
- 来源继续被默认拒绝政策阻断；
- 受影响候选保持在准入层不可训练；内容审核与术语修订可继续推进，互不阻塞。

### 方案 C：申请 licensor-grant（面向未来 commercial-product）
- 联系 Hario / Fellow 取得书面授权（许可范围、用途、期限）；
- 取得后在例外的 `license_basis` 记 `basis: "licensor-grant"` + `evidence_ref` 指向授权文件；
- 未取得前，`commercial-product` 用途下这两个来源持续阻断（内部审批不能替代外部授权）。

**建议**：先走方案 A（非商业研究 + claim 清单限定），方案 C 与产品化决策解耦、后置。
