---
name: brewphase-agent-journey
description: Record a valuable multi-step task as a BrewPhase Agent Journey — a durable, queryable record of the user's own expressions, decisions, executions, failures, verifications and outcomes. Use this whenever a task involves multi-step code analysis, debugging, refactoring or development; has a clear goal plus real execution and verification; requires several decisions, course corrections or retries; spans sessions or is worth reusing later; or the user explicitly asks to record how the work was done. Do NOT use for one-off questions, translation, small format conversions, light back-and-forth with no continuous execution, or whenever the user says not to record. Recording must never block the actual task: if the MCP server is unavailable or lacks the scope, keep working and say plainly that nothing was saved.
---

# BrewPhase Agent Journey

Record **one worth-keeping task** as a Journey: the user's goal, the plan you
showed them, the decisions you made and why, what you actually executed, what
you actually observed, how you revised after a failure, what you really
verified, and the outcome.

The unit of value is **a defensible record of work**, not a transcript. If you
cannot say what was decided, what was run and what came back, you have not
finished recording.

Journeys live in the **local** BrewPhase Desktop database. They are personal
assets: the user owns them, reads them back later, and relates them to other
work. They are never synced to iOS and never leave the machine through Cloud.

## What this skill is not

- Not a chat logger. Every message is not an event.
- Not a task board or a replacement for a Work Context (a Work Context spans
  many tasks; a Journey is exactly one run of one task).
- Not a hidden-reasoning store. Only what you already showed the user.
- Not a way to claim work you did not do. Nothing was observed unless something
  was actually run.

## When to use

Trigger on the *situation*, not on a keyword:

- You are about to spend several steps analysing, debugging, refactoring or
  building something.
- The task has a goal, a plan, real actions and a way to tell whether it worked.
- You will make choices worth justifying (approach, trade-off, rejected
  alternative).
- Something will probably fail and need a revision.
- The user may come back to this tomorrow and needs the trail.
- The user explicitly says "record how you did this".

## When not to use

- A single question with a single answer.
- Translation, reformatting, small conversions.
- Light clarification with no continuous execution.
- The user says not to record.
- You would only be able to write filler events. **Skip it.**

**Judge by long-term reuse value, not by how long the chat got.**

## Hard rules

1. **Never write the model's hidden chain of thought.** Record only the
   summary, plan, decision rationale and results you already surfaced to the
   user. Internal drafts and per-token reasoning are not content.
2. **Do not create an event per message, or per tool call.** Milestones only.
3. **Never claim success before the action ran.** Append the attempt first,
   then update it with the real result.
4. **Never mark a test `completed` if it was not run.** Use `skipped`.
5. **Never overwrite a failure.** Keep the original plan/execution and append a
   `revision` that points back at it.
6. **Never send `source_client_id`.** The field does not exist in the schema;
   the server takes identity from the authenticated MCP client. Sending it is
   a contract violation, not a helpful hint.
7. **Never send `role` or `evidence_level`.** Both are derived server-side.
   `role` follows `event_type`; `evidence_level` is fixed at `agent_reported`.
8. **v1 evidence is always `agent_reported`.** An agent description of a test
   run is still an agent description. It is not `tool_result` or
   `runtime_observed`, and the server rejects those values. Do not dress your
   own report up as system-observed fact.
9. **Never raise `capture_mode` through parameters.** `capture_mode` is not
   exposed in any MCP tool schema — there is no field to send, and inventing
   one does nothing. An Agent must never raise its own capture level. See
   "Capture Mode — current version" below.
10. **Never write tokens, passwords, cookies, private keys, `.env` contents or
    other credentials** — not in `title`, `summary`, `content`, `reason` or
    `metadata`. The server redacts known patterns before storage, but that is a
    safety net, not permission to include them.
11. **Do not save full terminal dumps, raw tool output or whole conversations
    by default.** Store the necessary summary; the current MCP creation path
    uses `workflow_summary`.
12. **If the user says stop recording, stop.** Do not append another event.

### When the tools are unavailable or unauthorized

- **Finish the user's task anyway.** Recording must never block real work.
- Say plainly that the Journey was **not** saved. Do not imply it was.
- Do not work around it: no direct database access, no private endpoints, no
  unauthorised path, no writing a plain file and calling it a Journey.
- If the call fails because of a stale version or a duplicate key, follow the
  idempotency and recovery rules below instead of blindly retrying.

## Tools

All six are Local MCP only, and need the matching scope
(`agent_journey:write` for the four writes, `agent_journey:read` for the two
reads). Inputs are `snake_case`; responses are `snake_case` too.

| Tool | Scope | Purpose |
|---|---|---|
| `start_agent_journey` | write | Begin a task worth keeping |
| `append_agent_journey_event` | write | Append one significant step |
| `update_agent_journey_event` | write | Advance an execution/verification status |
| `update_agent_journey_status` | write | Pause, resume, fail or cancel the journey |
| `list_agent_journeys` | read | Find existing journeys (recovery) |
| `get_agent_journey` | read | Read one journey's timeline and relations |

Write responses carry `sync_status: "desktop_local_only"`. Read responses do
not.

### Response shapes

```text
start_agent_journey          → { journey, created, replayed?, sync_status }
append_agent_journey_event   → { event, edges[], sequence, journey, created, replayed?, sync_status }
update_agent_journey_event   → { event }
update_agent_journey_status  → { journey }
list_agent_journeys          → { journeys[], total }
get_agent_journey            → { journey, events[], edges[] }
```

`events` is always ascending by `sequence` — that is the only ordering truth.
`edges` are **relationships, not the timeline**: after filtering with
`event_types`, an edge may point at an event that is not in `events`.

## Workflow

### 1. Decide whether to record

If the task does not qualify (§ When not to use), just do the work.

### 2. Start the journey

```text
start_agent_journey(
  title            = the problem being solved, in the user's terms
  goal             = objective, constraints, what "done" means
  work_context_id  = only if you already know the real UUID
  source_agent     = your real client name        (self-reported, not identity)
  model            = your real model name         (self-reported, not identity)
  idempotency_key  = start:<full UUID>
)
```

- `title` 1–200 chars after trim; `goal` ≤ 2000.
- `source_agent` / `model` are **self-reported metadata**. They are not
  authentication and never replace `source_client_id`.
- Fill `work_context_id` **only** when you genuinely know it. Guessing it
  returns `NOT_FOUND` and wastes the call.
- Keep the first `idempotency_key` **and its exact arguments**. On timeout or
  an ambiguous result, retry with the **same key and the same parameters**.

A successful start returns `journey.status = "created"`.

### 3. Record the user's goal and the plan

Append `user_input` for the user's **actual expression** of the task goal and
their key constraints:

- **Keep the user's original wording and original language** wherever it fits
  the length limit. A quotation beats a paraphrase.
- **Never pass off your own interpretation, inference or summary as the
  user's words.** If you had to condense, say so — write it as a summary of
  what they asked, not as a quote. A reader must be able to tell which is
  which.
- Your planning and analysis belong in `plan` (and your conclusions in
  `observation`), not in `user_input`.
- Long requests: keep only the fragments that matter to the task — the goal,
  the constraints, the acceptance criteria. Do not save an entire transcript
  indiscriminately just to be complete.
- Never store hidden chain of thought as if it were something the user said.

Then append `plan` — the plan you showed the user:

- what problem is being solved,
- the key steps you will take,
- what result counts as done,
- which premises are still unknown.

A `plan` is a **statement event**: it is created with `status = "completed"`
(the server does this when you omit `status`), because writing the plan *is*
the act. It does not mean the plan succeeded.

Never write hidden reasoning, internal scratch or per-token deliberation as a
plan.

### 4. Record decisions

When a choice actually changes direction, append `decision`:

- what you chose,
- why,
- what alternatives you dropped,
- the known cost or limitation of the choice.

Only decisions that mattered. Detail that changes nothing is noise.

### 5. Record execution

An `execution` is one meaningful unit of real work — not every command.

```text
append  execution (status omitted → planned)
update  execution → running          (you actually started)
   …run it…
update  execution → completed        (it really succeeded)
              or → failed            (it really did not)
```

- You may append it as `planned` before acting, or as `running` if you start
  immediately. **You may not create it as `completed`** — the server rejects
  that, because "about to do it" and "did it" must be two separate writes.
- `update_agent_journey_event` takes `event_id`, `status` and
  `expected_updated_at`. Use the `updated_at` returned by the append; the
  server rejects a stale version with `STALE_RECORD`.
- Never report success before the action finished.

### 6. Record what you observed

Append `observation` with the actual outcome: real return values, which files
changed, build/test results, defects found, mismatches against expectations.

`observation` is a **statement event** — created `completed` because the
*observation* has been recorded. It says nothing about whether the operation it
describes succeeded. If it failed, say so in `summary` / `content`.

### 7. Revise without rewriting history

When the plan has to change:

1. Keep the original `plan` / `execution` untouched.
2. Append `revision`.
3. Say why it changed.
4. Point at the original with `parent_event_id` and/or a `revises` edge.

To retry after a failed execution, append a **new** `execution` and relate it
to the failed one with a `retries` edge.

**Edge direction:** `from_event_id` is the event you are creating now;
`to_event_id` is the earlier event it relates to. Edges are relationships —
never use them to sort or order anything.

### 8. Verify for real

```text
append  verification (status omitted → planned)
update  verification → running     (the test/check actually started)
   …run it…
update  verification → completed   (it really passed)
              or → failed          (it really failed)
              or → skipped         (it was never run)
```

- **`skipped` cannot be a creation status.** Create it as `planned` first, then
  update to `skipped` using the `expected_updated_at` the server returned.
- **Never mark an unrun test `completed`.** This is the single most damaging
  lie a Journey can contain.

### 9. Finish the journey

Only when the task has genuinely reached an end, append `outcome` **with**
`journey_status: "completed"` — the server completes the journey in the same
transaction, so there is never a finished outcome on an unfinished journey.

An outcome should state: what was actually solved, what was produced, which
verifications really ran, what remains open, where the key files/commits are,
and what is worth doing next.

Other endings use `update_agent_journey_status`:

| Situation | Status |
|---|---|
| Waiting on the user | `paused` |
| Broke down and cannot continue | `failed` |
| User cancelled the task | `cancelled` |

`completed` is **not** accepted by `update_agent_journey_status` — only an
`outcome` event can finish a journey. `completed` and `cancelled` are terminal
and cannot be reopened. Never fabricate a successful outcome to tidy up the
data.

`abandoned` is not reachable; do not try to set it.

## Idempotency keys

This is a real database constraint, not a style suggestion.

**The key space is unique per MCP client across all tools.** The prefixes
`start:` and `evt:` are a naming convention for humans — they are **not**
separate namespaces. Reusing one key across two tools returns
`IDEMPOTENCY_KEY_REUSE`.

```text
start:<full UUID>     start_agent_journey
evt:<full UUID>       append_agent_journey_event
```

Rules:

- Generate a fresh full UUID for every new write.
- Retry of the **same** logical request → **same key, byte-identical params**.
  The server compares the parsed-parameter digest; changed params with the same
  key are rejected.
- Changed params → **new key**.
- Never reuse a key across tools.
- Never use a counter (`evt:1`, `evt:2`) instead of a UUID.
- Do not mint endless new keys because a retry failed — first check whether the
  original request already landed (`list_agent_journeys` / `get_agent_journey`).
- The two update tools take no key; they use `expected_updated_at`.

## Recovery across sessions

There is no background sweeper and no hook that resumes work for you.

1. `list_agent_journeys` — find the journey for this task.
2. `get_agent_journey` — read the full timeline.
3. Read `events` in ascending `sequence` order.
4. Inspect the latest execution, any failure, revisions and verifications.
5. Continue **that** journey. Do not start a duplicate for convenience.

To resume, use `update_agent_journey_status` with the `updated_at` you just
read:

```text
paused  → running
failed  → running      (only when it really can continue)
```

`completed` and `cancelled` must not be reopened.

On `STALE_RECORD`: re-read the entity with `get_agent_journey`, look at the new
`updated_at`, decide from the current state, and only then act. Never blindly
replay a stale request.

## Privacy

- Storage is local to the user's machine (`agent_journeys` and
  `agent_journey_events` tables). Not synced to iOS, not sent to Cloud.
- Content is length-limited before storage (`title` 200, `summary` 2000,
  `content` 20000, `reason` 2000) with an explicit `…[truncated]` marker.
- Known credential patterns are redacted before the write. That filter is
  best-effort: keeping secrets out in the first place is your responsibility.

### Capture Mode — current version

The current MCP creation path uses `workflow_summary`.

`capture_mode` is not exposed in any MCP tool schema.
The current Desktop Settings UI does not yet provide an Agent Journey
Capture Mode control. This is planned for R6-5.

Do not claim that the user can change this setting in the current version.
When the user-controlled setting is implemented, only the user may change
it through BrewPhase. An Agent must never raise the capture level itself.

Concretely, for the work you do right now:

- `workflow_summary` is what every journey you create actually records:
  goal, plan, decisions, key executions, failures and revisions,
  verifications, outcome.
- `conversation_capture` and `detailed_capture` are **not** available to you.
  They are not parameters you can send, and there is no setting you can flip.
- If the user asks "can I store the full conversation instead?", answer that
  the control does not exist in this version. Do not describe the R6-5 plan
  as a shipped feature, and do not work around it by pasting raw transcript
  text into `content` — that would reach the same goal by violating the
  capture boundary rather than respecting it.

## Tone when reporting

When you could not record, say so in one sentence and move on. Never claim a
Journey exists because you intended to create one.
