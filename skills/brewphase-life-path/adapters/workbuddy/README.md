# WorkBuddy adapter

How to get this skill running in WorkBuddy, including how to wire it to your
local BrewPhase data.

The skill is just Markdown. "Installing" it means putting one directory where
WorkBuddy looks for skills, then restarting the app.

---

## TL;DR

```bash
# 1. clone once, somewhere durable
git clone https://github.com/banmu123/BrewPhase ~/BrewPhase

# 2. link the skill into WorkBuddy's skills directory
ln -s ~/BrewPhase/skills/brewphase-life-path ~/.workbuddy/skills/brewphase-life-path

# 3. restart WorkBuddy, then ask it something that should match
```

Windows users: see the exact PowerShell below — `ln -s` needs Developer Mode.

---

## Where WorkBuddy looks for skills

| Scope | Path | When to use |
|---|---|---|
| User (all projects) | `~/.workbuddy/skills/` | Almost always |
| Project only | `<workspace>/.workbuddy/skills/` | One repository, not shared |

On Windows these are `C:\Users\<you>\.workbuddy\skills\` and
`<workspace>\.workbuddy\skills\`.

The directory name must be exactly `brewphase-life-path`, and `SKILL.md` must sit
at its top level. A nested `brewphase-life-path-main/` or
`skills/brewphase-life-path/skills/brewphase-life-path/` will not be read.

---

## Install

### Option A — let WorkBuddy do it

Paste this into WorkBuddy:

> 帮我安装这个 skill：
> `https://github.com/banmu123/BrewPhase`
> 读 `skills/brewphase-life-path/references/install.md`，按里面的步骤装到
> `~/.workbuddy/skills/`，装完用一句话验证它能不能被选中。

That file is written for an agent: it covers path detection, symlink vs copy,
verification, and the MCP step. This is the path least likely to go wrong,
because the agent can check your actual filesystem instead of guessing.

### Option B — install manually

**macOS / Linux**

```bash
git clone https://github.com/banmu123/BrewPhase ~/BrewPhase

mkdir -p ~/.workbuddy/skills
ln -s ~/BrewPhase/skills/brewphase-life-path \
      ~/.workbuddy/skills/brewphase-life-path
```

**Windows — PowerShell**

Developer Mode on, or an elevated shell:

```powershell
git clone https://github.com/banmu123/BrewPhase $env:USERPROFILE\BrewPhase

New-Item -ItemType Directory -Force "$env:USERPROFILE\.workbuddy\skills"
New-Item -ItemType SymbolicLink `
  -Path   "$env:USERPROFILE\.workbuddy\skills\brewphase-life-path" `
  -Target "$env:USERPROFILE\BrewPhase\skills\brewphase-life-path"
```

Without Developer Mode, `New-Item -ItemType SymbolicLink` fails with
"Administrator privilege required". Copy instead — and remember it is now a fork:

```powershell
Copy-Item -Recurse `
  "$env:USERPROFILE\BrewPhase\skills\brewphase-life-path" `
  "$env:USERPROFILE\.workbuddy\skills\brewphase-life-path"
```

### Option C — `npx skills add`

```bash
npx skills add banmu123/BrewPhase
```

**Not verified for WorkBuddy.** This CLI targets repositories following the
`skills/<name>/SKILL.md` convention, which this repo does, but where it installs
depends on the CLI's own knowledge of the agent. It may install to a Claude-style
path that WorkBuddy does not read. If you try it, check afterwards that
`~/.workbuddy/skills/brewphase-life-path/SKILL.md` exists; if it does not, use
Option A or B.

---

## Verify it is loaded

Files present is not the same as the skill being active.

1. **Restart WorkBuddy.** Skill directories are usually scanned at startup.
2. Send something that should match, without naming the skill:

   > 我在现在这份工作里待了六年，说不上差，但也不觉得自己在往哪里走。

3. **Pass:** the reply studies several people from different regions and eras,
   gives conditions and costs for each, avoids similarity percentages, and does
   not predict a date. That shape only comes from this skill's references.
4. **Fail:** generic encouragement, or "which skill would you like to use?"

If it fails:

| Check | Command |
|---|---|
| File is where you think | `ls ~/.workbuddy/skills/brewphase-life-path/SKILL.md` |
| All references present | `ls ~/.workbuddy/skills/brewphase-life-path/references/ \| wc -l` → 8 |
| Frontmatter intact | `head -3 .../SKILL.md` → `---`, `name:`, `description:` |
| Symlink resolves | `readlink -f ~/.workbuddy/skills/brewphase-life-path` |

---

## Connect BrewPhase MCP (optional)

This is what lets the skill read *your own* confirmed current state, directions,
stages and work context. It is separate from installing the skill — the skill
works without it, using only what you say in the conversation.

### 1. Create a client in BrewPhase Desktop

Open BrewPhase Desktop → **设置 → AI 连接** → create a client.

Grant the scopes you are comfortable with:

| Scope | What it allows |
|---|---|
| `direction:read` | Read your current state, directions, stages |
| `work_context:read` | Read work contexts and their linked resources |
| `records:read` | Read your records |
| `direction:propose` | Let the agent write **drafts** for you to confirm |

Copy the token immediately — it is shown once.

### 2. Add the server to WorkBuddy's MCP config

The file is `~/.workbuddy/mcp.json` (Windows: `C:\Users\<you>\.workbuddy\mcp.json`).
Merge this into the existing `mcpServers` object — **do not replace the file**,
or you will drop your other servers.

```json
{
  "mcpServers": {
    "brewphase": {
      "command": "node",
      "args": ["C:/path/to/BrewPhase/Desktop/out/mcp/stdio.mjs"],
      "env": {
        "BREWPHASE_MCP_TOKEN": "<token from step 1>",
        "BREWPHASE_MCP_USER_DATA_DIR": "C:/Users/<you>/AppData/Roaming/BrewPhase"
      }
    }
  }
}
```

Notes:

- `args` must point at the **built** `out/mcp/stdio.mjs`, not a source file. If
  `out/` does not exist, build BrewPhase Desktop first.
- On Windows use forward slashes in JSON paths, or escape backslashes.
- `BREWPHASE_MCP_USER_DATA_DIR` is the directory containing `brewphase.db`.

### 3. Trust the server

A newly written MCP entry does not run by itself. In WorkBuddy's connector or MCP
settings, find `brewphase` and enable / trust it. Without this step every call
fails with a connection error.

### 4. Check the connection

Ask:

> 读一下我的 BrewPhase 方向，告诉我现在的阶段是什么。

**Pass:** it returns your actual direction and stage names.

| Failure | Meaning |
|---|---|
| `UNAUTHORIZED` | Token wrong or client deleted |
| `PERMISSION_DENIED` | That scope was not granted |
| `APP_NOT_RUNNING` | BrewPhase Desktop is closed |
| Connection refused / server not found | Not trusted in step 3 |
| `BRIDGE_UNAVAILABLE` | Bridge disabled in BrewPhase, or path is wrong |

---

## Security

- The token is a credential. Do not paste it into chat, commits, issues or
  screenshots. Redact it if you need to show the config.
- `direction:propose` lets the agent write drafts. It **cannot** confirm them —
  the confirm action does not exist on the MCP side, by design.
- Revoke a client in BrewPhase at any time; the token stops working immediately.

---

## What is verified, and what is not

**Observed in a current WorkBuddy desktop build:**

- skills are discovered from a `skills/` directory at user and project level
- MCP servers come from a JSON config and require explicit trust before running
- `SKILL.md` frontmatter with `name` + `description` is the expected shape
- a skill placed in `~/.workbuddy/skills/<name>/` with `SKILL.md` at the top
  level is picked up after a restart

**Not verified:**

- whether `npx skills add` installs into WorkBuddy at all
- whether every build uses the same directory names and MCP config location
- whether relative symlinks inside a skill directory are followed on Windows
- whether a marketplace or import UI exists in your build

If you verify any of these, correct this file and say which build you tested.
