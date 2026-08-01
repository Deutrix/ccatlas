/**
 * T3.13–T3.15 — `--all-projects`.
 *
 * T3.14 is the security-critical one, and its test is about **filenames** as
 * much as contents: a directory listing of `p-clients-bigcorp.html` discloses
 * exactly what redacting the page bodies was meant to prevent.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  allProjectsGate,
  projectSlug,
  renderIndex,
  writeProjectReport,
} from '../../src/services/all-projects.ts';

function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccatlas-all-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// T3.14 🔒 — the redaction gate
// ---------------------------------------------------------------------------

test('--all-projects REFUSES without --redact', () => {
  const gate = allProjectsGate({ redact: false, allowPaths: false });

  // Fails closed. This is a command whose output people share precisely
  // because it looks like a dashboard.
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /--redact/);
  assert.match(gate.reason, /who you work for/);
});

test('--redact opens the gate', () => {
  assert.equal(allProjectsGate({ redact: true, allowPaths: false }).allowed, true);
});

test('the override is explicit and named, not a bare --yes', () => {
  // `--allow-paths` says what is being permitted; `--yes` only agrees to
  // something unnamed.
  const gate = allProjectsGate({ redact: false, allowPaths: true });
  assert.equal(gate.allowed, true);
});

test('the refusal names both ways forward', () => {
  const { reason } = allProjectsGate({ redact: false, allowPaths: false });
  assert.match(reason, /--allow-paths/);
});

// ---------------------------------------------------------------------------
// 🔒 Filenames leak too
// ---------------------------------------------------------------------------

test('a filename carries NO information about the project', () => {
  const slug = projectSlug('C:\\Users\\jane\\clients\\bigcorp\\secret-product');

  // A directory listing leaks as effectively as a page body.
  assert.match(slug, /^p-[0-9a-f]{8}$/u);
  for (const leak of ['jane', 'clients', 'bigcorp', 'secret', 'product']) {
    assert.ok(!slug.includes(leak), `slug leaks "${leak}"`);
  }
});

test('slugs are stable and case-insensitive across path spellings', () => {
  const a = projectSlug('C:\\Users\\me\\App');
  assert.equal(projectSlug('c:\\users\\me\\app'), a);
  assert.notEqual(projectSlug('C:\\Users\\me\\Other'), a);
});

test('a redacted index links by slug, never by path', () => {
  const html = renderIndex(
    [{ slug: 'p-deadbeef', label: 'p-deadbeef', bytes: 2048, overBudget: false }],
    true,
  );

  // An index whose body is clean while its anchors spell out client names has
  // redacted nothing.
  assert.match(html, /href="p-deadbeef\.html"/);
  assert.ok(!html.includes('clients'));
  assert.match(html, /filenames are hashed/);
});

test('an UNREDACTED index says so plainly', () => {
  const html = renderIndex(
    [{ slug: 'p-1', label: 'C:\\Users\\jane\\app', bytes: 100, overBudget: false }],
    false,
  );

  assert.match(html, /NOT redacted/);
});

test('the index escapes labels', () => {
  const html = renderIndex(
    [{ slug: 'p-1', label: '<img onerror=alert(1)>', bytes: 1, overBudget: false }],
    false,
  );

  assert.ok(!html.includes('<img onerror'));
  assert.match(html, /&lt;img onerror/);
});

// ---------------------------------------------------------------------------
// T3.15 📏 — one failure does not fail the run
// ---------------------------------------------------------------------------

test('a failing project becomes an error entry, not an exception', async (t) => {
  const dir = tempDir(t);
  const result = await writeProjectReport(dir, 'C:\\broken', new Error('unreadable .mcp.json'));

  // A sweep over 93 projects that aborts on the first bad one produces
  // nothing, which is strictly worse than 92 reports and a note.
  assert.equal(result.error, 'unreadable .mcp.json');
  assert.equal(result.bytes, 0);
  assert.deepEqual(readdirSync(dir), [], 'a failed project must not leave a partial file');
});

test('a successful project is written and measured', async (t) => {
  const dir = tempDir(t);
  const result = await writeProjectReport(dir, 'C:\\good', '<!doctype html><p>hi</p>');

  assert.equal(result.error, undefined);
  assert.ok(result.bytes > 0);
  assert.equal(result.overBudget, false);
  assert.deepEqual(readdirSync(dir), [`${projectSlug('C:\\good')}.html`]);
});

test('📏 an over-budget project file is flagged, not suppressed', async (t) => {
  const dir = tempDir(t);
  const huge = `<!doctype html>${'x'.repeat(121 * 1024)}`;
  const result = await writeProjectReport(dir, 'C:\\big', huge);

  // The per-file budget holds for every project file, not just the index —
  // and the user still gets the file.
  assert.equal(result.overBudget, true);
  assert.equal(readdirSync(dir).length, 1);
});

test('the index surfaces both errors and over-budget files', () => {
  const html = renderIndex(
    [
      { slug: 'p-1', label: 'p-1', bytes: 0, overBudget: false, error: 'unreadable' },
      { slug: 'p-2', label: 'p-2', bytes: 130 * 1024, overBudget: true },
    ],
    true,
  );

  assert.match(html, /unreadable/);
  assert.match(html, /over budget/);
});
