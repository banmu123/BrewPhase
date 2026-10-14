# 外部证据核验包（阶段五点六任务 1）

> 日期：2026-10-14 ｜ 目的：把已核验的外部证据集中成包，减少人工判断成本。
> 每条记录包含 supports_claim 与 **does_not_support**——后者防止把来源当成它不是的东西。
> 本包不批准任何样本；它只是人工决策的证据输入。

## 已核验来源（6 个）

### 1. hario-v60-expert-guide ✅

- official_url: https://www.hario.co.uk/pages/brew-guides-v60-expert
- access_date: 2026-10-14 ｜ 页面标题: Expert V60 Brew Guide — Hario UK
- relevant_quote: "If the brew is too weak, try a finer grind. If the water drips through the coffee too slowly, make the grind coarser."；"15g of coffee beans…250ml of water…medium-fine grind…92-96 ºC…the whole process should take around 2.5 minutes…soak [filter] with hot water to remove any papery taste, and to warm the V60 and the mug"
- supports_claim: rule.hario.v60.too-weak、rule.hario.v60.too-slow、claim.pourover.v60-official-tuning、claim.pourover.v60-official-expert、claim.pourover.paper-rinse-universal（Hario 半边）
- does_not_support: 不支持「这是 V60 唯一标准配方」（页面自称指南并建议 Experiment）；不支持其它器具/研磨机的具体刻度；不支持「洗滤纸对风味的量化影响」
- candidate_ids: b1-006、b1-007、b1-009（部分）、b1-010（部分）、b1-012、b1-013、b1-017、b1-025（Hario 半边）
- license_notes: proprietary-free + commercialUse/derivatives unclear → 训练准入需例外（提案方案 A 待批）

### 2. fellow-espresso-basics ✅

- official_url: https://help.fellowproducts.com/hc/article_attachments/49853941237019（PDF）
- access_date: 2026-10-14 ｜ 文档名: Espresso Basics — FELLOW ESPRESSO SERIES 1（多语言）
- relevant_quote: "Shot tastes sour — If your shot tastes sour, salty, or weak, try grinding your coffee slightly finer."；"Shot tastes bitter — If your shot tastes chalky or bitter, try grinding your coffee slightly coarser."；"A micro-adjustment can go a long way."；"Measure out 18 grams of coffee beans for each shot"；"Tamp down with your arm at 90°"
- supports_claim: rule.fellow.shot-sour、rule.fellow.shot-bitter、claim.extraction.channeling-vendor、claim.defects.roast-level-acrid、claim.espresso.fellow-dose-tamp、rule.fellow.shot-slow
- does_not_support: 不支持「研磨是酸/苦的唯一原因」（原文只是快速排除指南）；不支持把 weak 译作「空洞」、chalky 译作「发涩」（术语决策见 translation_decisions.json）；不支持除 18g 之外的通用粉量/比例
- candidate_ids: b1-014、b1-015、b1-016、b1-026（部分）
- license_notes: proprietary-free + unclear → 需例外（提案方案 A 待批）

### 3. fda-caffeine ✅（public-domain，自动准入）

- official_url: https://www.fda.gov/consumers/consumer-updates/spilling-beans-how-much-caffeine-too-much
- access_date: 2026-10-14 ｜ 页面标题: Spilling the Beans: How Much Caffeine is Too Much? | FDA
- relevant_quote: "the FDA has cited 400 milligrams a day — that's about two to three 12-fluid-ounce cups of coffee — as an amount not generally associated with negative effects"；"Depending on factors such as body weight, medications…'too much' can vary from person to person"；"If you are…pregnant…we recommend talking to your health care provider"；decaf "2 to 15 milligrams in an 8-fluid-ounce cup"
- supports_claim: claim.health.fda-400、claim.health.fda-variance、claim.health.fda-pregnancy-refer
- does_not_support: 不支持「400mg 是安全上限」（FDA 用语是 cited / not generally associated）；不支持个人化医疗建议；不支持 EFSA 的单次 100mg 睡眠口径（那是 EFSA 的）
- candidate_ids: b1-029
- license_notes: public-domain + allowed/allowed → **自动准入**（唯一）

### 4. wcr-varieties-catalog ✅（首页级）

- official_url: https://varieties.worldcoffeeresearch.org/
- access_date: 2026-10-14 ｜ 页面标题: Coffee varieties catalog
- relevant_quote: "From it's native home in Ethiopia, Arabica coffee began spreading around the world in the mid-1700s. Historically, most coffees were descendant from Typica and Bourbon. In the mid-20th century, breeders began introducing 'introgressed' varieties…"；"Commercial cultivation began around 1870 in Congo…Robusta is relatively young"
- supports_claim: claim.fundamentals.two-species（框架）、claim.fundamentals.arabica-home、claim.fundamentals.rust-introgression、claim.fundamentals.robusta-origin、claim.origin.env-factors（部分）
- does_not_support: 首页**不含**「Robusta 约占全球产量四成」的数字（claim.fundamentals.robusta-share 需查子页/其它来源）；不含参照品种方法细节（Caturra/SL28）与授粉/混合克隆说明（在 catalog-fields 子页）
- candidate_ids: b1-001（部分）、b1-003（部分）、b1-007/008/024（框架）
- license_notes: unclear → 需例外
- needs-source-check: 子页 https://varieties.worldcoffeeresearch.org/arabica 与 catalog-fields 文章

### 5. efsa-caffeine-opinion ✅（摘要级）

- official_url: https://www.efsa.europa.eu/en/efsajournal/pub/4102
- access_date: 2026-10-14 ｜ 页面标题: Scientific Opinion on the safety of caffeine（EFSA Journal 2015;13(5):4102，2015-05-27）
- relevant_quote: "Single doses of caffeine up to 200 mg … do not give rise to safety concerns."；"Habitual caffeine consumption up to 400 mg per day does not give rise to safety concerns for non-pregnant adults."；"up to 200 mg per day by pregnant women…for the fetus"
- supports_claim: claim.health.efsa-daily-400 ✓；孕妇 200mg ✓；单次 200mg 框架 ✓
- does_not_support: 摘要页**未直接出现**「单次 100mg 影响部分成人睡眠」（claim.health.efsa-sleep-100）——该结论在 opinion 正文/声明节，**needs-source-check**；不支持把 400mg 表述为「安全上限」（EFSA 用语是 does not give rise to safety concerns）
- candidate_ids: b1-029
- license_notes: see-source-terms（学术出版）→ 训练准入阻断（事实引用与引用官方口径的改写边界由人工把握）；b1-029 的 EFSA 半边阻断

### 6. hario-v60-hoffmann ✅

- official_url: https://www.hario.co.uk/blogs/hario-ambassadors/hario-v60-recipe-interview-with-hario-ambassador-james-hoffmann
- access_date: 2026-10-14 ｜ 页面标题: Hario V60 Recipe & Interview with Hario Ambassador James Hoffmann（2022-05-10）
- relevant_quote: "Dose: 30g coffee (Fine-Medium Grind size)；500mL Soft or bottled water (97°C…)；For the bloom…60mL…bloom for up to 45 seconds"；"get 60% of your total water in, within 30 seconds"；"100% of your brew weight in within the next 30 seconds"
- supports_claim: claim.pourover.v60-hoffmann-recipe（30g/500mL/97°C/45s 闷蒸/两段注水——b1-025 引用逐项一致）；conflict.v60.official-recipes-differ 的「同品牌内部配方不一」论点
- does_not_support: **这是 Hoffmann 个人配方（Hario 大使访谈），不是 Hario 官方标准配方，更不是最佳通用比例**；不支持把 97°C 说成 V60 必然水温
- candidate_ids: b1-025
- license_notes: 署名专家内容（proprietary-free?）→ 准入状态以注册表为准（hario-v60-hoffmann 阻断中）

## 待核验清单（needs-source-check，本轮未访问）

sca.coffee/value-assessment（b1-005）、worldcoffeeresearch.org/news/2023/robusta-variety-catalog 与 varieties 子页（b1-001/003/004）、fellowproducts.com/blogs/brew-talks 养豆两篇（b1-019/020/023/028/009）、UC Davis Coffee Center 冷萃研究与色曲线（b1-018/021/022）、CQI PHP 三页（b1-007/011）、NCA（b1-002）、Baratza（b1-009/017）、AeroPress how-to/手册（b1-009/010/027/030）、Sage BES875 与 Gaggia Classic 手册（b1-026）、Hario Mizudashi 配方卡（b1-022）、Stumptown Kalita 指南（b1-006 半边）。

---

## 阶段六点六-C 追加（2026-10-14）：Stumptown Kalita Wave 指南核验

| 字段 | 值 |
|---|---|
| URL | https://stumptowncoffee.com/pages/brew-guide-kalita-wave |
| 核验时间 | 2026-10-14 |
| 服务 claim | `claim.pourover.paper-rinse-universal`（stumptown 侧）+ kalita-geometry / kalita-forgiving 佐证 |

逐句支持记录：
- 滤纸冲洗："Rinse the filter with hot water to wash out any papery taste and warm up the dripper, then pour out the rinse water."（去纸味 + 预热双理由，与 hario 侧表述一致）
- 平底三孔容错："The flat-bottom filter and three-hole base promote an even extraction, which makes this one of the more forgiving brewers out there."
- 慢速螺旋注水："The key to mastering this brewer is the slow spiral pour."
- 配方：21g / 345g / 205°F(≈96°C) / 2:45–3:00 —— 与 pour-over.md 对照表数字一致

⚠️ **新发现（超出既有 claim 范围）**：FAQ 给出调参方向逐字口径——
"Bitter usually means over-extraction, so go coarser or pour a little faster. **Sour or weak usually means under-extraction, so go finer** or slow your pour down."
——「酸/淡→欠萃→磨细」方向的厂商逐字证据；处置选项见
`batch2a_005_008_recovery_report.md` §二（路径 1 入库新 claim / 路径 2 维持 P 层），
**本轮未入库、未扩例外**。
