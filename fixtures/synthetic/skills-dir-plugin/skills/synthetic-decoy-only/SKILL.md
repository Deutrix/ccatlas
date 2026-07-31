---
name: synthetic-decoy-only
description: SYNTHETIC FIXTURE — a personal skill whose directory carries a FOREIGN tool manifest and no Claude Code manifest. Must be classified personal, not plugin.
---

# Synthetic decoy-only skill

Synthetic fixture content. Not a real skill; never invoke it.

This directory contains `.cursor-plugin/plugin.json` and **no**
`.claude-plugin/plugin.json`. A collector matching `**/plugin.json` promotes it
to a plugin; a correct collector matching `**/.claude-plugin/plugin.json`
leaves it as a personal skill. See `docs/FORMATS.md` §0 trap #14.
