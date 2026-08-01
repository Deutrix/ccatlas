# Changelog

## 0.5.0 — unreleased

First feature-complete build. Six commands, all verified against a real
machine rather than only against fixtures.

### Commands

- `status` — what is installed, from where, and whether the CLI and the config
  files agree. `--project <path>` scopes it to one repo.
- `doctor` — findings with a severity, a cause and the exact fix command, plus
  an explicit list of checks that did **not** run.
- `updates` — version differences, marketplace staleness, and **stale pins**.
- `usage` — invocation counts and `--unused`, the prune list.
- `report` — a self-contained HTML report, `--redact` before sharing.
- `export` / `import` / `rollback` — portable bundles, dry-run by default.

### The finding that motivates the project

A **stale pin** is a plugin whose version string has not moved while the
source it points at has. `/plugin update` reports *already at the latest
version* and the user keeps running old code. On the development machine, 2 of
5 installed plugins were in this state.

It turned out to be detectable with **zero network access**: the marketplace
clone already on disk carries each entry's `source.sha`, and
`installed_plugins.json` carries the `gitCommitSha` that actually landed.

### Security posture

- Export **fails closed** — a credential that cannot be templated to `${VAR}`
  refuses the export rather than warning.
- **Claude may never apply a remote bundle.** No trusted host, flag or setting
  changes this. There is no `--yes`.
- `report --redact` and `--all-projects` protect paths, and the latter refuses
  to run without redaction.
- Zero telemetry. `--offline` guarantees zero egress.

### Known limitations

- End-to-end `status` is ~2s, essentially all of it `claude` subprocess time.
- `report --all-projects` re-collects per project; slow on many projects.
- Four doctor checks are blocked on data Claude Code does not expose. They are
  listed in the command's own output rather than silently skipped.
- Token costs are estimates from Claude Code's estimator, which falls back
  silently across regimes ~40% apart. Every surface says so.
