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

```bash
ln -s ../../skills/brewphase-agent-journey .agents/skills/brewphase-agent-journey
```

The same link is expected under `.codex/skills/` for loaders that use that path:

```bash
ln -s ../../skills/brewphase-agent-journey .codex/skills/brewphase-agent-journey
```

Run both from the repository root. If your loader only reads one of the two
paths, creating both is harmless and saves a round trip when you switch tools.

### Windows (PowerShell)

Enable Developer Mode first, otherwise `New-Item -ItemType SymbolicLink`
requires an elevated shell:

```powershell
New-Item -ItemType Directory -Force -Path .agents\skills
New-Item -ItemType SymbolicLink `
  -Path   .agents\skills\brewphase-agent-journey `
  -Target ..\..\skills\brewphase-agent-journey
```

Without Developer Mode, point the loader at `skills/brewphase-agent-journey`
directly rather than copying it — **copies drift**, and a stale copy will keep
using removed tool names.

## Verify the link and the frontmatter

```bash
readlink .agents/skills/brewphase-agent-journey     # → ../../skills/brewphase-agent-journey
test -f  .agents/skills/brewphase-agent-journey/SKILL.md && echo ok
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
