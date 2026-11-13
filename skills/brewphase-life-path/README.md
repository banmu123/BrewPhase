# brewphase-life-path

A cross-agent skill for thinking about life direction through the **verified life
paths of real people** — from ancient history to people still alive — instead of
through motivational quotes.

BrewPhase Life Path is not a collection of inspiring stories. It is a method:
abstract your situation into a searchable pattern, retrieve comparable lives
across regions and eras, verify what actually happened, separate what transfers
from what does not, and end with two or three routes and one thing to do next.

> 中文说明见 [README.zh-CN.md](README.zh-CN.md)

---

## Why this exists

Most "life advice" tooling fails in the same three ways:

1. **It draws from a narrow sample.** A handful of American founders, read as
   universal.
2. **It drops the conditions.** A success is described as effort plus belief,
   with the family money, the timing and the institution quietly removed.
3. **It predicts.** A date is attached to a life, and the person measures
   themselves against it.

This skill is built to avoid all three. Coverage is explicitly global; every
trajectory must include enabling conditions and costs; and time statements are
always ranges with stated assumptions, never dates or probabilities.

## What it does

- Reads your own confirmed direction and current work context from **BrewPhase
  Desktop** over MCP, if you have it running and authorized
- Searches widely for people whose *constraints* resemble yours — not whose
  fame resembles your ambition
- Verifies claims against primary and scholarly sources, and labels what is fact,
  what is the person's own account, and what is inference
- Produces two or three paths that fit your real situation, with costs and
  failure signals
- Ends with 1–3 next actions and an explicit list of what not to do now

## What it does not do

- No personality tests, no similarity percentages ("you are 80% like X")
- No life-outcome predictions, no success probabilities
- No bundled biography database — every case is retrieved and verified at use
- No changes to your BrewPhase data: it can only *propose* drafts, which you
  confirm in the app
- No motivational content, and no anxiety manufactured from other people's
  achievements

## Get started

### 1.1 Install the skill

```bash
npx skills add banmu123/BrewPhase
```

This works for agents that follow the `skills/<name>/SKILL.md` convention. It
does **not** reach every agent — for WorkBuddy, see 1.3.

### 1.2 Let your agent install it

Paste this into your agent:

> Set up brewphase-life-path for me: https://github.com/banmu123/BrewPhase
> Read `skills/brewphase-life-path/references/install.md` and follow the steps to install it.

That file is written for an agent: it finds the skills directory, decides between
symlink and copy, verifies every file landed, and walks through the optional MCP
step. This is the path least likely to go wrong, because the agent can inspect
your actual filesystem instead of guessing.

### 1.3 WorkBuddy

WorkBuddy reads skills from `~/.workbuddy/skills/` (or
`<workspace>/.workbuddy/skills/`). Two commands, then restart:

```bash
git clone https://github.com/banmu123/BrewPhase ~/BrewPhase
ln -s ~/BrewPhase/skills/brewphase-life-path ~/.workbuddy/skills/brewphase-life-path
```

Windows needs Developer Mode for `ln -s`; the PowerShell equivalent is in
[adapters/workbuddy](adapters/workbuddy/README.md), along with copying without
symlinks, verification, and **how to connect BrewPhase MCP** so the skill can
read your own direction and work context.

Then ask something that should match:

> 我在现在这份工作里待了六年，说不上差，但也不觉得自己在往哪里走。

If the answer studies several people from different regions and eras, with
conditions and costs for each, it is working. Generic encouragement means it was
not loaded — see the troubleshooting table in the adapter doc.

### 1.4 Other agents

| Agent | Where |
|---|---|
| Codex / `.agents` convention | link this directory into `.agents/skills/` in your repo — [adapters/codex](adapters/codex/README.md) |
| Claude Code / compatible | copy or symlink this directory into `~/.claude/skills/brewphase-life-path` |
| Anything else | ask the agent to read `references/install.md` |

Once installed, you should not need to invoke it by name. The `description` in
`SKILL.md` is written so that agents matching on user intent will select it when
the conversation is about direction, transition, feeling stuck, or learning from
someone else's life.

## Usage

Once installed, you do not invoke it by name. Ask about your situation in
ordinary language, and the skill is selected when the question is about
**direction** rather than about a task. You do not need to name a person, a
framework, or the skill.

### Prompts that work

| You want | Say something like |
|---|---|
| Orient a stuck situation | "I've been in the same job for six years. It's fine, but I don't know where I'm going." |
| Weigh a transition | "I want to leave and build something of my own, but I have one year of savings." |
| Learn from a specific kind of life | "How did people build a career before formal credentials existed?" |
| Test feasibility | "Is this realistic in three to five years?" |
| Rebuild after failure | "My first attempt failed and cost me a lot. How did others recover?" |
| Narrow the frame | "Only look at Japan — don't bring in other countries." |

### What you get

A full analysis has a fixed shape:

1. where you are now, and what the real question is
2. where you want to go, and what is still unclear about it
3. four to six people worth studying — each with background, what they actually
   did, what made it possible, what it cost, what transfers, what does not
4. two or three routes that fit your constraints, each with its cost and its
   early failure signal
5. time as ranges under three scenarios, plus what cannot be estimated
6. one to three next actions
7. what not to do now, and when to redo the analysis

**Length scales with the question.** "Should I take this job?" gets four short
sections; "I don't know what to do with my life" gets the full report. If you get
eight sections for a small decision, that is a bug — say so.

### Steering it

- *"Keep it short"* — drops to the medium or short form
- *"Only people from South Asia"* — narrows coverage, and states what that costs
  analytically
- *"Skip the famous founders"* — changes who gets selected, not just the framing
- *"Just the next steps"* — skips the research sections
- *"Write this down as my direction"* — needs BrewPhase MCP with
  `direction:propose`; it writes a **draft** that you confirm in the app

### Requirements and limits

- **Live search is required** for real research. Without it, the skill says so
  plainly and offers the framework instead — it will not pretend to have
  searched, and it will not cite sources from memory.
- **BrewPhase is optional.** Connected, the analysis can read your own confirmed
  current state, directions, stages and work context. Without it, it works from
  the conversation alone.
- **It will not decide for you.** It gives routes and trade-offs; the choice
  stays yours. It will also refuse to give a success probability or a date for a
  life outcome — that refusal is by design, not a limitation to work around.

## Optional: connect BrewPhase

The skill works without BrewPhase, using only what you say in conversation. If
you also run [BrewPhase Desktop](https://github.com/banmu123/BrewPhase), you can
authorize its local MCP bridge so the analysis can read your confirmed current
state, directions, stages and work context.

Requirements:

- BrewPhase Desktop running on the same machine
- MCP bridge enabled, with a client authorized for `direction:read` (and
  `work_context:read` for work context)
- Scopes are granted by you in the app; nothing is read without them

The MCP server is local. It is not a source about the wider world — world
biography always comes from the agent's own search. See
[references/brewphase-mcp.md](references/brewphase-mcp.md).

## Structure

```
brewphase-life-path/
├── SKILL.md                          # the only canonical entry point
└── references/
    ├── coverage-map.md               # global coverage matrix + starting anchors
    ├── historical-pattern-matching.md# the five-step research procedure
    ├── source-evaluation.md          # four-tier evidence grading
    ├── personal-analysis.md          # matching on transferable constraints
    ├── path-planning.md              # routes, sequencing, next actions
    ├── forecast-guidelines.md        # ranges, scenarios, what not to predict
    ├── brewphase-mcp.md              # reading the user's own context
    ├── response-template.md          # three output sizes
    └── install.md                    # for agents installing this skill (not runtime)
```

`SKILL.md` is deliberately short: it decides *whether* to act and *in what
order*. The references carry the method. Agents load them selectively, which
keeps the common case cheap.

## Design rules

These are the constraints that keep the output honest, and they are enforced in
the reference files:

1. **Never invent a life.** Missing facts are acceptable; fabricated ones are not.
2. **Always name conditions and costs**, not just outcomes.
3. **Give differences the same weight as similarities.**
4. **At least one counter-case** in every full analysis — someone who tried and
   did not arrive, or arrived and paid a price.
5. **Coverage floor**: ≥2 historical, ≥2 modern/contemporary, ≥3 cultural
   backgrounds, ≥3 path types. Not four founders from one country.
6. **Ranges, not dates.** No success probabilities.
7. **Four labels, never blended**: fact / their account / scholarly view /
   inference.
8. **Privacy boundary**: the user's material never enters a public search; the
   search uses an abstracted pattern only.

## Tests

The `tests/` directory holds scenario specifications used to check the skill
manually and in review:

- `trigger-scenarios.md` — when it should and should not fire
- `coverage-scenarios.md` — global and domain coverage behaviour
- `evaluation-scenarios.md` — 14 analysis scenarios with expected properties

These are specifications for judgement, not automated assertions. See each file
for how to run a check.

## License

MIT — see [LICENSE](LICENSE).

## Contributing

Corrections to the method, better source standards, and additional coverage
anchors are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first — in
particular the rule that **no person, event or source may be added from memory
without a traceable citation**.
