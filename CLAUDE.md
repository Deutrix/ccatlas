# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

**All seven phases are feature-complete.** Eight commands run end to end against a real machine: `status`, `doctor`, `updates`, `usage`, `report`, `export`, `import`, `rollback`. 878 tests; typecheck, leak-scan, `claude plugin validate dist/plugin --strict` and the 📏 600-token budget are all blocking CI gates and all green.

Not published to npm. See the README's *Status* table for what remains and why.

**The design documents are not in this repository** — it ships the product, not the planning. The reasoning that matters at the point of use is in the source: every non-obvious decision is commented where it is made, and each module states the invariants it enforces at the top.

**The fixture corpus under `fixtures/` is the contract.** Every CLI JSON shape and transcript record shape was *observed*, not assumed — `fixtures/**/FINDINGS.md` records what was scanned and what was found. Do not write a parser against a shape that is not in the corpus; that is the single most likely way to waste a week here.

**Run the binary against a real machine after any detector change.** It has caught eight defects that no test did — a prune list recommending the deletion of a plugin used 22 times, a security-critical path unreachable from the arg parser, a 25% undercount from records dropped before a probe resolved. It is the cheapest check available.

## What ccatlas is

A local-first CLI + Claude Code plugin that inventories, audits, and makes portable a user's Claude Code extension stack (marketplaces, plugins, skills, agents, commands, hooks, MCP/LSP servers). Positioning: a package-manager dashboard for **extensions** — what you have, whether it is current, what you actually use, and how to move it. It reports **context** cost (roughly how many tokens an extension occupies every turn), never money. There is no billing data anywhere in it, and no telemetry; `ccusage` is the tool for what sessions cost in money.

Ships two ways from one artefact: npm package `ccatlas` (standalone) and plugin `ccatlas@deutrix` whose marketplace entry uses `source: npm`.

## Toolchain (scaffolded — `T0.8`)

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
node scripts/package.mjs                    # stage dist/plugin first
claude plugin validate dist/plugin --strict # manifest/frontmatter/hooks
node scripts/token-budget.mjs               # fail the build above 600 always-on tokens
```

Validate the **staged** plugin, not the repo root: the root carries this
`CLAUDE.md`, which `--strict` correctly rejects as a plugin file. Both commands
write errors to **stdout** with an empty stderr — the exit code is the only
reliable signal.

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

These are non-negotiable. Each has tests; none may be relaxed without replacing the guarantee it provides:

- **Secret export fails closed.** If a detected secret can't be safely templated to `${VAR}`, the export fails unless `--allow-secrets` is passed. Detection is the union of three heuristics (known prefixes, Shannon entropy, shape matching). CI runs a 200-config fuzz corpus; any leak fails the build.
- **Never exported:** `.credentials.json`, `plugins/cache/`, `sessions/`, `history.jsonl`, `todos/`, `statsig/`, shell snapshots. Machine-specific values (`env.*`, model endpoints, Bedrock/Vertex config, absolute paths) are held back into `machines/<host>.json`, not shared.
- **Claude may not apply remote bundles.** Importing installs plugins and registers MCP servers — arbitrary code execution by design. Skills expose `--dry-run` only; `--apply` from a remote source always requires a user turn and interactive confirmation, with no `--yes` escape. This is a prompt-injection boundary: a bundle URL arriving via a fetched page or MCP tool result must never become an installed plugin.
- **No mutation without a dry-run plan and a snapshot.** Plans disclose every executable surface in full — each MCP server's exact `command`/`args`, each plugin's source URL and pinned SHA, every hook. No collapsing behind "12 actions."
- Zero telemetry. `--offline` guarantees zero egress and is asserted in tests.

## Conventions

- **Reference task IDs in commits.** They're stable: `feat(P2): T2.4 — flag stale pins`.
- A change ships only when the 📏 hard numbers are met, the 🔒 security paths have tests, `claude plugin validate dist/plugin --strict` passes, the 3-platform CI matrix is green, and `--json` still matches the versioned schema.
- Naming: working name `ccatlas` is a find-and-replace away from anything else; nothing in the design depends on it. Avoid "Claude" in any product name (trademark friction, implies official status) — the `cc` prefix sidesteps it.
