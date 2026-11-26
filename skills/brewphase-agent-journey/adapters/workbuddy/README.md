# WorkBuddy adapter

How to get this skill running in WorkBuddy.

The skill is just Markdown. "Installing" it means putting one directory where
WorkBuddy looks for skills, then restarting the app.

---

## TL;DR

```bash
# 1. clone once, somewhere durable
git clone https://github.com/banmu123/BrewPhase ~/BrewPhase

# 2. create WorkBuddy's user-level skills directory if it does not exist yet
#    (a fresh machine has no ~/.workbuddy/ at all)
mkdir -p ~/.workbuddy/skills

# 3. link the skill into it (only if nothing is there yet)
if [ ! -e ~/.workbuddy/skills/brewphase-agent-journey ]; then
  ln -s ~/BrewPhase/skills/brewphase-agent-journey \
        ~/.workbuddy/skills/brewphase-agent-journey
else
  echo "already exists — inspect before replacing:"
  ls -la ~/.workbuddy/skills/brewphase-agent-journey
fi

# 4. restart WorkBuddy, then ask it something worth recording
```

The `[ ! -e … ]` guard matters: it stops you from overwriting a link, a real
directory, or **another skill** that happens to share the name. If something
is already there, look at it first — do not delete content you did not
create.

Windows users: see the PowerShell section below — `ln -s` needs Developer Mode
on or an elevated shell.

## Where WorkBuddy looks for skills

| Scope | Path | When to use |
|---|---|---|
| User (all projects) | `~/.workbuddy/skills/` | Almost always |
| Project only | `<workspace>/.workbuddy/skills/` | One repository, not shared |

On Windows these are `C:\Users\<you>\.workbuddy\skills\` and
`<workspace>\.workbuddy\skills\`.

The directory name must be exactly `brewphase-agent-journey`, and `SKILL.md`
must sit at its top level. A nested `brewphase-agent-journey-main/` or
`skills/brewphase-agent-journey/skills/brewphase-agent-journey/` will not be
read.

---

## Install

### Option A — let WorkBuddy do it

Paste this into WorkBuddy:

> 帮我安装这个 skill：
> `https://github.com/banmu123/BrewPhase`
> 读 `skills/brewphase-agent-journey/SKILL.md` 的 frontmatter，把它软链到
> `~/.workbuddy/skills/brewphase-agent-journey`，装完用一句话验证它能不能被选中。

This is the path least likely to go wrong, because the agent can check your
actual filesystem instead of guessing your home directory.

### Option B — install manually (macOS / Linux)

User-level (all projects):

```bash
mkdir -p ~/.workbuddy/skills
if [ ! -e ~/.workbuddy/skills/brewphase-agent-journey ]; then
  ln -s ~/BrewPhase/skills/brewphase-agent-journey \
        ~/.workbuddy/skills/brewphase-agent-journey
else
  echo "exists — inspect:"; ls -la ~/.workbuddy/skills/brewphase-agent-journey
fi
```

Project-scoped instead (only this repository). `mkdir -p` is required here
too: `.workbuddy/` will not exist in a clean clone:

```bash
mkdir -p <workspace>/.workbuddy/skills
if [ ! -e <workspace>/.workbuddy/skills/brewphase-agent-journey ]; then
  ln -s <path-to-repo>/skills/brewphase-agent-journey \
        <workspace>/.workbuddy/skills/brewphase-agent-journey
else
  echo "exists — inspect:"; ls -la <workspace>/.workbuddy/skills/brewphase-agent-journey
fi
```

Do not run both — pick one scope, or WorkBuddy will see the same skill twice.

### Windows — PowerShell

Create the directory first (`-Force` creates missing parents and does not
touch existing content), then link only if the target is absent:

```powershell
New-Item -ItemType Directory -Force -Path $env:USERPROFILE\.workbuddy\skills | Out-Null

if (-not (Test-Path "$env:USERPROFILE\.workbuddy\skills\brewphase-agent-journey")) {
  New-Item -ItemType SymbolicLink `
    -Path   "$env:USERPROFILE\.workbuddy\skills\brewphase-agent-journey" `
    -Target "$env:USERPROFILE\BrewPhase\skills\brewphase-agent-journey" | Out-Null
}
```

If the path already exists, inspect it before doing anything else
(`Get-Item "$env:USERPROFILE\.workbuddy\skills\brewphase-agent-journey" | Format-List *`)
— it may be an old link, a real directory, or a different skill.

Without Developer Mode, `New-Item -ItemType SymbolicLink` fails with
"Administrator privilege required". Copy instead — and remember it is now a
fork:

```powershell
$dst = "$env:USERPROFILE\.workbuddy\skills\brewphase-agent-journey"
if (-not (Test-Path $dst)) {
  Copy-Item -Recurse `
    "$env:USERPROFILE\BrewPhase\skills\brewphase-agent-journey" $dst
} else {
  Write-Host "$dst already exists — inspect before replacing"
}
```

The `Test-Path` guard is what keeps `Copy-Item -Recurse` from silently
merging into or overwriting an existing install.

---

## Verify after restarting

WorkBuddy caches its skill list at startup, so **restart** before checking.

```bash
readlink ~/.workbuddy/skills/brewphase-agent-journey
test -f  ~/.workbuddy/skills/brewphase-agent-journey/SKILL.md && echo ok
head -3   ~/.workbuddy/skills/brewphase-agent-journey/SKILL.md
```

Then, in WorkBuddy, ask something that should match — e.g. *"help me debug why
this test fails, and record the process"*. A correct install makes the agent
reach for `start_agent_journey`. If it answers without ever offering to record,
check the link first, then check that the MCP server below is configured.

---

## MCP is a separate step

Installing the skill does **not** connect WorkBuddy to BrewPhase. The six
`*_agent_journey` tools come from a different integration:

| | What it is | Where it comes from |
|---|---|---|
| **Skill** | Instructions the model follows | this directory, via symlink |
| **MCP Server** | `start_agent_journey`, `append_agent_journey_event`, … | `Desktop/out/mcp/stdio.mjs` |

Configure it in WorkBuddy's MCP settings using the config BrewPhase shows under
**设置 → AI 连接 → 复制 WorkBuddy 配置**. That config contains a token which is
displayed **exactly once** — do not paste it into this repository, into a skill,
or into a chat transcript, and do not copy a saved config from someone else; it
goes stale the moment the client is revoked.

Grant `agent_journey:read` / `agent_journey:write` per client in BrewPhase
settings. Without them the skill still works for the user's actual task — it
just reports honestly that nothing was recorded, which is the behaviour the
skill's hard rules require.
