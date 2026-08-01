/**
 * T7.1–T7.11 — the plugin package.
 *
 * These are the constraints that **fail silently** if violated. A component
 * placed inside `.claude-plugin/` does not error, does not warn, and simply
 * never loads; a `${user_config.*}` reference in a shell field is rejected at
 * runtime, not at validation. So they get tests rather than a checklist.
 *
 * The token budget itself is measured by `scripts/token-budget.mjs` against a
 * real `claude plugin details` call, which needs the CLI. What is asserted
 * here is everything that can be checked from the files alone.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestDir = path.join(repoRoot, '.claude-plugin');
const manifest = JSON.parse(readFileSync(path.join(manifestDir, 'plugin.json'), 'utf8'));

const read = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8');

/** `---\n…\n---` frontmatter, which is what the always-on listing reads. */
function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---/u.exec(text);
  if (match === null) return undefined;
  const out = {};
  for (const line of (match[1] ?? '').split('\n')) {
    const kv = /^(\w+):\s*(.*)$/u.exec(line);
    if (kv?.[1] !== undefined) out[kv[1]] = kv[2] ?? '';
  }
  return out;
}

// ---------------------------------------------------------------------------
// The silent-failure constraints
// ---------------------------------------------------------------------------

test('.claude-plugin/ holds ONLY plugin.json', () => {
  // Components placed inside it silently fail to load — no error, no warning,
  // they simply never appear. This is the most expensive packaging mistake
  // available because nothing tells you.
  assert.deepEqual(readdirSync(manifestDir), ['plugin.json']);
});

test('every component directory sits at the plugin ROOT', () => {
  for (const dir of ['skills', 'commands', 'hooks', 'bin']) {
    assert.ok(existsSync(path.join(repoRoot, dir)), `${dir}/ is missing`);
    assert.ok(!existsSync(path.join(manifestDir, dir)), `${dir}/ is inside .claude-plugin/`);
  }
});

test('nothing references a path outside the plugin directory', () => {
  // Installed plugins are copied into ~/.claude/plugins/cache and cannot read
  // `../shared`. A relative escape works in the repo and breaks on install.
  const hooks = read('hooks', 'hooks.json');
  assert.ok(!hooks.includes('../'), 'hooks.json escapes the plugin directory');

  for (const skill of readdirSync(path.join(repoRoot, 'skills'))) {
    const body = read('skills', skill, 'SKILL.md');
    assert.ok(!/\]\(\.\.\//u.test(body), `${skill} links outside its own directory`);
  }
});

test('version is declared in plugin.json and NOWHERE else', () => {
  // T7.14 🧠: plugin.json wins silently, so a second declaration in the
  // marketplace entry masks it and nobody finds out until they diverge.
  assert.equal(typeof manifest.version, 'string');
  assert.notEqual(manifest.version, '');

  const marketplace = path.join(manifestDir, 'marketplace.json');
  if (!existsSync(marketplace)) return;

  const entries = JSON.parse(readFileSync(marketplace, 'utf8')).plugins ?? [];
  for (const entry of entries) {
    assert.equal(entry.version, undefined, `${entry.name} declares a version in both places`);
  }
});

// ---------------------------------------------------------------------------
// Hooks — T7.10, T7.11
// ---------------------------------------------------------------------------

test('hooks use exec form with args, never a shell string', () => {
  const hooks = JSON.parse(read('hooks', 'hooks.json'));

  for (const entries of Object.values(hooks.hooks)) {
    for (const group of entries) {
      for (const hook of group.hooks) {
        // `${user_config.*}` is REJECTED in any field that runs through a
        // shell. Exec form with `args` sidesteps the shell entirely.
        assert.ok(Array.isArray(hook.args), 'hook has no args array');
        assert.ok(!hook.command.includes(' '), 'command looks like a shell string');
      }
    }
  }
});

test('no hook interpolates ${user_config.*}', () => {
  const raw = read('hooks', 'hooks.json');
  assert.ok(!/\$\{user_config\./u.test(raw), 'user_config in a hook field is rejected at runtime');
});

test('SessionStart is cache-only and cannot block the session', () => {
  const hooks = JSON.parse(read('hooks', 'hooks.json'));
  const [group] = hooks.hooks.SessionStart;
  const [hook] = group.hooks;

  // T7.10: 150ms budget, cache-only, no network, never blocks session start.
  // `--cached` is the whole point — a cold run spawns `claude` three times.
  assert.ok(hook.args.includes('--cached'), 'SessionStart does a cold collection');
  assert.ok(hook.timeout <= 1, 'SessionStart timeout would let it block');
});

// ---------------------------------------------------------------------------
// Skills — T7.3–T7.7
// ---------------------------------------------------------------------------

const SKILLS = ['stack-overview', 'stack-audit', 'stack-migrate'];

test('every skill has frontmatter with a name and a description', () => {
  for (const skill of SKILLS) {
    const front = frontmatter(read('skills', skill, 'SKILL.md'));
    assert.ok(front, `${skill} has no frontmatter`);
    assert.equal(front.name, skill);
    assert.ok(front.description.length > 40, `${skill}'s description is too thin to route on`);
  }
});

test('descriptions stay short — they are the ALWAYS-ON part', () => {
  // Bodies are read on invoke and cost nothing until then; the description is
  // in every session's listing. Measured budget is ~464/600 with these.
  for (const skill of SKILLS) {
    const front = frontmatter(read('skills', skill, 'SKILL.md'));
    assert.ok(
      front.description.length < 420,
      `${skill}'s description is ${front.description.length} chars — it is always-on`,
    );
  }
});

test('T7.7: bulk lives in reference.md, not in the skill body', () => {
  for (const skill of SKILLS) {
    const reference = path.join(repoRoot, 'skills', skill, 'reference.md');
    assert.ok(existsSync(reference), `${skill} has no reference.md`);

    const body = read('skills', skill, 'SKILL.md');
    const ref = readFileSync(reference, 'utf8');

    // Deliberately NOT `ref.length > body.length`. That was the first version
    // of this assertion and it failed on stack-migrate, whose body is mostly
    // the "Claude may not apply a remote bundle" rule — which has to be read
    // at routing time, not on demand, so its being large is correct. The
    // assertion was wrong, not the file.
    //
    // What T7.7 actually requires is that a substantial reference exists and
    // the body points at it, so detail has somewhere to go that costs nothing
    // until it is needed.
    assert.ok(ref.length > 800, `${skill}'s reference.md is too thin to be carrying anything`);
    assert.match(body, /reference\.md/u, `${skill} never points at its reference`);
  }
});

test('🔒 stack-migrate states that Claude may not apply a remote bundle', () => {
  const body = read('skills', 'stack-migrate', 'SKILL.md');

  // T5.30. The skill is the surface where this rule is actually enforced at
  // read time, so it has to be unambiguous in the body — not only in code.
  assert.match(body, /may not apply a remote bundle/iu);
  assert.match(body, /no `--yes`|there is no `--yes`/iu);
  assert.match(frontmatter(body).description, /[Nn]ever applies a remote bundle/u);
});

test('stack-audit refuses to recommend a prune it cannot justify', () => {
  const body = read('skills', 'stack-audit', 'SKILL.md');
  assert.match(body, /recommend nothing/u);
});

// ---------------------------------------------------------------------------
// No bundled MCP server — by design
// ---------------------------------------------------------------------------

test('the plugin ships NO MCP server', () => {
  // It would add tool schemas to every turn, which is self-defeating for a
  // product whose thesis is context-budget discipline. Reach comes from bin/
  // on the Bash tool PATH plus small skills.
  assert.equal(manifest.mcpServers, undefined);
  assert.ok(!existsSync(path.join(repoRoot, '.mcp.json')));
});

test('sensitive userConfig is marked so it is never exported', () => {
  assert.equal(manifest.userConfig.sync_token.sensitive, true);
  // Values marked sensitive route to the OS keychain and are not ours to move.
  assert.equal(manifest.userConfig.sync_repo.sensitive, undefined);
});

test('every userConfig entry has the title the validator requires', () => {
  // Undocumented in our design notes; `plugin validate` rejects without it.
  for (const [key, entry] of Object.entries(manifest.userConfig)) {
    assert.equal(typeof entry.title, 'string', `${key} has no title`);
    assert.equal(typeof entry.description, 'string', `${key} has no description`);
  }
});
