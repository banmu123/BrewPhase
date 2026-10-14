# Batch2a 小批量生成报告（阶段六点二）

> 日期：2026-10-14 ｜ 范围：仅 b2a-002、b2a-003（GPT 指定的小批量规范验证）
> 产出：`batch2a_candidates_draft.jsonl`（2 条草稿，**未 approve、未入 corpus、未训练**）

## 一、生成文件

- `Tools/CoffeeAI/review_queue/batch2a_candidates_draft.jsonl`（2 条草稿）

## 二、claim 对应情况

| sample_id | claim_ids（全部为知识库现有 ID） | 来源 | 来源准入 |
|---|---|---|---|
| b2a-002 | rule.fellow.shot-bitter、claim.defects.roast-level-acrid | fellow-espresso-basics | ✅ 已准入（方案 A 例外，claim 在例外 allowed_claim_ids 内） |
| b2a-003 | rule.fellow.shot-slow、claim.espresso.fellow-ratio-1to3 | fellow-espresso-basics | ✅ 同上 |

## 三、F/P/I 检查结果（逐条）

- **b2a-002**：F——Fellow 苦→磨粗映射、微调提醒、流速证据、「待补证」标注引用；
  P——「先研磨后豆子」的排查顺序（带「经验上」标记）；I——烘焙度放大苦感（带
  「尚未完全核验」标记）。chalky/粉感 与 astringency/涩感已明确区分（规范 §7）。
- **b2a-003**：F——shot time 作为诊断证据（Fellow 口径）；P——联动变量框架 +
  品鉴判断法（带「通常/很多咖啡师会」标记）；无 I 层内容（本条不涉及无来源推断）。
  「25 秒最好」「黄金参数」类表述已避免，落点是「时间帮定位方向，风味决定停在哪」。

## 四、结构校验

- 自写校验脚本（只读）：2 条 × 9 字段齐全；roles = system/user/assistant；
  来源 ID 均在注册表；术语冻结遵守（全文无「空洞」、无「发涩」误用）。
- `validate_data.py`（draft 无 meta）：按设计报 `missing-meta` 禁止训练——
  **符合预期**，证明草稿不会意外进入训练管线。

## 五、潜在风险

1. b2a-002 的烘焙度推断（I 层）措辞已带标注，但最终定稿由人工复核语气是否足够保守；
2. b2a-003 的「常见品鉴判断方法」是 P 层概括——若负责人认为仍偏强，可再弱化为
   「一些品鉴框架会把…」；
3. 两条均为 single-turn——Batch2a 后续批次可考虑多轮诊断对话样本（待规范补充）。

## 六、状态

草稿停止在此，**等待人工审核**。审核通过后的动作（人工确认后执行）：
移入正式批次构建流程（builder 扩展 S 表或独立合并步骤）→ 生成 meta（含双指纹）→
逐条重审 → approved。
