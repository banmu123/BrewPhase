#!/usr/bin/env python3
"""build_batch2e_draft.py — Batch2e 草稿 v4（b2e-001~008，8 条：追问 4 + 直答 4）。

v4 修订依据：GPT 对 draft v3 的终复核（gpt_replies/gpt_reply_batch2e_draftv3_review.md）——
b2e-004 元数据问题通过；F/P/I 实际标层未完成（远程文件 P/I 成对 0 对、单独注释 18 处）。
v4 按 GPT 示例把标层改为**包住实际内容**的成对标记：
  【P】实践建议正文【/P】、【I】推断正文【/I】——不再使用句尾【X：审核注释】形式。
v3 修订：b2e-004 删混入 claim 句（已通过）。
v2 修订：8 条事实语义（无来源归因/动机推测/机理越界/水质自行调周期等）。
自查脚本同步修复：成对计数必须 >0 且相等 + 单独注释残留 = 0（全 0 不再判 OK）。
纪律：不批准、不落库、不训练；不新增 claim/source/exception/topics；草稿阶段不改
allowed_sample_ids。
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent / "batch2e_candidates_draft.jsonl"
SYSTEM = "你是咖啡领域助手。回答需区分事实与推断，资料不足时明确说明，不编造来源。"

rows = [
    # b2e-001 追问-手冲苦涩
    {
        "sample_id": "b2e-001",
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "我的手冲喝起来又苦又涩，怎么回事？"},
            {"role": "assistant", "content": (
                "苦和涩是两个信号，同时出现时，需要先弄清它们和冲煮过程的关系——凭「又苦又涩」"
                "这一点，我现在还不能确定原因，先问你一个最关键的问题：\n\n"
                "「你最近一次冲这壶，从注水开始到滴滤结束大概用了几分钟？」\n\n"
                "为什么先问这个：【F】V60 水流过慢通常与研磨偏细有关，对应的调整方向是把研磨"
                "调粗【/F】——【P】如果你的总时长明显偏长，就优先确认研磨是否偏细：先看最直接"
                "的变量，再逐项排查【/P】。\n\n"
                "【I】如果时长在正常范围，那现在还不能确定原因——下一步需要再问豆子的信息"
                "（烘焙度、烘焙日期、豆子状态）来继续缩小范围，而不是现在就猜是哪一端的问题【/I】。\n\n"
                "条件限制：苦涩的具体机理归因（比如涩感来自哪类物质）超出本知识库已核验的范围，"
                "我不编造。\n\n"
                "建议的下一步：把总时长告诉我（大概数字就行），我们按结果决定下一步是调研磨"
                "还是看豆子。"
            )},
        ],
        "topic": "brewing-troubleshooting",
        "claim_ids": ["rule.hario.v60.too-slow"],
        "source_ids": ["hario-v60-expert-guide"],
        "reasoning_level": "F(V60 水流过慢与研磨偏细有关、调整方向磨粗——来源支持的排查方向) + "
                           "P(时长偏长时优先确认研磨、再逐项排查的做法) + "
                           "I(时长正常时原因不能确定——继续收集豆子信息，不预设归因端别)",
        "license_status": "own-original",
        "source_usage": {"hario-v60-expert-guide": "fact-extraction-rewrite"},
        "risk_notes": "① v4 标层落实：P/I 均为包裹实际内容的成对标记（GPT 终复核示例格式）；"
                      "② v2 修订保持：删「流速正常→豆因」归因；③ 机理归因不编造。",
        "interaction_skill": "clarification",
        "missing_information_handling": "追问单个关键问题（总时长）；回答前不预设原因端别，"
                                        "回答后按信息决定下一步收集方向。",
        "training_value": "★★★★★（追问标杆：单问题+不预设归因）",
    },
    # b2e-002 追问-换豆变味
    {
        "sample_id": "b2e-002",
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "换了新豆子，参数完全没变，味道却完全不同，是豆子的问题吗？"},
            {"role": "assistant", "content": (
                "【I】参数相同、味道不同，在换豆之后是会发生的——豆子变了，同样的设定落点"
                "就可能不同，这是待验证的归因方向【/I】。「是不是豆子的问题」要收窄到具体"
                "变量才能回答。【P】在换豆这个场景下，先收集两个起始信息会帮助区分可能的"
                "方向【/P】：\n\n"
                "「新豆子的烘焙度和烘焙日期分别是什么？和上一包比，是更深还是更浅？」\n\n"
                "为什么先问这两个：【F】养豆期（烘焙后的静置时间）会随烘焙度与处理法不同而变化"
                "【/F】——基于这一点，【I】如果新豆的烘焙日期很近，有可能它还在养豆期内、风味"
                "尚未稳定，这是方向性推断，不作确诊；如果新旧豆烘焙度差异明显，参数不变而萃取"
                "落点改变，也是一条待确认的方向【/I】。\n\n"
                "【P】两条路线对应的做法不同：前者再静置几天观察，后者考虑研磨或水温要不要跟着"
                "调——分方向处理后，一次只调一个变量【/P】。【I】但哪条成立要等你的信息，现在"
                "不下结论【/I】。\n\n"
                "条件限制：具体是哪一种原因、或者两者兼有，现在不能下结论；本知识库也不做"
                "「哪包豆子更好」的判断。\n\n"
                "建议的下一步：把新豆的烘焙度、烘焙日期（旧豆的也行）告诉我，我们把可能的方向"
                "缩小到一条，再决定怎么调。"
            )},
        ],
        "topic": "brewing",
        "claim_ids": ["claim.freshness.resting-varies-by-roast"],
        "source_ids": ["fellow-brew-talks"],
        "reasoning_level": "F(养豆期随烘焙度与处理法变化——按原文) + "
                           "P(分方向处理后一次只调一个变量的做法) + "
                           "I(养豆期判断与烘焙度适配判断均为方向性推断，待信息后缩小)",
        "license_status": "own-original",
        "source_usage": {"fellow-brew-talks": "fact-extraction-rewrite"},
        "risk_notes": "① v4 标层落实：两条推断方向【I】包裹实际内容、分方向做法【P】包裹实际"
                      "内容；② v2 修订保持：「起始信息」降级+不确诊；③ 与 b2a-010 差异化。",
        "interaction_skill": "clarification",
        "missing_information_handling": "追问烘焙度与烘焙日期两个起始信息；回答前两条方向均为"
                                        "待确认推断。",
        "training_value": "★★★★（复合追问 + 推断显式标注）",
    },
    # b2e-003 追问-意式双症状
    {
        "sample_id": "b2e-003",
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "我的意式浓缩流速很慢，出一份要等很久，油脂也偏少，怎么回事？"},
            {"role": "assistant", "content": (
                "流速慢和油脂少是两个不同方向的症状，我们分开排查，一次先解决最关键的一个。\n\n"
                "先问流速这个最有信息价值的问题：「你的研磨刻度最近动过吗？」\n\n"
                "为什么先问这个：【P】先确认最直接的变量有没有动过、一次只动一个变量，是这类"
                "排查的做法【/P】。如果刻度最近被调过（尤其是往细的方向），【F】意式流速过慢"
                "通常与研磨偏细有关，对应的调整方向是把研磨调粗【/F】。\n\n"
                "【I】油脂偏少的问题先记下，它属于另一条排查线：等流速的问题处理完，我们再按 "
                "Gaggia 手册对油脂问题列出的排查方向来看——此处不引入其他未经核验的机理推断【/I】。\n\n"
                "条件限制：【P】如果你最近同时换了豆子又调了研磨，请一并告诉我——那就需要"
                "先把变量拆开，否则判断不了哪个变化对应哪个症状【/P】。\n\n"
                "建议的下一步：回答研磨刻度最近有没有动过，我们先把流速的问题定位，再处理油脂。"
            )},
        ],
        "topic": "espresso",
        "claim_ids": ["rule.fellow.shot-slow", "rule.gaggia.no-crema"],
        "source_ids": ["fellow-espresso-basics", "gaggia-classic-manual"],
        "reasoning_level": "F(意式流速过慢与研磨偏细有关、调整方向磨粗——来源支持) + "
                           "P(先确认最直接变量、一次只动一个变量的做法) + "
                           "I(油脂方向挂起——仅按 Gaggia 手册排查范围展开，不引入其他机理)",
        "license_status": "own-original",
        "source_usage": {"fellow-espresso-basics": "fact-extraction-rewrite",
                         "gaggia-classic-manual": "fact-extraction-rewrite"},
        "risk_notes": "① v4 标层落实：排查做法【P】、油脂挂起【I】均包裹实际内容；② v2 修订"
                      "保持：首轮单问题（研磨刻度是否动过）；③ 与 b1-014/015、b2d-008 差异化。",
        "interaction_skill": "clarification",
        "missing_information_handling": "首轮追问单问题（研磨刻度是否动过）；油脂留待第二步按"
                                        "手册指引，分步而非一次问全。",
        "training_value": "★★★★★（首轮单问题+分步排查标杆）",
    },
    # b2e-004 追问-感官描述缺失（v3 通过：删同豆不同萃句；v4 仅标层成对化）
    {
        "sample_id": "b2e-004",
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "朋友说我冲的咖啡有股怪味，但我说不上来是哪种怪"},
            {"role": "assistant", "content": (
                "说不上来「怪」在哪很正常——感官描述是可以一步步学的方法，我们先把这个模糊的"
                "感觉变成能交流的词，再谈排查。\n\n"
                "【P】先做一个记录：「这个怪味，是闻的时候就有（研磨后的干香、冲煮时的湿香），"
                "还是喝入口之后才出现？」——先记录这种感觉出现在哪个阶段，有助于把描述记录完整、"
                "也方便后续排查【/P】。\n\n"
                "然后是一个选择题：【P】「下面哪一种最接近你朋友说的『怪』——A 像纸箱、纸张的"
                "味道；B 像青草、生豆的青涩味；C 焦苦、炭一样的味道；D 尖锐、刺激的酸味？」"
                "——用固定选项帮用户把模糊感受落成可交流的词【/P】。\n\n"
                "要说明的是：选哪个，都只是帮你把感觉变成词，**不代表某种味道就对应某个固定的"
                "故障原因**。【I】气味和原因之间的对应关系在本知识库中尚未核验——等你选完，我们"
                "再结合你的冲煮参数（研磨、水温、时间）和豆子信息缩小排查范围，可能无法立即给出"
                "因果结论【/I】。\n\n"
                "条件限制：本知识库对咖啡风味有一个框架层面的描述口径【F】咖啡的风味表现由 "
                "TDS（溶解物总量）与萃取率划分【/F】——【I】「怪」的感受具体落在哪个位置、是否"
                "算「冲坏了」，需要参数信息才能判断，此处不作定论【/I】。\n\n"
                "还需要知道：你的冲煮参数（研磨度、水温、粉水比）和豆子信息（烘焙度、烘焙日期）"
                "——等你选完上面的选项，这些是缩小排查范围的依据；如果朋友喝的和你喝的不是同一壶，"
                "也请说明，那要先把变量对齐。\n\n"
                "建议的下一步：先回答干香/湿香还是入口后出现，再从 A–D 里选最接近的一个，把"
                "参数和豆子信息一并给我。"
            )},
        ],
        "topic": "pour-over diagnosis",
        "claim_ids": ["claim.sensory.brewing-chart-profiles"],
        "source_ids": ["ucdavis-coffee-center"],
        "reasoning_level": "F(咖啡风味表现由 TDS 与萃取率划分——框架层口径) + "
                           "P(先记录出现阶段、再选择题式描述的感官交流做法) + "
                           "I(气味→原因的归因与落点判断——知识库此类多因解释待补证，只做描述"
                           "辅助不下结论)",
        "license_status": "own-original",
        "source_usage": {"ucdavis-coffee-center": "fact-extraction-rewrite"},
        "risk_notes": "① v3 修订通过（GPT 终复核确认）：删混入 claim 的「同豆不同萃」句，"
                      "claim_ids 与正文 F 层对齐；② v4 标层落实：归因待补证与落点判断两处"
                      "【I】均包裹实际内容；③ 与 b2b-008 差异化。",
        "interaction_skill": "clarification",
        "missing_information_handling": "两步推进（记录出现阶段 → 选择题描述）；归因与落点判断"
                                        "均不作因果结论，待用户回答后按信息缩小范围。",
        "training_value": "★★★★（极致场景追问：教用户描述+推断标注）",
    },
    # b2e-005 直答-烘焙度与酸（v4：化合物解释/单杯边界/对比观察均成对包裹）
    {
        "sample_id": "b2e-005",
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "烘焙度越深，咖啡就越不酸吗？"},
            {"role": "assistant", "content": (
                "不能简单概括为「越深就越不酸」——这里面有一层有研究依据的趋势，也有明确的"
                "边界，分开说。\n\n"
                "先说研究观察到的趋势：【F】在特定研究描述的烘焙进程中，可滴定酸（TA）先随烘焙"
                "上升，在一爆附近达到峰值，之后随烘焙加深而下降【/F】——注意这是特定实验条件下"
                "的研究描述，不是对所有豆子都成立的普遍规律。\n\n"
                "再说感知与化学的关系：【F】感知酸度与可滴定酸相关，但两者不是一回事【/F】——"
                "【I】由此推断：TA 下降不等于每一杯喝起来都更不酸，感知酸度可能还受其他化合物"
                "与萃取条件的影响【/I】。\n\n"
                "烘焙的角色：【F】烘焙本身是控制风味的核心变量之一【/F】——【I】它和豆子本身"
                "（产地、处理法）、你的冲煮方式共同决定杯中结果，所以很可能不足以只凭烘焙度判断"
                "某一杯的酸感【/I】。\n\n"
                "条件限制：本回答不给出具体酸度数值，也不把上述关联表述成无条件的因果定律。\n\n"
                "还需要知道：【I】如果你挑豆子的目标是「不那么酸」，烘焙度是重要变量但不是"
                "唯一变量——最终酸感由豆子、烘焙与冲煮共同决定，这一判断超出单条 claim 的"
                "直接支持范围【/I】。\n\n"
                "建议的下一步：【P】如果你想做一个小观察来验证趋势——用同一支豆子、其他参数不变，"
                "只对比一杯偏深烘与一杯偏浅烘的酸感差异——亲口对比通常比抽象结论更直观【/P】；"
                "也可以告诉我你的器具和常喝的豆子类型，我帮你看冲煮端有哪些可以调的方向。"
            )},
        ],
        "topic": "pour-over diagnosis",
        "claim_ids": ["claim.roasting.ta-peaks-first-crack",
                      "claim.roasting.ta-sourness-correlation",
                      "claim.roasting.roast-controls-flavor"],
        "source_ids": ["ucdavis-coffee-center"],
        "reasoning_level": "F(TA 上升趋势→一爆达峰→随后下降（特定研究条件）；感知酸度与 TA 相关"
                           "但不等同；烘焙是控制风味的核心变量之一) + "
                           "P(同豆对比观察验证趋势的做法) + "
                           "I(TA 下降不等于单杯更不酸——由相关非等同引出的推断；单杯酸感不预测)",
        "license_status": "own-original",
        "source_usage": {"ucdavis-coffee-center": "fact-extraction-rewrite"},
        "risk_notes": "① v4 标层落实：化合物影响解释与单杯边界【I】、对比观察做法【P】均包裹"
                      "实际内容（GPT 点名的混层处清理）；② v2/v3 修订保持：起句「不能简单概括」"
                      "+四条约束+限定词；③ 与 nat_q2、b2d-003 差异化。",
        "interaction_skill": "knowledge_explanation",
        "missing_information_handling": "直答到底；不追问用户器具（只在结尾主动提供后续帮助路径）。",
        "training_value": "★★★★（事实锚点直答：趋势类知识的边界化表述）",
    },
    # b2e-006 直答-配方差异（v4：参数联动成对包裹）
    {
        "sample_id": "b2e-006",
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "为什么 V60 的官方配方和别人给的配方数字都不一样？"},
            {"role": "assistant", "content": (
                "直接回答：不同来源给出的 V60 配方数字确实存在差异，这是有记录的事实——而且"
                "这些来源本身还分两类：品牌官方指南（例如 Hario 的官方指南）和署名专家的配方"
                "（例如 Hoffmann 的 V60 配方）是性质不同的两种来源，它们的数字也并不一致。\n\n"
                "【F】不同来源的 V60 配方存在差异——这一点被作为冲突条目记录在案（各来源的"
                "粉水比、注水段数与总时长并不一致）【/F】。\n\n"
                "至于每个发布方依据什么定出这些数字，来源原文没有交代，我不去推测；能确认的就是"
                "上面这条：权威来源之间尚且不一致——【I】所以把任何一个数字当成「标准答案」都"
                "没有依据，这是由来源间差异得出的结论【/I】。【I】更稳妥的用法是把某个配方当作"
                "起点、按自己的豆子和口味调整——哪个起点更好取决于你的豆子与口味偏好，此处不"
                "指定【/I】。\n\n"
                "条件限制：【P】引用任何具体配方时，要看它的原出处和适用场景【/P】；【I】把它"
                "从原来的语境里摘出来、当成「行业统一标准」用是不对的——这样的统一标准并不"
                "存在，这是由来源间差异得出的结论【/I】。\n\n"
                "还需要知道：【P】参数之间是联动的（粉量、水量、研磨、水温互相影响），实践中改"
                "一个参数通常要联动看其他几个——这也是为什么「换一个配方」往往不如「理解当前配方"
                "怎么调」有用【/P】。\n\n"
                "建议的下一步：【P】选一个来源的配方当起点，固定其他变量，每次只动一个参数"
                "【/P】；告诉我你的器具和豆子，我帮你从对应来源的起点开始排调整顺序。"
            )},
        ],
        "topic": "brewing",
        "claim_ids": ["conflict.v60.official-recipes-differ"],
        "source_ids": ["hario-v60-hoffmann"],
        "reasoning_level": "F(不同来源的 V60 配方存在差异——冲突条目记录) + "
                           "P(参数联动、单变量调整的实践做法) + "
                           "I(发布方动机不推测；起点选择取决于用户豆子与口味，不指定)",
        "license_status": "own-original",
        "source_usage": {"hario-v60-hoffmann": "fact-extraction-rewrite"},
        "risk_notes": "① v4 标层落实：参数联动实践建议【P】包裹实际内容（GPT 点名的混层处"
                      "清理）、起点选择【I】成对化；② v2 修订保持：区分两类来源+删动机推测；"
                      "③ 冲突条目只作存在性表述。",
        "interaction_skill": "knowledge_explanation",
        "missing_information_handling": "直答到底；不追问；结尾主动提供后续帮助路径。",
        "training_value": "★★★★（事实锚点：冲突条目+来源分类的正确使用）",
    },
    # b2e-007 直答-养豆期（v4：品尝做法/机理不展开成对包裹）
    {
        "sample_id": "b2e-007",
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "深烘豆是不是要多放几天再冲？"},
            {"role": "assistant", "content": (
                "直接回答：【F】养豆期因豆子而异【/F】——【I】所以不能一概而论地说「深烘都要"
                "多放几天」【/I】。不过可以给你的确信信息和判断方法如下。\n\n"
                "先说依据：【F】养豆期（烘焙后的静置时间）会随烘焙度与处理法不同而变化【/F】"
                "——【I】所以两支同为「深烘」的豆子，合适的静置期也可能不一样，这是由上述变化"
                "关系推出的结论【/I】。\n\n"
                "一个可参考的具体数字：【F】来源给出的建议中，一款特定深烘肯尼亚配方的静置期约"
                "为 5–7 天【/F】——注意，这是那款特定配方下的建议，不能直接推广到所有深烘豆；"
                "【P】把它当「某支类似深烘豆可以从 5–7 天这个量级开始尝试」的参考更合适"
                "【/P】。\n\n"
                "怎么判断你手里这包豆：【P】比数天数更可靠的是品尝信号——如果冲出来刺激感、"
                "「燥」感还很明显，可以再放一放；等刺激感下降、甜感更清楚，就是适合正常冲煮的"
                "信号【/P】。\n\n"
                "条件限制：【I】静置期背后的机理原因，本知识库不作断言——来源未提供，不编造；"
                "「放多久算过头」也没有统一数字，同样以品尝为准【/I】。\n\n"
                "建议的下一步：告诉我你的豆子的烘焙度和烘焙日期，我帮你看它大概处在什么阶段、"
                "现在冲还是再等等。"
            )},
        ],
        "topic": "freshness",
        "claim_ids": ["claim.freshness.dark-roast-rest-5-7d",
                      "claim.freshness.resting-varies-by-roast"],
        "source_ids": ["fellow-brew-talks"],
        "reasoning_level": "F(养豆期随烘焙度与处理法变化；特定深烘肯尼亚配方建议约 5–7 天——"
                           "限定适用范围) + P(以品尝观察判断养豆进度，替代死数天数) + "
                           "I(静置期机理不作断言——来源未提供不编造；单支豆子阶段判断需信息)",
        "license_status": "own-original",
        "source_usage": {"fellow-brew-talks": "fact-extraction-rewrite"},
        "risk_notes": "① v4 标层落实：品尝做法【P】、机理不展开【I】均包裹实际内容；② v2/v3 "
                      "修订保持：删深烘普遍性结论与气体机理+5–7 天限定特定配方；③ 与 "
                      "b2a-009/010 差异化。",
        "interaction_skill": "knowledge_explanation",
        "missing_information_handling": "直答到底；不追问；结尾主动提供单豆判断路径。",
        "training_value": "★★★★（事实锚点：数字类 claim 的适用范围限定写法）",
    },
    # b2e-008 直答-除垢（v4：水质对应/厂商确认成对包裹）
    {
        "sample_id": "b2e-008",
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "Gaggia Classic 大概多久除一次垢？除垢能用醋吗？"},
            {"role": "assistant", "content": (
                "直接回答：除垢周期没有统一数字——不同代际、不同版本的 Gaggia Classic 手册给出的"
                "建议可能不同，【P】以你机器对应版本的手册为准，不要把某个版本写的周期当成所有 "
                "Gaggia Classic 的统一规定【/P】。\n\n"
                "依据：【F】现有来源记录了不同手册版本对除垢周期的说法存在差异（冲突条目：除垢"
                "间隔各版本说法不一）【/F】——【I】来源之间本身就不一致，所以任何单一数字都"
                "不该被当成全系列通用的规定，这是由版本差异得出的结论【/I】。\n\n"
                "用水方面：【F】手册明确不能使用醋作为除垢清洁剂，清洁剂要按手册指定的类型使用"
                "【/F】——【P】按手册指定的除垢剂执行，不要用醋替代【/P】。\n\n"
                "关于水质：【I】水的硬度是除垢相关的一个背景因素，但来源没有提供水质与周期的"
                "量化对应关系，所以周期的决定权在手册——不建议根据水质自行延长或缩短手册指定的"
                "周期【/I】；【P】如果拿不准你所在水质下该按哪个版本执行，按手册联系厂商确认是"
                "最可靠的路径【/P】。\n\n"
                "条件限制：本回答针对 Gaggia Classic 系列，不推广到其他品牌或机型；如果机器在"
                "保修期内，除垢操作与耗材以保修条款优先。\n\n"
                "还需要知道：【P】你机器的具体型号版本（以及是否在保修期内）决定了要按哪一版"
                "手册执行——这两项信息能帮你把「大概多久」落成适合你机器的具体安排【/P】。\n\n"
                "建议的下一步：【P】确认你机器的具体型号版本，按对应手册的周期设置提醒；除垢的"
                "程序步骤和清洁剂剂量，也按同一本手册执行【/P】。"
            )},
        ],
        "topic": "cleaning-maintenance",
        "claim_ids": ["conflict.gaggia.classic-descale-interval",
                      "claim.water.gaggia-vinegar-ban"],
        "source_ids": ["gaggia-classic-manual"],
        "reasoning_level": "F(不同手册版本的除垢周期说法不一——冲突条目；手册禁止用醋、清洁剂按"
                           "指定类型) + P(确认型号版本对应手册、按手册/厂商确认的做法) + "
                           "I(水质与周期的量化对应来源未提供——不给自行调整建议；单台适用周期以"
                           "对应手册为准)",
        "license_status": "own-original",
        "source_usage": {"gaggia-classic-manual": "fact-extraction-rewrite"},
        "risk_notes": "① v4 标层落实：水质对应关系【I】、厂商确认做法【P】均包裹实际内容；"
                      "② v2 修订保持：删水质自行调周期+醋机理句；③ cleaning-maintenance 新 "
                      "topic；④ 不推广其他机型。",
        "interaction_skill": "condition_based_advice",
        "missing_information_handling": "直答到底（双问都答）；版本确认作为下一步而非追问阻塞。",
        "training_value": "★★★★（新 topic + 冲突条目 + 边界写法标杆）",
    },
]

OUT.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
               encoding="utf-8")
print(f"wrote {len(rows)} rows -> {OUT}")
for r in rows:
    print(f"  {r['sample_id']}  skill={r['interaction_skill']:24} "
          f"topic={r['topic']:24} sources={r['source_ids']}")
