/**
 * T5.16–T5.26 — the import path.
 *
 * Two 📏 gates carry the weight. **T5.23 idempotency**: a second consecutive
 * apply must make zero changes, which is what makes `sync pull` safe on a
 * schedule. **T5.26 rollback fidelity**: apply → corrupt → rollback →
 * byte-identical, verified by re-reading from disk rather than trusting the
 * write.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  blockingProblems,
  buildImportPlan,
  buildReceipt,
  isNoOp,
  preflight,
} from '../../src/services/import.ts';
import {
  listSnapshots,
  readSnapshot,
  restoreSnapshot,
  SNAPSHOT_FILES,
  takeSnapshot,
  verifyRestore,
  writeSnapshot,
} from '../../src/services/snapshot.ts';

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

const bundle = (over = {}) => ({
  schemaVersion: 1,
  kind: 'ccatlas.bundle/1',
  manifest: {
    generatedAt: '2026-08-01T00:00:00.000Z',
    generatedBy: 'ccatlas/test',
    source: { hostname: '<REDACTED>', os: 'win32' },
    counts: {},
    includes: [],
    estimatorRegime: 'tokenizer',
  },
  marketplaces: [],
  plugins: [],
  mcpServers: {},
  settings: {},
  files: [],
  secretsRequired: [],
  signature: null,
  integrity: 'sha256:test',
  ...over,
});

const localPlugin = (name, over = {}) => ({
  id: { name, scope: 'user', kind: 'plugin' },
  origin: 'marketplace',
  state: 'enabled',
  source: 'cli',
  sources: ['cli'],
  marketplace: 'm',
  enabled: true,
  version: { version: '1.0.0', versionSource: 'plugin-json' },
  contributes: { skills: 0, agents: 0, hooks: 0, mcpServers: 0, lspServers: 0 },
  ...over,
});

function tempHome(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ccatlas-import-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, '.claude', 'plugins'), { recursive: true });
  return root;
}

// ---------------------------------------------------------------------------
// 📏 T5.23 — idempotency
// ---------------------------------------------------------------------------

test('📏 a bundle already satisfied produces ZERO actions', () => {
  const plan = buildImportPlan({
    bundle: bundle({
      plugins: [{ id: 'p@m', scope: 'user', enabled: true, version: '1.0.0', versionSource: 'plugin-json' }],
      marketplaces: [{ name: 'm', distribution: 'git', scope: 'user' }],
    }),
    inventory: inventory({
      plugins: [localPlugin('p@m')],
      marketplaces: [{ id: { name: 'm', scope: 'user', kind: 'marketplace' }, origin: 'marketplace', state: 'enabled', source: 'cli', distribution: 'git' }],
    }),
    env: {},
  });

  // This is what makes `sync pull` safe to run on a schedule.
  assert.deepEqual(plan.actions, []);
  assert.equal(isNoOp(plan), true);
  assert.equal(plan.satisfied.length, 2);
});

test('the plan is built against the CURRENT inventory, not the bundle alone', () => {
  const first = buildImportPlan({
    bundle: bundle({ plugins: [{ id: 'p@m', scope: 'user', enabled: true, version: '1.0.0', versionSource: 'plugin-json' }] }),
    inventory: inventory(),
    env: {},
  });

  // Nothing installed ⇒ one action. That same bundle against an inventory
  // that now HAS it ⇒ none. Idempotency falls out of the diff.
  assert.equal(first.actions.length, 1);
  assert.equal(isNoOp(first), false);
});

test('a plugin at a DIFFERENT scope is not already satisfied', () => {
  const plan = buildImportPlan({
    bundle: bundle({ plugins: [{ id: 'p@m', scope: 'project', enabled: true, version: '1.0.0', versionSource: 'plugin-json' }] }),
    inventory: inventory({ plugins: [localPlugin('p@m')] }),
    env: {},
  });

  // D4: keyed by (id, scope). Matching on id alone would skip a real install.
  assert.equal(plan.actions.length, 1);
});

// ---------------------------------------------------------------------------
// T5.18 — the plan discloses everything
// ---------------------------------------------------------------------------

test('an MCP action carries the EXACT command line it will run', () => {
  const plan = buildImportPlan({
    bundle: bundle({
      mcpServers: { evil: { command: 'node', args: ['-e', 'require("child_process")'], scope: 'user' } },
    }),
    inventory: inventory(),
    env: {},
  });

  // Registering an MCP server registers a program Claude Code will execute.
  // This is the executable surface that matters most, and it is never
  // summarised.
  assert.deepEqual(plan.actions[0].executes, {
    command: 'node',
    args: ['-e', 'require("child_process")'],
  });
});

test('a plugin install discloses its pinned SHA', () => {
  const plan = buildImportPlan({
    bundle: bundle({
      plugins: [{ id: 'p@m', scope: 'user', enabled: true, version: '1.0.0', versionSource: 'plugin-json', sourceSha: 'a'.repeat(40) }],
    }),
    inventory: inventory(),
    env: {},
  });

  // The difference between reproducing a stack and installing whatever HEAD
  // happens to be today.
  assert.match(plan.actions[0].reason, /pinned at aaaaaaaaaaaa/);
});

test('every action carries an argv or is a file write', () => {
  const plan = buildImportPlan({
    bundle: bundle({
      marketplaces: [{ name: 'm', source: { source: 'github', repo: 'o/r' }, distribution: 'git', scope: 'user' }],
      files: [{ path: 'CLAUDE.md', encoding: 'utf8', content: '# hi' }],
    }),
    inventory: inventory(),
    env: {},
  });

  for (const action of plan.actions) {
    const disclosed = action.argv !== undefined || action.kind === 'file-write';
    assert.ok(disclosed, `${action.kind} discloses nothing`);
  }
  assert.deepEqual(plan.actions[0].argv, ['plugin', 'marketplace', 'add', 'o/r']);
});

test('marketplaces are ordered before plugins', () => {
  const plan = buildImportPlan({
    bundle: bundle({
      marketplaces: [{ name: 'm', distribution: 'git', scope: 'user' }],
      plugins: [{ id: 'p@m', scope: 'user', enabled: true, version: '1.0.0', versionSource: 'plugin-json' }],
    }),
    inventory: inventory(),
    env: {},
  });

  // A plugin install resolves through its marketplace; the reverse order
  // fails on the first plugin from an unknown source.
  assert.equal(plan.actions[0].kind, 'marketplace-add');
  assert.equal(plan.actions[1].kind, 'plugin-install');
});

// ---------------------------------------------------------------------------
// T5.17 — pre-flight
// ---------------------------------------------------------------------------

test('a missing required env var BLOCKS', () => {
  const problems = preflight(bundle({ secretsRequired: ['GITHUB_TOKEN'] }), {});

  // Applying anyway registers a server whose env holds the literal
  // ${GITHUB_TOKEN}, failing at first use with an error pointing nowhere near
  // the import.
  assert.equal(problems.length, 1);
  assert.equal(problems[0].blocking, true);
  assert.match(problems[0].message, /literal \$\{GITHUB_TOKEN\}/);
});

test('a present env var raises nothing', () => {
  assert.deepEqual(preflight(bundle({ secretsRequired: ['TOKEN'] }), { TOKEN: 'x' }), []);
});

test('an empty env var counts as missing', () => {
  assert.equal(preflight(bundle({ secretsRequired: ['TOKEN'] }), { TOKEN: '' })[0].blocking, true);
});

test('a Claude Code major skew WARNS but does not block', () => {
  const problems = preflight(
    bundle({ manifest: { ...bundle().manifest, source: { hostname: 'x', os: 'linux', claudeCodeVersion: '2.1.220' } } }),
    {},
    '3.0.0',
  );

  // Blocking would make every bundle expire on the next Claude Code release.
  const skew = problems.find((p) => p.kind === 'version-skew');
  assert.ok(skew);
  assert.equal(skew.blocking, false);
});

test('a non-tokenizer estimator regime is flagged, not blocked', () => {
  const problems = preflight(
    bundle({ manifest: { ...bundle().manifest, estimatorRegime: 'fallback' } }),
    {},
  );

  const flagged = problems.find((p) => p.subject === 'estimatorRegime');
  assert.match(flagged.message, /must not be presented as authoritative/);
  assert.equal(flagged.blocking, false);
});

test('blockingProblems separates the two', () => {
  const plan = buildImportPlan({
    bundle: bundle({ secretsRequired: ['A'], manifest: { ...bundle().manifest, estimatorRegime: 'unknown' } }),
    inventory: inventory(),
    env: {},
  });

  assert.equal(plan.problems.length, 2);
  assert.equal(blockingProblems(plan).length, 1);
});

// ---------------------------------------------------------------------------
// T5.22 — conflict policy
// ---------------------------------------------------------------------------

test('keep-local leaves a differing enabled bit alone', () => {
  const plan = buildImportPlan({
    bundle: bundle({ plugins: [{ id: 'p@m', scope: 'user', enabled: false, version: '1.0.0', versionSource: 'plugin-json' }] }),
    inventory: inventory({ plugins: [localPlugin('p@m', { enabled: true })] }),
    env: {},
    conflictPolicy: 'keep-local',
  });

  assert.deepEqual(plan.actions, []);
  assert.ok(plan.satisfied[0].includes('kept local'));
});

test('take-bundle acts, and names both sides of the conflict', () => {
  const plan = buildImportPlan({
    bundle: bundle({ plugins: [{ id: 'p@m', scope: 'user', enabled: false, version: '1.0.0', versionSource: 'plugin-json' }] }),
    inventory: inventory({ plugins: [localPlugin('p@m', { enabled: true })] }),
    env: {},
    conflictPolicy: 'take-bundle',
  });

  assert.equal(plan.actions[0].kind, 'plugin-disable');
  assert.deepEqual(plan.actions[0].conflict, { local: 'enabled', bundle: 'disabled' });
});

// ---------------------------------------------------------------------------
// T5.19 / 📏 T5.26 — snapshot and rollback
// ---------------------------------------------------------------------------

const write = (home, relative, contents) => {
  const file = path.join(home, ...relative.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, 'utf8');
};

test('a snapshot captures existing files and records absent ones', async (t) => {
  const home = tempHome(t);
  write(home, '.claude.json', '{"a":1}');

  const snapshot = await takeSnapshot(home, 'test', '2026-08-01T00:00:00.000Z');

  assert.equal(snapshot.entries.length, SNAPSHOT_FILES.length);
  const present = snapshot.entries.find((e) => e.path === '.claude.json');
  assert.equal(present.content, '{"a":1}');

  // An ABSENT file is an entry with no content, not an omission. If an apply
  // created it, restoring must delete it again.
  const absent = snapshot.entries.find((e) => e.path === '.claude/settings.json');
  assert.equal(absent.content, undefined);
});

test('📏 apply → corrupt → rollback → byte-identical', async (t) => {
  const home = tempHome(t);
  write(home, '.claude.json', '{"original":true}');
  write(home, '.claude/settings.json', '{"enabledPlugins":{"p@m":true}}');

  const snapshot = await takeSnapshot(home, 'before apply', '2026-08-01T00:00:00.000Z');

  // "Apply" then corrupt.
  write(home, '.claude.json', '{"mangled":true}');
  write(home, '.claude/settings.local.json', '{"created":"by the apply"}');

  await restoreSnapshot(home, snapshot);

  assert.equal(readFileSync(path.join(home, '.claude.json'), 'utf8'), '{"original":true}');
  // The file the apply CREATED must be gone — that is the half an
  // omission-based snapshot would miss.
  assert.equal(existsSync(path.join(home, '.claude/settings.local.json')), false);

  // Verified by RE-READING, not by trusting the write.
  assert.deepEqual(await verifyRestore(home, snapshot), []);
});

test('verifyRestore catches a file that was not restored', async (t) => {
  const home = tempHome(t);
  write(home, '.claude.json', '{"a":1}');
  const snapshot = await takeSnapshot(home, 'x', '2026-08-01T00:00:00.000Z');

  write(home, '.claude.json', '{"b":2}');

  // Without this the fidelity test above would pass against a restore that
  // silently did nothing.
  const mismatches = await verifyRestore(home, snapshot);
  assert.equal(mismatches.length, 1);
  assert.match(mismatches[0], /differs/);
});

test('an unreadable file is NOT recorded as absent', async (t) => {
  const home = tempHome(t);
  // A directory where a file is expected: readFile fails with EISDIR.
  mkdirSync(path.join(home, '.claude.json'), { recursive: true });

  // Recording it as absent would make rollback DELETE something it merely
  // failed to read.
  await assert.rejects(takeSnapshot(home, 'x', '2026-08-01T00:00:00.000Z'), /could not read/);
});

test('snapshots round-trip through disk and list in order', async (t) => {
  const home = tempHome(t);
  const stateDir = path.join(home, 'state');
  write(home, '.claude.json', '{"a":1}');

  const first = await takeSnapshot(home, 'first', '2026-08-01T00:00:00.000Z');
  const second = await takeSnapshot(home, 'second', '2026-08-02T00:00:00.000Z');
  await writeSnapshot(stateDir, first);
  await writeSnapshot(stateDir, second);

  const ids = await listSnapshots(stateDir);
  assert.equal(ids.length, 2);
  assert.deepEqual(ids, [...ids].sort(), 'ids do not sort chronologically');

  const reread = await readSnapshot(stateDir, first.id);
  assert.deepEqual(reread.entries, first.entries);
});

test('an absent snapshot reads as undefined rather than throwing', async (t) => {
  assert.equal(await readSnapshot(path.join(tempHome(t), 'state'), 'nope'), undefined);
  assert.deepEqual(await listSnapshots(path.join(tmpdir(), 'ccatlas-no-snapshots-xyz')), []);
});

// ---------------------------------------------------------------------------
// T5.24 — the receipt
// ---------------------------------------------------------------------------

test('a receipt records the integrity digest and every action', () => {
  const receipt = buildReceipt({
    appliedAt: '2026-08-01T00:00:00.000Z',
    source: 'owner/repo',
    bundle: bundle({ integrity: 'sha256:abc' }),
    sourceRevision: 'rev123',
    snapshot: 'snap-1',
    executed: [
      { action: { kind: 'plugin-install', subject: 'p@m', reason: '' }, code: 0 },
      { action: { kind: 'mcp-add', subject: 's', reason: '' }, code: 1 },
    ],
  });

  assert.equal(receipt.integrity, 'sha256:abc');
  // T5.14: a gist URL is not stable; its revision SHA is.
  assert.equal(receipt.sourceRevision, 'rev123');
  assert.equal(receipt.snapshot, 'snap-1');
  assert.equal(receipt.ok, false, 'a non-zero action must not read as success');
});

test('a fully successful apply reports ok', () => {
  const receipt = buildReceipt({
    appliedAt: 'now',
    source: './b.json',
    bundle: bundle(),
    executed: [{ action: { kind: 'plugin-install', subject: 'p', reason: '' }, code: 0 }],
  });

  assert.equal(receipt.ok, true);
});
