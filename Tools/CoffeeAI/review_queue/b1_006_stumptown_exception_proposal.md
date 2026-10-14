# b1-006 Stumptown 来源例外提案（阶段六点六-C，2026-10-14）

> **只提案，不登记**——`source_exceptions.json` 本轮未改动（GPT 指令）。
> 状态：b1-006 blocked → exception proposal ready；批准与否由负责人决定。

## 一、来源信息

| 字段 | 值 |
|---|---|
| sourceId | `stumptown-kalita-guide` |
| 页面 | Stumptown Coffee Roasters 官方冲煮指南：Brew Guide — Kalita Wave |
| URL | https://stumptowncoffee.com/pages/brew-guide-kalita-wave |
| 注册表状态 | active ｜ license: see-source-terms ｜ commercialUse: **unclear** ｜ derivatives: **unclear** |
| 核验记录 | **2026-10-14 逐句核验通过**（external_evidence_packet.md 阶段六点六-C 节）：滤纸冲洗、平底三孔容错、慢速螺旋注水、21g/345g/205°F 配方全部与 claim 一致 |
| 质量层级 | Tier 3（烘焙商官方指南） |

### 本轮新增核验的关键原句（滤纸冲洗——b1-006 的核心 claim）

> "Rinse the filter with hot water to wash out any papery taste and warm up the
> dripper, then pour out the rinse water."

与 `claim.pourover.paper-rinse-universal` 的两个要点（去纸味 + 预热器具）逐字一致；
该 claim 的另一来源侧（Hario Expert 指南「滤纸需先用热水淋洗去纸味并预热」）此前已核验
——**跨来源 claim 的两侧现均有逐句证据**。

## 二、使用目的与限定（方案 A 结构）

- 用途：`fact-extraction-rewrite`（唯一允许用法）；
- 部署用途：**仅 `noncommercial-research`**（cu/dv 均 unclear，未来商业用途必须
  licensor-grant 证据，本提案不预授权）；
- 样本范围：`allowed_sample_ids: ["b1-006"]`；
- 主题范围：`allowed_topics: ["brewing"]`（b1-006 的 topic）；
- claim 范围：`allowed_claim_ids: ["claim.pourover.paper-rinse-universal"]`
  ——**只含已逐句核验的滤纸冲洗相关 claim**（GPT 红线）； kalita-geometry /
  kalita-forgiving 等本来源其它 claim 未被 b1-006 引用，不纳入本例外（如未来需要另行提案）。

### 禁止包含的表述（写入例外的 scope 条款）

- ❌「最佳冲煮方式」——Stumptown 是 Kalita Wave 的器具特定指南，不是通用最佳实践；
- ❌「必须冲洗」——两来源都把冲洗作为**建议步骤**（理由：去纸味 + 预热），不是强制
  规范；候选与回答中只能说「厂商建议冲洗，理由是……」；
- ❌「所有手冲适用」——claim 是跨来源**共识性建议**，不等于适用于一切器具与场景；
- ❌ 复制原文步骤文本——仅独立提取事实后改写。

## 三、连带需求（同一提案包）

b1-006 同时引用 `hario-v60-expert-guide`（现有例外不含 b1-006 与
paper-rinse-universal）。若批准本提案，需同步扩展现有 hario 例外：

- `allowed_sample_ids` += `b1-006`；
- `allowed_claim_ids` += `claim.pourover.paper-rinse-universal`
  （hario 侧冲洗理由已核验，external_evidence_packet.md §1）。

两处一起批准才能解除 b1-006 的来源准入阻断（多来源样本按例外并集核对 claim）。

## 四、批准后的预期效果

- b1-006 来源准入解除 → 进入下一批人工审核 → approved 12 → 13；
- b1-006 训练价值（GPT 评估）：滤纸预处理 + 手冲基础动作 + 新手体验改善——
  低于 b1-025 但仍值得保留（P2 → 本轮已升级为提案就绪）。

## 五、禁止事项确认（本轮遵守）

- ❌ 未登记 `source_exceptions.json`（例外总数仍 6）；
- ❌ 未批准 b1-006（仍 unreviewed）；
- ❌ 未新增候选、未 split、未训练；approved = 12 不变。
