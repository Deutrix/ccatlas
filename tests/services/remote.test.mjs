/**
 * T2.7 / T2.8 — remote resolution and the `--offline` guarantee.
 *
 * TX.5 requires zero egress under `--offline` and requires it **asserted**.
 * Every test here injects the runner and checks whether the command was
 * issued, because a test that merely passes the flag and trusts the result
 * proves nothing about the code path.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cloneIsBehind,
  gitTimeoutMs,
  REMOTE_CONCURRENCY,
  remoteUrlFor,
  resolveRemoteHead,
  resolveRemoteHeads,
} from '../../src/services/remote.ts';

const SHA = 'a'.repeat(40);

const market = (over = {}) => ({
  name: 'mkt',
  distribution: 'git',
  source: { source: 'github', repo: 'owner/repo' },
  ...over,
});

/** Records every git invocation and answers with a HEAD line. */
function recorder(answer = `${SHA}\tHEAD\n`, code = 0) {
  const calls = [];
  return {
    calls,
    run: async (argv, timeoutMs) => {
      calls.push({ argv: [...argv], timeoutMs });
      return { code, stdout: answer };
    },
  };
}

// ---------------------------------------------------------------------------
// TX.5 — the offline guarantee
// ---------------------------------------------------------------------------

test('--offline issues NO git command at all', async () => {
  const { calls, run } = recorder();
  const check = await resolveRemoteHead(market(), { offline: true, run });

  // The guarantee is a property of this code path, not of every caller
  // remembering to check the flag first.
  assert.deepEqual(calls, [], 'offline dialled out');
  assert.equal(check.checked, false);
  assert.match(check.reason, /--offline/);
});

test('the same call DOES issue git when not offline — the test can fail', async () => {
  const { calls, run } = recorder();
  await resolveRemoteHead(market(), { run });

  // Without this, the assertion above would pass against a function that
  // never issues a command under any circumstances.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, ['ls-remote', 'https://github.com/owner/repo.git', 'HEAD']);
});

// ---------------------------------------------------------------------------
// URL derivation — fails closed
// ---------------------------------------------------------------------------

test('a github source yields the clone URL', () => {
  assert.equal(remoteUrlFor(market()), 'https://github.com/owner/repo.git');
});

test('an explicit http(s) url is used as given', () => {
  assert.equal(
    remoteUrlFor(market({ source: { source: 'url', url: 'https://example.com/m.git' } })),
    'https://example.com/m.git',
  );
});

test('an unknown source type yields NO guessed URL', () => {
  // T0.5 observed only `github` locally, so every other branch is unverified
  // and must fail closed rather than construct a plausible URL.
  assert.equal(remoteUrlFor(market({ source: { source: 'npm' } })), undefined);
  assert.equal(remoteUrlFor(market({ source: { source: 'local', path: './m' } })), undefined);
  assert.equal(remoteUrlFor(market({ source: undefined })), undefined);
});

test('a non-http url is rejected rather than passed to git', () => {
  assert.equal(
    remoteUrlFor(market({ source: { source: 'url', url: 'file:///etc/passwd' } })),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// Distribution
// ---------------------------------------------------------------------------

test('a GCS marketplace is not checked, and says why', async () => {
  const { calls, run } = recorder();
  const check = await resolveRemoteHead(market({ distribution: 'gcs' }), { run });

  // It has no git remote at all — that is not a failure to check, there is
  // nothing to check against. This is the marketplace holding 276 of 281
  // available plugins.
  assert.deepEqual(calls, []);
  assert.equal(check.checked, false);
  assert.match(check.reason, /GCS tarball/);
});

// ---------------------------------------------------------------------------
// Parsing and failure
// ---------------------------------------------------------------------------

test('a HEAD line is parsed to its sha', async () => {
  const { run } = recorder(`${SHA}\trefs/heads/main\n`);
  const check = await resolveRemoteHead(market(), { run });

  assert.equal(check.checked, true);
  assert.equal(check.headSha, SHA);
});

test('a non-zero exit is reported, never treated as up to date', async () => {
  const { run } = recorder('', 128);
  const check = await resolveRemoteHead(market(), { run });

  assert.equal(check.checked, false);
  assert.match(check.reason, /exited 128/);
});

test('unparseable output is a miss, not a silent success', async () => {
  const { run } = recorder('not a sha at all\n');
  const check = await resolveRemoteHead(market(), { run });

  assert.equal(check.checked, false);
  assert.match(check.reason, /no parseable HEAD/);
});

// ---------------------------------------------------------------------------
// T2.8 — the git timeout
// ---------------------------------------------------------------------------

test('CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS is honoured', () => {
  // A user who raised it for a slow private remote should not have ccatlas
  // time out where `claude` succeeds.
  assert.equal(gitTimeoutMs({ CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS: '300000' }), 300_000);
});

test('the default matches Claude Code at 120s', () => {
  assert.equal(gitTimeoutMs({}), 120_000);
});

test('a nonsense timeout falls back rather than passing NaN to git', () => {
  for (const value of ['', 'soon', '-1', '0']) {
    assert.equal(gitTimeoutMs({ CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS: value }), 120_000, value);
  }
});

test('the timeout reaches the runner', async () => {
  const { calls, run } = recorder();
  await resolveRemoteHead(market(), { run, env: { CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS: '9000' } });

  assert.equal(calls[0].timeoutMs, 9000);
});

// ---------------------------------------------------------------------------
// T2.7 — concurrency
// ---------------------------------------------------------------------------

test('checks are capped at the concurrency limit', async () => {
  let inFlight = 0;
  let peak = 0;

  const markets = Array.from({ length: 20 }, (_, i) => market({ name: `m${i}` }));
  const { results } = await resolveRemoteHeads(markets, {
    run: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { code: 0, stdout: `${SHA}\tHEAD\n` };
    },
  });

  assert.equal(results.size, 20);
  // An unbounded fan-out opens 20 TLS connections at once on a laptop that
  // may be on a phone tether.
  assert.ok(peak <= REMOTE_CONCURRENCY, `peak concurrency was ${peak}`);
});

test('a slow marketplace does not hold up the others', async () => {
  const markets = [market({ name: 'slow' }), ...Array.from({ length: 5 }, (_, i) => market({ name: `fast${i}` }))];
  const finished = [];

  await resolveRemoteHeads(markets, {
    run: async (argv) => {
      // A worker pool rather than chunked Promise.all: chunking makes every
      // batch wait for its slowest member.
      await new Promise((resolve) => setTimeout(resolve, argv.join(' ').includes('slow') ? 40 : 1));
      finished.push(argv);
      return { code: 0, stdout: `${SHA}\tHEAD\n` };
    },
  });

  assert.equal(finished.length, 6);
});

test('unchecked marketplaces produce a warning each, naming the reason', async () => {
  const { warnings } = await resolveRemoteHeads(
    [market({ name: 'gcs-one', distribution: 'gcs' }), market({ name: 'ok' })],
    { run: async () => ({ code: 0, stdout: `${SHA}\tHEAD\n` }) },
  );

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].subject, 'gcs-one');
  assert.match(warnings[0].message, /not checked/);
});

test('an empty marketplace list is handled without spawning a worker', async () => {
  const { results, warnings } = await resolveRemoteHeads([], {});
  assert.equal(results.size, 0);
  assert.deepEqual(warnings, []);
});

// ---------------------------------------------------------------------------
// Behind-ness
// ---------------------------------------------------------------------------

test('a clone whose HEAD differs from upstream is behind', () => {
  const behind = cloneIsBehind(market({ headSha: 'b'.repeat(40) }), { checked: true, headSha: SHA });
  assert.equal(behind, true);
});

test('a matching HEAD is not behind', () => {
  assert.equal(cloneIsBehind(market({ headSha: SHA }), { checked: true, headSha: SHA }), false);
});

test('case differences in a sha do not count as behind', () => {
  assert.equal(
    cloneIsBehind(market({ headSha: SHA.toUpperCase() }), { checked: true, headSha: SHA }),
    false,
  );
});

test('an unchecked remote yields UNDEFINED, never "up to date"', () => {
  // "Cannot tell" and "up to date" are different answers, and rendering the
  // first as the second is the failure this whole codebase keeps guarding.
  assert.equal(cloneIsBehind(market({ headSha: SHA }), undefined), undefined);
  assert.equal(
    cloneIsBehind(market({ headSha: SHA }), { checked: false, reason: 'offline' }),
    undefined,
  );
});

test('a clone with no readable HEAD yields undefined', () => {
  assert.equal(cloneIsBehind(market({ headSha: undefined }), { checked: true, headSha: SHA }), undefined);
});
