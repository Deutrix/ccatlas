# `@skills-dir` plugin — synthetic fixture

**Fills:** `docs/FORMATS.md` §5 — *"No `@skills-dir` plugin exists locally"* (161 directories under `~/.claude/skills/`, not one contains `.claude-plugin/plugin.json`).
**Unblocks:** T1.4. Feeds T1.7 (shadowing) and T1.6 (identity normalisation).

> ⚠️ Synthetic. Constructed, not captured.

## Layout

`./skills/` stands in for `~/.claude/skills/`.

```
skills/
├── synthetic-skills-dir-plugin/          ← the ONLY true positive
│   ├── .claude-plugin/plugin.json        ← the detection signal
│   ├── .cursor-plugin/plugin.json        ← decoy  (trap #14)
│   ├── .codex-plugin/plugin.json         ← decoy  (trap #14)
│   ├── .kimi-plugin/plugin.json          ← decoy  (trap #14)
│   ├── skills/synthetic-alpha-skill/SKILL.md
│   ├── skills/synthetic-bravo-skill/SKILL.md
│   ├── agents/synthetic-reviewer.md
│   └── commands/synthetic-report.md
├── synthetic-bravo-skill/SKILL.md        ← negative: plain personal skill, NAME COLLIDES with the plugin's
├── synthetic-decoy-only/
│   ├── SKILL.md
│   └── .cursor-plugin/plugin.json        ← negative: foreign manifest, no Claude Code manifest
└── synthetic-misplaced-manifest/
    ├── SKILL.md
    └── plugin.json                       ← negative: right content, wrong path (root, not .claude-plugin/)
```

**Six files are named `plugin.json`. Exactly one is a Claude Code manifest.** That ratio is the point: on the reference machine a naive `find -name plugin.json` returned 16 files for 7 plugins (`FORMATS.md` §0 trap #14). Detection must match the **path** `**/.claude-plugin/plugin.json`, never the filename.

The oracle is `expected-detection.json`.

## How it must be distinguished from a marketplace-sourced plugin

Not by manifest content — the manifests are the same shape. By **location and bookkeeping**:

| | marketplace-sourced | `@skills-dir` |
|---|---|---|
| Lives under | `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` | `~/.claude/skills/<dir>/` |
| Entry in `plugins/installed_plugins.json` | ✅ | ❌ |
| Key in `settings.json → enabledPlugins` | ✅ (the **only** home of the enabled bit) | ❌ |
| Marketplace in its id | ✅ `<plugin>@<marketplace>` | no marketplace exists |

**Consequence, and it is easy to get wrong:** an `@skills-dir` plugin has no `enabledPlugins` key, and `enabledPlugins` is the only home of the enabled bit (`FORMATS.md` §2). ccatlas must report its state as **enabled (implicit)** or **unknown** — *not* `disabled`, and it must not synthesise an `enabledPlugins` key for it.

**Its canonical id form is left unresolved on purpose.** `<name>@skills-dir`, bare `<name>`, and `<name>@local` are all plausible; none was observed. `expected-detection.json` asserts `origin: "skills-dir"` (the term `docs/01-prd.md` uses) and leaves the id to T1.6.

## Verified against the live CLI

```
$ claude plugin validate . --strict     # in skills/synthetic-skills-dir-plugin/
✔ Validation passed                      exit 0
```

**This manifest therefore carries no `__synthetic` marker** — and that is a finding, not an oversight. Adding `__synthetic` / `__models` produces:

```
⚠ Found 2 warnings:
  ❯ __synthetic: Unknown field '__synthetic'. Claude Code ignores it at load time.
  ❯ __models: Unknown field '__models'. Claude Code ignores it at load time.
✘ Validation failed (--strict treats warnings as errors)   exit 1
```

Unknown top-level fields in `plugin.json` are a **warning**, and `--strict` promotes warnings to errors. A marker key would make the fixture fail the very gate T1.18 and CI run. The manifest self-identifies through its `name`, `displayName`, `description` and `keywords` instead, and through `../MANIFEST.json`. The three decoy manifests *do* carry `__synthetic` inline, because Claude Code never loads them.

> Extra observation for `FORMATS.md` §1: `plugin validate` reports unknown manifest fields individually, one warning per field, with the text *"Claude Code ignores it at load time."*

## What is deliberately absent

- **No `plugin details` output.** Token figures come from an estimator with three regimes ~40% apart (`FORMATS.md` §0 trap #3). Fabricating a cost table would certify T4.7/T4.8 against invented numbers. If a cost fixture is needed, measure it live — `claude --plugin-dir <path> plugin details <name>` works on an uninstalled checkout.
- **No `installed_plugins.json` / `enabledPlugins` entry.** Their absence *is* the fixture.
