# 🔒 Synthetic credentials in this directory — read before you panic

`fixtures/synthetic/secrets/` contains strings that look exactly like API keys, tokens, private keys and database URLs.

**None of them is real. Not one.** They were constructed to make secret detection testable, because the machine this project's fixture corpus came from had **nothing to detect**: every `env` object was empty across user scope, all 12 project-scope MCP configs, and the `.mcp.json` in the ECC clone (`fixtures/files/FINDINGS.md` §7). There was no credential to leak — and equally no positive fixture for T1.16.

---

## The sentinel convention

**Every synthetic credential value in this repository contains the literal uppercase token `SYNTHETIC`.**

That single rule is what lets a human, a `grep`, and a future incident responder each reach the same conclusion in seconds:

```bash
# Every credential-shaped value under fixtures/synthetic/ contains SYNTHETIC.
# If this prints nothing, every one of them is accounted for.
grep -rInE 'sk-[A-Za-z0-9-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xoxb-[0-9]{6,}-[0-9]{6,}-[A-Za-z0-9]{10,}|AKIA[A-Z0-9]{12,}|Bearer [A-Za-z0-9._~+/-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|BEGIN [A-Z ]*PRIVATE KEY|[a-zA-Z][a-zA-Z0-9+.-]*://[^[:space:]/@:\"]+:[^[:space:]/@\"]+@' \
  fixtures/synthetic/ | grep -v SYNTHETIC
```

The length quantifiers are load-bearing: without them the pattern matches its own definition in `lib/entropy.mjs` and reports a false alarm on itself. This is the same pattern check **V9** enforces (`generate.mjs verify`), which is the authoritative form — the shell version is for a responder who has a checkout and no Node.

Rules the sentinel obeys:

1. **It is in the value, not in a comment.** A comment can be stripped, reformatted, or lost in a copy-paste. The value carries its own provenance.
2. **It survives decoding.** The JWT's payload base64url-decodes to JSON containing `"sub":"SYNTHETIC-FIXTURE"`. A responder who decodes the token sees the sentinel, not a plausible subject.
3. **It sits after the prefix, never instead of it.** `ghp_SYNTHETIC…` keeps the real `ghp_` prefix so prefix detection is genuinely exercised, while making the value unusable and unmistakable.
4. **Every host is `.invalid`.** RFC 2606 reserves `.invalid` as permanently non-resolvable. No synthetic URL can ever reach a real service, even by accident.
5. **Deliberately fake numbers.** Slack ids are `2109876543210`; AWS regions are real strings but the key ids are not.

### The sentinel must not defeat the detector

The obvious sentinel — `ghp_SYNTHETIC0000000000000000000000` — has **Shannon entropy of 2.06 bits/char**. The zero run destroys it. That value is fine for testing *prefix* detection and useless for testing *entropy* detection, and fatal if a detector requires prefix **and** entropy.

So the corpus carries both, on purpose:

| | value | entropy | tests |
|---|---|---|---|
| `POS-github-token-legacy` | `ghp_SYNTHETIC000…` | **2.06** | prefix detection *alone* |
| `POS-github-pat-classic` | `ghp_SYNTHETICvclug…` | 4.53 | prefix **and** entropy |
| `POS-generic-service-token` | `SYNTHETICh6vXzFf…` | 5.19 | entropy *alone* — no prefix, no shape |

Every entropy figure quoted anywhere in this directory was **computed from the shipped bytes**, never estimated. Recompute them all with:

```bash
node fixtures/synthetic/generate.mjs verify
```

### 🔴 What the measurement actually showed

**No Shannon-entropy threshold separates the two populations.** The corpus breaks it from both ends:

- **From below** — the lowest-entropy true positive, `AKIASYNTHETICMOEAA57` at **3.62** bits/char, sits under nine of the fifteen negatives. Only its `AKIA` prefix identifies it.
- **From above** — the highest-entropy value in the whole corpus is a **negative**: a base64 PNG data URI at **5.02** bits/char, out-ranking every true positive but one. Second-highest is a **redacted Windows install path at 4.52**, copied from the real fixtures and present on every plugin record ccatlas will ever read.

A threshold must be ≤ 4.77 to catch the AWS secret key and > 5.02 to clear the data URI. **No such number exists.** A length ≥ 32 precondition does not rescue it — both offending negatives are long (542 and 70 chars).

Entropy is a weak tiebreak for long, unprefixed, *unstructured* values. Structure is what separates: the `data:` scheme, the path separators, the UUID grouping, the fixed-length pure hex. Recognise and exclude those forms first, then apply entropy to what remains.

`secrets/negative-cases.json → entropyFinding` has the full derivation, and check **V8** asserts its four quoted extremes still equal the measured ones — so the claim cannot drift from the data.

---

## Negative cases matter as much as positives

A secret detector that fires on everything is worse than none, because T5.5–T5.7 make export **fail closed** — a false positive blocks the bundle and the user cannot ship.

`secrets/negative-cases.json` holds 15 must-not-flag values. Six are copied **verbatim out of the real fixtures**:

- four `gitCommitSha` values (40-char hex) from `fixtures/files/installed_plugins.json`
- the `.gcs-sha` from `claude-plugins-official`
- a marketplace `source.sha` — the single most common 40-hex string in the corpus, 221 occurrences in one marketplace

**A detector that flags 40-hex-plus-entropy flags the existing repository.** These are public commit identifiers, load-bearing for T2.2 and T2.4, and they are already committed.

Two more deserve naming: `${user_config.sync_token}` and `CLAUDE_PLUGIN_OPTION_SYNC_TOKEN` are the **sanctioned** way to carry a token (`docs/02-architecture.md` §4.2). Flagging them makes the approved pattern unusable and pushes authors back to literals — the detector would cause the vulnerability it exists to prevent.

---

## ⚠️ Requirement on the repository leak scan

**`fixtures/synthetic/**` must be excluded from any credential/leak scan this repository adopts.**

Stated precisely, because the control does not exist yet: as of this writing `scripts/` contains only `build.mjs` and `.github/workflows/ci.yml` has **no secret-scanning step**. The T0.5 sweep and the lead's corpus-wide re-verification were run by hand. So this is a **requirement on the scan when it is added**, not a description of one already in place.

**Why the exclusion is necessary.** The whole point of this directory is to contain strings that a credential detector fires on. Without an exclusion:

1. the scan fails on every run, permanently red;
2. contributors learn to ignore it — and a real leak lands unnoticed;
3. someone "fixes" it by neutering the fixtures, and T1.16 quietly stops being tested.

**Why the exclusion is safe.** Every value carries the `SYNTHETIC` sentinel, every host is `.invalid`, and the grep at the top of this file proves the invariant in one command. The exclusion is auditable, not a leap of faith.

**Suggested shape** — narrow, path-scoped, and paired with an invariant check so the exclusion cannot be used to smuggle anything in:

- exclude the path `fixtures/synthetic/**` from the credential scan;
- add a **positive** CI check that every credential-shaped match under `fixtures/synthetic/**` contains `SYNTHETIC` (the grep above, asserted to produce no output);
- keep `fixtures/cli/**`, `fixtures/files/**` and `fixtures/transcripts/**` **in** scope — those are real captures and must stay scanned.

For third-party tooling: `gitleaks` honours a `.gitleaksignore` / `[allowlist] paths`, GitHub secret scanning honours `secret_scanning.yml` `paths-ignore`, and `trufflehog` takes `--exclude-paths`. Whichever is adopted, pair it with the positive invariant check above.

---

## Rules for anyone editing these fixtures

- **Never** paste a real credential here, not even a revoked or expired one.
- Every new credential-shaped value **must** contain `SYNTHETIC` and use a `.invalid` host.
- Record its measured entropy in `secrets/expected-findings.json`; do not estimate it.
- Add the paired negative at the same time. A positive without its control teaches the detector the wrong lesson.
- Re-run `node fixtures/synthetic/generate.mjs verify` before committing.

## If you are an incident responder

You found a token-shaped string in this repository. Check three things, in order:

1. Is the path under `fixtures/synthetic/`? → synthetic by construction.
2. Does the value contain `SYNTHETIC`? → synthetic, confirmed at the value level.
3. Is the host `.invalid`? → cannot resolve, cannot authenticate anywhere.

If all three hold, no credential was exposed and no rotation is required. If **any** of them fails — particularly a token-shaped value under `fixtures/cli/`, `fixtures/files/` or `fixtures/transcripts/`, which are **real captures** — treat it as a genuine exposure and rotate.
