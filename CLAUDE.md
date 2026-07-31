# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

**Design-stage only. There is no source code yet** — the repo is `docs/` and nothing else. Phase 0 (discovery) has not started, and its blockers (`T0.1`–`T0.4`) are unanswered, which means **every CLI JSON shape described in the docs is an assumption, not an observed fact**. Do not write parsers against those shapes until a fixture corpus exists and `docs/FORMATS.md` has been written (`T0.6`).

Read in this order: `docs/01-prd.md` (what and why) → `docs/02-architecture.md` (how, plus every hard constraint) → `docs/03-diagrams.md` (the same as mermaid) → `docs/04-tasks.md` (the work, with stable IDs).

## What ccatlas is

A local-first CLI + Claude Code plugin that inventories, audits, and makes portable a user's Claude Code extension stack (marketplaces, plugins, skills, agents, commands, hooks, MCP/LSP servers). Positioning: `ccusage` is the accountant for tokens; ccatlas is the package-manager dashboard — what you have, whether it's current, whether it earns its context, and how to move it.

Ships two ways from one artefact: npm package `ccatlas` (standalone) and plugin `ccatlas@deutrix` whose marketplace entry uses `source: npm`.

## Planned toolchain (not yet scaffolded — `T0.8`)

| Concern | Choice |
|---|---|
| Language | TypeScript, bundled by esbuild to a **single minified ESM file** at `bin/ccatlas` |
| Runtime deps | **Zero.** `node:*` only |
| Analytics index | `node:sqlite` |
| HTML report | inline JSON + vanilla JS, no CDN, no runtime build step |
| Git | shell out to `git`; no JS git implementation |

The zero-dependency rule is load-bearing, not stylistic: installed plugins are copied into `~/.claude/plugins/cache`, and a `node_modules` tree there forces a `SessionStart` install dance. Treat adding a runtime dependency as an architectural decision requiring justification.

Two CI gates are defined and are hard requirements, not aspirations:

```bash
claude plugin validate . --strict          # manifest/frontmatter/hooks
claude plugin details ccatlas              # fail the build above 600 always-on tokens
```

Platform matrix is macOS + Linux + **Windows** from Phase 1. No POSIX path assumptions anywhere.

## Architecture invariants

```
Surfaces      CLI · slash commands · skills · HTML report · statusline
Services      inventory · updates · analytics · bundle · sync · doctor
Collectors    cli · config · mcp · skills · transcripts       (read-only, pure)
Sources       claude CLI JSON · ~/.claude/** · ~/.claude.json · repo .claude/** · .mcp.json
```

- **Strict layering.** Services consume collector output only. Surfaces consume service output only. **No surface reads a source directly.**
- **Official CLI first.** Every fact comes from `claude … --json` where such a command exists. File parsing is a *labelled* fallback: every record carries `source: "cli" | "file"`. Where CLI and files disagree, emit a reconciliation warning — never silently pick one.
- **Collectors never write.** All mutation shells out to the `claude` CLI (`plugin marketplace add`, `plugin install`, `mcp add-json`). ccatlas never writes into `~/.claude/plugins/` itself.
- **Fail independently.** One broken collector degrades one report section, never the run. A corrupt `~/.claude.json` must not take down `status`.
- **Estimates are labelled.** Invocation counts are exact; token costs are estimates from Claude Code's own `count_tokens`-backed estimator and must be labelled and rounded on every surface.
- **`--json` everywhere**, against a versioned schema. Skills consume JSON, not tables.

### The transcript adapter is quarantined

`~/.claude/projects/**/*.jsonl` is undocumented and unstable. **Exactly one module** parses it, behind a schema probe: unrecognised shape → `{ available: false, reason }`. Only the `analytics` service may import it. If Phase 4 stalls on transcript instability, cutting it to invocation counts and shipping Phase 5 is the *planned* degradation, not a failure.

### Version resolution is the product's differentiator

Claude Code resolves a plugin version from the first of: (1) `version` in `plugin.json`, (2) `version` in the marketplace entry, (3) git commit SHA of the source, (4) `unknown`. ccatlas records **which rule fired** as `versionSource`, because that determines update semantics — and surfaces two pathologies no existing tool shows:

- **Stale pin** — version came from a string (1 or 2), the source's HEAD SHA has moved, so `/plugin update` reports "already at the latest version" while the user runs old code.
- **Double declaration** — `version` set in *both* `plugin.json` and the marketplace entry; `plugin.json` wins silently and masks the marketplace bump.

### MCP tool-name parsing trap

Plugin-bundled MCP tools use the scoped form `mcp__plugin_<plugin>_<server>__<tool>`; user/project-scope servers use `mcp__<server>__<tool>`. A matcher written against the bare server key never fires on the former. Parse and attribute these **distinctly**.

### State location

Persistent state goes in `${CLAUDE_PLUGIN_DATA}` (→ `~/.claude/plugins/data/ccatlas-deutrix/`), which survives plugin updates. **Never write to `${CLAUDE_PLUGIN_ROOT}`** — it changes on every update. Standalone npm installs use `~/.ccatlas/` with the identical layout.

## Plugin packaging constraints

- `.claude-plugin/` contains **only** `plugin.json`. Components placed inside it silently fail to load — every other directory (`skills/`, `commands/`, `hooks/`, `bin/`) sits at the plugin root.
- Installed plugins are copied into the cache and **cannot reference files outside their own directory** (no `../shared`). Vendor or symlink within the marketplace.
- **No bundled MCP server, by design.** It would add tool schemas to every turn — self-defeating for a product whose thesis is context-budget discipline. Reach comes from `bin/` (added to the Bash tool's `PATH` while enabled) plus small skills, with bulk instructions in on-demand `reference.md` files.
- Set `version` in `plugin.json` **only, never in both** `plugin.json` and the marketplace entry. Bump it on every release — a pinned version ships no commits until the string moves.
- `${user_config.*}` is rejected in any field that runs through a shell. Hooks use exec form with `args` and read `CLAUDE_PLUGIN_OPTION_*` from the environment.
- Hooks must never block session start: 150ms hard cap, cache-only, no network.

## Security invariants

These are non-negotiable and each has a task marked 🔒 in `docs/04-tasks.md`:

- **Secret export fails closed.** If a detected secret can't be safely templated to `${VAR}`, the export fails unless `--allow-secrets` is passed. Detection is the union of three heuristics (known prefixes, Shannon entropy, shape matching). CI runs a 200-config fuzz corpus; any leak fails the build.
- **Never exported:** `.credentials.json`, `plugins/cache/`, `sessions/`, `history.jsonl`, `todos/`, `statsig/`, shell snapshots. Machine-specific values (`env.*`, model endpoints, Bedrock/Vertex config, absolute paths) are held back into `machines/<host>.json`, not shared.
- **Claude may not apply remote bundles.** Importing installs plugins and registers MCP servers — arbitrary code execution by design. Skills expose `--dry-run` only; `--apply` from a remote source always requires a user turn and interactive confirmation, with no `--yes` escape. This is a prompt-injection boundary: a bundle URL arriving via a fetched page or MCP tool result must never become an installed plugin.
- **No mutation without a dry-run plan and a snapshot.** Plans disclose every executable surface in full — each MCP server's exact `command`/`args`, each plugin's source URL and pinned SHA, every hook. No collapsing behind "12 actions."
- Zero telemetry. `--offline` guarantees zero egress and is asserted in tests.

## Conventions

- **Reference task IDs in commits.** They're stable: `feat(P2): T2.4 — flag stale pins`.
- Task markers in `docs/04-tasks.md`: ⛔ blocker · 🔬 spike · 🔒 security-critical · 📏 hard acceptance number. A phase ships only when all 📏 numbers are met, all 🔒 tasks have tests, `claude plugin validate . --strict` passes, the 3-platform CI matrix is green, and `--json` matches the versioned schema.
- Naming: working name `ccatlas` is a find-and-replace away from anything else; nothing in the design depends on it. Avoid "Claude" in any product name (trademark friction, implies official status) — the `cc` prefix sidesteps it.
