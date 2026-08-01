/**
 * T1.6 · T1.7 · T1.8 · T1.9 — the inventory service.
 *
 * The tests that matter here are the negative ones. "Prefer CLI, fall back to
 * file" typechecks perfectly, produces a plausible inventory, and violates a
 * stated architecture invariant — so most of this file is about proving that
 * disagreements are *kept*, not resolved.
 *
 * Everything runs through the real collectors against the committed fixture
 * corpus wherever possible, because a service tested only against hand-built
 * objects is a service tested against the author's idea of the format.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createCliCollector } from '../../src/collectors/cli.ts';
import { collectConfig, SETTINGS_PRECEDENCE } from '../../src/collectors/config.ts';
import { createRegistryCollector } from '../../src/collectors/registry.ts';
import { runCollector } from '../../src/collectors/isolate.ts';
import {
  buildInventory,
  detectShadowing,
  mergeMarketplaces,
  mergePlugins,
  reconcile,
  resolveVersion,
  SCOPE_RANK,
} from '../../src/services/inventory.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtureRoot = path.join(repoRoot, 'fixtures');
const ctx = { offline: true, fixtureRoot };

const warnings = () => [];

/** A minimal CLI plugin row, in the shape `parsePluginList` emits. */
const cliRow = (over = {}) => ({
  id: { name: 'p@mkt', scope: 'user', kind: 'plugin' },
  origin: 'marketplace',
  state: 'enabled',
  source: 'cli',
  marketplace: 'mkt',
  enabled: true,
  version: { version: '1.0.0', versionSource: 'plugin-json' },
  contributes: { skills: 0, agents: 0, hooks: 0, mcpServers: 0, lspServers: 0 },
  ...over,
});

const fileRow = (over = {}) => ({ key: 'p@mkt', scope: 'user', version: '1.0.0', ...over });

const entity = (kind, name, scope) => ({
  id: { name, scope, kind },
  origin: 'personal',
  state: 'enabled',
  source: 'file',
});

// ---------------------------------------------------------------------------
// T1.8 — reconciliation never picks
// ---------------------------------------------------------------------------

test('agreement collapses to one value with no warning', () => {
  const w = warnings();
  assert.deepEqual(reconcile('version', 'p', '1.0.0', '1.0.0', w), { value: '1.0.0', source: 'cli' });
  assert.deepEqual(w, []);
});

test('a field only the file layer has is tagged file, not discarded', () => {
  const w = warnings();
  assert.deepEqual(reconcile('sha', 'p', undefined, 'abc', w), { value: 'abc', source: 'file' });
  assert.deepEqual(w, [], 'a single-source fact is not a disagreement');
});

test('DISAGREEMENT keeps both values and warns — the T1.8 invariant', () => {
  const w = warnings();
  const merged = reconcile('version', 'p@mkt', '2.0.0', '1.0.0', w);

  // The loser is retained. `prefer CLI, fall back to file` would return
  // {value:'2.0.0'} with no trace that the file said something else — the same
  // shape, silently missing the finding.
  assert.deepEqual(merged, {
    value: '2.0.0',
    source: 'cli',
    conflictsWith: { value: '1.0.0', source: 'file' },
  });

  assert.equal(w.length, 1);
  assert.equal(w[0].code, 'reconciliation');
  assert.equal(w[0].subject, 'p@mkt');
  assert.ok(w[0].message.includes('2.0.0') && w[0].message.includes('1.0.0'));
});

test('neither layer having the field yields undefined, not a fabricated default', () => {
  const w = warnings();
  assert.equal(reconcile('installedAt', 'p', undefined, undefined, w), undefined);
  assert.deepEqual(w, []);
});

test('a version disagreement surfaces on the merged plugin, not only in the warning', () => {
  const { plugins, warnings: w } = mergePlugins(
    [cliRow({ version: { version: '2.0.0', versionSource: 'plugin-json' } })],
    [fileRow({ version: '1.0.0' })],
  );

  assert.equal(plugins.length, 1);
  assert.deepEqual(plugins[0].sources, ['cli', 'file']);
  assert.deepEqual(plugins[0].reconciled.version.conflictsWith, { value: '1.0.0', source: 'file' });
  assert.equal(w.filter((x) => x.code === 'reconciliation').length, 1);
});

test('agreeing plugins carry no `reconciled` key at all', () => {
  const { plugins, warnings: w } = mergePlugins([cliRow()], [fileRow()]);

  assert.equal(plugins[0].reconciled, undefined, 'absence is the signal that nothing disagreed');
  assert.deepEqual(w, []);
});

test('a plugin only the CLI reports is kept — sideloads never touch the registry', () => {
  const { plugins, warnings: w } = mergePlugins(
    [cliRow({ id: { name: 'side@inline', scope: 'session', kind: 'plugin' } })],
    [],
  );

  assert.equal(plugins.length, 1);
  assert.deepEqual(plugins[0].sources, ['cli']);
  assert.deepEqual(w, [], '--plugin-dir sideloads are absent from installed_plugins.json by design');
});

test('a plugin only the registry file reports is surfaced as a half-removed install', () => {
  const { plugins, warnings: w } = mergePlugins([], [fileRow({ key: 'ghost@mkt' })]);

  assert.equal(plugins.length, 1, 'dropping it would hide a real broken state');
  assert.deepEqual(plugins[0].sources, ['file']);
  assert.equal(plugins[0].state, 'error');
  assert.equal(plugins[0].enabled, false);
  assert.ok(w.some((x) => x.code === 'reconciliation' && x.subject === 'ghost@mkt'));
});

// ---------------------------------------------------------------------------
// T1.6 — keying
// ---------------------------------------------------------------------------

test('keying is (name, scope): one plugin at two scopes stays two records', () => {
  const { plugins } = mergePlugins(
    [
      cliRow({ version: { version: '1.0.0', versionSource: 'plugin-json' } }),
      cliRow({
        id: { name: 'p@mkt', scope: 'project', kind: 'plugin' },
        version: { version: '2.0.0', versionSource: 'plugin-json' },
      }),
    ],
    [fileRow({ version: '1.0.0' }), fileRow({ scope: 'project', version: '2.0.0' })],
  );

  assert.equal(plugins.length, 2);
  // Keyed on name alone, the project row would match the user file record and
  // report a phantom 1.0.0-vs-2.0.0 conflict on both.
  for (const plugin of plugins) assert.equal(plugin.reconciled, undefined);
});

test('two same-scope records for one plugin warn rather than one vanishing', () => {
  const { warnings: w } = mergePlugins(
    [cliRow()],
    [fileRow({ version: '1.0.0' }), fileRow({ version: '1.0.1' })],
  );

  assert.ok(w.some((x) => x.code === 'partial' && x.subject === 'p@mkt'));
});

// ---------------------------------------------------------------------------
// T1.9 — version resolution
// ---------------------------------------------------------------------------

test('plugin.json wins and records which rule fired', () => {
  const resolved = resolveVersion({ pluginJsonVersion: '6.2.0' });
  assert.equal(resolved.version, '6.2.0');
  assert.equal(resolved.versionSource, 'plugin-json');
});

test('the marketplace entry decides only when plugin.json is absent', () => {
  const resolved = resolveVersion({ marketplaceEntryVersion: '2.2.1' });
  assert.equal(resolved.version, '2.2.1');
  assert.equal(resolved.versionSource, 'marketplace-entry');
});

test('source.sha is a real fifth mechanism, not a version-source impostor', () => {
  const sha = 'a'.repeat(40);
  const resolved = resolveVersion({ sourceSha: sha });

  // 142 of 276 entries in the largest marketplace pin this way. Re-pinning is
  // an upstream marketplace edit, not a version bump — different update
  // semantics, which is why the rule that fired is recorded.
  assert.equal(resolved.versionSource, 'marketplace-source-sha');
  assert.equal(resolved.sourceSha, sha);
});

test('gitCommitSha is NEVER a versionSource — rule 3 does not exist', () => {
  const sha = 'b'.repeat(40);
  const resolved = resolveVersion({ pluginJsonVersion: '6.2.0', gitCommitSha: sha });

  assert.equal(resolved.versionSource, 'plugin-json');
  assert.equal(resolved.installedSha, sha, 'it is drift evidence, carried alongside');
  assert.notEqual(resolved.version, sha);
});

test('no declaration anywhere resolves to the literal "unknown"', () => {
  const resolved = resolveVersion({});
  assert.equal(resolved.version, 'unknown');
  assert.equal(resolved.versionSource, 'unknown');
});

test('an explicit "unknown" version is not mistaken for a marketplace fallback', () => {
  // frontend-design: a relative path inside a non-git clone. The cache dir is
  // literally `.../unknown/`. It must not silently adopt an entry version.
  const resolved = resolveVersion({ pluginJsonVersion: 'unknown' });
  assert.equal(resolved.version, 'unknown');
  assert.equal(resolved.versionSource, 'unknown');
});

test('double declaration flags ONLY when the two values differ', () => {
  // The real divergence: ui-ux-pro-max, plugin.json 2.5.0 vs entry 2.2.1.
  const divergent = resolveVersion({ pluginJsonVersion: '2.5.0', marketplaceEntryVersion: '2.2.1' });
  assert.deepEqual(divergent.doubleDeclared, { effective: '2.5.0', masked: '2.2.1' });
  assert.equal(divergent.version, '2.5.0', 'plugin.json wins silently upstream; we say so');

  // The false-positive guard: everything-claude-code, 1.9.0 both. Flagging
  // this would trip every well-maintained plugin and train the user to ignore
  // the diagnostic entirely.
  const agreeing = resolveVersion({ pluginJsonVersion: '1.9.0', marketplaceEntryVersion: '1.9.0' });
  assert.equal(agreeing.doubleDeclared, undefined);
});

// ---------------------------------------------------------------------------
// T1.7 — shadowing reports both
// ---------------------------------------------------------------------------

test('a name at two scopes reports the winner AND the loser', () => {
  const personal = entity('skill', 'deploy', 'user');
  const project = entity('skill', 'deploy', 'project');

  const { groups, annotated, warnings: w } = detectShadowing([personal, project]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].effective.scope, 'project');
  assert.deepEqual(groups[0].shadowed, [personal.id]);

  // The loser survives in the output, marked. Claude Code itself only ever
  // shows the winner — which is exactly why the user cannot see the problem.
  const loser = annotated.find((e) => e.id.scope === 'user');
  assert.equal(loser.state, 'shadowed');
  assert.deepEqual(loser.shadowedBy, project.id);

  const winner = annotated.find((e) => e.id.scope === 'project');
  assert.deepEqual(winner.shadows, [personal.id]);
  assert.equal(w[0].code, 'shadowed');
});

test('precedence orders managed above every other scope', () => {
  const { groups } = detectShadowing([
    entity('skill', 'x', 'user'),
    entity('skill', 'x', 'project'),
    entity('skill', 'x', 'managed'),
  ]);

  assert.equal(groups[0].effective.scope, 'managed');
  // Losers are ordered highest-precedence first, so a surface can render
  // "what would win if you removed the managed one" without re-sorting.
  assert.deepEqual(groups[0].shadowed.map((id) => id.scope), ['project', 'user']);
});

test('the same name at the same scope is not a shadow', () => {
  const { groups, warnings: w } = detectShadowing([
    entity('skill', 'x', 'user'),
    entity('skill', 'x', 'user'),
  ]);

  assert.deepEqual(groups, [], 'that is one entity seen twice — dedupe belongs to the merge');
  assert.deepEqual(w, []);
});

test('the same name in different kinds is not a shadow', () => {
  const { groups } = detectShadowing([entity('skill', 'x', 'user'), entity('agent', 'x', 'project')]);
  assert.deepEqual(groups, [], 'a skill and an agent named alike never mask each other');
});

test('case-only differences shadow, because two of three platforms say so', () => {
  const { groups } = detectShadowing([
    entity('command', 'Deploy', 'user'),
    entity('command', 'deploy', 'project'),
  ]);

  // Windows and macOS collapse these; Linux does not. A stack that behaves
  // differently per platform is the finding, so it is reported everywhere.
  assert.equal(groups.length, 1);
});

test('entities with no conflict pass through byte-identical', () => {
  const only = entity('skill', 'solo', 'user');
  const { annotated, groups } = detectShadowing([only]);

  assert.deepEqual(groups, []);
  assert.equal(annotated[0], only, 'no needless copy, and no invented fields');
});

// ---------------------------------------------------------------------------
// Marketplaces
// ---------------------------------------------------------------------------

test('lastUpdated comes from the file layer — the CLI does not carry it', () => {
  const { marketplaces } = mergeMarketplaces(
    [
      {
        id: { name: 'mkt', scope: 'user', kind: 'marketplace' },
        origin: 'marketplace',
        state: 'enabled',
        source: 'cli',
        distribution: 'git',
      },
    ],
    [{ name: 'mkt', distribution: 'gcs', lastUpdated: '2026-03-30T14:49:21.944Z' }],
  );

  assert.equal(marketplaces[0].lastUpdated, '2026-03-30T14:49:21.944Z');
  // The probe looked at the clone; the CLI guessed from a hardcoded name set.
  assert.equal(marketplaces[0].distribution, 'gcs');
});

test('an unprobed file record never downgrades a real CLI inference', () => {
  const { marketplaces } = mergeMarketplaces(
    [
      {
        id: { name: 'mkt', scope: 'user', kind: 'marketplace' },
        origin: 'marketplace',
        state: 'enabled',
        source: 'cli',
        distribution: 'gcs',
      },
    ],
    [{ name: 'mkt', distribution: 'unknown' }],
  );

  assert.equal(marketplaces[0].distribution, 'gcs', 'unknown means unreachable, not "not git"');
});

// ---------------------------------------------------------------------------
// Composition, against the real collectors
// ---------------------------------------------------------------------------

test('builds a full inventory from the fixture corpus', async () => {
  const cli = await runCollector(createCliCollector(), ctx);
  const registry = await runCollector(createRegistryCollector(), ctx);

  const inventory = buildInventory({ cli, registry, elapsedMs: 1 });

  assert.deepEqual(inventory.degraded, []);
  assert.equal(inventory.plugins.length, 5);
  assert.equal(inventory.marketplaces.length, 4);

  // Every installed plugin was seen by both layers, so every one reconciled.
  for (const plugin of inventory.plugins) {
    assert.deepEqual(plugin.sources, ['cli', 'file'], `${plugin.id.name} lost a layer`);
  }
});

test('gitCommitSha reaches the merged inventory — the CLI cannot supply it', async () => {
  const cli = await runCollector(createCliCollector(), ctx);
  const registry = await runCollector(createRegistryCollector(), ctx);
  const inventory = buildInventory({ cli, registry });

  const superpowers = inventory.plugins.find((p) => p.id.name.startsWith('superpowers@'));
  assert.equal(superpowers.version.installedSha, 'eafe962b18f6c5dc70fb7c8cc7e83e61f4cdde06');

  // Without the registry collector this field is unobtainable, and T2.4's
  // stale-pin diagnostic — the differentiator — has nothing to compare.
  const withoutRegistry = buildInventory({ cli });
  const same = withoutRegistry.plugins.find((p) => p.id.name.startsWith('superpowers@'));
  assert.equal(same.version.installedSha, undefined);
});

test('the fixture corpus reconciles cleanly — no disagreement between layers', async () => {
  const cli = await runCollector(createCliCollector(), ctx);
  const registry = await runCollector(createRegistryCollector(), ctx);
  const inventory = buildInventory({ cli, registry });

  const conflicts = inventory.warnings.filter((w) => w.code === 'reconciliation');
  assert.deepEqual(
    conflicts,
    [],
    'the captured CLI and file layers agreed on 2.1.220; a conflict here is a regression',
  );
});

test('a failed collector degrades one section and names it', () => {
  const inventory = buildInventory({
    cli: {
      name: 'cli',
      status: 'failed',
      ok: false,
      data: null,
      mode: 'threw',
      error: { code: 'x', message: 'boom' },
      warnings: [{ code: 'collector-failed', message: 'cli: boom', subject: 'cli' }],
      elapsedMs: 1,
    },
    registry: {
      name: 'registry',
      status: 'ok',
      ok: true,
      data: { installed: [fileRow({ key: 'ghost@mkt' })], marketplaces: [] },
      warnings: [],
      elapsedMs: 1,
    },
  });

  assert.deepEqual(inventory.degraded, ['cli']);
  // The surviving section still produced data, which is the whole point of
  // T1.5 — and `degraded` is what stops a surface reading the empty plugin
  // list as "nothing is installed".
  assert.equal(inventory.plugins.length, 1);
});

test('a partial section is listed as partial, never as failed', () => {
  const inventory = buildInventory({
    cli: {
      name: 'cli',
      status: 'ok',
      ok: true,
      data: { plugins: [], available: [], marketplaces: [], mcpServers: [] },
      warnings: [{ code: 'partial', message: 'mcp list skipped' }],
      elapsedMs: 1,
    },
  });

  assert.deepEqual(inventory.partial, ['cli']);
  assert.deepEqual(inventory.degraded, []);
});

test('settings and the CLI disagreeing about `enabled` is reported, not resolved', () => {
  const inventory = buildInventory({
    cli: {
      name: 'cli',
      status: 'ok',
      ok: true,
      data: { plugins: [cliRow({ enabled: true })], available: [], marketplaces: [], mcpServers: [] },
      warnings: [],
      elapsedMs: 1,
    },
    config: {
      name: 'config',
      status: 'ok',
      ok: true,
      data: { enabledPlugins: { 'p@mkt': { value: false, scope: 'user' } } },
      warnings: [],
      elapsedMs: 1,
    },
  });

  const conflict = inventory.warnings.find((w) => w.code === 'reconciliation');
  assert.ok(conflict, 'enabledPlugins is the only home of the enabled bit; a mismatch is a finding');
  assert.deepEqual(inventory.plugins[0].reconciled.enabled.conflictsWith, {
    value: false,
    source: 'file',
  });
});

test('an absent collector is not the same as a failed one', () => {
  const inventory = buildInventory({});

  assert.deepEqual(inventory.degraded, [], 'a section that was never asked for is not degraded');
  assert.deepEqual(inventory.plugins, []);
});

// ---------------------------------------------------------------------------
// Warnings must survive the service layer
// ---------------------------------------------------------------------------

test('a failed section carries its REASON, not just its name', () => {
  const inventory = buildInventory({
    cli: {
      name: 'cli',
      status: 'failed',
      ok: false,
      data: null,
      mode: 'timeout',
      error: { code: 'collector-timeout', message: 'timed out after 60000ms' },
      warnings: [
        { code: 'collector-failed', message: 'cli: timed out after 60000ms', subject: 'cli' },
      ],
      elapsedMs: 60_000,
    },
  });

  // `degraded: ['cli']` with the message dropped defeats isolate.ts's own
  // guarantee that a degraded section explains its own emptiness — and the
  // loss is invisible, because the section name still looks right.
  const failure = inventory.warnings.find((w) => w.code === 'collector-failed');
  assert.ok(failure, 'the reason vanished between the collector and the inventory');
  assert.match(failure.message, /timed out/);
  assert.equal(failure.collector, 'cli', 'warnings are tagged with the section they came from');
});

test('a partial section carries its reason too', async () => {
  const registry = await runCollector(createRegistryCollector(), ctx);
  const inventory = buildInventory({ registry });

  // The registry collector announces that it did not probe the clones. That
  // warning is what stops a surface rendering `distribution: unknown` as a
  // fact about the machine.
  assert.ok(
    inventory.warnings.some((w) => w.code === 'partial' && w.message.includes('not probed')),
    'the collector said something the inventory failed to pass on',
  );
});

test('the natural call harvests warnings; extraWarnings does not double them', async () => {
  const registry = await runCollector(createRegistryCollector(), ctx);

  const plain = buildInventory({ registry });
  const withExtra = buildInventory({
    registry,
    extraWarnings: [{ code: 'partial', message: 'transcripts unavailable', collector: 'transcripts' }],
  });

  // `extraWarnings` is for collectors NOT passed above. Threading aggregate()'s
  // full list through it would report every warning twice, so the field is
  // documented as supplemental and tested as such.
  assert.equal(withExtra.warnings.length, plain.warnings.length + 1);
  assert.ok(withExtra.warnings.some((w) => w.collector === 'transcripts'));
});

// ---------------------------------------------------------------------------
// Composition against the real config collector
// ---------------------------------------------------------------------------

test('enabledPlugins is keyed <plugin>@<marketplace> — verified, not assumed', async () => {
  const scaleHome = path.join(fixtureRoot, 'synthetic', 'scale', 'tree', 'home');
  const config = await runCollector(
    { name: 'config', collect: (c) => collectConfig(c, { roots: { home: scaleHome } }) },
    { offline: true },
  );

  assert.equal(config.status, 'ok');
  const keys = Object.keys(config.data.enabledPlugins);
  assert.ok(keys.length > 0, 'the scale tree must declare enabledPlugins or this proves nothing');

  // If the key form differed from `plugin.id.name`, the enabled reconciliation
  // would silently never fire and every hand-built test would still pass.
  for (const key of keys) {
    assert.match(key, /^[^@]+@[^@]+$/, `enabledPlugins key "${key}" is not <plugin>@<marketplace>`);
  }
});

test('the real config collector reconciles enabled against the registry layer', async () => {
  const scaleHome = path.join(fixtureRoot, 'synthetic', 'scale', 'tree', 'home');
  const roots = { roots: { home: scaleHome } };

  const config = await runCollector(
    { name: 'config', collect: (c) => collectConfig(c, roots) },
    { offline: true },
  );
  const registry = await runCollector(createRegistryCollector(roots), { offline: true });

  const enabledKeys = Object.keys(config.data.enabledPlugins);
  const [firstKey] = enabledKeys;

  // A CLI row asserting the OPPOSITE of what settings declare, keyed exactly
  // as the real settings file keys it. This is the end-to-end proof that the
  // branch is reachable with production key spellings.
  const declared = config.data.enabledPlugins[firstKey].value;
  const inventory = buildInventory({
    cli: {
      name: 'cli',
      status: 'ok',
      ok: true,
      data: {
        plugins: [
          cliRow({
            id: { name: firstKey, scope: 'user', kind: 'plugin' },
            enabled: !declared,
          }),
        ],
        available: [],
        marketplaces: [],
        mcpServers: [],
      },
      warnings: [],
      elapsedMs: 1,
    },
    config,
    registry,
  });

  const conflict = inventory.warnings.find(
    (w) => w.code === 'reconciliation' && w.subject === firstKey,
  );
  assert.ok(conflict, `no enabled conflict raised for ${firstKey}`);

  const plugin = inventory.plugins.find((p) => p.id.name === firstKey);
  assert.equal(plugin.reconciled.enabled.conflictsWith.value, declared);
});

// ---------------------------------------------------------------------------
// Precedence must not drift from the settings resolver
// ---------------------------------------------------------------------------

test('shadowing precedence is DERIVED from SETTINGS_PRECEDENCE, not copied', () => {
  // Two hand-written constants with a comment claiming they agree is how they
  // stop agreeing. Asserted so a change to one is a failure, not a divergence.
  assert.deepEqual(SCOPE_RANK, [...SETTINGS_PRECEDENCE].reverse());
  assert.equal(SCOPE_RANK[0], 'managed', 'managed must outrank everything');
  assert.equal(SCOPE_RANK[SCOPE_RANK.length - 1], 'user');
});
