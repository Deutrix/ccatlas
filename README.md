# ccatlas

Inventory, freshness, usage ROI, and portability for your Claude Code stack.

`ccusage` is the accountant for your tokens. ccatlas is the package-manager
dashboard: **what you have** (marketplaces, plugins, skills, agents, commands,
hooks, MCP/LSP servers), **whether it's current**, **whether it earns its
context**, and **how to move it** to another machine.

## Why

Claude Code resolves a plugin's version from the first of four rules, and which
rule fired changes what "update" means. Two failure modes follow, and no
existing tool surfaces either:

- **Stale pin** — the version came from a string, the source's HEAD has moved,
  so `/plugin update` reports "already at the latest version" while you keep
  running old code.
- **Double declaration** — `version` is set in both `plugin.json` and the
  marketplace entry; `plugin.json` wins silently and masks the marketplace bump.

ccatlas records **which rule fired** as `versionSource` on every plugin, which
is what makes both detectable.

## Commands

| Command | What it answers |
|---|---|
| `ccatlas status` | what is installed, from where, and whether it agrees with itself |
| `ccatlas doctor` | findings with a severity, a cause, and the exact command to fix it |
| `ccatlas updates` | version differences, stale pins, marketplace staleness |
| `ccatlas usage` | what you actually invoke, and what you never do |
| `ccatlas report` | a self-contained HTML report you can send to someone |
| `ccatlas export` | a portable bundle of this stack |
| `ccatlas import` | plan an import; `--apply` performs it |
| `ccatlas rollback` | restore the last snapshot |

Every command takes `--json` against a versioned schema. **Skills consume the
JSON, never the tables** — the table layout is not a contract.

Useful flags: `--cached` (read the recorded answer, don't collect), `--offline`
(guaranteed zero egress), `--project P`, `--verbose` (per-section timings),
`--check` (exit 1 when there is something to act on, for CI).

### As a plugin

Slash commands `/stack`, `/stack-doctor`, `/stack-updates`, `/stack-usage` and
`/stack-report`, plus three skills — `stack-overview`, `stack-audit`,
`stack-migrate`. The always-on cost of all of it is **~464 tokens against a
600 ceiling**, enforced as a blocking CI gate rather than a claim; bulk
instructions live in on-demand `reference.md` files that cost nothing until
read.

There is **no bundled MCP server, by design**. It would add tool schemas to
every turn — self-defeating for a tool whose thesis is context-budget
discipline.

## Design principles

- **Local-first.** Zero telemetry. `--offline` guarantees zero egress and is
  asserted in tests.
- **Zero runtime dependencies.** `node:*` only, shipped as a single bundled
  file. Installed plugins are copied into `~/.claude/plugins/cache`; a
  `node_modules` tree there would force a `SessionStart` install dance.
- **Official CLI first.** Every fact comes from `claude … --json` where such a
  command exists. File parsing is a *labelled* fallback — every record carries
  `source: "cli" | "file"`. Where the two disagree ccatlas **reports the
  disagreement** rather than silently picking a winner.
- **Read-only collectors.** All mutation shells out to the `claude` CLI.
  ccatlas never writes into `~/.claude/plugins/` itself.
- **Fail independently.** One broken collector degrades one report section,
  never the run. A corrupt `~/.claude.json` must not take down `status`.
- **Empty ≠ broken.** A section with nothing in it says so, and never renders
  as a failure.
- **Estimates are labelled.** Invocation counts are exact; token costs are
  estimates, and are labelled as such on every surface.
- **macOS, Linux and Windows** — no POSIX path assumptions anywhere.

## Safety

Import installs plugins and registers MCP servers — arbitrary code execution by
design. The boundaries are therefore explicit:

- **Claude may not apply a remote bundle.** Skills expose `--dry-run` only.
  `--apply` from a remote source always requires a human turn with interactive
  confirmation, and **there is no `--yes` escape** — the option does not exist.
- **Export fails closed.** If a detected secret cannot be safely templated to
  `${VAR}`, the export fails unless `--allow-secrets` is passed. Detection is
  the union of three heuristics, fuzzed against a 200-config corpus in CI.
- **Never exported:** `.credentials.json`, `plugins/cache/`, `sessions/`,
  `history.jsonl`, `todos/`, `statsig/`, shell snapshots. Machine-specific
  values are held back into `machines/<host>.json`, not shared.
- **No mutation without a dry-run plan and a snapshot.** Plans disclose every
  executable surface in full — each MCP server's exact `command`/`args`, each
  plugin's source URL and pinned SHA. Nothing is collapsed behind "12 actions."

## Install

### Marketplace (primary)

```
/plugin marketplace add deutrix/claude-plugins
/plugin install ccatlas@deutrix
/reload-plugins
```

The marketplace entry uses an **npm source**, so the published package is the
single artefact behind both install paths.

### npm (standalone)

```sh
npm i -g ccatlas
# or
npx ccatlas@latest status
```

Works without Claude Code running — needed for CI checks and for inspecting a
machine where Claude Code won't start.

### Skills directory (development)

```sh
claude plugin init ccatlas      # scaffolds under ~/.claude/skills/ccatlas/
claude --plugin-dir ./ccatlas   # one-off testing
```

Loads as `ccatlas@skills-dir` with no marketplace and no install step.

## Development

Requires Node `^22.13.0 || >=24.0.0` — the range where `node:sqlite` is
available without a flag.

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run build       # esbuild -> bin/ccatlas (single minified ESM file)
npm test            # node:test, against the sources and the built binary
npm run leak-scan   # 🔒 fails the build on a leaked credential
node scripts/token-budget.mjs   # 📏 fails above 600 always-on tokens

node scripts/package.mjs                        # stage dist/plugin
claude plugin validate dist/plugin --strict     # validate the STAGED plugin
```

Validate `dist/plugin`, **not the repo root**. The root carries a `CLAUDE.md`
for developing ccatlas, which `--strict` correctly rejects as a plugin file and
which is not shipped. `plugin validate` also writes its errors to **stdout**
with an empty stderr, so the exit code is the only reliable signal.

`npm run build` emits an extensionless `bin/ccatlas`. Node resolves an
extensionless entry point's module type from the nearest `package.json`, so
`"type": "module"` is load-bearing — do not remove it.

Set `version` in **`plugin.json` and `package.json`, never in the marketplace
entry** — `tests/manifest-consistency.test.mjs` enforces both halves, because
the repo shipped a 0.0.0/0.5.0 mismatch that made `--version` misreport itself.
`npm run sync-version` copies the version across in a one-line edit.

Releasing is documented step by step in [`PUBLISHING.md`](./PUBLISHING.md).

### A note on the transcript adapter

`~/.claude/projects/**/*.jsonl` is undocumented and unstable. **Exactly one
module** parses it, behind a per-file schema probe: an unrecognised shape
yields `{ available: false, reason }` and degrades the usage section alone.

## Documentation

The design documents — PRD, architecture, diagrams and the execution ledger —
are **not published**. This repository ships the product, not the planning. The
reasoning that matters at the point of use is in the source: every non-obvious
decision is commented where it is made, and the invariants are stated at the
top of the module that enforces them.

## Status

All seven phases are feature-complete: **138 of 152 tasks**, 878 tests, with
typecheck, leak-scan, `claude plugin validate --strict` and the 600-token
budget all clean.

What remains, and why:

| Item | Why |
|---|---|
| SQLite analytics index | Deferred with a measured reason — a full 293k-line scan is ~16s, so incremental indexing is not yet earning its complexity |
| `ccusage` merge | Optional by design, never required |
| Four `doctor` checks | Blocked on data Claude Code does not expose. `doctor` says so in its own output rather than implying a clean bill of health |
| End-to-end `status` latency | ~2s against a 2s budget, essentially all `claude` subprocess time |

Not yet published to npm.

## License

MIT © Deutrix
