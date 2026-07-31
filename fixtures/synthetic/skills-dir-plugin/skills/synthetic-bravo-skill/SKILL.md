---
name: synthetic-bravo-skill
description: SYNTHETIC FIXTURE — a PLAIN personal skill. No .claude-plugin/ anywhere. Shares its name with a skill contributed by the synthetic @skills-dir plugin, so shadowing detection has a case.
---

# Synthetic bravo skill (personal)

Synthetic fixture content. Not a real skill; never invoke it.

Negative case for T1.4 `@skills-dir` detection: this directory is what 161 of 161
directories under `~/.claude/skills/` look like on the reference machine — a
`SKILL.md` and nothing else. It must be classified `origin: personal`, never as
a plugin.
