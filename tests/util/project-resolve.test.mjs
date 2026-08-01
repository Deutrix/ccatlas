/**
 * T1.28 junction/symlink coverage — defect D2.
 *
 * The string matrix in `project-path.test.mjs` covers WSL, trailing
 * separators, case variants, drive letters and UNC. It had zero coverage of
 * junctions, which is the one class of collision where two paths are *genuinely
 * the same directory* rather than merely similar strings — and therefore the
 * one class no amount of string rewriting can decide.
 *
 * Links are created with `symlinkSync(target, link, 'junction')`. On Windows
 * that makes a real NTFS junction, which needs no elevation; on Linux and
 * macOS the type argument is ignored and a directory symlink is created. So
 * the same test body exercises the real mechanism on all three CI legs rather
 * than being skipped on two of them.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import process from 'node:process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { groupProjectKeys, normaliseProjectPath } from '../../src/util/project-path.ts';
import {
  resolveProjectRefs,
  resolveRealKey,
  sameRealDirectory,
} from '../../src/util/project-resolve.ts';

/**
 * Builds a real directory plus a junction pointing at it.
 *
 * The root is realpath'd immediately, and with `.native`, for two separate
 * reasons that both bite:
 *
 * - macOS hands out `/var/folders/...` from `tmpdir()` while `/var` is itself
 *   a symlink to `/private/var`.
 * - Windows hands out an **8.3 short name** — `C:\Users\ALEX~1.WOR\...` — and
 *   plain `realpathSync` leaves it that way while `realpathSync.native`
 *   expands it to `C:\Users\alex.WORKSTN\...`.
 *
 * Without both, assertions would compare a resolved path against an
 * unresolved one and fail for reasons unrelated to the code under test.
 */
function linkedTree(t) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'ccatlas-link-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const real = path.join(root, 'real', 'project');
  mkdirSync(real, { recursive: true });

  const link = path.join(root, 'via-junction');
  let linked = true;
  try {
    symlinkSync(real, link, 'junction');
  } catch {
    // A locked-down CI image can refuse even junctions. Signalled rather than
    // silently passing an assertion that never ran.
    linked = false;
  }

  return { root, real, link, linked };
}

const ref = (raw) => groupProjectKeys([raw])[0];

// ---------------------------------------------------------------------------
// The gap D2 names
// ---------------------------------------------------------------------------

test('a junction and its target are DIFFERENT strings — the string layer cannot help', (t) => {
  const { real, link, linked } = linkedTree(t);
  if (!linked) return t.skip('this environment refuses to create links');

  // This is the whole point of the defect. Both spellings reach one directory,
  // and every string rule in project-path.ts correctly reports them distinct.
  assert.notEqual(normaliseProjectPath(real), normaliseProjectPath(link));

  const grouped = groupProjectKeys([real, link]);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].collides, false);
  assert.equal(grouped[1].collides, false);
});

test('the resolver catches what the string layer cannot', async (t) => {
  const { real, link, linked } = linkedTree(t);
  if (!linked) return t.skip('this environment refuses to create links');

  const { refs, warnings } = await resolveProjectRefs(groupProjectKeys([real, link]));

  assert.equal(refs.length, 2, 'still two entries — reported, never merged');
  assert.equal(refs[0].realKey, refs[1].realKey);
  assert.deepEqual(refs[0].linkedTo, [refs[1].key]);
  assert.deepEqual(refs[1].linkedTo, [refs[0].key]);
  for (const entry of refs) assert.equal(entry.collides, true);

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'path-collision');
  // Actionable: the warning names both spellings, because the reader's next
  // move is to go and read the divergent state off each entry.
  assert.ok(warnings[0].message.includes(real));
  assert.ok(warnings[0].message.includes(link));
});

test('a nested path THROUGH a junction resolves to the target', async (t) => {
  const { real, link, linked } = linkedTree(t);
  if (!linked) return t.skip('this environment refuses to create links');

  mkdirSync(path.join(real, 'src', 'deep'), { recursive: true });

  assert.equal(
    await resolveRealKey(path.join(link, 'src', 'deep')),
    await resolveRealKey(path.join(real, 'src', 'deep')),
  );
});

test('a junction chain collapses to the final target in one call', async (t) => {
  const { root, real, link, linked } = linkedTree(t);
  if (!linked) return t.skip('this environment refuses to create links');

  const second = path.join(root, 'via-junction-2');
  try {
    symlinkSync(link, second, 'junction');
  } catch {
    return t.skip('nested links unsupported here');
  }

  // realpath resolves the whole chain, so a junction to a junction needs no
  // loop of our own — and cannot be walked into an infinite one.
  assert.equal(await resolveRealKey(second), normaliseProjectPath(real));
});

test('three spellings of one directory produce ONE warning naming all three', async (t) => {
  const { root, real, link, linked } = linkedTree(t);
  if (!linked) return t.skip('this environment refuses to create links');

  const second = path.join(root, 'another-way-in');
  try {
    symlinkSync(real, second, 'junction');
  } catch {
    return t.skip('nested links unsupported here');
  }

  const { refs, warnings } = await resolveProjectRefs(groupProjectKeys([real, link, second]));

  assert.equal(warnings.length, 1, 'one directory, one finding — not one per pair');
  assert.equal(refs.length, 3);
  for (const entry of refs) assert.equal(entry.linkedTo.length, 2);
});

// ---------------------------------------------------------------------------
// Interaction with the string layer
// ---------------------------------------------------------------------------

test('a string collision and a link alias are both reported, from their own layers', async (t) => {
  const { real, link, linked } = linkedTree(t);
  if (!linked) return t.skip('this environment refuses to create links');

  // `real` with a trailing separator is a STRING collision, folded by
  // groupProjectKeys into one ref with two rawKeys.
  const grouped = groupProjectKeys([real, `${real}${path.sep}`, link]);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].rawKeys.length, 2);

  const { refs, warnings } = await resolveProjectRefs(grouped);

  // …and the junction is a LINK alias, caught only by the resolver.
  assert.equal(warnings.length, 1);
  assert.equal(refs[0].collides, true, 'already colliding as a string');
  assert.equal(refs[1].collides, true, 'colliding only as a link');
});

test('a ref whose spelling is unique and whose target is unique collides with nothing', async (t) => {
  const { real, linked } = linkedTree(t);
  if (!linked) return t.skip('this environment refuses to create links');

  const { refs, warnings } = await resolveProjectRefs([ref(real)]);

  assert.deepEqual(warnings, []);
  assert.deepEqual(refs[0].linkedTo, []);
  assert.equal(refs[0].collides, false);
  assert.equal(refs[0].resolution, 'resolved');
});

// ---------------------------------------------------------------------------
// 8.3 short names — a sixth alias class, found by this suite
// ---------------------------------------------------------------------------

test('a Windows 8.3 short name resolves onto its long spelling', async (t) => {
  if (process.platform !== 'win32') return t.skip('8.3 short names are Windows-only');

  // `os.tmpdir()` on this reference machine returns `C:\Users\ALEX~1.WOR\...`
  // — the short form — so this is an everyday path, not a contrived one.
  const short = mkdtempSync(path.join(tmpdir(), 'ccatlas-short-'));
  t.after(() => rmSync(short, { recursive: true, force: true }));

  const long = realpathSync.native(short);
  if (long === short) return t.skip('this volume has 8.3 name creation disabled');

  // Two spellings, one directory, and no string rule can bridge them: the
  // mapping lives in the filesystem.
  assert.notEqual(normaliseProjectPath(short), normaliseProjectPath(long));
  assert.equal(await sameRealDirectory(short, long), true);

  const { refs, warnings } = await resolveProjectRefs(groupProjectKeys([short, long]));
  assert.equal(warnings.length, 1);
  for (const entry of refs) assert.equal(entry.collides, true);
});

// ---------------------------------------------------------------------------
// Unresolvable paths
// ---------------------------------------------------------------------------

test('a deleted project directory is unresolvable, not an error', async () => {
  const gone = path.join(tmpdir(), 'ccatlas-definitely-not-here-8f3a');

  assert.equal(await resolveRealKey(gone), undefined);

  const { refs, warnings } = await resolveProjectRefs([ref(gone)]);
  // ~/.claude.json accumulates keys for directories since deleted or moved,
  // and an unmounted drive looks identical. That is ordinary, not a fault.
  assert.equal(refs[0].resolution, 'unresolvable');
  assert.equal(refs[0].realKey, undefined);
  assert.deepEqual(warnings, []);
});

test('TWO unresolvable paths are not thereby aliases of each other', async () => {
  const a = path.join(tmpdir(), 'ccatlas-missing-a-8f3a');
  const b = path.join(tmpdir(), 'ccatlas-missing-b-8f3a');

  const { refs, warnings } = await resolveProjectRefs([ref(a), ref(b)]);

  // Bucketing on `undefined` would invent an alias out of two absences and
  // then tell the user two unrelated projects are the same directory.
  assert.deepEqual(warnings, []);
  for (const entry of refs) assert.deepEqual(entry.linkedTo, []);
});

test('an empty or whitespace path resolves to nothing', async () => {
  assert.equal(await resolveRealKey(''), undefined);
  assert.equal(await resolveRealKey('   '), undefined);
});

// ---------------------------------------------------------------------------
// The pair helper
// ---------------------------------------------------------------------------

test('sameRealDirectory answers true through a junction', async (t) => {
  const { real, link, linked } = linkedTree(t);
  if (!linked) return t.skip('this environment refuses to create links');

  assert.equal(await sameRealDirectory(real, link), true);
  assert.equal(await sameRealDirectory(link, real), true);
});

test('sameRealDirectory answers false when either side cannot be resolved', async (t) => {
  const { real, linked } = linkedTree(t);
  if (!linked) return t.skip('this environment refuses to create links');

  const gone = path.join(tmpdir(), 'ccatlas-definitely-not-here-8f3a');

  // "Cannot tell" renders as "not proven the same", so the caller keeps two
  // entries rather than merging on a guess.
  assert.equal(await sameRealDirectory(real, gone), false);
  assert.equal(await sameRealDirectory(gone, gone), false);
});

test('sameRealDirectory is true for two spellings of one real path', async (t) => {
  const { real, linked } = linkedTree(t);
  if (!linked) return t.skip('this environment refuses to create links');

  // Separator and trailing-slash variants agree here too, so the resolver is
  // a superset of the string layer rather than a parallel opinion.
  assert.equal(await sameRealDirectory(real, `${real}${path.sep}`), true);
  assert.equal(await sameRealDirectory(real, real.replace(/\\/g, '/')), true);
});

// ---------------------------------------------------------------------------
// Purity of the layer below
// ---------------------------------------------------------------------------

test('the string normaliser remains synchronous and filesystem-free', (t) => {
  const { real, linked } = linkedTree(t);
  if (!linked) return t.skip('this environment refuses to create links');

  const result = normaliseProjectPath(real);
  assert.equal(typeof result, 'string', 'not a promise — collectors call this in a hot loop');

  // It answers for a path that does not exist, which is the property that lets
  // it run over 102 keys without 102 syscalls.
  assert.equal(
    normaliseProjectPath('C:\\Nowhere\\At\\All\\'),
    'c:/nowhere/at/all',
  );
});
