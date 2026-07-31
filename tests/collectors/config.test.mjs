/**
 * T1.2 — the `config` collector: settings resolution across four scopes.
 *
 * Plain .mjs, no test framework, matching tests/cli.test.mjs. The TypeScript
 * source is imported directly: Node 22.18 strips types by default, and
 * src/collectors/config.ts imports nothing but types from ../types.js, so the
 * only import in it is erased before Node ever resolves it.
 *
 * EVERY TEST NAME CARRIES A PROVENANCE TAG, because this is the one collector
 * whose core behaviour was never observed on the reference machine:
 *
 *   [real]      — data extracted from fixtures/files/settings-shape.json, which
 *                 is a SHAPE DESCRIPTOR captured from a real machine, not a
 *                 settings file. Real values, wrapped in `.value`.
 *   [synthetic] — fixtures/synthetic/precedence/, a constructed behaviour
 *                 oracle. Nothing in it was captured from any machine.
 *   [inline]    — stand-ins written in this file, for behaviour neither corpus
 *                 covers (file discovery, malformed input, drop-in dirs).
 *
 * Oracle assertions additionally carry the oracle's own confidence grade
 * (CERTIFIABLE / DOCUMENTED / ASSERTED / MODEL-DEPENDENT) in the test name.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MANAGED_SETTINGS_PATHS,
  PLUGIN_CONFIG_SCOPES,
  SETTINGS_PRECEDENCE,
  collectConfig,
  permissionDecision,
  resolveSettings,
} from '../../src/collectors/config.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const filesDir = path.join(repoRoot, 'fixtures', 'files');
const precedenceDir = path.join(repoRoot, 'fixtures', 'synthetic', 'precedence');

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/**
 * Builds a throwaway settings tree; the collector reads it, never the real
 * machine. Passed via `options.roots`, NOT `fixtureRoot` — `fixtureRoot` is the
 * repository's `fixtures/` directory and cannot stand in for a home directory.
 */
function makeSettingsTree(t, files) {
  const root = mkdtempSync(path.join(tmpdir(), 'ccatlas-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return root;
}

const layer = (scope, settings) => ({ scope, path: `<${scope}>`, settings });

// ---------------------------------------------------------------------------
// Declared model. The oracle refuses to pick one; T1.2 must, out loud.
// ---------------------------------------------------------------------------

test('[inline] the collector declares its merge model in its own output', () => {
  const data = resolveSettings([layer('user', {})]);
  assert.equal(data.mergeModel, 'per-key-merge');
  assert.equal(data.permissionModel, 'array-union-deny-wins');
});

test('[inline] scope precedence runs user < project < local < session < managed', () => {
  // `session` is the `--settings` layer: docs place command-line settings
  // between managed and local. It ranks above local, below managed.
  assert.deepEqual([...SETTINGS_PRECEDENCE], ['user', 'project', 'local', 'session', 'managed']);
});

test('[inline] pluginConfigs is restricted to user, --settings and managed', () => {
  assert.deepEqual([...PLUGIN_CONFIG_SCOPES].sort(), ['managed', 'session', 'user']);
});

test('[inline] managed settings paths are recorded per platform', () => {
  assert.equal(MANAGED_SETTINGS_PATHS.win32, 'C:\\Program Files\\ClaudeCode\\managed-settings.json');
  assert.equal(
    MANAGED_SETTINGS_PATHS.darwin,
    '/Library/Application Support/ClaudeCode/managed-settings.json',
  );
  assert.equal(MANAGED_SETTINGS_PATHS.linux, '/etc/claude-code/managed-settings.json');
});

// ---------------------------------------------------------------------------
// [synthetic] The precedence oracle
// ---------------------------------------------------------------------------

const hasOracle = existsSync(path.join(precedenceDir, 'expected-precedence.json'));

if (hasOracle) {
  const oracle = readJson(path.join(precedenceDir, 'expected-precedence.json'));
  const syntheticLayers = [
    { scope: 'user', path: path.join(precedenceDir, 'user-settings.json') },
    { scope: 'project', path: path.join(precedenceDir, 'project-settings.json') },
    { scope: 'local', path: path.join(precedenceDir, 'local-settings.json') },
    { scope: 'managed', path: path.join(precedenceDir, 'managed-settings.json') },
  ].map((l) => ({ ...l, settings: readJson(l.path) }));

  const resolved = resolveSettings(syntheticLayers);

  test('[synthetic] the oracle is the one shipped with the repo, and is synthetic', () => {
    assert.equal(oracle.__synthetic, true);
    assert.deepEqual(oracle.scopeOrder.highestFirst, ['managed', 'local', 'project', 'user']);
  });

  const RECORD_SETTINGS = new Set([
    'enabledPlugins',
    'extraKnownMarketplaces',
    'pluginConfigs',
    'env',
  ]);

  for (const exp of oracle.expectations) {
    const entry = exp.entry ? ` / ${exp.entry}` : '';
    test(`[synthetic][${exp.status}] ${exp.id} — ${exp.setting}${entry}`, () => {
      if (RECORD_SETTINGS.has(exp.setting)) {
        const got = resolved[exp.setting][exp.entry];
        if (exp.expectedPresent === false) {
          assert.equal(got, undefined, `must resolve to NO entry at all: ${exp.why}`);
          return;
        }
        assert.ok(got, `expected an entry for ${exp.setting}.${exp.entry}`);
        assert.deepEqual(got.value, exp.expectedValue, exp.why ?? exp.id);
        assert.equal(got.scope, exp.expectedScope, `winning scope for ${exp.id}`);
        assert.equal(got.source, 'file');
        return;
      }

      if (exp.setting === 'permissions.defaultMode') {
        assert.ok(resolved.permissions.defaultMode);
        assert.equal(resolved.permissions.defaultMode.value, exp.expectedValue);
        assert.equal(resolved.permissions.defaultMode.scope, exp.expectedScope);
        return;
      }

      if (exp.setting === 'permissions (effective decision)') {
        assert.equal(permissionDecision(resolved.permissions, exp.entry), exp.expectedDecision);
        return;
      }

      if (exp.setting === 'permissions.allow' || exp.setting === 'permissions.additionalDirectories') {
        const field = exp.setting.slice('permissions.'.length);
        const got = resolved.permissions[field].map((r) => r.rule);
        // The oracle does not assert order within the union — compare as sets.
        assert.deepEqual([...got].sort(), [...exp.expectedValueUnderUnion].sort());
        return;
      }

      assert.fail(`unhandled oracle setting: ${exp.setting}`);
    });
  }

  test('[synthetic] full resolution matches the oracle golden object (assumed model)', () => {
    const golden = oracle.resolvedUnderAssumedModel;
    const plain = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.value]));
    const rules = (field) => [...resolved.permissions[field].map((r) => r.rule)].sort();

    assert.deepEqual(plain(resolved.enabledPlugins), golden.enabledPlugins);
    assert.deepEqual(plain(resolved.extraKnownMarketplaces), golden.extraKnownMarketplaces);
    assert.deepEqual(plain(resolved.pluginConfigs), golden.pluginConfigs);
    assert.deepEqual(plain(resolved.env), golden.env);
    assert.equal(resolved.permissions.defaultMode.value, golden.permissions.defaultMode);
    assert.deepEqual(rules('allow'), [...golden.permissions.allow].sort());
    assert.deepEqual(rules('deny'), [...golden.permissions.deny].sort());
    assert.deepEqual(
      rules('additionalDirectories'),
      [...golden.permissions.additionalDirectories].sort(),
    );
  });

  test('[synthetic] provenance names every shadowed scope, highest-precedence first', () => {
    for (const record of oracle.shadowingReport.entries) {
      if (record.setting === 'permissions.defaultMode') {
        assert.deepEqual(resolved.permissions.defaultMode.shadowed, record.shadowed);
        continue;
      }
      const got = resolved[record.setting][record.entry];
      assert.ok(got, `${record.setting}.${record.entry}`);
      assert.equal(got.scope, record.winner);
      assert.deepEqual(got.shadowed, record.shadowed, `${record.setting}.${record.entry}`);
      if (record.ignoredByRule) {
        assert.deepEqual(got.ignored, record.ignoredByRule.R4);
      }
    }
  });

  test('[synthetic] collect() with fixtureRoot=fixtures/ reproduces the oracle', async () => {
    // The settled meaning of fixtureRoot: the repository's fixtures/ directory.
    // The four-scope corpus is the only four-scope settings set in existence,
    // so this is the end-to-end path — discovery, reading, and resolution —
    // rather than resolveSettings() called with hand-assembled layers.
    const result = await collectConfig({
      fixtureRoot: path.join(repoRoot, 'fixtures'),
      offline: true,
    });
    assert.equal(result.ok, true);

    const golden = oracle.resolvedUnderAssumedModel;
    const plain = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.value]));
    assert.deepEqual(plain(result.data.enabledPlugins), golden.enabledPlugins);
    assert.deepEqual(plain(result.data.pluginConfigs), golden.pluginConfigs);
    assert.deepEqual(plain(result.data.env), golden.env);

    const scopes = result.data.scopes.filter((s) => s.status === 'read').map((s) => s.scope);
    assert.deepEqual(scopes.sort(), ['local', 'managed', 'project', 'user']);
  });

  test('[synthetic] an entry dropped by rule is reported, not silently swallowed', () => {
    // The oracle calls these `ignoredByRule`, deliberately separate from
    // `entries` (genuine shadowing): an input dropped because its scope is
    // IGNORED for that key is a different finding class from one that lost on
    // precedence. Reporting an R4 drop as "shadowed by user" would misdescribe
    // the mechanism and hide the security property.
    assert.equal(
      oracle.shadowingReport.ignoredByRule.length,
      oracle.shadowingReport.expectedIgnoredByRuleCount,
      'oracle self-consistency: ignoredByRule length must match its stated count',
    );

    for (const dropped of oracle.shadowingReport.ignoredByRule) {
      const found = resolved.droppedInputs.find(
        (d) => d.setting === dropped.setting && d.entry === dropped.entry,
      );
      assert.ok(found, `expected a dropped-input record for ${dropped.setting}.${dropped.entry}`);
      assert.deepEqual([...found.definedAt].sort(), [...dropped.definedAt].sort());
      assert.match(found.reason, /R4|ignored/i);
    }
  });
} else {
  test('[synthetic] precedence oracle absent — synthetic coverage did not run', { skip: true }, () => {});
}

// ---------------------------------------------------------------------------
// [real] fixtures/files/settings-shape.json
//
// That file is a DESCRIPTOR, not a settings file: real values live under
// `.value`, beside `_shape`/`_note` metadata. These tests feed the extracted
// real values through the resolver. They are not "the real settings file ran".
// ---------------------------------------------------------------------------

const shape = readJson(path.join(filesDir, 'settings-shape.json'));
const realUserSettings = {
  enabledPlugins: shape['settings.json'].enabledPlugins.value,
  extraKnownMarketplaces: shape['settings.json'].extraKnownMarketplaces.value,
  // Values were redacted in the capture; only the key names survive.
  env: Object.fromEntries(shape['settings.json'].env.keyNames.map((k) => [k, 'redacted'])),
  // Captured as present with the literal value "latest" (_otherNotable).
  autoUpdatesChannel: 'latest',
};

test('[real] the 5 observed enabledPlugins entries resolve from user scope', () => {
  const data = resolveSettings([layer('user', realUserSettings)]);
  assert.deepEqual(Object.keys(data.enabledPlugins).sort(), [
    'everything-claude-code@everything-claude-code',
    'figma@claude-plugins-official',
    'frontend-design@claude-plugins-official',
    'superpowers@claude-plugins-official',
    'ui-ux-pro-max@ui-ux-pro-max-skill',
  ]);
  for (const value of Object.values(data.enabledPlugins)) {
    assert.equal(value.value, true);
    assert.equal(value.scope, 'user');
    assert.equal(value.source, 'file');
  }
});

test('[real] pluginConfigs absent on the reference machine resolves to an empty map', () => {
  assert.equal(shape['settings.json'].pluginConfigs.present, false);
  const data = resolveSettings([layer('user', realUserSettings)]);
  assert.deepEqual(data.pluginConfigs, {});
  assert.deepEqual(data.droppedInputs, []);
});

test('[real] 3 marketplaces in settings vs 4 on disk is not an error', () => {
  const data = resolveSettings([layer('user', realUserSettings)]);
  const known = Object.keys(readJson(path.join(filesDir, 'known_marketplaces.json')));
  const inSettings = Object.keys(data.extraKnownMarketplaces);

  assert.equal(inSettings.length, 3);
  assert.equal(known.length, 4);
  // The auto-installed official marketplace is the difference, by design.
  const missing = known.filter((name) => !inSettings.includes(name));
  assert.deepEqual(missing, ['claude-plugins-official']);
  // The gap is expected, so nothing is dropped and nothing is flagged.
  assert.deepEqual(data.droppedInputs, []);
});

test('[real] autoUpdatesChannel never surfaces as marketplace or plugin state', () => {
  const data = resolveSettings([layer('user', realUserSettings)]);
  const serialised = JSON.stringify(data);
  assert.equal(/autoupdate/i.test(serialised), false, 'autoUpdate* is CLI self-updater state');
  for (const value of Object.values(data.extraKnownMarketplaces)) {
    assert.deepEqual(Object.keys(value.value), ['source']);
  }
});

test('[real] unrecognised top-level settings keys are not carried into the output', () => {
  const data = resolveSettings([
    layer('user', { ...realUserSettings, theme: 'dark', alwaysThinkingEnabled: true }),
  ]);
  const serialised = JSON.stringify(data);
  assert.equal(serialised.includes('alwaysThinkingEnabled'), false);
  assert.equal(serialised.includes('"dark"'), false);
});

// ---------------------------------------------------------------------------
// [inline] Discovery, degradation, validation — behaviour no corpus covers
// ---------------------------------------------------------------------------

/** Root overrides pointing at a throwaway tree. */
const rootsIn = (root) => ({
  roots: {
    home: path.join(root, 'home'),
    projectDir: path.join(root, 'project'),
    managedBase: path.join(root, 'managed', 'managed-settings.json'),
  },
});

test('[inline] collect() discovers all four scopes by path', async (t) => {
  const root = makeSettingsTree(t, {
    'home/.claude/settings.json': { env: { A: 'user', U: 'user' } },
    'project/.claude/settings.json': { env: { A: 'project', P: 'project' } },
    'project/.claude/settings.local.json': { env: { A: 'local' } },
    'managed/managed-settings.json': { env: { A: 'managed', M: 'managed' } },
  });

  const result = await collectConfig({ offline: true }, rootsIn(root));
  assert.equal(result.ok, true);
  assert.equal(typeof result.elapsedMs, 'number');
  assert.ok(result.data);

  assert.equal(result.data.env.A.value, 'managed');
  assert.equal(result.data.env.A.scope, 'managed');
  assert.deepEqual(result.data.env.A.shadowed, ['local', 'project', 'user']);
  assert.equal(result.data.env.U.value, 'user');
  assert.equal(result.data.env.P.value, 'project');
  assert.equal(result.data.env.M.value, 'managed');

  const read = result.data.scopes.filter((s) => s.status === 'read').map((s) => s.scope);
  assert.deepEqual(read.sort(), ['local', 'managed', 'project', 'user']);
});

test('[inline] ~/.claude/settings.local.json is local scope, below project-local', async (t) => {
  const root = makeSettingsTree(t, {
    'home/.claude/settings.local.json': { env: { A: 'user-local', H: 'user-local' } },
    'project/.claude/settings.local.json': { env: { A: 'project-local' } },
  });

  const result = await collectConfig({ offline: true }, rootsIn(root));
  assert.equal(result.data.env.A.value, 'project-local');
  assert.equal(result.data.env.A.scope, 'local');
  assert.equal(result.data.env.H.value, 'user-local');
  assert.equal(result.data.env.H.scope, 'local');
});

test('[inline] managed-settings.d drop-ins outrank the base managed file', async (t) => {
  const root = makeSettingsTree(t, {
    'managed/managed-settings.json': { env: { A: 'base', B: 'base' } },
    'managed/managed-settings.d/10-first.json': { env: { A: 'first' } },
    'managed/managed-settings.d/20-second.json': { env: { A: 'second' } },
  });

  const result = await collectConfig({ offline: true }, rootsIn(root));
  assert.equal(result.data.env.A.value, 'second');
  assert.equal(result.data.env.B.value, 'base');
});

test('[inline] a malformed settings file degrades that scope, not the run', async (t) => {
  const root = makeSettingsTree(t, {
    'home/.claude/settings.json': '{ this is not json',
    'project/.claude/settings.json': { env: { P: 'project' } },
  });

  const result = await collectConfig({ offline: true }, rootsIn(root));
  assert.equal(result.ok, true, 'a broken file must not fail the collector');
  assert.equal(result.error, undefined);
  assert.equal(result.data.env.P.value, 'project');

  const user = result.data.scopes.find((s) => s.scope === 'user' && s.status === 'malformed');
  assert.ok(user, 'the malformed scope must be reported structurally');

  const degraded = result.warnings.filter((w) => w.subject === user.path);
  assert.equal(degraded.length, 1);
  // `partial`, not `collector-failed`: the collector lived, the scope did not.
  // Never `reconciliation` — T1.8 consumes that and this is not a conflict.
  assert.equal(degraded[0].code, 'partial');
  assert.equal(result.warnings.every((w) => w.code === 'partial'), true);
});

test('[inline] an unreadable path is reported as unreadable, not as absent', async (t) => {
  // A directory where a settings file should be: readFile fails with a code
  // other than ENOENT, which must not be mistaken for "no such settings".
  const root = makeSettingsTree(t, {
    'home/.claude/settings.json/keep': 'not a settings file',
    'project/.claude/settings.json': { env: { P: 'project' } },
  });

  const result = await collectConfig({ offline: true }, rootsIn(root));
  assert.equal(result.ok, true);
  assert.equal(result.data.env.P.value, 'project');

  const user = result.data.scopes.find((s) => s.scope === 'user');
  assert.equal(user.status, 'unreadable', `expected unreadable, got ${user.status}`);
  assert.equal(result.warnings.some((w) => /unreadable/.test(w.message)), true);
});

test('[inline] an entry dropped for two different causes reports both, once each', () => {
  // Invalid where it was permitted, ignored where it was not. Two distinct
  // facts about two distinct scopes: one record each, and no entry resolved.
  const data = resolveSettings([
    layer('user', { pluginConfigs: { 'a@m': 'not-an-object' } }),
    layer('project', { pluginConfigs: { 'a@m': { k: 'project' } } }),
  ]);
  assert.equal(Object.hasOwn(data.pluginConfigs, 'a@m'), false);

  const records = data.droppedInputs.filter((d) => d.entry === 'a@m');
  assert.equal(records.length, 2);
  const byType = records.find((d) => /type/i.test(d.reason));
  const byRule = records.find((d) => /ignored by rule/i.test(d.reason));
  assert.deepEqual(byType.definedAt, ['user']);
  assert.deepEqual(byRule.definedAt, ['project']);
});

test('[inline] the ignored-by-rule reason names --settings, not the internal scope', () => {
  const data = resolveSettings([layer('project', { pluginConfigs: { 'a@m': { k: 'p' } } })]);
  assert.equal(data.droppedInputs.length, 1);
  assert.match(data.droppedInputs[0].reason, /user, --settings, managed/);
  assert.equal(data.droppedInputs[0].reason.includes('session'), false);
});

test('[inline] collect() never throws across the boundary', async () => {
  const missing = path.join(tmpdir(), 'ccatlas-does-not-exist-' + Date.now());
  const result = await collectConfig({ fixtureRoot: missing, offline: true });
  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.data.enabledPlugins, {});
  assert.deepEqual(result.data.env, {});
  assert.ok(result.elapsedMs >= 0);
  assert.ok(result.data.scopes.every((s) => s.status === 'absent'));
  // Nothing read, so the result is knowingly incomplete rather than empty.
  assert.equal(result.warnings.every((w) => w.code === 'partial'), true);
});

test('[inline] absent pluginConfigs is reported as partial, never as empty', async (t) => {
  const root = makeSettingsTree(t, {
    'home/.claude/settings.json': { enabledPlugins: { 'a@m': true } },
  });

  const result = await collectConfig({ offline: true }, rootsIn(root));
  assert.deepEqual(result.data.pluginConfigs, {});

  const warning = result.warnings.find((w) => w.subject === 'pluginConfigs');
  assert.ok(warning, 'absent is not empty — say so');
  assert.equal(warning.code, 'partial');
  assert.match(warning.message, /unknown, not empty/);
});

test('[inline] an absent project-scope settings file is reported as partial', async (t) => {
  const root = makeSettingsTree(t, {
    'home/.claude/settings.json': { pluginConfigs: { 'a@m': { k: 'v' } } },
  });

  const result = await collectConfig({ offline: true }, rootsIn(root));
  const project = result.data.scopes.find((s) => s.scope === 'project');
  assert.equal(project.status, 'absent');

  const warning = result.warnings.find((w) => w.subject === project.path);
  assert.equal(warning.code, 'partial');
  assert.match(warning.message, /project-scope overrides are unknown/);
  // pluginConfigs was defined, so that warning must NOT also fire.
  assert.equal(result.warnings.some((w) => w.subject === 'pluginConfigs'), false);
});

test('[inline] a false enabled bit is never confused with an absent one', () => {
  const data = resolveSettings([
    layer('user', { enabledPlugins: { 'a@m': false } }),
    layer('project', { enabledPlugins: { 'b@m': true } }),
  ]);
  assert.equal(Object.hasOwn(data.enabledPlugins, 'a@m'), true);
  assert.equal(data.enabledPlugins['a@m'].value, false);
  assert.equal(data.enabledPlugins['a@m'].scope, 'user');
});

test('[inline] record values are replaced whole, never deep-merged', () => {
  const data = resolveSettings([
    layer('user', { extraKnownMarketplaces: { m: { source: { source: 'github', repo: 'a/b' } } } }),
    layer('managed', { extraKnownMarketplaces: { m: { source: { source: 'git', url: 'u' } } } }),
  ]);
  assert.deepEqual(data.extraKnownMarketplaces.m.value, { source: { source: 'git', url: 'u' } });
});

test('[inline] entries of the wrong type are dropped and reported', () => {
  const data = resolveSettings([
    layer('user', {
      enabledPlugins: { 'a@m': 'yes', 'b@m': true },
      env: { GOOD: 'x', BAD: 3 },
    }),
  ]);
  assert.deepEqual(Object.keys(data.enabledPlugins), ['b@m']);
  assert.deepEqual(Object.keys(data.env), ['GOOD']);
  assert.equal(data.droppedInputs.length, 2);
  for (const dropped of data.droppedInputs) {
    assert.match(dropped.reason, /type/i);
  }
});

test('[inline] a --settings layer may supply pluginConfigs; project may not', () => {
  const data = resolveSettings([
    layer('user', { pluginConfigs: { 'a@m': { k: 'user' } } }),
    layer('project', { pluginConfigs: { 'a@m': { k: 'project' }, 'p@m': { k: 'project' } } }),
    layer('session', { pluginConfigs: { 'a@m': { k: 'session' } } }),
  ]);
  assert.deepEqual(data.pluginConfigs['a@m'].value, { k: 'session' });
  assert.equal(data.pluginConfigs['a@m'].scope, 'session');
  assert.deepEqual(data.pluginConfigs['a@m'].ignored, ['project']);
  assert.equal(Object.hasOwn(data.pluginConfigs, 'p@m'), false);
});

test('[inline] permissionDecision — deny beats allow, ask beats allow, unset is unset', () => {
  const perms = resolveSettings([
    layer('user', { permissions: { allow: ['Bash(ls:*)', 'Bash(rm:*)'], ask: ['Bash(git push:*)'] } }),
    layer('managed', { permissions: { deny: ['Bash(rm:*)'] } }),
  ]).permissions;

  assert.equal(permissionDecision(perms, 'Bash(rm:*)'), 'deny');
  assert.equal(permissionDecision(perms, 'Bash(ls:*)'), 'allow');
  assert.equal(permissionDecision(perms, 'Bash(git push:*)'), 'ask');
  assert.equal(permissionDecision(perms, 'Bash(nothing:*)'), 'unset');
});

test('[inline] every permission rule keeps the scopes that contributed it', () => {
  const perms = resolveSettings([
    layer('user', { permissions: { allow: ['Bash(ls:*)'] } }),
    layer('project', { permissions: { allow: ['Bash(ls:*)', 'Read(**)'] } }),
  ]).permissions;

  const ls = perms.allow.find((r) => r.rule === 'Bash(ls:*)');
  assert.deepEqual(ls.scopes, ['project', 'user']);
  assert.deepEqual(perms.allow.find((r) => r.rule === 'Read(**)').scopes, ['project']);
});
