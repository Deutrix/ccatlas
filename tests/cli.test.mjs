/**
 * Exercises the built binary, not the TypeScript source.
 *
 * Plain .mjs on purpose — no TS loader, no third-party test framework, so the
 * zero-runtime-dependency posture holds in the test path too.
 *
 * Every invocation goes through `process.execPath` rather than executing
 * bin/ccatlas by name: Windows does not honour shebangs, so `./bin/ccatlas`
 * would fail there for reasons unrelated to the code under test.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(repoRoot, 'bin', 'ccatlas');
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

function runCli(...args) {
  return spawnSync(process.execPath, [binPath, ...args], { encoding: 'utf8' });
}

test('--version prints the version baked in at build time', () => {
  const { status, stdout, stderr } = runCli('--version');
  assert.equal(stderr, '');
  assert.equal(status, 0);
  assert.equal(stdout.trim(), pkg.version);
});

test('status --json emits the one versioned envelope from types.ts', () => {
  const { status, stdout } = runCli('status', '--json', '--cached');
  assert.equal(status, 0);

  const payload = JSON.parse(stdout);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.tool, 'ccatlas');
  assert.equal(payload.version, pkg.version);
  assert.equal(payload.command, 'status');
  assert.doesNotThrow(() => new Date(payload.generatedAt).toISOString());
  assert.ok('data' in payload, 'envelope must carry a data slot even when empty');

  // Defect D1: two envelopes existed, one with `warnings: string[]` and one
  // with structured `Warning[]`. Only the structured one survives, and skills
  // branch on `code` — so a regression to bare strings must fail here rather
  // than be discovered downstream.
  assert.ok(Array.isArray(payload.warnings));
  for (const warning of payload.warnings) {
    assert.equal(typeof warning, 'object', 'warnings must be structured, not strings');
    assert.equal(typeof warning.code, 'string');
    assert.equal(typeof warning.message, 'string');
  }

  // The field set is the contract T7.3-T7.5 read. An added field is a
  // compatible change; a removed one is not.
  for (const field of ['schemaVersion', 'tool', 'version', 'command', 'generatedAt', 'warnings', 'data']) {
    assert.ok(field in payload, `envelope is missing ${field}`);
  }
});

test('--help prints usage and exits 0', () => {
  const { status, stdout } = runCli('--help');
  assert.equal(status, 0);
  assert.match(stdout, /USAGE/);
  assert.match(stdout, /--cached/);
});

test('a bare invocation prints help rather than doing something surprising', () => {
  const { status, stdout } = runCli();
  assert.equal(status, 0);
  assert.match(stdout, /USAGE/);
});

test('unrecognised flags exit 2, name every problem, and suggest', () => {
  const { status, stderr } = runCli('status', '--not-a-real-flag', '--jso');
  assert.equal(status, 2);

  // Both problems in one run: a user who mistyped twice should not have to
  // rediscover the second one after fixing the first.
  assert.match(stderr, /--not-a-real-flag/);
  assert.match(stderr, /--jso/);
  assert.match(stderr, /Did you mean --json/);
});

test('an unknown command exits 2 and lists the known ones', () => {
  const { status, stderr } = runCli('stauts');
  assert.equal(status, 2);
  assert.match(stderr, /unknown command "stauts"/);
  assert.match(stderr, /status/);
});

test('a run that FINDS problems still exits 0', () => {
  // Degraded sections, reconciliation conflicts and shadowed skills are
  // ccatlas working, not ccatlas failing. Nonzero is reserved for T2.10's
  // `updates --check`; establishing "nonzero means findings" here would
  // collide with it, and reclaiming the code later would break scripts.
  const { status, stdout } = runCli('status', '--cached', '--no-color');
  assert.equal(status, 0);
  assert.match(stdout, /ccatlas status/);
});

test('status renders a tree by default and a flat list on request', () => {
  const tree = runCli('status', '--cached', '--no-color');
  const flat = runCli('status', '--cached', '--flat', '--no-color');

  assert.equal(tree.status, 0);
  assert.equal(flat.status, 0);
  assert.match(tree.stdout, /[├└]─/u, 'the default renderer draws a tree');
  assert.ok(!/[├└]─/u.test(flat.stdout), 'the flat renderer draws no tree');
});

test('--no-color emits no ANSI escapes anywhere', () => {
  const { stdout } = runCli('status', '--cached', '--no-color');
  // eslint-disable-next-line no-control-regex
  assert.ok(!/\[/.test(stdout), 'piping status into a file must not embed escape codes');
});

test('--json and --flat together is a usage error, not a silent precedence', () => {
  const { status, stderr } = runCli('status', '--json', '--flat');
  assert.equal(status, 2);
  assert.match(stderr, /--flat/);
});

test('the shipped artifact bundles no runtime dependencies', () => {
  const source = readFileSync(binPath, 'utf8');
  assert.match(source, /^#!\/usr\/bin\/env node\n/);

  // Any bare-specifier import in the bundle means something was left external
  // and would need a node_modules tree beside the plugin cache copy.
  const imports = [...source.matchAll(/(?:^|[;\s}])(?:import|from)\s*"([^"]+)"/g)].map((m) => m[1]);
  const nonBuiltin = imports.filter((specifier) => !specifier.startsWith('node:'));
  assert.deepEqual(nonBuiltin, [], `bundle imports non-builtin modules: ${nonBuiltin.join(', ')}`);

  assert.equal(pkg.dependencies, undefined, 'package.json must declare no runtime dependencies');
});
