/**
 * Secret detection — T1.16 (doctor) and T5.5/T5.6/T5.7 (export). 🔒
 *
 * **One implementation, two consumers**, for the same reason the project path
 * normaliser is shared: built twice, the doctor and the exporter would
 * disagree about what a secret is, and the disagreement that matters is the
 * one where doctor says a config is clean and export ships a token. T5.5
 * becomes wiring around this, not a second heuristic, and T5.7's 200-config
 * fuzz corpus then tests a single thing.
 *
 * ## The union of three heuristics, and why none may gate another
 *
 * The synthetic oracle (`fixtures/synthetic/secrets/`) is explicit about this,
 * and every claim below is measured there rather than assumed:
 *
 * - **prefix** — a known credential prefix. **Sufficient on its own.** The
 *   oracle ships `POS-github-token-legacy`, a real-shaped `ghp_` token at
 *   **2.06 bits/char** — lower than every other value in the repository. A
 *   detector that requires prefix AND entropy misses it, and would miss any
 *   real token containing a long repeated run.
 * - **shape** — a JWT triplet, a PEM block, or a URL carrying userinfo. Four
 *   of the seventeen positives are shape-only.
 * - **entropy** — a **weak tiebreak**, applicable only to what survives the
 *   structural exclusions below.
 *
 * ## Entropy alone cannot work, and this is proved rather than argued
 *
 * From the oracle's `negative-cases.json`: a threshold must be ≤ 4.7719 to
 * catch `POS-aws-secret-access-key`, and > 5.0225 to clear `NEG-base64-icon`
 * (a 542-char data URI, the highest-entropy value in the whole corpus,
 * positive or negative). **No such number exists.** Dropping the threshold to
 * 4.5 additionally flags `NEG-windows-install-path` at 4.52 — a redacted
 * install path present on every plugin record in both layers, i.e. a
 * guaranteed false positive on every machine.
 *
 * Length gating does not rescue it: both offending negatives are long (542 and
 * 70 chars), so a `length >= 32` precondition admits both.
 *
 * What separates them is **structure, not magnitude**. So the order here is:
 * recognise and exclude the known-benign forms first, then apply entropy only
 * to what is left. Hex alphabets cap at 4.0 bits/char, which spares every git
 * SHA automatically — but that is a property of the alphabet, not evidence of
 * a well-chosen threshold, and it does not extend to base64 digests (~5.9).
 */

/** How a value was identified. A finding may satisfy more than one. */
export type SecretHeuristic = 'prefix' | 'shape' | 'entropy';

export interface SecretFinding {
  /** Dotted path to the value, e.g. `mcpServers.github.env.GITHUB_TOKEN`. */
  readonly location: string;
  readonly heuristics: SecretHeuristic[];
  /** What fired, for the message. Never the value itself. */
  readonly evidence: string;
  /** Shannon bits per character, when measured. Diagnostic only. */
  readonly entropyBitsPerChar?: number;
  /**
   * A safe rendering: first 4 and last 2 characters, middle elided. Never the
   * whole value — a doctor report is something users paste into issues, and a
   * tool that prints the token it just warned you about has leaked it twice.
   */
  readonly redacted: string;
}

// ---------------------------------------------------------------------------
// Prefixes
// ---------------------------------------------------------------------------

/**
 * Known credential prefixes. Sufficient evidence on their own.
 *
 * `Bearer ` **includes the trailing space deliberately**: a bare `Bearer`
 * match hits ordinary prose — the oracle's `NEG-bearer-as-english` is the
 * sentence "Bearer token support is documented in the README."
 */
const PREFIXES: readonly string[] = [
  'sk-ant-',
  'sk-',
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'github_pat_',
  'xoxb-',
  'xoxp-',
  'xoxa-',
  'AKIA',
  'Bearer ',
];

// ---------------------------------------------------------------------------
// Structural exclusions — applied BEFORE entropy, never after
// ---------------------------------------------------------------------------

/** 40 or 64 hex characters: git SHA, `.gcs-sha`, `source.sha`. */
const HEX_DIGEST = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/iu;

/** 8-4-4-4-12. Every session id and transcript filename on the machine. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** ISO-8601. On every plugin record and every timeline transcript record. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/u;

/** `data:` URIs. The highest-entropy value in the corpus is one of these. */
const DATA_URI = /^data:/iu;

/**
 * A filesystem path. `NEG-windows-install-path` measures 4.52 bits/char and
 * appears on every plugin record in both layers, so missing this exclusion
 * means a false positive on every machine, several times over.
 */
const FILESYSTEM_PATH = /^(?:[a-z]:[\\/]|[\\/]|<HOME>|~[\\/]|\.{1,2}[\\/])/iu;

/**
 * A **scoped** npm package specifier, optionally versioned:
 * `@modelcontextprotocol/server-sequential-thinking`, `@upstash/context7-mcp@2.1.4`.
 *
 * The `@scope/` prefix is required. An earlier version of this pattern allowed
 * a bare word — `^@?[a-z0-9][\w.-]*…` — which matches almost any alphanumeric
 * string and therefore swallowed most of the oracle's positives before the
 * entropy heuristic ever saw them, silently downgrading six findings to
 * prefix-only. Unscoped bare names need no exclusion: they are short, and the
 * entropy path never runs below 32 characters.
 */
const PACKAGE_SPECIFIER = /^@[a-z0-9][\w.-]*\/[\w.-]+(?:@[\w.-]+)?$/iu;

/**
 * Indirection, not a literal. `${GITHUB_TOKEN}` and `${user_config.sync_token}`
 * are the **approved** ways to carry a token (`02-architecture.md` §4.2), and
 * `CLAUDE_PLUGIN_OPTION_*` is the variable a hook is required to read. Flagging
 * any of them punishes the correct configuration and teaches users to ignore
 * the detector — the most expensive failure mode a security check has.
 */
const INDIRECTION = /^\$\{[^}]*\}$|^\$[A-Z_][A-Z0-9_]*$|^CLAUDE_PLUGIN_OPTION_[A-Z0-9_]*$/u;

/**
 * Prose. **The single most productive exclusion**, and the one that is easy to
 * omit because the corpus's own documentation strings are the trigger.
 *
 * An opaque credential does not contain whitespace. Natural language always
 * does, and long enough natural language clears any workable entropy
 * threshold: the oracle ships `NEG-long-description` at 4.34 bits/char as the
 * prose control, and the fixture files' own `__models` narration runs higher
 * still — twelve values over 4.5 across three files.
 *
 * Safe for every entropy-only positive, which are opaque tokens by
 * construction. Multi-line secrets are not lost: a PEM block contains
 * newlines and is caught by `shape`, which is evaluated independently and is
 * never gated by these exclusions.
 */
const CONTAINS_WHITESPACE = /\s/u;

/**
 * A URL with **no** userinfo component.
 *
 * Found by the real corpus, not by the synthetic oracle, whose negatives
 * happen to contain no plain URLs: `https://github.com/wonderwhy-er/
 * DesktopCommanderMCP.git` measures 4.55 bits/char and every one of the 276
 * available plugin entries carries a source URL. Without this the detector
 * fires hundreds of times on an untouched machine.
 *
 * Safe because the URL that *is* a credential — one carrying `user:password@`
 * — is caught by `shape`, which is evaluated independently and is never gated
 * by these exclusions. So this excludes the benign form specifically rather
 * than URLs as a class.
 */
const PLAIN_URL = /^[a-z][\w+.-]*:\/\/[^@\s]*$/iu;

function isStructurallyBenign(value: string): boolean {
  return (
    CONTAINS_WHITESPACE.test(value) ||
    PLAIN_URL.test(value) ||
    HEX_DIGEST.test(value) ||
    UUID.test(value) ||
    ISO_TIMESTAMP.test(value) ||
    DATA_URI.test(value) ||
    FILESYSTEM_PATH.test(value) ||
    INDIRECTION.test(value) ||
    PACKAGE_SPECIFIER.test(value)
  );
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Three base64url segments. Header and payload must both decode-ish. */
const JWT = /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/u;

const PEM = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u;

/**
 * A URL carrying a userinfo component — `scheme://user:password@host`.
 *
 * The password group is required, and `@` is excluded from both userinfo
 * segments: `NEG-package-name-versioned` is `@upstash/context7-mcp@2.1.4`, and
 * a matcher that allows `@` inside userinfo reads its second `@` as the
 * host separator and reports a package name as a credential.
 */
const URL_USERINFO = /^[a-z][\w+.-]*:\/\/[^/@:\s]+:[^/@\s]+@[^/\s]+/iu;

function shapeOf(value: string): string | undefined {
  if (JWT.test(value)) return 'a JWT';
  if (PEM.test(value)) return 'a PEM private key block';
  if (URL_USERINFO.test(value)) return 'a URL with an embedded password';
  return undefined;
}

// ---------------------------------------------------------------------------
// Entropy
// ---------------------------------------------------------------------------

/** Shannon entropy in bits per character, over the value's own alphabet. */
export function shannonBitsPerChar(value: string): number {
  if (value.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);

  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * The tiebreak threshold, applied **only** to values that survived every
 * structural exclusion.
 *
 * 4.5 is below the lowest entropy-only positive (4.7719) with margin, and the
 * two negatives it would otherwise catch — the data URI at 5.02 and the
 * install path at 4.52 — are both excluded structurally before they get here.
 * That is the whole design: the threshold is safe *because* it never sees them,
 * not because the number is clever.
 */
const ENTROPY_THRESHOLD = 4.5;

/** Below this, a value is too short for entropy to mean anything. */
const ENTROPY_MIN_LENGTH = 32;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Does what follows the prefix actually look like a credential?
 *
 * Only `Bearer ` needs this, and it needs it badly. The prefix carries a
 * trailing space by design, so it also matches the sentence "Bearer token
 * support is documented in the README." — the oracle's
 * `NEG-bearer-as-english`, and a phrase that appears in real skill and plugin
 * descriptions. The remainder must therefore be a single opaque run, not a
 * sentence.
 *
 * Every other prefix is its own evidence: nothing benign starts `ghp_` or
 * `AKIA`, so they are accepted unconditionally rather than being subjected to
 * a length rule that the 2.06 bits/char legacy token might one day fail.
 */
function bearsACredential(prefix: string, value: string): boolean {
  if (!prefix.endsWith(' ')) return true;

  const remainder = value.slice(prefix.length).trim();
  return remainder.length >= 8 && !CONTAINS_WHITESPACE.test(remainder);
}

/** First 4 and last 2 characters. Never enough to use, always enough to find. */
export function redact(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars)`;
}

/**
 * Inspects one value. Returns every heuristic that fired, or `undefined`.
 *
 * Prefix and shape are evaluated **before** the structural exclusions and are
 * never gated by them: a token is a token even if it happens to look like
 * something else. Only the entropy path is exclusion-gated.
 */
export function inspectValue(location: string, value: unknown): SecretFinding | undefined {
  if (typeof value !== 'string' || value === '') return undefined;

  const heuristics: SecretHeuristic[] = [];
  const evidence: string[] = [];

  const prefix = PREFIXES.find((candidate) => value.startsWith(candidate));
  if (prefix !== undefined && bearsACredential(prefix, value)) {
    heuristics.push('prefix');
    evidence.push(`starts with "${prefix}"`);
  }

  const shape = shapeOf(value);
  if (shape !== undefined) {
    heuristics.push('shape');
    evidence.push(`looks like ${shape}`);
  }

  // Once prefix or shape has fired, the value is already known to be a
  // credential and the structural exclusions are skipped — they exist to stop
  // entropy misfiring on benign data, not to suppress corroborating evidence
  // on something already identified. Without this, the whitespace rule strips
  // `entropy` from a `Bearer <token>` value that the oracle records as
  // prefix+entropy. Length still gates: entropy under 32 chars means nothing.
  const alreadyIdentified = heuristics.length > 0;

  let entropyBitsPerChar: number | undefined;
  if (value.length >= ENTROPY_MIN_LENGTH && (alreadyIdentified || !isStructurallyBenign(value))) {
    entropyBitsPerChar = shannonBitsPerChar(value);
    if (entropyBitsPerChar >= ENTROPY_THRESHOLD) {
      heuristics.push('entropy');
      evidence.push(`${entropyBitsPerChar.toFixed(2)} bits/char over ${value.length} chars`);
    }
  }

  if (heuristics.length === 0) return undefined;

  return {
    location,
    heuristics,
    evidence: evidence.join('; '),
    ...(entropyBitsPerChar !== undefined ? { entropyBitsPerChar } : {}),
    redacted: redact(value),
  };
}

/**
 * Walks an arbitrary JSON structure, inspecting every string value.
 *
 * **Every string, not just `env`.** The oracle is emphatic: 3 of its 17
 * positives sit outside any `env` object — two in `args`/`url` and one in
 * `pluginConfigs` — so an `env`-only scan scores 14/17 *and reports two
 * servers clean that are not*. A partial scan that says "clean" is worse than
 * no scan, because it is believed.
 *
 * Object keys are not inspected. `NEG-plugin-option-env-name` is the variable
 * name `CLAUDE_PLUGIN_OPTION_SYNC_TOKEN`, which is required by the approved
 * configuration and appears as a key.
 */
/**
 * Keys safe to write after a dot. Anything else takes bracket notation.
 *
 * Hyphens are permitted: MCP server names are hyphenated throughout
 * (`synthetic-github`), and bracketing them would make every ordinary path
 * unreadable. What forces brackets is a character that breaks dotted reading —
 * a dot, a separator, a drive colon, an `@`, or whitespace.
 */
const PLAIN_KEY = /^[A-Za-z_$][\w$-]*$/u;

/**
 * Renders one path segment.
 *
 * `~/.claude.json` is keyed by absolute path — `projects["C:\\a\\b"]` — and
 * `pluginConfigs` by `plugin@marketplace`. Joining those with a dot produces a
 * path the reader cannot follow back to the value, which is the only thing a
 * location is for. Bracket-quoted form matches the oracle's notation.
 */
function segment(key: string, first: boolean): string {
  if (PLAIN_KEY.test(key)) return first ? key : `.${key}`;
  return `[${JSON.stringify(key)}]`;
}

export function scanValue(root: unknown, basePath = ''): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seen = new WeakSet<object>();

  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      const finding = inspectValue(path, node);
      if (finding !== undefined) findings.push(finding);
      return;
    }

    if (typeof node !== 'object' || node === null) return;

    // A config file cannot contain a cycle, but this also runs over objects a
    // caller assembled, and a scanner that hangs on a bad input is a scanner
    // that stops being run.
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }

    for (const [key, item] of Object.entries(node)) {
      walk(item, path === '' ? segment(key, true) : `${path}${segment(key, false)}`);
    }
  };

  walk(root, basePath);
  return findings;
}
