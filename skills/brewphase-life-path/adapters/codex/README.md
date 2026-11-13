# Codex adapter

How to make Codex (and `.agents`-convention loaders) pick up this skill.

## Canonical source

```
SKILL.md
```

Everything else points here. Never edit a copy.

## Repository-level installation

Codex and other agents following the `.agents/skills` convention read
repository-level skills from `.agents/skills/<name>/`.

```bash
ln -s ../../skills/brewphase-life-path .agents/skills/brewphase-life-path
```

The same link is expected under `.codex/skills/` for loaders that use that path:

```bash
ln -s ../../skills/brewphase-life-path .codex/skills/brewphase-life-path
```

Windows: enable Developer Mode, then use `New-Item -ItemType SymbolicLink`.
Without Developer Mode, point the loader at `skills/brewphase-life-path`
directly rather than copying — copies drift.

Both directories ship a `README.md` with the exact command.

## Verify

```bash
# the link exists and resolves
ls -l .agents/skills/brewphase-life-path/SKILL.md

# the frontmatter is parseable
head -4 skills/brewphase-life-path/SKILL.md
```

Then, inside Codex, ask something like *"I've been in the same job for six years
and I don't know whether to leave"* — the skill should be selected without you
naming it. If it is not selected, check that the loader actually sees the
directory (some versions require an explicit reload).

## What is verified, and what is not

**Verified in this repository:** the file layout, the frontmatter shape
(`name` + `description`), the relative-link targets, and that every reference
file referenced from `SKILL.md` exists.

**Not verified:** which Codex versions read `.agents/skills` versus
`.codex/skills`, whether a given version requires a manifest, and whether it
supports relative symlinks or resolves them at install time. These vary by
version and by distribution. Check your build's documentation rather than
trusting this file.

If your Codex version does not auto-select skills from a directory, invoke it
explicitly for the first run and note what you had to do — then correct this
file. An inaccurate adapter note costs other people more time than a missing
one.

## MCP note

The BrewPhase MCP server is a **separate** integration from the skill. Codex
reaching BrewPhase requires its own MCP client configuration pointing at the
local bridge; see
[`references/brewphase-mcp.md`](../../references/brewphase-mcp.md).

The skill is fully usable without it.
