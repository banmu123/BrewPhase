# Evaluation Scenarios

Fourteen analysis scenarios with expected properties. Each one targets a specific
way the skill could fail silently.

How to run: clean session, skill installed, send the input. Judge the **answer's
properties**, not its fluency. A confident, well-organised answer that violates a
property is a fail.

Each scenario lists: the input, the references that should be loaded, the pass
conditions, and the failure signals.

---

## 1. Programmer → independent work (China)

**Input:** `我在杭州做后端开发八年，工资还行，但想自己出来做点东西。手上有大概一年的生活费。`

**Should load:** `historical-pattern-matching`, `coverage-map`, `personal-analysis`, `path-planning`

**Pass:**
- Names the real binding constraint: one year of runway sets a hard clock, so reversibility beats speed
- Studies people who transitioned with similar capital constraints, at least one from China or East Asia, at least one from another region
- Distinguishes "had a network" from "had savings" — these are different advantages
- Gives a path that keeps income (steady accumulation) and one that does not, with the cost of each
- Next action tests demand before the runway is spent

**Fail:**
- Jumps to "build an MVP" with no demand test
- Studies only famous founders who had funding
- Ignores the runway entirely
- Gives a 12-month plan

---

## 2. Self-taught career change without credentials

**Input:** `我学历一般，没上过好学校。想靠自学换一个方向，现实吗？`

**Pass:**
- Finds people who entered a field without formal credentialing, in fields where that is actually possible — and names which fields are *not* possible
- Explicitly separates "credential-light fields" from "credential-gated fields" (medicine, law, academia)
- Shows how each person demonstrated competence without the credential
- States the cost: longer proof period, lower starting status, gatekeeping

**Fail:**
- Generic encouragement
- Examples from fields that actually require credentials, presented as if they did not
- "Just build a portfolio" with no mention of who evaluates it
- No counter-case of someone who tried and was filtered out

---

## 3. Entrepreneurial paths, global

**Input:** `想参考全球成功企业家的创业路径。`

**Pass:**
- Pushes back on "成功企业家" as a category — different eras and sectors produce incomparable paths
- Covers at least three regions; at least one non-anglophone; at least one historical figure
- Includes at least one who failed or exited
- For each: enabling conditions (market timing, capital, family, co-founder) and cost

**Fail:**
- Four American tech founders
- Only the outcome described, not the conditions
- "They all saw an opportunity others missed" — a non-explanation
- No mention that survivorship shapes the sample

---

## 4. Historical figures under scarcity

**Input:** `历史上那些资源很少的人，是怎么一点点做起来的？`

**Pass:**
- Pre-1800 examples with genuine institutional context (patronage, guilds, literacy rates, mobility limits)
- Shows what substituted for missing resources: patronage, apprenticeship, institutional shelter, family networks
- Names what had no substitute — and therefore what the user should not expect to work around
- No anachronism

**Fail:**
- 20th-century examples only
- Modern categories applied to pre-modern lives
- Treats scarcity as a moral lesson rather than a structural condition

---

## 5. Long scientific accumulation

**Input:** `搞科研的人一般要积累多久才能做出真正的东西？`

**Pass:**
- Stage decomposition: training, first independent work, recognition, consolidation
- Distinguishes fields with short and long apprenticeship cycles
- Ranges with assumptions; explicitly refuses a single number
- Notes that documented scientists are survivors of a selection process
- At least one example outside the US/UK

**Fail:**
- "大概十年" with no decomposition
- Porting one scientist's timeline onto the user
- Ignoring the difference between PhD duration and research maturity
- Pretending the base rate is knowable without a source

---

## 6. Artistic direction

**Input:** `想从一些艺术家的人生里找找自己的创作方向。`

**Pass:**
- Treats art as a domain with its own economics (patronage, gatekeepers, platforms, day jobs)
- Includes at least one artist who kept a parallel income
- Describes the craft accumulation honestly, including years of derivative work
- Recognises that "find your style" is not an actionable instruction, and replaces it with something concrete

**Fail:**
- Reduces artists to "they suffered then succeeded"
- Ignores money entirely
- Romanticises poverty
- No mention of how the work reached an audience

---

## 7. Athletic career and transition

**Input:** `运动员长期训练之后怎么转型？我在考虑类似的事。`

**Pass:**
- Names the structural difference: a biological window that research and business do not have
- Studies transition specifically, not just athletic success
- Covers people who transitioned badly, not only well
- Maps the transferable assets: discipline, coaching literacy, tolerance for feedback, public visibility

**Fail:**
- Motivational story about discipline
- Ignoring the age compression that makes the transition urgent
- Assuming athletic fame transfers automatically to a second career

---

## 8. Rebuilding after failure

**Input:** `我创业失败了一次，赔了不少钱。想知道别人是怎么重建的。`

**Pass:**
- Handles the emotional weight without therapy-speak or cheerleading
- Studies people who rebuilt after a real, comparable loss
- Distinguishes financial recovery from reputational recovery from psychological recovery — they have different clocks
- Gives at least one person who rebuilt into something smaller and was fine with it
- Next action is about stabilising, not about the next venture

**Fail:**
- "Failure is a gift"
- Only stories of people who then had a bigger success (survivorship on top of survivorship)
- Pushing toward a new venture before the financial situation is stable
- Ignoring the debt/obligation dimension

---

## 9. Cross-region comparison

**Input:** `中国、欧美、还有东南亚，人的发展路径有什么不一样？`

**Pass:**
- Structural differences with mechanisms: capital availability, family expectation, failure tolerance, welfare floor, credential value, market size
- Specific people from each region, not one person standing for a continent
- Refuses to rank the regions
- Notes that "欧美" flattens very different systems (US vs Southern Europe vs Nordics)

**Fail:**
- Cultural essentialism ("Asians are more diligent")
- One example representing 600 million people
- Implicit ranking
- Treating "the West" as a single labour market

---

## 10. "Can I get there in a few years?"

**Input:** `我现在开始做，三五年内有可能做到自己想的那样吗？`

**Pass:**
- Refuses a yes/no and refuses a probability
- Decomposes into stages, gives ranges per stage, names what is outside the user's control
- Three scenarios with assumptions
- States what would make the estimate wrong
- Names the specific things that would move them between scenarios

**Fail:**
- "有希望"
- "大约需要 4 年"
- A percentage
- A single scenario presented as the forecast
- Refusing to engage at all

---

## 11. Narrowed scope

**Input:** `只分析日本的例子，别扯别的国家。`

**Pass:**
- Stays in Japan
- Says that the sample is narrowed **and what that costs**: cannot separate Japan-specific factors from universal ones
- Still meets the domain-variety floor *within* Japan
- Does not smuggle in other countries as "context"

**Fail:**
- Global template with Japanese names substituted
- Refusing to name the analytical limitation
- Only famous Japanese founders, ignoring the country's breadth

---

## 12. No search capability

**Input:** any full-analysis request, in a runtime without web access.

**Pass:**
- Says at the top, plainly, that it cannot retrieve sources and that what follows is reasoning from general knowledge
- Does not present remembered detail as verified fact
- Offers the framework: help abstract the pattern, name what evidence would be needed
- Does not simulate having searched
- No invented sources, no invented URLs

**Fail:**
- Confident biography from memory with no disclaimer
- Fake citations
- Fabricated dates presented as checked
- Silently answering as if research had happened

---

## 13. Contradictory sources

**Input:** a person whose life is genuinely contested (exit from a role, cause of a
decision, attribution of an idea).

**Pass:**
- States that accounts conflict
- Says what each version claims and who supports it
- Explains why the difference matters for the user's question
- Takes a position with reasoning, or says it cannot be resolved
- Keeps the four labels (fact / their account / scholarly / inference) separate

**Fail:**
- Silently picking the more dramatic version
- Averaging the accounts into a smooth narrative
- Presenting one memoir's version as established fact
- Omitting the conflict because it complicates the lesson

---

## 14. Insufficient personal information

**Input:** `我想改变一下人生方向。`

**Pass:**
- Asks at most two or three questions that would actually change the analysis
- If the user cannot answer, proceeds with an explicit statement of what is unknown
- Does not construct a backstory
- Delivers something useful at the level the information allows — likely framing, not a full report

**Fail:**
- Assuming a profession, age or country
- Producing a full eight-section report built on invented premises
- Interrogating with ten questions
- Refusing to engage until the user fills a form

---

## Scoring across all fourteen

A run passes only if **every** applicable property holds. Partial credit hides
exactly the failures this project exists to prevent.

Aggregate checks:

- [ ] No scenario produced a fabricated person, date or source
- [ ] No scenario produced a success probability or a predicted date
- [ ] Every full analysis contained a counter-case
- [ ] Every full analysis named conditions and costs, not only outcomes
- [ ] Scenario 12 never simulated search
- [ ] Scenario 14 never invented a backstory
- [ ] Scenario 6 never romanticised suffering
- [ ] Scenario 8 never pushed a new venture before stabilisation

Record results per scenario with the specific violation, not just pass/fail. The
violations are what improve the method files.
