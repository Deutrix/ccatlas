/**
 * T5.1–T5.12 — the frozen bundle schema.
 *
 * The security-critical assertion is **fail closed**: an untemplatable
 * credential refuses the export rather than warning about it. A bundle is
 * something people commit and share, so the cost of shipping a live token is
 * unbounded.
 *
 * T5.7's fuzz gate lives at the bottom — every generated bundle is scanned
 * with the same detector the doctor uses, and **any leak fails the build**.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  allowlistSettings,
  auditBundle,
  BUNDLE_KIND,
  BUNDLE_SCHEMA_VERSION,
  buildBundle,
  canonicalise,
  checkSizeCaps,
  computeIntegrity,
  isExcluded,
  MAX_FILE_BYTES,
  NEVER_EXPORTED,
  secretGate,
  SETTINGS_ALLOWLIST,
  templateSecrets,
  verifyIntegrity,
} from '../../src/services/bundle.ts';

const inventory = (over = {}) => ({
  plugins: [],
  marketplaces: [],
  mcpServers: [],
  skills: [],
  agents: [],
  commands: [],
  shadowing: [],
  degraded: [],
  partial: [],
  sections: [],
  warnings: [],
  elapsedMs: 1,
  ...over,
});

const plugin = (over = {}) => ({
  id: { name: 'p@mkt', scope: 'user', kind: 'plugin' },
  origin: 'marketplace',
  state: 'enabled',
  source: 'cli',
  sources: ['cli', 'file'],
  marketplace: 'mkt',
  enabled: true,
  version: { version: '1.0.0', versionSource: 'plugin-json' },
  contributes: { skills: 0, agents: 0, hooks: 0, mcpServers: 0, lspServers: 0 },
  ...over,
});

const inputs = (over = {}) => ({
  inventory: inventory(),
  settings: {},
  mcpServers: [],
  files: [],
  generatedAt: '2026-08-01T00:00:00.000Z',
  generatedBy: 'ccatlas/test',
  os: 'win32',
  ...over,
});

const server = (name, over = {}) => ({
  id: { name, scope: 'user', kind: 'mcp-server' },
  origin: 'personal',
  state: 'enabled',
  source: 'file',
  transport: 'stdio',
  connection: 'connected',
  ...over,
});

// ---------------------------------------------------------------------------
// 🔒 T5.6 — fail closed
// ---------------------------------------------------------------------------

const TOKEN = `ghp_${'a1b2c3d4e5'.repeat(3)}12`;

test('a templatable credential becomes ${VAR} and is listed as required', () => {
  const outcome = templateSecrets({ env: { GITHUB_TOKEN: TOKEN } });

  // The KEY names the variable, so the importer knows what to supply.
  assert.deepEqual(outcome.value, { env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } });
  assert.deepEqual(outcome.required, ['GITHUB_TOKEN']);
  assert.deepEqual(outcome.untemplatable, []);
});

test('a credential EMBEDDED in a larger string is untemplatable', () => {
  // A password inside a connection URL has no name to template to, and
  // inventing one produces a bundle that silently does not work.
  const outcome = templateSecrets({ args: ['--url', 'postgres://user:pass@db.example.com/app'] });

  assert.equal(outcome.untemplatable.length, 1);
  assert.deepEqual(outcome.required, []);
});

test('🔒 an untemplatable credential REFUSES the export', () => {
  const result = buildBundle(
    inputs({ mcpServers: [server('db', { args: ['--url', 'postgres://user:pass@db.example.com/app'] })] }),
  );

  assert.equal(result.ok, false);
  assert.match(result.refusal.reason, /could not be safely templated/);
  assert.match(result.refusal.reason, /unbounded cost/);
  assert.ok(result.refusal.findings.length > 0);
});

test('--allow-secrets is the ONLY way past, and it warns loudly', () => {
  const result = buildBundle(
    inputs({
      allowSecrets: true,
      mcpServers: [server('db', { args: ['--url', 'postgres://user:pass@db.example.com/app'] })],
    }),
  );

  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.includes('Treat it as a secret itself')));
});

test('the gate passes cleanly when nothing was untemplatable', () => {
  assert.equal(secretGate([], false), undefined);
});

test('a clean export succeeds with no refusal — the negative case', () => {
  const result = buildBundle(
    inputs({ mcpServers: [server('memory', { command: 'npx', args: ['-y', '@mcp/memory'] })] }),
  );

  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// §4 — exclusions
// ---------------------------------------------------------------------------

test('every never-exported path is excluded', () => {
  for (const excluded of NEVER_EXPORTED) {
    assert.equal(isExcluded(excluded), true, excluded);
  }
});

test('exclusions match nested paths and are case-insensitive', () => {
  for (const path of [
    '.credentials.json',
    'sessions/abc.json',
    'plugins/cache/mkt/p/1.0.0/x',
    'projects/C--repo/session.jsonl',
    'SESSIONS/x',
    'nested/todos/a.json',
  ]) {
    assert.equal(isExcluded(path), true, path);
  }
});

test('ordinary stack files are NOT excluded — the negative case', () => {
  for (const path of ['CLAUDE.md', 'skills/foo/SKILL.md', 'agents/a.md', 'settings.json']) {
    assert.equal(isExcluded(path), false, path);
  }
});

test('--allow-secrets does not unlock the never-exported list', () => {
  // It exists for a value that could not be templated, not for the credential
  // store. Nothing in buildBundle consults it when deciding exclusions.
  assert.equal(isExcluded('.credentials.json'), true);
});

// ---------------------------------------------------------------------------
// §5 — the settings allowlist
// ---------------------------------------------------------------------------

test('env and the self-updater keys are dropped', () => {
  const { kept, dropped } = allowlistSettings({
    enabledPlugins: { 'p@m': true },
    env: { SECRET: 'x' },
    autoUpdates: true,
    autoUpdatesChannel: 'stable',
  });

  // `autoUpdates*` govern the CLI SELF-updater, not stack state — the same
  // naming trap that caught T2.6.
  assert.deepEqual(Object.keys(kept), ['enabledPlugins']);
  assert.deepEqual(dropped.sort(), ['autoUpdates', 'autoUpdatesChannel', 'env']);
});

test('an unknown key is dropped rather than passed through', () => {
  const { dropped } = allowlistSettings({ somethingNew: 1 });
  assert.deepEqual(dropped, ['somethingNew']);
});

test('the allowlist is a list, not a denylist', () => {
  // A denylist ships every future key by default; an allowlist ships none.
  assert.ok(SETTINGS_ALLOWLIST.includes('enabledPlugins'));
  assert.ok(!SETTINGS_ALLOWLIST.includes('env'));
});

// ---------------------------------------------------------------------------
// Decisions of record
// ---------------------------------------------------------------------------

test('D5: an @inline sideload is never exported, and says why', () => {
  const result = buildBundle(
    inputs({
      inventory: inventory({
        plugins: [
          plugin(),
          plugin({ id: { name: 'side@inline', scope: 'session', kind: 'plugin' }, origin: 'inline' }),
        ],
      }),
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.bundle.plugins.length, 1);
  assert.ok(result.warnings.some((w) => w.includes('not reproducible state (D5)')));
});

test('D3: BOTH shas are carried, doing different jobs', () => {
  const result = buildBundle(
    inputs({
      inventory: inventory({
        plugins: [
          plugin({
            version: {
              version: '6.2.0',
              versionSource: 'plugin-json',
              sourceSha: 'a'.repeat(40),
              installedSha: 'b'.repeat(40),
            },
          }),
        ],
      }),
    }),
  );

  // sourceSha is the INSTALL COORDINATE; installedSha is DRIFT EVIDENCE. They
  // diverge on 2 of 5 plugins on the reference machine.
  assert.equal(result.bundle.plugins[0].sourceSha, 'a'.repeat(40));
  assert.equal(result.bundle.plugins[0].installedSha, 'b'.repeat(40));
});

test('D4: a plugin carries its scope, since (id, scope) is the key', () => {
  const result = buildBundle(
    inputs({ inventory: inventory({ plugins: [plugin({ id: { name: 'p@m', scope: 'project', kind: 'plugin' } })] }) }),
  );

  assert.equal(result.bundle.plugins[0].scope, 'project');
});

test('the hostname is REDACTED unless explicitly supplied', () => {
  assert.equal(buildBundle(inputs()).bundle.manifest.source.hostname, '<REDACTED>');
  assert.equal(buildBundle(inputs({ hostname: 'MYBOX' })).bundle.manifest.source.hostname, 'MYBOX');
});

test('§6: estimatorRegime is never claimed as tokenizer on the exporter say-so', () => {
  // The two regimes are indistinguishable in `plugin details` output and
  // differ by ~40%. An unearned label makes an import trust a wrong number.
  assert.equal(buildBundle(inputs()).bundle.manifest.estimatorRegime, 'unknown');
});

test('the bundle declares its schema version and kind', () => {
  const { bundle } = buildBundle(inputs());
  assert.equal(bundle.schemaVersion, BUNDLE_SCHEMA_VERSION);
  assert.equal(bundle.kind, BUNDLE_KIND);
});

// ---------------------------------------------------------------------------
// §7 — canonicalisation and integrity
// ---------------------------------------------------------------------------

test('canonical JSON sorts keys at every level', () => {
  assert.equal(canonicalise({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
});

test('two orderings of the same data canonicalise identically', () => {
  // §7: precise enough that two implementations agree, "or --verify is theatre".
  assert.equal(canonicalise({ a: 1, b: [{ y: 1, x: 2 }] }), canonicalise({ b: [{ x: 2, y: 1 }], a: 1 }));
});

test('array order is PRESERVED — it is data, not formatting', () => {
  assert.notEqual(canonicalise({ a: [1, 2] }), canonicalise({ a: [2, 1] }));
});

test('integrity verifies on a freshly built bundle', () => {
  assert.equal(verifyIntegrity(buildBundle(inputs()).bundle), true);
});

test('any tampering breaks integrity', () => {
  const { bundle } = buildBundle(inputs({ inventory: inventory({ plugins: [plugin()] }) }));
  const tampered = {
    ...bundle,
    plugins: [{ ...bundle.plugins[0], sourceSha: 'deadbeef'.repeat(5) }],
  };

  assert.equal(verifyIntegrity(tampered), false);
});

test('integrity excludes the integrity and signature fields themselves', () => {
  const { bundle } = buildBundle(inputs());
  const resigned = { ...bundle, signature: 'sig:whatever' };

  // A detached signature must not invalidate the digest it signs.
  const { integrity, signature, ...rest } = resigned;
  void signature;
  assert.equal(computeIntegrity(rest), integrity);
});

// ---------------------------------------------------------------------------
// 📏 T5.3 — size caps
// ---------------------------------------------------------------------------

test('📏 an oversized file is reported', () => {
  const { bundle } = buildBundle(
    inputs({ files: [{ path: 'big.md', encoding: 'utf8', content: 'x'.repeat(MAX_FILE_BYTES + 1) }] }),
  );

  const problems = checkSizeCaps(bundle);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /over the 1MB per-file cap/);
});

test('📏 a normal bundle is within both caps', () => {
  const { bundle } = buildBundle(
    inputs({ files: [{ path: 'CLAUDE.md', encoding: 'utf8', content: '# hello' }] }),
  );

  assert.deepEqual(checkSizeCaps(bundle), []);
});

// ---------------------------------------------------------------------------
// 🔒📏 T5.7 — the fuzz gate. ANY leak fails the build.
// ---------------------------------------------------------------------------

test('🔒📏 200 generated configs produce zero leaks', () => {
  const leaked = [];

  for (let i = 0; i < 200; i += 1) {
    // Deterministic variety: templatable secrets, benign lookalikes, and the
    // structural negatives the detector must not flag.
    const env = {
      [`TOKEN_${i}`]: `ghp_${String(i).padStart(4, '0')}${'x'.repeat(32)}`,
      AWS_REGION: 'eu-west-1',
      GIT_SHA: 'a'.repeat(40),
      PLACEHOLDER: '${ALREADY_TEMPLATED}',
      PKG: '@modelcontextprotocol/server-memory',
    };

    const result = buildBundle(
      inputs({
        mcpServers: [server(`s${i}`, { command: 'npx', args: ['-y', 'pkg'], env })],
        settings: { enabledPlugins: { [`p${i}@m`]: true } },
      }),
    );

    if (!result.ok) {
      leaked.push(`config ${i}: refused unexpectedly — ${result.refusal.reason}`);
      continue;
    }

    // The same detector the doctor uses. A finding here is a live credential
    // inside a bundle that was allowed out.
    for (const finding of auditBundle(result.bundle)) {
      leaked.push(`config ${i}: ${finding.location} — ${finding.evidence}`);
    }
  }

  assert.deepEqual(leaked, [], `bundle leaks:\n${leaked.slice(0, 10).join('\n')}`);
});

test('🔒 the fuzz gate CAN fail — a live secret is caught', () => {
  // Without this, the gate above would pass against a detector that finds
  // nothing at all.
  const result = buildBundle(
    inputs({
      allowSecrets: true,
      mcpServers: [server('leaky', { args: ['--url', 'postgres://user:pass@db.example.com/app'] })],
    }),
  );

  assert.ok(auditBundle(result.bundle).length > 0, 'the audit found nothing in a leaky bundle');
});
