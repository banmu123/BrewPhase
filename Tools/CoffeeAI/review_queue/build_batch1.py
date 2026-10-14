#!/usr/bin/env python3
"""build_batch1.py — 生成 CommitBrew Coffee AI 第一批候选训练样本（阶段二）。

产出（全部 review_status = unreviewed，仅供人工审核，绝不进入正式训练集）：
  review_queue/batch1_candidates.jsonl        训练内容（chat 格式）
  review_queue/batch1_candidates.meta.jsonl   元数据（来源/许可/审核状态/指纹）

安全设计：
  1. 每条样本的 claim_ids 必须能在知识库中找到（claim.* 表 / rule.* / conflict.*），
     source_ids 必须已在 SOURCE_REGISTRY.json 注册 —— 否则构建直接失败。
  2. sample_id 不得与现有 data/corpus 重复。
  3. 本脚本只写 review_queue/，不触碰 data/corpus、data/splits。
  4. 回答全部为独立撰写（own-original），引用的仅为已核验事实点，不复制来源正文。

用法: python3 Tools/CoffeeAI/review_queue/build_batch1.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
COFFEEAI = Path(__file__).resolve().parents[1]
KNOWLEDGE = REPO / "knowledge"
sys.path.insert(0, str(COFFEEAI / "scripts"))
from coffeeai_common import messages_fingerprint  # noqa: E402

SYSTEM = "你是咖啡领域助手。回答需区分事实与推断，资料不足时明确说明，不编造来源。"
DATA_VERSION = "v0.2-batch1"

# ---------------------------------------------------------------------------
# 样本定义。claim_ids / source_ids 只允许引用知识库真实存在的 ID。
# ---------------------------------------------------------------------------

S = []

def add(sample_id, group_id, topic, source_doc, source_ids, claim_ids, question, answer, notes):
    S.append({
        "sample_id": sample_id, "group_id": group_id, "topic": topic,
        "source_doc": source_doc, "source_ids": source_ids, "claim_ids": claim_ids,
        "question": question, "answer": answer, "notes": notes,
    })

# ---- A. 基础事实理解 ----
add("b1-001", "g-b1-a-species", "varieties", "knowledge/fundamentals/coffee-fundamentals.md",
    ["wcr-varieties-catalog", "wcr-varieties-catalog-fields"],
    ["claim.fundamentals.two-species", "claim.fundamentals.robusta-share", "claim.fundamentals.robusta-genetic-diversity"],
    "Arabica 和 Robusta 是什么关系？",
    "广泛栽培的咖啡主要来自两个种：Arabica（阿拉比卡）与 C. canephora（常称 Robusta）。据 WCR 品种目录，Robusta 约占全球咖啡产量的四成，而且它的遗传多样性远大于 Arabica，产业对其多样性的探索才刚开始。两者不是简单的「高低级」关系，而是适应性、种植条件与育种方向不同的两个种；具体到一杯咖啡的表现，还要叠加品种、环境与处理法等因素。",
    "事实密度适中；「两个种」为 WCR 口径。")
add("b1-002", "g-b1-a-seed", "fundamentals", "knowledge/fundamentals/coffee-fundamentals.md",
    ["nca-aboutcoffee"],
    ["claim.fundamentals.bean-is-seed"],
    "咖啡豆是豆子吗？",
    "日常说的「咖啡豆」其实是咖啡果实的种子，采收处理后经烘焙才成为我们看到的豆子。这是 NCA 消费者教育资料中的表述。「豆」是行业习惯叫法，不是植物学分类意义上的豆科种子。",
    "轻量事实题，训练对象表述习惯。")
add("b1-003", "g-b1-a-varieties-data", "varieties", "knowledge/varieties/coffee-varieties.md",
    ["wcr-varieties-catalog", "wcr-varieties-catalog-fields"],
    ["claim.varieties.no-absolute-data", "claim.varieties.fields"],
    "为什么 WCR 品种目录不直接给每个品种的绝对风味或产量数字？",
    "因为环境、海拔、土壤养分、天气、树龄与农场管理的影响太大，WCR 明确说明某些变量（如杯质、产量潜力）不可能给出绝对数值，因此目录以参照品种（中美洲的 Caturra、非洲的 SL28）做相对比较，每个品种按 20 多个变量（产量潜力、株型、豆粒大小、抗病性等）描述。这意味着品种资料里看到的任何评分都是「相对参照」的结果，不是对某一批豆子的绝对承诺。",
    "训练「相对数据 vs 绝对承诺」的理解。")
add("b1-004", "g-b1-a-robusta-poll", "varieties", "knowledge/varieties/coffee-varieties.md",
    ["wcr-varieties-catalog-fields"],
    ["claim.varieties.robusta-pollination", "claim.varieties.robusta-mix-transparency"],
    "为什么 Robusta 种植常需要同时种多个品种？",
    "WCR 的品种资料指出：Robusta 需要不止一个品种同时开花才能成功授粉，因此农户通常需要种植互补的克隆组合。这也是 Robusta 常以混合克隆形式分发、且混合内容透明度通常较低的原因之一。这类种植层面的差异会进一步影响供应链上游的品种信息可得性。",
    "链条较长，审核时注意每步是否被来源支持。")
add("b1-005", "g-b1-a-cva", "sensory", "knowledge/sensory/sensory-and-flavor.md",
    ["sca-coffee-standards", "sca-cva"],
    ["claim.sensory.cva-four", "claim.sensory.cva-supersedes-2004", "claim.sensory.cva-science-compatible"],
    "SCA 的 CVA 是什么？",
    "CVA（Coffee Value Assessment）是 SCA 现行的咖啡价值评价体系，由四部分组成：SCA-102（样品制备与品尝机制）、SCA-103（描述性评价）、SCA-104（情感性/偏好评价）、SCA-105（外在信息评价）。自 2024 年 11 月起，其中样品制备、描述性、情感性三部分已被采纳为官方标准，取代 2004 年的杯测协议。它的关键思路是把「这杯咖啡有什么感官特征」与「评价者喜不喜欢」分开——这也是日常讨论风味时值得借用的区分。",
    "标准类事实；日期表述以来源为准。")
add("b1-006", "g-b1-s-paper-rinse", "brewing", "knowledge/brewing/pour-over.md",
    ["hario-v60-expert-guide", "stumptown-kalita-guide"],
    ["claim.pourover.paper-rinse-universal"],
    "手冲之前为什么要先冲洗滤纸？",
    "冲洗滤纸是跨来源一致的手冲通用步骤：官方指南给出的理由有两个——去掉纸味、同时预热滤杯与滤纸（Hario 与 Stumptown 的指南都提到）。这个动作成本低、共识度高；至于它对风味影响的具体幅度，知识库中没有量化来源，属于行业共识级建议而非精确结论。",
    "共识级建议；明确无量化来源。")

# ---- B. 对比和解释 ----
add("b1-007", "g-b1-b-factors", "origins-variability", "knowledge/origins/coffee-origins.md",
    ["wcr-varieties-catalog", "wcr-varieties-catalog-fields", "cqi-php"],
    ["claim.origin.env-factors", "claim.varieties.no-absolute-data", "claim.processing.php-scientific"],
    "品种、产区和处理法，分别能说明一杯咖啡的什么？",
    "三个标签说明的是不同层面的信息：品种描述的是植株层面的特性（生长、抗病、产量潜力等，且按 WCR 的体系只能相对参照地描述）；产区背后是环境变量——海拔、土壤、天气、树龄与农场管理——它们与品种共同塑造原料基础；处理法是采收后的转化环节，能够塑造风味方向，但被专业教育体系（如 CQI）视为需要风险控制的过程，而不是风味的保证。任何一个标签单独都不能「决定」杯中表现，把它们叠加起来也只是缩小范围，不是答案。",
    "训练多因素归因的边界意识。")
add("b1-008", "g-b1-b-factors", "origins-variability", "knowledge/origins/coffee-origins.md",
    ["wcr-varieties-catalog"],
    ["claim.origin.env-factors"],
    "为什么不能只凭产区名称判断咖啡的风味？",
    "因为产区内部的变化已经很大。WCR 明确指出，环境、海拔、土壤养分、天气、树龄与农场管理都会显著影响产量、品质与健康——这些变量在同产区内部同样在起作用。两批同产区的豆子可能因为农场管理或年份气候而表现不同。产区名称是有价值的背景信息，但它是必要背景而非充分条件；推断风味还需要处理法、烘焙度与批次信息。",
    "与 b1-007 同组（同组改写关系）。")
add("b1-009", "g-b1-b-grind-scale", "grinding", "knowledge/grinding/grinding.md",
    ["baratza-documents", "aeropress-how-to-use", "fellow-brew-talks"],
    ["claim.grinding.manual-not-recipe", "claim.grinding.aeropress-grind-ref", "claim.grinding.fellow-grind-reference"],
    "换了一台磨豆机，原来的研磨刻度还能直接用吗？",
    "不能直接换算。Baratza 明确说明手册里不含针对具体冲煮方式的刻度，因为正确数值取决于你的豆子与器具；AeroPress 官方配方借用第三方磨豆机（如 Baratza Encore 11–13）作基准，Fellow 的官方配方也注明「每台磨豆机略有差异，仅作基准」。也就是说，刻度只有在同一台机器上才有稳定的相对意义；换机器后应当把旧刻度当作粗略起点，重新用对比冲煮找基准。",
    "跨厂商口径一致，强样本。")
add("b1-010", "g-b1-b-filter", "brewing", "knowledge/brewing/brewing-variables.md",
    ["aeropress-how-to-use", "hario-v60-expert-guide"],
    ["claim.aeropress.paper-vs-metal"],
    "纸质滤纸和金属滤网的区别是什么？",
    "取舍是清晰的：AeroPress 官方说明纸滤会滤除细粉、带来更顺滑的口感；冲煮变量层面的共识是金属滤会保留更多油脂与细粉。两者在口感与透明度上取向不同，没有「哪个更好」的统一答案——取决于目标风格与豆子。同一个人也可以在不同场景下选择不同滤材，把它当作风味取向的选择，而不是对错题。",
    "克制：不展开未经来源支持的风味细节。")
add("b1-011", "g-b1-b-processing-compare", "processing", "knowledge/processing/coffee-processing.md",
    ["cqi-php", "cqi-home", "cqi-q-grader-faq"],
    ["claim.processing.php-importance", "claim.processing.course-coverage", "claim.processing.php-flavor-creation", "claim.fermentation.risk-framing"],
    "水洗、日晒、蜜处理，哪个处理法更好？",
    "知识库现有证据不足以支持「哪个更好」的比较结论。能确认的是：处理是采收后到待烘种子之间的关键转化环节，基础实践水平可以区分商业级与精品级（CQI 的表述）；CQI 的处理课程同时覆盖 natural、honey、washed、湿剥与发酵，把它们当作并列的专业方法体系；进阶处理可以定向创造风味，但在专业教育框架里它被当作需要「理解理论、降低风险、建立标准程序」的过程，而不是风味的保证。所以遇到「某处理法必然更好喝」的说法，应当视为未经证实的断言。",
    "示范「证据不足时不下比较结论」。")

# ---- C. 冲煮诊断 ----
add("b1-012", "g-b1-c-pourover-weak", "brewing-troubleshooting", "knowledge/troubleshooting/troubleshooting.json",
    ["hario-v60-expert-guide"],
    ["rule.hario.v60.too-weak", "claim.pourover.v60-official-tuning"],
    "我的 V60 手冲喝起来太淡，应该怎么办？",
    "按「症状 → 原因 → 证据 → 调整」的顺序排查：Hario 官方指南对「太淡」给出的对应原因是研磨偏粗，调整方向是磨细，可核验的证据是滴滤速度（水流过快往往伴随偏粗）。建议固定其它变量、只把研磨调细一档，再冲一次对比。注意不要一次性大调——官方调参方向之外，改动幅度过大时问题与原因的对应关系就难以归因了。",
    "结构化故障树样本（symptom/causes/evidence/test/adjustment/risk）。")
add("b1-013", "g-b1-c-pourover-slow", "brewing-troubleshooting", "knowledge/troubleshooting/troubleshooting.json",
    ["hario-v60-expert-guide"],
    ["rule.hario.v60.too-slow"],
    "手冲时水流下得太慢，是什么原因？",
    "Hario 官方指南对「水流过慢」给出的对应原因是研磨偏细，方向是磨粗。判断时可以结合滴滤速度与总时长观察；调整时小幅移动即可，因为磨粗同时会降低萃取率——改过头会从「过慢」直接变成「太淡」，就变成另一个问题了。",
    "与 b1-012 为同一故障树的两条分支。")
add("b1-014", "g-b1-c-shot-sour", "espresso", "knowledge/espresso/espresso-dial-in.md",
    ["fellow-espresso-basics"],
    ["rule.fellow.shot-sour", "claim.extraction.channeling-vendor"],
    "意式浓缩喝起来发酸、发咸、很空洞，怎么调？",
    "Fellow 官方快速指南把「Shot 发酸/咸/空洞」归入研磨偏粗一类，方向是磨细。需要说明的是：这是厂商层面的第一近似，不是完整的因果模型——粉量偏低、布粉问题、通道效应、豆子状态等其它原因在知识库中标注为「待补证」。如果小幅磨细后问题仍在，应当逐项检查其它变量，而不是沿同一方向持续猛调。",
    "必须保留「第一近似」限定语。")
add("b1-015", "g-b1-c-shot-bitter", "espresso", "knowledge/espresso/espresso-dial-in.md",
    ["fellow-espresso-basics"],
    ["rule.fellow.shot-bitter", "claim.extraction.channeling-vendor"],
    "意式浓缩又苦又涩，可能是什么问题？",
    "按 Fellow 官方口径，「发苦/发涩」对应研磨偏细，方向是磨粗。同样要注意这是第一近似：烘焙度偏高、水温偏高或豆子状态等因素也可能放大苦涩，这些交互因素在本知识库中尚未完全核验。实践上微调即可——研磨的很小变化对意式流速影响很大，官方也提醒微调就有很大差别。",
    "与 b1-014 成对但独立成组。")
add("b1-016", "g-b1-c-acid-not-enough", "brewing-troubleshooting", "knowledge/espresso/espresso-dial-in.md",
    ["fellow-espresso-basics"],
    ["rule.fellow.shot-sour", "claim.extraction.channeling-vendor"],
    "咖啡喝起来发酸，是不是就说明萃取不足？",
    "不能凭「酸」直接下结论。厂商口径（Fellow）确实把酸/咸/空洞列为研磨偏粗的常见信号，但那是第一近似而非充分判据：酸也可能是豆子本身的明亮酸质，是风格而非缺陷。更可靠的做法是把酸的性质（尖锐空洞还是明亮多汁）与其它证据——流速、甜度、余韵——放在一起看，然后用单变量对比试验验证假设。看到一个「酸」字就断言萃取不足，容易把正常的酸质调没了。",
    "核心推理样本，回答里显式区分信号与判据。")
add("b1-017", "g-b1-c-one-variable", "brewing-variables", "knowledge/brewing/brewing-variables.md",
    ["baratza-documents", "hario-v60-expert-guide", "aeropress-how-to-use"],
    ["claim.grinding.manual-not-recipe"],
    "想改进一杯咖啡的味道，应该一次调整几个变量？",
    "通行做法是一次只改一个变量。原因是诊断需要归因：如果同时改了研磨和水温，即使变好喝了，你也不知道是哪个调整起了作用，下次复现不了。知识库的冲煮变量模型把剂量、水温、比例、研磨、时间、注水结构等分开记录，正是因为它们各有典型方向和代价；Baratza 也明确参数「取决于你的豆子与器具」，所以别人的参数只能当起点。建议每次只改一项、幅度小一些，并记录参数与杯测感受，形成自己的对比记录。",
    "注：一次一变量为知识库通用建议（brewing-variables.md，无独立 claim id），已如实标注。")
add("b1-018", "g-b1-c-coldbrew-weak", "cold-brew", "knowledge/brewing/cold-brew.md",
    ["ucdavis-coldbrew-2025"],
    ["rule.coldbrew.weak", "claim.coldbrew.roast-dominant", "claim.coldbrew.time-least"],
    "我的冷萃风味不足，是不是泡的时间不够长？",
    "直觉会说「再泡久一点」，但 UC Davis 的冷萃研究发现不同的排序：在全浸泡冷萃中，烘焙度是感官差异的首要驱动因素，其次是温度，时间的影响最不显著。所以更有效的排查顺序是先看豆子烘焙度是否合适、萃取温度如何，而不是单纯延长浸泡。当然，这是特定实验条件下的结论（Arabica 豆、特定烘焙度与温度组合），不是普适定律；但它足以说明「风味不足 = 时间不足」这个默认假设值得先检验。",
    "反直觉研究结论，训练证据优先于直觉。")

# ---- D. 风味变化和养豆 ----
add("b1-019", "g-b1-d-rest-varies", "freshness", "knowledge/freshness/freshness.md",
    ["fellow-brew-talks"],
    ["claim.freshness.dark-roast-rest-5-7d", "claim.freshness.light-roast-rest-4-6w", "claim.freshness.resting-varies-by-roast"],
    "为什么有的豆子养几天就能喝，有的要养几周？",
    "因为影响风味稳定期长短的因素很多，不同豆子的差异可以达到数周量级。同一厂商配方库里就有对照案例：深烘肯尼亚批次的推荐养豆期是烘焙后 5–7 天，而某些浅烘/实验处理豆标注为 4–6 周。烘焙度、处理法与具体批次都会影响这个窗口，所以「养豆几天」没有统一答案；更可靠的做法是每隔几天用同一套参数冲煮对比，找到风味稳定的时间点。",
    "直接引用知识库并列案例，不做机理断言。")
add("b1-020", "g-b1-d-rest-varies", "freshness", "knowledge/freshness/freshness.md",
    ["fellow-brew-talks"],
    ["claim.freshness.dark-roast-rest-5-7d", "claim.freshness.resting-varies-by-roast"],
    "深烘豆是不是养一个星期就一定够了？",
    "不能推广。「5–7 天」来自特定批次语境——Fellow 引用的深烘肯尼亚批次与 Counter Culture 配方的备注，不是对所有深烘豆的规律。你的深烘豆可能更接近这个区间，也可能明显偏离（比如处理法或烘焙曲线不同的批次）。把它当作「有来源的具体案例」而不是通用天数，再用自己的冲煮对比确定这袋豆子的稳定点。",
    "训练「具体案例 ≠ 普遍规律」。")
add("b1-021", "g-b1-d-roast-level", "roasting", "knowledge/roasting/coffee-roasting.md",
    ["sca-coffee-standards", "ucdavis-research-index"],
    ["claim.roasting.sca-131", "claim.roasting.color-curve"],
    "浅烘、中烘、深烘的界限有统一标准吗？",
    "目前没有统一的已发布标准。SCA-131「烘焙度测试方法」仍处于制定中，尚未成为正式标准；同时 UC Davis 的研究发现咖啡豆在烘焙过程中遵循「通用色曲线」，这对如何更一致地定义浅/中/深有重要意义，但那是研究进展而非已落地的行业标尺。所以在标准明确之前，「浅烘/深烘」的边界在不同烘焙商和语境下会有差异，讨论时最好说明自己的参考依据（色值、一爆发展时间或烘焙商标注）。",
    "标准「制定中」是重要事实，防止模型编造标准。")
add("b1-022", "g-b1-d-coldbrew-time", "cold-brew", "knowledge/brewing/cold-brew.md",
    ["ucdavis-coldbrew-2025", "hario-recipe-cards"],
    ["claim.coldbrew.8h-vs-24h", "claim.coldbrew.time-least", "claim.coldbrew.hario-mizudashi"],
    "冷萃一定要泡满 24 小时吗？",
    "不一定。UC Davis 的研究提示：在其实验条件下，8 小时的冷/室温萃取可能提供与 24 小时相近的风味与感官品质；Hario Mizudashi 的官方配方给的也是 8–10 小时冷藏。两者方向一致——不需要默认泡满 24 小时。但注意研究的结论是「时间不是主导变量」，不是「时间无所谓」：你的豆子、研磨与目标浓度都可能改变最优时长，把它当作可以实验的范围，而不是固定值。",
    "冲突登记 conflict.coldbrew.time 的口径已并入。")

# ---- E. 不确定性判断 ----
add("b1-023", "g-b1-e-rest-date", "uncertainty", "knowledge/freshness/freshness.md",
    ["fellow-brew-talks"],
    ["claim.freshness.resting-varies-by-roast"],
    "我只知道豆子的品种名字，能判断它的黄金风味期吗？",
    "不能。养豆窗口与烘焙度、处理法、包装、储存和具体批次的关系可以达到数周量级——同一来源的配方库里，深烘案例是 5–7 天，浅烘案例是 4–6 周——不存在只凭品种名称就能推算的公式。缺少烘焙日期和批次信息时，诚实的回答是「无法判断」；可以给出的是获取信息（问烘焙日期）和自己做冲煮对比的方法，而不是编一个天数。",
    "E 类核心样本。")
add("b1-024", "g-b1-e-origin-only", "uncertainty", "knowledge/origins/coffee-origins.md",
    ["wcr-varieties-catalog"],
    ["claim.origin.env-factors"],
    "只告诉我「这是埃塞俄比亚豆」，你能推断出它的风味吗？",
    "很多结论下不了。产区能提供的只是背景信息：种植带与气候大类。而 WCR 明确环境、海拔、土壤、天气、树龄与农场管理都在产区内部变化巨大；处理法、品种、烘焙度都未知时，连风味方向都难以推断。「埃塞俄比亚部分产区/品种/处理法常见花香描述」是知识库允许的最弱表述，任何更具体的结论——比如「一定是花香」——都是没有依据的推断。要给出有效判断，我需要处理法、烘焙度、批次等信息。",
    "把 METHODOLOGY §4 的红线转化为回答行为。")
add("b1-025", "g-b1-e-v60-recipes", "uncertainty", "knowledge/brewing/pour-over.md",
    ["hario-v60-expert-guide", "hario-v60-hoffmann"],
    ["conflict.v60.official-recipes-differ", "claim.pourover.v60-official-expert", "claim.pourover.v60-hoffmann-recipe"],
    "V60 的标准配方是什么？",
    "没有唯一的标准配方。即便在同一品牌内部，已核验的 V60 配方也各不相同：Hario 官方 Expert 指南是 15g/250g、中细研磨、约 92–96°C、总时长约 2.5 分钟；署名专家 Hoffmann 的配方是 30g/500mL、97°C、闷蒸 45 秒、两分钟内完成主段注水。它们服务不同的器具尺寸、水量与目标风味。所以更有价值的问题不是「哪个是标准的」，而是「这个配方来自谁、为什么器具、什么语境」——把配方当作「来源+作者+器具+语境」的组合，再按自己的豆子调整。",
    "冲突样本：参数分歧的正当性。")
add("b1-026", "g-b1-e-descale", "cleaning-maintenance", "knowledge/cleaning-maintenance/cleaning-maintenance.md",
    ["sage-bes875-ug-i23", "gaggia-classic-manual"],
    ["conflict.descaling.no-universal-cycle", "conflict.gaggia.classic-descale-interval",
     "claim.cleaning.no-universal-cycle", "claim.cleaning.follow-manual",
     "claim.cleaning.cleaning-vs-descaling", "claim.water.gaggia-vinegar-ban"],
    "咖啡机多久除垢一次？有没有通用的周期？",
    "不存在通用除垢周期。已核验的厂商口径差异很大：Sage 按水硬度建议 60–90 天（并用滤芯时另有滤芯周期），Gaggia Classic（2019 版手册）是 2 个月，Nespresso 按胶囊数或半年计，De'Longhi 按水硬度设置提示——同一厂商的不同代际手册甚至也不一致。另外清洗（backflush）与除垢是两件事，周期与耗材都不同。正确做法是：查你手上那台机器对应型号与代际的手册，使用厂商指定的除垢产品（Gaggia 明文禁止用醋），按机器的提示而非固定日历操作。",
    "冲突样本：跨品牌周期不可比。")
add("b1-027", "g-b1-e-inverted", "uncertainty", "knowledge/brewing/immersion-aeropress.md",
    ["aeropress-manual-inverted"],
    ["conflict.aeropress.inverted-method", "claim.aeropress.inverted-not-recommended"],
    "AeroPress 倒置法到底能不能用？",
    "这是一个立场分层问题，不是简单的事实矛盾。官方说明书明确不推荐倒置法，理由是稳定性差、有倾覆后热水喷溅烫伤的风险——这是厂商对安全责任的立场。社区实践中确实有人为了浸泡控制而选择倒置，但社区来源在知识库中被标记为轶事级、且来源状态为待核验，只能作为「存在这种实践」的证据。官方反对的是风险而不是风味；本知识库无法保证任何操作方式的安全，是否采用由你自行判断——采用前请自行评估密封状态、器具稳固性与烫伤风险，并以官方安全说明为准。本知识库不给出「应该用哪种」的单一结论。",
    "冲突样本：官方立场 vs 社区实践的分层呈现。")
add("b1-028", "g-b1-e-espresso-temp", "uncertainty", "knowledge/CONFLICTS.md",
    ["fellow-brew-talks"],
    ["conflict.espresso.brew-temperature-defaults", "claim.espresso.fellow-ratio-example",
     "claim.espresso.fellow-ratio-1to3"],
    "意式萃取的标准温度是多少度？",
    "不存在单一的「标准温度」。已核验的厂商默认值本身就不一致：Fellow 的不同配方分别用 94°C 和 93°C；第三方教育资料常给一个区间而非固定值。可以成立的表述只有两种：「某机型的官方默认是 X°C」（绑定型号的事实），以及「实际温度是配方变量，受豆子、烘焙度、研磨与目标风味影响」。任何「意式最佳温度是 X°C」的说法都把配方变量说成了普适结论。",
    "冲突样本：拒绝伪标准值。")
add("b1-029", "g-b1-s-caffeine", "health", "knowledge/health/coffee-health.md",
    ["fda-caffeine", "efsa-caffeine-opinion"],
    ["claim.health.fda-400", "claim.health.efsa-daily-400", "claim.health.fda-variance", "claim.health.efsa-sleep-100", "claim.health.fda-pregnancy-refer"],
    "每天喝多少咖啡是安全的？",
    "可以引用官方机构的参考口径：FDA 认为，对多数健康成人，每天 400mg 咖啡因一般不与负面影响相关；EFSA 对非孕健康成人的口径同样是每日不超过 400mg。但「多少算多」因人而异——取决于体重、用药、健康状况与个体敏感性；EFSA 还提示单次 100mg 就可能影响部分人的睡眠，尤其临睡前。孕期、备孕或哺乳期的人应咨询医疗人员是否需要限制。以上是官方机构对一般人群的参考值，不构成个人健康建议；含咖啡因的饮料不止咖啡，计算摄入时要把其它来源也算进去。",
    "健康类样本：只引官方口径 + 强个体差异 + 建议就医。")
add("b1-030", "g-b1-s-aeropress-temp", "brewing", "knowledge/brewing/immersion-aeropress.md",
    ["aeropress-how-to-use", "aeropress-manual-inverted"],
    ["conflict.aeropress.water-temperature", "claim.aeropress.official-temp"],
    "为什么 AeroPress 官方建议的水温比手冲低这么多？",
    "AeroPress 官方基准水温是 185°F / 约 85°C（官方 how-to 还提到没有温度计时烧开亦可），明显低于手冲常见的 92–96°C。第三方指南常建议更高温度，那属于配方选择而不是「更正确」——实际温度是可调的配方变量。官方低温基准反映了这个产品的设计取向：较短时间、浸泡加轻压的萃取方式配合较低水温，服务于它自己的基准流程。想用更高温度探索不同风味是可以的，但应知道那已经偏离了官方基准，属于你自己的配方决策。",
    "冲突样本：官方基准 vs 配方变量。")

# ---------------------------------------------------------------------------
# 校验 + 写盘
# ---------------------------------------------------------------------------

def collect_claim_ids():
    ids = set()
    for md in KNOWLEDGE.rglob("*.md"):
        for m in re.finditer(r"\|\s*(claim\.[a-zA-Z0-9.\-]+)\s*\|", md.read_text(encoding="utf-8")):
            ids.add(m.group(1))
    rules = KNOWLEDGE / "troubleshooting" / "troubleshooting.json"
    if rules.is_file():
        for r in json.loads(rules.read_text(encoding="utf-8")).get("rules", []):
            ids.add(r["id"])
    conflicts = KNOWLEDGE / "CONFLICTS.md"
    if conflicts.is_file():
        for m in re.finditer(r"^## (conflict\.[a-zA-Z0-9.\-]+)\s*$",
                             conflicts.read_text(encoding="utf-8"), re.M):
            ids.add(m.group(1))
    return ids


def main():
    registry = json.loads((KNOWLEDGE / "SOURCE_REGISTRY.json").read_text(encoding="utf-8"))
    known_sources = {s["sourceId"] for s in registry.get("sources", [])}
    known_claims = collect_claim_ids()
    print(f"知识库可引用 ID：{len(known_claims)} 个 claim/rule/conflict，{len(known_sources)} 个来源")

    # 现有正式语料的 sample_id（防撞）
    existing_ids = set()
    for f in (COFFEEAI / "data" / "corpus").glob("*.jsonl"):
        for line in f.read_text(encoding="utf-8").splitlines():
            if line.strip():
                existing_ids.add(json.loads(line)["sample_id"])

    errors = []
    seen = set()
    for s in S:
        if s["sample_id"] in seen or s["sample_id"] in existing_ids:
            errors.append(f"{s['sample_id']}: sample_id 重复")
        seen.add(s["sample_id"])
        for sid in s["source_ids"]:
            if sid not in known_sources:
                errors.append(f"{s['sample_id']}: 来源 ID 未注册: {sid}")
        for cid in s["claim_ids"]:
            if cid not in known_claims:
                errors.append(f"{s['sample_id']}: claim ID 在知识库中不存在: {cid}")
        if s["question"].strip() == "" or len(s["answer"].strip()) < 40:
            errors.append(f"{s['sample_id']}: 问题为空或回答过短")
    if errors:
        for e in errors:
            print(f"[构建失败] {e}", file=sys.stderr)
        sys.exit(1)

    out_corpus = Path(__file__).resolve().parent / "batch1_candidates.jsonl"
    out_meta = Path(__file__).resolve().parent / "batch1_candidates.meta.jsonl"
    corpus_lines, meta_lines = [], []
    for s in S:
        messages = [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": s["question"]},
            {"role": "assistant", "content": s["answer"]},
        ]
        corpus_lines.append(json.dumps({
            "sample_id": s["sample_id"], "group_id": s["group_id"], "messages": messages,
        }, ensure_ascii=False))
        meta_lines.append(json.dumps({
            "sample_id": s["sample_id"], "group_id": s["group_id"], "topic": s["topic"],
            "source_doc": s["source_doc"], "source_ids": s["source_ids"],
            "claim_ids": s["claim_ids"], "license_status": "own-original",
            "review_status": "unreviewed", "data_version": DATA_VERSION,
            "dedup_fingerprint": messages_fingerprint(messages),
            # 阶段三：来源级用途声明（外部来源唯一允许的用法，见 coffeeai_common 政策）
            "source_usage": {sid: "fact-extraction-rewrite" for sid in s["source_ids"]},
            "notes": f"阶段二候选（{s['notes']}）",
        }, ensure_ascii=False))
    out_corpus.write_text("\n".join(corpus_lines) + "\n", encoding="utf-8")
    out_meta.write_text("\n".join(meta_lines) + "\n", encoding="utf-8")
    print(f"[OK] 写出 {len(S)} 条候选 → {out_corpus.name} / {out_meta.name}")
    print("[OK] 全部 claim_ids / source_ids 校验通过；review_status 均为 unreviewed")


if __name__ == "__main__":
    main()
