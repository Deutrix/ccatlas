# `fixtures/synthetic/` — constructed fixtures, not captures

> 🔴 **Nothing here was captured from a machine.**
>
> `fixtures/cli/`, `fixtures/files/` and `fixtures/transcripts/` hold **real** output and are the regression baseline for TX.2. This directory holds **constructed** fixtures that exist only to exercise behaviour the reference machine cannot witness.
>
> **Never diff a synthetic fixture against live output. Never cite one as evidence of a format.** A synthetic fixture mistaken for a real capture corrupts the baseline, which is the worst outcome this corpus can produce.

Task **T1.29**. Every file fills a specific row of `docs/FORMATS.md` §5 "Known gaps" — nothing here is speculative coverage.

## The four gaps

| Directory | Gap it fills (`FORMATS.md` §5) | Unblocks | Oracle |
|---|---|---|---|
| [`precedence/`](precedence/README.md) | *"No project-scope `.claude/settings.json`, no local-scope plugin keys, `pluginConfigs` absent"* | **T1.2** | `precedence/expected-precedence.json` |
| [`skills-dir-plugin/`](skills-dir-plugin/README.md) | *"No `@skills-dir` plugin exists locally"* | **T1.4** | `skills-dir-plugin/expected-detection.json` |
| [`secrets/`](SECRETS-README.md) | *"Every `env` object is empty across all scopes"* | **T1.16**, T5.5–T5.7 | `secrets/expected-findings.json` |
| [`scale/`](scale/README.md) | *"Only 4 marketplaces / 5 plugins — do not certify 📏 perf gates"* | **T1.11** | `generate.mjs verify` |

`MANIFEST.json` indexes every file with its gap and task.

## 🔒 Before you read `secrets/`

It contains strings that look exactly like API keys, private keys and database URLs. **None is real.** Every one carries the literal sentinel `SYNTHETIC` and every host is `.invalid`.

**Read [`SECRETS-README.md`](SECRETS-README.md) first** — it states the convention, and it states the requirement that this directory be excluded from any credential scan the repository adopts (a requirement, not a description: no such scan exists yet).

## Self-identification

Every file whose format tolerates unknown keys carries `__synthetic: true` and a `__models` block naming the gap it fills and the task it unblocks.

Four kinds of file cannot carry it, and are indexed in `MANIFEST.json → markerPolicy` instead. The most important: the `@skills-dir` plugin's `.claude-plugin/plugin.json`. Adding a marker there makes `claude plugin validate --strict` **fail** — verified live: unknown manifest fields produce a warning, and `--strict` promotes warnings to errors. That is a genuine constraint, not an oversight.

## Verifying

```bash
node fixtures/synthetic/generate.mjs verify
```

Twelve checks (V1–V12), exit 1 on any failure:

- **V1–V7** — the scale tree: byte-identical regeneration, cross-file bookkeeping, `installPath` resolvability, `.in_use` directory-ness, reference-scale floors, orphan correctness.
- **V8** — every entropy figure quoted in `secrets/*.json` matches recomputation, *and* the derived claims in `entropyFinding` still equal the measured extremes. An earlier draft of this corpus asserted a separating threshold that its own shipped data contradicted; V8 exists so that cannot recur.
- **V9** — every credential-shaped string anywhere in this directory carries the `SYNTHETIC` sentinel.
- **V10** — every `.json` self-identifies, or matches a documented exemption pattern.
- **V11** — the precedence golden re-derives from its four settings files, and each `definedAt` matches reality.
- **V12** — the `@skills-dir` detection counts hold (6 files named `plugin.json`, exactly 1 a Claude Code manifest).

The two oracles are hand-written, so V11 and V12 exist to stop them drifting from the fixtures they describe. Neither implements T1.2 or T1.4 — they check self-consistency, which is what makes the oracles safe to gate on.

Zero dependencies — `node:*` only, matching the project's constraint.

## What is deliberately absent

Honest gaps beat invented shapes. `MANIFEST.json → notBuilt` is the full list; the ones that matter:

- **No `plugin details` cost output** for any synthetic plugin. The token estimator has three observed regimes ~40% apart (`FORMATS.md` §0 trap #3); fabricated figures would certify T4.7/T4.8 against invented numbers.
- **No `{source, url, path, ref, sha}` marketplace source.** Its key set is observed but the literal value of its `source` discriminator was never captured. `FORMATS.md` §5's *"Non-`github` marketplace source types"* row **remains open**.
- **Merge granularity for settings Records is unresolved**, not guessed. The precedence oracle labels both models and ships entries that discriminate them.
- **No third-party marketplace corpus** for T2.11 and **no synthetic transcripts** — both explicitly out of scope.
