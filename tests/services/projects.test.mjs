/**
 * T1.25 — the `projects` module.
 *
 * The interesting cases are all about the **asymmetry** between the two
 * enumeration sources: `~/.claude.json` keys are real absolute paths, while
 * `~/.claude/projects/` names are an encoded form that folds `\`, `/`, `:`
 * *and `.`* onto `-` and has no inverse. On the reference machine that is 103
 * keys against 35 directories, so most keys have no transcripts and some
 * directories match no key.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { collectProjects, findProject, readTranscriptDirNames } from '../../src/services/projects.ts';

const keys = (...values) => ({ claudeJsonKeys: values });

function tempTree(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ccatlas-projects-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// ---------------------------------------------------------------------------
// Grouping and collisions
// ---------------------------------------------------------------------------

test('two spellings of one path collapse to one project, keeping both raw keys', async () => {
  const inventory = await collectProjects(
    keys('C:/laragon/www/app', 'C:\\laragon\\www\\app'),
  );

  assert.equal(inventory.projects.length, 1);
  assert.equal(inventory.projects[0].ref.rawKeys.length, 2);
  assert.equal(inventory.projects[0].ref.collides, true);

  // Reported, never merged: each entry may hold different per-project state.
  assert.ok(inventory.warnings.some((w) => w.code === 'path-collision'));
});

test('distinct paths stay distinct — the negative case', async () => {
  const inventory = await collectProjects(keys('C:/a/one', 'C:/a/two'));

  assert.equal(inventory.projects.length, 2);
  for (const project of inventory.projects) assert.equal(project.ref.collides, false);
  assert.deepEqual(inventory.warnings, []);
});

test('no keys and no directories is an empty inventory, not an error', async () => {
  const inventory = await collectProjects();
  assert.deepEqual(inventory.projects, []);
  assert.deepEqual(inventory.unresolved, []);
});

// ---------------------------------------------------------------------------
// Directory matching — forward only
// ---------------------------------------------------------------------------

test('a transcript directory is matched by ENCODING the key, never by decoding', async () => {
  const inventory = await collectProjects({
    claudeJsonKeys: ['C:\\Users\\me\\Desktop\\app'],
    transcriptDirNames: ['C--Users-me-Desktop-app'],
  });

  assert.deepEqual(inventory.projects[0].sources, ['claude-json', 'transcripts']);
  assert.deepEqual(inventory.projects[0].transcriptDirs, ['C--Users-me-Desktop-app']);
  assert.deepEqual(inventory.unresolved, []);
});

test('a key with no transcript directory is still a project', async () => {
  // 103 keys against 35 directories: having no sessions yet is the common
  // case, not a defect.
  const inventory = await collectProjects({
    claudeJsonKeys: ['C:\\never\\opened'],
    transcriptDirNames: [],
  });

  assert.deepEqual(inventory.projects[0].sources, ['claude-json']);
  assert.deepEqual(inventory.projects[0].transcriptDirs, []);
});

test('a directory no key explains is reported, never dropped or guessed', async () => {
  const inventory = await collectProjects({
    claudeJsonKeys: ['C:\\known'],
    transcriptDirNames: ['C--known', 'E--Breeds-2026'],
  });

  assert.equal(inventory.unresolved.length, 1);
  assert.equal(inventory.unresolved[0].dirName, 'E--Breeds-2026');
  // Real case: the reference machine has 3 such directories, all on a second
  // drive letter whose keys are absent from ~/.claude.json.
  assert.match(inventory.unresolved[0].reason, /no inverse/);
  assert.ok(inventory.warnings.some((w) => w.code === 'partial'));
});

test('an unresolved directory gets NO invented path', async () => {
  const inventory = await collectProjects({ transcriptDirNames: ['E--Mystery-Dir'] });

  // The only honest path comes from the `cwd` field on a record inside the
  // file, and reading transcripts is T4.1's quarantined job. A guess here
  // would put an unreliable string into the identity layer everything keys on.
  assert.deepEqual(inventory.projects, []);
  assert.equal(inventory.unresolved[0].dirName, 'E--Mystery-Dir');
  assert.ok(!('ref' in inventory.unresolved[0]));
});

test('the lossy encoding is respected: a dot and a hyphen collide by design', async () => {
  // `C:\lod-expo` and `C:\lod.expo` produce the same directory name, so ONE
  // directory legitimately matches two keys. Both claim it rather than the
  // module picking a winner it has no basis to pick.
  const inventory = await collectProjects({
    claudeJsonKeys: ['C:\\lod-expo', 'C:\\lod.expo'],
    transcriptDirNames: ['C--lod-expo'],
  });

  assert.equal(inventory.projects.length, 2);
  for (const project of inventory.projects) {
    assert.deepEqual(project.transcriptDirs, ['C--lod-expo']);
  }
  assert.deepEqual(inventory.unresolved, []);
});

test('either raw spelling of a collided key can match the directory', async () => {
  // The encoding folds separators, and two keys that collided into one ref
  // differ in exactly those — so every raw spelling is tried, not just the
  // display one.
  const inventory = await collectProjects({
    claudeJsonKeys: ['C:/Users/me/app', 'C:\\Users\\me\\app'],
    transcriptDirNames: ['C--Users-me-app'],
  });

  assert.equal(inventory.projects.length, 1);
  assert.deepEqual(inventory.projects[0].transcriptDirs, ['C--Users-me-app']);
});

// ---------------------------------------------------------------------------
// Existence — gone vs unreachable
// ---------------------------------------------------------------------------

test('a directory that exists probes as present', async (t) => {
  const root = tempTree(t);
  const inventory = await collectProjects({ claudeJsonKeys: [root], probe: true });

  assert.equal(inventory.projects[0].existence, 'present');
});

test('a deleted directory probes as GONE — the T1.27 signal', async (t) => {
  const root = tempTree(t);
  const missing = path.join(root, 'deleted-project');

  const inventory = await collectProjects({ claudeJsonKeys: [missing], probe: true });
  assert.equal(inventory.projects[0].existence, 'gone');
});

test('a path under a file is gone (ENOTDIR), not unreachable', async (t) => {
  const root = tempTree(t);
  mkdirSync(path.join(root, 'real'), { recursive: true });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path.join(root, 'afile'), 'x', 'utf8');

  const inventory = await collectProjects({
    claudeJsonKeys: [path.join(root, 'afile', 'under-a-file')],
    probe: true,
  });

  assert.equal(inventory.projects[0].existence, 'gone');
});

test('without probing, existence is unreachable rather than a guess', async () => {
  const inventory = await collectProjects(keys('C:\\somewhere'));

  // "Not measured" must not read as "present". The pure path exists so the
  // matching logic can be tested without a filesystem.
  assert.equal(inventory.projects[0].existence, 'unreachable');
});

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

test('findProject resolves any spelling of a known path', async () => {
  const inventory = await collectProjects(keys('C:\\Users\\me\\App'));

  for (const spelling of [
    'C:\\Users\\me\\App',
    'C:/Users/me/App',
    'c:/users/me/app/',
    'C:\\Users\\me\\App\\',
  ]) {
    assert.ok(findProject(inventory, spelling), `did not resolve ${spelling}`);
  }
});

test('findProject returns undefined for an unknown path and for empty input', async () => {
  const inventory = await collectProjects(keys('C:\\known'));

  assert.equal(findProject(inventory, 'C:\\unknown'), undefined);
  assert.equal(findProject(inventory, ''), undefined);
  assert.equal(findProject(inventory, '   '), undefined);
});

// ---------------------------------------------------------------------------
// Reading the directory
// ---------------------------------------------------------------------------

test('an absent transcripts root reads as no directories, not an error', async () => {
  assert.deepEqual(
    await readTranscriptDirNames(path.join(tmpdir(), 'ccatlas-no-such-projects-root')),
    [],
  );
});

test('only directories are enumerated, not stray files', async (t) => {
  const root = tempTree(t);
  mkdirSync(path.join(root, 'C--a-project'), { recursive: true });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path.join(root, 'not-a-dir.jsonl'), '', 'utf8');

  assert.deepEqual(await readTranscriptDirNames(root), ['C--a-project']);
});
