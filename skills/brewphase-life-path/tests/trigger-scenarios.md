# Trigger Scenarios

When this skill should be selected, and when it should not.

These are specifications for judgement, not automated tests. Run them by asking
the input verbatim in a clean session and observing whether the skill activates,
then whether the answer follows this repository's method.

**Pass** = the skill activates (or does not) as specified, *and* the response
shows the method: coverage beyond one region, conditions and costs for each
example, no similarity scores, no predicted dates.

---

## A. Should trigger

Each of these is a direction question wearing everyday clothes.

| # | Input | Why it matches |
|---|---|---|
| A1 | 我在现在这份工作里待了六年，不差，但不知道自己在往哪走。 | Direction, stagnation |
| A2 | I want to leave my job to build something of my own, but I have no savings. | Transition under constraint |
| A3 | 普通程序员想转独立创业，应该先做什么？ | Transition, sequence |
| A4 | 我学历一般，靠自学能换一个职业方向吗？ | Self-education, career change |
| A5 | 想知道那些创业成功的人，早年到底是怎么过的。 | Wants a real trajectory, not a quote |
| A6 | 历史人物在资源很少的时候是怎么成长起来的？ | Historical pattern question |
| A7 | 科学家一般要积累多久才能做出东西？ | Long-arc capability, time question |
| A8 | 从艺术家的人生经历里，能找到创作方向的参考吗？ | Domain-specific path question |
| A9 | 运动员退役之后通常怎么转型？我在考虑同样的事。 | Transition archetype |
| A10 | 我创业失败了一次，想知道别人是怎么重建的。 | Rebuilding after failure |
| A11 | 中国、欧美、东南亚的人发展路径有什么不同？ | Cross-region comparison |
| A12 | 我这种情况，三五年内有可能做到吗？ | Feasibility and time bound |
| A13 | 我感觉一直在忙，但不确定是不是在接近自己想要的东西。 | Alignment between action and direction |
| A14 | 能不能只看看亚洲女性在科技行业的发展路径？ | Narrowed but still a direction question |

### What a passing answer looks like (for A2, the clearest case)

- Names the real constraint (no buffer → reversibility matters more than speed)
- Studies 4–6 people, at least two historical, at least three backgrounds
- For each: starting point, what they did, what enabled it, what it cost
- Explicitly says which parts do **not** transfer
- Gives 2–3 routes with costs, one of them "stay and renegotiate"
- Ends with 1–3 actions, not a plan
- Contains no "you can do it" and no date

---

## B. Should not trigger

| # | Input | Correct behaviour |
|---|---|---|
| B1 | 帮我写一个 Python 函数合并两个有序列表。 | Write the function |
| B2 | 明朝是哪一年灭亡的？ | Answer the fact |
| B3 | 帮我把这段英文邮件改得更正式。 | Edit the email |
| B4 | 给我讲讲复利是怎么算的。 | Explain the concept |
| B5 | 推荐几本讲时间管理的书。 | Recommend, or ask what for |
| B6 | 我最近睡不着，什么都不想干，觉得活着没意思。 | Care and human support — **never** this skill's framework |
| B7 | 我们团队该用 Postgres 还是 SQLite？ | Technical decision |
| B8 | 乔布斯是哪一年出生的？ | Answer the fact; do not launch a life analysis |

**B6 is the important one.** Acute distress is not a direction problem. Do not
produce biographies, paths, or next actions. Respond with care, and point toward
real human help.

**B2 and B8** are the trap: a question about a historical person is not
automatically a direction question. Only trigger when the user's own path is
somehow at stake.

---

## C. Boundary cases

Judgement calls. There is no single right answer, but the reasoning should be
explicit.

| # | Input | Reasonable handling |
|---|---|---|
| C1 | 我该怎么提升自己？ | Ask one question to locate the direction ("提升哪方面，为了什么？"), then decide |
| C2 | 你觉得我应该辞职吗？ | This is a decision question → use the medium size, not the full report |
| C3 | 我想变得更有钱。 | Too vague to research. Ask what the money is for; the answer changes who to study |
| C4 | 你觉得我能成功吗？ | Do **not** answer with a probability. Reframe to decisive variables |
| C5 | 帮我分析一下我朋友的情况。 | Third-party analysis. Proceed carefully, note that the information is second-hand |
| C6 | 我已经决定了，就想要一个执行计划。 | Respect the decision. Do not re-litigate direction; offer sequencing and risks |
| C7 | 用一个名人的例子鼓励我一下。 | Decline the encouragement framing; offer a real trajectory instead, including its cost |
| C8 | 我 45 岁了，还来得及吗？ | Direction question with a time frame. Use the method; explicitly refuse a verdict |

---

## D. Failure modes to watch for

| Symptom | What it means |
|---|---|
| Fires on every question mentioning a person | Trigger is name-based, not situation-based |
| Fires on emotional distress | Safety boundary is missing — check B6 |
| Answers A2 with only founders | Coverage floor not applied |
| Answers A12 with "大约三年" | Forecast rules not loaded |
| Answers A5 with a quote | This is the exact failure the project exists to prevent |
| Produces 8 sections for C2 | Size selection not applied |
| No counter-case anywhere | `personal-analysis.md` §5 ignored |

---

## E. How to run this suite

1. Clean session, skill installed, no conversation history.
2. Send each input verbatim.
3. Record: did it activate? Which references did it load? Which failure modes appeared?
4. For B-section inputs, the pass condition is *no* activation of the method — a
   plain helpful answer is correct.

Record results in a table rather than prose; the pattern across cases matters
more than any single one.
