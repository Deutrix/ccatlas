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

test('--json emits a versioned envelope', () => {
  const { status, stdout } = runCli('--json');
  assert.equal(status, 0);

  const payload = JSON.parse(stdout);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.tool, 'ccatlas');
  assert.equal(payload.version, pkg.version);
  assert.equal(payload.command, 'root');
  assert.ok(Array.isArray(payload.warnings));
  assert.doesNotThrow(() => new Date(payload.generatedAt).toISOString());
});

test('--help prints usage and exits 0', () => {
  const { status, stdout } = runCli('--help');
  assert.equal(status, 0);
  assert.match(stdout, /ccatlas --json/);
});

test('unrecognised arguments exit 2 and write to stderr', () => {
  const { status, stderr } = runCli('--not-a-real-flag');
  assert.equal(status, 2);
  assert.match(stderr, /unrecognised arguments/);
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
