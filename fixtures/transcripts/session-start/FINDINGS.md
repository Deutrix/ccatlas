# T0.4 — Session-start extension loads: findings

**Corpus:** 59 top-level transcripts across multiple projects. Records span Claude Code **2.1.202 → 2.1.217**, so schema drift is directly observable.

> Derived by the lead from the `t04-session-start` agent's fixtures. The agent captured and annotated the evidence but did not deliver a written reconciliation; every claim below is traceable to a fixture in this directory.

---

## 1. Answer — 🟢 YES. `sessionsLoaded` is **measured**, not modelled.

Transcripts record the extension roster at session start, as `type: "attachment"` records with these `attachment.type` values:

| `attachment.type` | Carries | Capped? |
|---|---|---|
| `skill_listing` (`isInitial: true`) | skills **and** slash commands — `names[]`, `skillCount`, rendered `content` | 🔴 **yes, ~30,000 chars** |
| `agent_listing_delta` (`isInitial: true`) | subagents — `addedLines` with full descriptions | no (80 full descriptions observed) |
| `deferred_tools_delta` | MCP tools — `addedNames`, `removedNames`, `readdedNames`, `pendingMcpServers` | no |
| `mcp_instructions_delta` | per-server instruction blocks | no |

`names[]` is **complete**: `names.length === skillCount` in every session checked. **Parse `names[]`, never `content`.**

This answers **PRD open question 2** affirmatively and upgrades §5.3 from modelled to measured — but see §2, which is why that is not simply good news.

---

## 2. 🔴 The skill listing is hard-capped, so always-on cost is **not additive**

The rendered `content` is held to a **~30,000-character budget**. It is *not* row-truncated — there is exactly one row per skill, `rows === skillCount`, zero unmatched in every session checked. What the budget drops is **descriptions**.

In the reference record: **581 skills, 29,999 chars, 61 rows with a description, 520 rendered as a bare `- name`.**

### Why this breaks the cost model

`02-architecture.md` §5.3 defines:

```
passiveCost(e) = alwaysOn(e) × sessionsLoaded(e)
```

with `alwaysOn(e)` taken per-entity from `claude plugin details`. That treats per-entity always-on cost as **additive**. Above the cap it is not:

- The skill listing's total always-on cost is **bounded at ~30,000 chars (~7.5k tokens)** regardless of roster size.
- Above the cap, the marginal cost of one more skill is **its name plus about 3 characters** — not its description.
- Therefore **summing per-skill `alwaysOn` figures from `plugin details` overstates the real session cost**, and the overstatement grows with roster size.

This machine is far above the cap: **581 skills in the roster**, of which ~90% contribute only a name. A stacked "context budget by plugin" chart (**T3.4**, the F4 screenshot feature) built by summing per-component figures would be materially wrong here — and wrong in the direction that makes the product's own headline number look worse than reality.

### Interaction with T0.2

T0.2 established that `plugin details` reports per-component always-on figures. This finding establishes that those figures **do not compose** once the roster exceeds the cap. The two must be reconciled before T4.9 is implemented:

- Per-component figures remain valid for **ranking** entities against each other.
- They are **invalid for summation** into a session total above the cap.
- The real session cost is better measured from the emitted listing itself, which is in the transcript — i.e. the measured path is also the *more correct* path, not merely the more precise one.

The cap applies to `skill_listing` **only**. `agent_listing_delta` carried all 80 agent descriptions uncapped; `deferred_tools_delta` shows no cap.

---

## 3. 🔴 One transcript file ≠ one session load

`08-resume-load-boundary.json` contains **two session-load boundaries 11h25m apart** in a single `.jsonl` file. Observed in **6 of 59** transcripts; one file carries **four** boundaries.

Worse, the two roster records behave differently on resume:

| Record | Re-emitted on resume? |
|---|---|
| `agent_listing_delta` (`isInitial: true`) | ✅ yes |
| `skill_listing` (`isInitial: true`) | ❌ **no** |

Two consequences:

- **Counting files undercounts `sessionsLoaded`** — the denominator of every ROI figure. T4.3's incremental tail-parsing must detect load boundaries, not file boundaries.
- **A plugin toggled between two boundaries is invisible for skills**, because the skill roster is never re-emitted. Skill attribution after a resume reflects the roster as of the *first* load.

**Reconstruction rule for "what was loaded at time T":** start from the most recent `skill_listing isInitial:true` at or before T, then replay every subsequent `skill_listing isInitial:false` as additions. Do **not** read record 1 and stop.

---

## 4. Further traps, each fixture-backed

**`skillCount` means different things on different records.** On `isInitial: false` records it counts the entries **in that record** (73), not the roster size (568 at session start). Treating it as a total is wrong by an order of magnitude.

**`skill_listing` has no `removedNames`.** A reconstructed skill roster can only ever grow within a session. `deferred_tools_delta` *does* have `removedNames` and `readdedNames`, so MCP tools can be tracked precisely and skills cannot.

**`names[]` mixes four namespaces, and bare ≠ personal.** Entries appear as personal skills (bare), plugin skills (`<plugin>:<skill>`), user slash commands (`<dir>:<name>`), and built-in skills (bare). **A bare name is not evidence of a personal skill** — T4.6 attribution cannot use the presence of a colon as the discriminator, and must reconcile against the inventory instead.

**Mid-session roster changes are real.** `07-mid-session-roster-change.json` shows an MCP server's 10 tools leaving the roster and returning 27 minutes later via `removedNames` → `addedNames` + `readdedNames`. This is the closest observable proxy for `/reload-plugins`; **no literal `/reload-plugins` invocation exists anywhere in the corpus**, so the reload path cannot be detected directly.

**The project identifier is `cwd` — a path.** It therefore inherits the collision T0.5 documented in `~/.claude.json`: 102 project keys, 10 of which are duplicates once lowercased and separator-normalised. **T4.6 session→project attribution needs the same normalisation as T1.3**, and the two must share one implementation or they will disagree.

**Schema drift is directly observed** across 2.1.202 / 2.1.207 / 2.1.214 / 2.1.217 within a single corpus — concrete support for risk R1 and for T4.1's probe requirement.

---

## 5. Envelope

Common fields on roster records: `type` · `uuid` · `parentUuid` · `sessionId` · `timestamp` (ISO-8601 UTC) · `cwd` · `version` · `gitBranch` · `entrypoint` · `userType` · `isSidechain`.

Pre-roster opening records use narrower shapes and appear before any `attachment`: `last-prompt`, `mode`, `permission-mode`, `bridge-session` — these carry `sessionId` but **not** `timestamp`, `cwd`, or `version`. A parser that assumes the envelope on line 0 will fail.

One fixture shows both `session_id` and `sessionId` on the same record (2.1.207). Prefer `sessionId`; tolerate the variant.

---

## 6. Reconciliation against `02-architecture.md` §5.3

| Claim | Verdict |
|---|---|
| `sessionsLoaded(e)` ← "count of sessions where the owning plugin was enabled" (modelled) | **CORRECTED → measured.** Read the emitted roster; do not infer from enablement. |
| `passiveCost(e) = alwaysOn(e) × sessionsLoaded(e)` | **CORRECTED.** Valid per-entity for ranking; **invalid as a sum** above the ~30k-char cap. |
| `roiRatio(e) = passiveCost(e) ÷ max(invocations(e), 1)` | **CONFIRMED in form**, but inherits the numerator's cap error. |
| sessions are countable per transcript file | **CORRECTED.** 6 of 59 files carry multiple load boundaries. |

**Counts:** CONFIRMED 1 · CORRECTED 3 · UNVERIFIABLE 0.

### Proposed replacement for §5.3

```
roster(session, T)   ← skill_listing isInitial:true at/before T,
                       plus replayed isInitial:false additions
                       (+ agent_listing_delta, deferred_tools_delta,
                          mcp_instructions_delta)
sessionsLoaded(e)    ← count of LOAD BOUNDARIES whose roster contains e
                       (not files, not enablement)
alwaysOnMeasured     ← size of the emitted listing, capped at ~30k chars
alwaysOn(e)          ← per-entity figure from plugin details
                       — valid for RANKING, not for SUMMATION above the cap
roiRatio(e)          = passiveCost(e) ÷ max(invocations(e), 1)
```

---

## 7. Downstream impact

| Task | Impact |
|---|---|
| **T4.9** | 🔴 **Respecify.** Per-entity always-on is not additive above the cap. Compute the session total from the emitted listing; use per-entity figures for ranking only. |
| **T3.4** | 🔴 The context-budget chart cannot be a naive stack of per-plugin sums — it would be wrong on any machine above the cap, which includes the reference machine. |
| **T4.3** | 🔴 Incremental parsing must key on **load boundaries**, not files. 6 of 59 files carry more than one. |
| **T0.4 → T4.1** | 🟢 Probe candidate: `attachment.type` ∈ the four known roster kinds, plus `names[]`/`skillCount` agreement on `skill_listing`. |
| **T4.6** | 🔴 Two corrections: bare names are not necessarily personal skills; and `cwd`-based project attribution needs T1.3's path normalisation, shared not duplicated. |
| **T4.12** | 🟡 `usage --unused` sorts by passive cost descending — that ordering is affected by the cap, since most skills above it cost only their name. Prune advice must not overstate reclaimable context. |
| **F2 / reload detection** | 🟡 No `/reload-plugins` signal exists in transcripts; `deferred_tools_delta` churn is the only proxy. |
