# Batch2a 第一轮人工审核包（阶段六点五-A）

> 日期：2026-10-14 ｜ 对象：7 条草稿（b2a-001/002/003/004/006/009/010）
> 门禁状态：`check_candidate_quality.py` 7 条全过（0 error / 0 warning）
> **本包只是审核输入；批准动作 = 负责人在下方「需人工确认点」逐条拍板。**

## 审核前置状态（2026-10-14）

- 例外总数 6：hario-v60-expert-guide、fellow-espresso-basics、gaggia-classic-manual、
  baratza-documents、fellow-brew-talks（限定已核验 claims）、**nca-aboutcoffee（本轮新登记，
  限定 5 条 nca-freshness claims；bean-is-seed 未核验不在范围）**
- 全部 7 条草稿引用的来源与 claim 均已被例外覆盖（来源准入层就绪）
- `review_status` 全部仍为 unreviewed（等人工批准）

## 逐条审核输入

### b2a-001 意式酸·多因归因（GPT 审核顺序 #3，Batch2 核心）
- 内容质量：门禁 0 issue；四段结构（结论/原因/条件/建议）完整
- claim 对应：`rule.fellow.shot-sour` + `claim.extraction.channeling-vendor`（均在 fellow 例外清单）
- 来源状态：✅ 已准入
- F/P/I：F（Fellow 映射/流速证据）+ P（先研磨后换豆）+ I（豆子酸质风格——已标注未核验）
- 术语：无 avoid 词
- **需人工确认点**：①「豆子酸质风格」I 层的语气是否足够保守；② 与 b1-014/016 的差异化是否成立

### b2a-002 苦/粉感/涩感三分（GPT 审核顺序 #1）
- 内容质量：门禁 0 issue
- claim 对应：`rule.fellow.shot-bitter` + `claim.defects.roast-level-acrid`
- 来源状态：✅ 已准入
- F/P/I：F（映射）+ P（排查顺序）+ I（烘焙度——已标注）
- 术语：chalky/粉感 与 astringency/涩感 已按冻结区分
- **需人工确认点**：① I 层「烘焙度放大苦感」的措辞

### b2a-003 时间反崇拜（GPT 审核顺序 #2）
- 内容质量：门禁 0 issue
- claim 对应：`rule.fellow.shot-slow` + `claim.espresso.fellow-ratio-1to3`
- 来源状态：✅ 已准入
- F/P/I：F（time=诊断证据）+ P（联动变量框架/品鉴判断）——无 I
- 术语：本轮修正「中段空洞→风味强度不足」（门禁抓到后已改）
- **需人工确认点**：① P 层「常见品鉴判断方法」的强度

### b2a-004 通道效应（GPT 审核顺序 #4）
- 内容质量：门禁 0 issue（本轮修正「待补证」→「尚无核验来源…方向性推断」）
- claim 对应：`rule.gaggia.no-crema`（gaggia 例外）+ `claim.extraction.channeling-vendor`（fellow 例外）
- 来源状态：✅ 两来源均已准入
- F/P/I：F（Gaggia crema 关联/Fellow 近似）+ I（布粉填压手法——已标注待补证）
- **需人工确认点**：① 手法细节只给方向不给程序，是否可接受

### b2a-006 手冲淡·排除比例后的多变量（GPT 审核顺序 #5）
- 内容质量：门禁 0 issue
- claim 对应：`rule.hario.v60.too-weak`（hario 例外）+ `claim.grinding.manual-not-recipe`（baratza 例外）
- 来源状态：✅ 两来源均已准入
- F/P/I：F（Hario 口径/Baratza 前提）+ P（单变量对比法）+ I（水温/豆子——已标注）
- **需人工确认点**：① 先验证比例的追问设计是否符合产品预期

### b2a-009 反黄金期限（GPT 审核顺序 #6——nca 例外批准后解锁）
- 内容质量：门禁 0 issue
- claim 对应：`claim.freshness.nca-lose-freshness-immediately`、`claim.freshness.nca-peak-decline-stale`（nca 例外✅）+ `claim.freshness.dark-roast-rest-5-7d`、`claim.freshness.resting-varies-by-roast`（fellow-brew-talks 例外✅）
- 来源状态：✅ 两来源均已准入（本轮 nca 登记后解锁）
- F/P/I：F（NCA 储存/衰退 + Fellow 批次案例）+ P（对比冲煮法）+ I（整体判断因豆而异）
- 术语：刻意未引用未核验的 light-roast-rest-4-6w
- **需人工确认点**：① 「好喝是主观判断」的表述边界

### b2a-010 新鲜度机理与储存（GPT 审核顺序 #7——nca 例外批准后解锁）
- 内容质量：门禁 0 issue
- claim 对应：3 条 nca claims（nca 例外✅）
- 来源状态：✅ nca-aboutcoffee 已准入
- F/P/I：F（NCA 事实）+ P（储存建议）+ I（排气/氧化机理——claim 未建，标注待补证）
- **需人工确认点**：① 机理部分作 I 层是否可接受（或先补核验来源再写）

## 汇总：需负责人拍板的决策点

1. **逐条批准**：7 条草稿哪些进入 approved（建议全 7 条——门禁/claim/来源三层已就绪）；
2. **I 层语气**：3 处 I 层标注（b2a-001 豆子酸质、b2a-004 手法、b2a-010 机理）是否可接受；
3. **批准执行方式**：确认后按 approval_execution_template.md 逐条落库（review_status + 双指纹 + reviewed_by）。

## 未修改证明

batch1（5 approved + 25 unreviewed）、例外表（6 条，本轮 +nca）、data/corpus、
batch2a 草稿内容（除上轮术语修正外）——本轮零修改；118 tests OK。
