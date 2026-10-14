# Behavior Quality Backlog — 历史 approved 样本的行为质量审计记录

> 建立依据：GPT 六点九-C 回复（2026-10-14，存档 `/tmp/gpt_next26.md`）。
> 背景：阶段六点九-C 为 Batch2b 新增行为质量门禁后，在已 approved 的历史样本上
> 回归发现行为类 warning。处置原则（GPT 拍板，方案①）：**接受为已知历史问题，
> 不回改 approved 数据；规则作为后续批次门槛。**
> approved 数据治理原则：approved 不可静默修改——任何增强都产生新版本/新审核流程。

## Historical approved samples

### b2a-006

- **Detected**: `next-step-missing` warning（阶段六点九-C 行为门禁，
  `check_candidate_quality.py --input batch2a_candidates_draft.jsonl`）
- **Severity**: warning（不阻断；error 级检查对该样本全部通过）
- **Decision**: accepted
- **Reason**: Sample passed original approval criteria. Behavior gate introduced
  after approval. No retroactive modification.
  （该样本通过批准当时的全部门禁——`next-step-missing` 是批准之后才引入的
  行为质量维度；问题性质为交互质量增强项/用户体验优化项，不属于 F/P/I 错误、
  来源错误、术语错误或幻觉风险，不值得触碰 approved 数据。）
- **Future action**: New versions of approved samples should satisfy interaction
  quality gate.（若未来因其它正当理由产生 b2a-006 新版本，新版必须通过包括
  行为门禁在内的全量检查；本 backlog 条目即为审计解释。）
