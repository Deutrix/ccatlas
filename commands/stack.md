---
description: What is installed in this Claude Code stack, and whether it agrees with itself
---

Run `ccatlas status` and summarise: totals, anything in `degraded` (that section
is broken, not empty), and any `reconciliation` warning — those mean the CLI and
the config files disagree and both values are recorded.

Add `--project .` to scope it to this repo.
