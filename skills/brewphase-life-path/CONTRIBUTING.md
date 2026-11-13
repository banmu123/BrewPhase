# Contributing

This project is a method, not a content dump. Corrections and sharpening are more
valuable than additions.

## The one rule that is not negotiable

**Never add a person, an event, a date or a source from memory.**

Every factual claim added to this repository must carry a traceable citation:
a book with page reference, a paper with DOI, an archive with a call number, or
a dated article with a named author and outlet. If you cannot cite it, it does
not go in.

This rule exists because the failure mode of this domain is confident
fabrication. One invented detail discredits the whole method.

## What is welcome

### 1. Coverage anchors

New people worth studying in
[`references/coverage-map.md`](references/coverage-map.md).

Requirements for adding one:

- A named region from the ten-region list, and a domain from the seven-domain list
- **One sentence on why this person is worth studying** — what specific
  constraint or decision their life makes visible. "Famous and successful" is
  not a reason.
- At least one citation supporting the characterisation, so a reader can verify
  that the suggested angle is real
- Preference for under-represented regions, domains and genders

Anchors are starting points, not endorsements. Do not add someone because they
are frequently cited elsewhere.

### 2. Method corrections

Edits to `historical-pattern-matching.md`, `source-evaluation.md`,
`personal-analysis.md`, `path-planning.md`, `forecast-guidelines.md` or
`response-template.md`.

Good corrections tend to look like:

- "This step assumes X, which is false when Y" — a boundary condition
- "This rule produces Z in practice" — an unintended consequence
- A clearer test for a vague instruction

State the failure the change prevents. Method changes without a named failure
are hard to evaluate.

### 3. Adapters

Platform-specific installation notes in `adapters/`. **Only document what you
have actually verified**, with the version you verified it against. If a CLI does
not install into a platform, say so — an unverified claim here wastes other
people's time more than a missing file would.

### 4. Test scenarios

Additions to `tests/` are welcome, especially:

- cases where the skill should *not* trigger
- cases with sparse or contradictory sources
- non-anglophone and non-tech domains

## What is not welcome

- Motivational content, quotes, "life lessons" collections
- Personality-typing or similarity scoring in any form
- Success-probability estimates or predicted dates for life outcomes
- Copyrighted material reproduced at length; paraphrase and cite instead
- People added without a stated research angle and a citation
- Claims about living people that are contested, without marking the dispute

## Style

- Prose over bullets when the content is judgement; bullets for lists of facts.
- Second person, direct. No hype.
- Tables only for genuine comparison.
- English in `README.md` and the skill files; Chinese in `README.zh-CN.md`.
  Bilingual additions to references are acceptable where the Chinese term is
  itself the subject (e.g. 司马迁, 屠呦呦).
- Keep `SKILL.md` short. Detail belongs in `references/`.

## Pull request checklist

- [ ] Every new factual claim has a traceable citation
- [ ] No invented person, event, date or URL
- [ ] New coverage anchors state a research angle, not just a name
- [ ] Any platform claim in `adapters/` was actually tested, and says against what version
- [ ] `SKILL.md` still reads as a decision procedure, not an essay
- [ ] No motivational framing introduced
- [ ] Changes to method files name the failure they prevent

## A note on tone

The people in this skill's scope lived complicated lives, and many are alive
today. Write about them with the same care you would want applied to your own
life: accurate about what they did, explicit about what is uncertain, and
unwilling to flatten them into a lesson.
