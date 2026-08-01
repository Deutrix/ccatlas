/**
 * T1.20 — argument parsing.
 *
 * `parseArgs` is pure, so the whole flag surface is exercised here without
 * spawning a binary. `tests/cli.test.mjs` covers the handful of behaviours
 * that only exist end to end (exit codes, actual stdout).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { colorDefault, COMMANDS, GLOBAL_FLAGS, helpText, parseArgs } from '../../src/cli/args.ts';

const run = (...argv) => parseArgs(argv);

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

test('a bare command parses with every flag defaulted off', () => {
  const parsed = run('status');
  assert.equal(parsed.kind, 'run');
  assert.equal(parsed.command, 'status');
  assert.deepEqual(parsed.flags, {
    json: false,
    cached: false,
    offline: false,
    color: true,
    verbose: false,
    flat: false,
    check: false,
    apply: false,
    redact: false,
    open: false,
    allProjects: false,
    allowPaths: false,
    unused: false,
  });
});

test('no arguments prints help rather than guessing a command', () => {
  assert.equal(run().kind, 'help');
});

test('an unknown command is an error naming the known ones', () => {
  const parsed = run('stauts');
  assert.equal(parsed.kind, 'error');
  assert.match(parsed.errors[0], /unknown command "stauts"/);
  for (const command of COMMANDS) assert.match(parsed.errors[0], new RegExp(command));
});

test('a second positional is an error, not a silently ignored argument', () => {
  const parsed = run('status', 'extra');
  assert.equal(parsed.kind, 'error');
  assert.match(parsed.errors[0], /unexpected argument "extra"/);
});

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

test('every documented global flag parses', () => {
  const parsed = run('status', '--json', '--cached', '--offline', '--no-color', '--verbose');
  assert.equal(parsed.kind, 'run');
  assert.equal(parsed.flags.json, true);
  assert.equal(parsed.flags.cached, true);
  assert.equal(parsed.flags.offline, true);
  assert.equal(parsed.flags.color, false);
  assert.equal(parsed.flags.verbose, true);
});

test('the help text documents exactly the flags the parser accepts', () => {
  const text = helpText('9.9.9');
  // A flag the parser takes but help omits is undiscoverable; one help
  // promises but the parser rejects is worse.
  for (const { flag } of GLOBAL_FLAGS) {
    assert.ok(text.includes(flag), `help omits ${flag}`);
    assert.equal(run('status', flag).kind, 'run', `parser rejects documented ${flag}`);
  }
});

test('flags may precede the command', () => {
  const parsed = run('--verbose', 'status');
  assert.equal(parsed.kind, 'run');
  assert.equal(parsed.flags.verbose, true);
});

test('--json forces colour off — JSON is parsed, not read', () => {
  const parsed = parseArgs(['status', '--json'], { colorDefault: true });
  assert.equal(parsed.flags.color, false);
});

test('--json with --flat is an error rather than a silent precedence', () => {
  const parsed = run('status', '--json', '--flat');
  assert.equal(parsed.kind, 'error');
  assert.match(parsed.errors[0], /--flat/);
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

test('EVERY unknown flag is reported, not just the first', () => {
  const parsed = run('status', '--nope', '--also-nope');
  assert.equal(parsed.kind, 'error');
  assert.equal(parsed.errors.length, 2, 'a user who mistyped twice should learn both now');
});

test('a near-miss flag gets a prefix-based suggestion', () => {
  const parsed = run('status', '--cach');
  assert.match(parsed.errors[0], /Did you mean --cached/);
});

test('a flag with no near match gets no invented suggestion', () => {
  const parsed = run('status', '--wildly-unrelated');
  // A wrong suggestion costs more than none: fuzzy distance would propose
  // --json for both --jsom and --jason.
  assert.ok(!parsed.errors[0].includes('Did you mean'));
});

test('--help wins over parse errors — that user is the one who needs it', () => {
  assert.equal(run('status', '--nonsense', '--help').kind, 'help');
});

test('--version wins over everything, including --help', () => {
  assert.equal(run('status', '--help', '--version').kind, 'version');
});

test('a bare "-" is treated as a positional, not a flag', () => {
  const parsed = run('-');
  assert.equal(parsed.kind, 'error');
  assert.match(parsed.errors[0], /unknown command/);
});

// ---------------------------------------------------------------------------
// Colour defaulting — reads the environment, so it lives outside the parser
// ---------------------------------------------------------------------------

test('a non-TTY defaults to no colour', () => {
  // `ccatlas status > report.txt` embedding escape codes is the failure people
  // hit long before they find --no-color.
  assert.equal(colorDefault({}, false), false);
  assert.equal(colorDefault({}, true), true);
});

test('NO_COLOR wins over FORCE_COLOR and over the TTY', () => {
  // NO_COLOR is what a user sets to protect a pipeline; it must not be
  // overridable by an inherited FORCE_COLOR.
  assert.equal(colorDefault({ NO_COLOR: '1', FORCE_COLOR: '1' }, true), false);
  assert.equal(colorDefault({ NO_COLOR: '1' }, true), false);
});

test('FORCE_COLOR turns colour on for a non-TTY', () => {
  assert.equal(colorDefault({ FORCE_COLOR: '1' }, false), true);
});

test('an EMPTY NO_COLOR is not set — the spec says presence, not truthiness', () => {
  assert.equal(colorDefault({ NO_COLOR: '' }, true), true);
});

test('an explicit --no-color beats an environment that wanted colour', () => {
  const parsed = parseArgs(['status', '--no-color'], { colorDefault: true });
  assert.equal(parsed.flags.color, false);
});

test('an explicit --color beats an environment that wanted none', () => {
  const parsed = parseArgs(['status', '--color'], { colorDefault: false });
  assert.equal(parsed.flags.color, true);
});

// ---------------------------------------------------------------------------
// --project — the scope axis reaches the surface
// ---------------------------------------------------------------------------

test('--project takes the next argument as its value', () => {
  const parsed = run('status', '--project', 'C:/repo');
  assert.equal(parsed.kind, 'run');
  assert.equal(parsed.flags.project, 'C:/repo');
});

test('--project=value works too', () => {
  assert.equal(run('status', '--project=C:/repo').flags.project, 'C:/repo');
});

test('a --project VALUE is never mistaken for a command', () => {
  // `--project .` would otherwise be reported as an unknown command, which is
  // the failure mode of parsing value-taking flags in the same pass as
  // positionals.
  const parsed = run('status', '--project', '.');
  assert.equal(parsed.kind, 'run');
  assert.equal(parsed.flags.project, '.');
});

test('--project with no value is a usage error, not a silent global run', () => {
  for (const argv of [['status', '--project'], ['status', '--project', '--json']]) {
    const parsed = parseArgs(argv);
    assert.equal(parsed.kind, 'error', argv.join(' '));
    assert.match(parsed.errors[0], /--project needs a directory path/);
  }
});

test('no --project means the global baseline', () => {
  assert.equal(run('status').flags.project, undefined);
});

test('--project still parses when it precedes the command', () => {
  const parsed = run('--project', 'C:/repo', 'doctor');
  assert.equal(parsed.kind, 'run');
  assert.equal(parsed.command, 'doctor');
  assert.equal(parsed.flags.project, 'C:/repo');
});

test('doctor is a known command', () => {
  assert.equal(run('doctor').kind, 'run');
  assert.equal(run('doctor').command, 'doctor');
});

// ---------------------------------------------------------------------------
// --check and --apply
// ---------------------------------------------------------------------------

test('--check and --apply parse on updates', () => {
  assert.equal(run('updates', '--check').flags.check, true);
  assert.equal(run('updates', '--apply').flags.apply, true);
});

test('--check with --apply is a contradiction, not a precedence', () => {
  const parsed = run('updates', '--check', '--apply');
  assert.equal(parsed.kind, 'error');
  assert.match(parsed.errors[0], /Pick one/);
});

test('--check and --apply are rejected on commands that do not have them', () => {
  for (const command of ['status', 'doctor']) {
    const parsed = parseArgs([command, '--check']);
    assert.equal(parsed.kind, 'error', command);
    assert.match(parsed.errors[0], /applies to `updates`/);
  }
});

test('updates is a known command', () => {
  assert.equal(run('updates').kind, 'run');
  assert.equal(run('updates').command, 'updates');
});
