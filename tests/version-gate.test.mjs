/**
 * TX.1 — Claude Code version detection and feature gating.
 *
 * The posture is **warn, never crash**. ccatlas is a diagnostic, and a machine
 * running something unexpected is exactly the machine somebody is trying to
 * diagnose — so an out-of-range version degrades specific features and says
 * so, rather than refusing to run.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessVersion,
  compareVersions,
  isDegraded,
  MINIMUM_VERSION,
  parseVersionOutput,
  TESTED_VERSION,
} from '../src/version-gate.ts';

test('versions compare NUMERICALLY, not lexically', () => {
  // "2.1.9" > "2.1.10" as strings, which would call a newer build older.
  assert.ok(compareVersions('2.1.10', '2.1.9') > 0);
  assert.ok(compareVersions('2.1.143', '2.1.99') > 0);
  assert.equal(compareVersions('2.1.220', '2.1.220'), 0);
});

test('a leading v is tolerated and nonsense is NaN', () => {
  assert.equal(compareVersions('v2.1.0', '2.1.0'), 0);
  assert.ok(Number.isNaN(compareVersions('nightly', '2.1.0')));
});

test('the version is extracted from the real --version output', () => {
  assert.equal(parseVersionOutput('2.1.220 (Claude Code)'), '2.1.220');
  assert.equal(parseVersionOutput('  2.1.143  '), '2.1.143');
  assert.equal(parseVersionOutput('unknown'), undefined);
});

test('the tested version is supported and degrades nothing', () => {
  const verdict = assessVersion(TESTED_VERSION);
  assert.equal(verdict.position, 'supported');
  assert.deepEqual(verdict.degrade, []);
});

test('below the minimum degrades CLI-sourced features but still runs', () => {
  const verdict = assessVersion('2.0.1');

  // A hard refusal is the wrong response to an old CLI — the file layer is
  // most of what ccatlas reads and is unaffected.
  assert.equal(verdict.position, 'below-minimum');
  assert.ok(verdict.degrade.length > 0);
  assert.match(verdict.message, /still read what it can/);
  assert.ok(isDegraded(verdict, 'plugin-details-cost'));
});

test('the minimum itself is supported, not below it', () => {
  assert.equal(assessVersion(MINIMUM_VERSION).position, 'supported');
});

test('ABOVE the tested range warns but degrades nothing', () => {
  const verdict = assessVersion('3.0.0');

  // Refusing here would make ccatlas expire on every Claude Code release.
  assert.equal(verdict.position, 'above-tested');
  assert.deepEqual(verdict.degrade, []);
  assert.match(verdict.message, /expected rather than alarming/);
});

test('an undetectable version is not a failure', () => {
  const verdict = assessVersion(undefined);

  // `claude --version` can be absent on a machine where the file layer works
  // perfectly.
  assert.equal(verdict.position, 'unknown');
  assert.deepEqual(verdict.degrade, []);
  assert.match(verdict.message, /file layer is unaffected/);
});
