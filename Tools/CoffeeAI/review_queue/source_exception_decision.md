# 来源例外决策分析（阶段五点五 → 五点七执行）

> 日期：2026-10-14 ｜ 依据：`source_exception_proposal.md` + 试点/全量审核证据
> **执行结果（2026-10-14）：方案 A 已批准并登记**——`source_exceptions.json` 新增
> hario-v60-expert-guide 与 fellow-espresso-basics 两条例外（noncommercial-research +
> fact-extraction-rewrite + allowed_claim_ids/allowed_sample_ids/allowed_topics 限定 +
> license_basis=registry-sanctioned-use + valid_until 2027-10-14，
> approved_by=banmu123 (project owner)）。commercial-product 未开启（届时走方案 C
> licensor-grant）。check_approval_ready 对 5 条第一批样本校验 errors=0。

## hario-v60-expert-guide

- **方案 A（批准 noncommercial-research + fact-extraction-rewrite，claim 清单限定）**
  - 支持：官方页面已逐句核验（2026-10-14），5 条 claim/rule 与原文一致；用途限定在
    独立改写；范围限定器可把影响面收窄到 5 条 claim；
  - 风险：commercialUse=unclear——商业用途不在本例外覆盖内（政策要求届时 licensor-grant）。
  - 推荐：**是（首选）**。
- **方案 B（继续阻断）**：b1-012/013、b1-006/007/010/017/025 等引用候选持续不可训练；
  内容质量已核验的成果被闲置。
- **方案 C（申请 licensor-grant）**：与 A 不冲突，面向未来商业产品化时再启动。

## fellow-espresso-basics

- **方案 A（批准，同上限定）**
  - 支持：官方 PDF 已逐句核验；6 条 claim/rule 一致；weak/chalky 转述已修正并以原文锚定；
  - 风险：同上 commercialUse=unclear；PDF 若更新需重新比对。
  - 推荐：**是（首选）**。
- **方案 B（继续阻断）**：b1-014/015/016/026 等持续阻断。
- **方案 C**：同上后置。

## 综合推荐

**两来源均走方案 A**（noncommercial-research + fact-extraction-rewrite + allowed_claim_ids
限定 + allowed_topics 限定），`license_basis` 先以 `registry-sanctioned-use` 记录注册表口径
并附试点核验证据；`valid_until` 建议设 12 个月（2027-10-14 前复核）。方案 C 作为产品化前的
独立许可流程。**执行前提**：负责人填写 `approved_by`/`approved_at` 并确认——任何脚本不得代填。
