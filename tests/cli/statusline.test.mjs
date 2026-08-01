/**
 * T7.12 — the statusline segment.
 *
 * It renders on every prompt, so the tests are mostly about what it does NOT
 * do: never collect, never block, and never spend a prompt's width on
 * something the user cannot act on.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { renderStatusline, STATUSLINE_BUDGET_MS } from '../../src/cli/statusline.ts';

test('nothing actionable renders NOTHING', () => {
  // A count of installed plugins is the same on every prompt of every session.
  // Showing it would be noise that trains the user to stop reading.
  assert.equal(renderStatusline({}), '');
  assert.equal(renderStatusline({ stalePins: 0, critical: 0 }), '');
});

test('stale pins are surfaced — they are the actionable finding', () => {
  assert.match(renderStatusline({ stalePins: 2 }), /2 stale/);
});

test('critical findings lead', () => {
  const line = renderStatusline({ critical: 1, stalePins: 3 });
  assert.ok(line.indexOf('⛔') < line.indexOf('stale'));
});

test('a degraded collector is named', () => {
  assert.match(renderStatusline({ inventory: { degraded: ['cli'] } }), /cli/);
});

test('the segment is short enough for a prompt', () => {
  const line = renderStatusline({ critical: 2, stalePins: 5, inventory: { degraded: ['cli', 'mcp'] } });
  assert.ok(line.length < 60, `statusline is ${line.length} chars`);
});

test('the budget is stated rather than left as folklore', () => {
  assert.ok(STATUSLINE_BUDGET_MS <= 50);
});

test('rendering is pure and instant — it cannot block a prompt', () => {
  const started = performance.now();
  for (let i = 0; i < 10_000; i += 1) renderStatusline({ stalePins: i % 3 });
  // 10k renders inside the budget for ONE. Anything doing IO fails this.
  assert.ok(performance.now() - started < STATUSLINE_BUDGET_MS);
});
