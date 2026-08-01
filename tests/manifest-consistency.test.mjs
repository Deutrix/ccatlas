/**
 * The repo's own manifests must not exhibit the pathologies ccatlas detects.
 *
 * This is dogfooding with teeth. `package.json` and `.claude-plugin/plugin.json`
 * had **drifted to 0.0.0 vs 0.5.0** — caught only because `--help` printed a
 * version that disagreed with the manifest. Since the marketplace entry uses
 * `source: npm`, those two files describe the *same artefact*, so a mismatch
 * means `ccatlas --version` lies about which build you are running: precisely
 * the class of confusion this tool sells itself on surfacing.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

const pkg = read('../package.json');
const plugin = read('../.claude-plugin/plugin.json');
const marketplace = read('../marketplace/.claude-plugin/marketplace.json');

test('package.json and plugin.json report the SAME version', () => {
  // The binary bakes in pkg.version at build time (scripts/build.mjs), while
  // Claude Code reads plugin.json. Two sources, one artefact.
  assert.equal(
    pkg.version,
    plugin.version,
    `package.json ${pkg.version} vs plugin.json ${plugin.version} — the binary would misreport itself`,
  );
});

test('🔒 the marketplace entry declares NO version — no double declaration', () => {
  const entry = marketplace.plugins.find((p) => p.name === 'ccatlas');
  assert.ok(entry !== undefined, 'ccatlas is missing from its own marketplace');

  // Setting `version` here too would let plugin.json win silently and mask a
  // marketplace bump. That is T2.5's second pathology, committed into our own
  // repo — the least defensible place for it to exist.
  assert.equal(
    entry.version,
    undefined,
    'version is declared in BOTH plugin.json and the marketplace entry',
  );
});

test('the version is a real release, not the scaffold placeholder', () => {
  // 0.0.0 shipped for a while and made every `--version` output meaningless.
  assert.notEqual(pkg.version, '0.0.0');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/u);
});

test('.claude-plugin contains ONLY plugin.json', async () => {
  const { readdirSync } = await import('node:fs');
  const entries = readdirSync(new URL('../.claude-plugin/', import.meta.url));

  // Components placed here silently fail to load — no error, no warning, they
  // just never appear. Cheap to assert, expensive to debug.
  assert.deepEqual(entries, ['plugin.json']);
});
