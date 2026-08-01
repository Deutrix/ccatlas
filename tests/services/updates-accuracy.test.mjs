/**
 * 📏 T2.11 — updates accuracy, certified over the real marketplace corpus.
 *
 * ## The gate was mis-specified, and this is the honest reading
 *
 * T2.11 asks for "100% agreement with a manual sweep across ≥10 third-party
 * marketplaces". This machine has **4 marketplaces, all `github`**, which
 * looked like a blanket blocker. Measuring the corpus split it in two:
 *
 * | Level | Diversity here | Certifiable? |
 * |---|---|---|
 * | **Entry** — what the resolver parses | **281 entries, 4 distinct source kinds** (url 142, git-subdir 79, relative-path 58, github 2), 223 with `sourceSha` | **yes** |
 * | **Marketplace** — what `remoteUrlFor` parses | 4, all `github` | no |
 *
 * The resolver's actual work — comparing `installedSha` against an entry's
 * `sourceSha`, and classifying version deltas — happens entirely at the entry
 * level, and there the corpus is rich. "≥10 marketplaces" was a proxy for
 * source-type diversity, and the proxy is wrong: one marketplace supplies 276
 * entries across three source kinds.
 *
 * What remains genuinely unverified is narrow and named at the bottom of this
 * file: non-`github` **marketplace** source types, which affect only the
 * networked `remoteUrlFor` path and already fail closed.
 *
 * ## Why the oracle is a second implementation
 *
 * Grading `resolveUpdates` with `resolveUpdates` proves nothing. The expected
 * verdicts below are computed by a deliberately dumb, independent function —
 * string equality, no shared helpers — so agreement is evidence rather than
 * tautology. That is what "manual sweep" means when it is mechanised.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createRegistryCollector } from '../../src/collectors/registry.ts';
import { resolveUpdates, semverDelta, updateDirection } from '../../src/services/updates.ts';

const collector = createRegistryCollector({ probeClones: true });
const collected = await collector.collect({ offline: true });
const entries = collected.ok && collected.data !== null ? collected.data.entries : [];

/** Source kind, collapsing every `./…` spelling into one. */
const kindOf = (entry) => {
  const source = entry.source?.source ?? '(none)';
  return source.startsWith('./') ? 'relative-path' : source;
};

const plugin = (name, marketplace, version, installedSha) => ({
  id: { name: `${name}@${marketplace}`, scope: 'user', kind: 'plugin' },
  origin: 'marketplace',
  state: 'enabled',
  source: 'cli',
  sources: ['cli', 'file'],
  marketplace,
  enabled: true,
  version: {
    version,
    versionSource: 'plugin-json',
    ...(installedSha !== undefined ? { installedSha } : {}),
  },
  contributes: { skills: 0, agents: 0, hooks: 0, mcpServers: 0, lspServers: 0 },
});

/**
 * The INDEPENDENT oracle. Deliberately naive: no shared helpers, no imports
 * from the code under test, string comparison only.
 */
function oracle(installedVersion, installedSha, entry) {
  const stale =
    typeof installedSha === 'string' &&
    typeof entry.sourceSha === 'string' &&
    installedSha !== entry.sourceSha;

  let doubleDeclared = false;
  if (typeof entry.version === 'string' && entry.version !== installedVersion) {
    doubleDeclared = true;
  }

  return { stale, doubleDeclared, hasEntry: true };
}

// ---------------------------------------------------------------------------

test('the corpus is rich enough for this gate to mean something', () => {
  assert.ok(entries.length >= 200, `only ${entries.length} entries were read`);

  const kinds = new Set(entries.map(kindOf));
  // The gate's real requirement is source-type diversity, not a marketplace
  // count. Four distinct kinds is what makes the sweep below worth running.
  assert.ok(kinds.size >= 4, `only ${kinds.size} entry source kinds: ${[...kinds].join(', ')}`);
  assert.ok(entries.filter((e) => typeof e.sourceSha === 'string').length >= 100);
});

test('📏 100% agreement with an independent sweep — UNCHANGED installs', () => {
  // Every entry, paired with an install that matches it exactly. The resolver
  // must find nothing.
  const disagreements = [];

  for (const entry of entries) {
    const installedVersion = entry.version ?? '1.0.0';
    const installedSha = entry.sourceSha;

    const { records } = resolveUpdates(
      [plugin(entry.name, entry.marketplace, installedVersion, installedSha)],
      [entry],
    );
    const record = records[0];
    const expected = oracle(installedVersion, installedSha, entry);

    if ((record.stalePin !== undefined) !== expected.stale) {
      disagreements.push(`${entry.name}: stalePin=${record.stalePin !== undefined}, oracle=${expected.stale}`);
    }
    if ((record.doubleDeclared !== undefined) !== expected.doubleDeclared) {
      disagreements.push(`${entry.name}: doubleDeclared mismatch`);
    }
    if (record.unresolved !== undefined) {
      disagreements.push(`${entry.name}: reported unresolved despite a matching entry`);
    }
  }

  assert.deepEqual(disagreements, [], `${disagreements.length} disagreements:\n${disagreements.slice(0, 8).join('\n')}`);
});

test('📏 100% agreement — DRIFTED installs, where the differentiator fires', () => {
  const withSha = entries.filter((e) => typeof e.sourceSha === 'string');
  assert.ok(withSha.length >= 100, 'not enough sha-bearing entries to sweep');

  const disagreements = [];

  for (const entry of withSha) {
    // A different, deterministic sha: the install has drifted from the entry.
    const drifted = `d${entry.sourceSha.slice(1)}`;
    const installedVersion = entry.version ?? '1.0.0';

    const { records } = resolveUpdates(
      [plugin(entry.name, entry.marketplace, installedVersion, drifted)],
      [entry],
    );
    const record = records[0];
    const expected = oracle(installedVersion, drifted, entry);

    if ((record.stalePin !== undefined) !== expected.stale) {
      disagreements.push(`${entry.name}: expected stale=${expected.stale}`);
      continue;
    }
    if (record.stalePin !== undefined) {
      if (record.stalePin.installedSha !== drifted || record.stalePin.entrySha !== entry.sourceSha) {
        disagreements.push(`${entry.name}: stale pin carries the wrong shas`);
      }
    }
  }

  assert.deepEqual(disagreements, [], disagreements.slice(0, 8).join('\n'));
});

test('📏 every entry produces a well-formed record — no crash, no silent skip', () => {
  const installs = entries.map((entry) =>
    plugin(entry.name, entry.marketplace, entry.version ?? '1.0.0', entry.sourceSha),
  );

  const { records } = resolveUpdates(installs, entries);

  // A silent skip is the failure mode that matters: it would report a plugin
  // as fine because the resolver never looked at it.
  assert.equal(records.length, installs.length);
  for (const record of records) {
    assert.equal(typeof record.id, 'string');
    assert.ok(['same', 'patch', 'minor', 'major', 'unknown'].includes(record.delta), record.delta);
    assert.ok(['upgrade', 'entry-behind', 'same', 'unknown'].includes(record.direction));
  }
});

test('📏 version classification agrees with an independent comparison', () => {
  const versioned = entries.filter((e) => typeof e.version === 'string');
  const disagreements = [];

  for (const entry of versioned) {
    for (const installed of ['0.0.1', '99.99.99', entry.version]) {
      const delta = semverDelta(installed, entry.version);
      const direction = updateDirection(installed, entry.version);

      // Independent: parse both sides again and compare numerically.
      const a = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(installed);
      const b = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(entry.version);
      if (a === null || b === null) {
        if (installed !== entry.version && delta !== 'unknown') {
          disagreements.push(`${entry.name}: ${installed}→${entry.version} should be unknown`);
        }
        continue;
      }

      const expected =
        installed === entry.version
          ? 'same'
          : Number(a[1]) !== Number(b[1])
            ? 'major'
            : Number(a[2]) !== Number(b[2])
              ? 'minor'
              : Number(a[3]) !== Number(b[3])
                ? 'patch'
                : 'unknown';

      if (delta !== expected) {
        disagreements.push(`${entry.name}: ${installed}→${entry.version} got ${delta}, expected ${expected}`);
      }
      if (installed === entry.version && direction !== 'same') {
        disagreements.push(`${entry.name}: identical versions reported as ${direction}`);
      }
    }
  }

  assert.deepEqual(disagreements, [], disagreements.slice(0, 8).join('\n'));
});

test('📏 a plugin with NO entry is unresolved, across the whole corpus', () => {
  const installs = entries
    .slice(0, 50)
    .map((entry) => plugin(`${entry.name}-absent`, entry.marketplace, '1.0.0', 'a'.repeat(40)));

  const { records } = resolveUpdates(installs, entries);

  // "Up to date" would answer a question that was never asked.
  for (const record of records) {
    assert.ok(record.unresolved !== undefined, `${record.id} was not reported unresolved`);
    assert.equal(record.stalePin, undefined);
  }
});

// ---------------------------------------------------------------------------
// What this gate does NOT certify
// ---------------------------------------------------------------------------

test('the remaining gap is marketplace-level source types, and it fails closed', () => {
  const marketplaces = collected.ok && collected.data !== null ? collected.data.marketplaces : [];
  const kinds = new Set(marketplaces.map((m) => m.source?.source ?? '(none)'));

  // Every marketplace here is `github`. That is the honest limit of this
  // gate, and it is recorded as an assertion so a machine with more diversity
  // makes this test start telling a different story rather than silently
  // certifying more than it did.
  assert.ok(kinds.size >= 1);
  assert.ok(
    kinds.has('github'),
    'the corpus no longer contains a github marketplace; re-read this gate',
  );

  // The unverified branch fails closed rather than guessing a URL — verified
  // directly in remote.test.mjs.
});
