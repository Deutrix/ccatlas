---
name: stack-audit
description: Audits this Claude Code stack for things worth acting on — plugins and skills never invoked, version pins that look current but are stale, plaintext credentials in config, and orphaned state. Use for "what can I prune", "is anything out of date", "audit my setup", "what is costing me context".
---

# Stack audit

Three commands, read in this order.

```bash
ccatlas doctor --json     # findings, each with a severity and a fix command
ccatlas updates --json    # stale pins, upgrades, marketplace staleness
ccatlas usage --json      # invocation counts and the never-invoked list
```

## The finding no other tool shows

`updates.data.stalePins` — the version string has not moved but the source
has, so `/plugin update` reports *already at the latest version* while old code
runs. Lead with these when present.

## Before recommending a prune

`usage` returns `{available:false, reason}` when the transcript layer could not
be read. **If it does, recommend nothing.** "I could not read your usage" and
"you have not used these" are the same shape and opposite advice, and the
second gets acted on by deleting.

Also check `data.unused[].passiveCost`. Absent means nobody measured it — not
that it is free. Rank by cost only where a cost exists.

## Presenting fixes

Every doctor finding carries `fixCommand`, or omits it when no single command
would work. **Quote it verbatim; never invent one.** Read `reference.md` for
the finding codes, severity meanings and the `skipped` list — checks that did
not run, which must be reported rather than read as a clean bill of health.
