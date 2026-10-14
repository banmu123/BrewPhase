# Batch 1 修订补丁决策表（阶段五点五）

> 日期：2026-10-14 ｜ 依据：`batch1_revision_patch.jsonl` + 试点/全量审核
> **所有 decision 当前为 `pending`——等待项目负责人逐条拍板；未获得人工确认前，
> `batch1_candidates.jsonl` 保持零修改。**

| sample_id | old_content_summary | patch_content | decision | reason（人工审核理由） |
|---|---|---|---|---|
| b1-013 | 手冲水流过慢：Hario 官方方向（磨粗）+ 无标注推断句「磨粗同时会降低萃取率——改过头变太淡」 | 补推断标注「（这是方向性推断：研磨越粗、单位时间萃取越少）」，官方方向不变 | **pending** | 待负责人确认标注措辞 |
| b1-014 | 意式发酸/咸/空洞：Fellow 第一近似 + 待补证清单（内容结构良好） | 问题与回答「空洞」→「寡淡」，回答补「（原文 weak）」溯源 | **pending** | 待负责人确认 weak 译法定稿 |
| b1-015 | 意式苦涩：Fellow 口径 + 三因素句未分层 | 「发苦/粉感（原文 chalky，俗称发涩）」；水温=F（brewing-variables 支持）、烘焙度/豆子状态=I | **pending** | 待负责人确认 chalky 译法与分层表述 |
| b1-016 | 凭酸味断言萃取不足的反驳（结构良好） | 两处「空洞」→「寡淡」/「尖锐单薄」（纯术语替换，推理结构不动） | **pending** | 待负责人确认 |

**采纳流程（pending 之后）**：人工逐条给出 accept/reject/modify + 理由 → 统一套用补丁 →
重算内容指纹与审核记录（reviewed_content_sha256 / reviewed_record_sha256 由人工显式更新）→
重新人工审核。
