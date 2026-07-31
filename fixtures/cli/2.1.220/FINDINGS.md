# T0.1 — Official CLI JSON: captured fixtures and findings

**Claude Code 2.1.220 · win32 · captured 2026-07-31 · read-only. No plugin installed, updated, removed, enabled or disabled; nothing written under `~/.claude`; no git command run.**

Corpus caveat (carried from `docs/tasks.md`): 5 plugins, 4 marketplaces, 14 MCP servers, 161 personal skills. All four marketplaces are `source: "github"`. Every claim below is scoped to what that corpus can actually witness; source types not present locally are marked UNVERIFIABLE rather than guessed.

All fixtures in this directory are redacted: `<HOME>` = user home, `<TMP>` = agent scratchpad, `<USER>`, `<HOST>`, `<PROJECT-1>`. Both the long and 8.3 short (`…~1.…`) username forms and both plain and JSON-escaped (`\\`) path separators were rewritten. 40-hex git SHAs are deliberately **not** redacted — they are the load-bearing evidence for question 1, and they are public upstream commit identifiers, not credentials.

---

## 1. Command inventory — exit codes and behaviour

Every command completed non-interactively. **No command hung, prompted, or required a TTY.**

| Fixture | Command | Exit | stdout | stderr |
|---|---|---|---|---|
| `plugin-list.json` | `claude plugin list --json` | 0 | JSON array | empty |
| `plugin-list-available.json` | `claude plugin list --json --available` | 0 | JSON **object** | empty |
| `marketplace-list.json` | `claude plugin marketplace list --json` | 0 | JSON array | empty |
| `mcp-list.txt` | `claude mcp list` | 0 | text; health-checks each server (~40 s) | empty |
| `mcp-get-browsermcp.txt` | `claude mcp get browsermcp` | 0 | text (user stdio) | empty |
| `mcp-get-figma-dev-mode.txt` | `claude mcp get figma-dev-mode` | 0 | text (user http) | empty |
| `mcp-get-plugin-exa.txt` | `claude mcp get plugin:everything-claude-code:exa` | 0 | text (plugin http) | empty |
| `mcp-get-plugin-github.txt` | `claude mcp get plugin:everything-claude-code:github` | 0 | text (plugin stdio — **degraded**) | empty |
| `mcp-get-claude-flow.txt` | `claude mcp get claude-flow` | 0 | text (project, pending — degraded) | empty |
| `mcp-get-connector-gmail.txt` | `claude mcp get "claude.ai Gmail"` | 0 | text (connector — degraded) | empty |
| `mcp-get-missing.*` | `claude mcp get no-such-server-xyz` | **1** | empty | error + truncated server list |
| `plugin-details-{figma,frontend-design,superpowers,ui-ux-pro-max,everything-claude-code}.txt` | `claude plugin details <name>` | 0 | text | empty |
| `plugin-details-notinstalled.*` | `claude plugin details 42crunch-api-security-testing` | **1** | **error text on stdout** | empty |
| `plugin-list-plugin-dir-before.json` | `claude --plugin-dir <dir> plugin list --json` | 0 | JSON array incl. sideload | empty |
| `plugin-list-plugin-dir-mid.*` | `claude plugin list --plugin-dir <dir> --json` | **1** | empty | `error: unknown option '--plugin-dir'` |
| `plugin-list-plugin-dir-after.*` | `claude plugin list --json --plugin-dir <dir>` | **1** | empty | `error: unknown option '--plugin-dir'` |
| `plugin-validate.txt` | `claude plugin validate <dir>` | 0 | text, "passed with warnings" | empty |
| `plugin-validate-strict.txt` | `claude plugin validate <dir> --strict` | **1** | text, "Validation failed" | empty |
| `marketplace-manifest-excerpt.json` | *(file read, not a command)* | — | evidence for Q1 | — |

`marketplace-manifest-excerpt.json` is the one non-stdout artifact: a derived excerpt of `<installLocation>/.claude-plugin/marketplace.json` plus the marketplace-level SHA sidecars. It is included because it carries the answer to question 1 and no CLI command surfaces the same data.

### Parsing hazards

1. **`plugin details` writes its "not found" error to stdout and exits 1**, leaving stderr empty. A collector keying "did it work?" off stderr will parse the sentence `Plugin "x" not found…` as if it were details output. **Check the exit code, not stderr.**
2. **`plugin details` header is `<name> <version>` — but a bare `<name>` when the version is `unknown`** (`plugin-details-frontend-design.txt` line 1 is just `frontend-design`). Do not split the header and assume two tokens.
3. `mcp get <missing>` truncates its own server list (`… (and 5 more …)`), so stderr is not a reliable enumeration source.
4. `mcp list` live-health-checks every server. ~40 s across 14 here; latency scales with the slowest unreachable server. It is not a cheap call.

---

## 2. Per-command key inventory (observed field names and types)

### `plugin list --json` — top level is a JSON **array**

| Key | Type | Notes |
|---|---|---|
| `id` | string | `"<plugin>@<marketplace>"`. **The marketplace appears only in this suffix — there is no `source`/`marketplace` field.** Split on the last `@`. |
| `version` | string | Literal `"unknown"` when unresolved (`frontend-design`). Not null, not absent. |
| `scope` | string | `"user"` observed; `"session"` for `--plugin-dir` sideloads. |
| `enabled` | boolean | |
| `installPath` | string | Absolute, native separators (`\\` on Windows). |
| `installedAt` | string | ISO 8601 Z. **Absent on sideloads.** |
| `lastUpdated` | string | ISO 8601 Z. **Absent on sideloads.** |
| `mcpServers` | object | **Optional** — present on 2 of 5. Map of server name → MCP config (`{command,args}` or `{type:"http",url}`). Not namespaced; the `plugin:<plugin>:<server>` form appears only in `mcp list`. |

**Absent:** no `sha`, no `commit`, no `versionSource`, no `resolvedVersion`, no `source`, no `description`, no `marketplace`, no `installLocation`. This confirms the pre-check's key list exactly.

### `plugin list --json --available` — top level is a JSON **object**, not an array

```
{ "installed": [ …same schema as plugin list… ], "available": [ …different schema… ] }
```

`available[]` (276 rows here):

| Key | Type | Presence | Notes |
|---|---|---|---|
| `pluginId` | string | 276/276 | Named `pluginId`, **not** `id` — different key from `installed[]`. |
| `name` | string | 276/276 | |
| `description` | string | 276/276 | |
| `marketplaceName` | string | 276/276 | Explicit here, unlike `installed[]`. |
| `source` | string **or** object | 276/276 | Union type. See below. |
| `version` | string | **14/276** | Only where the marketplace entry itself declares one. |
| `installCount` | number | 247/276 | Undocumented in §3.1. Upstream popularity counter. |

`source` variants observed:

| Form | Rows | Keys |
|---|---|---|
| string | 55 (across 53 distinct relative paths) | e.g. `"./"`, `"./plugins/clangd-lsp"`, `"./external_plugins/asana"` |
| object | 78 | `source:"git-subdir"` + `url` + `path` + `ref` + `sha` |
| object | 140 | `source:"url"` + `url` + `sha` |
| object | 2 | `source:"github"` + `repo` + `sha` |
| object | 1 | `source` + `url` + `path` + `sha` (no `ref`) |

**221/276 available rows carry `source.sha`.** All string-form (relative-path) sources carry none.

### `plugin marketplace list --json` — JSON array

| Key | Type | Presence |
|---|---|---|
| `name` | string | 4/4 |
| `source` | string | 4/4 — all `"github"` here |
| `repo` | string | 4/4 — `owner/name` |
| `installLocation` | string | 4/4 — absolute path |

No `url`, `path`, `ref`, `sha`, `lastUpdated`, or auto-update flag. `known_marketplaces.json` on disk carries a `lastUpdated` that this command drops.

### `mcp list` — line-oriented text

Header `Checking MCP server health…`, blank line, then one line per server:

```
<name>: <transport-summary> - <status-glyph> <status-text>
```

Transport summary is `<command> <args…>` for stdio or `<url> (HTTP)` for http — **except** for `claude.ai` connectors and plugin http servers, where the bare URL appears with no `(HTTP)` suffix. Statuses observed: `✔ Connected`, `✘ Failed to connect — <error>`, `! Needs authentication`, `⏸ Pending approval (run claude to approve)`. Plugin-provided servers display as `plugin:<plugin>:<server>`.

### `mcp get <name>` — indented key/value text, **fields vary by server kind**

| Field | user stdio | user http | plugin http | plugin stdio | project pending | claude.ai connector |
|---|---|---|---|---|---|---|
| `Scope` | ✅ `User config…` | ✅ | ✅ `Dynamic config (from command line)` | ✅ same | ✅ `Project config (shared via .mcp.json)` | ✅ `claude.ai config` |
| `Status` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `Issue` | ✅ on failure | ✅ on failure | — | — | — | — |
| `Type` | ✅ `stdio` | ✅ `http` | ✅ `http` | ❌ **absent** | ❌ absent | ❌ absent |
| `Command` / `URL` | ✅ | ✅ | ✅ | ❌ **absent** | ❌ absent | ❌ absent |
| `Args`, `Environment` | ✅ (empty) | — | — | — | — | — |
| `To remove this server…` | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |

### `plugin details <name>` — sectioned text

Sections in order: header (`<name> [<version>]`, indented description, `Source: <pluginId>`), `Component inventory` (`Skills (n)  a, b, c` / `Agents (n)` / `Hooks (n)` / `MCP servers (n)  <names>  (tool schemas resolved at runtime; not counted)` / `LSP servers (n)`), `Projected token cost` (`Always-on:   ~N tok   added to every session`), `Per-component (rounded)` fixed-width table (`component | always-on | on-invoke`, values like `~90` / `~9.7k` / `~17.2k`), then two disclaimer lines. **No SHA, no install path, no marketplace source URL anywhere in `details`.**

### `plugin validate <path> [--strict]`

Prints `Validating plugin manifest: <abs path to .claude-plugin/plugin.json>`, then `⚠ Found N warning(s):` with `❯ <field>: <message>` bullets, then a verdict line. `--strict` changes only the verdict and exit code (`✔ Validation passed with warnings` / 0 → `✘ Validation failed (--strict treats warnings as errors)` / 1) — the warning list is identical. All output on stdout; stderr empty in both modes.

---

## 3. The five questions

### Q1 (PRD open question 1) — does `--available` expose a resolved SHA or a version-resolution method that plain `list` lacks?

**The pre-check's key list is CONFIRMED for plain `list`. Its negative is REFUTED for `--available`. And the conclusion drawn from it — "T2.4 must route through `git ls-remote` + `installLocation`" — is CORRECTED. Read this section before planning T2.4 or T2.2.**

**(a) Plain `plugin list --json` has no SHA and no version-resolution method.** Exactly the eight keys the pre-check named. Full-text search of the fixture for `versionSource`, `resolvedVersion`, `gitRef` → zero hits. CONFIRMED.

**(b) `--available` *does* expose a resolved commit SHA — but only for plugins you have *not* installed.** 221 of 276 `available[]` rows carry `source.sha`:

```json
{ "pluginId": "adobe-for-creativity@claude-plugins-official",
  "source": { "source": "git-subdir", "url": "https://github.com/adobe/skills.git",
              "path": "plugins/creative-cloud/adobe-for-creativity",
              "ref": "main", "sha": "17ef6fb53d2eb23158dec11823ff569258b7a26e" } }
```

But `available[]` is filtered to exclude everything already installed. All five installed ids checked against the 276 available ids: **0 of 5 present.** `figma@claude-plugins-official` is absent even though `claude-plugins-official` contributes 273 rows. So `--available` alone cannot give the upstream SHA of a plugin you actually have — the only case F2 cares about. A "read the SHA off `--available`" design would work for every plugin **except** the installed ones, and would fail silently.

**(c) The same SHA *is* reachable locally for installed plugins.** The `available[]` filter is a display filter, not a data limit. `installLocation` points at `<HOME>\.claude\plugins\marketplaces\<mkt>`, whose `.claude-plugin/marketplace.json` is the **full** catalog — 276 entries for `claude-plugins-official`, **223 carrying `source.sha`, installed plugins included**:

```json
"figma":       { "source": { "source": "url", "url": "https://github.com/figma/mcp-server-guide.git",
                             "sha": "ef474d181a6eca44b37722f839e8a7eb58d644ec" } }
"superpowers": { "source": { "source": "url", "url": "https://github.com/obra/superpowers.git",
                             "sha": "44c9b2d6e889982ac18c27d05a19fefe335194e1" } }
```

(`marketplace-manifest-excerpt.json`.) The upstream-side SHA for an installed plugin is a **local file read**, not a network call.

**What this means for T2.4 and T2.2, stated explicitly.**

- **T2.2 is load-bearing — confirmed, but for a different reason than assumed.** `installLocation` is required, not as a route to `git ls-remote`, but as the path to the local `marketplace.json` that carries `sha`, `url`, `ref` and `path` per plugin. That makes T2.2 a **file read**, not a git operation.
- **`git ls-remote` is demoted from required to optional.** It is no longer needed to *obtain* a SHA. It is needed only to answer "is the SHA the marketplace recorded still upstream HEAD?", because the manifest is only as fresh as the marketplace's last refresh (`known_marketplaces.json.lastUpdated`; `claude-plugins-official` was refreshed the same morning as capture). Both `url` and `ref` come from the local manifest, so **no clone is needed for that call either**. Refreshing the marketplace would achieve the same but is a write, so ccatlas must not.
- **The hard limit that shapes what F2 can claim.** The SHA the *installed copy was built from* is **recorded nowhere on disk.** `<HOME>\.claude\plugins\cache\<mkt>\<plugin>\<version>\` is keyed by version string only; all five installed plugins were checked — no `.gcs-sha`, no `.sha`, no metadata sidecar. So ccatlas can say *"this plugin is pinned to a version string while its source is tracked by SHA"* and *"the marketplace's recorded SHA is/is not upstream HEAD"*. It **cannot** say *"your copy is N commits behind"* without a network fetch. F2's diagnostic should be worded against what is knowable.

### Q2 — do `--plugin-dir` sideloads appear, and does flag position change the result?

**Verdict: yes they appear, and position is decisive.** `--plugin-dir` is a **global** flag on `claude`, not an option of `plugin list` — `claude plugin list --help` lists only `--available`, `--json`, `-h`.

| Invocation | Result |
|---|---|
| `claude --plugin-dir <dir> plugin list --json` | exit 0, **6 entries** — sideload included |
| `claude plugin list --plugin-dir <dir> --json` | exit **1**, `error: unknown option '--plugin-dir'`, empty stdout |
| `claude plugin list --json --plugin-dir <dir>` | exit **1**, `error: unknown option '--plugin-dir'`, empty stdout |

Both wrong positions are **hard failures, not silent omissions** — a collector that gets the order wrong crashes rather than under-reporting. That is the safe failure mode, and it is worth preserving in ccatlas's own CLI.

The sideload record is distinguishable two independent ways:

```json
{ "id": "ccatlas-probe@inline", "version": "0.0.1-probe",
  "scope": "session", "enabled": true, "installPath": "<TMP>\\sideload\\ccatlas-probe" }
```

- `id` suffix is **`@inline`** — a reserved pseudo-marketplace (binary: `var kHe="inline"`).
- `scope` is **`"session"`**, and `installedAt` / `lastUpdated` / `mcpServers` are all **absent**.

Tested with a throwaway plugin (`.claude-plugin/plugin.json` + one skill) created in the agent scratchpad, never installed, never registered.

### Q3 — does `marketplace list --json` return `repo`/`url`/`path`/`ref` per source type, and is `installLocation` **always** present?

**Partially — and the §3.1 claim appears misattributed.**

Observed 4/4: `{name, source, repo, installLocation}`. All four marketplaces are `source: "github"`, so `repo` is right for that type. **No `ref` appears even for github.** `url` and `path` cannot be observed because no `url` / `git-subdir` / local marketplace exists here → UNVERIFIABLE for those types.

The key set §3.1 describes *does* exist — but on the **plugin `source` objects** inside `available[]` and inside the on-disk `marketplace.json` (`git-subdir` → `url`+`path`+`ref`+`sha`; `url` → `url`+`sha`; `github` → `repo`+`sha`). §3.1 attributed the plugin-source schema to marketplace rows. A collector written to that row will look for `ref` on marketplace records and never find it.

**Is `installLocation` always present?** Present 4/4 — but n=4, all github. "Always" is unsupported for other source types. **T2.2 should treat a missing `installLocation` as a degraded case rather than assuming it.**

**And `installLocation` is not always a git clone.** 3 of 4 marketplaces have a real `.git` (HEAD SHAs read from `.git/HEAD` → ref file: `anthropic-agent-skills` `b29e7cf6…`, `everything-claude-code` `656cf4c9…`, `ui-ux-pro-max-skill` `4255c218…`). **`claude-plugins-official` has no `.git` at all** — it is a GCS snapshot with a `.gcs-sha` sidecar containing `c6e19310289232d8914e638af69268d75cb30c5d`. Any collector that shells out to git against `installLocation` fails on the largest and most important marketplace. Read `.git/HEAD` → ref file **and** fall back to `.gcs-sha`; both are plain file reads, so T2.2 need not invoke git at all.

### Q4 — are `@skills-dir` plugins included in `plugin list --json`, and how are they distinguished?

**UNVERIFIABLE on this corpus — there are zero `@skills-dir` plugins to include.** The mechanism is nonetheless pinned down, and the practical consequence for ccatlas is unambiguous.

`plugin list --json` returns 5 ids, all `<name>@<marketplace>`; none ends in `@skills-dir`. Yet `~/.claude/skills/` holds **161 directories**, every one a bare `SKILL.md` with **no `.claude-plugin/plugin.json`** (`find … -name plugin.json` → no matches).

From the 2.1.220 binary, `skills-dir` is a reserved sentinel alongside `inline`:

- `var kHe="inline", B0="skills-dir"`
- `Marketplace name "skills-dir" is reserved for plugins auto-loaded from .claude/skills/`
- `claude plugin init <name>` — *"Scaffold a new plugin at ~/.claude/skills/<name>/ (auto-loads next session as `<name>@skills-dir`)"* — the scaffold writes a **manifest**, and that is what makes the folder a plugin.
- A third sentinel, **`@synced`**, also exists: `e.source.endsWith("@inline") || …("@synced") || …("@skills-dir")`. Purpose unknown; not mentioned anywhere in the docs.

So: a `~/.claude/skills/<name>/` folder becomes an `@skills-dir` **plugin** when it carries a plugin manifest; a bare `SKILL.md` folder loads as a **skill** and never appears in `plugin list --json`. Distinguished by the reserved `@skills-dir` id suffix, same mechanism as `@inline`. Confirming the inclusion claim needs a machine that has one — flagged as a corpus gap.

**The downstream consequence is the real finding:** on a machine shaped like this one, `plugin list` sees **0 of 161** personal skills.

### Q5 (cross-check requested by lead — corroborating t05's `ui-ux-pro-max` version conflict from the CLI side)

**Corroborated, and it upgrades §3.3's masking claim from UNVERIFIABLE to CONFIRMED.** t05 found `ui-ux-pro-max` declaring 2.5.0 in `plugin.json` and 2.2.1 in its marketplace entry. Four version-bearing fields exist for this one plugin, and the CLI resolves them as follows:

| Source | Value |
|---|---|
| `marketplace.json` → `metadata.version` (marketplace-level, **not in §3.3**) | `2.2.1` |
| `marketplace.json` → `plugins[].version` (the marketplace **entry**, §3.3 rule 2) | `2.2.1` |
| `<installPath>/.claude-plugin/plugin.json` → `version` (§3.3 rule 1) | `2.5.0` |
| `<installPath>/skill.json` → `version` (sibling manifest, **not in §3.3**) | `2.5.0` |
| **`claude plugin list --json` surfaces** | **`2.5.0`** |
| Install cache directory name | `2.5.0` |

`ui-ux-pro-max` is not in `available[]` (it is installed), so `--available` adds nothing here.

Two conclusions:

1. **§3.3's "Both `plugin.json` and marketplace entry set → `plugin.json` wins silently" is CONFIRMED with a real divergent instance.** It was UNVERIFIABLE from `everything-claude-code` alone, where both sources agree at `1.9.0`. `ui-ux-pro-max` settles it: `2.5.0` wins, `2.2.1` is masked, and **nothing in any CLI output reveals that a second, different value exists**. This is precisely the F2 pinning pathology in the wild, and it is *only* detectable by reading both files — never from the CLI.
2. **§3.3's list of version sources is incomplete.** `metadata.version` and `skill.json.version` are two further version-bearing fields. Here they agree with their same-file neighbours, so their precedence is untested — but a collector that reports "the version" without saying *which of four fields it read* produces an unfalsifiable number. **ccatlas should record all version-bearing fields it finds and flag disagreement**, which is a strictly larger job than recording `versionSource` as a single enum.

---

## 4. Row-by-row reconciliation against `docs/02-architecture.md` §3.1

**§3.1: 10 rows — 4 CONFIRMED · 4 CORRECTED · 1 PARTIAL · 1 UNVERIFIABLE.**

| §3.1 row | Claim | Verdict | Evidence / what is actually true |
|---|---|---|---|
| `plugin list --json` | "name, version, source marketplace, enabled state" | **CORRECTED** | No `name`, no `source`/marketplace field. Actual: `id` (`<name>@<marketplace>` — split on last `@`), `version`, `scope`, `enabled`, `installPath`, `installedAt`, `lastUpdated`, optional `mcpServers`. |
| `plugin list --json` | "includes `@skills-dir` plugins" | **UNVERIFIABLE** | Zero `@skills-dir` plugins exist here (161 bare `SKILL.md` dirs, none with a manifest), so the inclusion claim has no positive instance either way. Mechanism confirmed from the binary. See Q4. |
| `plugin list --json` | "excludes `--plugin-dir` sideloads unless the flag precedes the subcommand" | **CONFIRMED** | Flag before → included as `@inline` / `scope:"session"`. Flag after or mid → exit 1, `unknown option`. The doc's wording is exactly right. |
| `plugin list --json --available` | "the above **plus** available plugins from marketplaces" | **CORRECTED** | Not a superset — a different **shape**. Top level becomes `{installed, available}` (object, not array); `available[]` has a *different schema* (`pluginId` not `id`; adds `description`, `marketplaceName`, `installCount`, union-typed `source`). Code treating it as an extended array breaks on the array→object change. Also: `available[]` **excludes installed plugins** (0/5 present). Also: `--available` requires `--json`. |
| `plugin details <name>` | "component inventory (skills, agents, hooks, MCP, LSP) + always-on and on-invoke token cost; text output" | **CONFIRMED** | All five categories present with those exact labels, plus `Always-on` and a per-component `always-on`/`on-invoke` table. Two parsing caveats to add: header omits the version when it is `unknown`; the not-found error goes to **stdout** with exit 1. |
| `plugin marketplace list --json` | "name, source, `installLocation`, plus `repo`/`url`/`path`/`ref` per source type" | **PARTIAL** (misattributed) | `name`, `source`, `repo`, `installLocation` confirmed 4/4 (all github). `ref` **absent even for github**; `url`/`path` unobservable (no such marketplace locally). The `repo`/`url`/`path`/`ref`-by-source-type schema is real but belongs to **plugin `source` objects**, not marketplace rows. |
| `plugin marketplace list --json` | "`installLocation` gives the local clone for SHA reads" | **CORRECTED** | Present 4/4, but only 3/4 are git clones. `claude-plugins-official` has **no `.git`** — GCS snapshot with a `.gcs-sha` sidecar. Read `.git/HEAD`→ref **or** `.gcs-sha`; never assume git, and never shell out to git. |
| `mcp list` | "configured MCP servers + connection status; includes `Pending approval` for project-scope servers" | **CONFIRMED** | 14 servers, 4 status kinds incl. `⏸ Pending approval` on the project-scope `claude-flow`. Caveat: live health check on every server, ~40 s here. |
| `mcp get <name>` | "per-server detail" | **CORRECTED** (claim too weak) | Field set **varies by server kind**. Plugin-scoped **stdio** servers return `Scope`+`Status` and **no `Type`/`Command`** — while plugin-scoped **http** servers do return `Type`/`URL`. Pending-approval servers and `claude.ai` connectors also return `Scope`+`Status` only. `mcp get` is not a complete per-server detail source. |
| `plugin validate <path> --strict` | "manifest/frontmatter/hooks validation" | **CONFIRMED** | Validates `<path>/.claude-plugin/plugin.json`; `--strict` promotes warnings to exit 1 without changing the warning list. Only manifest warnings were exercised (probe has one skill, no hooks) — frontmatter/hooks validation untested, not disproved. |

### §3.3 version resolution — 4 CONFIRMED · 1 CORRECTED

| §3.3 rule | Verdict | Evidence |
|---|---|---|
| 1. `version` in the plugin's `plugin.json` | **CONFIRMED** | `figma`: `plugin.json` has `2.2.87`; marketplace entry has no `version` but does have a `sha`. Resolved: `2.2.87` → rule 1 beats rule 3. |
| 2. `version` in the marketplace entry | **CONFIRMED** | The 14 `available[]` rows with `version` are exactly those whose marketplace entries declare one (e.g. `clangd-lsp` `1.0.0`, source `./plugins/clangd-lsp`, no `plugin.json` version). |
| 3. git commit SHA for relative paths in a git-hosted marketplace | **CORRECTED** | `frontend-design`: source `./plugins/frontend-design` in a **github-hosted** marketplace, no `version` in either `plugin.json` or the marketplace entry → resolved to **`"unknown"`, not a SHA**. Rule 3 did not fire. Root cause: that marketplace is a GCS snapshot with no `.git`, so there is no commit to read — the marketplace's own SHA sits in `.gcs-sha` but is not used for version resolution. **Rule 3 may still hold for genuinely git-cloned marketplaces; untested, as no such plugin is installed here.** Do not rely on it either way. |
| 4. `unknown` | **CONFIRMED** | `frontend-design` → `"unknown"` (string literal, not null/absent); its cache dir is literally `…\frontend-design\unknown\`. |
| "Both set → `plugin.json` wins silently; flag it" | **CONFIRMED** | `ui-ux-pro-max`: `plugin.json` `2.5.0` vs marketplace entry `2.2.1`. CLI surfaces `2.5.0`; cache dir is `2.5.0`; `2.2.1` is masked with no CLI signal. See Q5. |

### Observed but absent from §3.1/§3.3 entirely

Reconciliation is bidirectional; these are real fields the architecture doc does not mention.

- `plugin list`: `scope`, `installPath`, `installedAt`, `lastUpdated`, `mcpServers` (nested, optional — a second, independent path to plugin-bundled MCP servers, and the **only** path to a plugin-scoped **stdio** server's command, since `mcp get` withholds it).
- `available[]`: `installCount` (247/276), `description`, `marketplaceName`, union-typed `source`.
- Sideloads: `scope: "session"` and the `@inline` pseudo-marketplace.
- Reserved pseudo-marketplace sentinels: `@inline`, `@skills-dir`, **`@synced`** (third one, purpose unknown, undocumented).
- Two further version-bearing fields (Q5): `marketplace.json` → `metadata.version`, and `<installPath>/skill.json` → `version`.
- On-disk marketplace manifest: top-level `renames` map (old plugin name → new), e.g. `{"adlc":"agentforce-adlc","convex-backend":"convex","wordpress.com":"build-with-wordpress"}`.
- `.gcs-sha` sidecar as a non-git marketplace SHA source.

---

## 5. Downstream impact

| Task | Change |
|---|---|
| **T2.4** (stale-pin diagnostic) | **Rescoped and cheaper than assumed.** `docs/tasks.md` line 70's "*must* go through `git ls-remote` + `installLocation`" is a **correction, not a confirmation**. Upstream `sha`+`url`+`ref` for **installed** plugins come from a local read of `<installLocation>/.claude-plugin/marketplace.json`. `git ls-remote` drops to an optional freshness check needing no clone. Hard limit: the SHA the installed copy was built from is not recorded on disk, so F2 can report "pinned by version string while the source is SHA-tracked" and "the marketplace's SHA is/isn't upstream HEAD", but **not** "you are N commits behind". |
| **T2.2** (reach a local clone to read HEAD) | **Still load-bearing, but reframed as a file read, not a git operation.** Its job is to locate `marketplace.json` via `installLocation`. For marketplace-level SHA it must handle both shapes: `.git/HEAD`→ref file, **and** `.gcs-sha` for GCS-snapshot marketplaces like `claude-plugins-official`. Do not shell out to git; do not assume `installLocation` is always present (n=4, all github). |
| **PRD open question 1** | **Answered** — see Q1. Nuanced yes: `--available` carries SHAs, but not for the plugins you have; the local marketplace manifest closes that gap. |
| **F2 pinning diagnostic / whichever task owns `versionSource`** | **Scope grew.** Q5 shows four version-bearing fields, not the two §3.3 implies, and a real live disagreement (`ui-ux-pro-max` 2.5.0 vs 2.2.1) invisible from the CLI. `versionSource` cannot be a single enum derived from CLI output — the collector must read `plugin.json`, the marketplace entry, `metadata.version` and `skill.json`, record all values found, and flag disagreement. |
| **Import / sync engine (§7)** | **New requirement: honour the `renames` map.** The on-disk marketplace manifest carries a top-level old-name→new-name table. A bundle written before an upstream rename references a plugin id no longer in the catalog; resolving through `renames` turns a hard "plugin not found" into a successful install. Not mentioned anywhere in the current docs. |
| **Skills inventory task** (owner of `~/.claude/skills`) | **Promote from fallback to primary.** `plugin list` sees 0 of 161 personal skills. §3.2's `~/.claude/skills/**/SKILL.md` row is the *only* enumeration path for them, so §1's "official CLI first, files as labelled fallback" principle needs an explicit carve-out — otherwise every personal skill is mislabelled `source: "file"` as a degraded mode when it is in fact the only mode. |
| **Any `--available` consumer** (updates report) | **Schema fix required.** Cannot be modelled as "array of plugin, sometimes more fields": object envelope, two distinct record types, `pluginId` vs `id`, and installed plugins absent from `available[]`. |
| **MCP collector** | **Must merge two sources.** `mcp get` withholds `Type`/`Command` for plugin-scoped **stdio** servers, pending-approval servers, and `claude.ai` connectors. Transport for plugin stdio servers exists only in `plugin list --json` → `mcpServers`. Record the server kind and tolerate the degraded shape rather than treating a missing `Type` as a parse error. |
| **T1.5 / any collector shelling `plugin details`** | Check the **exit code**, not stderr — the not-found error is written to stdout with an empty stderr. And do not assume the header carries a version token. |
| **Perf budgets (T1.11)** | `mcp list` cost ~40 s for 14 servers because it health-checks each one. If the inventory path calls it, the `<2s` budget is unreachable **regardless of corpus scale** — this is not a sub-scale-measurement caveat. Either make it opt-in or source MCP config from files + `plugin list`. |
| **`--plugin-dir` support** | Global flag; **must** precede the subcommand. Wrong position fails loudly (exit 1, empty stdout), so this is low-risk but mandatory. |
| **Corpus gap for the lead** | No `@skills-dir`, no `@synced`, no non-github marketplace, and no git-cloned-marketplace relative-path plugin exists here. Q4, the `url`/`path`/`ref` marketplace keys, and §3.3 rule 3 stay unsettled until a second machine or a synthetic fixture provides one. |
