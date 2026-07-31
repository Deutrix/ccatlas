# Reference-scale tree — synthetic fixture

**Fills:** `docs/FORMATS.md` §5 / `docs/tasks.md` "Reference machine baseline" — *"Only 4 marketplaces / 5 plugins → **do not certify** T1.11's 📏 perf gates against this machine."*
**Unblocks:** T1.11 (`status --cached` <200 ms, cold `status` <2 s). Also feeds T1.3, T1.15, T1.25, T2.5.

> ⚠️ Generated, not captured. `./tree/` is a **filesystem**, not a text fixture — it is meant to be walked.

## Scale

| Dimension | This tree | T1.11 floor | Reference machine |
|---|---|---|---|
| Marketplaces | **6** | ≥5 | 4 ⚠️ |
| Plugins | **24** | ≥20 | 5 ⚠️ |
| Skills | **46** (40 personal + 6 plugin-contributed) | ≥30 | 161 ✅ |
| MCP servers | **14** (8 user + 2 project + 4 plugin-bundled) | ≥8 | 14 ✅ |
| Cache version dirs | 30 (24 live + 6 orphans) | — | 7 |
| Files | 140 | — | — |

`generate.mjs verify` asserts every floor, so the tree cannot silently drop below reference scale.

## Regenerating

```bash
node fixtures/synthetic/generate.mjs build       # rewrite ./tree/ from ./seed.json
node fixtures/synthetic/generate.mjs verify      # assert V1–V9; exit 1 on any failure
node fixtures/synthetic/generate.mjs materialize <dir>   # walkable copy, absolute paths resolved
```

**`./tree/` is committed in full — a test run needs no generation step.** `build` exists so the tree can be grown (edit `seed.json`, rebuild) and so `verify` has something to compare against.

`build` is **deterministic**: a seeded PRNG (`mulberry32`, `seed.prngSeed`) consumed in a fixed order, every timestamp derived from `seed.baseTimestampMs` with a fixed offset, explicit `\n`, and written (not sorted) key order matching the real captures. Re-running `build` on an unchanged `seed.json` produces byte-identical output — check **V1** asserts exactly that. This matters because `.gitattributes` marks `fixtures/** -text`, so nothing normalises line endings on checkout and any nondeterminism would show as a permanent diff.

`seed.json` is the **only** input. Do not hand-edit files under `./tree/` — `verify` fails on the first byte of drift.

## `<TREE_ROOT>` and why it is there

`installed_plugins.json → installPath` and `known_marketplaces.json → installLocation` are **absolute paths** in the real files. An absolute path cannot be committed. Those two fields therefore hold the token `<TREE_ROOT>` followed by native-Windows `\` separators — the same convention the real captures use for `<HOME>` (`fixtures/files/installed_plugins.json`).

**Everything else in the tree is a real, walkable directory.** The token appears in exactly two files and only in path-valued fields.

Two ways to consume it:

1. **Walk the tree directly** and substitute in your reader: `installPath.replace('<TREE_ROOT>', absoluteTreeRoot)`, splitting on `\`.
2. **`materialize <dir>`** — writes a copy with `<TREE_ROOT>` resolved to the destination and separators converted to the platform's. Use this for the T1.11 perf run; the paths then resolve with no substitution at all. (Substitution inside `.json` files is JSON-escaped, so the output still parses on both Windows and POSIX.)

## Traps reproduced on purpose

Each of these is a `docs/FORMATS.md` §0 trap. A perf gate run against a tree that lacks them measures the wrong work.

| Trap | Where it lives here |
|---|---|
| #11 — `.in_use` is a **directory** | Every one of the 30 version dirs. Contents are per-process lock files named `<pid>` holding `{"pid":N}` / `{"pid":N,"procStart":"…"}` — **observed live on 2026-07-31**, a detail `FORMATS.md` §2 does not yet record. `verify` V5 asserts the directory-ness. |
| #12 — `installed_plugins.json` values are **arrays**, one per scope | `sy-jade@synthetic-alpha` has **two** elements (`user` + `project`). A single-element array lets `[0]` pass; this one does not. |
| #13 — colliding `~/.claude.json` project keys | 12 project keys: 5 backslash, 7 forward-slash, drives `C:` **and** `E:`, and **three colliding pairs** (two by separator, one by case). |
| #17 — lossy project dir names | The 12 project keys name directories that do **not** exist in the tree — matching the real file, and giving T1.27 its orphaned-project finding. |
| Version `unknown` | `sy-cinder` — its `plugin.json` declares **no** `version`, the cache directory is literally `…/sy-cinder/unknown/`, and it is the one plugin with no `gitCommitSha`. Source is a relative path inside a non-git marketplace clone. |
| No `.git` on the biggest marketplace | `synthetic-official` carries `.gcs-sha` (one 40-hex line) and no `.git`, mirroring `claude-plugins-official`. |
| `renames` | Present only in `synthetic-official`'s manifest, mirroring the real one. Unresolved, a renamed plugin reads as removed + added. |
| Orphaned cache dirs | 6, each with a **stale `.in_use` mtime** and no `installed_plugins.json` reference (T1.15). `verify` V7 asserts both. |
| Disabled plugin | `sy-xenon@synthetic-echo` is `false` in `enabledPlugins`. That map is the **only** home of the enabled bit. |
| Double declaration | `sy-slate` diverges (`plugin.json` 2.5.0 vs marketplace entry 2.4.0 → `plugin.json` wins). `sy-umber` agrees (3.0.0 / 3.0.0) and is the **false-positive guard** T2.5 must not flag. |
| Plugin-bundled MCP | 3 plugins carry `<plugin-root>/.mcp.json` — verified live as the mechanism behind the CLI's nested `mcpServers` field. |

## ⚠️ mtimes do not survive git

`.in_use`'s **mtime is the liveness signal** (`FORMATS.md` §2), and the orphan/live distinction is expressed through it. `build` and `materialize` set those mtimes explicitly (live = base + 200 d, stale = base + 30 d), but **git does not preserve mtimes** — a fresh checkout stamps every file with the checkout time and the distinction is lost.

**Any test that depends on `.in_use` mtimes must run `build` or `materialize` first.** Tests that only depend on file *contents* can use the committed tree as-is. This is a real limitation of committing a filesystem fixture, not something the generator can fix.

## Shapes deliberately NOT reproduced

- **The `{source, url, path, ref, sha}` marketplace source variant** (78 of 276 entries in the real `available[]`). Its **key set** is observed, but the literal value of its `source` discriminator was never recorded — `fixtures/files/marketplace-manifest-shape.json` labels the category "git-subdir" as the fixture author's own classification, not as a captured value. Inventing one would certify T2.2's resolver against a discriminator that may not exist. The tree uses only the three shapes whose literal values *were* observed: a bare relative string, `{source:"url", url, sha}`, and `{source:"github", repo[, sha]}`. **This does not close the §5 gap on non-`github` source types.**
- **`plugin details` output.** No cost fixture accompanies any of the 24 plugins — the estimator has three regimes ~40% apart (`FORMATS.md` §0 trap #3) and fabricated figures would certify T4.7/T4.8 against invented numbers.
- **Transcripts.** The real corpus is 384 files / 276,870 records and is sufficient; nothing here is a transcript.
- **≥10 third-party marketplaces** for T2.11. Out of scope — that is Phase 2.
