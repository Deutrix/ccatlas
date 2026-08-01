---
name: stack-overview
description: Answers questions about what is installed in this Claude Code stack — which plugins, skills, agents, commands and MCP servers exist, where each came from, and whether the CLI and config files agree. Use for "what do I have installed", "where did this skill come from", "which plugin owns X".
---

# Stack overview

Run `ccatlas status --json` and answer from its output.

```bash
ccatlas status --json           # the whole stack
ccatlas status --json --cached  # fast path; falls back and says so on a miss
ccatlas status --json --project .   # this repo's effective stack
```

## Reading the envelope

Everything is under `data`. The fields that matter most:

- `data.scope` — `{kind:"global"}` or `{kind:"project",path}`. **Check this
  first**; a scoped answer looks identical in shape to a global one.
- `data.degraded` — collector sections that **failed**. A section listed here
  is empty because something broke, not because nothing is installed. Never
  report `0` for a degraded section; say it is unavailable.
- `data.partial` — succeeded but knowingly incomplete.
- `data.warnings` — structured, each with a `code`. `reconciliation` means the
  CLI and the config files disagree and **both** values are recorded.

Read `reference.md` for the full field list, the `versionSource` enum, and how
shadowing is represented.

## Rules

- **Never sum token costs.** Above Claude Code's listing cap, per-entity
  figures rank but do not add.
- Counts are exact; token figures are estimates — say so when quoting one.
- If `degraded` is non-empty, lead with what could not be read.
