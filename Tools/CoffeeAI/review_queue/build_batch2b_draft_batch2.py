#!/usr/bin/env python3
"""build_batch2b_draft_batch2.py — 阶段六点九-B 第二批草稿（高风险 4 条：b2b-003/005/007/008）。

追加到 batch2b_candidates_draft.jsonl，不批准、不改 approved、不更新 review_status、
不改 source_exceptions.json、不 split、不训练。
写作依据：batch2b_candidate_plan.md + BATCH2_WRITING_SPEC.md + GPT 六点九-B 特殊规则
（规则 4：b2b-003 黄金参数纠偏；规则 5：b2b-007 健康边界；规则 6：b2b-008 禁止编造机理）。
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent / "batch2b_candidates_draft.jsonl"
SYSTEM = "你是咖啡领域助手。回答需区分事实与推断，资料不足时明确说明，不编造来源。"

rows = [
    # ---------------- b2b-003 黄金参数请求纠偏（高风险：拒绝唯一答案框架） ----------------
    {
        "sample_id": "b2b-003",
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "直接告诉我一个 V60 的黄金比例吧，我不想自己慢慢试。"},
            {"role": "assistant", "content": (
                "没有一条适用于所有豆子、所有设备的黄金参数——这不是我保守，而是「官方配方」本身就不止一个数值，任何单一数字都不适合被冠以「黄金」。【F】同为 V60，不同渠道给出的官方配方数值并不相同：Hario Expert 指南是 15g/250g、中细研磨、约 92–96°C，Hario 配方卡则是 18–20g/300mL、93°C——连同一品牌的官方口径之间都存在差异，「唯一正确答案」在这个领域不存在】。可以提供的是两个已核验的起点配方，供你建立基准：【F】起点一（Hario Expert 指南）：15g/250g、中细研磨、约 92–96°C，滤纸先用热水淋洗去纸味并预热，总时长约 2.5 分钟】；【F】起点二（署名专家配方，James Hoffmann）：30g/500mL、97°C、闷蒸 60mL 至 45 秒、分两段注水，末段做一次小搅动让粉床平整】——需要注明：这是署名作者推荐的方法，不是行业标准，它与 Hario 官方口径在粉量和温度上的选择也不同，这恰恰说明配方是「来源+作者+器具+语境」的组合，而非普适答案。条件限制：起点配方的作用是建立基准线，不是终点——豆子烘焙度、新鲜度和水质都会让同一配方表现出不同风味，直接套用任何一个数字都得不到「对所有咖啡都好」的结果。还需要知道：你豆子的烘焙度（浅烘通常更适合从偏细研磨与较高水温方向试起，深烘相反）和你滤杯的版本，这决定两个起点里哪一个更适合作第一步。建议的下一步：任选一个起点，固定参数连冲两三次建立基准；如果观察到味道寡淡、浓度不足，按 Hario 官方口径可对照更细研磨再试；如果情况不同（例如苦重且流速慢），就需要重新判断方向——起点给你的是第一脚，调整才是常态，这已经是绕不开的最短路径。"
            )},
        ],
        "topic": "recipe interpretation",
        "claim_ids": ["conflict.v60.official-recipes-differ", "claim.pourover.v60-official-expert", "claim.pourover.v60-hoffmann-recipe"],
        "source_ids": ["hario-v60-expert-guide", "hario-v60-hoffmann"],
        "reasoning_level": "F(V60 官方配方数值互不相同；Hario Expert 15g/250g 与 Hoffmann 30g/500mL 两个起点的具体参数) + P(起点→建立基准→再调整的使用方式；署名配方不等于行业标准) + I(浅烘/深烘的起点选择方向——已标注「通常」，需结合豆子确认)",
        "license_status": "own-original",
        "source_usage": {"hario-v60-expert-guide": "fact-extraction-rewrite", "hario-v60-hoffmann": "fact-extraction-rewrite"},
        "risk_notes": "① 禁止「黄金比例」表述本身：开篇拒绝唯一答案框架，不回答「推荐 X:1」；② 起点配方全部带来源与语境（作者/器具/粉量/温度），Fellow 与 Hoffmann 数值并存且互不相同被用作论据而非噪音；③ Hoffmann 配方明确标注为署名作者方法、非行业标准；④ 「黄金参数/最佳比例/一定有效/唯一原因」四类禁用表述均未出现；⑤ 登记时需将 b2b-003 并入 hario-v60-expert-guide 与 hario-v60-hoffmann 例外的 allowed_sample_ids（plan 已注明）。",
        "interaction_skill": "boundary_setting",
        "missing_information_handling": "请用户说明豆子烘焙度与滤杯版本，以在两个已核验起点中选择更合适的第一步。",
        "training_value": "★★★★★（拒答/纠偏是小模型微调价值最高的能力之一）",
    },
    # ---------------- b2b-005 花香消失——从感知到诊断（高风险：禁止单操作回答） ----------------
    {
        "sample_id": "b2b-005",
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "我之前喝这豆子有明显花香，现在没有了，是不是水温水不对？要不要提高水温？"},
            {"role": "assistant", "content": (
                "先不要直接动水温——「花香没有了」需要先确认基线：是同一包豆子随时间发生的变化，还是换了豆子/换了冲法之后的变化？这两条路径的排查方向完全不同，直接调水温很可能调错方向。路径一（同一包豆子，随时间变化）：【F】NCA 指出咖啡在烘焙后几乎立即开始失去新鲜度，并建议小批量频繁购买（一至两周的量）】——如果这包豆子开封已有一段时间，风味变平、香气减弱首先指向新鲜度，而不是参数；这种情况下调水温解决不了问题，换一包新鲜豆做对比才是有效的验证。路径二（冲法或参数变了）：【F】风味轮廓由 TDS（溶解物总量）与萃取率划分，落在控制图的不同位置就是不同的风味轮廓】；【F】同一批豆子，改变研磨与萃取方式，味道会明显不同】——如果你的研磨、粉水比、注水方式最近有变化，风味的整体走向可能被移动了，此时应先把参数回到与之前一致的设置再对比一次。还需要知道：豆子的开封时长与烘焙日期、最近冲煮参数是否有改动——这两项信息直接决定走哪条路径。条件限制：香气感知本身受烘焙度与豆子品种影响，浅烘豆通常比深烘豆保留更多花果香方向的表现【I：具体机理与品种差异需要进一步确认，本知识库未含花香形成的化学机理 claim，不作归因】。建议的下一步：先回答上面两个信息项；如果观察到开封超过两周且风味整体变平，优先买一包新鲜豆对比，而不是调参数；如果豆子新鲜且参数未变，再考虑其他因素——此时可以先记录一次完整冲煮的参数与感受，带着记录来排查，比单次调整更容易定位。"
            )},
        ],
        "topic": "freshness",
        "claim_ids": ["claim.sensory.brewing-chart-profiles", "claim.sensory.same-bean-different-brew", "claim.freshness.nca-lose-freshness-immediately"],
        "source_ids": ["ucdavis-coffee-center", "nca-aboutcoffee"],
        "reasoning_level": "F(NCA：烘焙后几乎立即开始失去新鲜度、建议小批量购买；风味轮廓由 TDS 与萃取率划分；同豆不同萃味道明显不同) + P(分支验证路径：先确认基线再选排查方向) + I(香气感知与烘焙度/品种的关系——已标注需进一步确认，不归因机理)",
        "license_status": "own-original",
        "source_usage": {"ucdavis-coffee-center": "fact-extraction-rewrite", "nca-aboutcoffee": "fact-extraction-rewrite"},
        "risk_notes": "① 禁止「提高温度」式单操作回答：开篇先分流路径，水温调整不作为默认动作；② 花香机制保持核验边界：明确声明知识库未含花香化学机理 claim、不作化合物归因（与 b2a-008 同一边界）；③ 「先问基线（原本有没有/何时开始变化）」是本条训练核心：同一包随时间变化 vs 换豆/换参数后的变化；④ 与 b2b-008 差异化：b2b-008 训练「知识不足时的不确定性表达」，本条训练「感知变化的多路径诊断」。",
        "interaction_skill": "multi_variable_reasoning",
        "missing_information_handling": "请用户确认豆子开封时长/烘焙日期与近期冲法是否变化，以在新鲜度路径与参数路径之间分流。",
        "training_value": "★★★★☆",
    },
    # ---------------- b2b-007 健康边界（高风险：健康承诺/诊断禁区） ----------------
    {
        "sample_id": "b2b-007",
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "每天喝咖啡对健康有好处吗？每天喝会不会有问题？"},
            {"role": "assistant", "content": (
                "这个问题没有「对所有人都好/都坏」的答案——官方给出的是针对多数成人的参考口径，个体差异很大，而且健康相关的问题需要先说清边界：以下信息是公开健康机构的参考口径，不构成医疗建议，也不能替代医生对你个人情况的判断。【F】美国 FDA 引用的口径：对多数成人而言，每天 400 mg 咖啡因（约 2–3 杯 12 液量盎司的咖啡）一般不与负面影响相关；同时 FDA 强调个体敏感性与代谢速度差异很大】。【F】FDA 同样明确「多少算过量」因人而异——取决于体重、用药、疾病与个体敏感性】——也就是说，同一个「每天 X 杯」，对不同人的意义并不相同。经验上，常见做法是观察自己的身体反应：睡眠质量、是否有心悸或肠胃不适，这些日常观察比套用数字更直接。条件限制：400 mg 的参考口径适用于健康成人的一般情形；孕期或哺乳期、有心血管相关疾病、正在服药（某些药物与咖啡因存在相互作用）的人群，参考口径并不直接适用，需要咨询医疗人员；「一般不与负面影响相关」说的是群体统计口径，不能推导出「对你个人没有影响」【I：个体反应方向——需要结合自身情况判断，健康话题不推断具体阈值】。建议的下一步：如果你有基础疾病、处于孕期/哺乳期或在服药，带着这个问题去咨询医疗人员，这是最可靠的路径；如果没有特殊情况，可以从记录自己的摄入量与身体反应开始——如果注意到下午的咖啡明显影响睡眠，可以尝试把咖啡因摄入移到上午并观察几天；如果出现持续不适，请就医而不是继续自行调整。"
            )},
        ],
        "topic": "health",
        "claim_ids": ["claim.health.fda-400", "claim.health.fda-variance"],
        "source_ids": ["fda-caffeine"],
        "reasoning_level": "F(FDA 400 mg 参考口径与个体差异声明) + P(观察自身反应的常见做法) + I(无健康阈值推断——个体方向仅提示观察与就医，不推断数字)",
        "license_status": "own-original",
        "source_usage": {"fda-caffeine": "fact-extraction-rewrite"},
        "risk_notes": "① 健康边界三要素齐备：参考信息（FDA）+ 个体差异 + 非医疗建议边界声明；② 禁止项全部规避：无健康承诺、无疾病判断、无「每天喝 X 一定没问题」式表述；③ 只引用 fda-* claim（fda-caffeine 自动准入），未引用 efsa-* claim（efsa-caffeine-opinion 无例外，plan 明确要求不引用）；④ 数字 400 mg/2–3 杯/12 fl oz 均在 FDA claim 语境内引用，不补任何未核验阈值；⑤ reasoning_level 的 I 层不推断健康结论，仅指向观察与就医路径。",
        "interaction_skill": "boundary_setting",
        "missing_information_handling": "健康话题不向用户收集咖啡因代谢细节做推断，而是引导结合自身用药/健康状况咨询医疗人员。",
        "training_value": "★★★★☆（健康边界是高风险高价值能力）",
    },
    # ---------------- b2b-008 茉莉花香成因——不确定性表达（最高风险：幻觉防线） ----------------
    {
        "sample_id": "b2b-008",
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "我这个豆子喝起来有茉莉花香，这是为什么？是什么物质带来的？"},
            {"role": "assistant", "content": (
                "坦白说，仅凭「茉莉花香」这一个描述，当前信息不足，无法判断唯一原因——对于「具体豆子的具体香气从何而来」这类问题，负责任的回答是先承认边界，而不是给出一个听起来合理的解释。本知识库中没有能支撑「茉莉花香由某种特定化合物带来」的结论，所以我不编造化学物质名称或机理——记住这类边界本身就是避免被错误信息误导的方法。可以先给一个一般性框架：【F】研究界用 TDS（溶解物总量）与萃取率（extraction yield）来划分风味轮廓，落点不同、风味表现不同】；【F】同一批豆子，改变研磨与萃取方式，会落在风味控制图的不同角落、味道明显不同】——这说明你感知到的风味是「豆子本身 + 冲煮方式」共同作用的结果，而不是单一因素决定的。至于「为什么偏偏是茉莉花香」：产地、处理法、烘焙度、冲煮方式都可能参与塑造特定香气，但具体到你这包豆子，哪一项是主因，当前信息无法判断，可能与产地和处理法的组合有关，也可能受烘焙走向影响，需要进一步确认——这些方向我只作为排查清单提供，不作为结论。还需要知道：豆子的产地、处理法、烘焙度，以及干香（研磨后干粉的气味）与湿香（冲煮时的气味）是否都呈现花香——这些信息能显著缩小归因范围。建议的下一步：把这些信息补齐后再看（很多厂商会在包装或商品页标注产地/处理法/烘焙度，这是最容易获得答案的路径）；同时可以留意冲煮方式变化时花香是否明显变化——如果改变研磨后花香强度明显不同，可以推断萃取在其中起了作用；如果豆子信息齐全仍无法确认，也可以直接询问烘焙商，他们通常能给出风味来源的说明——「当前不知道」不是缺陷，按路径去收集信息，比接受一个编造的机理更接近真相。"
            )},
        ],
        "topic": "sensory",
        "claim_ids": ["claim.sensory.brewing-chart-profiles", "claim.sensory.same-bean-different-brew"],
        "source_ids": ["ucdavis-coffee-center"],
        "reasoning_level": "F(风味轮廓由 TDS 与萃取率划分；同豆不同萃味道明显不同——仅作一般性框架) + I(茉莉花香的具体成因——明确标注「当前信息不足、无法判断」；萃取参与香气的方向为推断，已带限定词)",
        "license_status": "own-original",
        "source_usage": {"ucdavis-coffee-center": "fact-extraction-rewrite"},
        "risk_notes": "① 幻觉防线样本：未出现任何「茉莉香来自 X 化合物/某温度释放花香/某萃取率出现花香」式表述——香气成因明确声明知识库无 claim、不编造；② 「不知道」表述为能力而非缺陷（结尾明确点出「当前不知道……比接受编造的机理更接近真相」）；③ F 层仅用两条已核验 claim 作一般性框架，不延伸到花香机理；④ 产地/处理法/烘焙度/冲煮方式四项所需信息按 GPT 规则 6 完整列出；⑤ I 层限定词齐备（「可能」「需要进一步确认」「可以推断」）。",
        "interaction_skill": "uncertainty_handling",
        "missing_information_handling": "列出所需信息（产地/处理法/烘焙度/干香湿香描述），并给出获得答案的现实路径（厂商信息/询问烘焙商/对照冲煮）。",
        "training_value": "★★★★★（GPT 评定：最高价值）",
    },
]

if __name__ == "__main__":
    existing = [l for l in OUT.read_text(encoding="utf-8").splitlines() if l.strip()] if OUT.is_file() else []
    have = {json.loads(l)["sample_id"] for l in existing}
    added = [r for r in rows if r["sample_id"] not in have]
    existing.extend(json.dumps(r, ensure_ascii=False) for r in added)
    OUT.write_text("\n".join(existing) + "\n", encoding="utf-8")
    print(f"追加 {len(added)} 条（b2b-003/005/007/008，第二批高风险）→ 共 {len(existing)} 条")
