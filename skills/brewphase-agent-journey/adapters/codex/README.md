# Codex adapter

How to make Codex (and other `.agents`-convention loaders) pick up this skill.

## Canonical source

```
SKILL.md
```

Everything else points here. Never edit a copy — a forked body drifts the
moment either side changes.

## Repository-level installation

Codex and other agents following the `.agents/skills` convention read
repository-level skills from `.agents/skills/<name>/`.

Run everything below **from the repository root**, so the `../..` in the
symlink resolves to the repo.

### macOS / Linux

Create the parent directories first — a clean checkout has neither `.agents/`
nor `.codex/`, and `ln -s` fails with `No such file or directory` if the
parent is missing:

```bash
mkdir -p .agents/skills .codex/skills
```

Then link the skill into both locations:

```bash
ln -s ../../skills/brewphase-agent-journey .agents/skills/brewphase-agent-journey
ln -s ../../skills/brewphase-agent-journey .codex/skills/brewphase-agent-journey
```

Creating both is harmless even if your loader only reads one path, and it
saves a round trip when you switch tools.

**If the link already exists**, do not overwrite it blindly:

```bash
# Already the right link? Leave it alone.
readlink .agents/skills/brewphase-agent-journey 2>/dev/null \
  | grep -qx '../../skills/brewphase-agent-journey' \
  && echo "already correct" \
  || echo "missing or different — inspect it before replacing"
```

If the path already exists and is **not** this link (for example a real
directory from an earlier manual install), stop and inspect it. Removing or
clobbering it could delete content you did not put there:

```bash
ls -la .agents/skills/ .codex/skills/
```

Replace it only after you have confirmed it contains nothing you need.

### Windows (PowerShell)

Enable Developer Mode first, otherwise `New-Item -ItemType SymbolicLink`
requires an elevated shell. Then create **both** parent directories and
**both** links — one block for `.agents\skills`, one for `.codex\skills`:

```powershell
# parent directories (idempotent — -Force does not touch existing content)
New-Item -ItemType Directory -Force -Path .agents\skills | Out-Null
New-Item -ItemType Directory -Force -Path .codex\skills  | Out-Null

# .agents/skills
if (-not (Test-Path .agents\skills\brewphase-agent-journey)) {
  New-Item -ItemType SymbolicLink `
    -Path   .agents\skills\brewphase-agent-journey `
    -Target ..\..\skills\brewphase-agent-journey | Out-Null
}

# .codex/skills
if (-not (Test-Path .codex\skills\brewphase-agent-journey)) {
  New-Item -ItemType SymbolicLink `
    -Path   .codex\skills\brewphase-agent-journey `
    -Target ..\..\skills\brewphase-agent-journey | Out-Null
}
```

The `if (-not (Test-Path …))` guards keep an existing link or directory from
being overwritten. If a path exists and is **not** this link, inspect it
(`Get-Item .agents\skills\brewphase-agent-journey | Format-List *`) before
replacing it — do not delete content you did not create.

Without Developer Mode, `New-Item -ItemType SymbolicLink` fails with
"Administrator privilege required". Point the loader at
`skills/brewphase-agent-journey` directly rather than copying it — **copies
drift**, and a stale copy will keep using removed tool names.

## Verify the link and the frontmatter

Check **both** locations:

```bash
readlink .agents/skills/brewphase-agent-journey     # → ../../skills/brewphase-agent-journey
readlink .codex/skills/brewphase-agent-journey      # → ../../skills/brewphase-agent-journey
test -f  .agents/skills/brewphase-agent-journey/SKILL.md && echo ok
test -f  .codex/skills/brewphase-agent-journey/SKILL.md  && echo ok
head -3  .agents/skills/brewphase-agent-journey/SKILL.md
```

`head -3` must print the frontmatter fence, `name: brewphase-agent-journey`,
and the opening of `description:`. If the name is missing or different, the
loader will not match this skill to a task.

## The skill and the MCP server are two separate integrations

| | What it is | Where it comes from |
|---|---|---|
| **Skill** | Instructions the model follows | this directory, via symlink |
| **MCP Server** | The six `*_agent_journey` tools | `Desktop/out/mcp/stdio.mjs`, spawned by Codex |

Installing the skill does **not** give Codex the tools, and configuring the
MCP server does **not** tell Codex when to record. Both are needed.

MCP setup is documented in `Desktop/README.md` (Settings → AI connections →
copy the Codex config). It produces a token that is **shown once** — never
write it into this repository, into a skill, or into an issue.

Scope is granted per client in BrewPhase settings. A client without
`agent_journey:write` can still read the skill and still do the user's task; it
just cannot record. That is expected behaviour, not a bug to work around.
