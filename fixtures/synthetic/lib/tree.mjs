// Deterministic construction of the reference-scale tree.
// Zero dependencies, node:* only. Pure: buildTree(seed) -> Map<relPath, content>.
//
// Determinism rules, all load-bearing (fixtures/** is `-text` in .gitattributes,
// so nothing normalises line endings for us):
//   - seeded PRNG only, consumed in a fixed order
//   - every timestamp is seed.baseTimestampMs + a fixed offset; no wall clock
//   - explicit '\n' everywhere
//   - object key order is written, not sorted, so it matches the real captures

/** Path token substituted for the absolute location of `scale/tree/`. */
export const TREE_ROOT = '<TREE_ROOT>';

/** Windows separator, matching the reference machine's captures verbatim. */
const W = '\\';

const winPath = (...parts) => [TREE_ROOT, ...parts].join(W);
const j = (obj) => JSON.stringify(obj, null, 2) + '\n';

/**
 * The self-identifying header every generated JSON file carries, except the
 * manifests — a `plugin.json` with unknown fields fails
 * `claude plugin validate --strict` (verified live). See ../MANIFEST.json →
 * markerPolicy.
 */
const marker = (unblocks) => ({
  __synthetic: true,
  __models: {
    gap: 'docs/tasks.md "Reference machine baseline" — 4 marketplaces / 5 plugins locally vs T1.11 floors of >=5 / >=20',
    unblocks,
    generatedBy: 'node fixtures/synthetic/generate.mjs build',
    source: 'fixtures/synthetic/scale/seed.json',
  },
});

function mulberry32(a) {
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86400000;

/** Deterministic 40-char lowercase hex, the shape of a git commit SHA. */
function sha40(rand) {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 40; i++) out += hex[Math.floor(rand() * 16)];
  return out;
}

const iso = (base, offsetMs) => new Date(base + offsetMs).toISOString();

/**
 * Source objects use ONLY shapes whose literal values were observed
 * (fixtures/files/marketplace-manifest-shape.json). See scale/README.md for the
 * one observed variant deliberately NOT reproduced.
 */
function sourceFor(index, plugin, rand) {
  if (plugin.sourceKind === 'string-relative') return `./plugins/${plugin.name}`;
  switch (index % 4) {
    case 0:
      return { source: 'url', url: `https://example.invalid/${plugin.name}.git`, sha: sha40(rand) };
    case 1:
      return { source: 'github', repo: `synthetic-org/${plugin.name}` };
    case 2:
      return { source: 'github', repo: `synthetic-org/${plugin.name}`, sha: sha40(rand) };
    default:
      return `./plugins/${plugin.name}`;
  }
}

function pluginManifest(plugin) {
  const manifest = {
    $schema: 'https://json.schemastore.org/claude-code-plugin-manifest.json',
    name: plugin.name,
    description: `SYNTHETIC FIXTURE — generated plugin ${plugin.name}. Reference-scale tree for the T1.11 perf gate. Not a real plugin.`,
    author: { name: 'ccatlas synthetic fixture' },
    homepage: `https://example.invalid/${plugin.name}`,
    license: 'MIT',
    keywords: ['synthetic', 'fixture', 'ccatlas'],
  };
  // The literal string 'unknown' is a RESOLUTION OUTCOME, never a manifest
  // value: sy-cinder resolves to 'unknown' precisely because it declares none.
  if (plugin.version !== 'unknown') manifest.version = plugin.version;
  if (plugin.skills) manifest.skills = ['./skills/'];
  return j(manifest);
}

function skillDoc(name, owner) {
  return [
    '---',
    `name: ${name}`,
    `description: SYNTHETIC FIXTURE — generated skill ${name}${owner ? `, contributed by ${owner}` : ''}. Bulk exists to reach reference scale for the T1.11 perf gate; never invoke it.`,
    '---',
    '',
    `# ${name}`,
    '',
    'Synthetic fixture content.',
    '',
  ].join('\n');
}

function agentDoc(name) {
  return [
    '---',
    `name: ${name}`,
    `description: SYNTHETIC FIXTURE — generated agent ${name}. Never dispatch it.`,
    'tools: Read, Grep, Glob',
    '---',
    '',
    'Synthetic fixture agent.',
    '',
  ].join('\n');
}

function commandDoc(name) {
  return [
    '---',
    `description: SYNTHETIC FIXTURE — generated command /${name}. Never invoke it.`,
    '---',
    '',
    `Synthetic fixture command \`/${name}\`.`,
    '',
  ].join('\n');
}

function mcpDef(server) {
  return server.type === 'http'
    ? { type: 'http', url: server.url }
    : { type: 'stdio', command: 'npx', args: ['-y', server.package], env: {} };
}

/** Cache directory (POSIX-joined, for the file map) for one plugin version. */
const cacheDir = (p, version) =>
  `home/.claude/plugins/cache/${p.marketplace}/${p.name}/${version}`;

function addVersionDir(files, plugin, version, { live, pid, procStart }) {
  const dir = cacheDir(plugin, version);
  files.set(`${dir}/.claude-plugin/plugin.json`, pluginManifest({ ...plugin, version }));
  // `.in_use` is a DIRECTORY (FORMATS.md §0 trap #11). Its real contents are
  // per-process lock files named <pid> or <pid>.tmp.<hex>, holding
  // {"pid":N} or {"pid":N,"procStart":"<ticks>"} — observed live, 2026-07-31.
  const lock = procStart ? { pid, procStart } : { pid };
  files.set(`${dir}/.in_use/${pid}`, JSON.stringify(lock) + '\n');
  if (live && plugin.skills) {
    for (const s of plugin.skills) files.set(`${dir}/skills/${s}/SKILL.md`, skillDoc(s, plugin.name));
  }
  if (live && plugin.mcpServers) {
    const servers = {};
    for (const name of plugin.mcpServers) {
      servers[name] = { type: 'stdio', command: 'npx', args: ['-y', `@synthetic/${name}`], env: {} };
    }
    files.set(`${dir}/.mcp.json`, j({ ...marker(['T1.11', 'T1.3']), mcpServers: servers }));
  }
}

function marketplaceManifest(mkt, plugins, rand) {
  const manifest = {
    $schema: 'https://json.schemastore.org/claude-code-plugin-marketplace.json',
    name: mkt.name,
    description: `SYNTHETIC FIXTURE — generated marketplace ${mkt.name}.`,
    owner: { name: 'ccatlas synthetic fixture' },
    metadata: { description: 'Synthetic fixture marketplace', version: '1.0.0' },
    plugins: plugins.map((p, i) => {
      const entry = { name: p.name, description: `SYNTHETIC FIXTURE — ${p.name}.`, source: sourceFor(i, p, rand) };
      if (p.marketplaceEntryVersion) entry.version = p.marketplaceEntryVersion;
      return entry;
    }),
  };
  // `renames` is present ONLY in claude-plugins-official, is undocumented, and
  // is consequential: unresolved, a renamed plugin reads as removed + added.
  if (mkt.hasRenames) manifest.renames = { 'sy-atlas-legacy': 'sy-atlas', 'sy-old-beacon': 'sy-beacon' };
  return j(manifest);
}

function buildSettings(seed) {
  const enabledPlugins = {};
  for (const p of seed.plugins) enabledPlugins[`${p.name}@${p.marketplace}`] = p.enabled;
  const extraKnownMarketplaces = {};
  for (const m of seed.marketplaces) {
    if (m.clone === 'gcs') continue; // auto-installed, like claude-plugins-official
    extraKnownMarketplaces[m.name] = { source: { source: 'github', repo: m.repo } };
  }
  return j({
    __synthetic: true,
    __models: {
      gap: 'Reference scale — 4 marketplaces / 5 plugins locally vs floors of >=5 / >=20',
      unblocks: ['T1.11'],
      generatedBy: 'fixtures/synthetic/generate.mjs build',
    },
    env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
    permissions: { allow: ['Bash(echo synthetic:*)'] },
    enabledPlugins,
    extraKnownMarketplaces,
    autoUpdatesChannel: 'latest',
    theme: 'dark',
  });
}

function buildClaudeJson(seed) {
  const mcpServers = {};
  for (const s of seed.userScopeMcpServers) mcpServers[s.name] = mcpDef(s);

  const projects = {};
  for (const [i, key] of seed.projectKeys.entries()) {
    const own = seed.projectScopeMcpServers.filter((s) => s.project === i);
    const projectServers = {};
    for (const s of own) projectServers[s.name] = mcpDef(s);
    projects[key] = {
      allowedTools: [],
      mcpContextUris: [],
      mcpServers: projectServers,
      enabledMcpjsonServers: [],
      disabledMcpjsonServers: [],
      hasTrustDialogAccepted: true,
      projectOnboardingSeenCount: 1,
      hasClaudeMdExternalIncludesApproved: false,
      hasClaudeMdExternalIncludesWarningShown: false,
    };
  }

  return j({
    __synthetic: true,
    __models: {
      gap: 'Reference scale (>=8 MCP servers) + FORMATS.md §0 trap #13 (colliding project keys)',
      unblocks: ['T1.11', 'T1.3', 'T1.25'],
      note: 'A FRAGMENT of ~/.claude.json — the real file is ~193 KB / 95 top-level keys and must never be read wholesale.',
    },
    autoUpdates: true,
    officialMarketplaceAutoInstalled: true,
    mcpServers,
    projects,
  });
}

function buildPluginFiles(seed, files, rand) {
  const known = {};
  for (const m of seed.marketplaces) {
    known[m.name] = {
      source: { source: 'github', repo: m.repo },
      installLocation: winPath('home', '.claude', 'plugins', 'marketplaces', m.name),
      lastUpdated: iso(seed.baseTimestampMs, m.lastUpdatedOffsetDays * DAY),
    };
    const owned = seed.plugins.filter((p) => p.marketplace === m.name);
    files.set(
      `home/.claude/plugins/marketplaces/${m.name}/.claude-plugin/marketplace.json`,
      marketplaceManifest(m, owned, rand),
    );
    if (m.clone === 'gcs') {
      files.set(`home/.claude/plugins/marketplaces/${m.name}/.gcs-sha`, sha40(rand) + '\n');
    }
  }
  // NO marker here: known_marketplaces.json is a BARE Record<name, entry> at the
  // top level, so a `__synthetic` key would read as a marketplace named
  // `__synthetic`. Indexed in ../MANIFEST.json → markerPolicy instead.
  files.set('home/.claude/plugins/known_marketplaces.json', j(known));

  const installed = { version: 2, plugins: {} };
  for (const [i, p] of seed.plugins.entries()) {
    const installedAt = iso(seed.baseTimestampMs, i * DAY);
    const lastUpdated = iso(seed.baseTimestampMs, (i + 30) * DAY);
    const scopes = p.scopes ?? ['user'];
    installed.plugins[`${p.name}@${p.marketplace}`] = scopes.map((scope) => {
      const record = {
        scope,
        installPath: winPath('home', '.claude', 'plugins', 'cache', p.marketplace, p.name, p.version),
        version: p.version,
        installedAt,
        lastUpdated,
      };
      // gitCommitSha is FILE-ONLY — the CLI never exposes it (FORMATS.md §2).
      if (!p.noSha) record.gitCommitSha = sha40(rand);
      return record;
    });
    addVersionDir(files, p, p.version, { live: true, pid: 4000 + i, procStart: `6392109060137${String(10000 + i)}` });
    for (const [k, orphan] of (p.orphanVersions ?? []).entries()) {
      addVersionDir(files, p, orphan, { live: false, pid: 3000 + i * 10 + k });
    }
  }
  files.set('home/.claude/plugins/installed_plugins.json', j({ ...marker(['T1.11', 'T1.15']), ...installed }));
  files.set('home/.claude/plugins/config.json', j({ ...marker(['T1.11']), repositories: {} }));
  files.set('home/.claude/plugins/.last_inuse_sweep', iso(seed.baseTimestampMs, 30 * DAY) + '\n');
  files.set(
    'home/.claude/plugins/blocklist.json',
    j({ ...marker(['T1.11', 'T1.12']), fetchedAt: iso(seed.baseTimestampMs, 30 * DAY), plugins: [] }),
  );
}

/**
 * @param {object} seed parsed scale/seed.json
 * @returns {Map<string, string>} relative POSIX path -> file content
 */
export function buildTree(seed) {
  const rand = mulberry32(seed.prngSeed);
  /** @type {Map<string, string>} */
  const files = new Map();

  files.set('home/.claude/settings.json', buildSettings(seed));
  files.set(
    'home/.claude/settings.local.json',
    j({ ...marker(['T1.11', 'T1.2']), permissions: { allow: [], deny: [] }, enabledMcpjsonServers: [] }),
  );
  files.set('home/.claude.json', buildClaudeJson(seed));

  for (let i = 1; i <= seed.personalSkills; i++) {
    const name = `sy-skill-${String(i).padStart(3, '0')}`;
    files.set(`home/.claude/skills/${name}/SKILL.md`, skillDoc(name, null));
  }
  for (let i = 1; i <= seed.personalAgents; i++) {
    const name = `sy-agent-${String(i).padStart(2, '0')}`;
    files.set(`home/.claude/agents/${name}.md`, agentDoc(name));
  }
  for (let i = 1; i <= seed.personalCommands - 1; i++) {
    const name = `sy-command-${String(i).padStart(2, '0')}`;
    files.set(`home/.claude/commands/${name}.md`, commandDoc(name));
  }
  // Collides by bare name with the command contributed by the @skills-dir
  // plugin fixture — FORMATS.md §0 trap #16 (commands are recorded BARE).
  files.set('home/.claude/commands/synthetic-report.md', commandDoc('synthetic-report'));

  buildPluginFiles(seed, files, rand);
  return files;
}

/** Files whose mtime carries meaning. Orphans must look stale. See scale/README.md. */
export function mtimePlan(seed) {
  const plan = new Map();
  const live = seed.baseTimestampMs + 200 * DAY;
  const stale = seed.baseTimestampMs + 30 * DAY;
  for (const p of seed.plugins) {
    plan.set(`${cacheDir(p, p.version)}/.in_use`, live);
    for (const orphan of p.orphanVersions ?? []) plan.set(`${cacheDir(p, orphan)}/.in_use`, stale);
  }
  return plan;
}
