/**
 * T1.1 — the `cli` collector, exercised entirely against committed fixtures.
 *
 * Plain .mjs, no test framework: the zero-runtime-dependency posture holds in
 * the test path too. The collector is TypeScript, imported directly — `npm
 * test` passes --experimental-strip-types, which is a no-op on Node 22.18+ and
 * required on 22.13–22.17, both of which `engines` admits. Running this file
 * by hand needs the same flag:
 *
 *   node --test --experimental-strip-types tests/collectors/cli.test.mjs
 *
 * NOTHING here invokes the real `claude` binary. Every fixture carries redacted
 * `<HOME>` / `<TMP>` placeholders, and the assertions below read them, so an
 * accidental live call fails rather than passing silently.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  cliCollector,
  createCliCollector,
  createFixtureRunner,
  normalisePluginSource,
  parseAvailableList,
  parseMarketplaceList,
  parseMcpList,
  parsePluginList,
  succeeded,
} from '../../src/collectors/cli.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtureRoot = path.join(repoRoot, 'fixtures');
const FIXTURE_VERSION = '2.1.220';

// --- helpers ---------------------------------------------------------------

const baseRunner = createFixtureRunner(fixtureRoot, FIXTURE_VERSION);

/** Wraps the fixture runner so a test can assert which argvs were issued. */
function spyRunner() {
  const calls = [];
  const runner = async (argv) => {
    calls.push([...argv]);
    return baseRunner(argv);
  };
  runner.calls = calls;
  return runner;
}

const ctx = (overrides = {}) => ({
  offline: true,
  fixtureRoot,
  claudeCodeVersion: FIXTURE_VERSION,
  ...overrides,
});

/**
 * `offline: false` below never reaches the network: `fixtureRoot` short-circuits
 * the spawn path entirely, so every byte still comes off disk. It exists only
 * to let the `mcp list` branch run at all.
 */
async function collectAll(options = {}, ctxOverrides = {}) {
  const result = await createCliCollector(options).collect(ctx(ctxOverrides));
  assert.equal(result.ok, true, `collect failed: ${JSON.stringify(result.error)}`);
  assert.ok(result.data);
  return result;
}

const readFixture = (argv) => baseRunner(argv);

// --- contract --------------------------------------------------------------

test('satisfies the Collector contract and tags every fact source: "cli"', async () => {
  assert.equal(cliCollector.name, 'cli');

  const { data, warnings, elapsedMs } = await collectAll();
  assert.ok(Array.isArray(warnings));
  assert.equal(typeof elapsedMs, 'number');
  assert.ok(elapsedMs >= 0);

  const all = [...data.plugins, ...data.available, ...data.marketplaces, ...data.mcpServers];
  assert.ok(all.length > 0);
  for (const entity of all) {
    assert.equal(entity.source, 'cli', `${entity.id.name} is not tagged source: "cli"`);
    assert.equal(typeof entity.id.name, 'string');
    assert.ok(entity.id.name.length > 0);
  }
});

test('the fixture corpus is what was read — never the live machine', async () => {
  const { data } = await collectAll({ pluginDir: 'C:\\tmp\\sideload\\ccatlas-probe' });

  // Every captured path was redacted to `<HOME>` / `<TMP>` at capture time, so
  // these assertions are unsatisfiable by live output. This is what makes the
  // suite reproducible rather than a description of one machine.
  const installed = data.plugins.find((p) => p.id.name === 'superpowers@claude-plugins-official');
  assert.match(installed.installPath, /^<HOME>[\\/]/);
  const sideload = data.plugins.find((p) => p.id.name === 'ccatlas-probe@inline');
  assert.match(sideload.installPath, /^<TMP>[\\/]/);
  for (const marketplace of data.marketplaces) {
    assert.match(marketplace.installLocation, /^<HOME>[\\/]/);
  }
});

test('a failure is a value — the collector never throws across its boundary', async () => {
  const exploding = async () => {
    throw new Error('boom');
  };
  const result = await createCliCollector({ runner: exploding }).collect(ctx());

  assert.equal(result.ok, false);
  assert.equal(result.data, null);
  assert.match(result.error.message, /boom/);
  assert.equal(typeof result.elapsedMs, 'number');
});

test('malformed input degrades to warnings, never to a throw', () => {
  for (const junk of [null, undefined, 42, 'nope', {}, [{}], [{ id: 7 }]]) {
    assert.doesNotThrow(() => parsePluginList(junk));
    assert.doesNotThrow(() => parseAvailableList(junk));
    assert.doesNotThrow(() => parseMarketplaceList(junk));
    assert.doesNotThrow(() => normalisePluginSource(junk));
  }
  assert.doesNotThrow(() => parseMcpList(''));
  assert.deepEqual(parseMcpList('').servers, []);
});

// --- trap 1: the top-level type changes with the flag ----------------------

test('trap 1: `plugin list --json` is a bare array, `--available` is an object', async () => {
  const plain = JSON.parse((await readFixture(['plugin', 'list', '--json'])).stdout);
  const withAvailable = JSON.parse(
    (await readFixture(['plugin', 'list', '--json', '--available'])).stdout,
  );

  assert.ok(Array.isArray(plain), 'fixture drift: plain list is no longer an array');
  assert.ok(!Array.isArray(withAvailable), 'fixture drift: --available is no longer an object');
  assert.deepEqual(Object.keys(withAvailable).sort(), ['available', 'installed']);

  // Branching on the flag, not the shape: each parser rejects the other's
  // payload with a warning instead of silently returning nothing useful.
  const wrong = parsePluginList(withAvailable);
  assert.deepEqual(wrong.plugins, []);
  assert.equal(wrong.warnings.length, 1);
  assert.equal(wrong.warnings[0].code, 'unsupported-version');

  const alsoWrong = parseAvailableList(plain);
  assert.deepEqual(alsoWrong.available, []);
  assert.equal(alsoWrong.warnings.length, 1);

  assert.equal(parsePluginList(plain).plugins.length, 5);
  const both = parseAvailableList(withAvailable);
  assert.equal(both.plugins.length, 5);
  assert.equal(both.available.length, 276);
  assert.deepEqual(both.warnings, []);
});

// --- trap 2: pluginId vs id ------------------------------------------------

test('trap 2: `available[].pluginId` and `installed[].id` normalise to one shape', async () => {
  const { data } = await collectAll();

  const installed = data.plugins.find((p) => p.id.name === 'figma@claude-plugins-official');
  assert.ok(installed, 'installed entry keyed off `id`');
  assert.equal(installed.marketplace, 'claude-plugins-official');

  const catalogued = data.available.find(
    (p) => p.id.name === '42crunch-api-security-testing@claude-plugins-official',
  );
  assert.ok(catalogued, 'available entry keyed off `pluginId`');
  assert.equal(catalogued.marketplace, 'claude-plugins-official');
  assert.equal(catalogued.id.kind, 'plugin');
  assert.equal(catalogued.enabled, false);

  // Both sides carry the same required keys — a consumer needs no branch.
  for (const entity of [installed, catalogued]) {
    for (const key of ['id', 'origin', 'state', 'source', 'marketplace', 'enabled', 'version']) {
      assert.ok(key in entity, `${entity.id.name} is missing ${key}`);
    }
    assert.equal(typeof entity.version.version, 'string');
  }

  // The raw key names must not leak through.
  assert.equal('pluginId' in catalogued, false);
  for (const entry of data.available) {
    assert.equal(typeof entry.description, 'string');
    assert.ok(entry.marketplace.length > 0);
  }
});

// --- trap 3: available[] excludes installed plugins ------------------------

test('trap 3: `available[]` is a catalogue, not a set of upgrade targets', async () => {
  const { data } = await collectAll();

  const installedIds = new Set(data.plugins.map((p) => p.id.name));
  assert.equal(installedIds.size, 5);

  const overlap = data.available.filter((a) => installedIds.has(a.id.name));
  assert.deepEqual(overlap, [], 'available[] must not be treated as containing installed plugins');

  // claude-plugins-official contributes the bulk of the catalogue yet none of
  // the four plugins installed from it appear — deriving updates from this
  // list would work for every plugin except the ones you have.
  const official = data.available.filter((a) => a.marketplace === 'claude-plugins-official');
  assert.ok(official.length > 200);
  assert.equal(
    official.some((a) => a.id.name === 'figma@claude-plugins-official'),
    false,
  );

  // Nothing in the collector's output claims an update is available.
  assert.deepEqual(Object.keys(data).sort(), [
    'available',
    'marketplaces',
    'mcpServers',
    'plugins',
  ]);
});

// --- trap 4: `source` is a union type --------------------------------------

test('trap 4: bare-string and object `source` both normalise to PluginSource', () => {
  const bare = normalisePluginSource('./plugins/clangd-lsp');
  assert.deepEqual(bare, { source: 'relative-path', path: './plugins/clangd-lsp' });

  assert.deepEqual(
    normalisePluginSource({
      source: 'git-subdir',
      url: 'https://github.com/adobe/skills.git',
      path: 'plugins/creative-cloud/adobe-for-creativity',
      ref: 'main',
      sha: '17ef6fb53d2eb23158dec11823ff569258b7a26e',
    }),
    {
      source: 'git-subdir',
      url: 'https://github.com/adobe/skills.git',
      path: 'plugins/creative-cloud/adobe-for-creativity',
      ref: 'main',
      sha: '17ef6fb53d2eb23158dec11823ff569258b7a26e',
    },
  );

  assert.deepEqual(normalisePluginSource({ source: 'github', repo: 'a/b', sha: 'deadbeef' }), {
    source: 'github',
    repo: 'a/b',
    sha: 'deadbeef',
  });
});

test('trap 4: every one of the 276 catalogue rows yields a usable PluginSource', async () => {
  const { data } = await collectAll();
  assert.equal(data.available.length, 276);

  const byDiscriminator = new Map();
  let withSha = 0;
  for (const entry of data.available) {
    const src = entry.pluginSource;
    assert.ok(src, `${entry.id.name} lost its source`);
    assert.equal(typeof src.source, 'string');
    assert.ok(src.source.length > 0);
    byDiscriminator.set(src.source, (byDiscriminator.get(src.source) ?? 0) + 1);
    if (src.sha !== undefined) {
      withSha += 1;
      // The SHA is the install coordinate, surfaced where readers look for it.
      assert.equal(entry.version.sourceSha, src.sha);
    }
  }

  assert.equal(byDiscriminator.get('relative-path'), 55, '55 rows are bare strings');
  assert.equal(byDiscriminator.get('url'), 140);
  assert.equal(byDiscriminator.get('git-subdir'), 79);
  assert.equal(byDiscriminator.get('github'), 2);
  assert.equal(withSha, 221);

  // A reader assuming an object breaks on 20% of entries; assuming a string
  // breaks on the other 80%. Neither is possible after normalisation.
  for (const entry of data.available) {
    if (entry.pluginSource.source === 'relative-path') {
      assert.equal(typeof entry.pluginSource.path, 'string');
      assert.equal(entry.pluginSource.url, undefined);
      assert.equal(entry.pluginSource.sha, undefined);
    }
  }
});

// --- trap 5: version is the literal string "unknown" -----------------------

test('trap 5: an unresolved version is the literal "unknown", not null or absent', async () => {
  const { data } = await collectAll();

  const unresolved = data.plugins.find(
    (p) => p.id.name === 'frontend-design@claude-plugins-official',
  );
  assert.ok(unresolved);
  assert.equal(unresolved.version.version, 'unknown');
  assert.notEqual(unresolved.version.version, null);
  assert.equal(unresolved.version.versionSource, 'unknown');

  // Every installed plugin carries a string version, never a nullish one.
  for (const plugin of data.plugins) {
    assert.equal(typeof plugin.version.version, 'string');
    assert.ok(plugin.version.version.length > 0);
  }

  // The CLI never reveals WHICH field it read (FINDINGS Q5: plugin.json,
  // marketplace entry, metadata.version and skill.json are all candidates and
  // two of them disagree for ui-ux-pro-max). Claiming 'plugin-json' from CLI
  // output alone would be an unfalsifiable number; the file collector witnesses
  // it and T1.8 reconciles.
  for (const plugin of data.plugins) {
    assert.equal(plugin.version.versionSource, 'unknown');
  }

  // Catalogue rows are different: a version there provably came from the
  // marketplace entry (14 of 276).
  const declared = data.available.filter((a) => a.version.versionSource === 'marketplace-entry');
  assert.equal(declared.length, 14);
  for (const entry of declared) {
    assert.notEqual(entry.version.version, 'unknown');
  }
});

// --- trap 6: sideloads -----------------------------------------------------

test('trap 6: `--plugin-dir` sideloads carry scope "session", @inline and no timestamps', async () => {
  const runner = spyRunner();
  const { data } = await collectAll({ runner, pluginDir: 'C:\\tmp\\sideload\\ccatlas-probe' });

  const sideload = data.plugins.find((p) => p.id.name === 'ccatlas-probe@inline');
  assert.ok(sideload, 'sideload missing from the roster');
  assert.equal(sideload.id.scope, 'session');
  assert.equal(sideload.marketplace, 'inline');
  assert.equal(sideload.origin, 'inline');
  assert.equal(sideload.installedAt, undefined);
  assert.equal(sideload.lastUpdated, undefined);
  assert.equal(sideload.version.version, '0.0.1-probe');
  assert.equal(sideload.enabled, true);

  // The other five are unaffected, and none of them is scoped to the session.
  assert.equal(data.plugins.length, 6);
  for (const plugin of data.plugins.filter((p) => p !== sideload)) {
    assert.equal(plugin.id.scope, 'user');
    assert.equal(plugin.origin, 'marketplace');
    assert.equal(typeof plugin.installedAt, 'string');
  }

  // trap 18: --plugin-dir is a GLOBAL flag. In any other position the CLI exits
  // 1 with empty stdout, so the argv order is load-bearing.
  const listCall = runner.calls.find((argv) => argv.includes('--plugin-dir'));
  assert.equal(listCall[0], '--plugin-dir');
  assert.ok(listCall.indexOf('plugin') > listCall.indexOf('--plugin-dir'));
});

test('trap 18: a mispositioned --plugin-dir fails loudly rather than under-reporting', async () => {
  for (const argv of [
    ['plugin', 'list', '--plugin-dir', 'C:\\tmp\\sideload', '--json'],
    ['plugin', 'list', '--json', '--plugin-dir', 'C:\\tmp\\sideload'],
  ]) {
    const outcome = await readFixture(argv);
    assert.equal(outcome.code, 1);
    assert.equal(outcome.stdout, '');
    assert.match(outcome.stderr, /unknown option '--plugin-dir'/);
    assert.equal(succeeded(outcome), false);
  }
});

// --- trap 7: errors on stdout, exit 1, empty stderr ------------------------

test('trap 7: success is keyed on the exit code, never on stderr', async () => {
  // Opposite stream populations, same exit code. Keying on either stream alone
  // misclassifies one of these two.
  const errorOnStdout = await readFixture(['plugin', 'details', '42crunch-api-security-testing']);
  assert.equal(errorOnStdout.code, 1);
  assert.equal(errorOnStdout.stderr, '', 'fixture drift: stderr is no longer empty');
  assert.match(errorOnStdout.stdout, /not found/);

  const errorOnStderr = await readFixture([
    'plugin',
    'list',
    '--plugin-dir',
    'C:\\tmp\\sideload',
    '--json',
  ]);
  assert.equal(errorOnStderr.code, 1);
  assert.equal(errorOnStderr.stdout, '');
  assert.ok(errorOnStderr.stderr.length > 0);

  assert.equal(succeeded(errorOnStdout), false, 'empty stderr must not read as success');
  assert.equal(succeeded(errorOnStderr), false);

  const ok = await readFixture(['plugin', 'list', '--json']);
  assert.equal(ok.code, 0);
  assert.equal(ok.stderr, '');
  assert.equal(succeeded(ok), true);

  // A stderr-keyed check would have called the not-found error a success and
  // parsed the sentence as data. Prove the collector does not.
  const failing = async (argv) =>
    argv.join(' ') === 'plugin list --json' ? errorOnStdout : baseRunner(argv);
  const degraded = await createCliCollector({ runner: failing }).collect(ctx());
  assert.equal(degraded.ok, true, 'one failed command degrades a section, not the run');
  assert.deepEqual(degraded.data.plugins, []);
  // 'partial', not 'collector-failed': the collector did not die, one command
  // did — and 'reconciliation' would hand T1.8 a conflict that never happened.
  assert.ok(degraded.warnings.some((w) => w.code === 'partial'));
  assert.equal(
    degraded.warnings.some((w) => w.code === 'reconciliation'),
    false,
  );
  assert.equal(
    JSON.stringify(degraded.data).includes('not found'),
    false,
    'the error sentence leaked into the data',
  );
});

// --- trap 8: mcp list ------------------------------------------------------

test('trap 8: `mcp list` is opt-in — it health-checks every server', async () => {
  const runner = spyRunner();
  const { data, warnings } = await collectAll({ runner });

  assert.equal(
    runner.calls.some((argv) => argv.join(' ') === 'mcp list'),
    false,
    'mcp list must not run by default: ~40s for 14 servers, and it is live egress',
  );
  assert.ok(warnings.some((w) => w.code === 'partial' && /mcp list/.test(w.message)));

  // The plugin-bundled servers are still known — `plugin list --json` carries
  // them, and it is the ONLY source of a plugin stdio server's command.
  assert.ok(data.mcpServers.length >= 7);
  for (const server of data.mcpServers) {
    assert.equal(server.connection, 'unknown');
  }
});

test('trap 8: offline collection never issues the live health check', async () => {
  const runner = spyRunner();
  await collectAll({ runner, includeMcpList: true });
  assert.equal(
    runner.calls.some((argv) => argv.join(' ') === 'mcp list'),
    false,
    'offline: true guarantees zero egress, and mcp list dials every server',
  );
});

test('trap 8: connection states, plugin namespacing and transports', async () => {
  const { data } = await collectAll({ includeMcpList: true }, { offline: false });
  const byName = new Map(data.mcpServers.map((s) => [s.id.name, s]));

  // 14 from `mcp list`, plus one the health check never mentions: the figma
  // PLUGIN bundles an MCP server also called `figma`, and a user-scope server
  // of that name (3 user-scope servers exist: browsermcp, figma-dev-mode,
  // figma) is what `mcp list` actually shows. The plugin-bundled one survives
  // as plugin:figma:figma rather than being silently dropped or conflated.
  assert.equal(byName.size, 15);
  assert.equal(byName.get('plugin:figma:figma').connection, 'unknown');
  assert.equal(byName.get('plugin:figma:figma').owningPlugin, 'figma');
  assert.equal(byName.get('figma').owningPlugin, undefined);

  assert.equal(byName.get('claude.ai Gmail').connection, 'connected');
  assert.equal(byName.get('claude.ai Comfy Cloud MCP').connection, 'needs-auth');
  assert.equal(byName.get('browsermcp').connection, 'failed');
  assert.equal(byName.get('figma-dev-mode').connection, 'failed');
  assert.equal(byName.get('figma').connection, 'needs-auth');

  // `Pending approval` is a real, distinct state. Folding it into 'connected'
  // or 'unknown' is what makes an always-on cost figure wrong: it contributes
  // zero, because nothing is loaded until it is approved.
  const pending = byName.get('claude-flow');
  assert.equal(pending.connection, 'pending-approval');
  assert.notEqual(pending.connection, 'connected');
  assert.notEqual(pending.connection, 'unknown');
  assert.equal(
    data.mcpServers.filter((s) => s.connection === 'pending-approval').length,
    1,
  );

  // Plugin servers display as plugin:<plugin>:<server>; the canonical name is
  // kept (it is what `mcp get` accepts) and the owner is extracted.
  const pluginServer = byName.get('plugin:everything-claude-code:github');
  assert.equal(pluginServer.owningPlugin, 'everything-claude-code');
  assert.equal(pluginServer.transport, 'stdio');
  assert.equal(pluginServer.command, 'npx');
  assert.deepEqual(pluginServer.args, ['-y', '@modelcontextprotocol/server-github']);
  assert.equal(pluginServer.connection, 'connected');

  for (const server of data.mcpServers) {
    if (server.id.name.startsWith('plugin:')) {
      assert.equal(typeof server.owningPlugin, 'string');
      assert.equal(server.origin, 'marketplace');
    } else {
      assert.equal(server.owningPlugin, undefined);
    }
  }

  // `mcp list` witnesses neither scope nor origin — only the `plugin:` prefix
  // is evidence of anything. The four claude.ai connectors are connector
  // config and claude-flow is project config (per `mcp get`), so these two
  // fields are uniform documented defaults, not per-row inferences. Asserted
  // so that a later commit inferring 'project' from one pending row has to
  // change a test that says why it must not.
  for (const server of data.mcpServers) {
    assert.equal(server.id.scope, 'user');
  }
  assert.equal(byName.get('claude-flow').origin, 'personal');
  assert.equal(byName.get('claude.ai Gmail').origin, 'personal');

  // Transport: the `(HTTP)` suffix is present for user/plugin http servers and
  // ABSENT for claude.ai connectors, so a suffix-only rule mislabels four.
  assert.equal(byName.get('plugin:everything-claude-code:exa').transport, 'http');
  assert.equal(byName.get('plugin:everything-claude-code:exa').url, 'https://mcp.exa.ai/mcp');
  assert.equal(byName.get('claude.ai Gmail').transport, 'http');
  assert.equal(byName.get('claude.ai Gmail').url, 'https://gmailmcp.googleapis.com/mcp/v1');
  assert.equal(byName.get('figma-dev-mode').url, 'http://127.0.0.1:3845/mcp');

  // Trailing whitespace before the separator must not become an argv entry.
  const browser = byName.get('browsermcp');
  assert.equal(browser.transport, 'stdio');
  assert.deepEqual(browser.args, ['-y', '@browsermcp/mcp@latest']);

  // Nothing is ever reported as sse — no such server has been observed.
  assert.equal(
    data.mcpServers.some((s) => s.transport === 'sse'),
    false,
  );
});

test('trap 8: status is keyed on text, so a new state degrades to "unknown"', () => {
  const { servers, warnings } = parseMcpList(
    ['Checking MCP server health…', '', 'future-server: npx -y thing - ☂ Rehydrating'].join('\n'),
  );
  assert.equal(servers.length, 1);
  assert.equal(servers[0].connection, 'unknown');
  assert.equal(servers[0].command, 'npx');
  assert.ok(warnings.length >= 1);
});

test('trap 8: `mcp list` and `plugin list` agree on plugin-bundled servers', async () => {
  const { data } = await collectAll({ includeMcpList: true }, { offline: false });
  const exa = data.mcpServers.find((s) => s.id.name === 'plugin:everything-claude-code:exa');

  // Merged, not duplicated: the health state comes from `mcp list`, the config
  // from `plugin list --json`.
  assert.equal(exa.connection, 'connected');
  assert.equal(exa.transport, 'http');
  assert.equal(exa.owningPlugin, 'everything-claude-code');
  assert.equal(
    data.mcpServers.filter((s) => s.id.name === 'plugin:everything-claude-code:exa').length,
    1,
  );
});

// --- trap 9: marketplace distribution --------------------------------------

test('trap 9: `claude-plugins-official` is a GCS tarball, not a git checkout', async () => {
  const { data } = await collectAll();
  assert.equal(data.marketplaces.length, 4);

  const byName = new Map(data.marketplaces.map((m) => [m.id.name, m]));
  assert.equal(byName.get('claude-plugins-official').distribution, 'gcs');
  assert.equal(byName.get('anthropic-agent-skills').distribution, 'git');
  assert.equal(byName.get('everything-claude-code').distribution, 'git');
  assert.equal(byName.get('ui-ux-pro-max-skill').distribution, 'git');

  for (const marketplace of data.marketplaces) {
    assert.equal(marketplace.id.kind, 'marketplace');
    assert.equal(typeof marketplace.installLocation, 'string');
    assert.ok(marketplace.installLocation.length > 0);
    // No autoUpdate field exists anywhere in the CLI output (trap 5).
    assert.equal('autoUpdate' in marketplace, false);
  }

  // `repo` is the only upstream coordinate the command returns; dropping it
  // would strand any later freshness check.
  assert.equal(byName.get('claude-plugins-official').repo, 'anthropics/claude-plugins-official');
  assert.equal(byName.get('claude-plugins-official').sourceType, 'github');
});

// --- fixture plumbing ------------------------------------------------------

test('an unknown Claude Code version is reported, not silently substituted', async () => {
  const result = await createCliCollector().collect({
    offline: true,
    fixtureRoot,
    claudeCodeVersion: '9.9.999',
  });

  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.code === 'unsupported-version'));
});

test('a missing fixture is a failed command, not an exception', async () => {
  const outcome = await baseRunner(['plugin', 'details', 'no-such-plugin-xyz']);
  assert.notEqual(outcome.code, 0);
  assert.equal(succeeded(outcome), false);
});
