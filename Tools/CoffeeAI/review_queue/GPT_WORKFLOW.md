# CoffeeAI × ChatGPT 交互循环规范与会话交接（2026-10-14）

> 本文档是「AI（WorkBuddy/CodeBuddy）↔ 负责人 ↔ ChatGPT」三方工作流的唯一权威记录。
> 任何新会话接手时：**先读本文档 → 按「恢复步骤」继续**，不需要重新理解历史。

## 一、工作循环规范（必须遵守）

每个阶段的标准循环：

```
1. 执行 GPT 提示词（严格按禁令清单，红线不越）
2. 回归验证：python3 Tools/CoffeeAI/tests/test_coffeeai.py（当前 118 tests OK）
   + python3 Tools/knowledge/build_kb.py --check
3. git commit + git push origin main（每次修改完必须先推送）
4. 用 ego-browser 打开 ChatGPT 对话，发送报告——必须附仓库地址
   https://github.com/banmu123/BrewPhase ，并要求 GPT「先看远程 main 最新提交再结合报告」
5. 后台轮询等待 GPT 回复 → 提取 → 按其提示词进入下一阶段
```

**红线（贯穿所有阶段）**：不批准未经负责人/ GPT 批准清单确认的候选；不修改 approved
数据（无 unapprove 机制）；训练冻结直到 approved ≥25 且 train ≥15；不安装 mlx-lm、
不下载模型、不训练；例外表只按批准清单登记；知识库 claim 必须逐句核验才能入库
（F 层），无法逐句支持的标 needs-source-check 且**不硬补成 F**。

## 二、ChatGPT 对话交互技术细节（ego-browser）

- **对话**：《检查黄金风味代码》
  `https://chatgpt.com/c/6aceef1f-e64c-83ee-9d88-7636efc2badb`（登录态在本机 ego 浏览器）
- **输入框选择器**：`div[role='textbox'][aria-label='询问 ChatGPT']`
  （旧 `#prompt-textarea` 与 `div.ProseMirror` 已失效；页面上有多个编辑器时用精确 aria-label）
- **发送流程**：goto 对话 URL → waitForSelector 输入框 → click 聚焦 →
  `page.keyboard.paste({ text: msg })`（长文本用文件读入，不用打字）→ 确认
  `inputLen > 300` → `keyboard.press("Enter")`
- **等待回复**：轮询 `main.innerText.length` + stop-button
  （`[data-testid="stop-button"]` 或 `button[aria-label*="停止"]`）消失；
  长度连续 4 次（每次 3 秒）稳定即完成。**长回复用 run_in_background 轮询**（前台会超时）
- **提取回复**：页面是虚拟列表——用**我方上一条消息的结尾句**作为
  `full.lastIndexOf(marker)` 锚点截取回复；「无法加载此回复」= 网络问题，重开页面即可；
  免费版额度每日 16:03（GMT+8）重置
- **消息文件惯例**：`/tmp/gpt_<阶段>_done.txt`（我方报告）、`/tmp/gpt_next<N>.md`（GPT 回复）
- **任务空间**：每次交互独立 taskSpace，结束 `task.finish({ keep: [] })`

## 三、当前状态快照（2026-10-14 21:00）

| 指标 | 值 |
|---|---|
| approved | **14**（batch1 5：b1-012/013/014/015/016；batch2a 9：b2a-001/002/003/004/005/006/008/009/010） |
| 例外 | **9**（fellow-espresso-basics / hario-v60-expert-guide / gaggia / baratza / fellow-brew-talks / nca / stumptown / hario-v60-hoffmann / ucdavis——全部 noncommercial-research + fact-extraction-rewrite + claim 限定） |
| 合并划分 | train 11 / valid 2 / test 1（无泄漏） |
| 测试 | **118 tests OK**（Python 3.13.12） |
| 训练 | **冻结**（阈值 approved≥25 / train≥15 未达；未装 mlx-lm、未下模型） |
| drafts | batch2a 9 条（已全部落库批准）；**batch2b 0/8（六点九-B 被中断，未写入任何文件）** |
| Git | main = origin/main = `32e1863`（全部已推送） |

## 四、中断点与恢复步骤（当前待办：阶段六点九-B）

**中断点**：六点九-B（Batch2b 草稿生成）刚开始写第一批（b2b-001/002）即被中断，
**batch2b_candidates_draft.jsonl 未创建**——从零开始即可，无半成品。

**GPT 六点九-B 提示词要点**（全文备份：本机 `/tmp/gpt_next24.md` 与
`/tmp/gpt_next24_backup.md`）：

- 输出 `Tools/CoffeeAI/review_queue/batch2b_candidates_draft.jsonl`，8 条：
  b2b-001~008（选题设计见 `batch2b_candidate_plan.md`，claim 已全部验证存在）
- **分两批生成**：第一批低风险 b2b-001/002/004/006（验证追问能力/参数边界）→
  第二批高风险 b2b-003/005/007/008（重点人工检查：是否像普通 ChatGPT 回答 vs 体现
  BrewPhase 判断框架）
- 每条结构 **A 直接结论 → B 原因解释 → C 条件限制 → D 下一步建议**；第一段必须避免
  单因素结论（规则 1：第一句体现判断边界）；必须包含「还需要知道」信息收集（规则 2）；
  禁止万能调整动作作唯一建议（规则 3）
- b2b-003 特殊：不能回答「推荐 15:1」——说明配方存在语境、可提供起点（Hario 官方
  15g/250g 与 Hoffmann 30g/500mL 均已核验）但不是所有咖啡的最佳答案
- b2b-007 特殊：健康回答必须含参考信息+个体差异+非医疗建议边界；禁健康承诺/疾病判断
- b2b-008 特殊（最高风险）：必须明确「当前信息不足」+列所需信息（产地/处理法/烘焙度/
  冲煮方式）；**禁止编造**茉莉香的化合物/温度/萃取率机理
- 元数据字段：`interaction_skill`（枚举：clarification / multi_variable_reasoning /
  uncertainty_handling / boundary_setting / condition_based_advice）、
  `missing_information_handling`、`reasoning_level`、`risk_notes`、`training_value`
- F 必须有 claim_id；P 标经验/常见做法；I 用「可能/通常/倾向于/需要进一步确认」限定词；
  禁止：黄金参数 / 最佳比例 / 一定有效 / 唯一原因
- 完成后：`check_candidate_quality.py --input batch2b_candidates_draft.jsonl`（门禁）+
  118 tests + build_kb --check + 输出报告 `batch2b_draft_generation_report.md`
  （8 条生成情况/门禁结果/风险分类/未修改文件证明）→ push → 报告 GPT
- 禁令：不批准、不写 approved 文件、不更新 review_status、不改例外表、不 split、不训练
- GPT 预告的下一阶段：**六点九-C 门禁规则增强复盘**（新增检查：无信息追问/直接给参数/
  缺下一步建议/过度确定词）——草稿完成后再向 GPT 确认

**恢复步骤**：① 读本文档与 `batch2b_candidate_plan.md` → ② 按上述要点生成
`batch2b_candidates_draft.jsonl`（先批 1 后批 2，各跑门禁）→ ③ 回归 + push →
④ 报告 GPT（附仓库地址）→ ⑤ 按回复继续。

## 五、阶段历史索引（全部已推送 GitHub main）

| 阶段 | 内容 | 提交 |
|---|---|---|
| 五点一~五点四 | 试点审核（weak/chalky 转述偏差发现）→ 知识库修复 → 候选同步 → 全量审查 | cf48284 |
| 五点五/五点六 | 决策包（全 pending）→ 落库流程准备 | 58b8e1a / db6f792 |
| 五点七 | **第一批 5 条 approved**（b1-012~016）+ 例外 2 条 + builder approved 保护 | 93db760 |
| 五点八/五点九 | Batch2 规划 → 写作规范冻结 | 66d9dac / b51051c |
| 六点一~六点三 | Batch2a 选题 → 草稿 2 条 → 质量门禁（+9 测试） | 1cdf613 / 2ae9cac+e1f3d05 / b232595 |
| 六点四-A/B | NCA 5 claim 入库 → 三来源例外提案 | cda7d8a / 8065722 |
| 六点五-A/B/C | nca 例外（例外=6）→ 拍板辅助表 → **Batch2a 7 条批准落地**（用户拍板 b2a-010 选 A：删 CO₂ 机理）+ 多来源 claim 并集语义修复 | f10a539 / 3e53209 / bad17bc |
| 六点六-A/B/C/D | UC Davis 5 claim → b1-029 最终化 + Hoffmann 提案 → b1-006 提案 + UC Davis 提案 + 恢复报告 → **例外落地 6→9** + b2a-005/008 草稿 | 7af461e / a6586e4 / 2c0b6b3 / 4c95554 |
| 六点七/六点八 | 第二轮审核包（8 条 A-H）→ **b2a-005/008 批准落库（approved 14）** | d00f7dd / d283bcc |
| 六点九 | Batch2b 选题设计（8 条，18 claim 验证存在）→ **六点九-B 草稿生成（待恢复）** | 32e1863 / — |

## 六、关键决策记录（GPT 已拍板，供后续引用）

- 术语冻结：weak→寡淡、chalky→粉感（avoid：空洞/发涩）；用户口语「发涩」→回答用冻结词
  并注明原文；astringent→涩感/收敛感不与 chalky 混用
- Stumptown FAQ「Sour or weak → under-extraction → finer」证据：**路径 2**——保留 P 层
  厂商经验，不升 F、不入库（防「酸=欠萃」固化）
- b1-029 EFSA sleep-100：removed（宁少一个知识点不留不确定数字）；defer 语义 = knowledge
  enhancement backlog，不改 review_status
- 多来源样本 claim 核对 = 命中例外 allowed_claim_ids **并集**（单来源行为不变）
- 训练启动条件：approved ≥25 且 train ≥15 → 才装 mlx-lm + 下基座 + LoRA dry-run（不直接训练）
