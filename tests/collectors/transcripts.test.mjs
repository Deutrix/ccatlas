/**
 * T4.1 ⛔ — the quarantined transcript adapter.
 *
 * The probe is the safety mechanism, and the assertion that matters most is
 * `Array.isArray(message.content)`: every signal lives inside that array, so a
 * changed shape there would let a coarser probe pass while extraction silently
 * returns zero — and a zero reads as *you used nothing, prune everything*.
 *
 * Signal tests run against the committed exemplars, which are real redacted
 * records, not hand-written shapes.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CLI_BUILTIN_COMMANDS,
  enumerateTranscripts,
  extractSignals,
  parseCommandName,
  parseMcpToolName,
  probeAssistantRecord,
  scanTranscript,
} from '../../src/collectors/transcripts.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const signals = path.join(repoRoot, 'fixtures', 'transcripts', 'signals');

const exemplar = (kind, file) =>
  JSON.parse(readFileSync(path.join(signals, kind, file), 'utf8'));

const KNOWN = new Set(['everything-claude-code', 'figma', 'superpowers']);

function tempTree(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ccatlas-transcripts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const writeJsonl = (file, records) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
};

const assistant = (over = {}) => ({
  type: 'assistant',
  uuid: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
  timestamp: '2026-07-15T17:33:34.311Z',
  isSidechain: false,
  cwd: 'C:/repo',
  version: '2.1.220',
  message: { role: 'assistant', content: [] },
  ...over,
});

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

test('a real assistant record passes the probe', () => {
  assert.deepEqual(probeAssistantRecord(exemplar('skill', '01.json')), { available: true });
});

test('a STRING message.content fails the probe — the load-bearing assertion', () => {
  const result = probeAssistantRecord(assistant({ message: { content: 'now a string' } }));

  // Every signal lives inside that array. A coarser probe would pass here,
  // extraction would return zero, and the report would say "you used nothing,
  // prune everything" — a confidently wrong recommendation that deletes
  // working configuration.
  assert.equal(result.available, false);
  assert.match(result.reason, /silently yield zero invocations/);
});

test('an epoch timestamp fails the probe', () => {
  // `ts` is a parsed ISO-8601 string, never a native int. A numeric timestamp
  // means the envelope changed.
  const result = probeAssistantRecord(assistant({ timestamp: 1_754_000_000_000 }));
  assert.equal(result.available, false);
  assert.match(result.reason, /must not be an epoch int/);
});

test('every required envelope field is checked', () => {
  for (const [field, bad] of [
    ['uuid', 42],
    ['sessionId', null],
    ['isSidechain', 'false'],
  ]) {
    const result = probeAssistantRecord(assistant({ [field]: bad }));
    assert.equal(result.available, false, field);
  }
});

test('the probe rejects a non-assistant record rather than blessing it', () => {
  assert.equal(probeAssistantRecord({ type: 'user' }).available, false);
  assert.equal(probeAssistantRecord(null).available, false);
});

// ---------------------------------------------------------------------------
// MCP tool names — two forms, parsed distinctly
// ---------------------------------------------------------------------------

test('a user-scope MCP tool splits into server and tool', () => {
  assert.deepEqual(parseMcpToolName('mcp__laravel-boost__database-query'), {
    server: 'laravel-boost',
    tool: 'database-query',
  });
});

test('a plugin-scoped tool resolves the plugin against the known list', () => {
  // The plugin↔server boundary is a SINGLE `_`, and both names may contain
  // `_` and `-`. Guessing at the first `_` yields plugin `everything` and
  // server `claude-code_playwright`.
  assert.deepEqual(
    parseMcpToolName('mcp__plugin_everything-claude-code_playwright__browser_navigate', KNOWN),
    { plugin: 'everything-claude-code', server: 'playwright', tool: 'browser_navigate' },
  );
});

test('a plugin whose name equals the server name still resolves', () => {
  assert.deepEqual(parseMcpToolName('mcp__plugin_figma_figma__authenticate', KNOWN), {
    plugin: 'figma',
    server: 'figma',
    tool: 'authenticate',
  });
});

test('an UNKNOWN plugin is recorded whole rather than split on a guess', () => {
  const parsed = parseMcpToolName('mcp__plugin_some_other_thing__do_it', KNOWN);

  // A wrong attribution is worse than an unattributed one: it silently
  // credits the wrong plugin in the prune ranking.
  assert.equal(parsed.plugin, undefined);
  assert.equal(parsed.server, 'some_other_thing');
  assert.equal(parsed.tool, 'do_it');
});

test('a non-MCP tool name yields undefined', () => {
  for (const name of ['Read', 'Skill', 'Agent', 'mcp__nosep', '']) {
    assert.equal(parseMcpToolName(name), undefined, name);
  }
});

// ---------------------------------------------------------------------------
// Signal extraction
// ---------------------------------------------------------------------------

test('a Skill tool_use yields a skill signal from the real exemplar', () => {
  const [signal] = extractSignals(exemplar('skill', '01.json'));
  assert.equal(signal.kind, 'skill');
  assert.equal(signal.entity, 'claude-in-chrome');
  assert.equal(signal.isSidechain, false);
  assert.match(signal.ts, /^\d{4}-\d{2}-\d{2}T/u);
});

test('the dispatch tool is `Agent`, and `Task*` is never matched', () => {
  const [signal] = extractSignals(exemplar('agent', '01.json'));
  assert.equal(signal.kind, 'agent');

  // TaskCreate/TaskUpdate/TaskList/TaskStop are a DIFFERENT feature. A prefix
  // matcher on `Task` hits the wrong tool 244 times and the right one never.
  for (const name of ['Task', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskStop']) {
    const record = assistant({
      message: { content: [{ type: 'tool_use', name, input: { subagent_type: 'x' } }] },
    });
    assert.deepEqual(extractSignals(record), [], name);
  }
});

test('both MCP forms extract from the real exemplars', () => {
  const [user] = extractSignals(exemplar('mcp-user-scope', '01.json'), KNOWN);
  assert.equal(user.kind, 'mcp');
  assert.equal(user.plugin, undefined);

  const [plugin] = extractSignals(exemplar('mcp-plugin-scope', '01.json'), KNOWN);
  assert.equal(plugin.plugin, 'everything-claude-code');
  assert.equal(plugin.server, 'playwright');
});

test('a command comes from a user record with STRING content', () => {
  const record = {
    ...assistant(),
    type: 'user',
    message: { role: 'user', content: '<command-name>/plan</command-name>' },
  };

  const [signal] = extractSignals(record);
  assert.equal(signal.kind, 'command');
  // The recorded name is BARE — no plugin namespace. Owner resolution happens
  // against the inventory, not by parsing the string.
  assert.equal(signal.entity, 'plan');
});

test('CLI built-ins are filtered — counting them tells the user nothing', () => {
  for (const name of ['model', 'clear', 'compact', 'mcp', 'plugin', 'effort']) {
    assert.ok(CLI_BUILTIN_COMMANDS.has(name), name);
    const record = {
      ...assistant(),
      type: 'user',
      message: { role: 'user', content: `<command-name>/${name}</command-name>` },
    };
    assert.deepEqual(extractSignals(record), [], name);
  }
});

test('a user record with ARRAY content is NOT a command', () => {
  // 41 records on the reference machine are `user` + `array[tool_result]`
  // whose text merely CONTAINS `<command-name>` — a file being read that
  // mentions it. Counting those would inflate commands more than tenfold.
  const record = {
    ...assistant(),
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', content: 'a file mentioning <command-name>/plan</command-name>' }],
    },
  };

  assert.deepEqual(extractSignals(record), []);
});

test('attachment records are skipped — 57.5% of the corpus, zero signal', () => {
  const record = { ...assistant(), type: 'attachment' };
  assert.deepEqual(extractSignals(record), []);
});

test('parseCommandName tolerates the slash being present or absent', () => {
  assert.equal(parseCommandName('<command-name>/plan</command-name>'), 'plan');
  assert.equal(parseCommandName('<command-name>plan</command-name>'), 'plan');
  assert.equal(parseCommandName('no command here'), undefined);
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

test('enumeration is RECURSIVE — sidecars are most of the corpus', async (t) => {
  const root = tempTree(t);
  writeJsonl(path.join(root, 'proj', 'session.jsonl'), [assistant()]);
  writeJsonl(path.join(root, 'proj', 'session', 'subagents', 'agent-1.jsonl'), [assistant()]);

  // Sidecars are 324 of 384 files and 46% of assistant records. A
  // non-recursive walk misses nearly half the data and reports the rest as
  // the whole picture.
  const found = await enumerateTranscripts(root);
  assert.equal(found.length, 2);
  assert.ok(found.some((f) => f.includes('subagents')));
});

test('non-jsonl files are ignored', async (t) => {
  const root = tempTree(t);
  writeJsonl(path.join(root, 'p', 's.jsonl'), [assistant()]);
  writeFileSync(path.join(root, 'p', 'tool-results.txt'), 'spilled output', 'utf8');

  assert.equal((await enumerateTranscripts(root)).length, 1);
});

test('an absent root enumerates to nothing rather than throwing', async () => {
  assert.deepEqual(await enumerateTranscripts(path.join(tmpdir(), 'ccatlas-no-projects-xyz')), []);
});

test('signals BEFORE the first assistant record are not dropped', async (t) => {
  const root = tempTree(t);
  const file = path.join(root, 's.jsonl');

  // The first four records of every file are session-state, and a slash
  // command typed at the start of a session precedes any model reply.
  // Extracting only after the probe fired lost 1 of 4 non-builtin commands on
  // the reference machine — a 25% undercount on the prune ranking's input.
  writeJsonl(file, [
    { type: 'last-prompt', value: 'x' },
    { ...assistant(), type: 'user', message: { role: 'user', content: '<command-name>/plan</command-name>' } },
    assistant({ message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 's' } }] } }),
  ]);

  const scan = await scanTranscript(file);
  assert.equal(scan.probe.available, true);
  assert.deepEqual(scan.signals.map((s) => s.kind).sort(), ['command', 'skill']);
});

test('a file that FAILS the probe contributes nothing, buffered records included', async (t) => {
  const root = tempTree(t);
  const file = path.join(root, 's.jsonl');

  writeJsonl(file, [
    { ...assistant(), type: 'user', message: { role: 'user', content: '<command-name>/plan</command-name>' } },
    assistant({ message: { content: 'a string now' } }),
  ]);

  const scan = await scanTranscript(file);
  assert.equal(scan.probe.available, false);
  assert.deepEqual(scan.signals, [], 'a rejected file leaked buffered signals');
});

test('a file with no assistant record is unavailable-with-reason, not empty', async (t) => {
  const root = tempTree(t);
  const file = path.join(root, 'plugin-state.jsonl');
  writeJsonl(file, [{ type: 'memory', value: 'a third-party plugin wrote this' }]);

  // Plugins write .jsonl under projects/** too. They are rejected by the
  // PROBE rather than by a filename list that would need updating for every
  // new plugin.
  const scan = await scanTranscript(file);
  assert.equal(scan.probe.available, false);
  assert.match(scan.probe.reason, /no assistant record/);
});

test('a malformed line is skipped rather than failing the file', async (t) => {
  const root = tempTree(t);
  const file = path.join(root, 's.jsonl');

  // 0 parse failures were observed in 276,870 lines — but a file being
  // appended to WHILE it is read has a legitimately truncated last line.
  writeFileSync(
    file,
    `${JSON.stringify(assistant({ message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'a' } }] } }))}\n{"truncated":`,
    'utf8',
  );

  const scan = await scanTranscript(file);
  assert.equal(scan.probe.available, true);
  assert.equal(scan.signals.length, 1);
});

test('an unreadable file degrades to a reason, never a throw', async () => {
  const scan = await scanTranscript(path.join(tmpdir(), 'ccatlas-no-such-file.jsonl'));
  assert.equal(scan.probe.available, false);
  assert.deepEqual(scan.signals, []);
});
