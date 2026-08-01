/**
 * 🔒 T5.27 / T5.28 / T5.30 — the import trust boundary.
 *
 * The attack this defends against is prompt injection: a bundle URL can
 * arrive inside a fetched page, an MCP tool result, a README or an issue
 * comment — text Claude reads and the user did not write. If Claude can act on
 * such a URL, anything Claude reads can install software.
 *
 * So the first test is the one that matters: **no input makes Claude able to
 * apply a remote bundle.** The rest narrows from there.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canApply,
  classifySource,
  EMPTY_TRUST_STORE,
  gistWarning,
  isTrusted,
  skillCapabilities,
} from '../../src/services/trust.ts';

const trusted = { hosts: ['github.com', 'internal.example.com'] };

// ---------------------------------------------------------------------------
// 🔒 T5.30 — the absolute rule
// ---------------------------------------------------------------------------

test('Claude can NEVER apply a remote bundle — no input changes this', () => {
  const sources = [
    'https://github.com/o/r/bundle.json',
    'owner/repo',
    'gist:abc123',
    'https://internal.example.com/b.json',
    '\\\\fileserver\\share\\b.json',
  ];

  // Every store, including one that trusts every host involved.
  for (const store of [EMPTY_TRUST_STORE, trusted, { hosts: ['*', 'github.com', 'fileserver'] }]) {
    for (const raw of sources) {
      const decision = canApply({ actor: 'claude', source: classifySource(raw), store });
      assert.equal(decision.allowed, false, `${raw} was applicable by Claude`);
      assert.match(decision.reason, /may not apply a remote bundle/);
    }
  }
});

test('the refusal explains the injection risk rather than just saying no', () => {
  const decision = canApply({
    actor: 'claude',
    source: classifySource('https://github.com/o/r.json'),
    store: trusted,
  });

  // A user who does not understand why will look for a flag to disable it.
  assert.match(decision.reason, /arbitrary code execution/);
  assert.match(decision.reason, /fetched page|MCP tool result|README/);
});

test('a skill is capable of dry-run and nothing else', () => {
  const caps = skillCapabilities();
  assert.equal(caps.dryRun, true);
  assert.equal(caps.apply, false);

  // Takes no options — an options bag is an invitation to add the escape
  // hatch later.
  assert.equal(skillCapabilities.length, 0);
});

// ---------------------------------------------------------------------------
// 🔒 T5.28 — the trust store narrows, it never widens
// ---------------------------------------------------------------------------

test('an untrusted host is dry-run only EVEN FOR A HUMAN', () => {
  const decision = canApply({
    actor: 'human',
    source: classifySource('https://random-host.example/b.json'),
    store: EMPTY_TRUST_STORE,
  });

  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /not in the trust store/);
});

test('a trusted host lets a HUMAN apply — and Claude still cannot', () => {
  const source = classifySource('https://github.com/o/r.json');

  const human = canApply({ actor: 'human', source, store: trusted });
  assert.equal(human.allowed, true);

  // The trust store is not a way for Claude to earn apply rights.
  assert.equal(canApply({ actor: 'claude', source, store: trusted }).allowed, false);
});

test('trust is never granted implicitly', () => {
  assert.deepEqual(EMPTY_TRUST_STORE.hosts, []);
  assert.equal(isTrusted(EMPTY_TRUST_STORE, classifySource('https://github.com/x')), false);
});

test('host matching is case-insensitive but not a substring match', () => {
  assert.equal(isTrusted(trusted, classifySource('https://GitHub.com/o/r')), true);
  // `evil-github.com` must not match `github.com`.
  assert.equal(isTrusted(trusted, classifySource('https://evil-github.com/o/r')), false);
  assert.equal(isTrusted(trusted, classifySource('https://github.com.evil.tld/o/r')), false);
});

// ---------------------------------------------------------------------------
// 🔒 T5.27 — confirmation, with no way to pre-answer it
// ---------------------------------------------------------------------------

test('a remote apply always requires interactive confirmation', () => {
  const decision = canApply({
    actor: 'human',
    source: classifySource('https://github.com/o/r.json'),
    store: trusted,
  });

  // "Trusted host" means the host is not the threat, not that the bundle is
  // harmless.
  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresConfirmation, true);
});

test('a local bundle needs no prompt — requiring one trains click-through', () => {
  const decision = canApply({
    actor: 'human',
    source: classifySource('C:/Users/me/bundle.json'),
    store: EMPTY_TRUST_STORE,
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresConfirmation, false);
});

test('canApply exposes NO option that skips confirmation', () => {
  // A confirmation an automated caller can pre-answer is not a confirmation.
  // The signature takes actor, source and store — there is no `yes`.
  const decision = canApply({
    actor: 'human',
    source: classifySource('https://github.com/o/r.json'),
    store: trusted,
    // eslint-disable-next-line no-undef
    yes: true,
    force: true,
    skipConfirm: true,
  });

  assert.equal(decision.requiresConfirmation, true, 'an unknown flag suppressed the prompt');
});

// ---------------------------------------------------------------------------
// Classification fails safe
// ---------------------------------------------------------------------------

test('every remote shape is classified remote', () => {
  for (const [raw, host] of [
    ['https://example.com/b.json', 'example.com'],
    ['http://example.com/b.json', 'example.com'],
    ['owner/repo', 'github.com'],
    ['gist:abc', 'gist.github.com'],
  ]) {
    const source = classifySource(raw);
    assert.equal(source.kind, 'remote', raw);
    assert.equal(source.host, host, raw);
  }
});

test('a UNC path is REMOTE — it reaches another machine', () => {
  // Misclassifying it as local would skip the confirmation entirely.
  assert.equal(classifySource('\\\\fileserver\\share\\b.json').kind, 'remote');
  assert.equal(classifySource('//fileserver/share/b.json').kind, 'remote');
});

test('userinfo in a URL does not disguise the host', () => {
  // `https://github.com@evil.tld/` — the real host is evil.tld.
  const source = classifySource('https://github.com@evil.tld/b.json');
  assert.equal(source.host, 'evil.tld');
  assert.equal(isTrusted(trusted, source), false);
});

test('local paths and file: URLs are local', () => {
  for (const raw of ['C:/Users/me/b.json', './b.json', '/home/me/b.json', 'file:///tmp/b.json']) {
    assert.equal(classifySource(raw).kind, 'local', raw);
  }
});

// ---------------------------------------------------------------------------
// 🔒 T5.31 — the gist warning
// ---------------------------------------------------------------------------

test('exporting to a gist warns that "secret" does not mean private', () => {
  const warning = gistWarning('gist:abc123');

  // Users routinely believe a secret gist is private. It is unlisted,
  // unauthenticated, and revisions survive deletion.
  assert.ok(warning);
  assert.match(warning, /UNLISTED, not private/);
  assert.match(warning, /after deletion/);
});

test('a non-gist target produces no warning', () => {
  assert.equal(gistWarning('https://example.com/b.json'), undefined);
  assert.equal(gistWarning('./bundle.json'), undefined);
});
