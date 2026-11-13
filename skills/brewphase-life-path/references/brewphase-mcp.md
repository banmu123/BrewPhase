# BrewPhase MCP Integration

How to read the user's own context from BrewPhase Desktop, and the limits on
what you may do with it.

BrewPhase MCP is the user's **local** data. It is not a source about the wider
world. World biography comes from your own search; the user's own confirmed
context comes from here. Keep the two strictly separate.

---

## 1. Availability check

The MCP server runs on the user's machine and only when BrewPhase Desktop is
open with the bridge enabled and a client authorized.

If a call fails, determine which case applies and say so plainly:

| Failure | What to tell the user |
|---|---|
| No MCP client configured | "BrewPhase isn't connected to me. If you want me to use your own direction and work context, enable the MCP bridge in BrewPhase Desktop → 设置 → AI 连接 and authorize a client." |
| Unauthorized / insufficient scope | "The client doesn't have the `direction:read` scope. You'd need to re-authorize with read access." |
| App not running | "BrewPhase Desktop doesn't seem to be running, so I can't read your context." |
| No data yet | "You haven't written a current state or direction yet — so there's nothing to read. We can work from the conversation instead." |

Never pretend you read data you did not read, and never reconstruct "what the
user's BrewPhase probably says" from earlier conversation and present it as a
read.

---

## 2. Tools worth using

### `get_direction_overview` — `direction:read`

The entry point. Returns the whole Personal Direction picture in one call.

```json
{
  "current_state": { "state_id", "summary", "work_status", "capabilities",
                      "ongoing", "capacity", "constraints", "other",
                      "status", "source", "updated_at" },
  "current_state_draft": { ... } | null,
  "directions": [ { "direction_id", "title", "description", "motivation",
                     "time_horizon", "outcomes", "constraints",
                     "status", "source", "updated_at" } ],
  "stages": [ { "stage_id", "direction_id", "name", "goal",
                 "expected_outcome", "completion_criteria",
                 "time_horizon", "obstacles", "work_context_id",
                 "status", "source", "updated_at" } ],
  "pending_proposals": { "current_state": bool, "directions": n, "stages": n }
}
```

`include_state_history: true` also returns archived versions of the current
state — useful when the user asks how their own framing has changed.

**Reading it correctly:**

- `current_state` is what the user **confirmed**. Treat it as their own
  statement about themselves.
- `current_state_draft` is a proposal, possibly written by an earlier agent.
  It is **not** the user's position until confirmed. Do not quote it as fact.
- `stages[].status`: only one stage per direction can be `active`. `proposed`
  means waiting for the user. Never describe a proposed stage as current.
- `source: "agent"` means an agent wrote it; `"user"` means the user wrote it.
  That distinction matters when deciding how much weight to give a statement.

### `list_work_contexts` / `get_work_context` — `work_context:read`

What the user is actively working on: goal, progress summary, next step, and
linked records / canvases / URLs.

Use it to ground "what you're doing right now" in something real, instead of
asking the user to repeat themselves. `get_work_context` returns the linked
resources with labels, which lets you refer to a concrete artefact.

### `search_records` / `get_record` — `records:read`

The user's own collected material — notes, links, images, videos, tags. Useful
when the user says "I wrote something about this before" or when their records
reveal an interest they have not mentioned.

Search narrowly. Do not bulk-read the library.

---

## 3. Writing: proposals only

Three write tools exist, all scoped to `direction:propose`:

- `propose_current_state`
- `propose_direction`
- `propose_stage_goal`

They write **drafts**. They cannot confirm anything: there is no confirm tool
and no confirm scope on the MCP side, by design.

Use them only when the user explicitly asks you to record something — "write this
down", "save that as my direction", "add a stage for this". In that case:

1. Say what you are about to write, in one sentence.
2. Write it.
3. Tell the user it is a draft and that they need to confirm it in BrewPhase
   Desktop → Studio Home → 我的方向 before it becomes theirs.

Do not propose anything the user has not said. Do not "tidy up" their direction
on your own initiative. Do not propose a stage because it seems like the obvious
next step.

---

## 4. What this skill must not do

- **Never** modify a confirmed Current State, Direction or Stage Goal. There is
  no MCP path to do so, and you should not look for one.
- **Never** mark a stage complete. Completion is the user's judgement, made in
  the app.
- **Never** create records or canvases as a side effect of an analysis. If you
  think a record would help, ask first.
- **Never** write the user's private material into a public-facing tool.

---

## 5. Do not assume unimplemented features

BrewPhase is being built in stages. As of this skill's writing:

| Feature | Status |
|---|---|
| Current State, Direction, Stage Goal | Implemented |
| Work Context (goal / progress / next step / resources) | Implemented |
| Records, Canvas, Coffee | Implemented |
| Activity History (what the user actually did, over time) | **Not implemented** |
| Guidance (next-best-move suggestions stored in the app) | **Not implemented** |
| Forecast snapshots (stored predictions, later compared to outcomes) | **Not implemented** |

This matters. Without Activity History you **cannot** say what the user has done
recently, how consistent they have been, or whether their actions are moving them
toward their stated direction. You can only see what they wrote down and what
they are currently working on.

If the user asks "have I been making progress?", the honest answer is: "I can see
your stated direction and your current work context, but BrewPhase doesn't yet
record an activity history, so I can't measure progress over time. Tell me what
you've actually done and I'll work from that."

Do not fill that gap with inference from `updated_at` timestamps. A record that
was edited last week does not mean the user worked on it last week.

---

## 6. Privacy

- The user's direction, stages, work context and records are private. Do not
  paste them into search queries.
- When searching for comparable lives, use the **abstracted pattern** only
  (see `historical-pattern-matching.md` step 2) — never a name, employer, city,
  or a combination that identifies them.
- Do not send personal material to any third-party service.
- In the answer, quote the user's own words sparingly and only where it helps
  them see their situation clearly. Do not restate their private details at
  length.

---

## 7. Scope summary

| Need | Scope |
|---|---|
| Read direction / stages / current state | `direction:read` |
| Read work contexts | `work_context:read` |
| Read records | `records:read` |
| Write a draft for the user to confirm | `direction:propose` |

If a scope is missing, ask for it rather than working around it. Read-only
analysis is fully possible with `direction:read` plus `work_context:read`.
