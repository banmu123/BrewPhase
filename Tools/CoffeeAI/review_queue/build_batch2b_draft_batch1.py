#!/usr/bin/env python3
"""build_batch2b_draft_batch1.py — 阶段六点九-B 第一批草稿（低风险 4 条：b2b-001/002/004/006）。

只写 batch2b_candidates_draft.jsonl（不存在则创建），不批准、不改 approved、
不更新 review_status、不改 source_exceptions.json、不 split、不训练。
写作依据：batch2b_candidate_plan.md + BATCH2_WRITING_SPEC.md + GPT 六点九-B 附加规则 1–3。
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent / "batch2b_candidates_draft.jsonl"
SYSTEM = "你是咖啡领域助手。回答需区分事实与推断，资料不足时明确说明，不编造来源。"

rows = [
    # ---------------- b2b-001 咖啡很酸——先澄清再判断 ----------------
    {
        "sample_id": "b2b-001",
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "我的咖啡很酸，怎么办？"},
            {"role": "assistant", "content": (
                "仅凭「酸」这个描述还不能判断具体原因，需要结合豆子、冲煮参数和酸感类型进一步判断——因为酸在咖啡里既可能是风味特征，也可能是问题的信号，两者的处理方向完全不同。【F】UC Davis 2021 年的研究（发表于 ACS Food Science & Technology）：咖啡的感知酸度与可滴定酸（TA）强相关——酸是咖啡的固有风味特征，而且类型多样，感知酸度甚至是杯测比赛中的专门打分类别，是冲煮咖啡的主导风味轮廓之一】。也就是说，「酸」本身不等于「有问题」。还需要知道几件事才能缩小范围：你用的器具是什么；豆子的烘焙度；酸感更接近明亮的果汁感，还是尖锐刺激、喝完不舒服的那种；以及当前的粉水比例和水温。每项信息能排除的方向不同——例如烘焙度能帮助区分「豆子风格带来的酸」与「萃取问题带来的酸」，滴滤速度能帮助判断萃取是否充分。条件限制：如果酸感明亮多汁、与甜感和风味平衡并存，这通常是浅烘或特定产区豆子的风格【I：具体品种与烘焙度对酸质风格的影响，需要进一步确认】；如果酸感尖锐刺激、伴随明显的寡淡或风味强度不足，则可能与萃取状态有关，但这同样需要看到更多参数才能下结论【I：推断——单凭味觉描述无法定位唯一原因】。建议的下一步：先把上面几项信息补齐（器具、烘焙度、酸感类型、粉水比与水温）；如果同时观察到滴滤速度明显偏快，可以尝试磨细一档再做对比冲煮——但如果速度正常而酸感依然尖锐，就不要沿萃取方向继续调，需要重新判断。"
            )},
        ],
        "topic": "pour-over diagnosis",
        "claim_ids": ["claim.roasting.ta-sourness-correlation"],
        "source_ids": ["ucdavis-coffee-center"],
        "reasoning_level": "F(感知酸度与滴定酸强相关、酸是固有风味特征且类型多样) + P(澄清式诊断流程：先收集最小信息集再判断) + I(酸感类型与萃取状态的对应方向——已标注需要进一步确认)",
        "license_status": "own-original",
        "source_usage": {"ucdavis-coffee-center": "fact-extraction-rewrite"},
        "risk_notes": "① 禁止复刻「酸=欠萃」：回答不把欠萃作为唯一或首选解释，酸首先被定位为固有风味特征；② 澄清问题本身不给结论：所有方向性判断均以 I 层限定词标注；③ 与 batch2a 差异化：b2a-002/003 训练单症状诊断链，本条训练「信息不足时先澄清再诊断」的交互能力。",
        "interaction_skill": "clarification",
        "missing_information_handling": "列出判断所需的最小信息集（器具/豆子烘焙度/酸感类型/粉水比与水温），并说明每项信息能排除什么方向。",
        "training_value": "★★★★★（澄清是交互能力基石）",
    },
    # ---------------- b2b-002 参数矛盾——比例合理但流速异常 ----------------
    {
        "sample_id": "b2b-002",
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "我用 18g 粉、300g 水冲手冲，但是 30 秒就全部流完了，是不是哪里不对？"},
            {"role": "assistant", "content": (
                "这组数据里有一个值得注意的矛盾点：粉水比例（18g/300g，约 1:16.7）落在常见范围内，但 30 秒就滴完对手冲来说明显偏快——两个信号不同向，不能只看其中一个就下结论。先说比例这边：【F】同为 V60 的官方配方，不同渠道给出的数值并不相同——Hario Expert 指南是 15g/250g，Hario 配方卡是 18–20g/300mL——连官方口径都不存在唯一标准参数，所以你的比例本身没有异常】。再看流速这边：【F】按 Hario 官方口径，「手冲太淡（寡淡、浓度不足）」对应研磨偏粗，判断证据正是观察滴滤速度，验证方法是对照更细的研磨】——你的「30 秒流完」与这个规则的观察证据一致，这是目前最值得优先验证的假设。验证顺序建议按影响面排序：先确认研磨刻度，再检查粉层——如果观察到布粉不均、粉床倾斜或注水沿滤纸边缘流下，萃取通道也会造成偏快，此时调研磨就调错了方向；如果粉层正常、刻度也确认偏粗，再对照更细研磨做一次对比冲煮。还需要知道：你的磨豆机型号与当前刻度、滤杯版本——研磨刻度不能跨磨豆机直接套用，同一数字在不同设备上实际粒度不同。条件限制：30 秒流完也可能与注水手法、滤纸贴合度有关，研磨只是待验证的方向之一【I：推断——需结合粉床状态进一步判断】。建议的下一步：把研磨刻度和器具型号告诉我；如果观察到粉床凹陷或明显的边缘通道，先调整布粉与注水再评估；如果粉层正常，可以尝试磨细一档对比一次——如果情况不同（例如流速正常了但味道变差），需要重新判断。"
            )},
        ],
        "topic": "pour-over diagnosis",
        "claim_ids": ["conflict.v60.official-recipes-differ", "rule.hario.v60.too-weak"],
        "source_ids": ["hario-v60-expert-guide"],
        "reasoning_level": "F(V60 官方配方数值互不相同；寡淡对应研磨偏粗、以滴滤速度为证据) + P(矛盾信号下先验证研磨、再排查粉层的优先级) + I(通道/注水手法等替代原因——已标注需进一步判断)",
        "license_status": "own-original",
        "source_usage": {"hario-v60-expert-guide": "fact-extraction-rewrite"},
        "risk_notes": "① 不下「最佳参数」结论：用「官方配方互不相同」的 F 层冲突事实压制唯一参数框架；② 不忽略矛盾信号：比例正常与流速异常被同时指出并分别处理；③ 「刻度不能跨磨豆机换算」为通用常识性表述，本条 claim_ids 未引用 baratza claim（该 claim 归属 b2b-004），此处仅作方向性提示；④ 登记时需将 b2b-002 并入 hario-v60-expert-guide 例外的 allowed_sample_ids（plan 已注明，属既有例外的样本范围对齐）。",
        "interaction_skill": "multi_variable_reasoning",
        "missing_information_handling": "请用户提供研磨刻度（含磨豆机型号）与滤杯版本，用于区分研磨偏粗与萃取通道两类方向。",
        "training_value": "★★★★☆",
    },
    # ---------------- b2b-004 同参数不同豆子——条件化回答 ----------------
    {
        "sample_id": "b2b-004",
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "别人用 15g/250ml 说效果很好，我用完全一样的参数，为什么我的不好喝？"},
            {"role": "assistant", "content": (
                "参数相同并不等于结果相同——甚至连同一批豆子，改变冲法味道都会明显不同，所以「照搬参数」本来就不是一个能直接复制的做法。先看证据：【F】UC Davis 的 Ristenpart 指出：同一批咖啡豆，改变研磨与萃取方式，会落在 Brewing Control Chart 的不同角落、味道明显不同；用秤对照粉水比、调整研磨与冲煮时间，可以预期并主导风味走向】——同一批豆子尚且如此，不同豆子之间的差异只会更大。【F】烘焙进程是滴定酸的主要控制变量之一：TA 从烘焙开始上升、在一爆达到峰值后持续下降】——烘焙度不同的豆子，即便用同一组参数，酸质起点就已经不同。【F】研磨这边也一样：Baratza 明确说明，手册里不含针对具体冲煮方式的研磨刻度，因为正确数值取决于你的豆子与器具】——「同样的 15 格」在不同磨豆机上对应的实际粒度并不相同。所以你与对方的差异可能来自四个方向：豆子烘焙度、豆子新鲜度、研磨的实际粒度（磨豆机型号与刻度）、以及水质。经验上，逐项对齐比盲调参数有效：先确认双方的豆子烘焙度是否一致，再核对磨豆机型号与刻度，最后才轮到水质差异。还需要知道：你和对方各自用的豆子（烘焙度/烘焙日期）、磨豆机型号与刻度——有了这些才能指出差异在哪一项。条件限制：如果对齐了所有条件结果仍不同，则可能与豆况批次差异有关，需要进一步确认【I：推断——批次与储存条件的具体影响因豆而异】。建议的下一步：按「烘焙度 → 磨豆机与刻度 → 新鲜度 → 水」的顺序逐项对齐；如果观察到你们的烘焙度不同，参数起点就需要重新调整，而不是继续沿用对方的比例——逐项对齐一次，比反复盲调有效得多。"
            )},
        ],
        "topic": "pour-over diagnosis",
        "claim_ids": ["claim.sensory.same-bean-different-brew", "claim.roasting.ta-peaks-first-crack", "claim.grinding.manual-not-recipe"],
        "source_ids": ["ucdavis-coffee-center", "baratza-documents"],
        "reasoning_level": "F(同豆不同萃味道明显不同；TA 随烘焙进程变化、一爆达峰；Baratza 明确刻度取决于豆子与器具) + P(逐项对齐对比法) + I(批次与储存条件差异——已标注因豆而异、需进一步确认)",
        "license_status": "own-original",
        "source_usage": {"ucdavis-coffee-center": "fact-extraction-rewrite", "baratza-documents": "fact-extraction-rewrite"},
        "risk_notes": "① 禁止「照搬参数就行」：开篇直接否定参数可复制的前提；② 不编造用户豆子的信息：差异来源以清单形式列出，等待用户补充；③ 数字 15g/250ml 来自用户原话复述，不作为我方推荐；④ 与 b2b-001 差异化：b2b-001 训练澄清，本条训练「参数→条件」的转化。",
        "interaction_skill": "condition_based_advice",
        "missing_information_handling": "列出需要对齐的变量清单（豆子烘焙度/新鲜度/磨豆机型号与刻度/水质），按影响面给出对齐顺序。",
        "training_value": "★★★★☆",
    },
    # ---------------- b2b-006 意式时间迷信——时间是读数不是目标 ----------------
    {
        "sample_id": "b2b-006",
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "听说浓缩萃取 25 秒最好，我的机器要卡在 25 秒吗？"},
            {"role": "assistant", "content": (
                "把 25 秒当作目标，方向就反了——时间不是要凑的目标数字，它是粉量、研磨、比例共同作用的读数，读数的用途是帮你定位问题，不是用来「达标」。【F】Fellow 官方口径正是这样使用 shot 时间的：「流得太慢」对应研磨偏细，验证方法是磨粗一档，而且微调即有明显差别】——时间在这里的身份是诊断证据，不是成绩单。【F】Fellow 自己的配方给的是 18g → 55g（1:3）、93°C、22–25 秒，含 5 秒预浸泡与 17 秒主萃取】——注意，这个 22–25 秒是与这套粉量、比例和预浸泡方案绑定的读数：换了豆子、换了粉量、换了机器、取消预浸泡，合理的时间窗口就会移动，把它单独抽出来当「标准时间」没有意义。经验上，咖啡师会用时间配合味道一起定位方向：时间只是把问题缩小到「研磨该往哪边动」的指针，最终停在哪里由风味决定。还需要知道：你当前的粉量与比例、shot 的实际时间，以及味道表现——有这三样才能判断现在的读数偏快还是偏慢、要不要动研磨。条件限制：不同机器（尤其有无预浸泡、泵压曲线差异）与不同豆子的合理窗口不同，参照某个固定秒数没有普适性【I：具体窗口因豆而异，需要进一步确认】。建议的下一步：固定粉量与比例，只微调研磨，记录每次的时间与味道对比；如果观察到流速偏慢且味道偏苦、口感收敛，可以尝试磨粗一档再对比；如果味道已经平衡，那时间是多少就记录多少——不必强求 25 秒，也不必把时间当成绩。"
            )},
        ],
        "topic": "espresso",
        "claim_ids": ["rule.fellow.shot-slow", "claim.espresso.fellow-ratio-1to3"],
        "source_ids": ["fellow-espresso-basics"],
        "reasoning_level": "F(shot 时间作为诊断证据、流太慢对应磨粗微调；Fellow 配方 1:3/22–25 秒及其预浸泡语境) + P(时间配合味道定位方向的经验做法) + I(合理窗口因豆因机而异——已标注需进一步确认)",
        "license_status": "own-original",
        "source_usage": {"fellow-espresso-basics": "fact-extraction-rewrite"},
        "risk_notes": "① 禁止「25 秒最好」：开篇直接否定目标化时间；② 同时避免反向绝对化——没有说「时间没用」，而是给时间以「诊断证据」的定位；③ Fellow 配方数字带完整语境（粉量/比例/预浸泡），不脱语境引用；④ 与 b2a-003（时间读数）呼应但场景更尖锐：用户把数字当目标，本条训练「目标→指标」的转化。",
        "interaction_skill": "boundary_setting",
        "missing_information_handling": "请用户提供粉量/比例、实际 shot 时间与味道表现，用于定位当前读数的方向。",
        "training_value": "★★★☆☆",
    },
]

if __name__ == "__main__":
    existed = OUT.is_file()
    lines = [json.dumps(r, ensure_ascii=False) for r in rows]
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"{'覆盖' if existed else '创建'} {OUT}：{len(rows)} 条（b2b-001/002/004/006，第一批低风险）")
