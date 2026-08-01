# Bundle and trust reference

## 🔒 Trust rules

| Actor | Source | May apply? |
|---|---|---|
| Claude | remote | **never** — no host, flag or setting changes this |
| Claude | local | yes |
| human | remote, untrusted host | no — dry-run only |
| human | remote, trusted host | yes, **with interactive confirmation** |
| human | local | yes |

There is no `--yes`. A confirmation that can be pre-answered is not one.

Classification fails safe: a UNC path is **remote**; `https://github.com@evil.tld/`
resolves to `evil.tld`; `evil-github.com` never matches a trusted `github.com`.

## Never exported

`.credentials.json` · `sessions/` · `history.jsonl` · `todos/` · `statsig/` ·
`plugins/cache/` · `projects/` · shell snapshots · `~/.claude.json` `projects`
map · `@inline` sideloads.

`--allow-secrets` does **not** unlock these.

## Held back to `machines/<host>.json`

`env.*`, model endpoints, Bedrock/Vertex config, absolute paths.

## Bundle shape

`schemaVersion` · `kind:"ccatlas.bundle/1"` · `manifest` · `marketplaces[]` ·
`plugins[]` · `mcpServers{}` · `settings{}` · `files[]` · `project?` ·
`secretsRequired[]` · `signature` · `integrity`.

Both SHAs are carried and do different jobs: `sourceSha` is the install
coordinate, `installedSha` is drift evidence.

`manifest.estimatorRegime` of `fallback` or `unknown` means the cost figures
must **not** be presented as authoritative.

## Export failure

An untemplatable credential **refuses** the export. A value in
`env.GITHUB_TOKEN` templates to `${GITHUB_TOKEN}`; one embedded in a
connection URL has no name and cannot be templated. Relay the refusal.
