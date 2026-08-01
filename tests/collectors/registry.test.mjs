/**
 * T1.8 (file half) — the `registry` collector.
 *
 * This collector exists because `installed_plugins.json` carries
 * `gitCommitSha` and the CLI does not expose it. So the tests that matter most
 * here are the ones proving the array-per-scope shape survives (trap 12) and
 * that an absent or corrupt registry degrades rather than fails.
 *
 * Parser tests run against the committed T0.5 fixtures. Collector tests build
 * throwaway trees under the OS temp dir, so nothing depends on the machine.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createRegistryCollector,
  enumerateCacheVersions,
  parseInstalledPlugins,
  parseKnownMarketplaces,
  probeDistribution,
  SUPPORTED_REGISTRY_VERSION,
} from '../../src/collectors/registry.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtureRoot = path.join(repoRoot, 'fixtures');
const files = path.join(fixtureRoot, 'files');

const INSTALLED = JSON.parse(readFileSync(path.join(files, 'installed_plugins.json'), 'utf8'));
const MARKETPLACES = JSON.parse(readFileSync(path.join(files, 'known_marketplaces.json'), 'utf8'));

const ctx = (extra = {}) => ({ offline: true, ...extra });

function tempTree(t, tree) {
  const root = mkdtempSync(path.join(tmpdir(), 'ccatlas-registry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  for (const [relative, contents] of Object.entries(tree)) {
    const target = path.join(root, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents, 'utf8');
  }
  return root;
}

// ---------------------------------------------------------------------------
// installed_plugins.json
// ---------------------------------------------------------------------------

test('parses every captured plugin from the T0.5 fixture', () => {
  const { installed, registryVersion, warnings } = parseInstalledPlugins(INSTALLED);

  assert.equal(registryVersion, SUPPORTED_REGISTRY_VERSION);
  assert.deepEqual(warnings, []);
  assert.equal(installed.length, 5);
  assert.deepEqual(
    installed.map((r) => r.key).sort(),
    [
      'everything-claude-code@everything-claude-code',
      'figma@claude-plugins-official',
      'frontend-design@claude-plugins-official',
      'superpowers@claude-plugins-official',
      'ui-ux-pro-max@ui-ux-pro-max-skill',
    ],
  );
});

test('gitCommitSha survives — it is the only source for it anywhere', () => {
  const { installed } = parseInstalledPlugins(INSTALLED);
  const superpowers = installed.find((r) => r.key.startsWith('superpowers@'));

  assert.equal(superpowers.gitCommitSha, 'eafe962b18f6c5dc70fb7c8cc7e83e61f4cdde06');

  // frontend-design has no SHA at all — absent, not empty-string.
  const frontend = installed.find((r) => r.key.startsWith('frontend-design@'));
  assert.equal(frontend.gitCommitSha, undefined);
});

test('the literal version "unknown" is preserved as a value, not dropped', () => {
  const { installed } = parseInstalledPlugins(INSTALLED);
  const frontend = installed.find((r) => r.key.startsWith('frontend-design@'));

  // A relative path inside a non-git marketplace clone yields this, and the
  // cache directory is literally `.../unknown/`. Coercing it to undefined
  // would make an installed plugin look unversioned rather than un-versionable.
  assert.equal(frontend.version, 'unknown');
});

test('trap 12: every element of the per-plugin array is kept, not just [0]', () => {
  const twoScopes = {
    version: 2,
    plugins: {
      'dual@mkt': [
        { scope: 'user', version: '1.0.0', gitCommitSha: 'a'.repeat(40) },
        { scope: 'project', version: '2.0.0', gitCommitSha: 'b'.repeat(40) },
      ],
    },
  };

  const { installed, warnings } = parseInstalledPlugins(twoScopes);

  assert.equal(installed.length, 2, 'reading [0] would silently drop the project scope');
  assert.deepEqual(installed.map((r) => r.scope).sort(), ['project', 'user']);
  // The two scopes hold DIFFERENT versions, which is exactly what collapsing
  // on name would lose.
  assert.deepEqual(installed.map((r) => r.version).sort(), ['1.0.0', '2.0.0']);
  assert.deepEqual(warnings, []);
});

test('a flattened (non-array) plugin entry warns instead of being accepted', () => {
  const { installed, warnings } = parseInstalledPlugins({
    version: 2,
    plugins: { 'flat@mkt': { scope: 'user', version: '1.0.0' } },
  });

  assert.deepEqual(installed, []);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'unsupported-version');
  assert.equal(warnings[0].subject, 'flat@mkt');
});

test('an unexpected registry version warns but still parses', () => {
  const { installed, registryVersion, warnings } = parseInstalledPlugins({
    version: 99,
    plugins: { 'p@m': [{ scope: 'user', version: '1.0.0' }] },
  });

  assert.equal(registryVersion, 99);
  assert.equal(installed.length, 1, 'a version bump is a warning, not a refusal to read');
  assert.ok(warnings.some((w) => w.code === 'unsupported-version'));
});

test('an unknown scope string warns and falls back to user, matching the cli collector', () => {
  const { installed, warnings } = parseInstalledPlugins({
    version: 2,
    plugins: { 'p@m': [{ scope: 'enterprise', version: '1.0.0' }] },
  });

  // Falling back to the same default the cli collector uses means the record
  // reconciles as equal rather than raising a spurious conflict.
  assert.equal(installed[0].scope, 'user');
  assert.ok(warnings.some((w) => w.message.includes('enterprise')));
});

test('a non-object registry is a warning, not a throw', () => {
  for (const bad of [null, [], 'nope', 42]) {
    const { installed, warnings } = parseInstalledPlugins(bad);
    assert.deepEqual(installed, []);
    assert.equal(warnings.length, 1);
  }
});

// ---------------------------------------------------------------------------
// known_marketplaces.json
// ---------------------------------------------------------------------------

test('parses all four captured marketplaces with their sources', () => {
  const { marketplaces, warnings } = parseKnownMarketplaces(MARKETPLACES);

  assert.deepEqual(warnings, []);
  assert.equal(marketplaces.length, 4);

  const official = marketplaces.find((m) => m.name === 'claude-plugins-official');
  assert.equal(official.source.source, 'github');
  assert.equal(official.source.repo, 'anthropics/claude-plugins-official');
  assert.equal(official.lastUpdated, '2026-07-31T08:10:55.364Z');
});

test('lastUpdated is present on every entry — it is the whole of the T2.6 report', () => {
  const { marketplaces } = parseKnownMarketplaces(MARKETPLACES);

  // T2.6 was respecified as a staleness report over lastUpdated because no
  // auto-update flag exists anywhere. Losing this field guts the feature.
  for (const entry of marketplaces) {
    assert.equal(typeof entry.lastUpdated, 'string', `${entry.name} lost lastUpdated`);
  }
});

test('no auto-update field is invented from the captured shape', () => {
  const { marketplaces } = parseKnownMarketplaces(MARKETPLACES);
  for (const entry of marketplaces) {
    assert.ok(!('autoUpdate' in entry), 'trap 5: no such flag exists');
  }
});

test('distribution starts unknown and is only set by the probe', () => {
  const { marketplaces } = parseKnownMarketplaces(MARKETPLACES);
  for (const entry of marketplaces) assert.equal(entry.distribution, 'unknown');
});

// ---------------------------------------------------------------------------
// Clone probe
// ---------------------------------------------------------------------------

test('a .gcs-sha sidecar is detected as gcs — the majority marketplace', async (t) => {
  const root = tempTree(t, {
    'marketplaces/official/.gcs-sha': `${'c'.repeat(40)}\n`,
    'marketplaces/official/.claude-plugin/marketplace.json': '{}',
  });

  const probed = await probeDistribution(path.join(root, 'marketplaces', 'official'));

  // claude-plugins-official holds 276 of 281 available plugins and has no
  // .git at all, so a resolver assuming git fails on the common case.
  assert.equal(probed.distribution, 'gcs');
  assert.equal(probed.headSha, 'c'.repeat(40));
});

test('a git checkout resolves HEAD through its ref', async (t) => {
  const sha = 'd'.repeat(40);
  const root = tempTree(t, {
    'mkt/.git/HEAD': 'ref: refs/heads/main\n',
    'mkt/.git/refs/heads/main': `${sha}\n`,
  });

  const probed = await probeDistribution(path.join(root, 'mkt'));
  assert.equal(probed.distribution, 'git');
  assert.equal(probed.headSha, sha);
});

test('a detached HEAD holds the sha directly', async (t) => {
  const sha = 'e'.repeat(40);
  const root = tempTree(t, { 'mkt/.git/HEAD': `${sha}\n` });

  const probed = await probeDistribution(path.join(root, 'mkt'));
  assert.equal(probed.distribution, 'git');
  assert.equal(probed.headSha, sha);
});

test('a reachable directory that is neither git nor gcs is local, not unknown', async (t) => {
  const root = tempTree(t, { 'mkt/.claude-plugin/marketplace.json': '{}' });

  const probed = await probeDistribution(path.join(root, 'mkt'));
  assert.equal(probed.distribution, 'local');
  assert.equal(probed.headSha, undefined);
});

test('an unreachable clone is unknown — an admission, not a fourth distribution', async () => {
  const probed = await probeDistribution(path.join(tmpdir(), 'ccatlas-does-not-exist-xyz'));
  assert.equal(probed.distribution, 'unknown');

  assert.deepEqual(await probeDistribution(undefined), { distribution: 'unknown' });
});

// ---------------------------------------------------------------------------
// The collector
// ---------------------------------------------------------------------------

test('collects from the committed fixture corpus with zero egress', async () => {
  const collector = createRegistryCollector();
  const result = await collector.collect(ctx({ fixtureRoot }));

  assert.equal(result.ok, true);
  assert.equal(result.data.installed.length, 5);
  assert.equal(result.data.marketplaces.length, 4);
  assert.equal(result.data.registryVersion, SUPPORTED_REGISTRY_VERSION);
});

test('fixture mode does not probe, and says so rather than guessing', async () => {
  const result = await createRegistryCollector().collect(ctx({ fixtureRoot }));

  for (const entry of result.data.marketplaces) assert.equal(entry.distribution, 'unknown');
  assert.ok(
    result.warnings.some((w) => w.code === 'partial' && w.message.includes('not probed')),
    'an unprobed distribution must be announced, not silently defaulted',
  );
});

test('an absent registry is partial, not a failure — a machine with no plugins', async (t) => {
  const root = tempTree(t, { '.claude/plugins/.keep': '' });
  const result = await createRegistryCollector({ roots: { home: root } }).collect(ctx());

  assert.equal(result.ok, true, 'no plugins installed is an answer, not a broken section');
  assert.deepEqual(result.data.installed, []);
  assert.equal(result.warnings.filter((w) => w.code === 'partial').length, 2);
  assert.ok(result.warnings.every((w) => w.code !== 'collector-failed'));
});

test('a corrupt registry degrades the section and keeps the run', async (t) => {
  const root = tempTree(t, {
    '.claude/plugins/installed_plugins.json': '{"version": 2, "plugins": {',
    '.claude/plugins/known_marketplaces.json': JSON.stringify(MARKETPLACES),
  });

  const result = await createRegistryCollector({ roots: { home: root } }).collect(ctx());

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.installed, []);
  // The other file still parsed — one corrupt input degrades one thing.
  assert.equal(result.data.marketplaces.length, 4);
  assert.ok(result.warnings.some((w) => w.message.includes('not valid JSON')));
});

test('reads a real home layout and probes the clones it finds', async (t) => {
  const sha = 'f'.repeat(40);
  const root = tempTree(t, {
    '.claude/plugins/installed_plugins.json': JSON.stringify({
      version: 2,
      plugins: { 'p@local-mkt': [{ scope: 'user', version: '1.2.3', gitCommitSha: sha }] },
    }),
    '.claude/plugins/marketplaces/local-mkt/.gcs-sha': `${sha}\n`,
  });

  // known_marketplaces.json must point at the real temp path, not a literal.
  writeFileSync(
    path.join(root, '.claude', 'plugins', 'known_marketplaces.json'),
    JSON.stringify({
      'local-mkt': {
        source: { source: 'github', repo: 'o/r' },
        installLocation: path.join(root, '.claude', 'plugins', 'marketplaces', 'local-mkt'),
        lastUpdated: '2026-07-31T08:10:55.364Z',
      },
    }),
    'utf8',
  );

  const result = await createRegistryCollector({ roots: { home: root } }).collect(ctx());

  assert.equal(result.ok, true);
  assert.equal(result.data.installed[0].gitCommitSha, sha);
  assert.equal(result.data.marketplaces[0].distribution, 'gcs');
  assert.equal(result.data.marketplaces[0].headSha, sha);
});

test('the collector never writes to the tree it reads', async (t) => {
  const root = tempTree(t, {
    '.claude/plugins/installed_plugins.json': JSON.stringify(INSTALLED),
    '.claude/plugins/known_marketplaces.json': JSON.stringify(MARKETPLACES),
  });

  const before = readFileSync(path.join(root, '.claude', 'plugins', 'installed_plugins.json'), 'utf8');
  await createRegistryCollector({ roots: { home: root } }).collect(ctx());
  const after = readFileSync(path.join(root, '.claude', 'plugins', 'installed_plugins.json'), 'utf8');

  assert.equal(before, after);
});

// ---------------------------------------------------------------------------
// Cache enumeration — T1.15's input
// ---------------------------------------------------------------------------

test('enumerates cache versions including the literal "unknown" directory', async (t) => {
  const root = tempTree(t, {
    'cache/mkt/plug/1.0.0/.claude-plugin/plugin.json': '{}',
    'cache/mkt/plug/2.0.0/.claude-plugin/plugin.json': '{}',
    'cache/mkt/other/unknown/.claude-plugin/plugin.json': '{}',
  });

  const found = await enumerateCacheVersions(path.join(root, 'cache'));

  assert.equal(found.length, 3);
  assert.ok(found.some((entry) => entry.plugin === 'other' && entry.version === 'unknown'));
});

test('.in_use is honoured as a DIRECTORY — a file check reports every version orphaned', async (t) => {
  const root = tempTree(t, {
    'cache/mkt/plug/1.0.0/.claude-plugin/plugin.json': '{}',
    // `.in_use` is a directory upstream; creating a file inside it makes it one.
    'cache/mkt/plug/1.0.0/.in_use/marker': '',
    'cache/mkt/plug/0.9.0/.claude-plugin/plugin.json': '{}',
  });

  const found = await enumerateCacheVersions(path.join(root, 'cache'));
  const live = found.find((entry) => entry.version === '1.0.0');
  const orphan = found.find((entry) => entry.version === '0.9.0');

  assert.equal(typeof live.inUseMtimeMs, 'number', '[ -f .in_use ] would report this orphaned');
  assert.equal(orphan.inUseMtimeMs, undefined);
});

test('an absent cache root enumerates to nothing rather than throwing', async () => {
  assert.deepEqual(await enumerateCacheVersions(path.join(tmpdir(), 'ccatlas-no-cache-xyz')), []);
});
