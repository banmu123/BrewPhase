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
- **任务空间纪律（2026-10-14 负责人指正）**：全程**只用一个** TaskSpace（首次创建后
  每轮 `taskSpace("同一名字")` 复用 + `goto` 刷新即可），**每轮拿到回复/发送完成后
  立即 `task.finish({ keep: [] })` 清掉**——不要每轮开新名字的空间、不要让空间积压
  （本轮曾积压 5 个空间，已全部 finish 清理；后台轮询任务会被 finish 终止，属预期）。
- **任务空间**：每次交互独立 taskSpace，结束 `task.finish({ keep: [] })`

## 三、当前状态快照（2026-10-14 22:20，六点九-D 完成）

| 指标 | 值 |
|---|---|
| approved | **14**（batch1 5：b1-012/013/014/015/016；batch2a 9：b2a-001/002/003/004/005/006/008/009/010） |
| 例外 | **9**（同前；b2b 落库时仅需把样本 ID 并入既有例外 allowed_sample_ids，claim 维度零缺口） |
| 合并划分 | train 11 / valid 2 / test 1（无泄漏） |
| 测试 | **127 tests OK**（六点九-C 新增 TestBatch2bInteractionQuality 9 用例） |
| 训练 | **冻结**（阈值 approved≥25 / train≥15 未达；未装 mlx-lm、未下模型） |
| drafts | batch2a 9 条（已落库批准）；**batch2b 8/8 草稿已生成并过门禁（0/0），待负责人拍板** |
| Git | main = origin/main = `5218512`（六点九-B/C/D 三个提交：2491311 / a0957de / 5218512，全部已推送） |

## 四、中断点与恢复步骤（当前待办：负责人拍板 → 六点九-E 落库）

**中断点**：六点九-B（草稿 8 条）✅ → 六点九-C（门禁行为增强）✅ → 六点九-D（审核包）✅
→ **等待负责人（用户）按拍板清单批准 Batch2b**。GPT 已确认「审核包达到拍板标准，
无需返工」。

**GPT 拍板清单要点**（全文：`gpt_replies/gpt_reply_69d_approval_69e_prompt.md`）：
- A. 8 条全部建议 approve（b2b-008 最高优先级；b2b-003 次之；b2b-001/005 构成诊断入口）
- B. 例外扩展**仅增加 allowed_sample_ids**（不动 allowed_claim_ids/topics/新来源授权）：
  ucdavis ←b2b-001/004/005/008；hario-v60-expert-guide ←b2b-002/003；
  hario-v60-hoffmann ←b2b-003；baratza-documents ←b2b-004；nca-aboutcoffee ←b2b-005；
  fellow-espresso-basics ←b2b-006（GPT 清单写作 fellow-brew-talks 系笔误，以 plan
  与例外表为准：fellow-espresso-basics）
- C. 训练保持冻结（mlx-lm 未装、模型未下载）
- **正确顺序（GPT 强调，不要提前改例外表）**：负责人批准 → 例外 allowed_sample_ids
  扩展 → 落库 → check_approval_ready

**六点九-E 提示词要点**（负责人批准后执行；全文同上存档 + `/tmp/gpt_next27.md`）：
① 更新例外 allowed_sample_ids → ② candidates.jsonl draft→approved → ③ meta 写
reviewed_by/reviewed_at/content_sha256/record_sha256 → ④ manifest: batch2b-approved-r1
→ ⑤ check_approval_ready → ⑥ validate --for-training → ⑦ split → ⑧ 更新数量报告。
禁止：自动批准剩余候选、改知识库、开始训练。

**恢复步骤**：① 读本文档与 `batch2b_review_package.md` → ② 等负责人对 8 条拍板 →
③ 按六点九-E 要点执行落库 → ④ 回归（127 tests + build_kb --check + 门禁）→ push →
⑤ 报告 GPT（附仓库地址）→ ⑥ 按回复继续（GPT 预告：达到阈值后做第一次 mlx-lm
dry-run，不要无限扩 Batch2c）。

**经验教训（本会话新增）**：BSD grep 交替用 `grep -E 'a|b'`；ego-browser 复杂脚本
用 heredoc 传；ChatGPT 页面 WS 断连会导致轮询空等——轮询 90 秒无变化自动 reload
一次即可自愈；来源准入检查必须用 `coffeeai_common.load_registry()`（展平嵌套
license），不要直接读 SOURCE_REGISTRY.json 原始结构。

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
| 六点九-B/C/D | **草稿 8 条生成（2491311）→ 门禁行为增强 +9 测试（a0957de）→ 人工审核包 + b2a-006 审计记录（5218512）**——GPT 三轮全部通过，待负责人拍板 | 2491311 / a0957de / 5218512 |
| 六点九-E | **批准落库 8 条（40e90d6）**：例外 allowed_sample_ids 扩展 + topics 对齐扩展（GPT 修正版方案 A，45b421a 发现 allowed_topics 层冲突后裁定）+ b1-025 存量修复 + 治理测试 3 case；approved 14→**22**、train **18**/2/2（train ≥15 达成）；130 tests OK | 45b421a / 40e90d6 |
| 纪律修正 | ego-browser 任务空间：单空间复用 + 每轮 finish（负责人指正，曾积压 5 个空间已清） | 16e84f3 |
| 管线修复 | split_dataset.py 默认输出路径基于仓库根（原 Tools/Tools/ 拼接 bug，GPT 要求单独 commit） | 1de659f |
| 六点九-F/G | **Batch2c 补齐**：plan（a383816）→ 草稿 b2c-001~003（5554d86）→ 审核包（27291d2）——GPT 全程通过 | a383816 / 5554d86 / 27291d2 |
| 六点九-H | **Batch2c 落库（0884d88）**：GPT 裁定修订（b2c-002 设备 F/P 拆分、b2c-003 interaction_skill=uncertainty_handling）+ 例外 allowed_sample_ids 扩展 + manifest batch2c-approved-r1；**approved 22→25（阈值达成）、train 20/3/2**；130 tests OK | 0884d88 |

## 六、关键决策记录（GPT 已拍板，供后续引用）

- 术语冻结：weak→寡淡、chalky→粉感（avoid：空洞/发涩）；用户口语「发涩」→回答用冻结词
  并注明原文；astringent→涩感/收敛感不与 chalky 混用
- Stumptown FAQ「Sour or weak → under-extraction → finer」证据：**路径 2**——保留 P 层
  厂商经验，不升 F、不入库（防「酸=欠萃」固化）
- b1-029 EFSA sleep-100：removed（宁少一个知识点不留不确定数字）；defer 语义 = knowledge
  enhancement backlog，不改 review_status
- 多来源样本 claim 核对 = 命中例外 allowed_claim_ids **并集**（单来源行为不变）
- 训练启动条件：approved ≥25 且 train ≥15 → 才装 mlx-lm + 下基座 + LoRA dry-run（不直接训练）
