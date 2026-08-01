/**
 * T2.1–T2.6 — updates and version health.
 *
 * The stale-pin case is the product's differentiator, and it is offline: the
 * marketplace clone carries the `source.sha` the next install would fetch, and
 * `installed_plugins.json` carries the `gitCommitSha` that actually landed.
 * Two recorded facts, no network, no inference.
 *
 * Two defects here were found by running the binary rather than by any test —
 * the version direction and T2.5's dead input — so both have explicit cases
 * below.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildUpdatesReport,
  marketplaceStaleness,
  resolveUpdates,
  semverDelta,
  updateDirection,
} from '../../src/services/updates.ts';

const plugin = (id, over = {}) => ({
  id: { name: id, scope: 'user', kind: 'plugin' },
  origin: 'marketplace',
  state: 'enabled',
  source: 'cli',
  sources: ['cli', 'file'],
  marketplace: id.split('@')[1] ?? '',
  enabled: true,
  version: { version: '1.0.0', versionSource: 'plugin-json', ...(over.version ?? {}) },
  contributes: { skills: 0, agents: 0, hooks: 0, mcpServers: 0, lspServers: 0 },
});

const entry = (name, marketplace, over = {}) => ({ name, marketplace, ...over });

const inventory = (plugins) => ({
  plugins,
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
});

// ---------------------------------------------------------------------------
// T2.3 — semver delta
// ---------------------------------------------------------------------------

test('semver deltas classify by the most significant difference', () => {
  assert.equal(semverDelta('1.0.0', '2.0.0'), 'major');
  assert.equal(semverDelta('1.0.0', '1.1.0'), 'minor');
  assert.equal(semverDelta('1.0.0', '1.0.1'), 'patch');
  assert.equal(semverDelta('1.0.0', '1.0.0'), 'same');
});

test('a non-semver version is unknown, never a reassuring patch', () => {
  // "unknown" is a REAL observed version — a relative path inside a non-git
  // clone yields it. Returning `patch` would invent a reassurance.
  assert.equal(semverDelta('unknown', '1.0.0'), 'unknown');
  assert.equal(semverDelta('1.0.0', 'unknown'), 'unknown');
  assert.equal(semverDelta('2026.01', '2026.02'), 'unknown');
});

test('a leading v is tolerated', () => {
  assert.equal(semverDelta('v1.0.0', 'v1.0.1'), 'patch');
});

// ---------------------------------------------------------------------------
// Direction — found by the live run, not by a test
// ---------------------------------------------------------------------------

test('direction distinguishes an upgrade from an entry that is BEHIND', () => {
  assert.equal(updateDirection('1.0.0', '2.0.0'), 'upgrade');

  // The real case: ui-ux-pro-max installed at 2.5.0, entry declaring 2.2.1.
  // Rendering that as "2.5.0 → 2.2.1" under "available updates" tells the user
  // to move to an older version, which is worse than saying nothing.
  assert.equal(updateDirection('2.5.0', '2.2.1'), 'entry-behind');
  assert.equal(updateDirection('1.0.0', '1.0.0'), 'same');
  assert.equal(updateDirection('unknown', '1.0.0'), 'unknown');
});

test('direction compares part by part, not lexically', () => {
  // "10" < "9" as strings. A lexical compare calls this an entry-behind.
  assert.equal(updateDirection('1.9.0', '1.10.0'), 'upgrade');
  assert.equal(updateDirection('1.10.0', '1.9.0'), 'entry-behind');
});

test('an entry BEHIND the install never reaches the upgrades list', () => {
  const report = buildUpdatesReport({
    inventory: inventory([plugin('p@m', { version: { version: '2.5.0' } })]),
    entries: [entry('p', 'm', { version: '2.2.1' })],
    marketplaces: [],
    now: Date.now(),
  });

  assert.deepEqual(report.upgrades, []);
  assert.equal(report.entriesBehind.length, 1);
});

test('a genuine upgrade reaches the upgrades list', () => {
  const report = buildUpdatesReport({
    inventory: inventory([plugin('p@m', { version: { version: '1.0.0' } })]),
    entries: [entry('p', 'm', { version: '2.0.0' })],
    marketplaces: [],
    now: Date.now(),
  });

  assert.equal(report.upgrades.length, 1);
  assert.equal(report.upgrades[0].delta, 'major');
  assert.deepEqual(report.entriesBehind, []);
});

// ---------------------------------------------------------------------------
// T2.4 — the stale pin, the differentiator
// ---------------------------------------------------------------------------

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

test('a moved source with an unmoved version string is a STALE PIN', () => {
  const { records, warnings } = resolveUpdates(
    [plugin('superpowers@official', { version: { version: '6.2.0', installedSha: SHA_A } })],
    [entry('superpowers', 'official', { sourceSha: SHA_B })],
  );

  // The real pathology: `/plugin update` reports "already at the latest
  // version" while the user runs old code.
  assert.deepEqual(records[0].stalePin, { installedSha: SHA_A, entrySha: SHA_B });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /no update available/);
});

test('a matching sha is NOT a stale pin — the negative case', () => {
  const { records, warnings } = resolveUpdates(
    [plugin('p@m', { version: { version: '1.0.0', installedSha: SHA_A } })],
    [entry('p', 'm', { sourceSha: SHA_A })],
  );

  assert.equal(records[0].stalePin, undefined);
  assert.deepEqual(warnings, []);
});

test('an ABSENT installedSha is not a stale pin — nothing to compare', () => {
  // frontend-design has no gitCommitSha at all. Treating absence as a
  // mismatch would flag it on every run with nothing to act on.
  const { records } = resolveUpdates(
    [plugin('p@m', { version: { version: 'unknown' } })],
    [entry('p', 'm', { sourceSha: SHA_A })],
  );

  assert.equal(records[0].stalePin, undefined);
});

test('an entry with no sourceSha is not a stale pin', () => {
  const { records } = resolveUpdates(
    [plugin('p@m', { version: { version: '1.0.0', installedSha: SHA_A } })],
    [entry('p', 'm', { version: '1.0.0' })],
  );

  assert.equal(records[0].stalePin, undefined);
});

test('stale pins are surfaced as their own list', () => {
  const report = buildUpdatesReport({
    inventory: inventory([
      plugin('a@m', { version: { version: '1.0.0', installedSha: SHA_A } }),
      plugin('b@m', { version: { version: '1.0.0', installedSha: SHA_A } }),
    ]),
    entries: [entry('a', 'm', { sourceSha: SHA_B }), entry('b', 'm', { sourceSha: SHA_A })],
    marketplaces: [],
    now: Date.now(),
  });

  // It is the finding no other tool shows, and a plugin whose version has not
  // moved sorts to the bottom of any version-ordered list.
  assert.equal(report.stalePins.length, 1);
  assert.equal(report.stalePins[0].id, 'a@m');
});

// ---------------------------------------------------------------------------
// T2.5 — double declaration, whose input was dead
// ---------------------------------------------------------------------------

test('a double declaration is detected from the ENTRY, not from --available', () => {
  // The merge populates doubleDeclared from `cli.available`, and T0.1 proved
  // --available excludes every installed plugin — so for an installed plugin
  // that field was never set and the detection was dead code.
  const { records } = resolveUpdates(
    [plugin('ui-ux-pro-max@skill', { version: { version: '2.5.0' } })],
    [entry('ui-ux-pro-max', 'skill', { version: '2.2.1' })],
  );

  assert.deepEqual(records[0].doubleDeclared, { effective: '2.5.0', masked: '2.2.1' });
});

test('AGREEING declarations are not flagged — the false-positive guard', () => {
  // everything-claude-code declares 1.9.0 in both. Flagging it would trip
  // every well-maintained plugin and train the user to ignore the diagnostic.
  const { records } = resolveUpdates(
    [plugin('ecc@m', { version: { version: '1.9.0' } })],
    [entry('ecc', 'm', { version: '1.9.0' })],
  );

  assert.equal(records[0].doubleDeclared, undefined);
});

test('an entry declaring no version cannot be a double declaration', () => {
  // 221 of 276 official entries declare none.
  const { records } = resolveUpdates(
    [plugin('p@m', { version: { version: '1.0.0' } })],
    [entry('p', 'm', { sourceSha: SHA_A })],
  );

  assert.equal(records[0].doubleDeclared, undefined);
  assert.equal(records[0].delta, 'unknown', 'no version to compare is not "same"');
});

// ---------------------------------------------------------------------------
// T2.1 — no entry is not "up to date"
// ---------------------------------------------------------------------------

test('a plugin with no marketplace entry is UNRESOLVED, not up to date', () => {
  const { records } = resolveUpdates([plugin('side@inline')], []);

  // Ordinary for a --plugin-dir sideload and for an unreadable clone. Saying
  // "up to date" would answer a question that was never asked.
  assert.equal(records[0].unresolved, 'no marketplace entry matched this plugin');
  assert.equal(records[0].delta, 'unknown');
});

test('entries for other marketplaces do not match by bare name', () => {
  const { records } = resolveUpdates(
    [plugin('p@mine')],
    [entry('p', 'theirs', { version: '9.9.9' })],
  );

  // `<plugin>@<marketplace>` is the identity. A same-named plugin in another
  // marketplace is a different plugin.
  assert.ok(records[0].unresolved);
});

// ---------------------------------------------------------------------------
// T2.6 — marketplace staleness
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

test('staleness is measured in whole days from lastUpdated', () => {
  const now = Date.parse('2026-08-01T00:00:00.000Z');
  const [market] = marketplaceStaleness(
    [{ name: 'third-party', distribution: 'git', lastUpdated: '2026-03-30T00:00:00.000Z' }],
    now,
  );

  assert.equal(market.ageDays, Math.floor((now - Date.parse('2026-03-30T00:00:00.000Z')) / DAY));
  assert.equal(market.autoRefreshed, false);
});

test('the auto-installed official marketplace is marked, not judged', () => {
  const [market] = marketplaceStaleness(
    [{ name: 'claude-plugins-official', distribution: 'gcs', lastUpdated: '2020-01-01T00:00:00.000Z' }],
    Date.now(),
  );

  // It refreshes at session start, so its age says nothing about user action.
  // Marked rather than filtered here so the caller decides.
  assert.equal(market.autoRefreshed, true);
});

test('a missing or unparseable lastUpdated yields no age rather than a wrong one', () => {
  const [absent] = marketplaceStaleness([{ name: 'a', distribution: 'git' }], Date.now());
  assert.equal(absent.ageDays, undefined);

  const [bad] = marketplaceStaleness(
    [{ name: 'b', distribution: 'git', lastUpdated: 'not a date' }],
    Date.now(),
  );
  assert.equal(bad.ageDays, undefined);
  assert.equal(bad.lastUpdated, 'not a date');
});

test('no auto-update field is invented — no such flag exists', () => {
  const [market] = marketplaceStaleness([{ name: 'a', distribution: 'git' }], Date.now());

  // §3.2.1 verified absent in known_marketplaces.json, in `marketplace list
  // --json`, and in `marketplace add --help`. The naming trap is
  // `autoUpdatesChannel`/`autoUpdates`, which govern the CLI self-updater.
  assert.ok(!('autoUpdate' in market));
});

test('a future lastUpdated clamps to zero rather than going negative', () => {
  const [market] = marketplaceStaleness(
    [{ name: 'a', distribution: 'git', lastUpdated: new Date(Date.now() + 5 * DAY).toISOString() }],
    Date.now(),
  );

  assert.equal(market.ageDays, 0);
});

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

test('an empty machine produces an empty report, not an error', () => {
  const report = buildUpdatesReport({
    inventory: inventory([]),
    entries: [],
    marketplaces: [],
    now: Date.now(),
  });

  assert.deepEqual(report.updates, []);
  assert.deepEqual(report.stalePins, []);
  assert.deepEqual(report.upgrades, []);
  assert.deepEqual(report.warnings, []);
});

test('every installed plugin gets exactly one record', () => {
  const report = buildUpdatesReport({
    inventory: inventory([plugin('a@m'), plugin('b@m'), plugin('c@m')]),
    entries: [entry('a', 'm', { version: '1.0.0' })],
    marketplaces: [],
    now: Date.now(),
  });

  assert.equal(report.updates.length, 3);
  assert.equal(report.updates.filter((r) => r.unresolved !== undefined).length, 2);
});
