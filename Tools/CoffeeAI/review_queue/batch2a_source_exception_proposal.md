# Batch2a 来源例外提案（阶段六点四-B）——等待人工决定，尚未登记

> 日期：2026-10-14 ｜ 范围：b2a-004/006/009 的三个依赖来源
> **本文件只是提案；`source_exceptions.json` 未改动（仍为 2 条：hario + fellow-espresso-basics）。
> 是否登记由负责人人工批准（approved_by 必须本人填写）。**

## 提案 1：gaggia-classic-manual（解锁 b2a-004；b1-026 复用）

## Source Information

- sourceId: `gaggia-classic-manual`
- registry 状态: active
- license: proprietary-free ｜ commercialUse: **unclear** ｜ derivatives: **not-allowed**
- URL: https://www.gaggia.com/app/uploads/2023/07/4219-465-07801-MANUAL-GAG.-CLASSIC-2019-RI9380-USA-EN-FR-ES-Rev-00_New_Classic.pdf（Gaggia Classic 2019 版官方用户手册）

## Intended Usage

- usage: **fact-extraction-rewrite**（仅独立事实提取与改写，不复制手册原文）
- deployment: **noncommercial-research**

## Supported Claims（精确限定）

- allowed_claim_ids: `rule.gaggia.no-crema`（crema 与豆子状态/配方）、`conflict.gaggia.classic-descale-interval`（除垢周期）、`claim.water.gaggia-vinegar-ban`（禁醋条款）
- allowed_sample_ids: `b2a-004`、`b1-026`
- allowed_topics: espresso、cleaning-maintenance
- 用途说明：支持 espresso troubleshooting（通道效应/crema/维护）claims——**不是**「支持咖啡知识训练」这种宽泛授权

## Does Not Support

- 不能推出：行业标准除垢周期、最佳萃取参数、普适机型结论
- 不支持：医疗/安全结论；手册警告之外的任何安全声明
- 不支持：b2a-004 中布粉/填压的细粒度机理（知识库标注待补证，仍需补证）

## License Risk

- commercialUse=unclear：未来若产物商业化，本例外**不覆盖**，需 licensor-grant + evidence_ref
- derivatives=not-allowed：**禁止改编/再分发手册内容**——本例外只允许事实提取后独立改写
- 手册为多语言官方文件，条⚠️：引用需绑定 2019 版（Rev-00），厂商更新后需重新比对

## Recommendation

- **默认推荐：A**（批准 noncommercial-research 限定例外）——内容已在 b1-026 审核中核验过
  除垢冲突口径；b2a-004 的 crema/豆子状态 claim 亦出自本手册
- 不自动批准；B/C 保留

---

## 提案 2：baratza-documents（解锁 b2a-006；b1-009/017 复用）

## Source Information

- sourceId: `baratza-documents`
- registry 状态: active
- license: proprietary-free ｜ commercialUse: **unclear** ｜ derivatives: **not-allowed**
- URL: https://www.baratza.com/en-au/documents（Baratza 官方文档库）

## Intended Usage

- usage: **fact-extraction-rewrite**
- deployment: **noncommercial-research**

## Supported Claims（精确限定）

- allowed_claim_ids: `claim.grinding.manual-not-recipe`（手册不含冲煮刻度、数值取决于豆子与器具）
- allowed_sample_ids: `b2a-006`、`b1-009`、`b1-017`
- allowed_topics: grinding、brewing
- 用途说明：支持「磨豆刻度不可跨机器换算」「参数以豆子与器具为前提」类 claims

## Does Not Support

- 不能推出：任何磨豆机的通用刻度对照表、最佳研磨度
- 不支持：Baratza 产品推荐/背书；其它品牌磨豆机结论

## License Risk

- commercialUse=unclear / derivatives=not-allowed：同提案 1
- 文档库为动态页面，⚠️ 核验时需记录具体文档标题与访问日期

## Recommendation

- **默认推荐：A**（限定例外）——claim 已在 b1-009/017 审核链中使用并核验表述一致
- 不自动批准；B/C 保留

---

## 提案 3：fellow-brew-talks（解锁 b2a-009；b1-019/020/023/028/009 复用）

## Source Information

- sourceId: `fellow-brew-talks`
- registry 状态: active
- license: proprietary-free ｜ commercialUse: **unclear** ｜ derivatives: **not-allowed**
- URL: https://fellowproducts.com/blogs/brew-talks（Fellow 官方博客）

## Intended Usage

- usage: **fact-extraction-rewrite**
- deployment: **noncommercial-research**

## Supported Claims（精确限定）

- allowed_claim_ids: `claim.freshness.dark-roast-rest-5-7d`、`claim.freshness.light-roast-rest-4-6w`、`claim.freshness.resting-varies-by-roast`、`claim.coldbrew.roast-x-temp-interaction`
- allowed_sample_ids: `b2a-009`、`b1-019`、`b1-020`、`b1-023`、`b1-028`、`b1-009`
- allowed_topics: freshness、uncertainty、espresso、cold-brew、brewing
- 用途说明：支持「养豆窗口随烘焙度变化的具体批次案例」「冷萃交互研究引用」类 claims
  ——**每条 claim 都是具体批次/实验语境，禁止训练成通用天数**

## Does Not Support

- 不能推出：黄金风味期固定数字、所有深烘豆 5–7 天的规律、厂商配方的普适性
- 不支持：商业销售建议；对第三方产品的评判

## License Risk

- commercialUse=unclear / derivatives=not-allowed：同提案 1
- 博客为营销+教育混合内容：⚠️ claim 层已剥离营销辞令（METHODOLOGY §1 第 6 步），
  批准例外不改变该纪律
- 具体批次文章 URL 本轮未逐篇核验（列表页已核验）——⚠️ 批准前建议补一次逐篇核验

## Recommendation

- **默认推荐：A**（限定例外），但**附前置条件**：对引用的养豆批次文章做逐篇 URL+日期核验
  （区别于另外两个已逐句核验的来源）
- 不自动批准；B/C 保留

---

## 汇总

| 提案 | 来源 | 解锁 | 推荐 | 前置条件 |
|---|---|---|---|---|
| 1 | gaggia-classic-manual | b2a-004、b1-026 | A | 无（已核验） |
| 2 | baratza-documents | b2a-006、b1-009/017 | A | 无（已核验表述） |
| 3 | fellow-brew-talks | b2a-009、b1-019/020/023/028 | A | ⚠️ 逐篇核验批次文章 |

三个例外均为 **noncommercial-research 限定**，不开 commercial-product（届时走 licensor-grant）。
负责人批准后由编码模型登记至 `source_exceptions.json`（字段按批准内容填写，approved_by 签署）。
