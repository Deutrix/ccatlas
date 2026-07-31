/**
 * T1.1 — the `cli` collector: the official `claude` JSON/text surfaces.
 *
 * Every shape parsed here traces to a committed fixture under
 * `fixtures/cli/<version>/` and to docs/FORMATS.md §0–§1. The traps this file
 * exists to survive, in the order they appear below:
 *
 *   1. The top-level type CHANGES with the flag — `plugin list --json` is a
 *      bare array, `--json --available` is an object. Branch on the flag you
 *      passed, never on the response shape.
 *   2. `available[]` keys the id as `pluginId`; `installed[]` uses `id`.
 *   3. `available[]` EXCLUDES everything installed (0 of 5 present in 276
 *      rows). It is a catalogue, not a set of upgrade targets.
 *   4. `source` is a union — bare string in 55 of 276 rows, plus four object
 *      shapes. Readers assuming an object break on 20% of entries.
 *   5. `version` is the literal string "unknown" when unresolved.
 *   6. `--plugin-dir` sideloads arrive with scope "session", an `@inline`
 *      marketplace suffix, and no `installedAt` / `lastUpdated`.
 *   7. Errors go to STDOUT with an empty stderr and exit 1. Key on the exit
 *      code — a stderr-keyed check parses the error sentence as data.
 *   8. `mcp list` is line-oriented text; `Pending approval` is a real state.
 *   9. `marketplace list --json` says nothing about distribution;
 *      claude-plugins-official is a GCS tarball with no `.git`.
 *
 * Read-only and pure: nothing here writes, and a failure is a value.
 */

import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import type {
  CollectContext,
  Collector,
  CollectorResult,
  ComponentCounts,
  EntityState,
  MarketplaceEntity,
  McpServerEntity,
  Origin,
  PluginEntity,
  PluginSource,
  Scope,
  VersionInfo,
  Warning,
} from '../types.ts';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** One `claude …` invocation. `code` is the ONLY success signal — trap 7. */
export interface CommandOutcome {
  stdout: string;
  stderr: string;
  code: number;
}

export type CommandRunner = (argv: readonly string[]) => Promise<CommandOutcome>;

/**
 * A catalogue row. Extends PluginEntity so consumers need no second branch,
 * and adds the two fields `available[]` carries that no installed row does.
 * Kept in its own array because "not installed" has no representation in
 * `Scope` or `EntityState` — position carries it.
 */
export interface AvailableEntry extends PluginEntity {
  description: string;
  installCount?: number;
}

/** `repo` / `sourceType` are the only upstream coordinates the CLI returns. */
export interface CliMarketplaceEntity extends MarketplaceEntity {
  repo?: string;
  sourceType?: string;
}

export interface CliInventory {
  /** `plugin list --json`. Installed only, one entry per (id, scope) row. */
  plugins: PluginEntity[];
  /** `plugin list --json --available` → `available[]`. NOT upgrade targets. */
  available: AvailableEntry[];
  marketplaces: CliMarketplaceEntity[];
  mcpServers: McpServerEntity[];
}

export interface CliCollectorOptions {
  /** Injected in tests. Otherwise chosen from `ctx.fixtureRoot`. */
  runner?: CommandRunner;
  /**
   * `mcp list` live-health-checks EVERY server (~40s for 14) — it blows the
   * T1.11 budget unconditionally and dials the network. Opt in explicitly.
   */
  includeMcpList?: boolean;
  /** Sideload probe. Must precede the subcommand — trap 18. */
  pluginDir?: string;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/** Keeps only the string-valued entries — env is `Record<string, string>`. */
const stringValues = (v: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.entries(v).filter(([, value]) => typeof value === 'string')) as Record<
    string,
    string
  >;

const warn = (code: Warning['code'], message: string, subject?: string): Warning => ({
  code,
  message,
  ...(subject !== undefined ? { subject } : {}),
});

/**
 * Trap 7. `plugin details <missing>` writes its error to stdout and leaves
 * stderr empty; a mispositioned `--plugin-dir` does the exact opposite. Both
 * exit 1. Neither stream classifies both correctly — only the code does.
 */
export function succeeded(outcome: CommandOutcome): boolean {
  return outcome.code === 0;
}

const SCOPES = new Set<string>(['user', 'project', 'local', 'managed', 'session']);
const toScope = (v: unknown): Scope => (typeof v === 'string' && SCOPES.has(v) ? (v as Scope) : 'user');

/** `@inline` and `@skills-dir` are reserved; `@synced` exists but is undocumented. */
function originFor(marketplace: string): Origin {
  if (marketplace === 'inline') return 'inline';
  if (marketplace === 'skills-dir') return 'skills-dir';
  return 'marketplace';
}

const NO_COMPONENTS: ComponentCounts = {
  skills: 0,
  agents: 0,
  hooks: 0,
  mcpServers: 0,
  lspServers: 0,
};

// ---------------------------------------------------------------------------
// `source` — the union type, trap 4
// ---------------------------------------------------------------------------

/**
 * 55 of 276 rows are a bare string (a path relative to the marketplace root);
 * the rest are `{source,url,sha}`, `{source,url,path,ref,sha}`,
 * `{source,repo,sha}` or `{source,url,path,sha}`. The bare form has no
 * discriminator of its own, so one is synthesised — `relative-path` is not an
 * upstream value and cannot collide with one.
 */
export function normalisePluginSource(raw: unknown): PluginSource | undefined {
  if (typeof raw === 'string') return { source: 'relative-path', path: raw };
  if (!isRecord(raw)) return undefined;

  const discriminator = str(raw['source']);
  const url = str(raw['url']);
  const repo = str(raw['repo']);
  const p = str(raw['path']);
  const ref = str(raw['ref']);
  const sha = str(raw['sha']);

  return {
    source: discriminator ?? 'unknown',
    ...(url !== undefined ? { url } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(p !== undefined ? { path: p } : {}),
    ...(ref !== undefined ? { ref } : {}),
    ...(sha !== undefined ? { sha } : {}),
  };
}

// ---------------------------------------------------------------------------
// `plugin list --json` — bare array, traps 1/5/6
// ---------------------------------------------------------------------------

function pluginFromRow(row: Record<string, unknown>): PluginEntity | undefined {
  const id = str(row['id']);
  if (id === undefined || id.length === 0) return undefined;

  // The marketplace appears ONLY in the id suffix; there is no `marketplace`
  // field. Split on the LAST `@` — plugin names may contain one.
  const at = id.lastIndexOf('@');
  const marketplace = at > 0 ? id.slice(at + 1) : '';

  // Trap 5: "unknown" is a literal, meaningful value. And the CLI never says
  // WHICH field it read (FINDINGS Q5 — four version-bearing fields exist and
  // two of them disagree for ui-ux-pro-max), so versionSource stays 'unknown'
  // for CLI-sourced facts. The file collector witnesses it; T1.8 reconciles.
  const version: VersionInfo = { version: str(row['version']) ?? 'unknown', versionSource: 'unknown' };

  const enabled = row['enabled'] === true;
  const state: EntityState = enabled ? 'enabled' : 'disabled';
  const installPath = str(row['installPath']);
  const installedAt = str(row['installedAt']);
  const lastUpdated = str(row['lastUpdated']);

  // `plugin list` witnesses only the MCP server count. The other four counts
  // come from `plugin details` (T1.2) — zero here means "not witnessed", and
  // a merge must prefer the details figures over these.
  const servers = isRecord(row['mcpServers']) ? row['mcpServers'] : undefined;

  return {
    id: { name: id, scope: toScope(row['scope']), kind: 'plugin' },
    origin: originFor(marketplace),
    state,
    source: 'cli',
    marketplace,
    enabled,
    version,
    contributes: { ...NO_COMPONENTS, mcpServers: servers ? Object.keys(servers).length : 0 },
    // Trap 6: both are absent on sideloads. Absent must stay absent.
    ...(installPath !== undefined ? { installPath } : {}),
    ...(installedAt !== undefined ? { installedAt } : {}),
    ...(lastUpdated !== undefined ? { lastUpdated } : {}),
  };
}

export function parsePluginList(raw: unknown): { plugins: PluginEntity[]; warnings: Warning[] } {
  // Trap 1: the plain command returns a bare array. An object here means the
  // caller passed --available, or the format drifted. Either way, refuse.
  if (!Array.isArray(raw)) {
    return {
      plugins: [],
      warnings: [
        warn(
          'unsupported-version',
          '`plugin list --json` did not return an array — format drift, or the ' +
            '--available response was passed to the wrong parser',
        ),
      ],
    };
  }

  const plugins: PluginEntity[] = [];
  const warnings: Warning[] = [];
  for (const row of raw) {
    const plugin = isRecord(row) ? pluginFromRow(row) : undefined;
    if (plugin === undefined) {
      warnings.push(warn('unsupported-version', 'skipped an unrecognised `plugin list` row'));
      continue;
    }
    plugins.push(plugin);
  }
  return { plugins, warnings };
}

// ---------------------------------------------------------------------------
// `plugin list --json --available` — object, traps 1/2/3/4
// ---------------------------------------------------------------------------

function availableFromRow(row: Record<string, unknown>): AvailableEntry | undefined {
  // Trap 2: `pluginId`, NOT `id`.
  const id = str(row['pluginId']);
  if (id === undefined || id.length === 0) return undefined;

  const at = id.lastIndexOf('@');
  const marketplace = str(row['marketplaceName']) ?? (at > 0 ? id.slice(at + 1) : '');
  const pluginSource = normalisePluginSource(row['source']);
  const declared = str(row['version']);
  const sha = pluginSource?.sha;
  const installCount = num(row['installCount']);

  // Only 14 of 276 rows declare a version, and those are exactly the ones
  // whose marketplace entry declares one — so the provenance IS knowable here.
  const version: VersionInfo = {
    version: declared ?? 'unknown',
    versionSource: declared !== undefined ? 'marketplace-entry' : 'unknown',
    ...(sha !== undefined ? { sourceSha: sha } : {}),
  };

  return {
    id: { name: id, scope: toScope(row['scope']), kind: 'plugin' },
    origin: originFor(marketplace),
    // Not installed, so not enabled. `EntityState` has no 'available' member;
    // membership of `CliInventory.available` is what marks it as a catalogue row.
    state: 'disabled',
    source: 'cli',
    marketplace,
    enabled: false,
    version,
    contributes: { ...NO_COMPONENTS },
    description: str(row['description']) ?? '',
    ...(pluginSource !== undefined ? { pluginSource } : {}),
    ...(installCount !== undefined ? { installCount } : {}),
  };
}

export function parseAvailableList(raw: unknown): {
  plugins: PluginEntity[];
  available: AvailableEntry[];
  warnings: Warning[];
} {
  // Trap 1 again, from the other side: an array here is the plain response.
  if (!isRecord(raw) || !Array.isArray(raw['available'])) {
    return {
      plugins: [],
      available: [],
      warnings: [
        warn(
          'unsupported-version',
          '`plugin list --json --available` did not return {installed, available} — ' +
            'format drift, or the plain response was passed to the wrong parser',
        ),
      ],
    };
  }

  const installed = parsePluginList(raw['installed'] ?? []);
  const available: AvailableEntry[] = [];
  const warnings = [...installed.warnings];

  for (const row of raw['available']) {
    const entry = isRecord(row) ? availableFromRow(row) : undefined;
    if (entry === undefined) {
      warnings.push(warn('unsupported-version', 'skipped an unrecognised `available[]` row'));
      continue;
    }
    available.push(entry);
  }

  return { plugins: installed.plugins, available, warnings };
}

// ---------------------------------------------------------------------------
// `plugin marketplace list --json` — trap 9
// ---------------------------------------------------------------------------

/**
 * `claude-plugins-official` ships as a GCS tarball: a `.gcs-sha` sidecar and
 * no `.git`, despite reporting `source: "github"`. It holds 276 of 281
 * available plugins, so anything shelling out to git against `installLocation`
 * fails on the largest marketplace. The CLI never reveals this, so the sentinel
 * is keyed by name here and must be confirmed against disk by T2.2.
 */
const GCS_MARKETPLACES = new Set(['claude-plugins-official']);
const LOCAL_SOURCES = new Set(['local', 'file', 'directory', 'path']);

export function parseMarketplaceList(raw: unknown): {
  marketplaces: CliMarketplaceEntity[];
  warnings: Warning[];
} {
  if (!Array.isArray(raw)) {
    return {
      marketplaces: [],
      warnings: [warn('unsupported-version', '`marketplace list --json` did not return an array')],
    };
  }

  const marketplaces: CliMarketplaceEntity[] = [];
  const warnings: Warning[] = [];

  for (const row of raw) {
    const name = isRecord(row) ? str(row['name']) : undefined;
    if (name === undefined || !isRecord(row)) {
      warnings.push(warn('unsupported-version', 'skipped an unrecognised marketplace row'));
      continue;
    }

    const sourceType = str(row['source']);
    const repo = str(row['repo']);
    const installLocation = str(row['installLocation']);
    const distribution = GCS_MARKETPLACES.has(name)
      ? 'gcs'
      : sourceType !== undefined && LOCAL_SOURCES.has(sourceType)
        ? 'local'
        : 'git';

    if (installLocation === undefined) {
      // Present 4/4 locally, all github — "always" is unsupported for other
      // source types, so a missing value is degraded rather than fatal.
      warnings.push(warn('partial', 'marketplace has no installLocation', name));
    }

    marketplaces.push({
      id: { name, scope: 'user', kind: 'marketplace' },
      origin: 'marketplace',
      state: 'enabled',
      source: 'cli',
      distribution,
      ...(installLocation !== undefined ? { installLocation } : {}),
      ...(repo !== undefined ? { repo } : {}),
      ...(sourceType !== undefined ? { sourceType } : {}),
    });
  }

  return { marketplaces, warnings };
}

// ---------------------------------------------------------------------------
// `mcp list` — line-oriented text, trap 8
// ---------------------------------------------------------------------------

/**
 * Keyed on the status TEXT, not the `✔ ✘ ! ⏸` glyphs: the glyph bytes are the
 * fragile part, and text-keying makes the 'unknown' fallback meaningful — a
 * fifth state in a future build surfaces as a warning instead of a misparse.
 */
const MCP_STATES: ReadonlyArray<readonly [string, McpServerEntity['connection']]> = [
  ['Connected', 'connected'],
  ['Failed to connect', 'failed'],
  ['Needs authentication', 'needs-auth'],
  ['Pending approval', 'pending-approval'],
];

/** Splits `<transport summary> - <glyph> <status>` from the right. */
function splitStatus(rest: string): { summary: string; connection: McpServerEntity['connection'] } {
  for (let i = rest.lastIndexOf(' - '); i >= 0; i = rest.lastIndexOf(' - ', i - 1)) {
    const tail = rest.slice(i + 3).replace(/^[^A-Za-z]+/u, '');
    const match = MCP_STATES.find(([text]) => tail.startsWith(text));
    if (match) return { summary: rest.slice(0, i).trim(), connection: match[1] };
  }

  const last = rest.lastIndexOf(' - ');
  if (last < 0) return { summary: rest.trim(), connection: 'unknown' };
  return { summary: rest.slice(0, last).trim(), connection: 'unknown' };
}

/**
 * `<url> (HTTP)` for user and plugin http servers, but a BARE url for
 * claude.ai connectors — a suffix-only rule mislabels four of fourteen.
 * `sse` is never emitted: no such server has been observed.
 */
function transportFrom(summary: string): Pick<McpServerEntity, 'transport' | 'command' | 'args' | 'url'> {
  const url = summary.endsWith(' (HTTP)') ? summary.slice(0, -' (HTTP)'.length).trim() : summary;
  if (/^https?:\/\//u.test(url)) return { transport: 'http', url };

  const tokens = summary.split(/\s+/u).filter((t) => t.length > 0);
  const [command, ...args] = tokens;
  return {
    transport: 'stdio',
    ...(command !== undefined ? { command } : {}),
    ...(args.length > 0 ? { args } : {}),
  };
}

export function parseMcpList(text: string): { servers: McpServerEntity[]; warnings: Warning[] } {
  const servers: McpServerEntity[] = [];
  const warnings: Warning[] = [];

  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) continue;

    // Names contain colons (`plugin:<p>:<s>`) and spaces (`claude.ai Gmail`),
    // but never a colon-space, and `://` is not one either.
    const split = trimmed.indexOf(': ');
    if (split < 0) continue; // the `Checking MCP server health…` header

    const name = trimmed.slice(0, split);
    const { summary, connection } = splitStatus(trimmed.slice(split + 2));
    if (connection === 'unknown') {
      warnings.push(warn('unsupported-version', 'unrecognised `mcp list` status', name));
    }

    const owner = /^plugin:([^:]+):(.+)$/u.exec(name);
    servers.push({
      // `mcp list` witnesses neither scope nor origin: the four `claude.ai *`
      // rows are connector config and `claude-flow` is project config (only
      // `mcp get` says so, one server at a time). The `plugin:` prefix is the
      // one exception — it proves plugin ownership. Everything else takes a
      // single documented default rather than an n=1 guess; `Scope` and
      // `Origin` have no 'unknown' member to say this honestly.
      id: { name, scope: 'user', kind: 'mcp-server' },
      origin: owner ? 'marketplace' : 'personal',
      // A dead server is an error state; auth and approval are not.
      state: connection === 'failed' ? 'error' : 'enabled',
      source: 'cli',
      connection,
      ...transportFrom(summary),
      ...(owner?.[1] !== undefined ? { owningPlugin: owner[1] } : {}),
    });
  }

  return { servers, warnings };
}

/**
 * `plugin list --json` → `mcpServers` is the ONLY source of a plugin-scoped
 * stdio server's command (`mcp get` withholds it), and it needs no health
 * check. Names are not namespaced there; the `plugin:<p>:<s>` form used by
 * `mcp list` is reconstructed so the two sources merge on one key.
 *
 * That merge is a union, not an intersection, and on this corpus it yields 15
 * servers where `mcp list` shows 14. The extra one is real: the figma PLUGIN
 * bundles a server also called `figma`, while `mcp list`'s bare `figma` row is
 * the USER-scope server of that name (fixtures/files: `userScopeMcpServers`
 * count is 3 — browsermcp, figma-dev-mode, figma — which accounts for every
 * non-plugin, non-connector row). So `plugin:figma:figma` is declared but
 * never health-checked. Dropping it would hide a configured server; conflating
 * it with the user-scope one would invent a fact. It is kept, with
 * `connection: 'unknown'`. Whether the user-scope entry shadows it is T1.7's
 * call, not this collector's.
 */
function serversFromPluginRows(raw: unknown): McpServerEntity[] {
  if (!Array.isArray(raw)) return [];

  const servers: McpServerEntity[] = [];
  for (const row of raw) {
    if (!isRecord(row)) continue;
    const id = str(row['id']);
    const config = row['mcpServers'];
    if (id === undefined || !isRecord(config)) continue;

    const at = id.lastIndexOf('@');
    const owningPlugin = at > 0 ? id.slice(0, at) : id;
    // A disabled plugin's servers are configured but not loaded.
    const state: EntityState = row['enabled'] === true ? 'enabled' : 'disabled';

    for (const [name, value] of Object.entries(config)) {
      if (!isRecord(value)) continue;
      const type = str(value['type']);
      const url = str(value['url']);
      const command = str(value['command']);
      const args = Array.isArray(value['args'])
        ? value['args'].filter((a): a is string => typeof a === 'string')
        : [];
      const env = isRecord(value['env']) ? stringValues(value['env']) : undefined;

      servers.push({
        id: { name: `plugin:${owningPlugin}:${name}`, scope: 'user', kind: 'mcp-server' },
        origin: 'marketplace',
        state,
        source: 'cli',
        owningPlugin,
        transport: type === 'http' ? 'http' : type === 'sse' ? 'sse' : 'stdio',
        // Health is unknowable without `mcp list`, which is opt-in.
        connection: 'unknown',
        ...(url !== undefined ? { url } : {}),
        ...(command !== undefined ? { command } : {}),
        ...(args.length > 0 ? { args } : {}),
        ...(env !== undefined ? { env } : {}),
      });
    }
  }
  return servers;
}

/** Config from `plugin list`, health from `mcp list`, keyed on the canonical name. */
function mergeMcpServers(fromPlugins: McpServerEntity[], fromList: McpServerEntity[]): McpServerEntity[] {
  const merged = new Map<string, McpServerEntity>();
  for (const server of fromPlugins) merged.set(server.id.name, server);

  for (const server of fromList) {
    const known = merged.get(server.id.name);
    merged.set(
      server.id.name,
      known === undefined
        ? server
        : {
            ...known,
            ...server,
            // The config side is richer for plugin stdio servers, which
            // `mcp get` refuses to describe at all.
            ...(known.command !== undefined ? { command: known.command } : {}),
            ...(known.args !== undefined ? { args: known.args } : {}),
            ...(known.env !== undefined ? { env: known.env } : {}),
          },
    );
  }
  return [...merged.values()];
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

/** The not-found capture is filed by scenario, not by the name that was probed. */
const DETAILS_FIXTURE_ALIASES = new Map([['42crunch-api-security-testing', 'notinstalled']]);

/** Maps an argv to its captured fixture. Mirrors `fixtures/cli/<version>/`. */
function fixtureBaseName(argv: readonly string[]): string | undefined {
  const global = argv[0] === '--plugin-dir';
  const rest = global ? argv.slice(2) : [...argv];
  const joined = rest.join(' ');

  if (rest[0] === 'plugin' && rest[1] === 'list') {
    const late = rest.indexOf('--plugin-dir');
    if (late >= 0) {
      return late < rest.indexOf('--json')
        ? 'plugin-list-plugin-dir-mid'
        : 'plugin-list-plugin-dir-after';
    }
    if (rest.includes('--available')) return 'plugin-list-available';
    return global ? 'plugin-list-plugin-dir-before' : 'plugin-list';
  }
  if (joined === 'plugin marketplace list --json') return 'marketplace-list';
  if (joined === 'mcp list') return 'mcp-list';
  if (rest[0] === 'plugin' && rest[1] === 'details' && rest[2] !== undefined) {
    return `plugin-details-${DETAILS_FIXTURE_ALIASES.get(rest[2]) ?? rest[2]}`;
  }
  return undefined;
}

const readIfPresent = async (file: string): Promise<string | undefined> => {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
};

/** Replays captured stdout/stderr/exit. Zero egress by construction. */
export function createFixtureRunner(fixtureRoot: string, version: string): CommandRunner {
  const dir = path.join(fixtureRoot, 'cli', version);

  return async (argv) => {
    const base = fixtureBaseName(argv);
    if (base === undefined) {
      return { stdout: '', stderr: `no fixture maps to: claude ${argv.join(' ')}`, code: 127 };
    }

    const stdout =
      (await readIfPresent(path.join(dir, `${base}.json`))) ??
      (await readIfPresent(path.join(dir, `${base}.txt`)));
    if (stdout === undefined) {
      return { stdout: '', stderr: `missing fixture: ${base}`, code: 127 };
    }

    const stderr = (await readIfPresent(path.join(dir, `${base}.stderr`))) ?? '';
    const exit = (await readIfPresent(path.join(dir, `${base}.exit`))) ?? 'EXIT=0';
    const code = Number(/EXIT=(\d+)/u.exec(exit)?.[1] ?? '0');
    return { stdout, stderr, code };
  };
}

/** Windows cannot spawn `claude.cmd` without a shell; only paths need quoting. */
const quote = (arg: string): string => (/\s/u.test(arg) ? `"${arg.replace(/"/gu, '\\"')}"` : arg);

function createSpawnRunner(): CommandRunner {
  const shell = process.platform === 'win32';
  return (argv) =>
    new Promise<CommandOutcome>((resolve) => {
      execFile(
        'claude',
        shell ? argv.map(quote) : [...argv],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, shell },
        (error, stdout, stderr) => {
          const raw = error === null ? 0 : (error as { code?: unknown }).code;
          resolve({
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            code: typeof raw === 'number' ? raw : error === null ? 0 : 127,
          });
        },
      );
    });
}

/** Picks the fixture set for the running build, newest captured as fallback. */
async function resolveFixtureVersion(
  fixtureRoot: string,
  requested: string | undefined,
): Promise<{ version: string; matched: boolean }> {
  let captured: string[] = [];
  try {
    const entries = await readdir(path.join(fixtureRoot, 'cli'), { withFileTypes: true });
    captured = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    captured = [];
  }

  if (requested !== undefined && captured.includes(requested)) return { version: requested, matched: true };
  return { version: captured[captured.length - 1] ?? (requested ?? ''), matched: requested === undefined };
}

// ---------------------------------------------------------------------------
// The collector
// ---------------------------------------------------------------------------

/** Runs a command, returning parsed JSON or a warning. Never throws. */
async function json(
  runner: CommandRunner,
  argv: readonly string[],
  warnings: Warning[],
): Promise<unknown> {
  const outcome = await runner(argv);
  const label = `claude ${argv.join(' ')}`;

  // Trap 7: the exit code decides. stdout may hold an error sentence and
  // stderr may be empty on failure — parsing either as data is the bug.
  if (!succeeded(outcome)) {
    const detail = (outcome.stderr.trim() || outcome.stdout.trim()).split('\n')[0] ?? '';
    warnings.push(warn('partial', `${label} exited ${outcome.code}: ${detail}`, label));
    return undefined;
  }

  try {
    return JSON.parse(outcome.stdout) as unknown;
  } catch {
    warnings.push(warn('unsupported-version', `${label} did not return parseable JSON`, label));
    return undefined;
  }
}

export function createCliCollector(options: CliCollectorOptions = {}): Collector<CliInventory> {
  return {
    name: 'cli',
    async collect(ctx: CollectContext): Promise<CollectorResult<CliInventory>> {
      const started = Date.now();
      const warnings: Warning[] = [];

      try {
        let runner = options.runner;
        if (runner === undefined) {
          if (ctx.fixtureRoot !== undefined) {
            const resolved = await resolveFixtureVersion(ctx.fixtureRoot, ctx.claudeCodeVersion);
            if (!resolved.matched) {
              warnings.push(
                warn(
                  'unsupported-version',
                  `no fixtures captured for Claude Code ${ctx.claudeCodeVersion ?? 'unknown'}; ` +
                    `replaying ${resolved.version}`,
                ),
              );
            }
            runner = createFixtureRunner(ctx.fixtureRoot, resolved.version);
          } else {
            runner = createSpawnRunner();
          }
        }

        // Trap 18: --plugin-dir is a GLOBAL flag. After the subcommand the CLI
        // exits 1 with empty stdout, so the order below is load-bearing.
        const listArgv =
          options.pluginDir !== undefined
            ? ['--plugin-dir', options.pluginDir, 'plugin', 'list', '--json']
            : ['plugin', 'list', '--json'];

        const listRaw = await json(runner, listArgv, warnings);
        const list = parsePluginList(listRaw ?? []);
        warnings.push(...(listRaw === undefined ? [] : list.warnings));

        // Trap 1: a DIFFERENT top-level type, so a separate call and parser.
        const availableRaw = await json(runner, ['plugin', 'list', '--json', '--available'], warnings);
        const catalogue = parseAvailableList(availableRaw ?? {});
        warnings.push(...(availableRaw === undefined ? [] : catalogue.warnings));

        const marketRaw = await json(runner, ['plugin', 'marketplace', 'list', '--json'], warnings);
        const markets = parseMarketplaceList(marketRaw ?? []);
        warnings.push(...(marketRaw === undefined ? [] : markets.warnings));

        const fromPlugins = serversFromPluginRows(listRaw);
        let fromList: McpServerEntity[] = [];

        if (options.includeMcpList !== true) {
          warnings.push(
            warn(
              'partial',
              '`mcp list` skipped: it live-health-checks every server (~40s for 14) — ' +
                'pass includeMcpList to opt in. Connection states are unknown.',
            ),
          );
        } else if (ctx.offline) {
          warnings.push(
            warn('partial', '`mcp list` skipped: offline, and it dials every server'),
          );
        } else {
          const outcome = await runner(['mcp', 'list']);
          if (succeeded(outcome)) {
            const parsed = parseMcpList(outcome.stdout);
            fromList = parsed.servers;
            warnings.push(...parsed.warnings);
          } else {
            warnings.push(warn('partial', `claude mcp list exited ${outcome.code}`));
          }
        }

        return {
          ok: true,
          data: {
            plugins: list.plugins,
            available: catalogue.available,
            marketplaces: markets.marketplaces,
            mcpServers: mergeMcpServers(fromPlugins, fromList),
          },
          warnings,
          elapsedMs: Date.now() - started,
        };
      } catch (error: unknown) {
        // A failure is a value: one broken collector degrades one report
        // section, never the run.
        return {
          ok: false,
          data: null,
          warnings,
          error: {
            code: 'cli-collector-failed',
            message: error instanceof Error ? error.message : String(error),
          },
          elapsedMs: Date.now() - started,
        };
      }
    },
  };
}

export const cliCollector: Collector<CliInventory> = createCliCollector();
