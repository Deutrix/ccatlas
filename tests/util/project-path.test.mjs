/**
 * T1.28 — the path-normalisation matrix.
 *
 * This is the regression fence around the one identity function three call
 * sites share (T1.3 mcp collector, T1.25 projects module, T4.6 analytics
 * attribution). If these three ever disagree about what a project *is*, the
 * inventory double-counts and the ROI denominator is wrong.
 *
 * Plain .mjs, importing the .ts source directly through Node's type stripper —
 * same zero-dependency posture as tests/cli.test.mjs, but exercising the module
 * rather than the built binary, because this module is a library consumed by
 * siblings and not reachable from the CLI surface yet.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collisionWarnings,
  encodeProjectDirName,
  findProjectRef,
  groupProjectKeys,
  isCandidateProjectDir,
  normaliseProjectPath,
  toProjectRef,
} from '../../src/util/project-path.ts';

// ---------------------------------------------------------------------------
// The matrix: [label, input, expectedKey]
//
// Every form the reference machine can produce, plus the forms a non-Windows
// machine produces, because the normaliser is shared and must not be correct
// only where it was written.
// ---------------------------------------------------------------------------

const MATRIX = [
  // Windows native — 30 of 102 keys on the reference machine.
  ['windows native backslash', 'C:\\Users\\alex\\Desktop\\proj', 'c:/users/alex/desktop/proj'],
  ['windows forward slash', 'C:/Users/alex/Desktop/proj', 'c:/users/alex/desktop/proj'],
  ['windows mixed separators', 'C:\\Users/alex\\Desktop', 'c:/users/alex/desktop'],
  ['windows uppercase drive', 'C:\\Users\\alex', 'c:/users/alex'],
  ['windows lowercase drive', 'c:\\users\\alex', 'c:/users/alex'],
  ['windows shouty path', 'C:\\USERS\\ALEX', 'c:/users/alex'],

  // Both drive letters are observed locally: C: and E:.
  ['second drive letter', 'E:\\Breeds 2026\\proj', 'e:/breeds 2026/proj'],

  // POSIX.
  ['posix absolute', '/home/x/proj', '/home/x/proj'],
  ['posix mixed case', '/home/X/Proj', '/home/x/proj'],

  // WSL. Normalised like any other POSIX path — see the negative assertions
  // below for why it is deliberately NOT rewritten to a drive letter.
  ['wsl drvfs mount', '/mnt/c/Users/X/proj', '/mnt/c/users/x/proj'],
  ['wsl trailing separator', '/mnt/c/Users/X/proj/', '/mnt/c/users/x/proj'],

  // Trailing separators — 0 keys locally, but a `cwd` off a transcript record
  // is not bound by whatever normalisation wrote the .claude.json key.
  ['trailing backslash', 'C:\\Users\\alex\\', 'c:/users/alex'],
  ['trailing forward slash', 'C:/Users/alex/', 'c:/users/alex'],
  ['trailing posix slash', '/home/x/', '/home/x'],
  ['many trailing separators', 'C:\\Users\\alex\\\\\\', 'c:/users/alex'],

  // Roots must survive: stripping a trailing separator must never yield ''.
  ['drive root backslash', 'C:\\', 'c:/'],
  ['drive root forward slash', 'C:/', 'c:/'],
  ['bare drive', 'C:', 'c:/'],
  ['posix root', '/', '/'],

  // Duplicate separators.
  ['doubled interior separators', 'C:\\\\Users\\\\\\\\alex', 'c:/users/alex'],
  ['doubled posix separators', '/home//x///proj', '/home/x/proj'],

  // UNC. Zero observed locally; the leading `//` is load-bearing all the same —
  // collapsing it would alias a network share onto a local absolute path.
  ['unc share', '\\\\server\\share\\proj', '//server/share/proj'],
  ['unc already normalised', '//server/share/proj', '//server/share/proj'],
  ['unc trailing separator', '\\\\server\\share\\', '//server/share'],

  // Windows extended-length prefixes.
  ['extended-length drive', '\\\\?\\C:\\Users\\alex', 'c:/users/alex'],
  ['extended-length unc', '\\\\?\\UNC\\server\\share\\proj', '//server/share/proj'],

  // Whitespace, empty.
  ['surrounding whitespace', '  C:\\Users\\alex  ', 'c:/users/alex'],
  ['empty string', '', ''],
  ['whitespace only', '   ', ''],
  ['separators only', '\\\\\\', '/'],
];

test('normalisation matrix — every observed and reachable path form', async (t) => {
  for (const [label, input, expected] of MATRIX) {
    await t.test(label, () => {
      assert.equal(
        normaliseProjectPath(input),
        expected,
        `${JSON.stringify(input)} should normalise to ${JSON.stringify(expected)}`,
      );
    });
  }
});

test('normalisation is idempotent', () => {
  for (const [label, input] of MATRIX) {
    const once = normaliseProjectPath(input);
    assert.equal(normaliseProjectPath(once), once, `not idempotent for ${label}`);
  }
});

// ---------------------------------------------------------------------------
// Negative assertions — the equivalences this normaliser deliberately does NOT
// assert. Each one is a decision, and the test is where the decision lives.
// ---------------------------------------------------------------------------

test('a WSL DrvFs path is NOT equated with its Windows drive-letter form', () => {
  // /mnt/c is only conventionally the C: drive: the mount point is
  // configurable, and on a plain Linux box /mnt/c/... is an ordinary
  // directory. Rewriting it would be a semantic claim beyond the three rules
  // the ProjectRef contract states (lowercase, forward slashes, no trailing
  // separator), and would silently redefine "project" for T1.25 and T4.6.
  assert.notEqual(normaliseProjectPath('/mnt/c/users/x'), normaliseProjectPath('C:\\users\\x'));
});

test('a UNC share is NOT equated with a local absolute path of the same tail', () => {
  assert.notEqual(normaliseProjectPath('\\\\server\\share'), normaliseProjectPath('/server/share'));
});

// ---------------------------------------------------------------------------
// Collisions. The contract is REPORT, never merge.
// ---------------------------------------------------------------------------

/** [label, rawKeys[]] — every group must collapse to exactly one ProjectRef. */
const COLLISION_GROUPS = [
  ['separator and case together', ['C:\\Users\\alex\\p', 'c:/users/alex/p']],
  ['trailing separator only', ['C:\\Users\\alex\\p', 'C:\\Users\\alex\\p\\']],
  ['drive root spellings', ['C:\\', 'C:/', 'c:']],
  ['case only, second drive', ['E:\\Proj', 'e:\\proj']],
  ['posix case only', ['/home/x/p', '/home/X/p']],
  ['the 72-vs-30 separator split', ['C:/a/b', 'C:\\a\\b']],
  ['extended-length prefix vs plain', ['\\\\?\\C:\\a', 'C:\\a']],
  ['unc separator spellings', ['\\\\server\\share\\p', '//server/share/p']],
  ['doubled trailing separators', ['C:\\a\\b', 'C:\\a\\b\\\\']],
  ['surrounding whitespace', ['  C:\\a\\b  ', 'C:\\a\\b']],
];

test('collision matrix — each group collapses to one ref and is flagged', async (t) => {
  for (const [label, rawKeys] of COLLISION_GROUPS) {
    await t.test(label, () => {
      const refs = groupProjectKeys(rawKeys);
      assert.equal(refs.length, 1, `${label} should yield exactly one ProjectRef`);

      const [ref] = refs;
      assert.equal(ref.collides, true, `${label} must be flagged as colliding`);
      assert.deepEqual(ref.rawKeys, rawKeys, 'every raw key must be retained, in input order');
      assert.equal(ref.displayPath, rawKeys[0], 'displayPath is the first raw key, never invented');
    });
  }
});

test('a non-colliding key is not flagged and carries exactly one raw key', () => {
  const [ref] = groupProjectKeys(['C:\\Users\\alex\\solo']);
  assert.equal(ref.collides, false);
  assert.deepEqual(ref.rawKeys, ['C:\\Users\\alex\\solo']);
  assert.equal(ref.key, 'c:/users/alex/solo');
  assert.equal(ref.displayPath, 'C:\\Users\\alex\\solo');
});

test('colliding entries are never merged away — every raw key survives grouping', () => {
  const rawKeys = ['C:\\a\\b', 'c:/a/b', 'C:/A/B/'];
  const [ref] = groupProjectKeys(rawKeys);
  assert.equal(ref.rawKeys.length, 3);
  // The point of the contract: the caller can still go back to each original
  // entry and read its divergent state. Nothing was picked, nothing discarded.
  assert.deepEqual([...ref.rawKeys].sort(), [...rawKeys].sort());
});

test('the reference-machine shape: 102 keys, 92 distinct, exactly 10 colliding', () => {
  const distinct = Array.from({ length: 92 }, (_, i) => `C:\\Users\\alex\\proj${i}`);
  // Ten of them re-appear in the other separator-and-case spelling, which is
  // precisely the measured local condition: 72 forward-slash keys, 30
  // backslash keys, 10 duplicates once normalised.
  const duplicates = distinct.slice(0, 10).map((p) => p.replace(/\\/g, '/').toUpperCase());

  const refs = groupProjectKeys([...distinct, ...duplicates]);

  assert.equal(distinct.length + duplicates.length, 102, 'the input must be 102 keys');
  assert.equal(refs.length, 92, 'normalisation must yield 92 distinct projects');
  assert.equal(refs.filter((r) => r.collides).length, 10, 'exactly 10 must be flagged colliding');
  assert.equal(
    refs.reduce((n, r) => n + r.rawKeys.length, 0),
    102,
    'no raw key may be dropped',
  );
});

test('collisionWarnings emits one path-collision warning per colliding ref', () => {
  const refs = groupProjectKeys(['C:\\a', 'c:/a', '/home/x']);
  const warnings = collisionWarnings(refs);

  assert.equal(warnings.length, 1);
  const [warning] = warnings;
  assert.equal(warning.code, 'path-collision');
  assert.equal(warning.subject, 'c:/a');
  // The message must name the raw keys: a warning that says "there is a
  // collision" without saying which entries collide is not actionable.
  assert.match(warning.message, /C:\\a/);
  assert.match(warning.message, /c:\/a/);
});

test('toProjectRef is the single-key form of groupProjectKeys', () => {
  assert.deepEqual(toProjectRef('C:\\Users\\alex'), groupProjectKeys(['C:\\Users\\alex'])[0]);
});

// ---------------------------------------------------------------------------
// Lookup — T4.6 resolves a transcript `cwd` against the known project set.
// ---------------------------------------------------------------------------

test('findProjectRef matches on the normalised key, whatever spelling is asked', () => {
  const refs = groupProjectKeys(['C:\\Users\\alex\\proj', '/home/x/other']);

  assert.equal(findProjectRef(refs, 'c:/users/alex/proj/')?.key, 'c:/users/alex/proj');
  assert.equal(findProjectRef(refs, 'C:\\USERS\\ALEX\\PROJ')?.key, 'c:/users/alex/proj');
  assert.equal(findProjectRef(refs, '/home/x/other')?.key, '/home/x/other');
  assert.equal(findProjectRef(refs, 'C:\\nowhere'), undefined);
});

// ---------------------------------------------------------------------------
// The lossy encoding — trap 17. Forward only.
// ---------------------------------------------------------------------------

test('encodeProjectDirName reproduces the observed on-disk directory name', () => {
  // Verified against the reference machine: ~/.claude/projects/ contains
  // `C--Users-alex-WORKSTN-Desktop-ccatlas`, and the project is at
  // C:\Users\alex.WORKSTN\Desktop\ccatlas.
  assert.equal(
    encodeProjectDirName('C:\\Users\\alex.WORKSTN\\Desktop\\ccatlas'),
    'C--Users-alex-WORKSTN-Desktop-ccatlas',
  );
  assert.equal(encodeProjectDirName('C:\\Users\\alex.WORKSTN'), 'C--Users-alex-WORKSTN');
});

test('the encoding replaces dots as well as separators and the colon', () => {
  // FORMATS.md trap 17 and §3 both state the class is [\/:]. The reference
  // machine proves dots are replaced too — `alex.WORKSTN` -> `alex-WORKSTN`.
  assert.equal(encodeProjectDirName('C:\\a.b\\c'), 'C--a-b-c');
  assert.equal(encodeProjectDirName('/home/x/.hidden/p'), '-home-x--hidden-p');
});

test('the encoding is provably NOT reversible — distinct paths share one dir name', () => {
  // This is why nothing may reconstruct a path from a directory name: the
  // collision is not theoretical, it is inherent to the character class.
  assert.equal(encodeProjectDirName('C:\\lod-expo'), encodeProjectDirName('C:\\lod.expo'));
  assert.equal(encodeProjectDirName('/a/b'), encodeProjectDirName('/a.b'));
});

test('the module exposes no inverse of the encoding', async () => {
  // A decoder cannot be correct, so it must not exist to be reached for.
  const mod = await import('../../src/util/project-path.ts');
  const inverseLooking = Object.keys(mod).filter((k) => /decode|parseDirName|fromDirName/i.test(k));
  assert.deepEqual(inverseLooking, [], 'no decoder may be exported');
});

test('isCandidateProjectDir narrows candidates without asserting identity', () => {
  assert.equal(
    isCandidateProjectDir('C:\\Users\\alex.WORKSTN\\Desktop\\ccatlas', 'C--Users-alex-WORKSTN-Desktop-ccatlas'),
    true,
  );
  // Case-insensitive, because the encoding preserves the cwd's case and the
  // cwd's case is not stable across the sources we read it from.
  assert.equal(isCandidateProjectDir('c:\\users\\alex.workstn\\desktop\\ccatlas', 'C--Users-alex-WORKSTN-Desktop-ccatlas'), true);
  assert.equal(isCandidateProjectDir('C:\\Users\\someone\\else', 'C--Users-alex-WORKSTN-Desktop-ccatlas'), false);
  // A candidate is a candidate, not proof: both of these match the same dir.
  assert.equal(isCandidateProjectDir('C:\\lod-expo', 'C--lod-expo'), true);
  assert.equal(isCandidateProjectDir('C:\\lod.expo', 'C--lod-expo'), true);
});
