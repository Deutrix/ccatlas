# T0.5 — Fallback file shapes: findings

**Environment:** Claude Code 2.1.220, Windows 11, captured 2026-07-31.
**Corpus:** 4 marketplaces · 5 plugins · 7 cache version dirs · 102 project keys.
Valid for **shape** discovery. Not valid for prevalence or for the perf gates (see `docs/tasks.md` → Reference machine baseline).

> Authored by the `t05-file-shapes` agent; transcribed by the lead because a hook blocked the subagent's write. Fixtures in this directory are the agent's own.

---

## 1. The auto-update flag — 🔴 IT DOES NOT EXIST

**There is no such key.** No per-marketplace value to report, because no such field exists. Three independent checks:

| Check | Result |
|---|---|
| `known_marketplaces.json` entry keys | `source`, `installLocation`, `lastUpdated` — the complete key set on all 4 entries |
| `claude plugin marketplace list --json` | `name`, `source`, `repo`, `installLocation` — no auto-update field |
| `claude plugin marketplace add --help` | options are `--scope` and `--sparse` only |

**Naming trap.** A grep for `auto.?update` across `~/.claude/**.json` returns `settings.json → autoUpdatesChannel: "latest"` and `~/.claude.json → autoUpdates`. **Both govern the Claude Code CLI self-updater, not marketplaces.** An implementation that greps for "autoUpdate" will find them and report a confident wrong answer. Marketplace refresh is an explicit verb: `claude plugin marketplace update [name]`.

**Does `01-prd.md` §F2's claim hold?** Not as written — but the *posture* it describes is real, produced by two other mechanisms:

1. **Official is implicit, not flagged.** `known_marketplaces.json` has 4 entries; `settings.json.extraKnownMarketplaces` has 3. `claude-plugins-official` is auto-installed (`~/.claude.json → officialMarketplaceAutoInstalled: true`). Official is special-cased by **how it is registered**, not by a flag.
2. **`lastUpdated` shows it behaviourally:**

| Marketplace | `lastUpdated` | Age |
|---|---|---|
| `claude-plugins-official` | 2026-07-31T08:10:55Z | same day — self-refreshed at session start |
| `anthropic-agent-skills` | 2026-07-20 | 11 d |
| `everything-claude-code` | 2026-03-30 | **123 d** |
| `ui-ux-pro-max-skill` | 2026-03-30 | **123 d** |

`anthropic-agent-skills` is Anthropic-owned but *user-added*, and sits in between — supporting "official **by registration**" over "official **by vendor**".

**⛔ T2.6 must be respecified.** "Every third-party marketplace with auto-update off" is not implementable. Replace with a **marketplace staleness report** over `known_marketplaces.json.lastUpdated`, excluding the auto-installed official entry.

---

## 2. Are the marketplace clones git checkouts? — 🔴 not all

| Marketplace | `.git` |
|---|---|
| `anthropic-agent-skills` | ✅ present |
| `everything-claude-code` | ✅ present |
| `ui-ux-pro-max-skill` | ✅ present |
| **`claude-plugins-official`** | 🔴 **ABSENT** |

The official clone is **not a git checkout**. It carries `.gcs-sha` (a single 40-char SHA, `c6e19310…`) — distributed as a GCS tarball.

**T2.2 specifies reading HEAD from `installLocation`. For the marketplace holding 276 of 281 available plugins there is no HEAD to read**, and no `git ls-remote` equivalent for a GCS object. T2.2 needs a `.gcs-sha` branch.

**Offsetting find:** `installed_plugins.json` carries **`gitCommitSha`** on 4 of 5 plugins — *a field the CLI does not expose*. Real file-layer capability that the CLI-first path lacks.

**Do not generalise it.** For the 2 relative-sourced plugins it equals the clone's HEAD (verified: `everything-claude-code` `656cf4c9…`, `ui-ux-pro-max` `4255c218…`). For the 2 `url`-sourced plugins it **differs** from the marketplace entry's `source.sha` (`superpowers` `eafe962b…` vs `44c9b2d6…`; `figma` `a72c41ef…` vs `ef474d18…`) despite same-session `lastUpdated`. Mechanism **unresolved** — these may be two live T2.4 stale pins, or the two fields may mean different things. n=2 each way. **Do not build T2.2 on the equivalence.**

---

## 3. Version resolution (§3.3) and the double declaration

### 🟢 Double declaration found, with a real divergence

`ui-ux-pro-max-skill` declares its version **twice, in the same repo, in the same directory**:

- `.claude-plugin/marketplace.json → plugins[0].version` = **`2.2.1`**
- `.claude-plugin/plugin.json → version` = **`2.5.0`**

`plugin.json` wins: `installed_plugins.json` records `2.5.0`; the cache dir is `…/ui-ux-pro-max/2.5.0/`. Both files are **upstream in the same repo**, so this is authoring drift, not a cache artifact — which is what makes it a usable T2.5 case.

There is a **third** version field in the same file (`metadata.version` = `2.2.1`, tracking the stale value) and a **fourth** in the repo root (`skill.json` = `2.5.0`). **T2.5 must decide which of these it reads.**

`everything-claude-code` is the **false-positive guard** — double-declared, both `1.9.0`. T2.5 must not flag it. Both cases are in `version-double-declaration.json`.

### The four documented rules

| Rule | Verdict |
|---|---|
| 1 — `version` in `plugin.json` | **CONFIRMED**, dominant. Fired on 4/5; `installed_plugins.json.version` == `plugin.json.version` every time. |
| 2 — `version` in marketplace entry | **UNVERIFIABLE.** Never observed *deciding* — both entries declaring it also have `plugin.json`, so rule 1 pre-empts. The 14 versioned entries in official are none of them installed. To verify: install one of the 14 LSP plugins on a scratch machine and check whether the cache dir is `1.0.0`. |
| 3 — git commit SHA | **CORRECTED.** **No plugin has a SHA as its version string.** `gitCommitSha` is recorded *alongside* a semver version, not *as* one. The SHA is stored **independently of** the version — it is not an ordered-fallback step. |
| 4 — `unknown` | **CONFIRMED + enumeration incomplete.** `frontend-design` → `unknown`, cache dir literally `…/unknown/`, no SHA, no `version` anywhere. Its source is `./plugins/frontend-design` — **a relative path in a non-git marketplace clone**. §3.3 lists only "npm sources, local dirs outside git". Add this case. |

### 🔴 Fifth, undocumented mechanism: `source.sha`

Marketplace entries can pin a commit directly: `{"source":"url","url":"…","sha":"44c9b2d6…"}` — independent of both `version` fields. **142 of 276 entries in `claude-plugins-official` are `url`-sourced**, so this is the majority source type in the largest marketplace, not an edge case. §3.3 must add it.

---

## 4. Per-path shapes

**`known_marketplaces.json`** — EXISTS. `Record<name, {source: {source, repo?, url?, path?, ref?}, installLocation, lastUpdated}>`. 4 entries, all `github`. Agrees with `marketplace list --json` on all 4 — no T1.8 conflict here.

**`installed_plugins.json`** — EXISTS. `{version: 2, plugins: Record<"<plugin>@<marketplace>", Array<{scope, installPath, version, installedAt, lastUpdated, gitCommitSha?}>>}`.

> ⚠️ **The value is an array**, one element per scope (all single/`user` here). Reading `[0]` silently drops scopes.

Relation to `plugin list --json`: `id` is the object key; `version`/`scope`/`installPath`/`installedAt`/`lastUpdated` are identical; **`enabled` is not in this file** (it lives in `settings.json.enabledPlugins`); **`mcpServers` is not in this file** (CLI-only); **`gitCommitSha` is file-only**. The two sources are **complementary, not redundant — T1.8 should merge, not pick.**

**`plugins/config.json`** — EXISTS. `{"repositories":{}}`, 24 bytes, untouched since 2025-09-29. Purpose not determinable locally.

**`cache/<mkt>/<plugin>/<version>/`** — EXISTS, layout as §3.2 describes, with three corrections:

- `plugin.json` sits at **`<version>/.claude-plugin/plugin.json`**, not the version-dir root.
- Sibling `.cursor-plugin/`, `.codex-plugin/`, `.kimi-plugin/` manifests coexist — **a naive `find -name plugin.json` returns 16 files for 7 plugins.**
- The version segment is the resolved string, **including the literal `unknown`**.

Multiple versions coexist; **2 orphans present** (`figma/2.2.81`, `superpowers/6.1.1`). Liveness mechanism: each version dir holds **`.in_use`, which is a DIRECTORY, not a file** — `[ -f ]` reports it absent. Its **mtime is the liveness signal**, advancing 10:27 → 10:31 across two probes on live dirs while orphans stayed frozen at 10:10:59. `plugins/.last_inuse_sweep` holds the last sweep time. **The ~14-day TTL is UNVERIFIABLE from a single snapshot — do not assert it as observed.**

**`~/.claude.json`** — EXISTS. ~193 KB, 95 top-level keys, mostly telemetry. **Never read wholesale.**

- User-scope `mcpServers`: 3 servers; shapes `{type:"stdio", command, args, env}` and `{type:"http", url}`.
- `projects`: `Record<absolutePath, ProjectState>` — **102 keys**, 40 distinct fields, 9 universal: `mcpServers` (102/102, non-empty on 12), `enabledMcpjsonServers` / `disabledMcpjsonServers` (102/102), `hasTrustDialogAccepted` (102/102), `allowedTools` (102/102), `hasTrustDialogHooksAccepted` (4/102), `ignorePatterns` (5/102), `disabledMcpServers` (1/102).

> 🔴 **Keys are used verbatim.** 72 forward-slash, 30 backslash, drives `C:` **and** `E:`, and **10 are duplicates of another key once lowercased and separator-normalised** — the same project with two entries and divergent state. **T1.3 must normalise *and* report the collision.**

**`settings.json` / `settings.local.json`** — BOTH EXIST.

- `enabledPlugins`: `Record<"<plugin>@<marketplace>", boolean>`, 5 entries all `true` — **the only home of the enabled bit**.
- `extraKnownMarketplaces`: 3 entries (one fewer than `known_marketplaces.json`), carries `source` only, **no autoUpdate field**.
- **`pluginConfigs` is ABSENT** — §3.2 lists it; shape unverified.
- `env`: 3 `CLAUDE_*` toggles. `permissions`: `allow` only.
- `settings.local.json` holds `permissions` + `enabledMcpjsonServers` only — **no plugin keys at local scope, so local-scope plugin precedence is untested.**

**`plugins/marketplaces/<name>/`** — EXISTS; see §2. All 4 have `.claude-plugin/marketplace.json`. **`renames` (official only, 6 entries) is undocumented and consequential** — without resolving it, a renamed plugin reads as removed + added.

**Sibling-owned, existence confirmed:** `skills/**/SKILL.md` 137 · `agents/**` 36 · `commands/**` 76 · `projects/**/*.jsonl` 35 dirs / 383 files · `<repo>/.claude/settings.json` **ABSENT in ccatlas** (project precedence untestable here) · `<repo>/.mcp.json` **ABSENT in ccatlas**; a real 6-server one in the ECC clone confirms `{mcpServers: Record<name, def>}` with **zero `env` keys**.

---

## 5. Reconciliation against `docs/02-architecture.md`

§3.2 has 9 doc rows; two split into claim + sub-claim (7/7b, 8/8b), plus 3 proposed new rows = 14 entries.

**§3.2** — `settings.json`/`local` **CORRECTED** (4/5 keys; `pluginConfigs` absent) · `<repo>/.claude/settings.json` **UNVERIFIABLE** · `~/.claude.json` **CONFIRMED + EXTENDED** · `<repo>/.mcp.json` **CONFIRMED** · `skills/**` **CONFIRMED** · `agents`/`commands` **CONFIRMED** · `known_marketplaces.json` "incl. auto-update flag" **CORRECTED — the row is wrong** · 7b "per-user not per-project" **CORRECTED** (true of install state, but `marketplace add --scope project|local` exists, so *declaration* can be project-scoped) · `cache/…` **CONFIRMED + EXTENDED** · 8b "~14 days" **CORRECTED / TTL UNVERIFIABLE** · `projects/**/*.jsonl` **CONFIRMED**

**§3.2 — proposed new rows:** `installed_plugins.json` (never named in §3.2, yet it is the primary file-layer source for T1.9 `version`, T1.15 `installPath`, T2.2 `gitCommitSha` — **the biggest omission**) · `plugins/marketplaces/<n>/` (literally T2.2's `installLocation` target) · `plugins/config.json`

**§3.3** — rule 1 **CONFIRMED** · rule 2 **UNVERIFIABLE** · rule 3 **CORRECTED** · rule 4 **CONFIRMED + CORRECTED** · "both set → `plugin.json` wins silently" **CONFIRMED** (with a divergent example) · **NEW: `source.sha`**

| | CONFIRMED | CORRECTED | UNVERIFIABLE | NEW |
|---|---|---|---|---|
| §3.2 (14 entries / 9 rows) | 6 | 4 | 1 | 3 |
| §3.3 (6) | 2 | 2 | 1 | 1 |
| **Total** | **8** | **6** | **2** | **4** |

Acceptance met: 9/9 §3.2 rows resolved — 8 with fixtures, 4 with recorded reasons — plus 3 proposed additions.

---

## 6. Downstream impact

| Task | Impact |
|---|---|
| **T2.6** | 🔴 **Blocking.** Respecify as a staleness report; no flag exists. |
| **T2.2** | 🔴 **Correction.** (a) no `.git` on official, only `.gcs-sha`; (b) `gitCommitSha` gives the local side free where present; (c) must handle `source.sha`. |
| **T1.3** | 🔴 **Normalisation mandatory** — 10 colliding keys, 2 separators, 2 drives. |
| **T2.5** | 🟢 Unblocked — positive + negative fixtures ready. Decide whether to read `metadata.version`. |
| **T2.4** | 🟡 `source.sha` is a third pin; the two url-source SHA mismatches may already be live stale pins. |
| **T1.9** | 🟡 "All four rules" is wrong. Suggested enum: `plugin-json` · `marketplace-entry` · `marketplace-source-sha` · `git-sha` · `unknown`, with `gitCommitSha` as a **separate field**, not a version source. |
| **T1.2** | 🟡 `pluginConfigs` absent, no project-scope settings, no local-scope plugin keys — **4-scope precedence cannot be tested on this machine.** Synthetic fixtures needed. |
| **T1.15** | 🟢 Implementable: orphan = cache triple absent from `installed_plugins.json.installPath` + stale `.in_use` mtime. `.in_use` is a **directory**. Do not assert the 14-day TTL as observed. |
| **T1.8** | 🟢 Marketplaces agree exactly; plugin records are complementary (CLI-only `enabled` + `mcpServers`, file-only `gitCommitSha`) — **merge, don't pick.** |
| **T1.16** | 🟡 Zero non-empty `env` across user scope, project scope and `.mcp.json` — no local positive fixture. Synthetic required. |
| **T1.12** | 🟢 New input: `plugins/blocklist.json` — `{fetchedAt, plugins[{plugin, added_at, reason, text}]}`. |
| **T0.1** | 🟡 No-SHA confirmed *for the CLI*; the file layer has it. Also `marketplace list --json` returns only `name`/`source`/`repo`/`installLocation` — **no `path`/`url`/`ref`** as §3.1 anticipates (all 4 local marketplaces are `github`, so other source types are unobserved). |

**Further additions proposed for §3.2:** `plugin-catalog-cache.json` (~343 KB; `catalog.marketplace_sha` + `installs_generated_at` may support `--offline`, T2.7/T2.8) · `.last_inuse_sweep` · `plugins/data/<plugin>-<marketplace>/` (**flattened with `-`, not `@`** — e.g. `superpowers-claude-plugins-official`; ambiguous when a name contains `-`, so map from the known plugin list rather than parsing) · `plugins/repos/` (empty) · `.in_use/` · `.gcs-sha` · `marketplace.json → renames` · `marketplace.json → entry source.sha`

---

## 7. Redaction and safety

**Redacted:** absolute paths → `<HOME>` (script-applied, not hand-edited); username covered by `<HOME>`; MCP **server names** omitted entirely (counts and key-shapes only); project directory names never emitted — only aggregate counts.

**Deliberately kept:** git commit SHAs (public commit identifiers, load-bearing for T2.2/T2.4), public marketplace repo slugs, plugin names, and the 3 `settings.json` `env` **key names** (all `CLAUDE_*` feature toggles, no values).

**Verification:** post-write `grep -rniE` for username, hostname, Windows/other drive paths, and `sk-` / `ghp_` / `gho_` / `github_pat_` / `xoxb-` / `AKIA` / `Bearer ` / `eyJ` across `fixtures/files/` — **exit 1, zero hits**. All 9 JSON files parse. Independently re-verified by the lead across the whole corpus (prefix + path/PII + Shannon-entropy sweep, 121/121 clean).

**`~/.claude.json` was never read wholesale into context** — only key names, type shapes and counts via scripted key-walking. No value from that file appears in any fixture. `oauthAccount`, `userID`, `anonymousId`, `machineID` are present but were not enumerated.

**Credential surface:** every `env` object across user-scope MCP, all 12 project-scope MCP configs, and the ECC `.mcp.json` is **empty** — zero env values, zero header values, on this machine. There is no credential to leak from this corpus, and equally **no positive fixture for T1.16**.

**Mutation:** no `git` binary invocation (clone HEADs read as plain text from `.git/HEAD` and ref files, deliberately, to avoid touching a repo with five concurrent agents). No modification under `~/.claude` or `~/.claude.json`. Three read-only CLI commands were invoked to settle the auto-update question — `marketplace list --json`, `marketplace --help`, `marketplace add --help` — since "absent from the file" is not the same as "the feature does not exist". Those spawn the CLI, which manages its own state files; no claim is made that the CLI performed zero incidental writes of its own.
