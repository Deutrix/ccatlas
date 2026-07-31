# T0.2 — `claude plugin details`: findings

**Environment:** Claude Code 2.1.220, Windows 11, captured 2026-07-31.

> Derived by the lead from the `t02-plugin-details` agent's fixtures. The agent captured the probes but did not deliver a written reconciliation; every claim below is traceable to a committed fixture in this directory.

---

## 1. Verdict — 🔴 TEXT-ONLY. No machine-readable form exists.

`claude plugin details --help` lists exactly one option: `-h, --help`. Every machine-readable flag is rejected with `exit=1, error: unknown option`:

`--json` · `--format` · `--output` · `--plain` · `--quiet` · `--model`

**T4.7 cost enrichment must parse prose.** The grammar is stable and regular enough to parse safely, but it is prose, and it is the fragile path the PRD's risk R3 anticipated.

---

## 2. 🔴 The estimator fails **silently**, and the failure is undetectable from output

This is the most consequential finding in Wave 1. From `model-variation-matrix.txt`, always-on totals for three plugins:

| Condition | ui-ux-pro-max | superpowers | frontend-design |
|---|---|---|---|
| default (no env, no flag) | ~401 | ~688 | ~78 |
| `ANTHROPIC_MODEL=claude-opus-5` | ~401 | ~688 | ~78 |
| `ANTHROPIC_MODEL=claude-sonnet-5` | ~401 | ~688 | ~78 |
| `ANTHROPIC_MODEL=claude-opus-4-1` | ~401 | ~688 | ~78 |
| `ANTHROPIC_MODEL=claude-sonnet-4-5` | ~285 | ~465 | ~54 |
| `ANTHROPIC_MODEL=claude-haiku-4-5-…` | ~285 | ~465 | ~54 |
| `ANTHROPIC_MODEL=claude-3-5-sonnet-…` | **~236** | **~584** | **~59** |
| `ANTHROPIC_MODEL=zzz-not-a-model` | **~236** | **~584** | **~59** |
| `BASE_URL` unreachable (no model) | **~236** | **~584** | **~59** |
| `BASE_URL` unreachable + `MODEL=opus-5` | **~236** | **~584** | **~59** |

Two things fall out of the bottom four rows.

**A bogus model name and an unreachable endpoint produce byte-identical output.** `zzz-not-a-model` does not error. It returns a plausible, well-formatted number in exactly the same shape as a real one. So does an unreachable `BASE_URL`, *even when a valid model is also specified* — the unreachable endpoint wins over the valid model name.

**There is no marker of any kind.** No warning, no `(estimated)` suffix, no non-zero exit, no stderr. `~236 tok` from the local fallback is indistinguishable from `~236 tok` from the real `count_tokens` API.

### Consequences

- **T4.8 is respecified.** Its premise — "fall back to a character-based estimate when `count_tokens` is unreachable" — assumed ccatlas would *detect* unreachability. It cannot. Claude Code has already silently fallen back, and ccatlas will faithfully cache a wrong number as if it were authoritative.
- **T4.7's cache key must be `plugin@version + model + estimatorRegime`,** not `plugin@version` as `02-architecture.md` §5.3 states. Three distinct regimes are observable in the table above; caching across them silently mixes incompatible figures.
- **Detecting the fallback regime requires a probe, not parsing.** The only workable approach found: measure a known reference plugin whose real-estimator value is recorded, and treat a match against the fallback baseline as "regime uncertain". Cheap, but it must exist — otherwise `passiveCost` inherits a ~40% error (ui-ux-pro-max: 401 → 236) with no signal.
- **This strengthens F3's honesty requirement.** "Estimates are labelled" is no longer sufficient. Reports must distinguish *estimated by the model's tokenizer* from *estimated by a local fallback of unknown fidelity*.

---

## 3. 🔴 MCP tool schemas are **not counted** in always-on cost

Every MCP row in the component inventory carries a parenthetical:

```
  MCP servers (6)  github, context7, exa, memory, playwright, sequential-thinking  (tool schemas resolved at runtime; not counted)
```

**The always-on figure excludes MCP tool schema cost entirely.**

This is a direct hit on the PRD. Problem statement §1.4 and user story **U4** — *"know which MCP servers cost the most per turn relative to use"* — cannot be answered from `plugin details`. That number is not in there, and an MCP-heavy plugin's real per-turn cost is understated by whatever its tool schemas weigh.

Hooks are annotated similarly and are genuinely free: `Hooks (7)  … (harness-only — no model context cost)`.

**Decision required** (feeds T4.7/T4.10 and F3's scope): either drop the MCP-cost claim from U4, or build an independent tool-schema estimator — which contradicts the design principle "ccatlas does not build its own estimator". Recommend surfacing MCP servers with **schema cost explicitly marked unavailable**, and ranking them on invocation counts alone, which *are* exact.

---

## 4. Grammar

```
<name>[ <version>]                        <- version ABSENT entirely when unresolved
  <description>
  Source: <plugin>@<marketplace>

Component inventory
  Skills (N)[  name, name, …]             <- name list omitted when N = 0
  Agents (N)
  Hooks (N)[  Event, Event, …]  (harness-only — no model context cost)
  MCP servers (N)[  name, …]  (tool schemas resolved at runtime; not counted)
  LSP servers (N)

Projected token cost
  Always-on:   ~N tok   added to every session

Per-component (rounded)
  component<pad>always-on  on-invoke
  <name><pad>~N  ~N

  On-invoke cost is paid each time a skill or agent fires.
  Token counts are estimates and may differ from actual usage.
```

### Parsing traps, each observed

| Trap | Evidence |
|---|---|
| **Version is omitted from the header when unresolved.** Splitting line 1 on whitespace as `<name> <version>` yields a wrong name or a crash. | `frontend-design` line 1 is `frontend-design` with no version — it is the plugin whose resolved version is literally `unknown` |
| **Zero-count sections are present, not omitted** — `Agents (0)` with no name list. Uniform handling works. | every fixture |
| **Number formats are mixed within one table**: `~90`, `~2,069` (thousands comma), `~8k`, `~9.7k`, `~13,990` | `figma`, `everything-claude-code` |
| **Per-component values do not sum to the always-on total.** Both sections round independently. | `figma`: components sum to ~2,080; total reports ~2,069. `frontend-design`: total ~78, single component ~80 |
| **The component list can contain duplicates.** `everything-claude-code` lists `context-budget` twice and `rules-distill` twice inside `Skills (196)`. | Attribution (T4.6) must decide whether the count is authoritative or the list is; naive de-duplication changes the total |
| Columns are whitespace-padded to variable width — parse by column header position or by trailing-token order, never by fixed offset | all |

---

## 5. `--plugin-dir` — works, but only **before** the subcommand

```
$ claude plugin details --plugin-dir <path> frontend-design     # AFTER  -> exit=1, unknown option
$ claude --plugin-dir <path> plugin details frontend-design     # BEFORE -> exit=0, full output
```

Against an out-of-tree, **uninstalled** copy, the output is identical to the installed resolution except for one line: `Source: frontend-design@inline` rather than `@claude-plugins-official`. **Cost sections populate identically** (`~78 tok`; `~80` / `~2.4k`).

**T7.6's CI token-budget gate is therefore viable against a checkout, with no npm publish and no install.** This unblocks making that gate blocking as soon as `plugin.json` exists (T7.1), rather than waiting for Phase 7 distribution.

---

## 6. Reference data point for F4

`everything-claude-code` alone: **196 skills, 6 MCP servers, 7 hooks, ~13,990 always-on tokens added to every session** — and that figure *excludes* its six MCP servers' tool schemas. This is the context-budget story in one line, and the natural hero number for the F4 dashboard's stacked-cost chart (T3.4).

---

## 7. Reconciliation

**§3.1, `claude plugin details` row** — *"component inventory + always-on and on-invoke token cost; text output; parse defensively, cache per plugin version"*:

| Claim | Verdict |
|---|---|
| component inventory returned | **CONFIRMED** — 5 kinds, always present |
| always-on and on-invoke cost returned | **CONFIRMED**, with a material carve-out: MCP tool schemas excluded |
| text output, parse defensively | **CONFIRMED** — no machine-readable flag exists |
| "cache per plugin version" | **CORRECTED** — must be `plugin@version + model + estimatorRegime` |

**§5.3 cost model:**

| Claim | Verdict |
|---|---|
| `alwaysOn(entity) ← claude plugin details` | **CONFIRMED** for skills/agents; **CORRECTED** for MCP — not available |
| cached by `plugin@version` | **CORRECTED** — see above |
| estimates are labelled | **CORRECTED / insufficient** — must additionally distinguish real-tokenizer from silent-fallback figures |

**Counts:** CONFIRMED 4 · CORRECTED 4 · UNVERIFIABLE 0.

---

## 8. Downstream impact

| Task | Impact |
|---|---|
| **T4.8** | 🔴 **Respecify.** Cannot detect unreachability from output; Claude Code falls back silently and identically. Needs a reference-probe regime check. |
| **T4.7** | 🔴 **Cache key corrected** to `plugin@version + model + estimatorRegime`. |
| **T4.10** | 🔴 MCP tool-schema cost is unavailable. "N tools loaded, M ever called" survives on invocation counts; the *cost* half does not. |
| **F3 / U4** | 🔴 **Product decision required** — drop the MCP per-turn cost claim, or build an estimator the design says ccatlas will not build. |
| **T4.14** | 🟡 Methodology note must distinguish two estimate provenances, not one. |
| **T7.6** | 🟢 **Unblocked early.** `--plugin-dir` before the subcommand measures a checkout; the CI gate can go blocking at T7.1 rather than Phase 7. |
| **T4.6** | 🟡 Duplicate entries exist in component lists — decide whether count or list is authoritative. |
| **T1.9** | 🟡 A plugin with an unresolved version has **no version token in the header at all** — not the string `unknown`. |
