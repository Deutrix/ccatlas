/**
 * T1.11 📏 — the inventory perf floors.
 *
 * ## What is being certified, and what is not
 *
 * The floors are defined *at reference scale*: ≥5 marketplaces, ≥20 plugins,
 * ≥30 skills, ≥8 MCP servers. The reference machine has 4 / 5 / 161 / 14 — it
 * is short on the two dimensions that dominate the cold path, so a green
 * number measured against it would be worse than no number. The synthetic
 * scale tree from T1.29 exists for exactly this and meets every floor:
 * 6 / 24 / 46 / 14.
 *
 * The honest caveat is that it is *structurally* at reference scale, not
 * *materially* — the files are generated, so their sizes are representative
 * rather than observed. Every assertion below is therefore a floor on the
 * work the code does over a tree of that shape, which is what the budget is
 * about. The scale actually exercised is asserted first, so a shrunken corpus
 * cannot quietly turn this suite green.
 *
 * ## The one thing these numbers do NOT include
 *
 * The `cli` collector here replays captured fixtures. In production it spawns
 * `claude plugin list --json` three times, and process spawn plus Claude
 * Code's own startup is very likely the dominant term in the 2s cold budget —
 * `claude mcp list` alone took ~40s on the reference machine, which is why it
 * is opt-in. So a green cold number here certifies **ccatlas's own work**, not
 * end-to-end `status` latency. The end-to-end figure needs a live-run
 * benchmark against a reference-scale machine, which does not exist yet; until
 * it does, the 📏 gate is met for the parsing and merging path only, and that
 * limitation belongs in any release note that cites it.
 *
 * ## Why the thresholds are asserted with headroom
 *
 * CI runners are shared and noisy, and a perf test that fails on an unlucky
 * scheduling slice teaches the team to rerun rather than to look. The budget
 * numbers are asserted as stated; the measured values are printed so a
 * regression shows up as a trend even while the assertion still passes.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createCliCollector } from '../../src/collectors/cli.ts';
import { collectConfig } from '../../src/collectors/config.ts';
import { createMcpCollector } from '../../src/collectors/mcp.ts';
import { createRegistryCollector } from '../../src/collectors/registry.ts';
import { collectSkills } from '../../src/collectors/skills.ts';
import { runCollector } from '../../src/collectors/isolate.ts';
import { buildInventory } from '../../src/services/inventory.ts';
import { fingerprintInputs, readCache, writeCache } from '../../src/services/cache.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtureRoot = path.join(repoRoot, 'fixtures');
const scaleHome = path.join(fixtureRoot, 'synthetic', 'scale', 'tree', 'home');

/** The floors T1.11 is defined against. Asserted, not assumed. */
const REFERENCE_SCALE = { marketplaces: 5, plugins: 20, skills: 30, mcpServers: 8 };

/** 📏 The budget, verbatim from the global constraints. */
const BUDGET_CACHED_MS = 200;
const BUDGET_COLD_MS = 2000;

const ctx = { offline: true };

/**
 * One cold collection over the scale tree.
 *
 * The `cli` collector replays the real captured corpus rather than the
 * synthetic tree — there is no synthetic CLI output, and its cost is fixture
 * file reads either way. The filesystem walk is where the cold path actually
 * spends, and that runs entirely against the scale tree.
 */
async function coldRun() {
  const roots = { roots: { home: scaleHome } };

  const [cli, config, registry, skills, mcp] = await Promise.all([
    runCollector(createCliCollector(), { ...ctx, fixtureRoot }),
    runCollector({ name: 'config', collect: (c) => collectConfig(c, roots) }, ctx),
    runCollector(createRegistryCollector(roots), ctx),
    runCollector({ name: 'skills', collect: (c) => collectSkills(c, roots) }, ctx),
    runCollector(
      createMcpCollector({ claudeJsonPath: path.join(scaleHome, '.claude.json') }),
      ctx,
    ),
  ]);

  return buildInventory({ cli, config, registry, skills, mcp });
}

const ms = (value) => `${value.toFixed(1)}ms`;

// ---------------------------------------------------------------------------
// The corpus itself
// ---------------------------------------------------------------------------

test('the synthetic corpus actually meets reference scale', () => {
  const installed = JSON.parse(
    readFileSync(path.join(scaleHome, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'),
  );
  const marketplaces = JSON.parse(
    readFileSync(path.join(scaleHome, '.claude', 'plugins', 'known_marketplaces.json'), 'utf8'),
  );

  // Without this, shrinking the corpus would make every budget below pass for
  // the wrong reason — the exact failure the ledger warns about twice.
  assert.ok(
    Object.keys(installed.plugins).length >= REFERENCE_SCALE.plugins,
    `corpus has ${Object.keys(installed.plugins).length} plugins, floor is ${REFERENCE_SCALE.plugins}`,
  );
  assert.ok(
    Object.keys(marketplaces).length >= REFERENCE_SCALE.marketplaces,
    `corpus has ${Object.keys(marketplaces).length} marketplaces, floor is ${REFERENCE_SCALE.marketplaces}`,
  );
});

test('a cold run over the scale tree sees the whole corpus', async () => {
  const inventory = await coldRun();

  assert.deepEqual(inventory.degraded, [], 'a degraded section would make the timing meaningless');

  // The registry layer alone sees all 24; the CLI layer replays the 5-plugin
  // real capture, so merged output is the union and every synthetic plugin
  // arrives file-only. That is the shape being timed.
  const fileOnly = inventory.plugins.filter((p) => p.sources.length === 1 && p.sources[0] === 'file');
  assert.ok(
    fileOnly.length >= REFERENCE_SCALE.plugins,
    `only ${fileOnly.length} scale-tree plugins reached the inventory`,
  );
  assert.ok(inventory.skills.length >= REFERENCE_SCALE.skills, `${inventory.skills.length} skills`);
});

// ---------------------------------------------------------------------------
// 📏 The budgets
// ---------------------------------------------------------------------------

test('📏 a cold inventory completes under 2s at reference scale', async (t) => {
  await coldRun(); // Warm the OS page cache; the budget is not a cold-disk budget.

  const started = performance.now();
  const inventory = await coldRun();
  const elapsed = performance.now() - started;

  t.diagnostic(`cold inventory at reference scale: ${ms(elapsed)} (budget ${BUDGET_COLD_MS}ms)`);
  assert.deepEqual(inventory.degraded, []);
  assert.ok(elapsed < BUDGET_COLD_MS, `cold run took ${ms(elapsed)}, budget is ${BUDGET_COLD_MS}ms`);
});

test('📏 a cached read completes under 200ms at reference scale', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'ccatlas-perf-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));

  const inputs = [
    path.join(scaleHome, '.claude.json'),
    path.join(scaleHome, '.claude', 'settings.json'),
    path.join(scaleHome, '.claude', 'settings.local.json'),
    path.join(scaleHome, '.claude', 'plugins', 'installed_plugins.json'),
    path.join(scaleHome, '.claude', 'plugins', 'known_marketplaces.json'),
  ];

  const inventory = await coldRun();
  const fingerprint = await fingerprintInputs(inputs);
  assert.deepEqual(await writeCache('inventory', fingerprint, inventory, { stateDir }), []);

  // The measured path is what `status --cached` actually does: fingerprint the
  // inputs, then read. Timing the read alone would flatter the number by
  // omitting the N stats that make the answer trustworthy.
  const started = performance.now();
  const readFingerprint = await fingerprintInputs(inputs);
  const read = await readCache('inventory', readFingerprint, { stateDir });
  const elapsed = performance.now() - started;

  t.diagnostic(`cached read at reference scale: ${ms(elapsed)} (budget ${BUDGET_CACHED_MS}ms)`);
  assert.equal(read.hit, true, 'a miss would time the wrong thing entirely');
  assert.equal(read.value.plugins.length, inventory.plugins.length);
  assert.ok(elapsed < BUDGET_CACHED_MS, `cached read took ${ms(elapsed)}, budget is ${BUDGET_CACHED_MS}ms`);
});

test('the cached path is materially cheaper than the cold one', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'ccatlas-perf-ratio-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));

  const inputs = [path.join(scaleHome, '.claude.json')];
  const fingerprint = await fingerprintInputs(inputs);
  await writeCache('inventory', fingerprint, await coldRun(), { stateDir });

  const coldStarted = performance.now();
  await coldRun();
  const cold = performance.now() - coldStarted;

  const cachedStarted = performance.now();
  await readCache('inventory', await fingerprintInputs(inputs), { stateDir });
  const cached = performance.now() - cachedStarted;

  t.diagnostic(`cold ${ms(cold)} vs cached ${ms(cached)}`);
  // A cache that is not decisively faster is a cache that is not earning its
  // invalidation complexity. Stated as a wide ratio so runner noise cannot
  // fail it, while a cache that stopped working still would.
  assert.ok(cached * 3 < cold, `cached ${ms(cached)} is not decisively faster than cold ${ms(cold)}`);
});
