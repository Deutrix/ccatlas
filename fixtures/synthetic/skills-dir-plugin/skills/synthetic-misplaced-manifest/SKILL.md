---
name: synthetic-misplaced-manifest
description: SYNTHETIC FIXTURE — a personal skill with a plugin.json at the directory ROOT rather than inside .claude-plugin/. Must be classified personal, not plugin.
---

# Synthetic misplaced-manifest skill

Synthetic fixture content. Not a real skill; never invoke it.

`plugin.json` sits at this directory's root, **not** inside `.claude-plugin/`.
Claude Code loads manifests only from `.claude-plugin/plugin.json`
(`docs/02-architecture.md` §4.1), so this is not a plugin. Negative case for a
detector that searches for the filename rather than the path.
