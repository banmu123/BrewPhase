# Install

Instructions for an **agent** installing this skill on a user's machine. If you
are a human reading this, [`README.md`](../README.md) is the short version.

BrewPhase Life Path is a directory of Markdown files. There is no build step, no
runtime, no dependency, and no background process. Installing it means putting
`skills/brewphase-life-path/` (from the BrewPhase repository) where the agent
looks for skills.

---

## What you are installing

```
BrewPhase/skills/brewphase-life-path/
├── SKILL.md              # entry point, frontmatter + procedure
└── references/           # 8 runtime files + this install guide
```

Nothing else from the repository is needed. `adapters/`, `tests/`, `README.md`
and `CONTRIBUTING.md` are for humans and reviewers.

---

## Step 0 — Ask two questions

Before touching anything, find out:

1. **Which agent** is this for? (WorkBuddy / Codex / Claude Code / other)
2. **User-level or project-level?** User-level makes it available everywhere;
   project-level limits it to one workspace.

Default to user-level unless the user says otherwise. Do not install into both.

---

## Step 1 — Locate the skills directory

| Agent | User-level | Project-level |
|---|---|---|
| WorkBuddy | `~/.workbuddy/skills/` | `<workspace>/.workbuddy/skills/` |
| Codex / `.agents` convention | — | `<workspace>/.agents/skills/` |
| Codex (`.codex`) | `~/.codex/skills/` | `<workspace>/.codex/skills/` |
| Claude Code | `~/.claude/skills/` | `<workspace>/.claude/skills/` |
| Other | Ask the user, or check the agent's docs | — |

These paths are the ones observed in current builds. **If the directory does not
exist, do not silently create a new convention** — ask the user which path their
agent reads, or check that agent's documentation. Creating a plausible-looking
directory that nothing reads is the most common way this install fails.

---

## Step 2 — Place the skill

**Prefer a symlink to a copy.** A copy forks the skill: when the repository
changes, the installed version does not, and there is no way to tell which is
authoritative.

macOS / Linux:

```bash
git clone https://github.com/banmu123/BrewPhase /tmp/bplp
ln -s /tmp/bplp/skills/brewphase-life-path ~/.workbuddy/skills/brewphase-life-path
```

Windows (PowerShell, Developer Mode on or elevated):

```powershell
git clone https://github.com/banmu123/BrewPhase $env:TEMP\bplp
New-Item -ItemType SymbolicLink `
  -Path   "$env:USERPROFILE\.workbuddy\skills\brewphase-life-path" `
  -Target "$env:TEMP\bplp\skills\brewphase-life-path"
```

If symlinks are unavailable (Windows without Developer Mode), copy the directory
instead — and tell the user it is now a fork that will not track the repository:

```bash
cp -r /tmp/bplp/skills/brewphase-life-path ~/.workbuddy/skills/
```

```powershell
Copy-Item -Recurse "$env:TEMP\bplp\skills\brewphase-life-path" `
  "$env:USERPROFILE\.workbuddy\skills\brewphase-life-path"
```

Do not leave the clone in `/tmp` if you symlinked to it — the link breaks when
the temp directory is cleared. Clone somewhere durable, or copy.

---

## Step 3 — Verify the files

```bash
ls ~/.workbuddy/skills/brewphase-life-path/SKILL.md
ls ~/.workbuddy/skills/brewphase-life-path/references/ | wc -l   # expect 9
head -3 ~/.workbuddy/skills/brewphase-life-path/SKILL.md          # expect --- / name: / description:
```

Check that `references/` contains all nine files — eight loaded at runtime, plus
this `install.md`:

```
brewphase-mcp.md  coverage-map.md  forecast-guidelines.md  install.md
historical-pattern-matching.md  path-planning.md  personal-analysis.md
response-template.md  source-evaluation.md
```

If any are missing, the copy was partial. Re-copy the whole directory.

---

## Step 4 — Verify the agent actually sees it

Files on disk are not proof of loading. Restart the agent, then ask the user to
send something that should match:

> 我在现在这份工作里待了六年，说不上差，但也不觉得自己在往哪里走。

**Pass:** the answer follows this skill's shape — several people from different
regions and eras, conditions and costs for each, no similarity percentages, no
predicted dates.

**Fail:** generic advice, or the agent asks what skill to use. Then:

1. Confirm the directory name is exactly `brewphase-life-path` (no `-main`, no
   version suffix).
2. Confirm `SKILL.md` is at the top level of that directory, not nested one
   level deeper.
3. Confirm the agent was restarted after files were placed.
4. If the agent reads a manifest or registry, add the entry there.

Report which step failed rather than declaring success.

---

## Step 5 — Optional: connect BrewPhase MCP

Only do this if the user runs BrewPhase Desktop and wants the analysis to read
their own confirmed direction and work context. The skill works without it.

**5a. Get a token from the app.** The user must do this — you cannot.

1. Open BrewPhase Desktop
2. 设置 → AI 连接 → create a client
3. Grant `direction:read` (add `work_context:read` for work context,
   `direction:propose` only if they want draft-writing)
4. Copy the token — it is shown once

**5b. Add the server to the agent's MCP config.** Ask the user where their MCP
config lives; common locations:

| Agent | Config |
|---|---|
| WorkBuddy | `~/.workbuddy/mcp.json` |
| Claude Code | `~/.claude.json` or project `.mcp.json` |
| Codex | the agent's own MCP configuration |

```json
{
  "mcpServers": {
    "brewphase": {
      "command": "node",
      "args": ["<path-to-BrewPhase>/Desktop/out/mcp/stdio.mjs"],
      "env": {
        "BREWPHASE_MCP_TOKEN": "<token from 5a>",
        "BREWPHASE_MCP_USER_DATA_DIR": "<BrewPhase user data directory>"
      }
    }
  }
}
```

Merge into the existing `mcpServers` object — do not overwrite other servers.

**5c. Trust it.** A newly written MCP entry usually does not activate by itself.
The user must enable or trust it in the agent's connector/MCP settings.

**Never print the token**, never commit it, and never write it anywhere except
the config file. If you need to show the config to the user, redact it.

---

## What not to do

- Do not modify the user's existing skill or MCP entries beyond adding this one
- Do not install to multiple locations "to be safe"
- Do not claim the install succeeded before Step 4 passes
- Do not invent a skills directory that the agent does not read
- Do not paste the MCP token into chat, logs, or a commit

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Agent never selects the skill | Wrong directory, nested one level too deep, or app not restarted |
| Skill selected but answer is generic | `references/` missing, so only `SKILL.md` loaded |
| MCP calls fail with `UNAUTHORIZED` | Token revoked, or client deleted in the app |
| MCP calls fail with `PERMISSION_DENIED` | Scope not granted for that tool |
| MCP calls fail with `APP_NOT_RUNNING` | BrewPhase Desktop is closed |
| Symlink resolves to nothing | The clone was in a temp directory that got cleared |
