/**
 * T1.4 — the `skills` collector.
 *
 * Plain .mjs, no test framework, matching tests/collectors/config.test.mjs. The
 * TypeScript source is imported directly: Node 22.18 strips types by default
 * and the `test` script passes `--experimental-strip-types` for 22.13–22.17.
 *
 * Two ways in, and they are not interchangeable:
 *
 *   fixtureRoot   — the repository's `fixtures/` directory. The collector maps
 *                   it to `fixtures/synthetic/skills-dir-plugin`, which stands
 *                   in for `~/.claude`. Touches nothing else, by construction.
 *   options.roots — a throwaway tree under the OS temp dir, for behaviour no
 *                   committed corpus covers. `fixtureRoot` cannot do this job:
 *                   it names `fixtures/`, not a home directory.
 *
 * Nothing here reads the real ~/.claude.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CLI_BUILTIN_COMMANDS,
  SKILLS_DIR_FIXTURE,
  collectSkills,
  isCliBuiltinCommand,
  parseFrontmatter,
  skillsCollector,
} from '../../src/collectors/skills.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtureRoot = path.join(repoRoot, 'fixtures');

/** The @skills-dir oracle (T1.29). Its `./skills/` stands in for `~/.claude/skills/`. */
const syntheticRoot = path.join(fixtureRoot, ...SKILLS_DIR_FIXTURE.dir.split('/'));
const oracle = JSON.parse(readFileSync(path.join(syntheticRoot, 'expected-detection.json'), 'utf8'));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Builds a throwaway tree from a `{ 'rel/path': 'contents' }` spec. */
function makeTree(t, spec) {
  const root = mkdtempSync(path.join(tmpdir(), 'ccatlas-skills-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [rel, contents] of Object.entries(spec)) {
    const target = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return root;
}

/** A throwaway tree is a `$HOME`, so its component dirs live under `.claude/`. */
const homeTree = (t, spec) =>
  makeTree(t, Object.fromEntries(Object.entries(spec).map(([rel, body]) => [`.claude/${rel}`, body])));

const atHome = (home) => [{ offline: true }, { roots: { home } }];

function frontmatter(name, description) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`;
}

const ctx = (extra = {}) => ({ fixtureRoot, offline: true, ...extra });

const byName = (entities) => new Map(entities.map((e) => [e.id.name, e]));
const names = (entities) => entities.map((e) => e.id.name).sort();

/** The naive search trap 14 punishes: every file *named* plugin.json, anywhere. */
function countPluginJsonByFilename(dir) {
  let found = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) found += countPluginJsonByFilename(path.join(dir, entry.name));
    else if (entry.name === 'plugin.json') found += 1;
  }
  return found;
}

async function collectSynthetic() {
  const result = await collectSkills(ctx());
  assert.equal(result.ok, true, result.error?.message);
  return result;
}

// ---------------------------------------------------------------------------
// contract
// ---------------------------------------------------------------------------

test('exposes the Collector contract under the frozen name', () => {
  assert.equal(skillsCollector.name, 'skills');
  assert.equal(typeof skillsCollector.collect, 'function');
});

test('a missing ~/.claude is empty and ok, not an error', async (t) => {
  const home = makeTree(t, {});
  const result = await collectSkills(...atHome(home));

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.skills, []);
  assert.deepEqual(result.data.agents, []);
  assert.deepEqual(result.data.commands, []);
  assert.deepEqual(result.data.skillsDirPlugins, []);
  assert.deepEqual(result.warnings, []);
  assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0);
});

test('an unreadable root degrades loudly; an absent one is silent', async (t) => {
  // A file where a directory is expected (ENOTDIR): the walk must degrade, not
  // reject — but it must never report "no skills here" without saying why.
  const home = homeTree(t, {
    skills: 'this is a file, not a directory',
    'commands/plan.md': frontmatter('plan', 'unaffected'),
  });
  await assert.doesNotReject(() => collectSkills(...atHome(home)));
  const result = await collectSkills(...atHome(home));

  assert.equal(result.ok, true);
  assert.equal(result.data.skills.length, 0);
  assert.deepEqual(names(result.data.commands), ['plan'], 'one bad root must not stop the others');

  // agents/ is simply absent — normal, and not worth a warning.
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, 'partial');
  assert.equal(result.warnings[0].subject, path.join(home, '.claude', 'skills'));
  assert.match(result.warnings[0].message, /unreadable directory/);
});

test('fixture mode reads fixtures/ and nothing else', async () => {
  // The settled meaning of fixtureRoot: the repository's fixtures/ directory.
  // A project in the context must not pull the walk onto a real tree.
  const { data } = await collectSkills(
    ctx({ project: { key: 'c:/nope', rawKeys: ['C:\\nope'], displayPath: 'C:\\nope', collides: false } }),
  );

  const all = [...data.skills, ...data.agents, ...data.commands];
  assert.ok(all.length > 0);
  for (const entity of all) assert.ok(entity.path.startsWith(syntheticRoot), entity.path);
  assert.equal(data.skillsDirPlugins[0].path.startsWith(syntheticRoot), true);
});

test('fixture mode still honours an explicit roots.projectDir', async (t) => {
  // The corpus has no project-scope fixture, so without this opt-out the
  // project branch would be untestable whenever fixtureRoot is set.
  const projectDir = makeTree(t, {
    '.claude/skills/opted-in/SKILL.md': frontmatter('opted-in', 'explicit override'),
  });
  const { data } = await collectSkills(ctx(), { roots: { projectDir } });

  const opted = byName(data.skills).get('opted-in');
  assert.equal(opted.id.scope, 'project');
  assert.ok(data.skills.some((s) => s.path.startsWith(syntheticRoot)), 'fixture user root still read');
});

// ---------------------------------------------------------------------------
// trap 1 — @skills-dir plugin detection (fixture: fixtures/synthetic/skills-dir-plugin)
// ---------------------------------------------------------------------------

test('trap 1: detects the @skills-dir plugin by .claude-plugin/plugin.json', async () => {
  const { data } = await collectSynthetic();

  assert.equal(data.skillsDirPlugins.length, oracle.counts.pluginsDetected);

  const [plugin] = data.skillsDirPlugins;
  const expected = oracle.expected.find((e) => e.isPlugin);
  assert.equal(plugin.name, expected.name);
  assert.equal(plugin.origin, 'skills-dir');
  assert.equal(plugin.version.version, expected.version);
  assert.equal(plugin.version.versionSource, expected.versionSource);
  assert.equal(plugin.source, 'file');
  assert.equal(plugin.manifestPath, path.resolve(syntheticRoot, expected.manifest));
  assert.equal(plugin.parseError, undefined);
});

test('trap 1: the plugin contributes skills, agents and commands', async () => {
  const { data } = await collectSynthetic();
  const [plugin] = data.skillsDirPlugins;
  const expected = oracle.expected.find((e) => e.isPlugin).contributes;

  assert.equal(plugin.contributes.skills, expected.skills.length);
  assert.equal(plugin.contributes.agents, expected.agents.length);
  assert.equal(plugin.contributes.commands, expected.commands.length);

  const owned = (list) => list.filter((e) => e.owningPlugin === plugin.name);
  assert.deepEqual(names(owned(data.skills)), [...expected.skills].sort());
  assert.deepEqual(names(owned(data.agents)), [...expected.agents].sort());
  assert.deepEqual(names(owned(data.commands)), [...expected.commands].sort());
  for (const entity of [...owned(data.skills), ...owned(data.agents), ...owned(data.commands)]) {
    assert.equal(entity.origin, 'skills-dir');
  }
});

test('trap 1: a skill nested two levels below the root is found, and only once', async () => {
  const { data } = await collectSynthetic();
  const alpha = data.skills.filter((s) => s.id.name === 'synthetic-alpha-skill');

  assert.equal(alpha.length, 1, 'plugin-owned skill must be reported exactly once');
  assert.equal(alpha[0].origin, 'skills-dir');
  assert.equal(alpha[0].owningPlugin, 'synthetic-skills-dir-plugin');
  assert.equal(
    alpha[0].path,
    path.join(syntheticRoot, 'skills', 'synthetic-skills-dir-plugin', 'skills', 'synthetic-alpha-skill', 'SKILL.md'),
  );
});

test('trap 1: the three non-plugin directories stay personal', async () => {
  const { data } = await collectSynthetic();
  const personal = data.skills.filter((s) => s.origin === 'personal');

  assert.equal(personal.length, oracle.counts.personalSkillDirectories);
  const expected = oracle.expected.filter((e) => !e.isPlugin).map((e) => path.basename(e.path));
  assert.deepEqual(names(personal), [...expected].sort());
  for (const skill of personal) assert.equal(skill.owningPlugin, undefined);
});

// ---------------------------------------------------------------------------
// trap 14 — sibling manifests (.cursor-plugin / .codex-plugin / .kimi-plugin)
// ---------------------------------------------------------------------------

test('trap 14: a filename search finds 6 manifests; the collector reports 1 plugin', async () => {
  const naive = countPluginJsonByFilename(path.join(syntheticRoot, 'skills'));
  assert.equal(
    naive,
    oracle.counts.filesNamedPluginJsonAnywhereUnderRoot,
    'fixture drifted: the trap-14 decoys are what make this test meaningful',
  );

  const { data } = await collectSynthetic();
  assert.equal(data.skillsDirPlugins.length, 1);
});

test('trap 14: a foreign manifest alone does not make a plugin', async () => {
  const { data } = await collectSynthetic();
  const decoy = byName(data.skills).get('synthetic-decoy-only');

  assert.equal(decoy.origin, 'personal');
  assert.equal(data.skillsDirPlugins.some((p) => p.name === 'synthetic-decoy-only'), false);
});

test('trap 14: a manifest at the directory root does not make a plugin', async () => {
  const { data } = await collectSynthetic();
  const misplaced = byName(data.skills).get('synthetic-misplaced-manifest');

  assert.equal(misplaced.origin, 'personal');
  assert.equal(data.skillsDirPlugins.some((p) => p.name === 'synthetic-misplaced-manifest'), false);
});

test('trap 14: nothing inside a dot-manifest directory is emitted as an entity', async () => {
  const { data } = await collectSynthetic();
  const all = [...data.skills, ...data.agents, ...data.commands];
  for (const entity of all) {
    assert.equal(/[\\/]\.(claude|cursor|codex|kimi)-plugin[\\/]/.test(entity.path), false, entity.path);
  }
});

// ---------------------------------------------------------------------------
// trap 3 — a bare name says nothing about the owner
// ---------------------------------------------------------------------------

test('trap 3: bare names span both origins; the colon says nothing either', async (t) => {
  const { data } = await collectSynthetic();
  const alpha = data.skills.find((s) => s.id.name === 'synthetic-alpha-skill');
  const personalBravo = data.skills.find((s) => s.origin === 'personal' && s.id.name === 'synthetic-bravo-skill');

  // Bare name, plugin-owned.
  assert.equal(alpha.id.name.includes(':'), false);
  assert.equal(alpha.origin, 'skills-dir');
  // Bare name, personal. Identical name shape, different origin: only the
  // inventory can attribute an owner.
  assert.equal(personalBravo.id.name.includes(':'), false);
  assert.equal(personalBravo.origin, 'personal');

  // And a namespaced command is personal, so a colon does not mean "plugin".
  const home = homeTree(t, { 'commands/sparc/tdd.md': '# SPARC TDD Mode\n' });
  const nested = (await collectSkills(...atHome(home))).data.commands[0];
  assert.equal(nested.id.name, 'sparc:tdd');
  assert.equal(nested.origin, 'personal');
  assert.equal(nested.owningPlugin, undefined);
});

test('shadowed names are both reported, and no winner is picked here', async () => {
  const { data } = await collectSynthetic();
  const bravo = data.skills.filter((s) => s.id.name === 'synthetic-bravo-skill');

  assert.equal(bravo.length, 2, 'both definitions must survive — T1.7 resolves precedence');
  assert.deepEqual(bravo.map((s) => s.origin).sort(), ['personal', 'skills-dir']);
  for (const entity of bravo) {
    assert.equal(entity.shadows, undefined);
    assert.equal(entity.shadowedBy, undefined);
    assert.equal(entity.state, 'enabled');
  }
});

// ---------------------------------------------------------------------------
// trap 4 — CLI built-in commands
// ---------------------------------------------------------------------------

test('trap 4: the six CLI built-ins are recognised, and nothing else is', () => {
  assert.deepEqual(
    [...CLI_BUILTIN_COMMANDS].sort(),
    ['clear', 'compact', 'effort', 'mcp', 'model', 'plugin'],
  );
  for (const builtin of CLI_BUILTIN_COMMANDS) {
    assert.equal(isCliBuiltinCommand(builtin), true);
    assert.equal(isCliBuiltinCommand(`/${builtin}`), true);
  }
  for (const real of ['plan', 'sparc:tdd', 'synthetic-report', 'compacted']) {
    assert.equal(isCliBuiltinCommand(real), false);
  }
});

test('trap 4: built-ins are never synthesised as entities', async () => {
  const { data } = await collectSynthetic();
  for (const command of data.commands) assert.equal(isCliBuiltinCommand(command.id.name), false);
});

test('trap 4: a real commands/clear.md is kept and flagged, not declared shadowed', async (t) => {
  const home = homeTree(t, { 'commands/clear.md': frontmatter('clear', 'a real file on disk') });
  const { data } = await collectSkills(...atHome(home));

  const [command] = data.commands;
  assert.equal(command.id.name, 'clear');
  assert.equal(command.collidesWithCliBuiltin, true);
  // The built-in is not a file, so precedence is not this collector's to assert.
  assert.equal(command.state, 'enabled');
  assert.equal(command.shadowedBy, undefined);
});

// ---------------------------------------------------------------------------
// naming, scope and frontmatter
// ---------------------------------------------------------------------------

test('commands are namespaced by directory; agents are not', async (t) => {
  const home = homeTree(t, {
    'commands/plan.md': frontmatter('plan', 'top-level command'),
    'commands/sparc/tdd.md': '# SPARC TDD Mode\n\nNo frontmatter at all.\n',
    'commands/a/b/deep.md': frontmatter('deep', 'two directories down'),
    'agents/reviewer.md': frontmatter('reviewer', 'top-level agent'),
    'agents/swarm/adaptive-coordinator.md': frontmatter('adaptive-coordinator', 'nested agent'),
  });
  const { data } = await collectSkills(...atHome(home));

  assert.deepEqual(names(data.commands), ['a:b:deep', 'plan', 'sparc:tdd']);
  assert.deepEqual(names(data.agents), ['adaptive-coordinator', 'reviewer']);

  const tdd = byName(data.commands).get('sparc:tdd');
  assert.equal(tdd.description, undefined, 'no frontmatter is normal, not a failure');
  assert.equal(tdd.parseError, undefined);
  assert.equal(tdd.state, 'enabled');
});

test('frontmatter survives CRLF, colons in the value, and a BOM', () => {
  const parsed = parseFrontmatter('﻿---\r\nname: x\r\ndescription: Use when: a, b: c\r\n---\r\nbody\r\n');
  assert.equal(parsed.name, 'x');
  assert.equal(parsed.description, 'Use when: a, b: c');
  assert.equal(parsed.error, undefined);
});

test('a --- rule inside the body is not frontmatter', () => {
  const parsed = parseFrontmatter('# Title\n\nsome prose\n\n---\n\nname: not-frontmatter\n');
  assert.equal(parsed.name, undefined);
  assert.equal(parsed.description, undefined);
  assert.equal(parsed.error, undefined);
});

test('names fall back to the path when frontmatter omits them', async (t) => {
  const home = homeTree(t, {
    'skills/no-name-skill/SKILL.md': '---\ndescription: has a description only\n---\n',
    'agents/no-name-agent.md': '---\ndescription: likewise\n---\n',
  });
  const { data } = await collectSkills(...atHome(home));

  assert.equal(data.skills[0].id.name, 'no-name-skill');
  assert.equal(data.skills[0].description, 'has a description only');
  assert.equal(data.agents[0].id.name, 'no-name-agent');
});

test('one malformed SKILL.md degrades that entry, not the run', async (t) => {
  const home = homeTree(t, {
    'skills/broken/SKILL.md': '---\nname: broken\ndescription: never closed\n',
    'skills/intact/SKILL.md': frontmatter('intact', 'unaffected'),
  });
  const { data, ok, warnings } = await collectSkills(...atHome(home));

  assert.equal(ok, true);

  const broken = byName(data.skills).get('broken');
  assert.equal(broken.state, 'error');
  assert.match(broken.parseError, /frontmatter/i);

  // A degraded entry is visible to a reader who only looks at `warnings`.
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'partial');
  assert.equal(warnings[0].subject, path.join(home, '.claude', 'skills', 'broken', 'SKILL.md'));

  const intact = byName(data.skills).get('intact');
  assert.equal(intact.state, 'enabled');
  assert.equal(intact.description, 'unaffected');
});

test('a malformed plugin.json still reports the plugin, with an unknown version', async (t) => {
  const home = homeTree(t, {
    'skills/half-broken/.claude-plugin/plugin.json': '{ "name": "half-broken", ',
    'skills/half-broken/skills/inner/SKILL.md': frontmatter('inner', 'still collected'),
  });
  const { data, ok } = await collectSkills(...atHome(home));

  assert.equal(ok, true);
  const [plugin] = data.skillsDirPlugins;
  assert.equal(plugin.name, 'half-broken', 'falls back to the directory name');
  assert.equal(plugin.version.version, 'unknown');
  assert.equal(plugin.version.versionSource, 'unknown');
  assert.match(plugin.parseError, /json/i);
  assert.equal(byName(data.skills).get('inner').owningPlugin, 'half-broken');
});

test('project scope is collected under .claude and tagged project', async (t) => {
  const projectDir = makeTree(t, {
    '.claude/skills/project-skill/SKILL.md': frontmatter('project-skill', 'project scoped'),
    '.claude/agents/project-agent.md': frontmatter('project-agent', 'project scoped'),
    '.claude/commands/project-command.md': frontmatter('project-command', 'project scoped'),
  });
  const home = homeTree(t, { 'skills/user-skill/SKILL.md': frontmatter('user-skill', 'user scoped') });

  // `ctx.project` is the production path; `roots.projectDir` only overrides it.
  const { data } = await collectSkills(
    {
      offline: true,
      project: {
        key: projectDir.toLowerCase().replaceAll('\\', '/'),
        rawKeys: [projectDir],
        displayPath: projectDir,
        collides: false,
      },
    },
    { roots: { home } },
  );

  assert.deepEqual(names(data.skills), ['project-skill', 'user-skill']);
  assert.equal(byName(data.skills).get('project-skill').id.scope, 'project');
  assert.equal(byName(data.skills).get('project-skill').origin, 'project');
  assert.equal(byName(data.skills).get('user-skill').id.scope, 'user');
  assert.equal(data.agents[0].id.scope, 'project');
  assert.equal(data.commands[0].id.scope, 'project');
});

test('every fact is tagged source: file, with the right kind', async () => {
  const { data } = await collectSynthetic();

  for (const skill of data.skills) {
    assert.equal(skill.source, 'file');
    assert.equal(skill.id.kind, 'skill');
    assert.equal(skill.id.scope, 'user');
  }
  for (const agent of data.agents) {
    assert.equal(agent.source, 'file');
    assert.equal(agent.id.kind, 'agent');
  }
  for (const command of data.commands) {
    assert.equal(command.source, 'file');
    assert.equal(command.id.kind, 'command');
  }
  for (const plugin of data.skillsDirPlugins) assert.equal(plugin.source, 'file');
});

test('output is deterministic and read-only', async () => {
  const before = readdirSync(path.join(syntheticRoot, 'skills')).sort();
  const first = await collectSkills(ctx());
  const second = await collectSkills(ctx());

  assert.deepEqual(first.data.skills, second.data.skills);
  assert.deepEqual(first.data.commands, second.data.commands);
  assert.deepEqual(readdirSync(path.join(syntheticRoot, 'skills')).sort(), before);
});
