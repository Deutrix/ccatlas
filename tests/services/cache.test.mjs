/**
 * T1.10 — the inventory cache.
 *
 * Two things are being proved: that a stale answer cannot be served, and that
 * a broken cache cannot break the run. The second matters more than it sounds
 * — ccatlas exists to inspect machines in a bad state, and a read-only `$HOME`
 * is one of those states.
 *
 * Every test passes an explicit `stateDir` under the OS temp dir, so nothing
 * here touches `~/.ccatlas` or `${CLAUDE_PLUGIN_DATA}` on the running machine.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
  CACHE_FORMAT_VERSION,
  cacheDir,
  clearCache,
  DIRTY_FLAG,
  fingerprintInputs,
  isDirty,
  markDirty,
  readCache,
  resolveStateDir,
  writeCache,
} from '../../src/services/cache.ts';

function tempState(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ccatlas-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeInput(root, name, contents) {
  const target = path.join(root, name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
  return target;
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

test('CLAUDE_PLUGIN_DATA wins, because it survives plugin updates', () => {
  const previous = process.env['CLAUDE_PLUGIN_DATA'];
  process.env['CLAUDE_PLUGIN_DATA'] = path.join(tmpdir(), 'plugin-data');
  try {
    assert.equal(resolveStateDir(), path.join(tmpdir(), 'plugin-data'));
  } finally {
    if (previous === undefined) delete process.env['CLAUDE_PLUGIN_DATA'];
    else process.env['CLAUDE_PLUGIN_DATA'] = previous;
  }
});

test('standalone installs fall back to ~/.ccatlas, never to the plugin root', () => {
  const previous = process.env['CLAUDE_PLUGIN_DATA'];
  const root = process.env['CLAUDE_PLUGIN_ROOT'];
  delete process.env['CLAUDE_PLUGIN_DATA'];
  process.env['CLAUDE_PLUGIN_ROOT'] = path.join(tmpdir(), 'plugin-root-must-not-be-used');
  try {
    const resolved = resolveStateDir();
    assert.ok(resolved.endsWith('.ccatlas'));
    // ${CLAUDE_PLUGIN_ROOT} changes on every plugin update, so a cache there
    // is discarded exactly when the user updates and then wonders why the
    // tool got slow.
    assert.ok(!resolved.includes('plugin-root-must-not-be-used'));
  } finally {
    if (previous !== undefined) process.env['CLAUDE_PLUGIN_DATA'] = previous;
    if (root === undefined) delete process.env['CLAUDE_PLUGIN_ROOT'];
    else process.env['CLAUDE_PLUGIN_ROOT'] = root;
  }
});

test('an empty CLAUDE_PLUGIN_DATA is treated as unset, not as the cwd', () => {
  const previous = process.env['CLAUDE_PLUGIN_DATA'];
  process.env['CLAUDE_PLUGIN_DATA'] = '   ';
  try {
    assert.ok(resolveStateDir().endsWith('.ccatlas'));
  } finally {
    if (previous === undefined) delete process.env['CLAUDE_PLUGIN_DATA'];
    else process.env['CLAUDE_PLUGIN_DATA'] = previous;
  }
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

test('a written entry reads back identically', async (t) => {
  const stateDir = tempState(t);
  const input = writeInput(stateDir, 'settings.json', '{}');
  const value = { plugins: [{ id: 'p@mkt', version: '1.0.0' }] };

  assert.deepEqual(await writeCache('inventory', [input], value, { stateDir }), []);
  const read = await readCache('inventory', { stateDir });

  assert.equal(read.hit, true);
  assert.deepEqual(read.value, value);
  assert.doesNotThrow(() => new Date(read.writtenAt).toISOString());
});

test('the reader supplies no fingerprint — the ENTRY names its own inputs', async (t) => {
  const stateDir = tempState(t);
  const input = writeInput(stateDir, 'settings.json', '{}');
  await writeCache('inventory', [input], { ok: true }, { stateDir });

  // A reader that had to pass a path list would be maintaining it separately
  // from the collectors that do the reading, and the two would drift the
  // moment a collector learned to read something new — validating against a
  // stale set and serving stale answers. So the list is recorded, not passed.
  const entry = JSON.parse(readFileSync(path.join(cacheDir(stateDir), 'inventory.json'), 'utf8'));
  assert.deepEqual(entry.inputs, [input]);
  assert.equal(typeof entry.fingerprint, 'string');
});

test('an absent entry is a miss with a reason, never a throw', async (t) => {
  const read = await readCache('nothing-here', { stateDir: tempState(t) });
  assert.deepEqual(read, { hit: false, reason: 'absent' });
});

// ---------------------------------------------------------------------------
// Invalidation — both mechanisms, because either alone serves stale answers
// ---------------------------------------------------------------------------

test('the dirty flag invalidates without reading the entry', async (t) => {
  const stateDir = tempState(t);
  const input = writeInput(stateDir, 'settings.json', '{}');
  await writeCache('inventory', [input], { ok: true }, { stateDir });

  await markDirty(stateDir);
  assert.equal(await isDirty(stateDir), true);

  const read = await readCache('inventory', { stateDir });
  assert.deepEqual(read, { hit: false, reason: 'dirty' });
});

test('a write clears the dirty flag', async (t) => {
  const stateDir = tempState(t);
  const input = writeInput(stateDir, 'settings.json', '{}');
  await markDirty(stateDir);

  await writeCache('inventory', [input], { ok: true }, { stateDir });

  assert.equal(await isDirty(stateDir), false);
  assert.equal((await readCache('inventory', { stateDir })).hit, true);
});

test('editing a recorded input invalidates, with no flag involved', async (t) => {
  const stateDir = tempState(t);
  const input = writeInput(stateDir, 'settings.json', '{}');
  await writeCache('inventory', [input], { ok: true }, { stateDir });
  assert.equal((await readCache('inventory', { stateDir })).hit, true);

  // The hook only fires while Claude Code is running. An edit from an editor,
  // a script, or `sync pull` sets no flag at all — so the fingerprint is the
  // authority and the flag is only the fast path.
  writeFileSync(input, '{"enabledPlugins":{"p@m":true}}', 'utf8');

  assert.deepEqual(await readCache('inventory', { stateDir }), {
    hit: false,
    reason: 'stale-inputs',
  });
});

test('CREATING a recorded-but-absent input invalidates', async (t) => {
  const stateDir = tempState(t);
  const present = writeInput(stateDir, 'settings.json', '{}');
  const absent = path.join(stateDir, 'project-settings.json');

  // The absent file is fingerprinted as absent, which is the only way its
  // later creation can be noticed at all.
  await writeCache('inventory', [present, absent], { ok: true }, { stateDir });
  assert.equal((await readCache('inventory', { stateDir })).hit, true);

  writeFileSync(absent, '{}', 'utf8');
  assert.equal((await readCache('inventory', { stateDir })).reason, 'stale-inputs');
});

test('an entry recording NO inputs is unusable, not trivially fresh', async (t) => {
  const stateDir = tempState(t);
  await writeCache('inventory', [], { ok: true }, { stateDir });

  // Nothing could ever invalidate it, so it would be served forever.
  assert.equal((await readCache('inventory', { stateDir })).reason, 'stale-inputs');
});

test('a bumped cache format is a miss, not a parse attempt', async (t) => {
  const stateDir = tempState(t);
  const input = writeInput(stateDir, 'settings.json', '{}');
  await writeCache('inventory', [input], { ok: true }, { stateDir });

  const target = path.join(cacheDir(stateDir), 'inventory.json');
  const entry = JSON.parse(readFileSync(target, 'utf8'));
  assert.equal(entry.cacheFormatVersion, CACHE_FORMAT_VERSION);
  writeFileSync(target, JSON.stringify({ ...entry, cacheFormatVersion: 999 }), 'utf8');

  assert.deepEqual(await readCache('inventory', { stateDir }), {
    hit: false,
    reason: 'format-changed',
  });
});

test('an entry written against a different payload schema is a miss', async (t) => {
  const stateDir = tempState(t);
  const input = writeInput(stateDir, 'settings.json', '{}');
  await writeCache('inventory', [input], { ok: true }, { stateDir });

  const target = path.join(cacheDir(stateDir), 'inventory.json');
  const entry = JSON.parse(readFileSync(target, 'utf8'));
  writeFileSync(target, JSON.stringify({ ...entry, schemaVersion: 0 }), 'utf8');

  assert.equal((await readCache('inventory', { stateDir })).reason, 'format-changed');
});

test('an entry with no inputs array at all is format-changed, not a crash', async (t) => {
  const stateDir = tempState(t);
  const input = writeInput(stateDir, 'settings.json', '{}');
  await writeCache('inventory', [input], { ok: true }, { stateDir });

  const target = path.join(cacheDir(stateDir), 'inventory.json');
  const { inputs, ...withoutInputs } = JSON.parse(readFileSync(target, 'utf8'));
  assert.ok(Array.isArray(inputs));
  writeFileSync(target, JSON.stringify(withoutInputs), 'utf8');

  // An entry written by a build that predates input recording.
  assert.equal((await readCache('inventory', { stateDir })).reason, 'format-changed');
});

test('a truncated entry self-heals rather than crashing the run', async (t) => {
  const stateDir = tempState(t);
  const input = writeInput(stateDir, 'settings.json', '{}');
  await writeCache('inventory', [input], { ok: true }, { stateDir });

  // An interrupted write, or a full disk.
  writeFileSync(path.join(cacheDir(stateDir), 'inventory.json'), '{"cacheFormat', 'utf8');

  const read = await readCache('inventory', { stateDir });
  assert.equal(read.hit, false);
  assert.equal(read.reason, 'unreadable');

  assert.deepEqual(await writeCache('inventory', [input], { ok: true }, { stateDir }), []);
  assert.equal((await readCache('inventory', { stateDir })).hit, true);
});

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

test('the fingerprint is order-stable across argument order', async (t) => {
  const root = tempState(t);
  const a = writeInput(root, 'a.json', '{}');
  const b = writeInput(root, 'b.json', '{"x":1}');

  assert.equal(await fingerprintInputs([a, b]), await fingerprintInputs([b, a]));
});

test('an edit that changes size changes the fingerprint', async (t) => {
  const root = tempState(t);
  const target = writeInput(root, 'settings.json', '{}');
  const before = await fingerprintInputs([target]);

  writeFileSync(target, '{"enabledPlugins":{"p@m":true}}', 'utf8');
  assert.notEqual(await fingerprintInputs([target]), before);
});

test('a same-size edit still changes the fingerprint via mtime', async (t) => {
  const root = tempState(t);
  const target = writeInput(root, 'settings.json', '{"a":1}');
  const before = await fingerprintInputs([target]);

  writeFileSync(target, '{"a":2}', 'utf8');
  // Filesystems can report a coarse mtime, so force a distinct one rather
  // than relying on the write landing in a later tick.
  const future = new Date(Date.now() + 5000);
  utimesSync(target, future, future);

  assert.notEqual(await fingerprintInputs([target]), before);
});

test('CREATING a previously absent input invalidates too', async (t) => {
  const root = tempState(t);
  const target = path.join(root, 'not-yet.json');

  const before = await fingerprintInputs([target]);
  assert.ok(before.endsWith(':-'), 'an absent file is fingerprinted, not skipped');

  writeFileSync(target, '{}', 'utf8');
  // Without this, adding a project settings.json would leave a cached answer
  // that predates the file serving happily forever.
  assert.notEqual(await fingerprintInputs([target]), before);
});

// ---------------------------------------------------------------------------
// Failure posture
// ---------------------------------------------------------------------------

test('an unwritable state dir yields a warning, not a throw', async (t) => {
  const root = tempState(t);
  // A FILE where the cache directory should be: mkdir fails on every platform,
  // unlike chmod tricks, which are a no-op for an administrator on Windows.
  writeFileSync(path.join(root, 'cache'), 'not a directory', 'utf8');

  const warnings = await writeCache('inventory', [path.join(root, 'x.json')], { ok: true }, { stateDir: root });

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'partial');
  assert.ok(warnings[0].message.includes('Answers stay correct'));
});

test('markDirty on an unwritable state dir does not throw — hooks must not fail', async (t) => {
  const root = tempState(t);
  writeFileSync(path.join(root, 'cache'), 'not a directory', 'utf8');

  // T7.10 caps hooks at 150ms and they must never block session start; a
  // throwing invalidation would do exactly that.
  await assert.doesNotReject(markDirty(root));
});

test('no temp file survives a failed write', async (t) => {
  const stateDir = tempState(t);
  const input = writeInput(stateDir, 'settings.json', '{}');
  await writeCache('inventory', [input], { ok: true }, { stateDir });

  const before = readFileSync(path.join(cacheDir(stateDir), 'inventory.json'), 'utf8');

  // A value JSON.stringify cannot serialise.
  const circular = {};
  circular.self = circular;
  const warnings = await writeCache('inventory', [input], circular, { stateDir });

  assert.equal(warnings.length, 1);
  const { readdirSync } = await import('node:fs');
  assert.deepEqual(
    readdirSync(cacheDir(stateDir)).filter((name) => name.includes('.tmp')),
    [],
  );
  // The previous good entry is intact: a failed write never destroys one.
  assert.equal(readFileSync(path.join(cacheDir(stateDir), 'inventory.json'), 'utf8'), before);
});

test('clearCache drops everything, dirty flag included', async (t) => {
  const stateDir = tempState(t);
  const input = writeInput(stateDir, 'settings.json', '{}');
  await writeCache('inventory', [input], { ok: true }, { stateDir });
  await markDirty(stateDir);

  await clearCache({ stateDir });

  assert.equal(await isDirty(stateDir), false);
  assert.deepEqual(await readCache('inventory', { stateDir }), { hit: false, reason: 'absent' });
});

test('clearing an already-absent cache is a no-op, not an error', async (t) => {
  await assert.doesNotReject(clearCache({ stateDir: path.join(tempState(t), 'nope') }));
});

test('the dirty flag lives inside the cache dir so clearCache removes it', async (t) => {
  const stateDir = tempState(t);
  await markDirty(stateDir);
  assert.equal(
    readFileSync(path.join(cacheDir(stateDir), DIRTY_FLAG), 'utf8'),
    '',
  );
});
