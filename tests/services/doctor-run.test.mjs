/**
 * The IO half of `doctor` — repo-root discovery, git-tracked detection, and
 * the absent-vs-unreadable split.
 *
 * These are the paths `doctor.test.mjs` cannot reach: it tests pure detectors
 * against constructed inputs, which is what makes the negative cases writable,
 * but it therefore never exercises *where the files come from*. That gap hid a
 * blocking bug — `.mcp.json` was looked for in `cwd`, so the critical-severity
 * committed-credential check was unreachable whenever `doctor` was run from a
 * subdirectory, which is most of the time.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { doctor } from '../../src/services/doctor-run.ts';

/** A throwaway HOME plus a throwaway repo, neither touching the real machine. */
function scratch(t) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'ccatlas-doctor-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  mkdirSync(repo, { recursive: true });

  return { root, home, repo };
}

const write = (file, contents) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8');
  return file;
};

/** A credential-shaped literal that the leak scanner allows. */
const FAKE_URL = 'postgres://user:pass@db.example.com:5432/app';

function initRepo(repo) {
  const run = (...args) =>
    execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', windowsHide: true });
  run('init', '-q');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'test');
  return run;
}

const options = (home, projectDir, stateDir) => ({
  home,
  projectDir,
  roots: { home },
  stateDir,
  offline: true,
  toolVersion: 'test',
});

// ---------------------------------------------------------------------------
// Repo-root discovery — the blocking bug
// ---------------------------------------------------------------------------

test('a .mcp.json at the repo ROOT is found when doctor runs from a subdirectory', async (t) => {
  const { root, home, repo } = scratch(t);
  initRepo(repo);
  write(path.join(repo, '.mcp.json'), { mcpServers: { db: { args: ['--url', FAKE_URL] } } });

  const deep = path.join(repo, 'src', 'services');
  mkdirSync(deep, { recursive: true });

  const { report } = await doctor(options(home, deep, path.join(root, 'state')));

  // Trusting cwd here finds nothing, and the critical-severity half of T1.16
  // is silently unreachable while the report still says clean.
  const secret = report.findings.find((f) => f.code === 'secret-in-config');
  assert.ok(secret, 'the repo-root .mcp.json was not found from a subdirectory');
  assert.match(secret.subject, /\.mcp\.json/);
});

test('a tracked .mcp.json is CRITICAL; an untracked one is only a warning', async (t) => {
  const { root, home, repo } = scratch(t);
  const git = initRepo(repo);
  const mcp = write(path.join(repo, '.mcp.json'), {
    mcpServers: { db: { args: ['--url', FAKE_URL] } },
  });

  const untracked = await doctor(options(home, repo, path.join(root, 'state-a')));
  const before = untracked.report.findings.find((f) => f.code === 'secret-in-config');
  assert.equal(before.severity, 'warning', 'git does not know this file yet');

  git('add', '.mcp.json');

  const tracked = await doctor(options(home, repo, path.join(root, 'state-b')));
  const after = tracked.report.findings.find((f) => f.code === 'secret-in-config');

  // The difference is not cosmetic: a tracked credential is exposed to
  // everyone with repo access and stays in history after the edit.
  assert.equal(after.severity, 'critical');
  assert.match(after.fixCommand, /git rm --cached/);
  assert.match(after.cause, /history/);

  // The untracked one must NOT hand the user a command git will reject.
  assert.ok(!before.fixCommand.includes('git rm --cached'), `same fix offered for ${mcp}`);
});

test('a directory with no repository above it scans locally and marks nothing committed', async (t) => {
  const { root, home } = scratch(t);
  const bare = path.join(root, 'not-a-repo');
  mkdirSync(bare, { recursive: true });
  write(path.join(bare, '.mcp.json'), { mcpServers: { db: { args: ['--url', FAKE_URL] } } });

  const { report } = await doctor(options(home, bare, path.join(root, 'state')));
  const secret = report.findings.find((f) => f.code === 'secret-in-config');

  assert.ok(secret, 'the file is still scanned outside a repository');
  assert.equal(secret.severity, 'warning', 'nothing is committed when there is no repo');
});

test('repo-root discovery terminates at the filesystem root', async (t) => {
  const { root, home } = scratch(t);
  const deep = path.join(root, 'a', 'b', 'c', 'd');
  mkdirSync(deep, { recursive: true });

  // No `.git` anywhere above. The walk must stop rather than loop, on `/`,
  // `C:\` and a UNC share alike.
  await assert.doesNotReject(doctor(options(home, deep, path.join(root, 'state'))));
});

// ---------------------------------------------------------------------------
// Absent vs unreadable
// ---------------------------------------------------------------------------

test('an ABSENT config is silently skipped — that is not a finding or a gap', async (t) => {
  const { root, home, repo } = scratch(t);

  const { report } = await doctor(options(home, repo, path.join(root, 'state')));

  assert.ok(!report.skipped.some((s) => s.check.includes('secret scan')));
  assert.deepEqual(report.findings.filter((f) => f.code === 'secret-in-config'), []);
});

test('an UNREADABLE config is recorded as a skipped check, not silently dropped', async (t) => {
  const { root, home, repo } = scratch(t);
  write(path.join(home, '.claude.json'), '{"mcpServers": {');

  const { report } = await doctor(options(home, repo, path.join(root, 'state')));

  // Collapsing absent and unreadable lets a corrupt ~/.claude.json quietly
  // reduce the scan by one file while the report still says clean.
  const skip = report.skipped.find((s) => s.check.includes('.claude.json'));
  assert.ok(skip, 'a corrupt config vanished from the report entirely');
  assert.match(skip.reason, /could not be parsed/);
});

test('one unreadable file does not stop the others being scanned', async (t) => {
  const { root, home, repo } = scratch(t);
  initRepo(repo);
  write(path.join(home, '.claude.json'), 'not json at all');
  write(path.join(repo, '.mcp.json'), { mcpServers: { db: { args: ['--url', FAKE_URL] } } });

  const { report } = await doctor(options(home, repo, path.join(root, 'state')));

  assert.ok(report.findings.some((f) => f.code === 'secret-in-config'));
  assert.ok(report.skipped.some((s) => s.check.includes('.claude.json')));
});

// ---------------------------------------------------------------------------
// Orphan detection keys on installPath, not a reconstructed name
// ---------------------------------------------------------------------------

test('an orphan is decided by installPath, not by rebuilding an id from directories', async (t) => {
  const { root, home, repo } = scratch(t);
  const cache = path.join(home, '.claude', 'plugins', 'cache', 'mkt', 'plug');

  // The installed version, and one beside it.
  mkdirSync(path.join(cache, '2.0.0', '.claude-plugin'), { recursive: true });
  mkdirSync(path.join(cache, '1.0.0', '.claude-plugin'), { recursive: true });

  write(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: {
      'plug@mkt': [{ scope: 'user', version: '2.0.0', installPath: path.join(cache, '2.0.0') }],
    },
  });

  const { report } = await doctor(options(home, repo, path.join(root, 'state')));
  const orphans = report.findings.filter((f) => f.code === 'orphaned-cache-dir');

  // Comparing paths rather than reconstructing `<plugin>@<marketplace>` from
  // directory segments — the same refusal project-path.ts makes about decoding
  // `~/.claude/projects/` names. Reconstruction happens to work today and
  // fails silently the first time a cache dir and a plugin id disagree.
  assert.equal(orphans.length, 1);
  assert.match(orphans[0].subject, /1\.0\.0/);
});

test('a plugin whose cache directory does NOT match its id is still resolved', async (t) => {
  const { root, home, repo } = scratch(t);
  const cache = path.join(home, '.claude', 'plugins', 'cache');

  // Directory says `renamed-dir`; the plugin id says `original-name`. A
  // reconstructed key would call the live directory an orphan and recommend
  // deleting the plugin currently in use.
  const live = path.join(cache, 'mkt', 'renamed-dir', '1.0.0');
  mkdirSync(path.join(live, '.claude-plugin'), { recursive: true });

  write(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: { 'original-name@mkt': [{ scope: 'user', version: '1.0.0', installPath: live }] },
  });

  const { report } = await doctor(options(home, repo, path.join(root, 'state')));

  assert.deepEqual(
    report.findings.filter((f) => f.code === 'orphaned-cache-dir'),
    [],
    'the live directory was reported as an orphan',
  );
});
