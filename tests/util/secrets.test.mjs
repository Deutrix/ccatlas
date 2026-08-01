/**
 * T1.16 🔒 — secret detection, graded against the synthetic oracle.
 *
 * `fixtures/synthetic/secrets/expected-findings.json` is a real oracle, not a
 * sample: it names 17 positives across three files, 13 negative sites, and 15
 * further negative cases, and it records which single heuristic each positive
 * depends on. Drop any one heuristic and a specific, named finding disappears
 * — so the tests below assert per-finding rather than on a total, which would
 * let a detector trade a miss for a false positive and stay green.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { inspectValue, redact, scanValue, shannonBitsPerChar } from '../../src/util/secrets.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const secrets = path.join(repoRoot, 'fixtures', 'synthetic', 'secrets');

const load = (name) => JSON.parse(readFileSync(path.join(secrets, name), 'utf8'));

const ORACLE = load('expected-findings.json');
const NEGATIVES = load('negative-cases.json');

/** The three scanned files, keyed as the oracle refers to them. */
const CORPUS = {
  './mcp-json-with-credentials.json': load('mcp-json-with-credentials.json'),
  './claude-json-mcp-fragment.json': load('claude-json-mcp-fragment.json'),
  './settings-env-with-credentials.json': load('settings-env-with-credentials.json'),
};

/** Every finding the detector produces across the whole corpus, by location. */
const found = new Map();
for (const [file, contents] of Object.entries(CORPUS)) {
  for (const finding of scanValue(contents)) found.set(`${file}::${finding.location}`, finding);
}

// ---------------------------------------------------------------------------
// Every expected positive, individually
// ---------------------------------------------------------------------------

for (const expected of ORACLE.expectedFindings) {
  test(`detects ${expected.id}`, () => {
    const key = `${expected.file}::${expected.location}`;
    const finding = found.get(key);

    assert.ok(finding, `missed ${expected.id} at ${expected.location}`);

    // The oracle records which heuristics SHOULD fire. A detector that finds
    // the value by luck — entropy on something the oracle says is prefix-only
    // — is not the detector that was specified, and will miss the next one.
    for (const heuristic of expected.heuristics) {
      assert.ok(
        finding.heuristics.includes(heuristic),
        `${expected.id}: expected ${heuristic}, got [${finding.heuristics.join(', ')}]`,
      );
    }
  });
}

test('all 17 oracle positives are found, and nothing extra is', () => {
  assert.equal(found.size, ORACLE.counts.expectedFindings);
});

// ---------------------------------------------------------------------------
// The load-bearing single-heuristic cases
// ---------------------------------------------------------------------------

test('prefix alone is sufficient — the 2.06 bits/char token', () => {
  // POS-github-token-legacy. Lower entropy than every other value in the
  // repository, synthetic or real. A detector that ANDs prefix with entropy
  // misses it, and would miss any real token with a long repeated run.
  const legacy = ORACLE.expectedFindings.find((f) => f.id === 'POS-github-token-legacy');
  const finding = found.get(`${legacy.file}::${legacy.location}`);

  assert.ok(finding);
  assert.ok(finding.heuristics.includes('prefix'));
  assert.ok(legacy.entropyBitsPerChar < 2.1, 'the oracle value drifted; re-run generate.mjs verify');
});

test('shape alone is sufficient — a password inside a URL', () => {
  const finding = inspectValue('args[3]', 'postgres://user:pass@db.example.com:5432/app');
  assert.ok(finding);
  assert.deepEqual(finding.heuristics, ['shape']);
});

test('entropy alone catches an unprefixed, unstructured token', () => {
  const entropyOnly = ORACLE.expectedFindings.filter(
    (f) => f.heuristics.length === 1 && f.heuristics[0] === 'entropy',
  );
  assert.ok(entropyOnly.length > 0, 'the oracle no longer ships an entropy-only positive');

  for (const expected of entropyOnly) {
    const finding = found.get(`${expected.file}::${expected.location}`);
    assert.ok(finding, `missed entropy-only ${expected.id}`);
    assert.deepEqual(finding.heuristics, ['entropy']);
  }
});

// ---------------------------------------------------------------------------
// Negatives — the expensive half
// ---------------------------------------------------------------------------

for (const negative of NEGATIVES.cases) {
  test(`does not flag ${negative.id}`, () => {
    const finding = inspectValue('some.key', negative.value);
    assert.equal(
      finding,
      undefined,
      `false positive on ${negative.id}: ${finding?.evidence ?? ''}`,
    );
  });
}

test('the two threshold-breaking negatives are excluded STRUCTURALLY, not by luck', () => {
  const dataUri = NEGATIVES.cases.find((c) => c.id === 'NEG-base64-icon');
  const installPath = NEGATIVES.cases.find((c) => c.id === 'NEG-windows-install-path');

  // Both measure ABOVE the entropy threshold. They are clean only because the
  // structural exclusions run first — which is the whole design, and the
  // reason the threshold can be a safe number rather than a clever one.
  assert.ok(shannonBitsPerChar(dataUri.value) > 4.5);
  assert.ok(shannonBitsPerChar(installPath.value) > 4.5);
  assert.equal(inspectValue('k', dataUri.value), undefined);
  assert.equal(inspectValue('k', installPath.value), undefined);
});

test('the approved ways to carry a token are never flagged', () => {
  // 02-architecture.md §4.2 makes these the CORRECT configuration. Flagging
  // them punishes the right answer and teaches users to ignore the detector —
  // the most expensive failure mode a security check has.
  for (const value of [
    '${user_config.sync_token}',
    '${GITHUB_TOKEN}',
    '$GITHUB_TOKEN',
    'CLAUDE_PLUGIN_OPTION_SYNC_TOKEN',
  ]) {
    assert.equal(inspectValue('env.TOKEN', value), undefined, `flagged ${value}`);
  }
});

test('every 40-hex digest in the corpus is clean', () => {
  // git SHA, .gcs-sha and source.sha — 221 occurrences of the last in one
  // marketplace alone. One false positive class here would swamp the report.
  for (const sha of [
    '656cf4c94a3f2a0f6c7ca597e87d35e520b0ca56',
    'c6e19310289232d8914e638af69268d75cb30c5d',
    '44c9b2d6e889982ac18c27d05a19fefe335194e1',
  ]) {
    assert.equal(inspectValue('gitCommitSha', sha), undefined);
  }
});

test('"Bearer" as English prose is not a credential', () => {
  // The prefix must require the trailing space, or it hits every skill and
  // plugin description mentioning bearer tokens.
  assert.equal(inspectValue('description', 'Bearer token support is documented.'), undefined);
  assert.ok(inspectValue('headers.Authorization', 'Bearer abc123def456ghi789'));
});

test('a plain https URL is not a credential — found by the real corpus, not the oracle', () => {
  // The synthetic negatives contain no plain URL. This one measures 4.55
  // bits/char, and all 276 available plugin entries carry a source URL, so
  // missing it fires hundreds of times on an untouched machine.
  for (const url of [
    'https://github.com/wonderwhy-er/DesktopCommanderMCP.git',
    'https://mcp.exa.ai/mcp',
    'https://raw.githubusercontent.com/some-org/some-repo/main/manifest.json',
  ]) {
    assert.equal(inspectValue('pluginSource.url', url), undefined, `flagged ${url}`);
  }

  // …while a URL that genuinely carries a password still is, via `shape`,
  // which the structural exclusions never gate.
  assert.ok(inspectValue('url', 'https://user:pass@registry.example.com/npm'));
});

test('an @-scoped versioned package is not a URL with a password', () => {
  // A userinfo matcher permitting `@` inside the credential reads this
  // string's second `@` as the host separator.
  assert.equal(inspectValue('args[1]', '@upstash/context7-mcp@2.1.4'), undefined);
});

test('an empty or whitespace value is never a finding', () => {
  // Every env object on the reference machine is empty or empty-valued. If
  // empty strings flag, the real corpus becomes unusable.
  assert.equal(inspectValue('env.X', ''), undefined);
  assert.equal(inspectValue('env.X', undefined), undefined);
  assert.equal(inspectValue('env.X', null), undefined);
  assert.equal(inspectValue('env.X', 12345), undefined);
});

// ---------------------------------------------------------------------------
// Scanning behaviour
// ---------------------------------------------------------------------------

test('the scan covers values OUTSIDE env — an env-only scan scores 14/17', () => {
  // `env.X` at the top level of settings.json counts as inside an env object;
  // only `args`, `url` and `pluginConfigs` are genuinely outside one.
  const outsideEnv = ORACLE.expectedFindings.filter((f) => !/(?:^|\.)env\./u.test(f.location));
  assert.equal(outsideEnv.length, ORACLE.counts.notInEnv);

  // Two of these are in args/url and one in pluginConfigs. An env-only scan
  // reports two servers clean that are not — and a partial scan that says
  // "clean" is worse than no scan, because it is believed.
  for (const expected of outsideEnv) {
    assert.ok(found.get(`${expected.file}::${expected.location}`), `missed ${expected.id}`);
  }
});

test('findings are per-value, not per-object', () => {
  const clean = inspectValue('env.AWS_REGION', 'eu-west-1');
  assert.equal(clean, undefined, 'a benign sibling of a real secret must stay clean');

  // The oracle ships AWS_REGION in the same env object as two positives
  // precisely to catch a detector that condemns a whole object.
  const scanned = scanValue({ env: { AWS_REGION: 'eu-west-1', AWS_ACCESS_KEY_ID: 'AKIAFAKEFAKEFAKEFAKE' } });
  assert.equal(scanned.length, 1);
  assert.equal(scanned[0].location, 'env.AWS_ACCESS_KEY_ID');
});

test('locations are dotted paths a human can follow to the value', () => {
  const scanned = scanValue({ mcpServers: { gh: { env: { TOKEN: `ghp_${'a1b2c3d4e5'.repeat(3)}12` } } } });
  assert.equal(scanned[0].location, 'mcpServers.gh.env.TOKEN');
});

test('array indices are part of the location', () => {
  const scanned = scanValue({ args: ['--url', 'postgres://user:pass@example.com/db'] });
  assert.equal(scanned[0].location, 'args[1]');
});

test('object KEYS are not inspected, only values', () => {
  // CLAUDE_PLUGIN_OPTION_SYNC_TOKEN is required by the approved config and
  // appears as a key. Inspecting keys would flag correct configuration.
  assert.deepEqual(scanValue({ CLAUDE_PLUGIN_OPTION_SYNC_TOKEN: '${user_config.sync_token}' }), []);
});

test('a cyclic structure terminates instead of hanging', () => {
  const cycle = { env: {} };
  cycle.self = cycle;
  // A scanner that hangs on a bad input is a scanner that stops being run.
  assert.deepEqual(scanValue(cycle), []);
});

// ---------------------------------------------------------------------------
// Redaction — the report must not leak what it warns about
// ---------------------------------------------------------------------------

test('a finding never carries the value it found', () => {
  const token = `ghp_${'x'.repeat(36)}`;
  const finding = inspectValue('env.T', token);

  // A doctor report is something users paste into issues. A tool that prints
  // the token it just warned about has leaked it a second time.
  assert.ok(!JSON.stringify(finding).includes(token));
  assert.match(finding.redacted, /^ghp_…/);
  assert.match(finding.redacted, /40 chars/);
});

test('a short value redacts to nothing but its length', () => {
  assert.equal(redact('abc'), '***');
});

// ---------------------------------------------------------------------------
// Entropy maths
// ---------------------------------------------------------------------------

test('the oracle entropy figures still reproduce', () => {
  // The oracle's own `verify` step asserts these against the shipped bytes.
  // Recomputing them here proves this implementation agrees with the one that
  // graded the corpus, rather than merely agreeing with itself.
  for (const expected of ORACLE.expectedFindings) {
    if (expected.entropyBitsPerChar === undefined) continue;
    const file = CORPUS[expected.file];
    const value = expected.location
      .split('.')
      .reduce((node, key) => (node === undefined ? undefined : node[key]), file);
    if (typeof value !== 'string') continue;

    assert.ok(
      Math.abs(shannonBitsPerChar(value) - expected.entropyBitsPerChar) < 0.001,
      `${expected.id}: computed ${shannonBitsPerChar(value)}, oracle says ${expected.entropyBitsPerChar}`,
    );
  }
});

test('entropy of a uniform string is zero, and of an empty string too', () => {
  assert.equal(shannonBitsPerChar('aaaaaaaa'), 0);
  assert.equal(shannonBitsPerChar(''), 0);
});
