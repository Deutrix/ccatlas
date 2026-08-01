/**
 * T4.7 — the `plugin details` cost parser.
 *
 * T0.2 settled that this is text-only: `--json`, `--format`, `--output`,
 * `--plain`, `--quiet` and `--model` are all rejected. So every test here runs
 * against the **real captured documents**, and the four documented traps each
 * get a case.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  detailsCacheKey,
  parsePluginDetails,
  parseTokenCount,
} from '../../src/collectors/details.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = path.join(repoRoot, 'fixtures', 'cli', '2.1.220');

const load = (name) => readFileSync(path.join(dir, `plugin-details-${name}.txt`), 'utf8');
const parse = (name) => parsePluginDetails(name, load(name));

// ---------------------------------------------------------------------------
// Trap 1 — mixed number formats inside one table
// ---------------------------------------------------------------------------

test('every observed token format parses', () => {
  // All five appear in ONE table. A parser handling only `~90` reads `~9.7k`
  // as 9 and understates by three orders of magnitude.
  assert.equal(parseTokenCount('~90'), 90);
  assert.equal(parseTokenCount('~2,069'), 2069);
  assert.equal(parseTokenCount('~8k'), 8000);
  assert.equal(parseTokenCount('~9.7k'), 9700);
  assert.equal(parseTokenCount('~13,990'), 13990);
});

test('an unparseable figure is undefined, never zero', () => {
  // A zero reads as "this costs nothing", the opposite of "could not read".
  assert.equal(parseTokenCount('n/a'), undefined);
  assert.equal(parseTokenCount(''), undefined);
});

test('uppercase and megabyte suffixes work too', () => {
  assert.equal(parseTokenCount('~8K'), 8000);
  assert.equal(parseTokenCount('~1.5M'), 1_500_000);
});

// ---------------------------------------------------------------------------
// The real documents
// ---------------------------------------------------------------------------

test('every captured details document parses without throwing', () => {
  const files = readdirSync(dir).filter((n) => n.startsWith('plugin-details-') && n.endsWith('.txt'));
  assert.ok(files.length >= 5, 'the fixture corpus shrank');

  for (const file of files) {
    const name = file.replace('plugin-details-', '').replace('.txt', '');
    assert.doesNotThrow(() => parsePluginDetails(name, readFileSync(path.join(dir, file), 'utf8')), name);
  }
});

test('the real always-on totals are read exactly', () => {
  assert.equal(parse('everything-claude-code').cost.alwaysOn, 13990);
  assert.equal(parse('figma').cost.alwaysOn, 2069);
  assert.equal(parse('superpowers').cost.alwaysOn, 688);
  assert.equal(parse('ui-ux-pro-max').cost.alwaysOn, 401);
});

test('component counts are read from the inventory section', () => {
  const ecc = parse('everything-claude-code');
  assert.equal(ecc.contributes.skills, 196);
  assert.equal(ecc.contributes.hooks, 7);
  assert.equal(ecc.contributes.mcpServers, 6);
  // Every fixture reports zero LSP servers — the reason T1.14 is blocked.
  assert.equal(ecc.contributes.lspServers, 0);
});

test('a version that is ABSENT stays absent rather than becoming "unknown"', () => {
  // frontend-design resolves to no version; the head line carries only a name.
  assert.equal(parse('frontend-design').version, undefined);
  assert.equal(parse('superpowers').version, '6.2.0');
});

// ---------------------------------------------------------------------------
// Trap 2 — per-component values do not sum to the total
// ---------------------------------------------------------------------------

test('a large component/total mismatch is REPORTED, not reconciled', () => {
  const ecc = parse('everything-claude-code');

  // Components sum to ~24,610 against a stated 13,990. Both sections round
  // independently, and above the ~30k listing cap per-entity figures rank but
  // do not add. Adding them and presenting the result would produce a number
  // the tool itself contradicts.
  const summed = ecc.components.reduce((sum, c) => sum + (c.alwaysOn ?? 0), 0);
  assert.ok(summed > ecc.cost.alwaysOn);
  assert.ok(ecc.warnings.some((w) => w.includes('never added together')));
});

test('a document whose sections agree carries no mismatch warning', () => {
  // The false-positive guard: rounding differences must not fire this.
  assert.ok(!parse('figma').warnings.some((w) => w.includes('never added together')));
});

// ---------------------------------------------------------------------------
// Trap 4 — the estimator falls back silently
// ---------------------------------------------------------------------------

test('regime is always `unknown` — it is NOT inferred from the numbers', () => {
  // A bogus model and an unreachable endpoint produce byte-identical,
  // well-formed output ~40% apart. There is nothing in the text to infer the
  // regime from, and guessing puts a confident label on a possibly-wrong
  // number.
  for (const name of ['figma', 'superpowers', 'ui-ux-pro-max']) {
    assert.equal(parse(name).cost.regime, 'unknown', name);
  }
});

test('the cache key carries model AND regime, not just plugin@version', () => {
  // `plugin@version` alone serves one model's numbers for another's.
  const a = detailsCacheKey('p', '1.0.0', 'claude-opus-5', 'tokenizer');
  const b = detailsCacheKey('p', '1.0.0', 'claude-sonnet-5', 'tokenizer');
  const c = detailsCacheKey('p', '1.0.0', 'claude-opus-5', 'fallback');

  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('an absent model is named rather than silently omitted', () => {
  assert.match(detailsCacheKey('p', '1.0.0', undefined, 'unknown'), /unknown-model/);
});

// ---------------------------------------------------------------------------
// Trap 7 — an error document is not a details document
// ---------------------------------------------------------------------------

test('the not-installed error document is rejected, not scraped', () => {
  const parsed = parse('notinstalled');

  // `plugin details <missing>` writes its error to STDOUT with an empty
  // stderr. Parsing it scraped a "version" of "42crunch-api-security-testing"
  // out of the error prose before this guard existed.
  assert.equal(parsed.version, undefined);
  assert.equal(parsed.cost.alwaysOn, 0);
  assert.equal(parsed.components.length, 0);
  assert.match(parsed.warnings[0], /not a `plugin details` document/);
});

test('an empty document is rejected the same way', () => {
  const parsed = parsePluginDetails('x', '');
  assert.match(parsed.warnings[0], /not a `plugin details` document/);
});

// ---------------------------------------------------------------------------
// Per-component rows
// ---------------------------------------------------------------------------

test('per-component rows carry a name and at least one figure', () => {
  for (const component of parse('figma').components) {
    assert.ok(component.name.length > 0);
    assert.ok(component.alwaysOn !== undefined || component.onInvoke !== undefined);
  }
});

test('the estimator caveat prose is not parsed as a component', () => {
  const names = parse('superpowers').components.map((c) => c.name);
  assert.ok(!names.some((n) => /On-invoke cost|Token counts/u.test(n)));
});
