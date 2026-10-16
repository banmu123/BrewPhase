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

## 三、当前状态快照（2026-10-16 11:20，负责人决策修订→Experiment E 规划启动）

| 指标 | 值 |
|---|---|
| approved | **43**（b1 5 + b2a 9 + b2b 8 + b2c 3 + b2d 10 + b2e 8） |
| 数据版本 | splits-v3-batch2e（train 35 / valid 4 / test 4，leakage=0；历史 28/4/3 保留） |
| 测试 | **143 tests OK** |
| C/D 实验 | **封存**——D 判定失败（行为分 6.0、追问零学出、事实回归），3B 旧线关闭，管线归档「链路验证完成、质量验收失败」 |
| **Experiment E（新）** | **规划阶段启动**——负责人 2026-10-16 决策修订：做自训练领域模型 + 主动澄清；修订记录 owner_decision_revision_experiment_E.md（待 GPT 复核）；GPT 提案存档 gpt_reply_experiment_E_proposal_owner_chat.md |
| 训练 | **冻结**（E 先设计与数据准备，不启动训练；待 GPT 设计评审批准后才开新受控实验） |
| Git | main = origin/main（决策修订提交之后） |

## 四、中断点与恢复步骤（2026-10-16：CoffeeAI 重开——Experiment E 规划）

**负责人决策修订（2026-10-16）**：推翻 10-15「不做追问」决策——「我认为这条路
值得做……需要自训练模型和实现主动追问」。新目标：BrewPhase Coffee Intelligence
Model（基座 LoRA/SFT 微调 + 主动澄清行为 + RAG 事实层 + 多轮交互 + 独立评测）。
修订记录：`owner_decision_revision_experiment_E.md`（含 C/D 教训、数据规划
300–500 多轮轨迹四类分布、评测门槛 60–100 冻结案例、运行环境约束、执行红线）；
GPT 提案逐字存档：`gpt_replies/gpt_reply_experiment_E_proposal_owner_chat.md`。

**GPT 提案五个要点**（负责人转发，2026-10-16）：
1. 职责分工：模型学行为、RAG 供可追溯事实、代码管对话状态——不把所有问题寄希望于权重；
2. C/D 失败根因：clarification 仅 6/43 + 训练目标混杂——不能只加数据量重跑；
3. E 方案四步：冻结评测集（60–100 案例）→ 建多轮训练数据（300–500 轨迹、四类行为）→ 改训练目标（结构化决策输出 answer/clarify，代码校验）→ 先评测达标再谈 App 集成；
4. 数据规模/基座型号/超参数在 E 设计评审阶段决定，禁止复制 D 参数；
5. **先设计不训练**：完整多轮样本+独立评测集+训练策略+App 运行方案都有依据后，再审批新受控实验。

**当前中断点（2026-10-16 11:45 更新）**：GPT 设计评审终审已出（Q1–Q6 全部批准进入
设计阶段，**训练仍未批准**；裁定逐字存档
`gpt_replies/gpt_reply_experiment_E_design_ruling.md`）——Q1 JSON schema v1 +
fail-closed 降级 + 变量注册表独立于 IntelligenceConfig；Q2 三候选零样本筛选
（开发集≠验收集，许可证前置核验）；Q3 轻粒度 synthetic+事实逐 claim 可追溯，
GPT 出 rubric 六门框架我方落库；Q4 三层计分+门线草案（正确追问 ≥85%/误追问
≤10%/接续 ≥85%/跳过 ≥90%/编造 0/自然度降幅 ≤1/20）；Q5 E1→E2 分期（E1 达标
≠E2 授权）；Q6 旧 43 条选择性复用（6 条单轮 clarification 不并入）。
**新增方法论参考（负责人指定）**：rasbt/LLMs-from-scratch——映射见
`training/experiment_E_design/README.md` 第三节（LoRA/指令微调/分类微调/裁判评测；
方法论参照非代码依赖）。
**下一步**：产出 E 设计包七件套（schema+注册表 → 基座筛选 → rubric → 评测集
规范 → E1/E2 策略 → 旧样本映射 → App 运行方案），完成后提交 GPT 复核（其额度
15:28 后恢复文件分析）。

**历史存档（已完成）**：负责人对 Batch2e 8 条逐条拍板 → 全部批准 → 落库
（aaeba79，approved 43）→ Experiment D（GPT 批准一轮，74cecfd）→ 终审失败封存
（22cd5be 归档修订）→ 负责人拍板不做追问（10-15，已被本日决策修订取代）→
GPT 确认收官（e534548）→ **负责人反转决策，Experiment E 启动（本节）**。

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

**中断点（2026-10-15 晚最终更新）**：GPT 终裁——**Experiment C 不通过，冻结当前
训练线**（裁定存档 `gpt_replies/gpt_reply_stage7g_experimentC_failed_freeze.md`）：
① nat_q7/nat_q4 = 重大事实回归（触发失败条件）；gov_q9 来源归属**勘误**（AHA
2026-07 科学声明确有 400mg 通常安全口径——归属可成立，残留问题是「建议」式措辞
应为「通常认为安全」）；② 追问缺口走数据侧：建议约 8 条 clarification 候选
（一半追问/一半直答防模板化），走现有候选→审核→批准流程，35 条/例外/28-4-3
不变；③ 冻结 A/B/C 线：不部署 C、不加强度、不升 7B；归档结论 =「训练链路验证
完成，目标行为局部改善，未通过产品质量验收」。**已完成 GPT 指示的文档勘误**
（experiment_C_report.md 补充说明节，原记录与哈希不动）。**下一步（等负责人
决定）**：是否开展 clarification 候选数据批次（GPT 建议先 8 条供审查）。

**恢复步骤（旧版存档，供追溯）**：① 读本文档与 `batch2b_review_package.md` → ② 等负责人对 8 条拍板 →
③ 按六点九-E 要点执行落库 → ④ 回归（127 tests + build_kb --check + 门禁）→ push →
⑤ 报告 GPT（附仓库地址）→ ⑥ 按回复继续（GPT 预告：达到阈值后做第一次 mlx-lm
dry-run，不要无限扩 Batch2c）。

**经验教训（本会话新增）**：BSD grep 交替用 `grep -E 'a|b'`；ego-browser 复杂脚本
用 heredoc 传；ChatGPT 页面 WS 断连会导致轮询空等——轮询 90 秒无变化自动 reload
一次即可自愈；来源准入检查必须用 `coffeeai_common.load_registry()`（展平嵌套
license），不要直接读 SOURCE_REGISTRY.json 原始结构。

**发送验证与 Model not found（2026-10-15 补充）**：发送成功验证必须检查
**main 对话区**是否出现报告独有词 + 输入框已清空——`document.body.innerText`
会匹配到输入框残留/瞬态内容导致误报（已踩两次）。ChatGPT 免费版会出现
「Model not found」服务端故障：消息发出后 3 秒内报错 + 出现「重试」按钮，
**消息不持久化（刷新即消失）**——对话看起来正常但 GPT 永远收不到。判据：
发送后 main 尾部出现「Model not found」。处置：等待免费版时段额度刷新后重发
（报告文本保存在 /tmp/gpt_stage7f<N>_done.txt），或升级订阅；无法从该 UI 切换
模型（composer 无模型选择器）。

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
| 七-A~七-E | 数据审计（72059b1）→ mlx-lm 环境隔离 venv（2773fc8）→ 基座决策+数据转换+10 题评测集（d67e924）→ **首次 LoRA dry-run 闭环+3 链路 bug 修复**（887ed5c）→ 实验敏感性（aad73ea：B 实验 6/10，对齐↑幻觉↑并存） | 72059b1 / 2773fc8 / d67e924 / 887ed5c / aad73ea |
| 七-F | Batch2d 选题（e9c135f）→ 草稿+门禁（f518d7d）→ 审核包（b9777d9）→ GPT 核验（7cebb70）→ **落库 approved 25→35、train 28/4/3**（67442a2）；报告 3 次 Model not found 后于 16:03 额度刷新后重发成功 | e9c135f / f518d7d / b9777d9 / 7cebb70 / 67442a2 |
| 七-G-0 | **实验 C 启动前配置核验与评测冻结（GPT 裁定先于训练）**：YAML 数组解析修复+7 测试、实验 C 独立配置、转换文档修正（system 进训练）、评测一致性修复（system+显式 ChatML，tokenizer 交叉校验 True）+N5 v2+冻结文档+6 测试、只读验证全过（143 tests / leakage=0 / dry-run Preflight 通过）；preflight 报告 = experiment_C_preflight_report.md | 180e012 |
| 七-G | **Experiment C 执行**（GPT 批准）：G-1 基线归档（20 题+SHA256）→ G-2 训练（train_20261015_192808，exit 0，4m15s，keys=list/准入 0/无下载）→ G-3 评测 40 份 → 报告 experiment_C_report.md：**未判成功**——行为 7/10 达线、两项历史事实错误消失、无模板化；但自然度 -1.5、nat_q7 机理编造/nat_q4 失实、追问仍 0 分（疑数据缺口） | 0913b5e |
| 七-G 终裁 | **GPT：Experiment C 不通过，冻结当前训练线**——nat_q7/nat_q4 重大事实回归；gov_q9 勘误（AHA 2026-07 声明确有 400mg 口径）；追问走数据侧（建议 8 条候选）；归档「链路验证完成、局部改善、未过质量验收」；报告已补勘误说明 | （本次提交） |

## 六、关键决策记录（GPT 已拍板，供后续引用）

- 术语冻结：weak→寡淡、chalky→粉感（avoid：空洞/发涩）；用户口语「发涩」→回答用冻结词
  并注明原文；astringent→涩感/收敛感不与 chalky 混用
- Stumptown FAQ「Sour or weak → under-extraction → finer」证据：**路径 2**——保留 P 层
  厂商经验，不升 F、不入库（防「酸=欠萃」固化）
- b1-029 EFSA sleep-100：removed（宁少一个知识点不留不确定数字）；defer 语义 = knowledge
  enhancement backlog，不改 review_status
- 多来源样本 claim 核对 = 命中例外 allowed_claim_ids **并集**（单来源行为不变）
- 训练启动条件：approved ≥25 且 train ≥15 → 才装 mlx-lm + 下基座 + LoRA dry-run（不直接训练）
