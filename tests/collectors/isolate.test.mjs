/**
 * T1.5 — collector error-isolation harness.
 *
 * Plain .mjs, no test framework, matching tests/cli.test.mjs: the
 * zero-runtime-dependency posture holds in the test path too. The module under
 * test is TypeScript, imported directly by its `.ts` specifier — Node strips
 * types on import. See the header of src/collectors/isolate.ts for why that
 * import can never pull a project file in at runtime.
 *
 * Every stub collector below is defined here on purpose. The harness must be
 * provable without any real collector existing, because its whole job is to
 * survive collectors that do not behave.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_COLLECTOR_TIMEOUT_MS,
  aggregate,
  runCollector,
  runCollectors,
} from '../../src/collectors/isolate.ts';

const CTX = Object.freeze({ offline: true, fixtureRoot: '/fixtures' });

/** A collector that returns a normal, populated result. */
function succeeding(name, data, warnings = []) {
  return {
    name,
    async collect() {
      return { ok: true, data, warnings, elapsedMs: 0 };
    },
  };
}

/** A collector that succeeds and legitimately found nothing. */
function empty(name) {
  return succeeding(name, []);
}

/** A collector whose returned promise rejects. */
function rejecting(name, error) {
  return {
    name,
    async collect() {
      throw error;
    },
  };
}

/** A collector that throws before it ever returns a promise. */
function throwingSynchronously(name, thrown) {
  return {
    name,
    collect() {
      throw thrown;
    },
  };
}

/** A collector that reports its own failure as a value, per the contract. */
function reportingFailure(name, error, warnings = []) {
  return {
    name,
    async collect() {
      return { ok: false, data: null, warnings, error, elapsedMs: 0 };
    },
  };
}

/**
 * A collector that never settles. Deliberately timer-free: a pending timer
 * would hold the event loop open and turn a harness bug into a hung test run
 * rather than a failed assertion.
 */
function hanging(name) {
  return {
    name,
    collect() {
      return new Promise(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// The guarantee: a failure is a value, never a throw
// ---------------------------------------------------------------------------

test('a rejected promise becomes a failed outcome, not a thrown error', async () => {
  const outcome = await runCollector(rejecting('cli', new Error('claude CLI not found')), CTX);

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.data, null);
  assert.equal(outcome.mode, 'rejected');
  assert.match(outcome.error.message, /claude CLI not found/);
});

test('a synchronous throw becomes a failed outcome', async () => {
  const outcome = await runCollector(
    throwingSynchronously('config', new Error('boom before the promise')),
    CTX,
  );

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.mode, 'threw');
  assert.match(outcome.error.message, /boom before the promise/);
});

test('non-Error throws are described rather than crashing the harness', async () => {
  const thrown = [
    ['a string', 'just a string'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a plain object', { detail: 'structured' }],
  ];

  for (const [label, value] of thrown) {
    const outcome = await runCollector(rejecting('mcp', value), CTX);
    assert.equal(outcome.status, 'failed', `${label} should fail cleanly`);
    assert.equal(typeof outcome.error.message, 'string', `${label} needs a string message`);
    assert.notEqual(outcome.error.message, '', `${label} needs a non-empty message`);
  }
});

test('a circular non-Error throw does not break the describer', async () => {
  const circular = { name: 'loop' };
  circular.self = circular;

  const outcome = await runCollector(throwingSynchronously('skills', circular), CTX);

  assert.equal(outcome.status, 'failed');
  assert.equal(typeof outcome.error.message, 'string');
  assert.notEqual(outcome.error.message, '');
});

test('runCollector never rejects, whatever the collector does', async () => {
  const misbehaving = [
    rejecting('cli', new Error('x')),
    throwingSynchronously('cli', null),
    { name: 'cli' }, // no collect at all
    { name: 'cli', collect: () => undefined },
    { name: 'cli', collect: () => 'not a result' },
  ];

  for (const collector of misbehaving) {
    await assert.doesNotReject(() => runCollector(collector, CTX));
  }
});

test('a collector that is not shaped like a collector fails as invalid-result', async () => {
  const noCollect = await runCollector({ name: 'cli' }, CTX);
  assert.equal(noCollect.mode, 'invalid-result');

  const returnsNothing = await runCollector({ name: 'cli', collect: () => undefined }, CTX);
  assert.equal(returnsNothing.mode, 'invalid-result');

  const returnsGarbage = await runCollector({ name: 'cli', collect: async () => 7 }, CTX);
  assert.equal(returnsGarbage.mode, 'invalid-result');

  const noOkFlag = await runCollector({ name: 'cli', collect: async () => ({ data: [] }) }, CTX);
  assert.equal(noOkFlag.mode, 'invalid-result');
});

test('a self-reported {ok:false} is preserved, including the collector own error code', async () => {
  const outcome = await runCollector(
    reportingFailure('config', { code: 'ENOENT', message: 'settings.json is unreadable' }),
    CTX,
  );

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.mode, 'reported');
  assert.equal(outcome.error.code, 'ENOENT');
  assert.match(outcome.error.message, /settings\.json/);
});

test('{ok:false} with no error object still yields a usable reason', async () => {
  const outcome = await runCollector(
    { name: 'config', collect: async () => ({ ok: false, data: null, warnings: [] }) },
    CTX,
  );

  assert.equal(outcome.status, 'failed');
  assert.equal(typeof outcome.error.code, 'string');
  assert.notEqual(outcome.error.message, '');
});

// ---------------------------------------------------------------------------
// Empty is not failed — the whole point
// ---------------------------------------------------------------------------

test('an empty-but-valid result is a success, distinguishable from a failure', async () => {
  const nothingFound = await runCollector(empty('skills'), CTX);
  const brokeTrying = await runCollector(rejecting('skills', new Error('parser died')), CTX);

  // Both sections render as zero rows. Only one of them means "you have none".
  assert.deepEqual(nothingFound.data, []);
  assert.equal(brokeTrying.data, null);

  assert.equal(nothingFound.status, 'ok');
  assert.equal(brokeTrying.status, 'failed');
  assert.equal(nothingFound.ok, true);
  assert.equal(brokeTrying.ok, false);

  // The discriminator must not be derivable from the payload alone: emptiness
  // is what the two have in common, so anything reading only `data` conflates
  // "nothing installed" with "the collector broke" and recommends pruning a
  // working stack.
  assert.notEqual(nothingFound.status, brokeTrying.status);
  assert.equal('error' in nothingFound, false);
  assert.equal('mode' in nothingFound, false);
  assert.equal(typeof brokeTrying.error.message, 'string');
});

test('{ok:true, data:null} stays a success — null is a collector legitimate answer', async () => {
  const outcome = await runCollector(succeeding('config', null), CTX);

  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.data, null);
});

test('the report separates failed sections from empty ones by name', async () => {
  const report = await runCollectors(
    [empty('skills'), rejecting('mcp', new Error('timeout talking to servers')), succeeding('cli', ['a'])],
    CTX,
  );

  assert.deepEqual(report.failed, ['mcp']);
  assert.equal(report.ok, false);

  const skills = report.outcomes.find((o) => o.name === 'skills');
  const mcp = report.outcomes.find((o) => o.name === 'mcp');
  assert.equal(skills.status, 'ok');
  assert.equal(mcp.status, 'failed');
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

test('a hung collector times out with a stated reason instead of stalling the run', async () => {
  const started = Date.now();
  const outcome = await runCollector(hanging('mcp'), CTX, { timeoutMs: 40 });
  const wall = Date.now() - started;

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.mode, 'timeout');
  assert.equal(outcome.data, null);
  assert.match(outcome.error.message, /40/);
  assert.match(outcome.error.message, /timed out|exceeded/i);
  assert.ok(wall < 5000, `timeout must not wait for the default budget (waited ${wall}ms)`);
});

test('a hung collector does not stop the others from being reported', async () => {
  const report = await runCollectors(
    [hanging('mcp'), succeeding('cli', ['plugin-a']), empty('skills')],
    CTX,
    { timeoutMs: 40 },
  );

  assert.deepEqual(report.failed, ['mcp']);
  assert.deepEqual(
    report.outcomes.find((o) => o.name === 'cli').data,
    ['plugin-a'],
  );
  assert.equal(report.outcomes.find((o) => o.name === 'skills').status, 'ok');
});

test('the default timeout leaves room for the ~40s claude mcp list health check', () => {
  assert.equal(typeof DEFAULT_COLLECTOR_TIMEOUT_MS, 'number');
  assert.ok(
    DEFAULT_COLLECTOR_TIMEOUT_MS > 40_000,
    'a default below the observed 40s mcp health check would time out a working machine',
  );
});

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

test('every outcome records elapsedMs, measured by the harness', async () => {
  const slow = {
    name: 'cli',
    async collect() {
      await new Promise((resolve) => setTimeout(resolve, 25));
      // A collector lying about its own timing must not win over the harness.
      return { ok: true, data: 'x', warnings: [], elapsedMs: 999_999 };
    },
  };

  const report = await runCollectors([slow, empty('skills')], CTX);

  for (const outcome of report.outcomes) {
    assert.equal(typeof outcome.elapsedMs, 'number');
    assert.ok(Number.isFinite(outcome.elapsedMs));
    assert.ok(outcome.elapsedMs >= 0);
  }

  const cli = report.outcomes.find((o) => o.name === 'cli');
  assert.ok(cli.elapsedMs >= 20, `expected ~25ms, got ${cli.elapsedMs}`);
  assert.ok(cli.elapsedMs < 999_999, 'the harness measurement must replace the self-reported one');

  assert.equal(typeof report.elapsedMs, 'number');
  assert.ok(report.elapsedMs >= 0);
});

test('a timed-out collector still records elapsedMs', async () => {
  const outcome = await runCollector(hanging('mcp'), CTX, { timeoutMs: 40 });

  assert.ok(outcome.elapsedMs >= 30, `expected roughly the 40ms budget, got ${outcome.elapsedMs}`);
});

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

test('warnings from every collector aggregate into one list, tagged with their origin', async () => {
  const report = await runCollectors(
    [
      succeeding('cli', ['a'], [{ code: 'unverified-estimate', message: 'fallback tokenizer' }]),
      succeeding('config', {}, [{ code: 'path-collision', message: 'two keys, one path', subject: 'c:/p' }]),
      empty('skills'),
    ],
    CTX,
  );

  assert.equal(report.ok, true);
  assert.equal(report.warnings.length, 2);

  const estimate = report.warnings.find((w) => w.code === 'unverified-estimate');
  assert.equal(estimate.collector, 'cli');
  assert.equal(estimate.message, 'fallback tokenizer');

  const collision = report.warnings.find((w) => w.code === 'path-collision');
  assert.equal(collision.collector, 'config');
  assert.equal(collision.subject, 'c:/p', 'tagging must not clobber the warning own subject');
});

test('a failure contributes a collector-failed warning naming the section', async () => {
  const report = await runCollectors([rejecting('mcp', new Error('socket closed')), empty('cli')], CTX);

  const failed = report.warnings.filter((w) => w.code === 'collector-failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].collector, 'mcp');
  assert.equal(failed[0].subject, 'mcp');
  assert.match(failed[0].message, /socket closed/);

  // The same warning must be visible on the outcome itself, so a surface that
  // renders one section in isolation still says why it is empty.
  const outcome = report.outcomes.find((o) => o.name === 'mcp');
  assert.ok(outcome.warnings.some((w) => w.code === 'collector-failed'));
});

test('a collector that already warned about its own failure is not double-counted', async () => {
  const report = await runCollectors(
    [
      reportingFailure(
        'config',
        { code: 'EACCES', message: 'permission denied' },
        [{ code: 'collector-failed', message: 'config collector could not read settings', subject: 'config' }],
      ),
    ],
    CTX,
  );

  assert.equal(report.warnings.filter((w) => w.code === 'collector-failed').length, 1);
});

test('a partial warning reaches the caller with nothing flattened', async () => {
  const report = await runCollectors(
    [
      succeeding('mcp', ['server-a'], [
        { code: 'partial', message: '.mcp.json unreadable; user scope only', subject: 'project' },
      ]),
    ],
    CTX,
  );

  assert.equal(report.warnings.length, 1);
  assert.deepEqual(report.warnings[0], {
    code: 'partial',
    message: '.mcp.json unreadable; user scope only',
    subject: 'project',
    collector: 'mcp',
  });
});

test('a knowingly incomplete section is named in report.partial and still succeeds', async () => {
  const report = await runCollectors(
    [
      succeeding('mcp', ['server-a'], [{ code: 'partial', message: 'one scope was unreadable' }]),
      succeeding('cli', ['plugin-a']),
    ],
    CTX,
  );

  // "Fine as far as it goes" is not failure: the run is ok and the data flows.
  assert.equal(report.ok, true);
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.outcomes.find((o) => o.name === 'mcp').data, ['server-a']);

  // But a caller checking only `ok` would call the section complete, so the
  // incompleteness gets the same top-level surface `failed` has.
  assert.deepEqual(report.partial, ['mcp']);
});

test('partial and failed are separate states, not degrees of the same one', async () => {
  const report = await runCollectors(
    [
      succeeding('mcp', ['server-a'], [{ code: 'partial', message: 'project scope skipped' }]),
      rejecting('skills', new Error('frontmatter parser died')),
      empty('cli'),
    ],
    CTX,
  );

  assert.deepEqual(report.partial, ['mcp']);
  assert.deepEqual(report.failed, ['skills']);
  assert.equal(report.ok, false, 'a real failure still sinks the run');

  // A failed section is degraded, not "incomplete" — its data is absent
  // entirely, so listing it as partial would understate the damage.
  assert.equal(report.partial.includes('skills'), false);
  assert.equal(report.failed.includes('mcp'), false);
  assert.equal(report.partial.includes('cli'), false, 'empty is complete, not partial');
});

test('a section is named once however many partial warnings it emits', async () => {
  const report = await runCollectors(
    [
      succeeding('mcp', [], [
        { code: 'partial', message: 'project scope unreadable' },
        { code: 'partial', message: 'local scope unreadable' },
      ]),
    ],
    CTX,
  );

  assert.deepEqual(report.partial, ['mcp']);
  assert.equal(report.warnings.length, 2, 'both reasons must still be reported');
});

test('aggregate reports partial sections too, on the typed path', async () => {
  const outcomes = await Promise.all([
    runCollector(succeeding('mcp', [], [{ code: 'partial', message: 'incomplete' }]), CTX),
    runCollector(empty('cli'), CTX),
  ]);

  const report = aggregate(outcomes);

  assert.equal(report.ok, true);
  assert.deepEqual(report.partial, ['mcp']);
});

test('warnings survive a collector that returns a malformed warnings field', async () => {
  const outcome = await runCollector(
    { name: 'cli', collect: async () => ({ ok: true, data: [], warnings: 'nope' }) },
    CTX,
  );

  assert.equal(outcome.status, 'ok');
  assert.ok(Array.isArray(outcome.warnings));
});

// ---------------------------------------------------------------------------
// Concurrency, ordering, and context
// ---------------------------------------------------------------------------

test('collectors run concurrently, not one after another', async () => {
  const total = 4;
  let started = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const observed = [];
  const collectors = Array.from({ length: total }, (_, i) => ({
    name: `c${i}`,
    async collect() {
      started += 1;
      if (started === total) release();
      await gate;
      observed.push(started);
      return { ok: true, data: i, warnings: [], elapsedMs: 0 };
    },
  }));

  // A serialised implementation deadlocks on the gate; the short budget turns
  // that into a failed assertion within ~200ms rather than a hung suite.
  const report = await runCollectors(collectors, CTX, { timeoutMs: 200 });

  assert.deepEqual(report.failed, [], 'a serialised run would time out on the gate');
  assert.deepEqual(observed, Array(total).fill(total));
});

test('outcomes come back in the order the collectors were given', async () => {
  const report = await runCollectors(
    [
      { name: 'slow', collect: async () => { await new Promise((r) => setTimeout(r, 30)); return { ok: true, data: 1, warnings: [], elapsedMs: 0 }; } },
      succeeding('fast', 2),
      rejecting('broken', new Error('nope')),
    ],
    CTX,
  );

  assert.deepEqual(report.outcomes.map((o) => o.name), ['slow', 'fast', 'broken']);
});

test('the collect context is passed through untouched', async () => {
  const seen = [];
  const spy = (name) => ({
    name,
    async collect(ctx) {
      seen.push(ctx);
      return { ok: true, data: null, warnings: [], elapsedMs: 0 };
    },
  });

  await runCollectors([spy('cli'), spy('config')], CTX);

  assert.equal(seen.length, 2);
  for (const ctx of seen) {
    // Identity, not deep equality: a harness that clones ctx could drop
    // fixtureRoot and send every collector at the real machine.
    assert.equal(ctx, CTX);
  }
});

test('an empty collector list is a valid, successful run', async () => {
  const report = await runCollectors([], CTX);

  assert.equal(report.ok, true);
  assert.deepEqual(report.outcomes, []);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.failed, []);
});

// ---------------------------------------------------------------------------
// aggregate() on its own — the typed path
// ---------------------------------------------------------------------------

test('aggregate builds the same report from outcomes collected separately', async () => {
  const outcomes = await Promise.all([
    runCollector(succeeding('cli', ['a'], [{ code: 'shadowed', message: 'two of them' }]), CTX),
    runCollector(rejecting('mcp', new Error('down')), CTX),
    runCollector(empty('skills'), CTX),
  ]);

  const report = aggregate(outcomes);

  assert.equal(report.ok, false);
  assert.deepEqual(report.failed, ['mcp']);
  assert.deepEqual(report.warnings.map((w) => w.collector), ['cli', 'mcp']);
  assert.equal(report.outcomes.length, 3);
  assert.ok(report.elapsedMs >= 0);
});
