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

Put the structured version in `details.decision` (`selected_approach`,
`rationale`, `alternatives[]`, `tradeoffs[]`) so a later reader can scan the
rejected options without parsing prose. Only decisions that mattered —
detail that changes nothing is noise.

See [Structured execution details](#structured-execution-details-details).

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
- **If you changed code, record it in `details.changes` — one entry per
  file.** Each entry needs the repo-relative path, the change type, what
  actually changed, what was wrong before, what happens after, and **why
  that file/function was the right place to fix it**. A single
  "fixed the parameter mapping" summary for three files is not enough, and
  a summary with no file list is worse. If you did not touch a file, do not
  list one.
- If the work was analysis or debugging with no file changes, record the
  object you worked on and the outcome in `details.observations` instead —
  never invent a `changes` entry.

### 6. Record what you observed

Append `observation` with the actual outcome: real return values, which files
changed, build/test results, defects found, mismatches against expectations.

Use `details.observations[]` (`finding`, `impact?`, `source?`) for the
structured form: what you actually saw, how far it reaches, and **where the
information came from** (log line, test output, error text). A guess is not
an observation — if you inferred it, say so in `summary` instead of filing
it under `source`.

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
- Record each command or test target in `details.verification[]` with
  `result` = `passed` | `failed` | `not_run` | `skipped`, plus `command`,
  `target`, `exit_code` when you have it, and a short `summary`.
  **Anything you did not execute is `not_run`** — not `passed`, not omitted.
  `evidence_reference` is for something another person can open (a test file,
  a report path, a commit).

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

## Structured execution details (`details`)

`append_agent_journey_event` accepts an optional, **strictly validated**
`details` object. It is stored under `metadata.journey_detail_v1` and read
back by `get_agent_journey`. Unknown keys are **rejected**, so do not invent
fields — omit what you do not know instead of guessing.

Use it whenever another developer (or a future you) must answer:
*what was changed, where, why there, and how it was verified.*

```text
details = {
  version: 1
  decision?      { selected_approach, rationale,
                   alternatives[]?: { approach, reason_not_selected },
                   tradeoffs[]?: string }
  changes[]?     { file_path, change_type: created|modified|deleted|renamed,
                   symbols[]?, change_summary, before_behavior?,
                   after_behavior?, why_this_location, line_range? {start,end} }
  observations[]?{ finding, impact?, source? }
  verification[]?{ command?, target,
                   result: passed|failed|not_run|skipped,
                   exit_code?, summary, evidence_reference? }
  references[]?  { kind: commit|diff|test|file|record|url, value, label? }
  limitations[]? string
}
```

### Which event carries which fields

| Event | Put in `details` |
|---|---|
| `decision` | `decision` — chosen approach, the real reason, each rejected alternative and why, known tradeoffs |
| `execution` (code changed) | `changes[]` — **one entry per file**, each with path, symbols, what changed, before/after behaviour and **why that location** |
| `execution` (no code changed) | `observations[]` — what you actually worked on and got. **Never invent a `changes` entry** |
| `observation` | `observations[]` — finding, impact, and the source you read it from |
| `revision` | `changes[]` for what actually moved this time, plus `observations[]`/`limitations[]` for the defect that forced it |
| `verification` | `verification[]` — one entry per command or test target |
| `outcome` | `changes[]` (what shipped), `verification[]`, `references[]`, `limitations[]` |

### Rules that will fail review

1. **One entry per file.** Three files changed means three `changes` entries.
   A single overall summary hides exactly the information a reader needs.
2. **`why_this_location` is required on every change.** Say what that module
   owns, what depends on it, and why the fix belongs there rather than
   somewhere more convenient.
3. **`result` is `not_run` / `skipped` if you did not execute it.** Not
   `passed`, not quietly left out.
4. **`evidence_level` is always `agent_reported`.** You cannot declare
   `tool_result` or `runtime_observed` — the server rejects it. Present your
   test results as what they are: your own report, traceable only through
   the `command` and `evidence_reference` you recorded.
5. **Repo-relative paths only** (`Desktop/src/...`). No absolute machine
   paths, no home directories.
6. **No full source files, no full terminal dumps, no raw diffs.** Keep the
   summary; reference a commit SHA instead of pasting a patch.
7. **Budget:** the whole `metadata` blob is capped (16 000 chars) and every
   field has its own limit. Over budget is **rejected**, not truncated —
   trimming would leave JSON you cannot parse.
8. **Never record hidden chain of thought.** `rationale` and
   `why_this_location` are reasons you already showed the user, not your
   internal scratchpad.

### Complete example

A realistic Journey: the user asks for a mapping fix, you plan it, pick an
approach, touch two files, hit a failure, revise, verify, and finish.

**1 — user input**

```text
append_agent_journey_event({
  journey_id: "…", event_type: "user_input",
  title: "边关系一条都写不进去，修一下",
  summary: "用户要求：append_agent_journey_event 提交 edges 后数据库里没有关系行。",
  idempotency_key: "evt:<uuid>"
})
```

**2 — plan**

```text
append_agent_journey_event({
  journey_id: "…", event_type: "plan",
  title: "先定位映射缺口，再补边关系回归",
  summary: "三步：复现 → 在 Handler 边界补字段映射 → 加真实 Bridge 回归。",
  idempotency_key: "evt:<uuid>"
})
```

**3 — decision (with rejected alternatives)**

```text
append_agent_journey_event({
  journey_id: "…", event_type: "decision",
  title: "映射放在 Handler 边界，不改 Service 领域模型",
  reason: "边界转换可测、可枚举；散落到 Service 会让领域模型背上协议细节。",
  details: {
    version: 1,
    decision: {
      selected_approach: "在 Handler 边界做 snake_case → camelCase 显式映射",
      rationale: "Handler 是外部协议与 Application Service 的适配边界，协议细节只应出现在这里。",
      alternatives: [
        { approach: "在 Service 内部兼容两种命名",
          reason_not_selected: "领域模型被迫知道外部协议，测试面扩大到每一处读取" },
        { approach: "只补类型断言",
          reason_not_selected: "断言骗过编译器，运行时字段仍是 undefined" },
        { approach: "改 MCP 对外用 camelCase",
          reason_not_selected: "破坏既有客户端契约，R6-2 的 6 个工具全部受影响" }
      ],
      tradeoffs: ["边界多一层显式转换", "需要补一条真实链路的回归"]
    }
  },
  idempotency_key: "evt:<uuid>"
})
```

**4 — execution, file 1 (the actual fix)**

```text
append_agent_journey_event({
  journey_id: "…", event_type: "execution", title: "补齐 edges 的字段映射",
  summary: "在 Handler 边界逐字段转换，断言只描述进来的形状。",
  details: {
    version: 1,
    changes: [{
      file_path: "Desktop/src/main/application/mcp-tools/handlers.ts",
      change_type: "modified",
      symbols: ["append_agent_journey_event"],
      change_summary: "把 params.edges 的 to_event_id / relationship_type 显式 map 成 toEventId / relationshipType。",
      before_behavior: "直接 as 成 Service 类型：类型过了，运行时字段仍是 snake_case，Service 读到 undefined，整条 append 事务回滚。",
      after_behavior: "Handler 在边界逐字段转换，边关系正常写入；未传 edges 时仍为 undefined，行为不变。",
      why_this_location: "Handler 是 MCP 协议与 Application Service 之间唯一的适配层，协议命名只应在这里消失。",
      line_range: { start: 369, end: 410 }
    }]
  },
  idempotency_key: "evt:<uuid>"
})
```

**5 — execution, file 2 (the regression that proves it)**

```text
append_agent_journey_event({
  journey_id: "…", event_type: "execution", title: "补边关系回归",
  summary: "在已有真实 Bridge 链路上加三条断言。",
  details: {
    version: 1,
    changes: [{
      file_path: "Desktop/tests/integration/mcp-journey-bridge.test.ts",
      change_type: "modified",
      symbols: ["F2. edges 的 snake_case → camelCase 映射"],
      change_summary: "新增：snake_case 提交真的落库、未传 edges 返回空数组、非法目标整体回滚不留半截。",
      before_behavior: "没有任何测试覆盖 edges 的字段名映射，映射写错照样绿。",
      after_behavior: "映射写错时该套件立刻变红。",
      why_this_location: "这个文件已经有 BridgeClient → BridgeServer → Service → SQLite 的完整链路，回归放这里才测得到端到端；放到纯单测里只能测到 mock。"
    }]
  },
  idempotency_key: "evt:<uuid>"
})
```

**6 — observation (what you actually saw)**

```text
append_agent_journey_event({
  journey_id: "…", event_type: "observation",
  title: "日志里 edge.toEventId 是 undefined",
  summary: "断言骗过了编译器，没骗过运行时。",
  details: {
    version: 1,
    observations: [{
      finding: "Service 收到的 edge 对象字段名仍是 to_event_id，读 toEventId 得到 undefined。",
      impact: "每条边都触发 NOT_FOUND，整条 append 回滚，库里 0 条关系。",
      source: "回归套件的断言输出与 agent_journey_edges 表计数"
    }]
  },
  idempotency_key: "evt:<uuid>"
})
```

**7 — failure, then a revision (history is never overwritten)**

```text
append_agent_journey_event({ … event_type: "execution", title: "第一次：只补了类型断言",
  details: { version: 1, changes: [{
    file_path: "Desktop/src/main/application/mcp-tools/handlers.ts",
    change_type: "modified", change_summary: "只把 as 的目标类型改成了 Service 的输入类型。",
    why_this_location: "当时误以为类型对了字段名就对了。" }] } })
update_agent_journey_event({ event_id: "…", status: "running", expected_updated_at: … })
update_agent_journey_event({ event_id: "…", status: "failed",   expected_updated_at: … })

append_agent_journey_event({
  journey_id: "…", event_type: "revision", title: "改成显式 map",
  reason: "断言不产生运行时转换；类型和字段名是两件事。",
  parent_event_id: "<failed event id>",
  edges: [{ to_event_id: "<failed event id>", relationship_type: "revises" }],
  idempotency_key: "evt:<uuid>"
})
```

The failed execution **stays** with its own `details` — a later reader must
be able to see what was tried first and why it did not work.

**8 — verification (only what really ran)**

```text
append_agent_journey_event({ … event_type: "verification", title: "跑回归" })
update_agent_journey_event({ …, status: "running", … })
   → npx vitest run tests/integration/mcp-journey-bridge.test.ts   (exit 0, 23 passed)
   → npx vitest run tests/integration/mcp-protocol.integration.test.ts (exit 0, 7 passed)
update_agent_journey_event({ …, status: "completed", … })

details: {
  version: 1,
  verification: [
    { command: "npx vitest run tests/integration/mcp-journey-bridge.test.ts",
      target: "边关系回归 3 例", result: "passed", exit_code: 0,
      summary: "23 通过；变异还原后恢复全绿。",
      evidence_reference: "tests/integration/mcp-journey-bridge.test.ts" },
    { command: "npx vitest run tests/integration/mcp-protocol.integration.test.ts",
      target: "真实 STDIO A→F 闭环", result: "passed", exit_code: 0,
      summary: "7 通过。" },
    { target: "Playwright 全量 E2E", result: "not_run",
      summary: "本阶段未运行，不声称通过。" }
  ]
}
```

**9 — outcome (finishes the journey in the same transaction)**

```text
append_agent_journey_event({
  journey_id: "…", event_type: "outcome",
  title: "边关系回归通过，整套 1457 全绿",
  summary: "typecheck 0、mcp:build 0、完整套件 0 失败；Cloud 回归未受影响。",
  journey_status: "completed",
  details: {
    version: 1,
    changes: [
      { file_path: "Desktop/src/main/application/mcp-tools/handlers.ts",
        change_type: "modified", change_summary: "边界显式映射 edges。",
        why_this_location: "协议命名只应在适配层消失。" },
      { file_path: "Desktop/tests/integration/mcp-journey-bridge.test.ts",
        change_type: "modified", change_summary: "新增边关系回归 3 例。",
        why_this_location: "该文件已有真实端到端链路。" }
    ],
    verification: [
      { target: "pnpm typecheck", result: "passed", exit_code: 0, summary: "0 错误。" },
      { target: "pnpm test", result: "passed", exit_code: 0, summary: "102 文件 / 1526 测试。" },
      { target: "Playwright 全量 E2E", result: "not_run", summary: "未运行。" }
    ],
    references: [
      { kind: "commit", value: "<sha>", label: "R6-2.1" },
      { kind: "test", value: "tests/integration/mcp-journey-bridge.test.ts" }
    ],
    limitations: ["Playwright 全量 E2E 未运行", "行号仅作辅助，以符号名为准"]
  },
  idempotency_key: "evt:<uuid>"
})
```

A reader who opens this Journey can answer, without asking you:
which files changed, why the fix landed in `handlers.ts` rather than in the
service, which approach was rejected and why, what the first attempt got
wrong, which commands actually ran, and what is still unverified.

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
