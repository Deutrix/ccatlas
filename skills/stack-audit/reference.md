# Audit output reference

## Doctor finding codes

| Code | Severity | Means |
|---|---|---|
| `secret-in-config` | warning, **critical if committed** | plaintext credential |
| `plugin-install-path-missing` | critical | registered but files gone |
| `plugin-half-removed` | warning | in the registry, not in `plugin list` |
| `mcp-server-failed` | warning | configured, will not connect |
| `mcp-server-needs-auth` | info | connected, unauthenticated |
| `orphaned-cache-dir` | info | disk, not breakage |
| `orphaned-project` | info | `~/.claude.json` key whose directory is gone |
| `shadowed-entity` | warning | masked copy never loads |
| `reconciliation-conflict` | warning | CLI and registry disagree |
| `double-declared-version` | info | `plugin.json` masks the marketplace entry |
| `plugin-validate-failed` | warning | `validate --strict` failed on a local plugin |

`pending-approval` MCP servers are **never** findings — normal for a fresh clone.

## `skipped[]`

Checks that did not run, each with a reason. **Report these.** A clean report
over a run that skipped four checks is a clean bill of health it did not earn.
Four are permanently blocked on this corpus: LSP collisions, LSP binaries, MCP
zero-tools, and the always-on cost threshold.

## Updates

| Field | Notes |
|---|---|
| `stalePins[]` | **the differentiator.** `installedSha` ≠ entry `sourceSha` |
| `upgrades[]` | genuine — the entry is ahead |
| `entriesBehind[]` | the entry is **behind**; updating moves you backwards |
| `marketplaces[]` | `autoRefreshed:true` refreshes itself; its age means nothing |

## Usage

`{available:false, reason}` ⇒ **recommend nothing.**

`unused[].passiveCost` absent means unmeasured, not free. Rank by cost only
where one exists. Counts are exact; token figures are estimates.
