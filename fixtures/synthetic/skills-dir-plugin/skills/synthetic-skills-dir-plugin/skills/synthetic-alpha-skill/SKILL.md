---
name: synthetic-alpha-skill
description: SYNTHETIC FIXTURE — first skill contributed by the synthetic @skills-dir plugin. Its owner is the plugin, not the personal skills directory it happens to live under.
---

# Synthetic alpha skill

Synthetic fixture content. Not a real skill; never invoke it.

Load-bearing property: this file sits at
`~/.claude/skills/<plugin-dir>/skills/<skill>/SKILL.md` — **two levels below** the
personal-skills root, because the plugin owns an inner `skills/` directory.
A collector that assumes `~/.claude/skills/*/SKILL.md` misses it entirely.
