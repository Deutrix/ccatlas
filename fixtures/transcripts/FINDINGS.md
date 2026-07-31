# T0.3 — Session transcript record shapes

**Status:** complete. **Method:** read-only scripted scan of every `.jsonl` under `~/.claude/projects/`.
**Corpus scanned:** **384 files / 276,870 records** across **35 project directories** — the entire local corpus, not a sample.
Of those, **60 top-level session transcripts** and **324 subagent sidecar transcripts** (see §2).
**Claude Code versions present in the data: 2.1.197 → 2.1.220 (19 distinct builds).** Use this as the T0.6 fixture stamp.

> Redaction: every exemplar under `signals/` is a single record with `uuid`/`sessionId`/`requestId` replaced by
> synthetic same-shape values, `cwd` → `<HOME>/<PROJECT>`, `gitBranch` → `<BRANCH>`, `slug` → `<SLUG>`,
> all prose → `<CONTENT>`, `tool_use.input` reduced to signal-bearing keys only (dropped key *names* retained,
> values discarded), and `toolUseResult` dropped entirely. A leak scan for `alex`/`WORKSTN`/absolute paths/token
> prefixes over the fixture tree returns clean.

---

## 1. Envelope

### 1.1 File layout — corrected

`02-architecture.md` §3.2 gives the source as `~/.claude/projects/**/*.jsonl`. That glob is correct but matches
**6.5x more files than expected**, because sessions have sidecar subdirectories:

```
~/.claude/projects/
  <project-dir>/                              # cwd with [\/:] -> '-'  e.g. C--<PROJECT-1>
    <session-uuid>.jsonl                      # the session transcript          (60 local)
    <session-uuid>/
      subagents/agent-<agentId>.jsonl         # one per dispatched subagent    (324 local)
      tool-results/<id>.txt                   # spilled large tool output       (29 local, not JSONL)
    memory/ · session-memory/ · workflows/ · scripts/    # third-party plugin state, NOT transcripts
```

The `memory/`, `session-memory/`, `workflows/`, and `scripts/` directories are written by user plugins
(ruflo / claude-flow), not by Claude Code. **T4.3's enumerator must not assume every `.jsonl` under
`projects/**` is a transcript** — it must validate with the probe (§5) and skip on failure.

Project-directory naming is lossy: `<DRIVE>:\dir\sub\<PROJECT-1>` becomes `C--<PROJECT-1>`. Drive colon and both
separators collapse to `-`, so the original path is **not recoverable** from the directory name. Recover the
real cwd from the `cwd` field on any record instead.

### 1.2 Line format

- **Strictly one JSON object per line.** 276,870 non-empty lines parsed, **0 failures, 0 non-object lines.**
- UTF-8, newline-terminated, trailing newline present.
- **Append-only, with last-wins semantics for state records.** Session state is *not* mutated in place: a new
  `last-prompt` / `mode` / `permission-mode` / `ai-title` record is appended on every change. One 23-turn
  session contains 23 `last-prompt`, 23 `mode`, 23 `permission-mode` and 22 `ai-title` records. A reader
  wanting current state takes the **last** occurrence.
- **Compaction appends, it does not rewrite.** `system` records with `subtype: "compact_boundary"` (carrying
  `compactMetadata`, `logicalParentUuid`) and `user` records with `isCompactSummary: true` appear *inline*,
  mid-file, with all pre-compaction records still present above them. No truncation observed.
  Still: T4.3 must keep a `size < storedOffset` implies re-index-this-file-from-byte-0 guard, since append-only
  is an empirical observation over 19 builds, not a documented contract.

### 1.3 Top-level keys

Two record families.

**(a) Timeline records** — `assistant`, `user`, `attachment`, `system`. Full envelope, always present:

| key | type | notes |
|---|---|---|
| `type` | string | discriminator |
| `uuid` | string (UUIDv4) | record id |
| `parentUuid` | string or null | previous record in the thread; `null` at thread start |
| `timestamp` | string | **ISO-8601 UTC with milliseconds and literal `Z`** — `"2026-07-05T07:33:46.418Z"`. *Never* an epoch int. §5.1's `ts INT` column must store `Date.parse()` output. |
| `sessionId` | string (UUIDv4) | **equals the transcript filename stem for every top-level record — 241,346/241,346, zero mismatches.** Not unique per file: sidecars reuse the parent's id. |
| `isSidechain` | boolean | `false` on every top-level record, `true` on every sidecar record. Strict partition. |
| `cwd` | string | absolute path; the only reliable way back to the real project path |
| `version` | string | Claude Code version that wrote the record — varies *within* a file |
| `gitBranch` | string | `""` when not a repo |
| `userType` | string | `"external"` throughout |
| `entrypoint` | string | `"cli"` throughout |

Optional/partial: `session_id` (snake_case duplicate of `sessionId`, ~45–79% — added at 2.1.199, do **not** rely
on it), `slug` (a stable human-readable session nickname, e.g. `wise-imagining-emerson`; only 5 of 19 versions),
`agentId`, `requestId`, `promptId`, `toolUseResult`, `isMeta`, the five `attribution*` fields (§3.6).

**(b) Session-state records** — `last-prompt`, `mode`, `permission-mode`, `ai-title`, `bridge-session`,
`queue-operation`, `file-history-snapshot`, `file-history-delta`, `fork-context-ref`, `started`.
These carry **no `uuid`, no `timestamp`, no `cwd`, no `version`**. Most carry only `type` + `sessionId` + payload.
`file-history-snapshot` / `file-history-delta` carry **no `sessionId` either**.
Exemplars: `signals/envelope/01–05.json`.

**A parser that assumes every line has `uuid` and `timestamp` will crash on line 1 of every transcript** —
the first four records of a session are `last-prompt`, `mode`, `permission-mode`, `bridge-session`.

### 1.4 Record type frequency (full corpus)

| type | n | share |
|---|---|---|
| `attachment` | 159,158 | 57.5% |
| `assistant` | 45,850 | 16.6% |
| `user` | 24,550 | 8.9% |
| `last-prompt` / `mode` / `ai-title` / `permission-mode` | ~40,000 | 14% |
| `system` | 1,499 | 0.5% |
| `bridge-session`, `queue-operation`, `file-history-*`, `fork-context-ref`, `started` | ~5,900 | 2% |

**Only `assistant` records carry invocation signal.** 57% of the corpus is `attachment`, which can be skipped
outright — a meaningful perf lever for T4.15.

---

## 2. Subagent sidecars — a double-counting hazard §3.2 does not mention

- Sidecar path: `<project-dir>/<parent-session-uuid>/subagents/agent-<agentId>.jsonl`.
- Sidecar records carry `sessionId` = **the parent session's uuid** (not a new session id) and
  `agentId` = the agent's id. `isSidechain: true` on all of them.
- **Sidecar records are not duplicated into the parent file.** Verified: `isSidechain: true` occurs in
  **zero** top-level files (33,295 occurrences, all in sidecars). The parent transcript holds only main-thread turns.
- Consequence: `**/*.jsonl` correctly yields each record exactly once. **But** tool calls made *by subagents*
  live only in sidecars. Indexing only `<project>/*.jsonl` silently drops them — for this corpus that is
  **21,000 of 45,850 assistant records (46%)**.
- **No join key from dispatch to sidecar.** The parent's `Agent` tool_use `id` is a `toolu_...` string;
  the sidecar's `agentId` is a separate `a<hex16>` / `a<name>-<hex16>` value. They never intersect
  (0/323). Association is by directory nesting and timestamp ordering only.
- Recommendation: index both, tag each invocation row with `is_sidechain` and `agent_id`, and default usage
  reports to **all** invocations. `sessions` keyed on `sessionId` stays correct because sidecars reuse the parent id
  — "distinct sessions" and "distinct projects" per F3 are unaffected.

---

## 3. The five signals

All five are extracted from **`assistant` records** with `message.content` an array containing
`{"type":"tool_use","id","name","input"}` blocks — except `command`, which is a `user` record (§3.4).
`message.content` is an array in **45,850/45,850** assistant records; it is never a bare string in this corpus.

### 3.1 `kind: skill` — CONFIRMED

`tool_use.name === "Skill"`, `input.skill` is the entity, optional `input.args`.

```json
{"type":"tool_use","id":"toolu_...","name":"Skill","input":{"skill":"superpowers:brainstorming"}}
```

- **36 invocations, 14 distinct skills, in the full corpus.**
- `input.skill` is the **only** entity source. It uses the `plugin:skill` form for plugin skills
  (`superpowers:brainstorming`, `ui-ux-pro-max:ui-ux-pro-max`, `figma:figma-design-to-code`) and a bare name
  for personal/built-in skills (`init`, `run`, `grilling`, `laravel-tdd`, `claude-in-chrome`).
  Split on the **first** `:` to get owner; absence of `:` means personal or built-in.
- Exemplars: `signals/skill/01–04.json`.

### 3.2 `kind: mcp`, user/project scope — CONFIRMED

`tool_use.name` matches `^mcp__(?!plugin_)(?<server>[^_].*?)__(?<tool>.+)$`.

```
mcp__claude-in-chrome__navigate
mcp__laravel-boost__database-query
mcp__figma-remote-mcp__get_design_context
```

- **1,099 tool_use invocations** across 4 user-scope servers, 23 distinct tool names:
  `claude-in-chrome` 980 calls / 12 tools · `laravel-boost` 51 / 3 · `figma-remote-mcp` 46 / 4 · `figma-dev-mode` 22 / 4.
- Exemplars: `signals/mcp-user-scope/01–04.json`.

### 3.3 `kind: mcp`, plugin-bundled — CONFIRMED, and the trap is real

`tool_use.name` matches `^mcp__plugin_(?<plugin>...)_(?<server>...)__(?<tool>.+)$`.

```
mcp__plugin_everything-claude-code_playwright__browser_navigate
mcp__plugin_figma_figma__authenticate
```

Confirmed mapping against the brief's premise: `claude mcp list` displays this server as
`plugin:everything-claude-code:playwright`; the transcript tool name is
`mcp__plugin_everything-claude-code_playwright__browser_navigate`. **`:` becomes `_`, and the `plugin` prefix
becomes part of the server segment.** A matcher on the bare key `playwright` never fires. Confirmed.

**Parsing rule, and its limit.** Splitting the tool name on `__` yields **exactly 3 segments in
1,105/1,105 observed MCP tool calls** — `mcp`, `<serverKey>`, `<tool>`. So *tool names never contain `__`*,
and `name.split('__')` is safe for separating server from tool.

It is **not** safe for separating plugin from server inside `plugin_<plugin>_<server>`: that split is on a
single `_`, and plugin names may legally contain `_`. `plugin_everything-claude-code_playwright` happens to
be unambiguous only because this plugin uses hyphens. **T4.5 must resolve plugin/server by cross-referencing
the known plugin list from `claude plugin list --json`, greedy-matching the longest known plugin name that
prefixes the segment — not by naive `_` split.**

There is a better key available: see §3.6 — `attributionMcpServer` carries the canonical
`plugin:everything-claude-code:playwright` form directly, with no splitting required.

- **6 tool_use invocations only** — `…playwright__browser_navigate` 2, `…playwright__browser_resize` 2,
  `mcp__plugin_figma_figma__authenticate` 2 — across 2 plugin-bundled servers and 3 distinct tools.
  **The format claim is solid on a thin sample:** a tool-name string is unambiguous regardless of frequency,
  but only 6 calls exist locally. (Do not confuse this with the 139 `attributionMcpServer` records for the same
  server — that is the context marker §3.6 says never to count.)
- Exemplars: `signals/mcp-plugin-scope/01–04.json`.

### 3.4 `kind: command` — **shape CONFIRMED, but UNVERIFIED for plugin/personal commands**

This is the most consequential finding in T0.3.

A slash command appears as a `user` record whose `message.content` is a **string** containing:

```
<command-name>/clear</command-name>
            <command-message>clear</command-message>
            <command-args></command-args>
```

The shape is real and parseable. But across the whole corpus there are only **31 such records, spanning 8
distinct names**: `/model` (13), `/compact` (4), `/mcp` (3), `/effort` (3), `/plugin` (3), `/clear` (2),
`/advisor` (2), `/loop` (1).

Six are Claude Code CLI built-ins. **Two — `/loop` and `/advisor` — are skill-backed slash commands, not CLI
built-ins.** That matters: it shows the `<command-name>` form is **not** restricted to built-ins, and does
capture typed slash-command invocations generally.

I checked every other plausible carrier; none holds a slash command:

| candidate carrier | n | slash-prefixed hits |
|---|---|---|
| `last-prompt.lastPrompt` | 10,048 | 3 — all `/compact` |
| `queue-operation.content` | 1,763 | 9 — all built-ins |
| `attachment.queued_command.prompt` | 610 | **0** |
| `user.promptSource === "typed"` message text | 493 | **0** |
| `<local-command-stdout>` markers | 25 files | bash-mode (`!`) output, not slash commands |

**What is missing: any invocation of a plugin-provided or personal command.** This machine has ~60 personal
`~/.claude/commands/*.md` files (`code-review.md`, `docs.md`, `e2e.md`, `plan.md`, …) plus a
`plugins/cache/everything-claude-code/…/1.9.0/commands/` directory. **Not one of those names appears anywhere
in 384 transcripts** — not as `<command-name>`, not as a `Skill` tool_use, not in any other carrier.

I tested the "commands are dispatched as skills" hypothesis directly by resolving all 14 observed
`Skill` `input.skill` values against the filesystem. **None resolves to a `commands/*.md` file**:
`laravel-tdd` and `frontend-design` are `skills/**/SKILL.md`; `init`, `run`, `grilling`, `loop`,
`claude-in-chrome` are built-in skills; the rest are plugin skills. The hypothesis is **unsupported**.

One further datum: `loop` is the only `attributionSkill` value with **no** corresponding `Skill` tool_use
(12 attribution records, 0 dispatches) — and `/loop` is also the one `<command-name>` entry that is
skill-backed. So a *typed* slash invocation appears to load its target directly, emitting a `<command-name>`
record and **no** `Skill` tool_use, whereas a *model-chosen* skill emits a `Skill` tool_use and no
`<command-name>`. n=1; treat as a hypothesis, not a finding.

**Verdict: the `command` signal shape is CONFIRMED, but UNVERIFIED for ccatlas's actual entities.**
There is no exemplar of a plugin or personal command being invoked, so I cannot say which form one takes.
Two readings remain open and I cannot separate them from this corpus:

- **(a)** they are recorded as `<command-name>` like `/loop` is, and this user simply never invoked one; or
- **(b)** they are not recorded at all.

**Consequences:**

1. Build `kind: command` against the `<command-name>` shape — it is the only carrier that exists, and it
   demonstrably handles at least one non-built-in.
2. **Filter out CLI built-ins** (`/model`, `/clear`, `/compact`, `/mcp`, `/plugin`, `/effort`) — they are not
   ccatlas entities: not installed, not prunable, no passive cost.
3. **T4.12 `--unused` must not assert "never used" for commands on this evidence.** Under reading (b) every
   command reports zero and `--unused` would recommend pruning the user's entire command library — the exact
   silent-zero pathology §5 designs the probe against. Until a real invocation is observed, `usage commands`
   must carry an explicit "command invocation recording is unconfirmed" caveat, and commands should be
   **excluded from the prune ranking** rather than listed at zero.
4. **Invocation-vs-model-initiated is not distinguishable for skills.** A `Skill` tool_use looks identical
   whether the user typed `/foo` or the model chose to load it.
5. **Cheap way to close this:** invoke one personal command (e.g. `/docs`) in a throwaway session and grep the
   new transcript for `<command-name>`. One turn settles (a) vs (b). Recommend the lead do this before T4.4.

- Exemplars: `signals/command/01–04.json` — shape preserved; all four are built-ins, since nothing else exists.

### 3.5 `kind: agent` — **CORRECTED. The tool is `Agent`, not `Task`.**

```json
{"type":"tool_use","id":"toolu_...","name":"Agent",
 "input":{"description":"...","subagent_type":"Explore","prompt":"...","model":"...","name":"...","isolation":"..."}}
```

- **`Task` appears zero times as a tool name across all 19 Claude Code builds present locally (2.1.197–2.1.220).**
  Dispatch is `Agent` — **280 invocations**, 10 distinct `subagent_type` values.
- **Double trap.** `Task*` tools *do* exist — `TaskCreate` (94), `TaskUpdate` (132), `TaskList` (3),
  `TaskStop` (15) — but they are the **background-task tracker**, not subagent dispatch.
  So a `name.startsWith("Task")` matcher fires **244 times on the wrong tool and 0 times on the right one**,
  and an exact `name === "Task"` matcher silently returns zero. Either way the agents report is wrong with no error.
- Entity = `input.subagent_type`. Values use the `plugin:agent` form for plugin agents
  (`everything-claude-code:security-reviewer`) and bare names otherwise (`general-purpose`, `Explore`, `fork`,
  `code-reviewer`, `security-reviewer`, `performance-optimizer`, `typescript-reviewer`, `architect`).
  Same first-`:` split as skills.
- `input.name` (86/280) is the addressable agent name, unrelated to `subagent_type`.
- Exemplars: `signals/agent/01–04.json`, plus `05-subagent-sidecar-first-record.json` for the sidecar shape.

### 3.6 Bonus signal §5.2 does not know about: first-class attribution fields

`assistant` records carry up to five attribution fields that Claude Code computes itself:

| field | n | example values |
|---|---|---|
| `attributionAgent` | 11,829 | `general-purpose`, `Explore`, `fork`, `workflow-subagent`, `security-reviewer` |
| `attributionSkill` | 2,241 | `superpowers:systematic-debugging`, `laravel-tdd`, `init` |
| `attributionPlugin` | 1,762 | `superpowers`, `frontend-design`, `ui-ux-pro-max`, `figma` |
| `attributionMcpServer` | 5,723 | `claude-in-chrome`, `laravel-boost`, **`plugin:everything-claude-code:playwright`** |
| `attributionMcpTool` | 5,723 | `computer`, `browser_batch`, `database-query` |

**These are context markers, not invocation records. Do not count them.**

Evidence: of assistant turns carrying any attribution field, **9,025 of 18,747 (48%) contain no `tool_use`
block at all** — they are pure `thinking`/`text` turns produced while the entity was in scope. Sampled
directly: `attributionAgent: "Explore"` on a turn whose only content block is `thinking`.
Ratio check: 11,829 `attributionAgent` records vs **280** actual `Agent` dispatches — **42x overcount**.
5,723 `attributionMcpServer` records vs **1,105** actual MCP calls — **5.2x overcount**.

Also asymmetric: `Skill` tool_use turns carry `attributionSkill` in **0 of 37** cases (the dispatching turn
precedes the load), while MCP tool_use turns carry `attributionMcpServer` in only 962 of 1,105 (87%).

**Correct use — two distinct jobs:**

- **Counting (T4.4/T4.5):** count `tool_use` blocks. Exact, one row per call, satisfies F3's "invocation counts
  are exact" honesty requirement.
- **Owner resolution (T4.6):** use the attribution fields as a lookup table. `attributionSkill` plus
  `attributionPlugin` gives skill-to-plugin ownership **for free**, with no filesystem walk and no guessing.
  `attributionMcpServer` gives the canonical `plugin:<plugin>:<server>` key, sidestepping §3.3's split ambiguity entirely.
- Availability: `attributionSkill`/`attributionPlugin` in 14 of 19 builds, `attributionAgent` in 12,
  `attributionMcp*` in 11. **All are post-2.1.197 additions — treat as optional enrichment, never as a probe
  or a required field.**
- Exemplars: `signals/attribution/01–03.json`.

---

## 4. PRD open question 3 — is per-tool MCP invocation distinguishable, or only per-server?

## **Answer: YES — per-tool, unambiguously. T4.10 is buildable.**

Two independent sources of evidence:

1. **`tool_use.name` carries the full triple.** `mcp__<server>__<tool>` splits into exactly 3 `__`-segments in
   **1,105 of 1,105** observed MCP calls, so the tool name is recoverable with zero ambiguity.
   **26 distinct MCP tool names** across 6 servers were observed, with per-tool counts, e.g. for
   `claude-in-chrome`: `computer` 541, `navigate` 183, `browser_batch` 86, `javascript_tool` 58,
   `tabs_context_mcp` 25, `read_page` 21, `find` 21, `read_console_messages` 16, `resize_window` 9,
   `tabs_close_mcp` 9, `read_network_requests` 8, `tabs_create_mcp` 3.
2. **`attributionMcpTool` exists as a first-class field** (5,723 records), carrying the bare tool name
   alongside `attributionMcpServer` — a corroborating source, though not to be used for counting (§3.6).

**T4.10 ("N tools loaded, M ever called") is buildable**, with one caveat the report must state: `M` comes from
transcripts but `N` — the number of tools a server *exposes* — is **not** in transcripts. `N` must come from the
MCP collector (`claude mcp get <name>`) or from the `deferred_tools_delta` / `mcp_instructions_delta`
`attachment` records (440 / 73 locally, unverified shape — out of T0.3 scope). If `N` is unavailable, T4.10
degrades to "M tools called" without the denominator.

---

## 5. Proposed schema probe for T4.1

```
probe(first N timeline records of file):
  find >=1 record where:
    rec.type === 'assistant'                      // REQUIRED - a 'user' record never exercises the probe field
    typeof rec.uuid      === 'string'
    typeof rec.sessionId === 'string'
    typeof rec.timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(rec.timestamp)
    typeof rec.isSidechain === 'boolean'
    rec.message && typeof rec.message === 'object'
    typeof rec.message.role === 'string'
    Array.isArray(rec.message.content)            // <-- the named probe field
```

**Named probe field: `message.content` is an array on `type: "assistant"` records**, guarded by the envelope
checks above (`type` + `uuid` + ISO-8601 `timestamp` + `sessionId`).

**Why this one.**

- **It is where the signal actually lives.** Every one of the five signals is a `tool_use` block inside
  `assistant.message.content`. If that array shape changes, extraction yields nothing. The probe therefore
  fails in exactly the case that matters.
- **It catches the silent-zero failure, which a coarser probe would not.** If `message.content` became a plain
  string (the obvious future compaction), a probe checking only `type`/`uuid`/`timestamp` still passes, tool_use
  extraction returns 0, and the report says *"you have used nothing — prune everything"*. That is worse than an
  outage: it is a confidently wrong recommendation that would delete working configuration. Asserting
  `Array.isArray(message.content)` converts that into `{available:false, reason}`.
- **It is cheap.** No full-file read. Scan forward until the first `assistant` record — in practice within the
  first ~10 lines — then stop.
- **It is version-stable across the whole observed range.** `type`, `uuid`, `timestamp`, `sessionId`,
  `isSidechain`, `cwd`, `version`, `gitBranch`, `userType`, `entrypoint`, `parentUuid` are each present in
  **19 of 19** builds (2.1.197–2.1.220). `message.content` is an array in **45,850/45,850** assistant records.
  This is the strongest stability datum available against risk R1.
- **It rejects non-transcripts.** The `memory/`, `workflows/`, and `session-memory/` `.jsonl` files that the
  §3.2 glob also matches (§1.1) contain no such record and fail cleanly.

**Explicitly rejected as probes:** `slug` (5/19 builds), `session_id` (17/19, added 2.1.199, redundant),
every `attribution*` field (11–14/19, and semantically a context marker), `requestId` (18/19).
Also rejected: probing the **first** line of a file — the first four records are session-state records with no
`uuid` and no `timestamp` (§1.3b), so a first-line probe fails on a perfectly healthy transcript.

**Recommendation:** run the probe **per file**, not once globally, and record the `version` string from the
probed record into the `files` table. A corpus spanning 19 builds means "the schema" is not a single thing;
per-file probing lets one drifted file degrade alone.

---

## 6. Signals not found

- **Any invocation of a plugin-provided or personal slash command.** Zero examples, corpus-wide, in any
  carrier (§3.4), despite ~60 personal commands plus a plugin `commands/` directory being installed. The
  `<command-name>` *shape* is confirmed and handles at least one non-built-in (`/loop`), but I have no
  exemplar for a ccatlas command entity and cannot tell "never invoked" from "not recorded". **This is the
  one genuinely open question left in T0.3, and it is closable in a single turn** — see §3.4.
- **`Task` as a subagent-dispatch tool name.** Zero occurrences across 19 builds (§3.5). The name is `Agent`.
- **Hook invocations.** Present but only as `attachment.hook_success` / `async_hook_response`
  (144,450 + 11,551 records) with `hookName`, `hookEvent`, `command`. Not one of the five signals, but if
  ccatlas ever reports hook usage, that is where it lives — and the `command` field embeds the full hook
  command line, which is a **redaction hazard for any future hook fixture**.
- **Session-start entity enumeration.** Not in T0.3's scope, but found incidentally and material to **T0.4**:
  `attachment.skill_listing` records carry `{skillCount: 555, names: string[555], isInitial: true, content}`,
  and `agent_listing_delta` (70), `deferred_tools_delta` (440), `mcp_instructions_delta` (73) records exist.
  **`sessionsLoaded` may be measurable rather than modelled.** Flagged to T0.4.

---

## 7. Reconciliation against `02-architecture.md` §5.2

| §5.2 row | Verdict | Actual |
|---|---|---|
| `Skill` tool use gives `kind: skill`, entity = skill name to owning plugin or personal | **CONFIRMED** | `tool_use.name === "Skill"`, entity `input.skill`. Owner from the `plugin:skill` prefix, or free from `attributionPlugin`. 36 invocations, 14 skills. |
| `mcp__<server>__<tool>` gives `kind: mcp`, user/project-scope server + tool | **CONFIRMED** | 1,099 tool_use invocations, 4 servers, 23 distinct tool names. Exactly 3 `__`-segments. |
| `mcp__plugin_<plugin>_<server>__<tool>` gives `kind: mcp`, plugin-bundled, parsed distinctly | **CONFIRMED** + refined | Confirmed on **6 tool_use invocations only** (2 servers, 3 tools) — thin, but a name string is unambiguous. Format exact as stated; the `claude mcp list` form `plugin:everything-claude-code:playwright` maps to `mcp__plugin_everything-claude-code_playwright__...`, verified. **Refinement:** the plugin/server boundary inside the segment is *not* safely splittable on `_`; resolve via known-plugin cross-reference, or read `attributionMcpServer` which carries the canonical colon form. |
| slash command gives `kind: command`, entity = command to owning plugin | **UNVERIFIABLE** (shape confirmed, entity unconfirmed) | The carrier exists: a `user` record whose string `message.content` holds a `<command-name>` element. 31 records, 8 names — 6 CLI built-ins plus `/loop` and `/advisor`, which are skill-backed, so the form is not built-ins-only. **But zero plugin or personal commands appear in any carrier**, despite ~60 being installed, and none of the 14 observed `Skill` `input.skill` values resolves to a `commands/*.md` file — so the "commands dispatch as skills" hypothesis is unsupported. Cannot distinguish "never invoked here" from "not recorded". §3.4 gives the one-turn experiment that closes it. |
| `Task` dispatch gives `kind: agent`, entity = subagent name | **CORRECTED** | The tool is **`Agent`**, not `Task`; `Task` occurs zero times in 19 builds. Entity is `input.subagent_type`. `TaskCreate`/`TaskUpdate`/`TaskList`/`TaskStop` are the background-task tracker — a `startsWith("Task")` matcher hits those 244 times and misses dispatch entirely. |
| §5.2 note: "plugin-scoped MCP naming is a real parsing trap" | **CONFIRMED** | And a second, larger trap found: the `Task`/`Agent` naming (above). |

### Reconciliation against §3.2, §5.1, §5.4

| Claim | Verdict | Actual |
|---|---|---|
| §3.2: `~/.claude/projects/**/*.jsonl` — invocation analytics | **CORRECTED** | Glob is right, scope is wider than assumed: 384 files, of which 324 are subagent sidecars holding 46% of assistant records, plus non-transcript plugin `.jsonl` files that must be probe-rejected. |
| §3.2: "unstable, undocumented" | **CONFIRMED — and less unstable than feared** | Undocumented, yes. But the entire envelope (`type`, `uuid`, `timestamp`, `sessionId`, `isSidechain`, `cwd`, `version`, `gitBranch`, `parentUuid`, `userType`, `entrypoint`) is present in **19/19** builds spanning 2.1.197 to 2.1.220, and `message.content` is an array in 45,850/45,850 assistant records. Risk R1 is real but the core shape held across 19 releases. |
| §5.1: "Transcripts are append-only JSONL" | **CONFIRMED** | 0 parse failures in 276,870 lines; state records re-appended rather than mutated; compaction appends a boundary inline without truncating. Keep the `size < offset` re-index guard anyway. |
| §5.1: `invocations.ts INT` | **CORRECTED** | `timestamp` is an ISO-8601 **string** with ms and `Z`. Must be `Date.parse()`-converted on write. |
| §5.1: `sessions.id TEXT PRIMARY KEY` | **CONFIRMED, with a caveat** | `sessionId` equals the filename stem in 241,346/241,346 top-level records. But sidecars **reuse the parent's `sessionId`**, so `sessionId` is not 1:1 with file. `files.path` remains the correct PK for `files`; `sessions.id` is correct as-is. |
| §5.1: `invocations(session_id, ts, kind, entity, plugin, tool)` | **needs 2 columns** | Add `is_sidechain` and `agent_id` — without them, subagent activity cannot be separated from main-thread activity. |
| §5.3: `sessionsLoaded` modelled | **possibly measurable** | `attachment.skill_listing` carries a full 555-name enumeration with `isInitial`. Defer to T0.4. |
| §5.4: one adapter, schema probe, `{available:false, reason}` | **CONFIRMED as the right design** | A concrete probe is proposed in §5. The silent-zero failure mode (§5) is the specific reason this isolation matters. |

---

## 8. Downstream impact

| Task | Impact |
|---|---|
| **T4.1** | Probe specified (§5). Probe **per file**, not once globally; store the per-file `version`. Must reject the non-transcript `.jsonl` files under `projects/**` (§1.1). |
| **T4.2** | `invocations` needs `is_sidechain INT` and `agent_id TEXT`. `ts` is a parsed ISO-8601 string, not a native int (§5.1 corrected). |
| **T4.3** | Enumerate **both** `<project>/*.jsonl` and `<project>/<session>/subagents/*.jsonl` — the latter is 324 of 384 files and 46% of assistant records. Skip `attachment` records early (57% of the corpus) for the T4.15 perf target. Keep a `size < storedOffset` rebuild-file guard. |
| **T4.4** | **One correction, one open item.** (1) `Task` becomes **`Agent`** — never prefix-match `Task` (§3.5). (2) Build `kind: command` against the `<command-name>` string carrier and filter CLI built-ins, but treat command coverage as **unconfirmed** until a plugin/personal command invocation is observed — the one-turn experiment in §3.4 should run before this task starts. Skill extraction is unchanged and confirmed. |
| **T4.5** | Both MCP forms confirmed. `split('__')` is safe for server/tool (3 segments, always). It is **not** safe for plugin/server inside `plugin_<p>_<s>` — cross-reference `claude plugin list --json`, or prefer `attributionMcpServer`, which carries the canonical `plugin:<plugin>:<server>` string. |
| **T4.6** | **Gets much easier.** `attributionSkill` plus `attributionPlugin`, and `attributionMcpServer`, supply owner attribution directly, in 11–14 of 19 builds. Use as enrichment with a filesystem fallback for older records — never as the counting source. |
| **T4.10** | **Buildable.** Per-tool MCP invocation is fully distinguishable (§4). Caveat: `N` (tools exposed) is not in transcripts — source it from the MCP collector, else degrade to "M called" with no denominator. |
| **T4.11 / T4.12** | `usage commands` ships with an explicit "command invocation recording is unconfirmed" caveat, and commands are **excluded from the `--unused` prune ranking** until §3.4 is closed — otherwise `--unused` recommends pruning the user's entire command library on zero evidence. `usage agents` works but must key on `Agent`/`subagent_type`. `--unused` for skills is well-supported (14 of 555 listed skills ever invoked), which is exactly the headline F3 wants. |
| **T0.4** | `attachment.skill_listing` (`skillCount`, `names[]`, `isInitial`) plus `agent_listing_delta` / `deferred_tools_delta` / `mcp_instructions_delta` suggest `sessionsLoaded` may be **measured**, not modelled. Changes §5.3's `passiveCost`. |
| **T0.6** | Fixture stamp: **Claude Code 2.1.197 – 2.1.220**, corpus 384 files / 276,870 records, captured 2026-07-31. |
| **T5.x (export)** | Not in scope, but noted: `attachment.hook_success.command` embeds full hook command lines, and `tool-results/*.txt` sidecars hold raw tool output. Both are redaction hazards if transcripts are ever touched by export. |
