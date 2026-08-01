/**
 * T6.1–T6.14 — git sync.
 *
 * The ⛔ test is T6.8: **never write conflict markers into JSON.** Git's
 * default merge puts `<<<<<<<` in the file, and for `settings.json` or
 * `installed_plugins.json` that produces something Claude Code parses at
 * startup and fails on — turning a routine merge conflict into a broken
 * install whose first symptom is Claude Code not starting.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyOverlay,
  authRemedies,
  classifyEntity,
  GITHUB_TOKEN_NOTE,
  mergeJson,
  publicRemoteWarning,
  pushGuard,
  threeWayStatus,
} from '../../src/services/sync.ts';

// ---------------------------------------------------------------------------
// T6.3 — three-way status, per entity
// ---------------------------------------------------------------------------

test('all three sides agreeing is in-sync', () => {
  assert.equal(classifyEntity({ key: 'p', machine: 'a', local: 'a', remote: 'a' }), 'in-sync');
});

test('one side moving is attributed to that side', () => {
  assert.equal(classifyEntity({ key: 'p', machine: 'b', local: 'a', remote: 'a' }), 'machine-ahead');
  assert.equal(classifyEntity({ key: 'p', machine: 'a', local: 'a', remote: 'b' }), 'remote-ahead');
});

test('BOTH sides moving differently is diverged — reported, not resolved', () => {
  // Neither can be taken without losing the other.
  assert.equal(classifyEntity({ key: 'p', machine: 'b', local: 'a', remote: 'c' }), 'diverged');
});

test('both sides moving to the SAME value is in-sync, not a conflict', () => {
  assert.equal(classifyEntity({ key: 'p', machine: 'b', local: 'a', remote: 'b' }), 'in-sync');
});

test('presence on one side only is named', () => {
  assert.equal(classifyEntity({ key: 'p', machine: 'a' }), 'machine-only');
  assert.equal(classifyEntity({ key: 'p', local: 'a' }), 'local-only');
  assert.equal(classifyEntity({ key: 'p', remote: 'a' }), 'remote-only');
});

test('status reports per ENTITY, and hides what is already in sync', () => {
  const diffs = threeWayStatus([
    { key: 'plugin-a', machine: '1', local: '1', remote: '1' },
    { key: 'plugin-b', machine: '2', local: '1', remote: '1' },
    { key: 'plugin-c', machine: '1', local: '1', remote: '3' },
  ]);

  // A file-level diff would say "plugins.json changed" and stop being useful.
  assert.deepEqual(diffs.map((d) => d.key), ['plugin-b', 'plugin-c']);
  assert.equal(diffs[0].status, 'machine-ahead');
});

// ---------------------------------------------------------------------------
// ⛔ T6.8 — no conflict markers in JSON
// ---------------------------------------------------------------------------

test('⛔ a conflicted merge still produces VALID JSON', () => {
  const { merged, conflicts } = mergeJson(
    { model: 'opus' },
    { model: 'sonnet' },
    { model: 'haiku' },
  );

  assert.equal(conflicts.length, 1);

  // The whole point: Claude Code parses settings.json at startup. Markers here
  // would make a routine conflict present as Claude Code failing to start.
  const serialised = JSON.stringify(merged);
  assert.ok(!serialised.includes('<<<<'), 'conflict markers reached the JSON');
  assert.doesNotThrow(() => JSON.parse(serialised));
});

test('a one-sided change is taken with no conflict', () => {
  const ours = mergeJson({ a: 1 }, { a: 2 }, { a: 1 });
  assert.deepEqual(ours.merged, { a: 2 });
  assert.deepEqual(ours.conflicts, []);

  const theirs = mergeJson({ a: 1 }, { a: 1 }, { a: 2 });
  assert.deepEqual(theirs.merged, { a: 2 });
});

test('identical changes on both sides are not a conflict', () => {
  const { merged, conflicts } = mergeJson({ a: 1 }, { a: 2 }, { a: 2 });
  assert.deepEqual(merged, { a: 2 });
  assert.deepEqual(conflicts, []);
});

test('additions from both sides both land', () => {
  const { merged, conflicts } = mergeJson({}, { a: 1 }, { b: 2 });
  assert.deepEqual(merged, { a: 1, b: 2 });
  assert.deepEqual(conflicts, []);
});

test('a one-sided deletion is honoured', () => {
  const { merged } = mergeJson({ a: 1, b: 2 }, { b: 2 }, { a: 1, b: 2 });
  assert.deepEqual(merged, { b: 2 });
});

test('a conflicted entry keeps the BASE value so the file stays usable', () => {
  const { merged, conflicts } = mergeJson({ a: 'base' }, { a: 'ours' }, { a: 'theirs' });

  assert.equal(merged.a, 'base');
  assert.deepEqual(conflicts[0], { key: 'a', ours: 'ours', theirs: 'theirs' });
});

test('nested objects compare by value, not by reference', () => {
  const { conflicts } = mergeJson(
    { permissions: { allow: ['a'] } },
    { permissions: { allow: ['a'] } },
    { permissions: { allow: ['a'] } },
  );
  assert.deepEqual(conflicts, []);
});

// ---------------------------------------------------------------------------
// T6.9 — machine overlays win
// ---------------------------------------------------------------------------

test('the machine overlay applies LAST and overrides the merge', () => {
  const merged = applyOverlay(
    { model: 'opus', env: { ANTHROPIC_BASE_URL: 'https://desktop.internal' } },
    { env: { ANTHROPIC_BASE_URL: 'https://laptop.internal' } },
  );

  // A pull that overwrote a laptop's endpoint with a desktop's would break the
  // laptop in a way that looks like the sync working.
  assert.deepEqual(merged.env, { ANTHROPIC_BASE_URL: 'https://laptop.internal' });
  assert.equal(merged.model, 'opus');
});

test('an empty overlay changes nothing', () => {
  assert.deepEqual(applyOverlay({ a: 1 }, {}), { a: 1 });
});

// ---------------------------------------------------------------------------
// 🔒 T6.10 — the push guard
// ---------------------------------------------------------------------------

test('🔒 a credential blocks the push, loudly', () => {
  const guard = pushGuard([{ location: 'mcpServers.gh.env.TOKEN', evidence: 'starts with "ghp_"' }]);

  // A push is irreversible in practice — the object reaches the remote and
  // every clone of it.
  assert.equal(guard.safe, false);
  assert.match(guard.reason, /irreversible in practice/);
  assert.equal(guard.locations.length, 1);
});

test('a clean bundle pushes — the negative case', () => {
  assert.deepEqual(pushGuard([]), { safe: true, locations: [] });
});

// ---------------------------------------------------------------------------
// 🔒 T6.11–T6.14 — remote posture and auth
// ---------------------------------------------------------------------------

test('🔒 a public host warns about what a stack bundle discloses', () => {
  const warning = publicRemoteWarning('https://github.com/me/my-stack.git');

  // It names every plugin, marketplace and MCP server you run — useful to an
  // attacker choosing what to target.
  assert.ok(warning);
  assert.match(warning, /what to target/);
});

test('a private host raises nothing', () => {
  assert.equal(publicRemoteWarning('git@git.internal.corp:me/stack.git'), undefined);
});

test('auth remedies are ordered safest-first, with SSH leading', () => {
  const remedies = authRemedies();

  assert.deepEqual(remedies.map((r) => r.order), [1, 2, 3, 4]);
  assert.match(remedies[0].title, /SSH/);
  assert.match(remedies[1].command, /KEEP_MARKETPLACE_ON_FAILURE/);
});

test('🔒 T6.13 — the URL rewrite remedy warns against HOST scope', () => {
  const rewrite = authRemedies().at(-1);

  // A host-scoped rewrite overrides credentials for every fetch and push to
  // that host, including unrelated repositories, and writes a plaintext token
  // into gitconfig.
  assert.match(rewrite.title, /PATH-SCOPED/);
  assert.match(rewrite.detail, /HOST-scoped rewrite overrides credentials/);
  assert.match(rewrite.detail, /plaintext token/);
});

test('the credential-helper remedy admits it does not fix the refresh', () => {
  // Claude Code's background refresh DISABLES helpers, so recommending one
  // alone would look like a fix and not be.
  const helper = authRemedies().find((r) => r.command === 'gh auth setup-git');
  assert.match(helper.detail, /does NOT help the background refresh/);
});

test('T6.14 — a bare GITHUB_TOKEN is explicitly called out as useless', () => {
  assert.match(GITHUB_TOKEN_NOTE, /git does not read it/);
});
