#!/usr/bin/env node
// fixtures/synthetic/generate.mjs — the reference-scale tree generator and the
// whole-directory invariant checker. Zero dependencies; node:* only.
//
//   node fixtures/synthetic/generate.mjs build              regenerate scale/tree/ + secrets/entropy-report.json
//   node fixtures/synthetic/generate.mjs verify             assert everything below; exit 1 on any failure
//   node fixtures/synthetic/generate.mjs materialize <dir>  write a walkable copy with absolute paths resolved
//
// `verify` is the gate. It asserts:
//   V1  regenerating scale/tree/ is byte-identical to what is committed
//   V2  every installed_plugins.json key has an enabledPlugins entry, and vice versa
//   V3  every installPath resolves to a directory holding .claude-plugin/plugin.json
//   V4  every marketplace named in a plugin key exists in known_marketplaces.json and has a clone manifest
//   V5  every .in_use under cache/ is a DIRECTORY (FORMATS.md §0 trap #11)
//   V6  the tree meets every reference-scale floor in seed.json
//   V7  orphan cache directories are absent from installed_plugins.json
//   V8  every entropy figure quoted in secrets/*.json matches recomputation
//   V9  every credential-shaped string anywhere under fixtures/synthetic/ carries the SYNTHETIC sentinel

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync, readdirSync, utimesSync } from 'node:fs';
import { join, dirname, resolve, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTree, mtimePlan, TREE_ROOT } from './lib/tree.mjs';
import { entropy4, walkStrings, CREDENTIAL_SHAPED, SENTINEL } from './lib/entropy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TREE_DIR = join(HERE, 'scale', 'tree');
const SEED = JSON.parse(readFileSync(join(HERE, 'scale', 'seed.json'), 'utf8'));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const failures = [];
const fail = (check, msg) => failures.push(`${check}: ${msg}`);
const ok = (check, msg) => console.log(`  ok   ${check}  ${msg}`);

// ---------------------------------------------------------------- filesystem

/**
 * Resolve <TREE_ROOT> and the committed Windows separators to real, native
 * ones. Inside a .json file both live in STRING LITERALS, so the replacement
 * has to be JSON-escaped or the result stops parsing — the committed bytes hold
 * `\\` for one separator.
 */
function materializeContent(rel, content, root) {
  if (!rel.endsWith('.json')) return content.replaceAll(TREE_ROOT, root).replaceAll('\\', sep);
  const jsonRoot = JSON.stringify(root).slice(1, -1);
  const jsonSep = JSON.stringify(sep).slice(1, -1);
  return content.replaceAll(TREE_ROOT, jsonRoot).replaceAll('\\\\', jsonSep);
}

function writeFiles(root, files, { native = false } = {}) {
  for (const [rel, content] of files) {
    const target = join(root, ...rel.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, native ? materializeContent(rel, content, root) : content);
  }
}

function listFiles(root, prefix = '') {
  if (!existsSync(root)) return [];
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(root, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

function applyMtimes(root) {
  for (const [rel, ms] of mtimePlan(SEED)) {
    const target = join(root, ...rel.split('/'));
    if (existsSync(target)) utimesSync(target, new Date(ms), new Date(ms));
  }
}

// -------------------------------------------------------------------- entropy

const SECRET_FILES = [
  'secrets/mcp-json-with-credentials.json',
  'secrets/claude-json-mcp-fragment.json',
  'secrets/settings-env-with-credentials.json',
];

/** Every credential-shaped string in the three positive files, with measured entropy. */
function measurePositives() {
  const rows = [];
  for (const rel of SECRET_FILES) {
    for (const { path, value } of walkStrings(readJson(join(HERE, ...rel.split('/'))))) {
      if (path.startsWith('$.__')) continue;
      if (!CREDENTIAL_SHAPED.test(value) && value.length < 32) continue;
      rows.push({ file: rel, path, length: value.length, entropyBitsPerChar: entropy4(value), sentinel: value.includes(SENTINEL) });
    }
  }
  return rows.sort((a, b) => (a.file + a.path).localeCompare(b.file + b.path));
}

function measureNegatives() {
  const negatives = readJson(join(HERE, 'secrets', 'negative-cases.json'));
  return negatives.cases.map((c) => ({ id: c.id, length: c.value.length, entropyBitsPerChar: entropy4(c.value), declared: c.shannonEntropyBitsPerChar ?? null }));
}

function entropyReport() {
  return {
    __synthetic: true,
    __models: {
      gap: 'docs/FORMATS.md §5 — no positive secret fixture existed; every entropy figure in secrets/*.json is MEASURED, never estimated',
      unblocks: ['T1.16'],
      generatedBy: 'node fixtures/synthetic/generate.mjs build',
      metric: 'Shannon entropy over each value\'s own character distribution, bits per character, rounded to 4 decimals',
      positivesScope: 'Every string in the three positive files that is EITHER credential-shaped OR >=32 chars. The length arm deliberately sweeps in benign long strings (npm package names, git URLs) so their entropy sits in the same table as the credentials — that side-by-side comparison is the point. `sentinel: false` on such a row is expected and correct; check V9 is what enforces the sentinel on credential-shaped strings.',
    },
    positives: measurePositives(),
    negatives: measureNegatives(),
  };
}

// --------------------------------------------------------------------- checks

function checkTreeBytes(files) {
  const onDisk = new Set(listFiles(TREE_DIR));
  const expected = new Set(files.keys());
  for (const rel of expected) if (!onDisk.has(rel)) fail('V1', `missing from scale/tree/: ${rel}`);
  for (const rel of onDisk) if (!expected.has(rel)) fail('V1', `unexpected file in scale/tree/: ${rel}`);
  let drifted = 0;
  for (const [rel, content] of files) {
    const target = join(TREE_DIR, ...rel.split('/'));
    if (existsSync(target) && readFileSync(target, 'utf8') !== content) {
      fail('V1', `byte drift: ${rel}`);
      drifted++;
    }
  }
  if (!drifted && expected.size === onDisk.size) ok('V1', `${expected.size} files regenerate byte-identically`);
}

function checkBookkeeping() {
  const installed = readJson(join(TREE_DIR, 'home/.claude/plugins/installed_plugins.json'));
  const settings = readJson(join(TREE_DIR, 'home/.claude/settings.json'));
  const known = readJson(join(TREE_DIR, 'home/.claude/plugins/known_marketplaces.json'));
  const enabled = settings.enabledPlugins;

  for (const key of Object.keys(installed.plugins)) {
    if (!(key in enabled)) fail('V2', `installed but absent from enabledPlugins: ${key}`);
  }
  for (const key of Object.keys(enabled)) {
    if (!(key in installed.plugins)) fail('V2', `enabledPlugins key with no install record: ${key}`);
  }
  if (!failures.some((f) => f.startsWith('V2'))) ok('V2', `${Object.keys(enabled).length} plugins agree across installed_plugins.json and enabledPlugins`);

  let records = 0;
  for (const [key, arr] of Object.entries(installed.plugins)) {
    if (!Array.isArray(arr)) fail('V3', `installed_plugins value is not an array (trap #12): ${key}`);
    for (const rec of arr) {
      records++;
      const dir = join(TREE_DIR, ...rec.installPath.replace(TREE_ROOT + '\\', '').split('\\'));
      if (!existsSync(join(dir, '.claude-plugin', 'plugin.json'))) fail('V3', `installPath has no .claude-plugin/plugin.json: ${key} (${rec.scope})`);
      if (!existsSync(join(dir, '.in_use'))) fail('V5', `no .in_use under ${key} (${rec.scope})`);
      else if (!statSync(join(dir, '.in_use')).isDirectory()) fail('V5', `.in_use is not a directory: ${key}`);
    }
    const marketplace = key.slice(key.lastIndexOf('@') + 1);
    if (!(marketplace in known)) fail('V4', `marketplace not in known_marketplaces.json: ${marketplace}`);
    else if (!existsSync(join(TREE_DIR, 'home/.claude/plugins/marketplaces', marketplace, '.claude-plugin', 'marketplace.json'))) {
      fail('V4', `marketplace clone has no manifest: ${marketplace}`);
    }
  }
  if (!failures.some((f) => f.startsWith('V3'))) ok('V3', `${records} install records resolve to a real cache directory`);
  if (!failures.some((f) => f.startsWith('V4'))) ok('V4', `${Object.keys(known).length} marketplaces resolve to a clone manifest`);
  if (!failures.some((f) => f.startsWith('V5'))) ok('V5', '.in_use is a directory everywhere under cache/');
}

function checkScale() {
  const floors = SEED.referenceScaleFloors;
  const pluginSkills = SEED.plugins.reduce((n, p) => n + (p.skills?.length ?? 0), 0);
  const bundledMcp = SEED.plugins.reduce((n, p) => n + (p.mcpServers?.length ?? 0), 0);
  const actual = {
    marketplaces: SEED.marketplaces.length,
    plugins: SEED.plugins.length,
    skills: SEED.personalSkills + pluginSkills,
    mcpServers: SEED.userScopeMcpServers.length + SEED.projectScopeMcpServers.length + bundledMcp,
  };
  for (const [dim, floor] of Object.entries(floors)) {
    if (dim.startsWith('__')) continue;
    if (actual[dim] < floor) fail('V6', `${dim}: ${actual[dim]} < reference floor ${floor}`);
  }
  if (!failures.some((f) => f.startsWith('V6'))) {
    ok('V6', `scale ${actual.marketplaces} mkts / ${actual.plugins} plugins / ${actual.skills} skills / ${actual.mcpServers} MCP servers (floors ${floors.marketplaces}/${floors.plugins}/${floors.skills}/${floors.mcpServers})`);
  }
}

function checkOrphans() {
  const installed = readJson(join(TREE_DIR, 'home/.claude/plugins/installed_plugins.json'));
  const live = new Set(Object.values(installed.plugins).flat().map((r) => r.installPath));
  let orphans = 0;
  for (const p of SEED.plugins) {
    for (const v of p.orphanVersions ?? []) {
      const path = [TREE_ROOT, 'home', '.claude', 'plugins', 'cache', p.marketplace, p.name, v].join('\\');
      if (live.has(path)) fail('V7', `orphan version is referenced by installed_plugins.json: ${p.name}@${v}`);
      if (!existsSync(join(TREE_DIR, 'home/.claude/plugins/cache', p.marketplace, p.name, v))) fail('V7', `orphan cache dir missing: ${p.name}@${v}`);
      orphans++;
    }
  }
  if (!failures.some((f) => f.startsWith('V7'))) ok('V7', `${orphans} orphan cache directories present and unreferenced`);
}

/** Every .json that legitimately cannot carry an inline marker. Mirrors MANIFEST.json → markerPolicy. */
const MARKER_EXEMPT = [
  // A bare Record<name, entry> — a `__synthetic` key would read as an entry.
  /^scale\/tree\/home\/\.claude\/plugins\/known_marketplaces\.json$/,
  // Manifests: unknown fields are warnings, and `--strict` promotes them to errors.
  /\/\.claude-plugin\/plugin\.json$/,
  /\/\.claude-plugin\/marketplace\.json$/,
];

function checkMarkers() {
  let marked = 0;
  let exempt = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.json')) continue;
      const rel = full.slice(HERE.length + 1).replaceAll('\\', '/');
      if (MARKER_EXEMPT.some((re) => re.test(rel))) {
        exempt++;
        continue;
      }
      const doc = readJson(full);
      if (doc.__synthetic !== true) fail('V10', `missing \`__synthetic: true\`: ${rel}`);
      else if (!doc.__models || typeof doc.__models !== 'object') fail('V10', `missing \`__models\`: ${rel}`);
      else marked++;
    }
  };
  walk(HERE);
  if (!failures.some((f) => f.startsWith('V10'))) ok('V10', `${marked} JSON files self-identify; ${exempt} exempt by MANIFEST.json → markerPolicy`);
}

const SCOPES_LOW_TO_HIGH = ['user', 'project', 'local', 'managed'];

/** JSON with object keys sorted recursively; array order preserved. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Merge a Record-shaped setting entry-by-entry, lowest scope first. */
function mergeRecord(loaded, key, scopes = SCOPES_LOW_TO_HIGH) {
  const out = {};
  for (const scope of scopes) Object.assign(out, loaded[scope][key] ?? {});
  return out;
}

/** Union arrays across scopes, lowest first, preserving first occurrence. */
function unionArrays(loaded, field) {
  const out = [];
  for (const scope of SCOPES_LOW_TO_HIGH) {
    for (const v of loaded[scope].permissions?.[field] ?? []) if (!out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Resolve the four precedence fixtures under the oracle's `assumed` model. This
 * is NOT an implementation of T1.2 — it is a consistency check that the golden
 * in expected-precedence.json still follows from its four inputs.
 */
function checkPrecedence() {
  const dir = join(HERE, 'precedence');
  const loaded = Object.fromEntries(SCOPES_LOW_TO_HIGH.map((s) => [s, readJson(join(dir, `${s}-settings.json`))]));
  const oracle = readJson(join(dir, 'expected-precedence.json'));

  let defaultMode;
  for (const scope of SCOPES_LOW_TO_HIGH) if (loaded[scope].permissions?.defaultMode) defaultMode = loaded[scope].permissions.defaultMode;

  const resolved = {
    enabledPlugins: mergeRecord(loaded, 'enabledPlugins'),
    extraKnownMarketplaces: mergeRecord(loaded, 'extraKnownMarketplaces'),
    // R4 — docs/02-architecture.md line 158: project and local are IGNORED here.
    pluginConfigs: mergeRecord(loaded, 'pluginConfigs', ['user', 'managed']),
    env: mergeRecord(loaded, 'env'),
    permissions: {
      defaultMode,
      allow: unionArrays(loaded, 'allow'),
      deny: unionArrays(loaded, 'deny'),
      additionalDirectories: unionArrays(loaded, 'additionalDirectories'),
    },
  };

  const golden = { ...oracle.resolvedUnderAssumedModel };
  delete golden.__note;
  // Object key order is not part of the claim (array order is — the allow union
  // is documented as lowest-scope-first), so compare canonically.
  if (canonical(resolved) !== canonical(golden)) {
    fail('V11', 'resolvedUnderAssumedModel no longer follows from the four settings files');
    fail('V11', `  computed: ${canonical(resolved)}`);
    fail('V11', `  golden:   ${canonical(golden)}`);
  }

  const RECORD_KEYS = new Set(['enabledPlugins', 'extraKnownMarketplaces', 'pluginConfigs', 'env']);
  for (const e of oracle.expectations) {
    if (!RECORD_KEYS.has(e.setting) || !e.entry) continue;
    const actual = SCOPES_LOW_TO_HIGH.filter((s) => e.entry in (loaded[s][e.setting] ?? {}));
    const declared = Object.keys(e.definedAt).sort();
    if (JSON.stringify(actual.slice().sort()) !== JSON.stringify(declared)) {
      fail('V11', `${e.id}: definedAt says [${declared}] but the files define it at [${actual}]`);
    }
  }
  if (!failures.some((f) => f.startsWith('V11'))) {
    ok('V11', `precedence golden re-derives from 4 scopes; ${oracle.expectations.length} expectations agree with their inputs`);
  }
}

function checkSkillsDir() {
  const root = join(HERE, 'skills-dir-plugin', 'skills');
  const oracle = readJson(join(HERE, 'skills-dir-plugin', 'expected-detection.json'));
  let named = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name === 'plugin.json') named++;
    }
  };
  walk(root);
  const dirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  const plugins = dirs.filter((e) => existsSync(join(root, e.name, '.claude-plugin', 'plugin.json')));

  if (named !== oracle.counts.filesNamedPluginJsonAnywhereUnderRoot) fail('V12', `files named plugin.json: ${named}, oracle says ${oracle.counts.filesNamedPluginJsonAnywhereUnderRoot}`);
  if (plugins.length !== oracle.counts.pluginsDetected) fail('V12', `directories with .claude-plugin/plugin.json: ${plugins.length}, oracle says ${oracle.counts.pluginsDetected}`);
  if (dirs.length - plugins.length !== oracle.counts.personalSkillDirectories) fail('V12', `personal skill directories: ${dirs.length - plugins.length}, oracle says ${oracle.counts.personalSkillDirectories}`);
  for (const e of oracle.expected) {
    const p = join(HERE, 'skills-dir-plugin', ...e.path.replace('./', '').split('/'));
    if (!existsSync(p)) fail('V12', `expected-detection.json names a path that does not exist: ${e.path}`);
  }
  if (!failures.some((f) => f.startsWith('V12'))) {
    ok('V12', `${named} files named plugin.json under skills/, exactly ${plugins.length} is a Claude Code manifest (trap #14)`);
  }
}

function checkEntropy() {
  const committed = readJson(join(HERE, 'secrets', 'entropy-report.json'));
  const fresh = entropyReport();
  if (JSON.stringify(committed.positives) !== JSON.stringify(fresh.positives)) fail('V8', 'secrets/entropy-report.json positives are stale — re-run `build`');
  if (JSON.stringify(committed.negatives) !== JSON.stringify(fresh.negatives)) fail('V8', 'secrets/entropy-report.json negatives are stale — re-run `build`');

  for (const n of fresh.negatives) {
    if (n.declared === null) fail('V8', `negative-cases.json ${n.id}: no shannonEntropyBitsPerChar declared — an undeclared figure is one the derived claims cannot be checked against`);
    else if (n.declared !== n.entropyBitsPerChar) fail('V8', `negative-cases.json ${n.id}: declared ${n.declared}, measured ${n.entropyBitsPerChar}`);
  }

  // The derived claims in `entropyFinding` must follow from the table, or the
  // file states a measured-sounding conclusion its own data contradicts.
  const finding = readJson(join(HERE, 'secrets', 'negative-cases.json')).entropyFinding;
  const maxNeg = fresh.negatives.reduce((a, b) => (b.entropyBitsPerChar > a.entropyBitsPerChar ? b : a));
  if (finding.highestNegative.id !== maxNeg.id || finding.highestNegative.bitsPerChar !== maxNeg.entropyBitsPerChar) {
    fail('V8', `entropyFinding.highestNegative says ${finding.highestNegative.id} ${finding.highestNegative.bitsPerChar}, measured ${maxNeg.id} ${maxNeg.entropyBitsPerChar}`);
  }
  const declaredFindings = readJson(join(HERE, 'secrets', 'expected-findings.json')).expectedFindings;
  const withEntropy = declaredFindings.filter((f) => typeof f.entropyBitsPerChar === 'number');
  const minPos = withEntropy.reduce((a, b) => (b.entropyBitsPerChar < a.entropyBitsPerChar ? b : a));
  if (finding.lowestPositive.id !== minPos.id || finding.lowestPositive.bitsPerChar !== minPos.entropyBitsPerChar) {
    fail('V8', `entropyFinding.lowestPositive says ${finding.lowestPositive.id}, measured ${minPos.id} ${minPos.entropyBitsPerChar}`);
  }
  const entropyOnly = withEntropy.filter((f) => f.heuristics.length === 1 && f.heuristics[0] === 'entropy');
  const minEO = entropyOnly.reduce((a, b) => (b.entropyBitsPerChar < a.entropyBitsPerChar ? b : a));
  const maxEO = entropyOnly.reduce((a, b) => (b.entropyBitsPerChar > a.entropyBitsPerChar ? b : a));
  if (finding.lowestEntropyOnlyPositive.id !== minEO.id) fail('V8', `entropyFinding.lowestEntropyOnlyPositive says ${finding.lowestEntropyOnlyPositive.id}, measured ${minEO.id}`);
  if (finding.highestEntropyOnlyPositive.id !== maxEO.id) fail('V8', `entropyFinding.highestEntropyOnlyPositive says ${finding.highestEntropyOnlyPositive.id}, measured ${maxEO.id}`);
  if (minEO.entropyBitsPerChar > maxNeg.entropyBitsPerChar) {
    fail('V8', `entropyFinding.headline claims no threshold separates the populations, but the lowest entropy-only positive (${minEO.entropyBitsPerChar}) now exceeds the highest negative (${maxNeg.entropyBitsPerChar}) — the claim is stale`);
  }

  const measured = fresh.positives.map((p) => p.entropyBitsPerChar);
  const findings = readJson(join(HERE, 'secrets', 'expected-findings.json')).expectedFindings;
  for (const f of findings) {
    if (typeof f.entropyBitsPerChar !== 'number') continue;
    const i = measured.indexOf(f.entropyBitsPerChar);
    if (i === -1) fail('V8', `expected-findings.json ${f.id}: declared entropy ${f.entropyBitsPerChar} matches no value in the fixtures`);
    else measured.splice(i, 1);
  }
  if (!failures.some((s) => s.startsWith('V8'))) ok('V8', `${fresh.positives.length} positive + ${fresh.negatives.length} negative entropy figures verified`);
}

function checkSentinel() {
  const root = HERE;
  let scanned = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      let text;
      try {
        text = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      scanned++;
      for (const [i, line] of text.split('\n').entries()) {
        const m = line.match(CREDENTIAL_SHAPED);
        if (m && !line.includes(SENTINEL)) {
          const rel = full.slice(root.length + 1).replaceAll('\\', '/');
          fail('V9', `credential-shaped string without the ${SENTINEL} sentinel: ${rel}:${i + 1} → ${m[0].slice(0, 24)}…`);
        }
      }
    }
  };
  walk(root);
  if (!failures.some((f) => f.startsWith('V9'))) ok('V9', `${scanned} files scanned; every credential-shaped string carries the ${SENTINEL} sentinel`);
}

// ------------------------------------------------------------------- commands

function cmdBuild() {
  if (!TREE_DIR.replaceAll('\\', '/').endsWith('fixtures/synthetic/scale/tree')) {
    throw new Error(`refusing to write outside fixtures/synthetic/scale/tree (resolved: ${TREE_DIR})`);
  }
  rmSync(TREE_DIR, { recursive: true, force: true });
  const files = buildTree(SEED);
  writeFiles(TREE_DIR, files);
  applyMtimes(TREE_DIR);
  writeFileSync(join(HERE, 'secrets', 'entropy-report.json'), JSON.stringify(entropyReport(), null, 2) + '\n');
  console.log(`built scale/tree/  ${files.size} files`);
  console.log('built secrets/entropy-report.json');
}

function cmdVerify() {
  console.log('verifying fixtures/synthetic/ …');
  checkTreeBytes(buildTree(SEED));
  checkBookkeeping();
  checkScale();
  checkOrphans();
  checkEntropy();
  checkSentinel();
  checkMarkers();
  checkPrecedence();
  checkSkillsDir();
  if (failures.length) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(`  FAIL ${f}`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

function cmdMaterialize(dest) {
  if (!dest) throw new Error('materialize needs a destination directory');
  const root = resolve(dest);
  rmSync(root, { recursive: true, force: true });
  writeFiles(root, buildTree(SEED), { native: true });
  applyMtimes(root);
  console.log(`materialized a walkable tree at ${root}`);
  console.log('  <TREE_ROOT> resolved to that path; separators are native.');
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'build') cmdBuild();
else if (cmd === 'verify') cmdVerify();
else if (cmd === 'materialize') cmdMaterialize(arg);
else {
  console.error('usage: generate.mjs build | verify | materialize <dir>');
  process.exit(2);
}
