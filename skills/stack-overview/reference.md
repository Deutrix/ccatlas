# `status --json` field reference

Loaded on demand. Nothing here costs always-on context.

## Envelope

| Field | Meaning |
|---|---|
| `schemaVersion` | `1`. Branch on it before reading `data`. |
| `command` | which command produced this |
| `warnings[]` | structured; each has `code`, `message`, optional `subject` and `collector` |
| `data` | the payload |

## `data`

| Field | Notes |
|---|---|
| `scope` | `{kind:"global"}` or `{kind:"project",path}`. **Check first.** |
| `plugins[]` | see below |
| `marketplaces[]` | `distribution` is `git \| gcs \| local \| unknown` |
| `mcpServers[]` | `connection` is `connected \| failed \| needs-auth \| pending-approval \| unknown` |
| `skills[]` `agents[]` `commands[]` | `state:"shadowed"` means it never loads |
| `shadowing[]` | `{kind,name,effective,shadowed[]}` — both winner and losers |
| `degraded[]` | collector sections that **failed**. Empty ≠ nothing installed. |
| `partial[]` | succeeded, knowingly incomplete |
| `sections[]` | per-collector status and cost, what `--verbose` renders |

## A plugin

| Field | Notes |
|---|---|
| `id.name` | `<plugin>@<marketplace>` — the identity |
| `id.scope` | keyed `(name, scope)`; one plugin can hold two scopes |
| `enabled` | lives in `settings.enabledPlugins`, not the plugin file |
| `sources[]` | `["cli","file"]` means both layers saw it |
| `reconciled` | present **only** when the layers disagreed; holds both values |
| `version.version` | literal `"unknown"` is valid and meaningful |
| `version.versionSource` | `plugin-json \| marketplace-entry \| marketplace-source-sha \| unknown` |
| `version.sourceSha` | install coordinate — what a reinstall fetches |
| `version.installedSha` | drift evidence — what is on disk |
| `version.doubleDeclared` | set only when two declarations **differ** |

## Warning codes

`collector-failed` · `partial` · `reconciliation` · `shadowed` ·
`path-collision` · `unverified-estimate` · `unsupported-version`

## Rules

- A `degraded` section is **unavailable**, never `0`.
- Never sum `cost.alwaysOn` across entities — above the listing cap they rank
  but do not add, and `nonAdditive:true` marks it.
- `reconciliation` means both values are kept; report both.
