#!/usr/bin/env python3
"""build_batch2c_draft.py — 阶段六点九-F 第二步：Batch2c 草稿（b2c-001~003）。

依据：batch2c_candidate_plan.md + GPT draft 硬约束（回复存档 gpt_replies/ 下
六点九-F 核验）：
  b2c-001 首句冻结「仅凭『不好喝』…还无法判断具体原因」；claim 不外推
  b2c-002 禁「专业设备」「家庭达不到」式无依据断言；来源边界：豆子/冲法→UC Davis、
          设备→Baratza、新鲜度→NCA
  b2c-003 F 层禁写「贵的豆子通常品质更高」；「价格不是唯一标准」为通用推理框架
          不伪装成咖啡事实；明确声明知识库无价格-品质结论
  通用规则：规则1 禁止替用户扩大问题；规则2 信息收集但不机械复制；规则3 必须有下一步动作
纪律：不批准、不落库、只到 quality gate；不扩展 b2c-004/005。
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent / "batch2c_candidates_draft.jsonl"
SYSTEM = "你是咖啡领域助手。回答需区分事实与推断，资料不足时明确说明，不编造来源。"

rows = [
    {
        "sample_id": "b2c-001",
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "我自己冲的咖啡不好喝，怎么办？"},
            {"role": "assistant", "content": (
                "仅凭「不好喝」这个描述，还无法判断具体原因——「不好喝」可以是很多完全不同的问题：酸、苦、淡、涩、风味不平整，它们的方向和调整路径并不相同，所以第一步不是动手调，而是先把问题定位出来。【F】研究界用 TDS（溶解物总量）与萃取率（extraction yield）来划分风味轮廓，冲煮落点不同、风味表现不同】；【F】同一批咖啡豆，改变研磨与萃取方式，会落在风味控制图的不同角落、味道明显不同】——这两条说明「好不好喝」是多个可变量共同作用的结果，需要信息才能定位，而不是靠猜。还需要知道几件事：你用的器具（手冲/意式/法压等，判断逻辑完全不同）；豆子（烘焙度、烘焙日期——豆况本身就会主导味道）；当前参数（粉水比、水温、时间，如果有的话）；以及最关键的一项——具体是哪里不好喝（偏酸？偏苦？寡淡？口感粗糙？）。每项信息能排除的方向不同：器具决定用哪套判断逻辑，症状方向决定先查萃取还是先查豆况。条件限制：如果你暂时说不清「哪里不好喝」，可以对比着描述——比如「比上次酸」「比店里苦」，相对描述也有定位价值；但请先不要按网上的通用建议盲调参数，同一个调整对不同问题的方向相反【I：推断——具体哪个变量主导，需要结合你的信息才能判断】。建议的下一步：先回答「具体哪里不好喝」这一项（这是缩小范围最快的一步），再补器具与豆子信息——有了这三项，就能进入有依据的诊断，而不是来回试错。"
            )},
        ],
        "topic": "pour-over diagnosis",
        "claim_ids": ["claim.sensory.brewing-chart-profiles", "claim.sensory.same-bean-different-brew"],
        "source_ids": ["ucdavis-coffee-center"],
        "reasoning_level": "F(风味轮廓由 TDS 与萃取率划分；同豆不同萃味道明显不同——仅作多维定位框架，不外推) + P(澄清式诊断流程：先症状方向后器具信息) + I(主导变量需结合用户信息判断——已标注推断)",
        "license_status": "own-original",
        "source_usage": {"ucdavis-coffee-center": "fact-extraction-rewrite"},
        "risk_notes": "① GPT 冻结首句已采用：「仅凭『不好喝』这个描述，还无法判断具体原因」；② claim 不外推：未出现「萃取率决定所有风味」「TDS 可以诊断所有问题」式表述，F 层仅作多维定位框架；③ 禁止替用户扩大问题（GPT 通用规则 1）：未预设用户的器具与症状，酸/苦/淡/涩仅作分流选项不展开诊断；④ 与 b2b-001 差异化：b2b-001 用户已给出症状方向（酸），本条连症状方向都缺失，训练「从零建立诊断路径」；⑤ 信息收集不机械复制（规则 2）：按「缩小范围速度」排序信息项并说明理由。",
        "interaction_skill": "clarification",
        "missing_information_handling": "五维最小信息集（症状方向/器具/豆子/参数/相对描述），按缩小范围速度排序并说明每项作用。",
        "training_value": "★★★★★（GPT 定级：BrewPhase 最核心入口）",
    },
    {
        "sample_id": "b2c-002",
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "为什么我家冲不出咖啡店的味道？"},
            {"role": "assistant", "content": (
                "咖啡店的体验来自多个条件的组合，不能直接归到「你家设备不行」或「技术不如人」某一个原因上——正确做法是把差异拆开逐项排查，先确认哪种差异在主导。逐类看证据：【F】豆子与冲法维度：同一批咖啡豆，改变研磨与萃取方式，会落在风味控制图的不同角落、味道明显不同】——你与咖啡店用的豆子大概率不同，即便豆子相同，冲法不同味道也会整体移动，这是有研究支撑的第一差异源。【F】设备维度（研磨）：Baratza 官方明确说明手册里不含针对具体冲煮方式的研磨刻度，因为正确数值取决于你的豆子与器具】——即研磨设置不能跨设备直接照搬。【P：在实际体验中，设备差异可能通过研磨一致性、操作方式等路径影响结果，这是基于已有知识的推断，需要结合具体设备验证；它与「谁技术好」无关，是条件差异】。【F】新鲜度维度：NCA 指出咖啡在烘焙后几乎立即开始失去新鲜度，建议小批量频繁购买】——咖啡店通常有稳定的豆子周转，家用豆子开封后的新鲜度衰减是常被忽略的差异项。此外还有水质与操作手法两个维度，本知识库暂时没有对应结论，只作为排查清单项列出、不展开【I：这两个维度的影响方向，需要进一步确认】。还需要知道：你的豆子（购买渠道、烘焙日期）、磨豆机与器具型号、当前的粉水比与水温——按上面的类别归组提供即可。条件限制：这些维度不需要全部对齐——通常一两项就在主导差异，但具体是哪一项，需要逐项确认后才敢下结论【I：推断——主导因素因人因豆而异】。建议的下一步：先从豆子信息开始确认（购买渠道与烘焙日期最容易核实），再对照磨豆机与器具——如果豆子新鲜度差距明显，先换新鲜豆对比一次，比先动参数更能说明问题。"
            )},
        ],
        "topic": "pour-over diagnosis",
        "claim_ids": ["claim.sensory.same-bean-different-brew", "claim.grinding.manual-not-recipe", "claim.freshness.nca-lose-freshness-immediately"],
        "source_ids": ["ucdavis-coffee-center", "baratza-documents", "nca-aboutcoffee"],
        "reasoning_level": "F(同豆不同萃；Baratza 研磨刻度取决于豆子与器具、不跨设备照搬；NCA 烘焙后几乎立即失去新鲜度——三维度各归其来源) + P(设备差异通过研磨一致性/操作方式等路径影响结果——基于已有知识的推断需具体设备验证，GPT 裁定 F/P 拆分；逐类排查的差异拆解法) + I(水质/手法维度与主导因素判断——已标注需进一步确认)",
        "license_status": "own-original",
        "source_usage": {"ucdavis-coffee-center": "fact-extraction-rewrite", "baratza-documents": "fact-extraction-rewrite", "nca-aboutcoffee": "fact-extraction-rewrite"},
        "risk_notes": "① GPT 禁止项规避：无「咖啡店好喝是因为专业设备」、无「家庭设备无法达到咖啡店水平」——定位为多条件组合+逐项排查；② 来源边界严格：豆子/冲法→UC Davis、设备→Baratza（F 层限定在研磨设备，不扩展到完整咖啡店体验——GPT 六点九-H 裁定）、新鲜度→NCA；③ 设备「结构性差异」表述已按 GPT 裁定从 F 拆到 P 层（「设备差异可能通过研磨一致性、操作方式等路径影响结果——基于已有知识的推断，需要结合具体设备验证」）；④ 水质/手法无 claim 仅列清单项并标 I 层（b2b-004 同边界）；⑤ 三来源 topic 交集 {'pour-over diagnosis'} 已预检非空（六点九-E 扩展成果），admission 需再次验证；⑥ 期望管理不劝退：结尾动作是「换新鲜豆对比」而非否定家庭冲煮。",
        "interaction_skill": "multi_variable_reasoning",
        "missing_information_handling": "按差异类别归组收集：豆子（渠道/烘焙日期）、磨豆机与器具型号、粉水比与水温；给出「先豆子后设备」的确认顺序。",
        "training_value": "★★★★★（GPT 定级：训练价值最高，对应产品愿景，审核等级提高）",
    },
    {
        "sample_id": "b2c-003",
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "贵的咖啡豆一定更好吗？"},
            {"role": "assistant", "content": (
                "价格和体验之间不存在一个简单判断规则——「价格不是唯一判断标准」，但这句话是通用的选择逻辑，不是咖啡领域的定价结论：先说清边界，本知识库没有关于价格与品质关系的结论，所以我不编造「贵豆为什么贵」的机理解释，也不给「贵=好」或「贵=智商税」任何一端的断言。可以给的是有依据的一般性框架：【F】风味轮廓由 TDS（溶解物总量）与萃取率（extraction yield）划分，相关研究包含消费者偏好测试】——「好不好喝」的研究本身就建立在「偏好因人而异」之上，同一支豆子在不同人嘴里结论可以相反。【F】同一批豆子，改变研磨与萃取方式，味道会明显不同】——把这两条放在一起看：你最终喝到的体验，是「豆子本身」与「你把它冲成什么样」共同决定的，冲煮环节带来的差异完全可能与豆子之间的差价同等重要【I：推断——具体幅度因豆而异，需要进一步确认】。影响体验的实际变量还包括处理法、产区风格与烘焙走向——它们同时影响定价与风味，但关系不是单向的，具体到某一款豆子，本知识库无法判断【I：推断——定价维度需要更多信息，这里不作展开】。还需要知道：你自己的风味偏好（偏酸还是偏苦、喜欢醇厚还是清淡）和常用的冲煮方式——「适不适合」比「贵不贵」更接近你这个问题的有效版本。条件限制：价格可以是品质的参考信号之一，但把它当唯一标尺，容易花更多钱买到不适合自己口味的豆子——这与「便宜没好货」一样都是过度概括【I：两种概括都不成立，需要进一步确认具体豆子】。建议的下一步：先确认自己的风味偏好方向，再按偏好找描述匹配的豆子，用小包装对比试错——同一支豆子把冲煮调到位，常常比换更贵的豆子对杯中体验的改变更大【I：推断——建议从可核实的信息开始，先冲好手里这支】。"
            )},
        ],
        "topic": "pour-over diagnosis",
        "claim_ids": ["claim.sensory.brewing-chart-profiles", "claim.sensory.same-bean-different-brew"],
        "source_ids": ["ucdavis-coffee-center"],
        "reasoning_level": "F(风味轮廓由 TDS 与萃取率划分、研究含消费者偏好测试；同豆不同萃——仅作一般性框架) + P(按偏好选豆的经验做法) + I(价格与品质关系、定价机理——明确标注知识库无结论、不编造；具体判断因豆而异)",
        "license_status": "own-original",
        "source_usage": {"ucdavis-coffee-center": "fact-extraction-rewrite"},
        "risk_notes": "① GPT 最高风险标记遵守：F 层未出现「贵的豆子通常品质更高」；「价格不是唯一判断标准」明确标注为通用选择逻辑、非咖啡领域定价结论（不伪装成咖啡事实）；② 幻觉防线：开篇声明「本知识库没有关于价格与品质关系的结论，不编造定价机理」——b2b-008 不知道能力的延续；③ 无反向绝对化：「贵=智商税」「便宜没好货」均被显式否定；④ 不推荐具体商品/品牌；⑤ 用户原话「一定更好吗」含「一定」——强断言扫描仅覆盖 assistant 文本，assistant 侧未用强断言词。",
        "interaction_skill": "uncertainty_handling",
        "missing_information_handling": "把「贵不贵」转化为「适不适合」：请用户提供风味偏好（酸/苦/醇厚/清淡）与冲煮方式，按匹配度而非价格选豆。",
        "training_value": "★★★★（GPT 定级：训练「没有知识怎么办」，比回答问题本身更重要）",
    },
]

if __name__ == "__main__":
    existed = OUT.is_file()
    OUT.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")
    print(f"{'覆盖' if existed else '创建'} {OUT}：{len(rows)} 条（b2c-001/002/003）")
