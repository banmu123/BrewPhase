#!/usr/bin/env python3
"""build_batch2e_draft.py — Batch2e 草稿（b2e-001~008，8 条：追问 4 + 直答 4）。

依据：batch2e_candidate_plan.md v3（GPT 批准进 draft：gpt_replies/gpt_reply_batch2e_planv2_two_fixes.md
+ 批准回复）+ Batch2d 草稿格式。
Draft 要求（GPT 批准回复原文）：
  - 追问侧 4 条：优先用一个具有诊断价值的问题推进对话；不把症状与原因写成确定
    因果关系；证据不足时明确标注为待验证推断；
  - 直答侧 4 条：保持直接回答，不为强化 clarification 改成反问；
  - b2e-005 特别要求：ta-peaks-first-crack 是特定研究结论，不泛化；正文同时解释
    感知酸度与 TA 的关联及结论边界，不将趋势泛化为定律；
  - 准入与授权：逐条保留 claim/source/topic 和 F/P/I 边界；草稿阶段不改
    allowed_sample_ids。
纪律：不批准、不落库、不训练；不新增 claim/source/exception/topics。
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent / "batch2e_candidates_draft.jsonl"
SYSTEM = "你是咖啡领域助手。回答需区分事实与推断，资料不足时明确说明，不编造来源。"

rows = [
    # b2e-001 追问-手冲苦涩（单问题分流；不写确定诊断）
    {
        "sample_id": "b2e-001",
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "我的手冲喝起来又苦又涩，怎么回事？"},
            {"role": "assistant", "content": (
                "苦和涩是两个信号，同时出现时最需要先分清的，是它们主要来自冲煮端还是豆子端——"
                "凭「又苦又涩」这一点，我还不能直接下结论，先问你一个最关键的问题：\n\n"
                "「你最近一次冲这壶，从注水开始到滴滤结束大概用了多久？水流是偏快地冲完，"
                "还是细细地拖了很长时间？」\n\n"
                "为什么先问这个：如果水流明显偏慢，【F】V60 水流过慢通常与研磨偏细有关，"
                "对应的调整方向是把研磨调粗】——研磨偏细会让萃取时间拉长，这是优先排查的方向，"
                "也是来源明确支持的排查路径。\n\n"
                "如果流速和时长都正常，那苦涩更可能与豆子本身有关（烘焙度、豆子状态、豆子本身"
                "的特性）——但这一步要等你回答上面的问题之后再排查，现在不猜：冲煮端和豆子端"
                "的调整方向完全不同，先定位再动手，比同时调两个变量更容易判断哪个起了作用"
                "【I：豆因方向——待你的流速/时长信息确认后再排查，此处不作判断】。\n\n"
                "条件限制：苦涩的具体机理归因（比如涩感来自哪类物质）超出本知识库已核验的范围，"
                "我不编造。\n\n"
                "建议的下一步：把总时长和水流状态告诉我（大概数字就行），我们先缩小范围，"
                "再决定是调研磨还是看豆子。"
            )},
        ],
        "topic": "brewing-troubleshooting",
        "claim_ids": ["rule.hario.v60.too-slow"],
        "source_ids": ["hario-v60-expert-guide"],
        "reasoning_level": "F(V60 水流过慢与研磨偏细有关、调整方向磨粗——来源支持的排查方向) + "
                           "P(先定位冲煮端/豆子端、一次只动一个变量的排查做法) + "
                           "I(豆因方向待确认——不作确定诊断；苦涩机理归因超出已核验范围不编造)",
        "license_status": "own-original",
        "source_usage": {"hario-v60-expert-guide": "fact-extraction-rewrite"},
        "risk_notes": "① GPT draft 要求：单个有诊断价值的问题推进；症状与原因不写成确定因果——"
                      "「流速慢→优先排查研磨」是来源支持的排查方向表述，非「苦涩+慢=过萃」的确诊；"
                      "② 流速正常分支不预设归因豆子，作待确认方向【I】；③ 苦涩机理不编造。",
        "interaction_skill": "clarification",
        "missing_information_handling": "追问单个关键问题（总时长与流速状态），拿到回答后缩小"
                                        "排查范围；不提前给唯一原因。",
        "training_value": "★★★★★（追问标杆：单问题区分冲煮端/豆子端）",
    },
    # b2e-002 追问-换豆变味（复合问题索取两个紧密相关字段；两原因为待确认方向）
    {
        "sample_id": "b2e-002",
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "换了新豆子，参数完全没变，味道却完全不同，是豆子的问题吗？"},
            {"role": "assistant", "content": (
                "参数相同、味道不同，在换豆之后是常见现象——参数只是设定，豆子变了，同样的设定"
                "落点就不同了。但「是不是豆子的问题」要收窄到具体变量才能回答，先问你一个信息"
                "收集的问题：\n\n"
                "「新豆子的烘焙度和烘焙日期分别是什么？和上一包比，是更深还是更浅？」\n\n"
                "为什么问这两个：它们是豆子侧最常改变风味的两个变量。【F】养豆期（烘焙后的静置"
                "时间）会随烘焙度与处理法不同而变化】——如果新豆烘焙日期很近，可能还在养豆期内，"
                "风味没稳定；如果新旧豆烘焙度差异大，原参数下的萃取落点也会不同。这两种原因"
                "对应的做法不一样：前者是再放几天再冲，后者是考虑研磨或水温要不要跟着调——"
                "但在拿到你的烘焙度和日期之前，这两条只是待确认的方向，不是结论【I：具体原因"
                "——需要烘焙度与烘焙日期信息后才能缩小，此处不作判断】。\n\n"
                "条件限制：如果你能提供烘焙商给的风味描述，也有助于对比新旧豆的目标口感差异；"
                "本知识库不做「哪包豆子更好」的判断。\n\n"
                "建议的下一步：把新豆的烘焙度、烘焙日期（旧豆的也行）告诉我，我们先区分是"
                "养豆期问题还是参数适配问题，再决定怎么调。"
            )},
        ],
        "topic": "brewing",
        "claim_ids": ["claim.freshness.resting-varies-by-roast"],
        "source_ids": ["fellow-brew-talks"],
        "reasoning_level": "F(养豆期随烘焙度与处理法变化——非固定天数) + "
                           "P(对比新旧豆烘焙度与日期、一次只调一个变量的做法) + "
                           "I(具体原因待确认——两种方向均不作确诊)",
        "license_status": "own-original",
        "source_usage": {"fellow-brew-talks": "fact-extraction-rewrite"},
        "risk_notes": "① GPT 裁定：复合问题索取两个紧密相关字段可以；两种原因作为待确认方向，"
                      "不宣称能确诊；② 醒豆时长不编造绝对数字；③ 与 b2a-010（同包豆开封时间轴）"
                      "差异化：本条是换豆（豆间差异）。",
        "interaction_skill": "clarification",
        "missing_information_handling": "追问烘焙度与烘焙日期两个紧密相关字段；回答前不区分"
                                        "养豆期问题与参数适配问题。",
        "training_value": "★★★★（复合追问 + 待确认方向呈现）",
    },
    # b2e-003 追问-意式双症状（v2 改题：流速过慢；首轮单问题，另一症状挂起）
    {
        "sample_id": "b2e-003",
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "我的意式浓缩流速很慢，出一份要等很久，油脂也偏少，怎么回事？"},
            {"role": "assistant", "content": (
                "流速慢和油脂少是两个不同方向的症状，我们分开排查，一次先解决最关键的一个。\n\n"
                "先问流速这个最有信息价值的问题：「你的研磨刻度最近动过吗？现在的刻度比之前"
                "细还是粗？」\n\n"
                "为什么先问这个：【F】意式流速过慢通常与研磨偏细有关，对应的调整方向是把研磨"
                "调粗】——这是来源明确支持的排查方向：研磨是决定流速的第一变量，先确认它有没有"
                "被动过，比同时检查多个东西更快定位。\n\n"
                "油脂偏少的问题先记下，等流速定位后再看：「油脂的多少通常和豆子的新鲜度、烘焙度"
                "有关——那是另一条排查线。一次只动一个变量，你才能知道哪个调整起了作用；等研磨"
                "的问题处理完，我们再看豆子那边的日期和烘焙度」【I：油脂方向——待流速排查后再"
                "处理，此处不作判断】。\n\n"
                "条件限制：如果你最近同时换了豆子又调了研磨，请一并告诉我——那就需要先把变量"
                "拆开，否则判断不了哪个变化对应哪个症状。\n\n"
                "建议的下一步：回答研磨刻度的变化情况，我们先把流速调回正常区间，再看油脂。"
            )},
        ],
        "topic": "espresso",
        "claim_ids": ["rule.fellow.shot-slow", "rule.gaggia.no-crema"],
        "source_ids": ["fellow-espresso-basics", "gaggia-classic-manual"],
        "reasoning_level": "F(意式流速过慢与研磨偏细有关、调整方向磨粗——来源支持) + "
                           "P(双症状分开排查、首轮单问题、一次只动一个变量的做法) + "
                           "I(油脂方向挂起——待流速排查后处理，不作判断)",
        "license_status": "own-original",
        "source_usage": {"fellow-espresso-basics": "fact-extraction-rewrite",
                         "gaggia-classic-manual": "fact-extraction-rewrite"},
        "risk_notes": "① v2 改题落实：症状为流速过慢，与 rule.fellow.shot-slow 方向一致（过慢→"
                      "磨粗）；② GPT 批准要求：首轮只问一个问题（研磨），油脂挂起并说明分步原因——"
                      "避免信息收集清单式追问；③ 油脂机理不编造，no-crema 按原文支撑排查；"
                      "④ 与 b1-014/015（口味症状）、b2d-008（时间信号）差异化。",
        "interaction_skill": "clarification",
        "missing_information_handling": "首轮追问研磨刻度变化（单问题）；油脂相关豆子信息留待"
                                        "第二步，明确分步而非一次问全。",
        "training_value": "★★★★★（首轮单问题+分步排查标杆）",
    },
    # b2e-004 追问-感官描述缺失（v2 降级：选项仅辅助描述，映射删除）
    {
        "sample_id": "b2e-004",
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "朋友说我冲的咖啡有股怪味，但我说不上来是哪种怪"},
            {"role": "assistant", "content": (
                "说不上来「怪」在哪很正常——感官描述是可以一步步学的方法，我们先把这个模糊的"
                "感觉变成能交流的词，再谈排查。\n\n"
                "先帮你定位感觉的位置：「这个怪味，是闻的时候就有（研磨后的干香、冲煮时的湿香），"
                "还是喝入口之后才出现？」——闻到和喝到的怪，指向的环节不同，这一步能先把范围"
                "分成两半。\n\n"
                "然后是一个选择题：「下面哪一种最接近你朋友说的『怪』——A 像纸箱、纸张的味道；"
                "B 像青草、生豆的青涩味；C 焦苦、炭一样的味道；D 尖锐、刺激的酸味？」\n\n"
                "要说明的是：选哪个，都只是帮你把感觉变成词，**不代表某种味道就对应某个固定的"
                "故障原因**。等你选完，我们再结合你的冲煮参数（研磨、水温、时间）和豆子信息"
                "缩小排查方向——味道和原因之间的对应关系需要结合信息验证，而不是直接对号入座"
                "【I：气味到原因的归因——此类多因解释与判别方法在本知识库中尚待补证，此处只做"
                "描述辅助，不下因果结论】。\n\n"
                "一个背景信息帮你放宽心：【F】咖啡的风味表现由 TDS（溶解物总量）与萃取率划分，"
                "同一批豆子改变研磨与萃取方式，会落在风味控制图的不同位置、味道明显不同】——"
                "所以「怪」未必是冲坏了，也可能只是这杯落在了你不习惯的位置。\n\n"
                "还需要知道：你的冲煮参数（研磨度、水温、粉水比）和豆子信息（烘焙度、烘焙日期）"
                "——等你选完上面的选项，这些是缩小排查范围的依据；如果朋友喝的和你喝的不是同一壶，"
                "也请说明，那要先把变量对齐。\n\n"
                "建议的下一步：从 A–D 里选最接近的一个（或者都不像、再描述一下），把参数和豆子"
                "信息一并给我。"
            )},
        ],
        "topic": "pour-over diagnosis",
        "claim_ids": ["claim.sensory.brewing-chart-profiles"],
        "source_ids": ["ucdavis-coffee-center"],
        "reasoning_level": "F(风味表现由 TDS 与萃取率划分、同豆不同萃——多维框架) + "
                           "P(先定位闻/喝、再选择题式描述的感官交流做法) + "
                           "I(气味→原因的归因——知识库此类多因解释待补证，只做描述辅助不下结论)",
        "license_status": "own-original",
        "source_usage": {"ucdavis-coffee-center": "fact-extraction-rewrite"},
        "risk_notes": "① GPT v2 裁定落实：v1 的「纸味→滤纸未润洗」等映射全部删除；选项仅用于"
                      "帮助描述，不暗示气味唯一对应环节；② brewing-troubleshooting 待补证边界"
                      "如实标注【I】；③ 与 b2b-008（已知花香问机理）差异化。",
        "interaction_skill": "clarification",
        "missing_information_handling": "先定位闻/喝，再选择题式追问描述；归因关系不作因果结论，"
                                        "待用户回答后按信息缩小范围。",
        "training_value": "★★★★（极致场景追问：教用户描述+推断标注）",
    },
    # b2e-005 直答-烘焙度与酸（v3：三条 claim；四条约束）
    {
        "sample_id": "b2e-005",
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "烘焙度越深，咖啡就越不酸吗？"},
            {"role": "assistant", "content": (
                "总体趋势上可以说「是的」，但要先把话说准：烘焙加深时，咖啡的酸通常呈下降趋势，"
                "这个趋势有依据；它不是「深烘必然不酸」的定律，也不能拿来预测每一杯。\n\n"
                "依据分三层：【F】在特定研究描述的烘焙进程中，可滴定酸（TA）先随烘焙上升，在"
                "一爆附近达到峰值，之后随烘焙加深而下降】——这是 TA 的变化趋势，注意它来自特定"
                "实验条件下的研究描述，不是所有豆子的普遍规律。【F】感知酸度与可滴定酸相关，"
                "但两者不是一回事】——TA 是化学量，你舌头感受到的「酸」还受其他化合物与萃取"
                "条件影响，所以 TA 低不等于喝起来一定不酸。【F】烘焙本身是控制风味的核心变量"
                "之一】——这正是烘焙度能改变酸感的原因，但豆子本身（产地、处理法）和你的冲煮"
                "方式同样在起作用。\n\n"
                "条件限制：这个趋势不足以预测每一杯的酸感——豆子、烘焙曲线、冲煮的水温和萃取率"
                "都会改变杯中实际感受到的酸；本回答不给出具体酸度数值，也不把关联表述成无条件"
                "的因果定律。\n\n"
                "还需要知道：如果你挑豆子的目标是「不那么酸」，烘焙度是重要变量但不是唯一变量——"
                "冲煮端（水温、研磨、萃取率）同样能改变杯中酸感。\n\n"
                "建议的下一步：告诉我你的器具和常喝的豆子类型，我帮你看冲煮端有哪些可以调的方向；"
                "如果你想做一个小观察来验证趋势——用同一支豆子、其他参数不变，只对比一杯偏深烘"
                "与一杯偏浅烘的酸感差异——亲口对比会比抽象结论更直观。"
            )},
        ],
        "topic": "pour-over diagnosis",
        "claim_ids": ["claim.roasting.ta-peaks-first-crack",
                      "claim.roasting.ta-sourness-correlation",
                      "claim.roasting.roast-controls-flavor"],
        "source_ids": ["ucdavis-coffee-center"],
        "reasoning_level": "F(TA 上升趋势→一爆达峰→随后下降（特定研究条件）；感知酸度与 TA 相关"
                           "但不等同；烘焙是控制风味的核心变量之一) + "
                           "P(挑豆时把烘焙度当重要变量而非唯一变量的做法) + "
                           "I(单杯酸感不预测——趋势非定律，不编数值)",
        "license_status": "own-original",
        "source_usage": {"ucdavis-coffee-center": "fact-extraction-rewrite"},
        "risk_notes": "① GPT v3 复核四条约束逐条落实：不当规律/说明 TA 趋势与感知关联/明确不足以"
                      "预测单杯且不忽略豆子烘焙冲煮条件/不编数值不定因果律；② ta-peaks-first-crack"
                      " 是特定研究结论，正文明确「特定实验条件下的研究描述」；③ 与 nat_q2（绝对化"
                      "纠偏）、b2d-003（反事实纠错）差异化：本条为直接知识解释。",
        "interaction_skill": "knowledge_explanation",
        "missing_information_handling": "直答到底；不追问用户器具（只在结尾主动提供后续帮助路径）。",
        "training_value": "★★★★（事实锚点直答 + 三层依据结构）",
    },
    # b2e-006 直答-官方配方为何不同（conflict claim；配方保持原来源场景）
    {
        "sample_id": "b2e-006",
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "为什么 V60 的官方配方和别人给的配方数字都不一样？"},
            {"role": "assistant", "content": (
                "直接回答：因为不同来源的「官方配方」本来就是各自给出的建议起点，它们彼此不同是"
                "正常现象，不是谁算错了，也不存在一个统一的「官方数字」。\n\n"
                "【F】不同官方来源给出的 V60 配方确实存在差异——这一点被作为冲突条目记录在案"
                "（各来源的粉水比、注水段数与总时长并不一致）】。每个配方是发布方基于自己的豆子、"
                "研磨标准与目标口感定的起点：它对发布方的设定成立，不等于对你的豆子和口味同样"
                "最优。\n\n"
                "条件限制：引用任何具体配方时，要看它的原出处和适用场景——把它从原来的语境里"
                "摘出来、当成「行业统一标准」用，是不对的，因为这样的统一标准并不存在。\n\n"
                "还需要知道：参数之间是联动的（粉量、水量、研磨、水温互相影响），所以起点不同"
                "的配方，背后的调整逻辑是相通的——这也是为什么「换一个配方」往往不如「理解当前"
                "配方怎么调」有用。\n\n"
                "建议的下一步：选一个来源的配方当起点，固定其他变量，每次只动一个参数；告诉我"
                "你的器具和豆子，我帮你从对应来源的起点开始排调整顺序。"
            )},
        ],
        "topic": "brewing",
        "claim_ids": ["conflict.v60.official-recipes-differ"],
        "source_ids": ["hario-v60-hoffmann"],
        "reasoning_level": "F(不同官方来源的 V60 配方存在差异——冲突条目记录) + "
                           "P(选一个起点、每次只动一个参数的做法) + "
                           "I(配方适用性判断——需结合用户豆子与器具，不下唯一结论)",
        "license_status": "own-original",
        "source_usage": {"hario-v60-hoffmann": "fact-extraction-rewrite"},
        "risk_notes": "① GPT v2 裁定：保留——conflict claim 与题目直接相关，解释「为什么不同」"
                      "而非再答「有没有黄金参数」（与 b2b-003 差异化）；② 具体配方保持原来源与"
                      "适用场景，不概括为行业唯一标准。",
        "interaction_skill": "knowledge_explanation",
        "missing_information_handling": "直答到底；不追问；结尾主动提供后续帮助路径。",
        "training_value": "★★★★（事实锚点：冲突条目的正确使用方式）",
    },
    # b2e-007 直答-深烘醒豆（v2 加适用范围限定：5-7 天仅特定配方）
    {
        "sample_id": "b2e-007",
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "深烘豆是不是要多放几天再冲？"},
            {"role": "assistant", "content": (
                "直接回答：通常是的——深烘豆一般比浅烘更需要放置几天再冲，但「几天」没有统一"
                "答案，要看具体的豆子和烘焙情况。\n\n"
                "依据：【F】来源给出的参考范围是：特定深烘豆（一款肯尼亚配方的深烘）建议约 "
                "5–7 天的静置期】——注意，这是那个特定配方下的建议，不是所有深烘豆的通用数字。"
                "【F】养豆期会随烘焙度与处理法不同而变化】——所以两支同为「深烘」的豆子，合适"
                "的静置期也可能不一样。\n\n"
                "为什么深烘通常要放更久：烘焙越深，豆内积累的气体和烘烤气味越明显，静置几天让"
                "它们先释放一部分，冲出来的风味会更稳定——这是养豆作为常见做法层面的解释，气体"
                "释放的具体机理本知识库不展开【P：养豆是常见做法；机理不作断言】。\n\n"
                "条件限制：刚烘好就冲不是不行，但风味可能偏「燥」、刺激感更明显；反过来，放置"
                "也不是越久越好——放过头会往不新鲜的方向走，和其他豆子一样有赏味窗口。\n\n"
                "还需要知道：判断养豆到没到位，最直接的信号是冲出来尝——刺激感和「燥」感下降、"
                "甜感更清楚，就是适合多冲的信号；这比数天数更可靠。\n\n"
                "建议的下一步：如果告诉我你的豆子的烘焙度和烘焙日期，我帮你判断它大概处在什么"
                "阶段、现在冲还是再等等。"
            )},
        ],
        "topic": "freshness",
        "claim_ids": ["claim.freshness.dark-roast-rest-5-7d",
                      "claim.freshness.resting-varies-by-roast"],
        "source_ids": ["fellow-brew-talks"],
        "reasoning_level": "F(特定深烘肯尼亚配方建议约 5–7 天静置——非通用数字；养豆期随烘焙度"
                           "与处理法变化) + P(养豆常见做法；以品尝信号判断比数天数可靠) + "
                           "I(气体释放机理不展开；单支豆子的阶段判断需烘焙度与日期信息)",
        "license_status": "own-original",
        "source_usage": {"fellow-brew-talks": "fact-extraction-rewrite"},
        "risk_notes": "① GPT v2 裁定：5–7 天是特定深烘肯尼亚豆配方的建议范围，正文明确限定适用"
                      "范围、不推广到所有深烘豆；② 与 b2a-009/010（陈化/开封变化）差异化：本条是"
                      "「养豆期」；③ 不编造普适数字。",
        "interaction_skill": "knowledge_explanation",
        "missing_information_handling": "直答到底；不追问；结尾主动提供单豆判断路径。",
        "training_value": "★★★★（事实锚点：数字类 claim 的适用范围限定写法）",
    },
    # b2e-008 直答-除垢（v2 加冲突边界：不同代际手册不同周期；禁醋按原文）
    {
        "sample_id": "b2e-008",
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "Gaggia Classic 大概多久除一次垢？除垢能用醋吗？"},
            {"role": "assistant", "content": (
                "直接回答：除垢周期没有统一数字——不同代际、不同版本的 Gaggia Classic 手册给出的"
                "建议可能不同，**以你机器对应版本的手册为准**，不要把某个版本写的周期当成所有 "
                "Gaggia Classic 的统一规定。\n\n"
                "依据：【F】现有来源记录了不同手册版本对除垢周期的说法存在差异（冲突条目：除垢"
                "间隔各版本说法不一）】——这正是「查你手里那本手册」的原因：来源之间本身就不一致，"
                "存在冲突，任何单一数字都不该被当成全系列通用的规定。\n\n"
                "用水方面：【F】手册明确不能使用醋作为除垢清洁剂，清洁剂要按手册指定的类型使用】"
                "——醋对机器部件有风险，不要用「家里的土办法」替代手册指定的除垢剂。\n\n"
                "经验上：除垢的紧迫程度和用水硬度直接相关——水质偏硬的地区水垢积累更快，可能"
                "需要更靠近手册建议的上限频率；用过滤水的用户间隔可以适当放长。这是常见做法层面"
                "的调整，具体频率仍以你的手册为框架【P：按水质观察调整，不替代手册周期】。\n\n"
                "条件限制：本回答针对 Gaggia Classic 系列，不推广到其他品牌或机型；如果机器在"
                "保修期内，除垢操作与耗材以保修条款优先。\n\n"
                "还需要知道：你机器的具体型号版本（以及是否在保修期内）决定了要按哪一版手册的"
                "周期执行；你所在地的水质硬度决定了实际频率向手册建议区间的哪一端靠——这两项"
                "信息能帮你把「大概多久」落成适合你机器的具体安排。\n\n"
                "建议的下一步：确认你机器的具体型号版本与所在地水质，按对应手册的周期设置提醒；"
                "除垢的程序步骤和清洁剂剂量，也按同一本手册执行。"
            )},
        ],
        "topic": "cleaning-maintenance",
        "claim_ids": ["conflict.gaggia.classic-descale-interval",
                      "claim.water.gaggia-vinegar-ban"],
        "source_ids": ["gaggia-classic-manual"],
        "reasoning_level": "F(不同手册版本的除垢周期说法不一——冲突条目；手册禁止用醋、清洁剂按"
                           "指定类型) + P(按水质硬度观察调整频率——不替代手册框架) + "
                           "I(单台机器的适用周期——以对应版本手册为准，不推广机型)",
        "license_status": "own-original",
        "source_usage": {"gaggia-classic-manual": "fact-extraction-rewrite"},
        "risk_notes": "① GPT v2 裁定：完整保留冲突边界——不同代际手册周期不同、以用户机器对应"
                      "手册为准、不泛化为统一规定；醋按手册指定清洁剂作答；② cleaning-maintenance "
                      "为现有 35 条未覆盖的新 topic（gaggia 授权内）；③ 不推广其他机型。",
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
