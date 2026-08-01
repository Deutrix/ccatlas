/**
 * The table primitive, and specifically its width arithmetic.
 *
 * Alignment bugs are invisible in a passing test suite and glaring in a
 * terminal, so the assertions here are about *columns occupied*, never about
 * string length.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { bar, displayWidth, stripAnsi, table, truncate } from '../../src/cli/table.ts';

const ESC = '\u001b';
const red = (t) => `${ESC}[31m${t}${ESC}[0m`;

test('ANSI occupies no columns', () => {
  assert.equal(stripAnsi(red('red')), 'red');
  assert.equal(displayWidth(red('red')), 3);

  // The naive answer, and the reason this module exists.
  assert.equal(red('red').length, 12);
});

test('emoji occupy two columns', () => {
  for (const emoji of ['✅', '⛔', '⚠']) {
    assert.equal(displayWidth(emoji), 2, `${emoji} measured wrong`);
  }
  assert.equal(displayWidth('🚀'), 2);
});

test('combining marks occupy none', () => {
  // "e" + U+0301 renders as a single é.
  assert.equal(displayWidth('e\u0301'), 1);
  assert.equal('e\u0301'.length, 2);
});

test('a variation selector does not add a column', () => {
  assert.equal(displayWidth('⚠\ufe0f'), 2);
});

test('columns align when cells mix ANSI, emoji and plain text', () => {
  const rows = [
    [red('alpha'), '1'],
    ['✅ ok', '2'],
    ['plain', '3'],
  ];
  const out = table([{ header: 'name' }, { header: 'n', align: 'right' }], rows);

  // Column 1 is 5 wide for every row (`alpha`, `✅ ok` and `plain` all occupy
  // 5 columns; the header `name` occupies 4). Plus a 2-space gap and a
  // 1-column value, every line must occupy exactly 8 — including the styled
  // row, whose `.length` is 12 characters longer than it looks.
  const widths = out.map((line) => displayWidth(line));
  assert.deepEqual(
    widths,
    [8, 8, 8, 8],
    `columns did not align: ${out.map((l) => JSON.stringify(stripAnsi(l))).join(' ')}`,
  );
});

test('truncate never splits an escape sequence', () => {
  const out = truncate(red('abcdefghij'), 5);

  // Whatever it cut, the result must not end mid-escape, and must reset.
  assert.ok(out.endsWith(`${ESC}[0m`));
  assert.ok(displayWidth(out) <= 5);
  assert.ok(stripAnsi(out).includes('…'));
});

test('truncate never splits a surrogate pair', () => {
  const out = truncate('🚀🚀🚀🚀', 5);
  assert.ok(!out.includes('\ufffd'), 'produced a replacement character');
  assert.ok(displayWidth(out) <= 5);
});

test('truncate leaves short text untouched', () => {
  assert.equal(truncate('short', 20), 'short');
  assert.equal(truncate('', 5), '');
});

test('an empty table renders NOTHING, not a bare header', () => {
  // "empty ≠ broken": a header with no rows under it reads as a failure. The
  // caller says what nothing looks like.
  assert.deepEqual(table([{ header: 'name' }], []), []);
});

test('a bordered table is rectangular', () => {
  const out = table(
    [{ header: 'plugin' }, { header: 'version' }],
    [
      ['a', '1.0.0'],
      ['much-longer-name', '2.0.0'],
    ],
    { bordered: true },
  );

  const widths = new Set(out.map((l) => displayWidth(l)));
  assert.equal(widths.size, 1, `ragged border: widths ${[...widths].join(', ')}`);
  assert.ok(out[0].startsWith('┌'));
  assert.ok(out.at(-1).startsWith('└'));
});

test('a bordered table stays rectangular with emoji and ANSI inside', () => {
  const out = table(
    [{ header: 'sev' }, { header: 'what' }],
    [
      ['⛔', red('critical thing')],
      ['✅', 'fine'],
    ],
    { bordered: true },
  );

  assert.equal(new Set(out.map((l) => displayWidth(l))).size, 1);
});

test('max truncates the column, and the table stays rectangular', () => {
  const out = table(
    [{ header: 'path', max: 10 }, { header: 'n' }],
    [
      ['C:/a/very/long/path/that/keeps/going', '1'],
      ['short', '2'],
    ],
    { bordered: true },
  );

  assert.equal(new Set(out.map((l) => displayWidth(l))).size, 1);
  assert.ok(out.some((l) => l.includes('…')));
});

test('bar stays visible for small non-zero values', () => {
  // Rounding a small count to an empty bar would render "used twice" and
  // "never used" identically.
  assert.notEqual(bar(1, 500), '');
  assert.equal(bar(0, 500), '');
  assert.equal(bar(5, 0), '');
  assert.ok(displayWidth(bar(500, 500, 12)) <= 12);
});
