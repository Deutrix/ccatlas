/**
 * T1.21 — the `status` renderers.
 *
 * The load-bearing tests here are the ones about *emptiness*. `isolate.ts` and
 * `buildInventory` both work hard to keep "this section is empty" distinct
 * from "this section's collector died"; a renderer that prints `Plugins: 0`
 * for both throws that away at the last and most expensive step — the one the
 * user actually reads.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { renderFlat, renderTree } from '../../src/cli/render.ts';

const PLAIN = { color: false, verbose: false };
const COLOURED = { color: true, verbose: false };

/** ANSI escape introducer, built without embedding a control byte here. */
const ESC = String.fromCharCode(27);

const emptyInventory = (over = {}) => ({
  plugins: [],
  marketplaces: [],
  mcpServers: [],
  skills: [],
  agents: [],
  commands: [],
  shadowing: [],
  degraded: [],
  partial: [],
  warnings: [],
  elapsedMs: 12,
  ...over,
});

const result = (inventory, over = {}) => ({
  inventory,
  origin: 'collected',
  warnings: inventory.warnings,
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

// ---------------------------------------------------------------------------
// Empty vs broken — the distinction the whole stack preserves
// ---------------------------------------------------------------------------

test('a genuinely empty section renders as a zero', () => {
  const text = renderTree(result(emptyInventory()), PLAIN);
  assert.match(text, /Plugins: 0/);
});

test('a DEGRADED section renders as unavailable, never as a zero', () => {
  const text = renderTree(result(emptyInventory({ degraded: ['cli'] })), PLAIN);

  // "Plugins: 0" here would be the tool confidently reporting that nothing is
  // installed on a machine whose plugin collector just died — the exact
  // failure isolate.ts exists to prevent, thrown away at the last step.
  assert.ok(!/Plugins: 0/.test(text), 'a broken section must not read as an empty one');
  assert.match(text, /Plugins: unavailable \(cli failed\)/);
});

test('the degraded marker names which collector failed', () => {
  const text = renderTree(result(emptyInventory({ degraded: ['skills'] })), PLAIN);
  assert.match(text, /Skills: unavailable \(skills failed\)/);
  // Sections fed by a healthy collector still report their real count.
  assert.match(text, /Plugins: 0/);
});

test('a partial section is marked incomplete, distinct from both', () => {
  const text = renderTree(result(emptyInventory({ partial: ['cli'] })), PLAIN);
  assert.match(text, /Plugins: 0 \(incomplete\)/);
});

test('the flat renderer announces degraded sections too', () => {
  const text = renderFlat(result(emptyInventory({ degraded: ['mcp'] })), PLAIN);
  // In a flat list the absence of rows is otherwise indistinguishable from
  // nothing being installed.
  assert.match(text, /degraded\tmcp/);
});

// ---------------------------------------------------------------------------
// Warnings are printed, not counted
// ---------------------------------------------------------------------------

test('warnings render in full with their code and section', () => {
  const inventory = emptyInventory({
    warnings: [
      {
        code: 'reconciliation',
        message: 'version is "2.0.0" per the CLI and "1.0.0" per the registry file',
        subject: 'p@mkt',
        collector: 'cli',
      },
    ],
  });

  const text = renderTree(result(inventory), PLAIN);
  // "1 warning" is not the information — it is the absence of it. A
  // reconciliation warning says the machine disagrees with itself.
  assert.match(text, /cli\/reconciliation/);
  assert.match(text, /2\.0\.0.*1\.0\.0/);
});

test('a warning with no collector renders without inventing one', () => {
  const inventory = emptyInventory({
    warnings: [{ code: 'shadowed', message: 'skill "deploy" is defined at 2 scopes' }],
  });

  const text = renderTree(result(inventory), PLAIN);
  assert.match(text, /shadowed/);
  assert.ok(!/undefined/.test(text), 'a missing collector must not print as "undefined"');
});

test('no warnings means no Warnings heading at all', () => {
  assert.ok(!/Warnings/.test(renderTree(result(emptyInventory()), PLAIN)));
});

// ---------------------------------------------------------------------------
// Plugin rendering
// ---------------------------------------------------------------------------

test('plugins group under their marketplace as a tree', () => {
  const inventory = emptyInventory({
    plugins: [
      plugin({ id: { name: 'a@one', scope: 'user', kind: 'plugin' }, marketplace: 'one' }),
      plugin({ id: { name: 'b@two', scope: 'user', kind: 'plugin' }, marketplace: 'two' }),
    ],
  });

  const text = renderTree(result(inventory), PLAIN);
  assert.match(text, /├─ one/);
  assert.match(text, /└─ two/);
  // The marketplace is the parent node, so the leaf shows the bare name.
  assert.match(text, /─ a 1\.0\.0 on/);
});

test('a disabled plugin says so', () => {
  const inventory = emptyInventory({ plugins: [plugin({ enabled: false })] });
  assert.match(renderTree(result(inventory), PLAIN), / off/);
});

test('a reconciled plugin shows WHICH fields disagree', () => {
  const inventory = emptyInventory({
    plugins: [
      plugin({
        reconciled: { version: { value: '2.0.0', source: 'cli', conflictsWith: { value: '1.0.0', source: 'file' } } },
      }),
    ],
  });

  assert.match(renderTree(result(inventory), PLAIN), /disagrees on version/);
});

test('a single-source plugin is marked, since it is half-evidenced', () => {
  const inventory = emptyInventory({ plugins: [plugin({ sources: ['file'] })] });
  assert.match(renderTree(result(inventory), PLAIN), /file-only/);
});

test('a double declaration shows the masked value', () => {
  const inventory = emptyInventory({
    plugins: [
      plugin({
        version: {
          version: '2.5.0',
          versionSource: 'plugin-json',
          doubleDeclared: { effective: '2.5.0', masked: '2.2.1' },
        },
      }),
    ],
  });

  // The whole point of the diagnostic is that the marketplace entry says
  // something the user never sees.
  assert.match(renderTree(result(inventory), PLAIN), /2\.5\.0 \(masks 2\.2\.1\)/);
});

test('a sha-sourced version is abbreviated and labelled, not shown raw', () => {
  const inventory = emptyInventory({
    plugins: [
      plugin({
        version: { version: 'a'.repeat(40), versionSource: 'marketplace-source-sha' },
      }),
    ],
  });

  const text = renderTree(result(inventory), PLAIN);
  assert.match(text, /aaaaaaaa \(sha\)/);
  assert.ok(!text.includes('a'.repeat(40)), 'a 40-char sha would wreck the column');
});

test('--verbose adds the installed sha and the rule that fired', () => {
  const inventory = emptyInventory({
    plugins: [
      plugin({
        version: { version: '1.0.0', versionSource: 'plugin-json', installedSha: 'b'.repeat(40) },
      }),
    ],
  });

  assert.ok(!/via plugin-json/.test(renderTree(result(inventory), PLAIN)));
  assert.match(renderTree(result(inventory), { color: false, verbose: true }), /via plugin-json/);
});

test('the plugin tree is suppressed when the cli section is degraded', () => {
  const inventory = emptyInventory({ plugins: [plugin({ sources: ['file'] })], degraded: ['cli'] });
  const text = renderTree(result(inventory), PLAIN);
  // Rendering a tree from half the evidence, under a heading that says the
  // section is unavailable, is a contradiction on one screen.
  assert.match(text, /Plugins: unavailable/);
});

// ---------------------------------------------------------------------------
// Shadowing
// ---------------------------------------------------------------------------

test('shadowing shows the winner AND what never loads', () => {
  const inventory = emptyInventory({
    shadowing: [
      {
        kind: 'skill',
        name: 'deploy',
        effective: { name: 'deploy', scope: 'project', kind: 'skill' },
        shadowed: [{ name: 'deploy', scope: 'user', kind: 'skill' }],
      },
    ],
  });

  const text = renderTree(result(inventory), PLAIN);
  assert.match(text, /skill deploy: project wins/);
  assert.match(text, /user never load/);
});

// ---------------------------------------------------------------------------
// Header and provenance
// ---------------------------------------------------------------------------

test('a cached answer says so, with when', () => {
  const text = renderTree(
    result(emptyInventory(), { origin: 'cache', cachedAt: '2026-08-01T10:00:00.000Z' }),
    PLAIN,
  );
  assert.match(text, /cached 2026-08-01T10:00:00\.000Z/);
});

test('a collected answer reports its own elapsed time', () => {
  assert.match(renderTree(result(emptyInventory()), PLAIN), /collected in 12ms/);
});

test('an unhonoured --cached is stated in the header, not buried', () => {
  const text = renderTree(result(emptyInventory(), { cacheMiss: 'stale-inputs' }), PLAIN);
  // A caller who asked for the fast path and silently got the slow one would
  // believe the number it printed met the 200ms budget.
  assert.match(text, /--cached not honoured: stale-inputs/);
});

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

test('colour off emits no escape sequences anywhere', () => {
  const inventory = emptyInventory({
    plugins: [plugin({ enabled: false })],
    degraded: ['mcp'],
    warnings: [{ code: 'partial', message: 'something', collector: 'mcp' }],
    shadowing: [
      {
        kind: 'skill',
        name: 'x',
        effective: { name: 'x', scope: 'project', kind: 'skill' },
        shadowed: [{ name: 'x', scope: 'user', kind: 'skill' }],
      },
    ],
  });

  for (const render of [renderTree, renderFlat]) {
    assert.ok(!render(result(inventory), PLAIN).includes(ESC), `${render.name} leaked an escape`);
  }
});

test('colour on emits escapes, and the plain text still contains the same facts', () => {
  const inventory = emptyInventory({ degraded: ['cli'] });
  const coloured = renderTree(result(inventory), COLOURED);
  const plain = renderTree(result(inventory), PLAIN);

  assert.ok(coloured.includes(ESC));
  // Stripping the escapes must recover exactly the uncoloured rendering —
  // colour is decoration, never a carrier of meaning.
  const stripped = coloured.split(ESC).map((part) => part.replace(/^\[\d+m/, '')).join('');
  assert.equal(stripped, plain);
});

// ---------------------------------------------------------------------------
// Flat
// ---------------------------------------------------------------------------

test('the flat renderer draws no tree characters', () => {
  const inventory = emptyInventory({ plugins: [plugin()] });
  const text = renderFlat(result(inventory), PLAIN);

  assert.ok(!/[├└]─/u.test(text));
  assert.match(text, /^plugin\tp@mkt\tuser\t1\.0\.0\tenabled\tcli\+file$/mu);
});

test('the flat renderer emits every entity kind', () => {
  const entity = (kind, name) => ({
    id: { name, scope: 'user', kind },
    origin: 'personal',
    state: 'enabled',
    source: 'file',
  });

  const inventory = emptyInventory({
    skills: [entity('skill', 's')],
    agents: [entity('agent', 'a')],
    commands: [entity('command', 'c')],
    mcpServers: [{ ...entity('mcp-server', 'm'), transport: 'stdio', connection: 'connected' }],
  });

  const text = renderFlat(result(inventory), PLAIN);
  for (const prefix of ['skill\t', 'agent\t', 'command\t', 'mcp\t']) {
    assert.ok(text.includes(prefix), `flat output omits ${prefix.trim()}`);
  }
});
