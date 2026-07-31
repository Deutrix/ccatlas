# ccatlas

> **Design stage — no working features yet.** The repo currently contains the
> design documents under [`docs/`](./docs) and the build scaffold landed by
> `T0.8`. `ccatlas --version` and `ccatlas --json` exist only to prove the
> toolchain. Nothing inventories anything yet.

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

## Design principles

- **Local-first.** Zero telemetry. `--offline` guarantees zero egress.
- **Zero runtime dependencies.** `node:*` only, shipped as a single bundled
  file. Installed plugins are copied into `~/.claude/plugins/cache`; a
  `node_modules` tree there would force a `SessionStart` install dance.
- **Official CLI first.** Every fact comes from `claude … --json` where such a
  command exists. File parsing is a *labelled* fallback — every record carries
  `source: "cli" | "file"`.
- **Read-only collectors.** All mutation shells out to the `claude` CLI.
  ccatlas never writes into `~/.claude/plugins/` itself.
- **`--json` everywhere**, against a versioned schema.
- **macOS, Linux and Windows** — no POSIX path assumptions anywhere.

## Install

Three paths, all supported (see [`docs/01-prd.md`](./docs/01-prd.md) §6).

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
npm test            # node:test against the built binary
```

`npm run build` emits an extensionless `bin/ccatlas`. Node resolves an
extensionless entry point's module type from the nearest `package.json`, so
`"type": "module"` is load-bearing — do not remove it.

## Documentation

| Document | Contents |
|---|---|
| [`docs/01-prd.md`](./docs/01-prd.md) | What and why |
| [`docs/02-architecture.md`](./docs/02-architecture.md) | How, plus every hard constraint |
| [`docs/03-diagrams.md`](./docs/03-diagrams.md) | The same, as mermaid |
| [`docs/04-tasks.md`](./docs/04-tasks.md) | The work, with stable task IDs |

## License

MIT © Deutrix
