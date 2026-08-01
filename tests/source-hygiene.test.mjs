/**
 * Source hygiene — guards against a defect class that has now landed twice.
 *
 * A stray NUL byte inside a template literal produced `` `plugin\0${bare}` ``
 * as a Set lookup key while the insert key was `` `plugin ${plugin}` ``. Every
 * lookup missed, and `usage --unused` recommended deleting all five installed
 * plugins — including `superpowers`, whose skills had been invoked 22 times.
 *
 * It is invisible in an editor, makes the file binary to `grep`, does not
 * appear in a diff, and typechecks perfectly. Nothing else in this repo would
 * have caught it, which is why it gets its own test rather than a code review
 * note.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Tracked AND untracked source — the bug landed in a file git did not know. */
function sourceFiles() {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '*.ts', '*.mjs'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return out.trim().split('\n').filter((f) => f !== '' && !f.startsWith('fixtures/'));
}

test('no source file contains a raw control character', () => {
  const offenders = [];

  for (const file of sourceFiles()) {
    const bytes = readFileSync(path.join(repoRoot, file));
    for (const [index, byte] of bytes.entries()) {
      // Tab, LF and CR are the legitimate ones. Everything else below 0x20 —
      // NUL especially — is invisible and load-bearing by accident.
      if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
        offenders.push(`${file} byte ${index}: 0x${byte.toString(16).padStart(2, '0')}`);
        break;
      }
      if (byte === 0x7f) {
        offenders.push(`${file} byte ${index}: DEL`);
        break;
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `raw control characters found — they are invisible in an editor and in diffs:\n${offenders.join('\n')}`,
  );
});

test('the guard actually inspects a meaningful number of files', () => {
  // A guard that silently matches nothing is worse than no guard: it reports
  // clean while checking an empty set.
  const files = sourceFiles();
  assert.ok(files.length > 25, `only ${files.length} source files were scanned`);
  assert.ok(files.some((f) => f.startsWith('src/')));
  assert.ok(files.some((f) => f.startsWith('tests/')));
});

test('a deliberate NUL separator is written as an escape, not a raw byte', () => {
  // `inventory.ts` uses NUL as a composite-key separator ON PURPOSE — a name
  // or path can contain a space or a colon but never a NUL. It is spelled
  // `\u0000` so it stays visible, and the test above enforces that spelling.
  const source = readFileSync(path.join(repoRoot, 'src', 'services', 'inventory.ts'), 'utf8');
  assert.match(source, /KEY_SEP = '\\u0000'/u, 'the deliberate separator changed spelling');
});
