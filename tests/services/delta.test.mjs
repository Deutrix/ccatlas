/**
 * T1.26 — the `delta` module.
 *
 * The trap the task row names is declared-vs-active, and it has teeth on the
 * cost side: a `.mcp.json` server at `pending-approval` is configured by the
 * project and contributes **zero** always-on tokens. The natural
 * implementation — sum the scoped inventory, subtract the global — counts it,
 * and tells the user a repo costs context it does not.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { inventoryDelta } from '../../src/services/delta.ts';

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

const entity = (name, scope = 'user', over = {}) => ({
  id: { name, scope, kind: 'skill' },
  origin: 'personal',
  state: 'enabled',
  source: 'file',
  ...over,
});

const server = (name, connection = 'connected', scope = 'project') => ({
  id: { name, scope, kind: 'mcp-server' },
  origin: 'project',
  state: 'enabled',
  source: 'file',
  transport: 'stdio',
  connection,
});

const plugin = (name, over = {}) => ({
  id: { name, scope: 'user', kind: 'plugin' },
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
// Added and removed
// ---------------------------------------------------------------------------

test('an entity only the scope has is added', () => {
  const delta = inventoryDelta(
    inventory({ skills: [entity('global-skill')] }),
    inventory({ skills: [entity('global-skill'), entity('project-skill', 'project')] }),
  );

  assert.equal(delta.added.length, 1);
  assert.equal(delta.added[0].name, 'project-skill');
  assert.equal(delta.added[0].state, 'active');
  assert.deepEqual(delta.removed, []);
});

test('an identical stack produces an empty delta — the negative case', () => {
  const same = () => inventory({ skills: [entity('s')], plugins: [plugin('p@mkt')] });
  const delta = inventoryDelta(same(), same());

  assert.deepEqual(delta.added, []);
  assert.deepEqual(delta.removed, []);
  assert.deepEqual(delta.shadowed, []);
});

test('reversing the arguments turns added into removed', () => {
  const global = inventory();
  const scoped = inventory({ skills: [entity('extra', 'project')] });

  assert.equal(inventoryDelta(global, scoped).added.length, 1);
  assert.equal(inventoryDelta(scoped, global).removed.length, 1);
});

test('comparison is case-insensitive, matching shadow detection', () => {
  const delta = inventoryDelta(
    inventory({ skills: [entity('Deploy')] }),
    inventory({ skills: [entity('deploy', 'project')] }),
  );

  // Windows and macOS collapse these. Reporting the project one as "added"
  // would claim the repo contributes a skill that merely masks an existing one.
  assert.deepEqual(delta.added, []);
});

// ---------------------------------------------------------------------------
// Declared vs active — the stated trap
// ---------------------------------------------------------------------------

test('a PENDING-APPROVAL server is added as DECLARED, not active', () => {
  const delta = inventoryDelta(
    inventory(),
    inventory({ mcpServers: [server('project-db', 'pending-approval')] }),
  );

  assert.equal(delta.added.length, 1);
  assert.equal(delta.added[0].state, 'declared');
  assert.match(delta.added[0].reason, /no always-on tokens/);
});

test('a failed server is declared too — it never started', () => {
  const delta = inventoryDelta(inventory(), inventory({ mcpServers: [server('broken', 'failed')] }));

  assert.equal(delta.added[0].state, 'declared');
  assert.match(delta.added[0].reason, /no tools/);
});

test('a connected server IS active', () => {
  const delta = inventoryDelta(inventory(), inventory({ mcpServers: [server('live', 'connected')] }));
  assert.equal(delta.added[0].state, 'active');
});

test('a disabled plugin is declared, on the same axis as a pending server', () => {
  const delta = inventoryDelta(
    inventory(),
    inventory({ plugins: [plugin('off@mkt', { enabled: false })] }),
  );

  assert.equal(delta.added[0].state, 'declared');
  assert.match(delta.added[0].reason, /enabledPlugins/);
});

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

const withCost = (name, alwaysOn, over = {}) =>
  plugin(name, { cost: { alwaysOn, regime: 'tokenizer' }, ...over });

test('the cost delta counts only ENABLED plugins', () => {
  const delta = inventoryDelta(
    inventory({ plugins: [withCost('a@mkt', 100)] }),
    inventory({ plugins: [withCost('a@mkt', 100), withCost('b@mkt', 250, { enabled: false })] }),
  );

  // A disabled plugin costs nothing. Counting it would report context the
  // project does not actually spend.
  assert.equal(delta.cost.alwaysOnAdded, 0);
});

test('the cost delta is the difference between the two scopes', () => {
  const delta = inventoryDelta(
    inventory({ plugins: [withCost('a@mkt', 100)] }),
    inventory({ plugins: [withCost('a@mkt', 100), withCost('b@mkt', 250)] }),
  );

  assert.equal(delta.cost.alwaysOnAdded, 250);
  assert.equal(delta.cost.measured, 2);
  assert.equal(delta.cost.incomplete, false);
});

test('with NO cost data the figure is absent, not zero', () => {
  const delta = inventoryDelta(inventory({ plugins: [plugin('a@mkt')] }), inventory({ plugins: [plugin('a@mkt')] }));

  // Today's universal case — the `plugin details` parser is T4.7. A zero
  // would read as "this project is free", a stronger claim than "nobody has
  // measured".
  assert.equal(delta.cost.alwaysOnAdded, undefined);
  assert.equal(delta.cost.unmeasured, 1);
  assert.equal(delta.cost.incomplete, true);
});

test('a NON-ADDITIVE cost is excluded from the sum and marks it incomplete', () => {
  const delta = inventoryDelta(
    inventory(),
    inventory({
      plugins: [
        withCost('a@mkt', 100),
        plugin('b@mkt', { cost: { alwaysOn: 900, regime: 'tokenizer', nonAdditive: true } }),
      ],
    }),
  );

  // Above the ~30k-char listing cap per-entity figures rank but do not add.
  // Summing them produces a confident wrong number rather than a missing one.
  assert.equal(delta.cost.measured, 1);
  assert.equal(delta.cost.unmeasured, 1);
  assert.equal(delta.cost.incomplete, true);
});

test('a declared MCP server contributes nothing to the cost side', () => {
  const withPending = inventory({
    plugins: [withCost('a@mkt', 100)],
    mcpServers: [server('pending', 'pending-approval'), server('alsoPending', 'failed')],
  });

  const delta = inventoryDelta(inventory({ plugins: [withCost('a@mkt', 100)] }), withPending);

  // Two servers added, zero tokens added. This is the whole point of T1.26.
  assert.equal(delta.added.filter((a) => a.kind === 'mcp-server').length, 2);
  assert.equal(delta.cost.alwaysOnAdded, 0);
});

// ---------------------------------------------------------------------------
// Shadowing
// ---------------------------------------------------------------------------

test('shadowing comes from the scoped inventory, not re-derived', () => {
  const delta = inventoryDelta(
    inventory(),
    inventory({
      shadowing: [
        {
          kind: 'skill',
          name: 'deploy',
          effective: { name: 'deploy', scope: 'project', kind: 'skill' },
          shadowed: [{ name: 'deploy', scope: 'user', kind: 'skill' }],
        },
      ],
    }),
  );

  // T1.7 already computed it; a second implementation of the precedence rule
  // is a second thing to keep in step.
  assert.equal(delta.shadowed.length, 1);
  assert.equal(delta.shadowed[0].winningScope, 'project');
  assert.deepEqual(delta.shadowed[0].losingScopes, ['user']);
});

test('a shadowed entity is NOT also reported as added', () => {
  const delta = inventoryDelta(
    inventory({ skills: [entity('deploy')] }),
    inventory({
      skills: [entity('deploy', 'project'), entity('deploy', 'user', { state: 'shadowed' })],
      shadowing: [
        {
          kind: 'skill',
          name: 'deploy',
          effective: { name: 'deploy', scope: 'project', kind: 'skill' },
          shadowed: [{ name: 'deploy', scope: 'user', kind: 'skill' }],
        },
      ],
    }),
  );

  // It never loads, so counting it as part of the effective stack would
  // overstate what the scope contributes.
  assert.deepEqual(delta.added, []);
  assert.equal(delta.shadowed.length, 1);
});

test('delta is pure — the same inputs give the same answer twice', () => {
  const a = inventory({ skills: [entity('s')] });
  const b = inventory({ skills: [entity('s'), entity('t', 'project')] });

  assert.deepEqual(inventoryDelta(a, b), inventoryDelta(a, b));
});
