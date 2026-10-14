# UC Davis Coffee Center 来源例外提案（阶段六点六-C，2026-10-14）

> **只提案，不登记**——`source_exceptions.json` 本轮未改动（GPT 指令）。
> 这是 b2a-005/008 候选恢复的前置条件（GPT 重点任务）。

## 一、来源信息

| 字段 | 值 |
|---|---|
| sourceId | `ucdavis-coffee-center` |
| 站点 | UC Davis Coffee Center（美国首个大学级咖啡研究中心） |
| URL | https://coffeecenter.ucdavis.edu/ |
| 具体核验页面 | ① New Brewing Control Chart（2025-01-02）② Grounds for Discovery（2024-08-22）——URL 见 claim_source_audit.md 阶段六点六-A 节 |
| 注册表状态 | active ｜ license: see-source-terms ｜ commercialUse: **unclear** ｜ derivatives: **unclear** |
| 核验记录 | 2026-10-14 两页逐句核验（claim_source_audit.md 阶段六点六-A 节，关键句逐字记录） |

## 二、使用目的与限定（方案 A 结构）

- 用途：`fact-extraction-rewrite`（唯一允许用法）；
- 部署用途：**仅 `noncommercial-research`**（cu/dv 均 unclear，未来商业用途必须
  licensor-grant 证据，本提案不预授权）；
- 样本范围：`allowed_sample_ids: ["b2a-005", "b2a-008"]`（待生成草稿的 sample_id，
  以落库时实际 ID 为准）；
- 主题范围：`allowed_topics: ["pour-over diagnosis"]`（b2a-005/008 的计划 topic，
  登记时须与草稿 meta 实际 topic 对齐）。

## 三、claim 范围（严格限定：只允许已入库且已核验的 5 条）

```
allowed_claim_ids:
  claim.roasting.ta-sourness-correlation      # 感知酸度↔TA 强相关 + 杯测打分类别
  claim.roasting.ta-peaks-first-crack         # TA 一爆峰值后下降（Nature Sci Rep 2024）
  claim.roasting.roast-controls-flavor        # 烘焙对风味的控制力远大于冲煮
  claim.sensory.brewing-chart-profiles        # 新 Sensory/Consumer Chart 按 TDS+EY 划分风味轮廓
  claim.sensory.same-bean-different-brew      # Ristenpart：同豆不同萃味道明显不同
```

### 禁止扩展（scope 条款——目前没有 F 支撑的内容一律不得引用本例外）

- ❌「萃取不足一定酸」——欠萃区味觉标注在论文原图内，未核验（needs-source-check；
  b2a-005 中该方向保持 P 层，与本次例外无关）；
- ❌ 花香物质来源与感知阈值——无核验来源；
- ❌「TDS 越高越好喝」——Chart 是风味轮廓划分，不是品质排序；
- ❌ EY 与风味的单线关系——same-bean-different-brew 的语义是多变量共同决定，
  任何单线因果表述与来源语义相悖；
- ❌ 上述 5 条之外的任何 ucdavis 内容（如 cold brew 研究、roast color curve 等
  其它页面/论文）——需要另行核验与提案。

## 四、批准后的预期效果

- b2a-005/008 的来源准入层就绪 → 可进入候选草稿生成（下一步）→ 质量门禁 → 人工审核；
- 这两条是 GPT 评估的最高价值待写样本（b2a-005 ★★★★★ 经典多因诊断、
  b2a-008 ★★★★☆ 反单变量解释）。

## 五、禁止事项确认（本轮遵守）

- ❌ 未登记 `source_exceptions.json`（例外总数仍 6）；
- ❌ 未生成 b2a-005/008 草稿（流程下一步，见 batch2a_005_008_recovery_report.md）；
- ❌ 未批准任何样本、未 split、未训练；approved = 12 不变。
