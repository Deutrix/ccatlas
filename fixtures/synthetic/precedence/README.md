# Four-scope settings precedence — synthetic fixture set

**Fills:** `docs/FORMATS.md` §5 — *"No project-scope `.claude/settings.json`, no local-scope plugin keys, `pluginConfigs` absent — T1.2 4-scope precedence is untestable here."*
**Unblocks:** T1.2 (and feeds T1.7 shadowing).

> ⚠️ **Everything in this directory is synthetic.** None of it was captured from a machine. The real, observed settings shape is `fixtures/files/settings-shape.json` — that is the regression baseline; this is a behaviour oracle.

## Files

| File | Stands in for | Observed on the reference machine? |
|---|---|---|
| `user-settings.json` | `~/.claude/settings.json` | ✅ the file exists; these values do not |
| `project-settings.json` | `<repo>/.claude/settings.json` | ❌ **absent** in ccatlas (T0.5) |
| `local-settings.json` | `~/.claude/settings.local.json` | ⚠️ exists, but carries only `permissions` + `enabledMcpjsonServers` — **no plugin keys** |
| `managed-settings.json` | the enterprise managed-settings file | ❌ no such file, and **no path for it is recorded anywhere in `docs/`** |
| `expected-precedence.json` | — | the oracle |

## How to use it

Load the four files as the four scopes, resolve, and compare against `expected-precedence.json`.

Each assertion carries a `status`:

- **`CERTIFIABLE`** — one right answer under every candidate merge model. Safe to gate CI on today.
- **`DOCUMENTED`** — one right answer, sourced to a line in `docs/02-architecture.md`. Safe to gate on. All three `pluginConfigs` assertions are here.
- **`ASSERTED`** — the rule is conventional and almost certainly right, but this project has not observed it. Gate on it, and record it as an assumption.
- **`MODEL-DEPENDENT`** — **two defensible answers.** These exist to force a declaration, not to be guessed. See below.

## The unresolved question: merge granularity

Nothing in the captured corpus witnesses whether Claude Code

- **replaces** a whole `Record`-shaped setting with the winning scope's object, or
- **merges** it entry by entry, so an entry defined at one scope only survives.

The two models disagree on every singly-defined entry, and `permissions` has a third model again (union of `allow`/`deny`/`ask` across scopes, `deny` outranking `allow`).

This fixture set does **not** pick one. It:

1. states both models per key in `expected-precedence.json → mergeGranularity`,
2. spells out what the *alternative* model would produce, and
3. ships entries that **discriminate** — `delta@synthetic-market` and `CCATLAS_SYNTHETIC_USER_ONLY` exist only at user scope while a higher scope defines the enclosing object, so under merge they survive and under replacement they vanish.

Whichever model T1.2 implements, these assertions fail loudly against the other instead of passing silently against both.

**To close this gap for real:** on a scratch machine, define `env.A` at user scope and `env.B` at project scope only, then read the effective environment. If both are present, it is per-key merge.

## `pluginConfigs` shape is inferred

`pluginConfigs` was **absent** on the reference machine (`fixtures/files/settings-shape.json` records `"present": false`). Its nesting here —

```
Record<"<plugin>@<marketplace>", Record<optionName, value>>
```

— is **inferred** from `docs/02-architecture.md` §4.2 (`userConfig` declares named options; `${user_config.<name>}` reads them back). It is marked `UNVERIFIED` in every file's `__shapeCaveats`. **Do not cite this directory as evidence of `pluginConfigs`' shape.** What *is* documented, and what this fixture really tests, is its **precedence rule** (architecture line 158), which is independent of the nesting.

## `pluginConfigs` is the security-relevant case

`docs/02-architecture.md:158`:

> `pluginConfigs` values are read only from user settings, `--settings`, and managed settings. Project and local settings are ignored for this key by design, since a cloned repo could otherwise inject values into hook commands and server configs.

That is **not** an ordering rule — project and local are *ignored*, not outranked. Three assertions cover it:

| id | Shape of the test |
|---|---|
| `PC-alpha` | defined at user + project + local → **user wins**; the losing values are literally named `PROJECT-MUST-BE-IGNORED` / `LOCAL-MUST-BE-IGNORED` |
| `PC-bravo` | user + managed → **managed wins** (managed is one of the two permitted scopes) |
| `PC-charlie-absent` | project + local **only** → the resolved map must contain **no entry at all** |

A resolver that applies the generic scope order passes the first two by luck and fails the third. `PC-charlie-absent` is the one that matters.

## Which file is local scope?

`settings.local.json` sits next to `settings.json` in `~/.claude/` on the reference machine, and Claude Code also supports a per-repo `.claude/settings.local.json`. The captured corpus only witnesses the former. This fixture set treats "local" as **one scope**, ranked above project; if T1.2 discovers that user-local and project-local are distinct scopes, this set needs a fifth file and the oracle needs a new rule. Recorded as an open question, not resolved here.

## Managed settings has no path here

No path for a managed-settings file appears in `docs/FORMATS.md`, `docs/02-architecture.md` or `docs/tasks.md`, and none exists on the reference machine. `managed-settings.json` is therefore **path-agnostic**: it is loaded by content in a test, and its filename is not a claim about where the real file lives. T1.2 must source the platform paths from primary Claude Code documentation. **Do not infer the path from this filename.**

## Deliberate secondary coverage

- `MK-other`'s winning value uses a **different source-object arity** (`{source:"git", url, ref}`) from the losers (`{source:"github", repo}`), so a resolver that deep-merges the two objects instead of replacing one produces a detectable `{source:"git", repo, url, ref}` Frankenstein. The key union is observed; the literal `"git"` value is **not**, and this does not close the §5 gap on non-`github` source types.
- `golf@synthetic-market` is `false` at user scope only — catches a resolver that conflates `false` with absent. `enabledPlugins` is the **only** home of the enabled bit (`FORMATS.md` §2), so a dropped `false` silently re-enables a deliberately disabled plugin.
- `expected-precedence.json → shadowingReport` gives T1.7 its expected set: **10 genuinely shadowed entries**, plus **2 dropped by rule** (`pluginConfigs` at project/local). Those two are a separate finding class — an entry ignored by R4 has no shadowing scope to name, and reporting it as shadowed would misdescribe the mechanism and hide the security property.

## Verified

`node fixtures/synthetic/generate.mjs verify` runs check **V11** over this directory: it re-derives `resolvedUnderAssumedModel` from the four settings files under the assumed model, and cross-checks every `expectations[].definedAt` against the scopes that actually define that entry. The golden cannot drift from its inputs.

V11 is **not** an implementation of T1.2 — it only proves the oracle is self-consistent, which is what makes it safe to gate on.
