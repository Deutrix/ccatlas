/**
 * T2.9 / T2.10 — the apply plan and the `--check` exit codes.
 *
 * The ordering assertion is the load-bearing one: a plugin update pulls from
 * the marketplace clone, so updating plugins before refreshing the clone
 * reinstalls the same stale `source.sha` and reports success — the exact
 * pathology T2.4 exists to detect, reproduced by the tool meant to fix it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyPlan,
  CHECK_CLEAN,
  CHECK_FINDINGS,
  checkExitCode,
  planUpdates,
  RELOAD_REMINDER,
} from '../../src/services/apply.ts';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const record = (id, over = {}) => ({
  id,
  installedVersion: '1.0.0',
  delta: 'unknown',
  direction: 'unknown',
  ...over,
});

const report = (over = {}) => ({
  updates: [],
  stalePins: [],
  upgrades: [],
  entriesBehind: [],
  marketplaces: [],
  warnings: [],
  ...over,
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test('marketplaces are refreshed BEFORE any plugin is updated', () => {
  const plan = planUpdates(
    report({
      marketplaces: [{ name: 'mkt', ageDays: 200, autoRefreshed: false }],
      stalePins: [record('p@mkt', { stalePin: { installedSha: SHA_A, entrySha: SHA_B } })],
    }),
    30,
  );

  assert.equal(plan.actions.length, 2);
  assert.equal(plan.actions[0].kind, 'marketplace-update');
  assert.equal(plan.actions[1].kind, 'plugin-update');
});

test('every command is spelled out in full — no collapsing', () => {
  const plan = planUpdates(
    report({ stalePins: [record('p@mkt', { stalePin: { installedSha: SHA_A, entrySha: SHA_B } })] }),
    30,
  );

  // F5's rule: a plan discloses every executable surface. A user who cannot
  // read what is about to run cannot refuse it.
  assert.deepEqual(plan.actions[0].argv, ['plugin', 'update', 'p@mkt']);
  assert.match(plan.actions[0].reason, /a72|pinned at a{8}/);
});

test('an auto-refreshed marketplace is never scheduled', () => {
  const plan = planUpdates(
    report({ marketplaces: [{ name: 'claude-plugins-official', ageDays: 900, autoRefreshed: true }] }),
    30,
  );

  // It refreshes at session start; scheduling it would be busywork the user
  // is asked to approve.
  assert.deepEqual(plan.actions, []);
});

test('a fresh marketplace is not scheduled — the negative case', () => {
  const plan = planUpdates(
    report({ marketplaces: [{ name: 'mkt', ageDays: 3, autoRefreshed: false }] }),
    30,
  );

  assert.deepEqual(plan.actions, []);
});

test('a marketplace with no measurable age is not scheduled', () => {
  const plan = planUpdates(report({ marketplaces: [{ name: 'mkt', autoRefreshed: false }] }), 30);
  assert.deepEqual(plan.actions, []);
});

test('a plugin appearing as both stale-pinned and an upgrade is scheduled once', () => {
  const one = record('p@mkt', {
    stalePin: { installedSha: SHA_A, entrySha: SHA_B },
    direction: 'upgrade',
    availableVersion: '2.0.0',
  });

  const plan = planUpdates(report({ stalePins: [one], upgrades: [one] }), 30);
  assert.equal(plan.actions.filter((a) => a.kind === 'plugin-update').length, 1);
});

// ---------------------------------------------------------------------------
// What no command fixes
// ---------------------------------------------------------------------------

test('a double declaration is MANUAL — no command fixes it', () => {
  const plan = planUpdates(
    report({ updates: [record('p@mkt', { doubleDeclared: { effective: '2.5.0', masked: '2.2.1' } })] }),
    30,
  );

  // Only the upstream author can reconcile them. Offering a command would be
  // offering a placebo.
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.manual.length, 1);
  assert.match(plan.manual[0].reason, /only the upstream author/);
});

test('an entry BEHIND the install is manual, never an action', () => {
  const plan = planUpdates(
    report({ entriesBehind: [record('p@mkt', { installedVersion: '2.5.0', availableVersion: '2.2.1' })] }),
    30,
  );

  // Updating would move the user backwards.
  assert.deepEqual(plan.actions, []);
  assert.match(plan.manual[0].reason, /backwards/);
});

test('manual items are reported, not omitted', () => {
  const plan = planUpdates(report({}), 30);
  assert.deepEqual(plan.actions, []);
  assert.deepEqual(plan.manual, []);
});

// ---------------------------------------------------------------------------
// T2.10 — exit codes
// ---------------------------------------------------------------------------

test('--check exits nonzero when there is something to act on', () => {
  assert.equal(checkExitCode(report({ stalePins: [record('p@m')] })), CHECK_FINDINGS);
  assert.equal(checkExitCode(report({ upgrades: [record('p@m')] })), CHECK_FINDINGS);
});

test('--check exits zero on a clean machine', () => {
  assert.equal(checkExitCode(report({})), CHECK_CLEAN);
});

test('an entry-behind alone does NOT trip --check', () => {
  // There is nothing to run. A cron job that fires on it would page someone
  // about an upstream authoring lapse they cannot fix.
  assert.equal(checkExitCode(report({ entriesBehind: [record('p@m')] })), CHECK_CLEAN);
});

test('a double declaration alone does not trip --check either', () => {
  assert.equal(
    checkExitCode(report({ updates: [record('p@m', { doubleDeclared: { effective: 'a', masked: 'b' } })] })),
    CHECK_CLEAN,
  );
});

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

test('actions run in plan order', async () => {
  const ran = [];
  const plan = planUpdates(
    report({
      marketplaces: [{ name: 'mkt', ageDays: 200, autoRefreshed: false }],
      stalePins: [record('p@mkt', { stalePin: { installedSha: SHA_A, entrySha: SHA_B } })],
    }),
    30,
  );

  const { ok } = await applyPlan(plan, {
    run: async (argv) => {
      ran.push(argv.join(' '));
      return { code: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(ok, true);
  assert.deepEqual(ran, ['plugin marketplace update mkt', 'plugin update p@mkt']);
});

test('execution STOPS at the first failure', async () => {
  const ran = [];
  const plan = planUpdates(
    report({
      marketplaces: [{ name: 'mkt', ageDays: 200, autoRefreshed: false }],
      stalePins: [record('p@mkt', { stalePin: { installedSha: SHA_A, entrySha: SHA_B } })],
    }),
    30,
  );

  const { executed, ok } = await applyPlan(plan, {
    run: async (argv) => {
      ran.push(argv.join(' '));
      return { code: 1, stdout: '', stderr: 'boom' };
    },
  });

  // Continuing past a failed marketplace refresh would install plugins from a
  // clone known to be in an unexpected state.
  assert.equal(ok, false);
  assert.equal(ran.length, 1);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].code, 1);
  assert.equal(executed[0].output, 'boom');
});

test('an empty plan runs nothing and succeeds', async () => {
  const { executed, ok } = await applyPlan(
    { actions: [], manual: [] },
    { run: async () => { throw new Error('should not run'); } },
  );

  assert.deepEqual(executed, []);
  assert.equal(ok, true);
});

test('ccatlas never mutates directly — every action is a claude invocation', () => {
  const plan = planUpdates(
    report({
      marketplaces: [{ name: 'mkt', ageDays: 200, autoRefreshed: false }],
      upgrades: [record('p@mkt', { direction: 'upgrade', availableVersion: '2.0.0' })],
    }),
    30,
  );

  // An architecture invariant: ccatlas never writes into ~/.claude/plugins/.
  for (const action of plan.actions) {
    assert.equal(action.argv[0], 'plugin', `${action.subject} is not a claude plugin command`);
  }
});

test('the reload reminder explains why an updated plugin looks unchanged', () => {
  // Claude Code loads plugins at session start, so a user who checks
  // immediately sees the old behaviour and concludes the update failed.
  assert.match(RELOAD_REMINDER, /reload-plugins/);
  assert.match(RELOAD_REMINDER, /still holds the previous copies/);
});
