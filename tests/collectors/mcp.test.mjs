/**
 * T1.3 — the `mcp` collector.
 *
 * Four declared sources: `~/.claude.json` user scope, its project-keyed local
 * scope, `<repo>/.mcp.json`, and the structured per-plugin `mcpServers` from
 * `plugin list --json`.
 *
 * Parser tests run against the committed fixtures (real captured output).
 * Collector tests build throwaway trees under the OS temp dir and pass explicit
 * absolute paths, so nothing here depends on the machine it runs on and no
 * fixture file is written by this suite.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createMcpCollector,
  extractClaudeJsonMcp,
  parseMcpListText,
} from '../../src/collectors/mcp.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliFixtures = path.join(repoRoot, 'fixtures', 'cli', '2.1.220');

const MCP_LIST_TEXT = readFileSync(path.join(cliFixtures, 'mcp-list.txt'), 'utf8');
const PLUGIN_LIST = JSON.parse(readFileSync(path.join(cliFixtures, 'plugin-list.json'), 'utf8'));

const ctx = (extra = {}) => ({ offline: true, ...extra });

/** Builds a throwaway tree and registers its cleanup with the running test. */
function tempTree(t, files) {
  const root = mkdtempSync(path.join(tmpdir(), 'ccatlas-mcp-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, typeof contents === 'string' ? contents : JSON.stringify(contents));
  }
  return root;
}

const byName = (entities, name) => entities.find((e) => e.id.name === name);

// ---------------------------------------------------------------------------
// `mcp list` display text — connection state only.
// ---------------------------------------------------------------------------

test('parseMcpListText reads every row of the captured output', () => {
  const rows = parseMcpListText(MCP_LIST_TEXT);
  // 14 servers on the reference machine; the "Checking MCP server health…"
  // header and the blank lines must not become rows.
  assert.equal(rows.length, 14);
  assert.ok(!rows.some((r) => /Checking MCP server health/.test(r.name)));
});

test('parseMcpListText captures all four observed connection states', () => {
  const rows = parseMcpListText(MCP_LIST_TEXT);
  const state = (name) => rows.find((r) => r.name === name)?.connection;

  assert.equal(state('claude.ai Gmail'), 'connected');
  assert.equal(state('figma'), 'needs-auth');
  assert.equal(state('browsermcp'), 'failed');
  // The state this task exists to not lose. A server pending approval is
  // declared but not active — it is never reported as connected.
  assert.equal(state('claude-flow'), 'pending-approval');
});

test('parseMcpListText keeps the plugin display form intact despite its colons', () => {
  const rows = parseMcpListText(MCP_LIST_TEXT);
  const exa = rows.find((r) => r.name === 'plugin:everything-claude-code:exa');

  assert.ok(exa, 'plugin:<plugin>:<server> must survive the name/target split');
  assert.equal(exa.connection, 'connected');
  assert.equal(exa.transport, 'http');
});

test('parseMcpListText does not split on the dashes inside a stdio command', () => {
  const rows = parseMcpListText(MCP_LIST_TEXT);
  const playwright = rows.find((r) => r.name === 'plugin:everything-claude-code:playwright');

  assert.equal(playwright.transport, 'stdio');
  // `npx -y @playwright/mcp@0.0.68 --extension` — neither ` -y ` nor
  // ` --extension` may be mistaken for the ` - ` status separator.
  assert.match(playwright.target, /--extension$/);
});

test('parseMcpListText survives a failure message containing its own colons and dashes', () => {
  const rows = parseMcpListText(MCP_LIST_TEXT);
  const browsermcp = rows.find((r) => r.name === 'browsermcp');

  assert.equal(browsermcp.connection, 'failed');
  assert.equal(browsermcp.target, 'npx -y @browsermcp/mcp@latest');
});

test('parseMcpListText tolerates empty input', () => {
  assert.deepEqual(parseMcpListText(''), []);
  assert.deepEqual(parseMcpListText('Checking MCP server health…\n\n'), []);
});

// ---------------------------------------------------------------------------
// `~/.claude.json` extraction — narrow by construction.
// ---------------------------------------------------------------------------

test('extractClaudeJsonMcp returns only MCP state, never the account keys beside it', () => {
  const slice = extractClaudeJsonMcp({
    oauthAccount: { emailAddress: 'someone@example.com', accountUuid: 'u-1' },
    userID: 'user-id-value',
    anonymousId: 'anon-id-value',
    machineID: 'machine-id-value',
    cachedStatsigGates: { a: true },
    mcpServers: { local: { type: 'stdio', command: 'node', args: ['s.js'] } },
    projects: {},
  });

  const serialised = JSON.stringify(slice);
  for (const secret of ['user-id-value', 'anon-id-value', 'machine-id-value', 'someone@example.com']) {
    assert.ok(!serialised.includes(secret), `${secret} must not survive extraction`);
  }
  for (const key of ['oauthAccount', 'userID', 'anonymousId', 'machineID', 'cachedStatsigGates']) {
    assert.ok(!Object.hasOwn(slice, key), `${key} must not be copied onto the slice`);
  }
  assert.ok(Object.hasOwn(slice.userServers, 'local'));
});

test('extractClaudeJsonMcp keeps per-project MCP state keyed by its raw path', () => {
  const slice = extractClaudeJsonMcp({
    projects: {
      'C:\\Users\\b\\proj': {
        mcpServers: { alpha: { type: 'http', url: 'https://example.test/mcp' } },
        enabledMcpjsonServers: ['alpha'],
        disabledMcpjsonServers: [],
        lastCost: 1.23,
        lastSessionFirstPrompt: 'a prompt that must not be copied',
      },
    },
  });

  assert.equal(slice.projects.length, 1);
  const [project] = slice.projects;
  assert.equal(project.rawKey, 'C:\\Users\\b\\proj');
  assert.deepEqual(project.enabledMcpjsonServers, ['alpha']);
  assert.ok(!JSON.stringify(project).includes('must not be copied'));
});

test('extractClaudeJsonMcp never throws on a shape it did not expect', () => {
  for (const input of [null, undefined, 42, 'text', [], { projects: 'not-an-object' }, { mcpServers: 7 }]) {
    const slice = extractClaudeJsonMcp(input);
    assert.deepEqual(slice.userServers, {});
    assert.deepEqual(slice.projects, []);
  }
});

// ---------------------------------------------------------------------------
// The collector.
// ---------------------------------------------------------------------------

test('user-scope servers are collected from ~/.claude.json with both transports', async (t) => {
  const root = tempTree(t, {
    'claude.json': {
      mcpServers: {
        'stdio-one': { type: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: 'x' } },
        'http-one': { type: 'http', url: 'https://example.test/mcp' },
        'inferred-stdio': { command: 'node', args: ['server.js'] },
      },
    },
  });

  const result = await createMcpCollector({
    claudeJsonPath: path.join(root, 'claude.json'),
  }).collect(ctx());

  assert.equal(result.ok, true);
  const stdio = byName(result.data, 'stdio-one');
  assert.equal(stdio.transport, 'stdio');
  assert.equal(stdio.id.scope, 'user');
  assert.equal(stdio.source, 'file');
  assert.deepEqual(stdio.args, ['-y', 'pkg']);
  assert.deepEqual(stdio.env, { TOKEN: 'x' });

  assert.equal(byName(result.data, 'http-one').transport, 'http');
  assert.equal(byName(result.data, 'http-one').url, 'https://example.test/mcp');
  // No `type` key, but a command: the observed plugin-bundled shape.
  assert.equal(byName(result.data, 'inferred-stdio').transport, 'stdio');
});

test('a declared server is never reported as active without evidence', async (t) => {
  const root = tempTree(t, {
    'claude.json': { mcpServers: { alpha: { type: 'http', url: 'https://example.test/mcp' } } },
  });

  const result = await createMcpCollector({
    claudeJsonPath: path.join(root, 'claude.json'),
  }).collect(ctx());

  // Declared is not active. Without `mcp list` output there is no health
  // information, and the collector must say so rather than assume connected.
  assert.equal(byName(result.data, 'alpha').connection, 'unknown');
  assert.equal(byName(result.data, 'alpha').state, 'enabled');
});

test('.mcp.json servers in neither approval list are pending approval', async (t) => {
  const root = tempTree(t, {
    'repo/.mcp.json': {
      mcpServers: {
        'claude-flow': { command: 'cmd', args: ['/c', 'npx', '-y', 'ruflo@latest', 'mcp', 'start'] },
        approved: { command: 'node', args: ['a.js'] },
        refused: { command: 'node', args: ['r.js'] },
      },
    },
  });

  // The project key is the repo's absolute path, known only once the temp tree
  // exists, so claude.json is written in a second pass.
  const repo = path.join(root, 'repo');
  writeFileSync(
    path.join(root, 'claude.json'),
    JSON.stringify({
      projects: {
        [repo]: {
          mcpServers: {},
          enabledMcpjsonServers: ['approved'],
          disabledMcpjsonServers: ['refused'],
        },
      },
    }),
  );

  const result = await createMcpCollector({
    claudeJsonPath: path.join(root, 'claude.json'),
    projectMcpJsonPath: path.join(repo, '.mcp.json'),
  }).collect(
    ctx({
      project: { key: repo.toLowerCase().replace(/\\/g, '/'), rawKeys: [repo], displayPath: repo, collides: false },
    }),
  );

  assert.equal(result.ok, true);
  // Matches the observed live case: `claude-flow` is a project-config server
  // sitting at "Pending approval" with no CLI call made.
  assert.equal(byName(result.data, 'claude-flow').connection, 'pending-approval');
  assert.equal(byName(result.data, 'claude-flow').id.scope, 'project');
  assert.equal(byName(result.data, 'approved').connection, 'unknown');
  assert.equal(byName(result.data, 'approved').state, 'enabled');
  assert.equal(byName(result.data, 'refused').state, 'disabled');
});

test('plugin-bundled servers come from the structured records, not the display text', async (t) => {
  const root = tempTree(t, { 'claude.json': { mcpServers: {} } });

  const result = await createMcpCollector({
    claudeJsonPath: path.join(root, 'claude.json'),
    pluginRecords: PLUGIN_LIST,
  }).collect(ctx());

  // 6 from everything-claude-code + 1 from figma, per the captured fixture.
  const pluginServers = result.data.filter((e) => e.owningPlugin !== undefined);
  assert.equal(pluginServers.length, 7);

  const exa = byName(result.data, 'plugin:everything-claude-code:exa');
  assert.equal(exa.owningPlugin, 'everything-claude-code');
  assert.equal(exa.transport, 'http');
  assert.equal(exa.url, 'https://mcp.exa.ai/mcp');
  assert.equal(exa.source, 'cli');

  const github = byName(result.data, 'plugin:everything-claude-code:github');
  assert.equal(github.transport, 'stdio');
  assert.equal(github.command, 'npx');
  assert.deepEqual(github.args, ['-y', '@modelcontextprotocol/server-github']);

  // The marketplace suffix is split off the LAST `@`, so a plugin id whose
  // name contains `@` still resolves to the right owner.
  assert.ok(byName(result.data, 'plugin:figma:figma'));
});

test('the plugin id is split on the last @, not the first', async (t) => {
  const root = tempTree(t, { 'claude.json': { mcpServers: {} } });

  const result = await createMcpCollector({
    claudeJsonPath: path.join(root, 'claude.json'),
    pluginRecords: [
      { id: '@scope/tool@some-marketplace', scope: 'user', mcpServers: { srv: { command: 'node' } } },
    ],
  }).collect(ctx());

  const [server] = result.data;
  assert.equal(server.owningPlugin, '@scope/tool');
  assert.equal(server.id.name, 'plugin:@scope/tool:srv');
});

test('missing plugin records degrade the section loudly, not silently', async (t) => {
  const root = tempTree(t, { 'claude.json': { mcpServers: { a: { command: 'node' } } } });

  const result = await createMcpCollector({
    claudeJsonPath: path.join(root, 'claude.json'),
  }).collect(ctx());

  assert.equal(result.ok, true);
  // `partial`, not `collector-failed`: the collector is alive and the other
  // three sources were read. Silence here would under-report the stack.
  const partial = result.warnings.find((w) => w.code === 'partial');
  assert.ok(partial, 'not enumerating plugin-bundled servers must be reported');
  assert.match(partial.message, /plugin list --json/);
});

test('CLI connection state is applied to the matching declared server', async (t) => {
  const root = tempTree(t, { 'claude.json': { mcpServers: {} } });

  const result = await createMcpCollector({
    claudeJsonPath: path.join(root, 'claude.json'),
    pluginRecords: PLUGIN_LIST,
    mcpListText: MCP_LIST_TEXT,
  }).collect(ctx());

  const exa = byName(result.data, 'plugin:everything-claude-code:exa');
  assert.equal(exa.connection, 'connected');
  assert.equal(exa.source, 'cli');

  const figmaPlugin = byName(result.data, 'plugin:figma:figma');
  // `mcp list` shows a bare `figma` row and a `plugin:figma:figma` server is
  // declared; the join is by display name, so the bare row must NOT match it.
  assert.equal(figmaPlugin.connection, 'unknown');
});

test('CLI connection state does not rewrite an entity declaration provenance', async (t) => {
  const root = tempTree(t, {
    'claude.json': { mcpServers: { alpha: { command: 'node', args: ['a.js'] } } },
  });

  const result = await createMcpCollector({
    claudeJsonPath: path.join(root, 'claude.json'),
    pluginRecords: [],
    mcpListText: 'alpha: node a.js - ✔ Connected\n',
  }).collect(ctx());

  const alpha = byName(result.data, 'alpha');
  assert.equal(alpha.connection, 'connected', 'health comes from the CLI');
  // `Entity.source` records where the server was DECLARED, not where the most
  // recent fact about it came from: its command, args and transport all still
  // come from the file. Per-fact provenance is what `Sourced<T>` is for.
  assert.equal(alpha.source, 'file');
});

test('the connection pass returns new entities rather than mutating them', async (t) => {
  const root = tempTree(t, {
    'claude.json': { mcpServers: { alpha: { command: 'node' } } },
  });

  const collector = createMcpCollector({
    claudeJsonPath: path.join(root, 'claude.json'),
    pluginRecords: [],
  });

  const before = await collector.collect(ctx());
  assert.equal(byName(before.data, 'alpha').connection, 'unknown');

  const after = await createMcpCollector({
    claudeJsonPath: path.join(root, 'claude.json'),
    pluginRecords: [],
    mcpListText: 'alpha: node - ✔ Connected\n',
  }).collect(ctx());

  // The earlier result must be untouched by the later one.
  assert.equal(byName(before.data, 'alpha').connection, 'unknown');
  assert.equal(byName(after.data, 'alpha').connection, 'connected');
});

test('CLI rows matching no declared server are reported, not invented into entities', async (t) => {
  const root = tempTree(t, { 'claude.json': { mcpServers: {} } });

  const result = await createMcpCollector({
    claudeJsonPath: path.join(root, 'claude.json'),
    pluginRecords: PLUGIN_LIST,
    mcpListText: MCP_LIST_TEXT,
  }).collect(ctx());

  // The claude.ai connectors live in claude.ai config — a source T1.3 does not
  // read. Emitting entities for them would fabricate a scope and an origin.
  assert.ok(!byName(result.data, 'claude.ai Gmail'));

  const unmatched = result.warnings.find((w) => /claude.ai Gmail/.test(w.message));
  assert.ok(unmatched, 'servers seen only in the CLI output must be reported');
  assert.equal(unmatched.code, 'reconciliation');
});

test('CLI state overrides the file-derived pending-approval inference', async (t) => {
  const root = tempTree(t, { 'repo/.mcp.json': { mcpServers: { alpha: { command: 'node' } } } });
  const repo = path.join(root, 'repo');
  writeFileSync(path.join(root, 'claude.json'), JSON.stringify({ projects: {} }));

  const result = await createMcpCollector({
    claudeJsonPath: path.join(root, 'claude.json'),
    projectMcpJsonPath: path.join(repo, '.mcp.json'),
    mcpListText: 'alpha: node a.js - ✔ Connected\n',
  }).collect(
    ctx({
      project: { key: repo.toLowerCase().replace(/\\/g, '/'), rawKeys: [repo], displayPath: repo, collides: false },
    }),
  );

  assert.equal(byName(result.data, 'alpha').connection, 'connected');
});

test('project path collisions are reported by the collector', async (t) => {
  const root = tempTree(t, {
    'claude.json': {
      projects: {
        'C:\\Users\\b\\proj': { mcpServers: {} },
        'c:/users/b/proj': { mcpServers: {} },
        '/home/other': { mcpServers: {} },
      },
    },
  });

  const result = await createMcpCollector({
    claudeJsonPath: path.join(root, 'claude.json'),
  }).collect(ctx());

  const collisions = result.warnings.filter((w) => w.code === 'path-collision');
  assert.equal(collisions.length, 1);
  assert.match(collisions[0].message, /NOT merged/);
});

// ---------------------------------------------------------------------------
// Failure is a value. The collector never throws across its boundary.
// ---------------------------------------------------------------------------

test('a missing ~/.claude.json degrades the section and keeps the run alive', async (t) => {
  const root = tempTree(t, {});

  const result = await createMcpCollector({
    claudeJsonPath: path.join(root, 'does-not-exist.json'),
  }).collect(ctx());

  assert.deepEqual(result.data, []);
  assert.equal(result.ok, true, 'a missing input degrades the section, it does not kill the run');
  assert.ok(result.warnings.some((w) => w.code === 'partial'));
  assert.equal(typeof result.elapsedMs, 'number');
});

test('malformed JSON is a warning, not a throw', async (t) => {
  const root = tempTree(t, { 'claude.json': '{ this is not json' });

  const result = await createMcpCollector({
    claudeJsonPath: path.join(root, 'claude.json'),
  }).collect(ctx());

  assert.ok(Array.isArray(result.data));
  assert.ok(result.warnings.some((w) => w.code === 'partial'));
});

test('an absent .mcp.json is normal and is not a warning', async (t) => {
  const root = tempTree(t, { 'claude.json': { mcpServers: {} } });
  const repo = path.join(root, 'repo');

  const result = await createMcpCollector({
    claudeJsonPath: path.join(root, 'claude.json'),
    projectMcpJsonPath: path.join(repo, '.mcp.json'),
    pluginRecords: [],
  }).collect(
    ctx({
      project: { key: repo.toLowerCase().replace(/\\/g, '/'), rawKeys: [repo], displayPath: repo, collides: false },
    }),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, []);
});

test('garbage server definitions are dropped, not propagated as broken entities', async (t) => {
  const root = tempTree(t, {
    'claude.json': {
      mcpServers: {
        good: { command: 'node', args: ['ok.js'] },
        'bad-args': { command: 'node', args: 'not-an-array' },
        'bad-env': { command: 'node', env: { KEY: 42 } },
        empty: {},
        nope: 'a string',
      },
    },
  });

  const result = await createMcpCollector({
    claudeJsonPath: path.join(root, 'claude.json'),
  }).collect(ctx());

  assert.ok(byName(result.data, 'good'));
  // Untrusted input at a system boundary: coerce nothing, invent nothing.
  assert.equal(byName(result.data, 'bad-args').args, undefined);
  assert.equal(byName(result.data, 'bad-env').env, undefined);
  // No transport can be determined without a url or a command.
  assert.ok(!byName(result.data, 'empty'));
  assert.ok(!byName(result.data, 'nope'));
});

// ---------------------------------------------------------------------------
// fixtureRoot — the convention `CollectContext` states, exercised with no
// explicit options at all. This is the branch a sibling can break silently.
// ---------------------------------------------------------------------------

test('fixtureRoot alone resolves every source the contract names', async (t) => {
  const root = tempTree(t, {
    'files/claude.json': { mcpServers: { alpha: { type: 'http', url: 'https://a.test/mcp' } } },
    'cli/2.1.220/mcp-list.txt': 'alpha: https://a.test/mcp (HTTP) - ✔ Connected\n',
    'cli/2.1.220/plugin-list.json': [
      { id: 'p@m', scope: 'user', mcpServers: { srv: { command: 'node' } } },
    ],
  });

  // No options: everything must come from fixtureRoot + claudeCodeVersion.
  const result = await createMcpCollector().collect(
    ctx({ fixtureRoot: root, claudeCodeVersion: '2.1.220' }),
  );

  assert.equal(result.ok, true);
  assert.equal(byName(result.data, 'alpha').transport, 'http');
  // `<fixtureRoot>/cli/<version>/mcp-list.txt` was found and applied.
  assert.equal(byName(result.data, 'alpha').connection, 'connected');
  // `<fixtureRoot>/cli/<version>/plugin-list.json` was found, so the
  // plugin-bundled section is complete and nothing is reported partial.
  assert.equal(byName(result.data, 'plugin:p:srv').owningPlugin, 'p');
  assert.deepEqual(result.warnings.filter((w) => w.code === 'partial'), []);
});

test('a fixture root missing the CLI artefacts degrades but does not fail', async (t) => {
  const root = tempTree(t, { 'files/claude.json': { mcpServers: {} } });

  const result = await createMcpCollector().collect(
    ctx({ fixtureRoot: root, claudeCodeVersion: '2.1.220' }),
  );

  assert.equal(result.ok, true);
  // An absent mcp-list.txt is silent — connection state is simply unknown. An
  // absent plugin-list.json is not, because servers would go unreported.
  assert.equal(result.warnings.filter((w) => w.code === 'partial').length, 1);
  assert.match(result.warnings[0].message, /plugin list --json/);
});

test('fixtureRoot without a version does not guess at a CLI fixture directory', async (t) => {
  const root = tempTree(t, { 'files/claude.json': { mcpServers: {} } });

  const result = await createMcpCollector().collect(ctx({ fixtureRoot: root }));

  assert.equal(result.ok, true);
  assert.ok(!result.warnings.some((w) => /undefined/.test(w.message)));
});

test('the collector identifies itself as mcp and is read-only', async () => {
  assert.equal(createMcpCollector().name, 'mcp');

  // `mcp list` health-checks every server over the network and took ~40s for
  // 14 locally. A collector that spawned it would blow the <2s cold budget and
  // violate `offline`. Display text is injected, never fetched.
  const source = readFileSync(path.join(repoRoot, 'src', 'collectors', 'mcp.ts'), 'utf8');
  for (const forbidden of ['child_process', 'node:http', 'node:https', 'fetch(']) {
    assert.ok(!source.includes(forbidden), `mcp.ts must not reference ${forbidden}`);
  }
  for (const mutator of ['writeFile', 'mkdir', 'rm(', 'unlink', 'appendFile']) {
    assert.ok(!source.includes(mutator), `mcp.ts must not reference ${mutator}`);
  }
});
