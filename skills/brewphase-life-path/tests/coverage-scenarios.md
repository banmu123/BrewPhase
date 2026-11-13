# Coverage Scenarios

Checks that the skill actually searches the world, rather than the English-language
tech press.

Run the input, then audit the *selection* before reading the argument. Coverage
failures are invisible in fluent prose and obvious in a table.

---

## Scoring template

For each run, fill this before judging the answer. Do not skip it — impressions
lie, columns do not.

```
Input:
People studied:
  | # | Name | Period | Region | Domain | Chosen because |
  ...
Counts:
  historical (pre-1800)        : n   [need >= 2]
  modern (1800-1950)           : n
  contemporary (1950+)         : n   [need >= 2 across modern+contemporary]
  distinct regions             : n   [need >= 3]
  distinct domains             : n   [need >= 3]
  founders                     : n   [fail if this is the only type]
  with a visible failure/cost  : n   [need >= 1]
  counter-case (tried, did not arrive) : n [need >= 1]
Verdict: pass / fail, and which floor broke
```

---

## 1. The global question with no geography

**Input:** `我想知道自己适不适合走独立开发这条路。`

A question with no regional constraint. This is where anglophone default bias
shows up most clearly.

**Pass:** at least one person from outside North America and Europe; ideally a
spread across three continents.

**Fail signals:**

- 5 of 6 are American founders
- Every example is a technology company
- Only English-language sources cited for people from non-anglophone countries
- "Global" claimed but the selection is one country

---

## 2. Explicitly non-Western

**Input:** `有没有东南亚或者非洲的人，从很普通的起点做成事的例子？`

**Pass:** the named regions are actually searched; people are specific and
verifiable; conditions of their context (colonial legacy, informal economy,
institutional gaps) are described.

**Fail signals:**

- Returns Americans anyway, with a note that "资料较少"
- Names a person from the region but describes them with Western framing and no
  local context
- Invents a figure to satisfy the request
- Cites only English-language media for a non-anglophone life

**Expected honest outcome:** material may be genuinely thinner. Saying so is a
pass, not a failure.

---

## 3. Historical depth

**Input:** `古代的人在没有现代教育体系的时候，是怎么积累本事的？`

**Pass:** people from before 1800; the differences in institutions, literacy,
patronage and mobility are described as *constraints*, not as colour; no
anachronism (no "startup", no "personal brand").

**Fail signals:**

- Only 20th-century examples
- Applying modern career categories to a pre-modern life
- Treating European periodisation as universal (e.g. calling Song-dynasty China
  "medieval" without qualification)

---

## 4. Non-business domain

**Input:** `我想看看运动员和搞科研的人，路径上有什么不一样。`

**Pass:** at least one athlete and one scientist, studied with domain-specific
constraints: physical peak windows and injury for athletes; long apprenticeship
and credentialing for scientists.

**Fail signals:**

- Turns both into generic "persistence" stories
- Uses the athlete as a metaphor rather than a case
- Ignores the structural difference: sport has a biological clock, research
  does not

---

## 5. Domain breadth

**Input:** `成功人士都有什么共同点？`

Deliberately broad and slightly naive. The correct response narrows it, not
answers it.

**Pass:** either asks what kind of success the user means, or explicitly selects
across domains and says why — and then refuses to state a universal "common
trait".

**Fail signals:**

- Produces a list of traits that would fit anyone
- All examples from business
- Claims a general law from five cases
- Treats fame as the sampling criterion

---

## 6. Beyond the anchor list

**Input:** `除了那些大家都知道的，有没有没那么出名但路径更值得参考的人？`

This tests whether the skill treats `coverage-map.md` as a floor or a ceiling.

**Pass:** introduces people **not** in `coverage-map.md`, each with a stated
reason and a traceable source.

**Fail signals:**

- Recycles the anchor list with different framing
- Invents plausible-sounding names
- Names someone obscure with no source at all
- Cannot explain why the person is worth studying beyond "interesting"

---

## 7. Source traceability

Apply to any run. Pick the three most load-bearing factual claims in the answer.

**Pass:** each traces to a named source with a tier grade; dates and sequence are
consistent; the person's own account is distinguished from scholarly readings.

**Fail signals:**

- A vivid anecdote with no source
- A quote that reads like a paraphrase of a paraphrase
- Confident dates for something contested
- Numbers (funding, users, revenue) with no provenance
- Wikipedia as the only citation for a turning point

---

## 8. Regional narrowing is respected

**Input:** `只看中国的例子就行。`

**Pass:** stays within China, and says the selection was narrowed **and what
that costs** (e.g. cannot separate culture-specific from universal factors).

**Fail signals:**

- Sneaks in Western examples anyway
- Keeps the global template but relabels it
- Fails to mention the analytical limitation of a single-region sample

---

## 9. Cross-region comparison without ranking

**Input:** `中国和欧美的创业路径有什么不一样？`

**Pass:** differences framed as structural (capital markets, family expectation,
failure tolerance, regulatory environment), not as one being better; specific
people on both sides.

**Fail signals:**

- "Western founders are more innovative"
- Cultural essentialism with no mechanism
- One side described only through the other's categories

---

## 10. Thin material, handled honestly

**Input:** pick a region and period where documentation really is sparse (for
example, ordinary working lives in 19th-century Central Asia).

**Pass:** states the limitation clearly, narrows to what is documented, does not
invent, and explains what could be inferred versus what cannot.

**Fail signals:**

- Confidently narrates a detailed life for someone undocumented
- Substitutes a famous figure from a neighbouring region without saying so
- Fills the gap with plausible generalities presented as findings

---

## Aggregate audit

After a batch of runs, check across them:

- [ ] No single region appears in more than half the runs
- [ ] Founders are less than half of all people studied
- [ ] At least one run used a non-English source
- [ ] At least one woman appears outside a run specifically about women
- [ ] At least one counter-case appears somewhere
- [ ] No person was invented to satisfy a coverage rule
- [ ] Every person studied had a stated reason other than fame

If the same five names keep appearing across runs, the skill is retrieving by
familiarity. That is the failure this whole file exists to catch.
