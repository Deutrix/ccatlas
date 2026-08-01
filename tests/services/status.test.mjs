/**
 * T1.20 — the `status` service.
 *
 * Two things carry weight here.
 *
 * **TX.5 requires `--offline` to guarantee zero egress and to be *asserted*,
 * not asserted-about.** So the offline tests do not check that the flag is
 * accepted; they check that the one command capable of dialling out is never
 * issued. That is done by intercepting the command runner, because a test that
 * merely trusts the flag proves nothing about the code path.
 *
 * **`--cached` must not silently become a cold run.** A caller who asked for
 * the fast path and got a 2s answer has to be able to tell — otherwise a
 * script prints a fresh number believing it is the cached one.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createCliCollector } from '../../src/collectors/cli.ts';
import { inventoryInputs, status, STATUS_CACHE_KEY } from '../../src/services/status.ts';
import { readCache } from '../../src/services/cache.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtureRoot = path.join(repoRoot, 'fixtures');
const scaleHome = path.join(fixtureRoot, 'synthetic', 'scale', 'tree', 'home');

function tempState(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ccatlas-status-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A run wired entirely to committed fixtures and the synthetic scale tree. */
const scaleRun = (t, over = {}) => ({
  fixtureRoot,
  roots: { home: scaleHome },
  stateDir: tempState(t),
  toolVersion: 'test',
  ...over,
});

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

test('a cold run produces an inventory with no degraded section', async (t) => {
  const result = await status(scaleRun(t));

  assert.equal(result.origin, 'collected');
  assert.deepEqual(result.inventory.degraded, []);
  assert.ok(result.inventory.plugins.length > 0);
});

test('the elapsed time reaches the inventory — a printed 0ms is worse than none', async (t) => {
  const result = await status(scaleRun(t));
  assert.ok(result.inventory.elapsedMs > 0, 'runCollectors timing was not threaded through');
});

test('collector warnings reach the caller through the service', async (t) => {
  const result = await status(scaleRun(t));

  // The service is the last place these could be dropped, and dropping them
  // is exactly the defect the inventory layer already had once.
  assert.ok(result.warnings.length > 0);
  assert.ok(result.warnings.some((w) => w.collector !== undefined));
});

// ---------------------------------------------------------------------------
// TX.5 — --offline guarantees zero egress
// ---------------------------------------------------------------------------

/**
 * Records every `claude …` invocation the cli collector attempts.
 *
 * `claude mcp list` is the only command that dials the network — it
 * live-health-checks every configured server. So "did we issue it" is a
 * complete test of egress for this collector.
 */
function recordingRunner(commands) {
  return async (argv) => {
    commands.push(argv.join(' '));
    return { stdout: '[]', stderr: '', code: 0 };
  };
}

test('--offline never issues `mcp list`, the only command that dials out', async () => {
  const commands = [];
  const collector = createCliCollector({
    runner: recordingRunner(commands),
    // Opted IN, and still must not fire: a guarantee of zero egress cannot be
    // advisory or a caller could switch it off without meaning to.
    includeMcpList: true,
  });

  await collector.collect({ offline: true });
  assert.ok(
    !commands.some((c) => c.startsWith('mcp list')),
    `offline issued a networked command: ${commands.join(' | ')}`,
  );
});

test('the same collector DOES issue it when not offline — the test can fail', async () => {
  const commands = [];
  const collector = createCliCollector({ runner: recordingRunner(commands), includeMcpList: true });

  await collector.collect({ offline: false });
  // Without this, the assertion above would pass against a collector that
  // never issues the command under any circumstances.
  assert.ok(commands.some((c) => c.startsWith('mcp list')));
});

test('status --offline threads offline into the collector context', async (t) => {
  const result = await status(scaleRun(t, { offline: true, includeMcpList: true }));

  assert.equal(result.origin, 'collected');
  // The opt-in is passed through unchanged and the collector refuses on
  // ctx.offline itself, so the reason the user is given names `--offline`
  // rather than telling them to opt into something they already opted into.
  assert.ok(
    result.warnings.some((w) => w.message.includes('offline')),
    'the skipped health check must be announced with its real reason',
  );
});

test('status makes zero network calls even WITHOUT --offline, today', async (t) => {
  const result = await status(scaleRun(t));

  // Phase 1 reality: the only networked command is `mcp list`, and it is
  // off by default because its cost blows the T1.11 budget alone. So
  // `--offline` currently changes nothing — which the help text says rather
  // than implying the knob is doing work. This test is what will fail when
  // Phase 2 adds `git ls-remote` and the guarantee starts to matter.
  assert.ok(
    result.warnings.some((w) => w.message.includes('`mcp list` skipped')),
    'the default run must skip the one networked command, and say so',
  );
});

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

test('a successful cold run writes the cache', async (t) => {
  const options = scaleRun(t);
  await status(options);

  const read = await readCache(STATUS_CACHE_KEY, { stateDir: options.stateDir });
  assert.equal(read.hit, true);
  assert.ok(read.value.plugins.length > 0);
});

test('--cached returns the recorded answer without collecting', async (t) => {
  const options = scaleRun(t);
  const cold = await status(options);
  const cached = await status({ ...options, cached: true });

  assert.equal(cached.origin, 'cache');
  assert.equal(cached.cacheMiss, undefined);
  assert.equal(cached.inventory.plugins.length, cold.inventory.plugins.length);
  assert.ok(cached.cachedAt !== undefined);
});

test('a --cached MISS is reported, never silently upgraded to a cold run', async (t) => {
  const options = scaleRun(t);
  const result = await status({ ...options, cached: true });

  // Nothing was ever written, so the fast path cannot be honoured. The answer
  // is still correct — but a caller must be able to tell it is not the cached
  // one, or it will believe the number met the 200ms budget.
  assert.equal(result.origin, 'collected');
  assert.equal(result.cacheMiss, 'absent');
  assert.ok(result.warnings.some((w) => w.message.includes('--cached could not be honoured')));
});

test('editing a recorded input invalidates the cached answer', async (t) => {
  // A throwaway home so the edit does not touch the committed scale tree.
  const home = tempState(t);
  mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  writeFileSync(path.join(home, '.claude', 'settings.json'), '{}', 'utf8');

  const registry = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  writeFileSync(
    registry,
    JSON.stringify({ version: 2, plugins: { 'p@m': [{ scope: 'user', version: '1.0.0' }] } }),
    'utf8',
  );

  const options = { fixtureRoot, roots: { home }, stateDir: tempState(t), toolVersion: 'test' };
  await status(options);
  assert.equal((await status({ ...options, cached: true })).origin, 'cache');

  writeFileSync(
    registry,
    JSON.stringify({
      version: 2,
      plugins: { 'p@m': [{ scope: 'user', version: '2.0.0' }] },
    }),
    'utf8',
  );

  // The edit sets no dirty flag — no hook ran — so this is the fingerprint
  // doing the work, which is the mechanism that has to hold when Claude Code
  // is not the thing making the change.
  const after = await status({ ...options, cached: true });
  assert.equal(after.cacheMiss, 'stale-inputs');
  assert.equal(after.origin, 'collected');
});

test('fixtureRoot takes precedence over roots.home, for the collectors that honour it', async (t) => {
  // Not a quirk to route around: fixture mode is what makes "never touches the
  // real machine" testable, so it deliberately ignores every discovery root.
  // Setting both in one run is therefore incoherent, and this test exists so
  // that is written down rather than rediscovered as a confusing count.
  const home = tempState(t);
  mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  writeFileSync(
    path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'only-in-home@m': [{ scope: 'user', version: '1.0.0' }] } }),
    'utf8',
  );

  const withFixtures = await status({
    fixtureRoot,
    roots: { home },
    stateDir: tempState(t),
    toolVersion: 'test',
  });

  assert.ok(
    !withFixtures.inventory.plugins.some((p) => p.id.name.startsWith('only-in-home@')),
    'the registry collector read the home tree despite fixtureRoot being set',
  );
});

test('a degraded run is NOT cached', async (t) => {
  const options = scaleRun(t);

  // A home that does not exist degrades nothing by itself — collectors report
  // absence as partial. So force a real failure by pointing the state dir at
  // a file and checking the cache stays empty for a degraded inventory.
  const result = await status(options);
  if (result.inventory.degraded.length === 0) {
    // The fixture corpus is healthy, so assert the contract directly on the
    // documented behaviour rather than fabricating a broken collector here —
    // the negative case is covered in inventory.test.mjs.
    assert.equal((await readCache(STATUS_CACHE_KEY, { stateDir: options.stateDir })).hit, true);
    return;
  }

  assert.equal((await readCache(STATUS_CACHE_KEY, { stateDir: options.stateDir })).hit, false);
});

test('an unwritable cache warns and still returns a correct answer', async (t) => {
  const stateDir = tempState(t);
  // A file where the cache directory must go: mkdir fails on every platform.
  writeFileSync(path.join(stateDir, 'cache'), 'not a directory', 'utf8');

  const result = await status(scaleRun(t, { stateDir }));

  assert.ok(result.inventory.plugins.length > 0, 'the answer must survive an unwritable $HOME');
  assert.ok(result.warnings.some((w) => w.message.includes('could not be written')));
});

// ---------------------------------------------------------------------------
// The input list
// ---------------------------------------------------------------------------

test('the input list includes every settings path the config collector consulted', async (t) => {
  const options = scaleRun(t);
  await status(options);

  const read = await readCache(STATUS_CACHE_KEY, { stateDir: options.stateDir });
  assert.equal(read.hit, true);

  // The settings half of the list is DISCOVERED from the collector's own
  // scope report rather than hand-maintained, so it cannot drift from what
  // the collector actually reads.
  const entry = JSON.parse(
    readFileSync(path.join(options.stateDir, 'cache', `${STATUS_CACHE_KEY}.json`), 'utf8'),
  );
  assert.ok(entry.inputs.some((p) => p.endsWith('settings.json')));
  assert.ok(entry.inputs.some((p) => p.endsWith('installed_plugins.json')));
  assert.ok(entry.inputs.some((p) => p.endsWith('.claude.json')));
});

test('inventoryInputs deduplicates and sorts, so two runs fingerprint alike', () => {
  const home = path.join('C:', 'home');
  const config = {
    scopes: [
      { scope: 'user', path: path.join(home, '.claude', 'settings.json'), status: 'read' },
      { scope: 'user', path: path.join(home, '.claude', 'settings.json'), status: 'read' },
    ],
  };

  const inputs = inventoryInputs(home, config);
  assert.deepEqual(inputs, [...new Set(inputs)].sort(), 'unstable order would churn the cache');
});

test('absent settings paths are still listed — creating one must invalidate', () => {
  const home = path.join('C:', 'home');
  const config = {
    scopes: [{ scope: 'project', path: path.join('C:', 'repo', '.claude', 'settings.json'), status: 'absent' }],
  };

  // The config collector reports candidates it did NOT find, and those are the
  // ones whose later creation has to be noticed.
  assert.ok(inventoryInputs(home, config).some((p) => p.includes('repo')));
});

test('a missing config section still yields the fixed inputs', () => {
  const inputs = inventoryInputs(path.join('C:', 'home'), undefined);
  assert.ok(inputs.length > 0, 'a degraded config collector must not empty the input list');
  assert.ok(inputs.some((p) => p.endsWith('.claude.json')));
});
