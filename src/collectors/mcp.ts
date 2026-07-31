/**
 * The `mcp` collector — T1.3.
 *
 * Four declared sources, each read-only:
 *
 * 1. `~/.claude.json` → `mcpServers`            — user scope
 * 2. `~/.claude.json` → `projects[<path>]`      — local scope, project-keyed
 * 3. `<repo>/.mcp.json`                          — project scope
 * 4. `plugin list --json` → per-plugin `mcpServers` — plugin-bundled
 *
 * **Declared is not active.** `connection` defaults to `unknown` and only moves
 * on evidence. `Pending approval` is a first-class state: configured, not
 * running, zero always-on context. (Not recorded per-entity: MCP tool-schema
 * cost is unavailable for *every* server — FORMATS.md §1 — so there is no
 * non-zero case to contrast with, and `McpServerEntity` has no cost field.)
 *
 * **Structured beats display text.** Plugin-bundled servers come from the
 * `mcpServers` object nested in `plugin list --json`. The `plugin:<p>:<s>` form
 * in `mcp list` is a human-readable rendering, used here only as a join key.
 *
 * **`~/.claude.json` is ~193 KB across 95 top-level keys**, among them
 * `oauthAccount`, `userID`, `anonymousId` and `machineID`. {@link readClaudeJsonMcp}
 * parses it, narrows at once to the MCP slice and drops the document on return;
 * {@link extractClaudeJsonMcp} reads named keys only, so the narrowing is a
 * property of the code rather than of a filter.
 *
 * `claude mcp list` is never spawned: it live-health-checks every server (~40s
 * for 14 locally), which would blow the T1.11 cold budget and perform the
 * network I/O `CollectContext.offline` forbids. T1.11 owns invoking the CLI;
 * here the text is injected, or read from a fixture root.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type {
  CollectContext,
  Collector,
  CollectorResult,
  EntityState,
  McpServerEntity,
  Origin,
  Scope,
  Warning,
} from '../types.ts';
import { collisionWarnings, groupProjectKeys } from '../util/project-path.ts';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** The subset of a `plugin list --json` row this collector reads. */
export interface PluginMcpRecord {
  /** `"<plugin>@<marketplace>"`. Split on the LAST `@` — plugin names may contain one. */
  id: string;
  scope: Scope;
  mcpServers?: Record<string, unknown> | undefined;
}

export interface McpCollectorOptions {
  /** Defaults to `<fixtureRoot>/files/claude.json`, else `~/.claude.json`. */
  claudeJsonPath?: string;
  /** Defaults to `<ctx.project.displayPath>/.mcp.json` when a project is given. */
  projectMcpJsonPath?: string;
  /** Structured per-plugin servers. Supplied by the inventory service (T1.8). */
  pluginRecords?: readonly PluginMcpRecord[];
  /** Raw `claude mcp list` text. Injected; never fetched here. */
  mcpListText?: string;
}

/** One parsed row of `claude mcp list` display output. */
export interface McpListRow {
  name: string;
  target: string;
  transport: McpServerEntity['transport'] | 'unknown';
  connection: McpServerEntity['connection'];
}

/** Per-project MCP state, narrowed from one `projects` entry. */
export interface ProjectMcpState {
  rawKey: string;
  mcpServers: Record<string, unknown>;
  enabledMcpjsonServers: string[];
  disabledMcpjsonServers: string[];
  disabledMcpServers: string[];
}

/** Everything this collector reads out of `~/.claude.json`, and nothing else. */
export interface ClaudeJsonMcpSlice {
  userServers: Record<string, unknown>;
  projects: ProjectMcpState[];
}

// ---------------------------------------------------------------------------
// `mcp list` display text
// ---------------------------------------------------------------------------

/** Order matters: `Failed to connect` is tested before `Connected`. */
const STATUSES: ReadonlyArray<readonly [RegExp, McpServerEntity['connection']]> = [
  [/Pending approval/, 'pending-approval'],
  [/Needs authentication/, 'needs-auth'],
  [/Failed to connect/, 'failed'],
  [/Connected/, 'connected'],
];

/**
 * Splits `<name>: <target> - <glyph> <status>`. The name runs to the first
 * colon-**space**, keeping `plugin:<plugin>:<server>` intact (its colons carry
 * no space) while still handling names with spaces like `claude.ai Gmail`. The
 * status separator is space-hyphen-space, which cannot collide with `-y` or
 * `--extension` in a command, and the lazy head stops at the first such
 * separator that a status actually follows.
 */
const ROW = /^(.*?):[ ]+(.*?)\s+-\s+(?:\S\s+)?(Connected|Failed to connect|Needs authentication|Pending approval)\b/;

export function parseMcpListText(text: string): McpListRow[] {
  const rows: McpListRow[] = [];

  for (const line of text.split(/\r?\n/)) {
    const match = ROW.exec(line.trim());
    if (!match) continue;

    const name = (match[1] ?? '').trim();
    const target = (match[2] ?? '').trim();
    const status = match[3] ?? '';
    if (name === '') continue;

    const connection = STATUSES.find(([re]) => re.test(status))?.[1] ?? 'unknown';
    rows.push({ name, target, transport: transportFromTarget(target), connection });
  }

  return rows;
}

/** `(HTTP)` / `(SSE)` suffixes and the URL scheme are the only signals here. */
function transportFromTarget(target: string): McpListRow['transport'] {
  if (/\(SSE\)\s*$/i.test(target)) return 'sse';
  if (/^https?:\/\//i.test(target)) return 'http';
  return target === '' ? 'unknown' : 'stdio';
}

// ---------------------------------------------------------------------------
// `~/.claude.json`
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const stringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];

/**
 * Narrow a parsed `~/.claude.json` to the MCP slice.
 *
 * Named keys only. `oauthAccount`, `userID`, `anonymousId`, `machineID` and the
 * telemetry caches are never read, so they cannot be copied out — and neither
 * can the per-project cost/prompt history sitting beside `mcpServers`.
 *
 * Total function: any shape at all yields an empty slice rather than a throw.
 */
export function extractClaudeJsonMcp(parsed: unknown): ClaudeJsonMcpSlice {
  if (!isRecord(parsed)) return { userServers: {}, projects: [] };

  const userServers = isRecord(parsed['mcpServers']) ? parsed['mcpServers'] : {};

  const projectsValue = parsed['projects'];
  const projects: ProjectMcpState[] = [];
  if (isRecord(projectsValue)) {
    for (const [rawKey, state] of Object.entries(projectsValue)) {
      if (!isRecord(state)) continue;
      projects.push({
        rawKey,
        mcpServers: isRecord(state['mcpServers']) ? state['mcpServers'] : {},
        enabledMcpjsonServers: stringArray(state['enabledMcpjsonServers']),
        disabledMcpjsonServers: stringArray(state['disabledMcpjsonServers']),
        disabledMcpServers: stringArray(state['disabledMcpServers']),
      });
    }
  }

  return { userServers, projects };
}

/**
 * Read and narrow in one step, so the ~193 KB parsed document is unreachable
 * the moment this returns.
 */
async function readClaudeJsonMcp(file: string): Promise<ClaudeJsonMcpSlice> {
  return extractClaudeJsonMcp(JSON.parse(await readFile(file, 'utf8')));
}

// ---------------------------------------------------------------------------
// Server definitions → entities
// ---------------------------------------------------------------------------

/**
 * Build an entity from one raw server definition. Untrusted input at a system
 * boundary: a field failing its check is omitted, never coerced, and a
 * definition with neither `url` nor `command` has no determinable transport and
 * yields `undefined` — a broken entity is worse than an absent one.
 */
function toEntity(
  name: string,
  raw: unknown,
  fields: {
    scope: Scope;
    origin: Origin;
    source: McpServerEntity['source'];
    state: EntityState;
    connection: McpServerEntity['connection'];
    owningPlugin?: string;
  },
): McpServerEntity | undefined {
  if (!isRecord(raw)) return undefined;

  const declared = raw['type'];
  const url = typeof raw['url'] === 'string' ? raw['url'] : undefined;
  const command = typeof raw['command'] === 'string' ? raw['command'] : undefined;

  let transport: McpServerEntity['transport'];
  if (declared === 'stdio' || declared === 'http' || declared === 'sse') transport = declared;
  else if (url !== undefined) transport = 'http';
  else if (command !== undefined) transport = 'stdio';
  else return undefined;

  const rawArgs = raw['args'];
  const args = Array.isArray(rawArgs) && rawArgs.every((a) => typeof a === 'string')
    ? (rawArgs as string[])
    : undefined;

  const rawEnv = raw['env'];
  const env = isRecord(rawEnv) && Object.values(rawEnv).every((v) => typeof v === 'string')
    ? (rawEnv as Record<string, string>)
    : undefined;

  // Conditional spreads, not `key: undefined`: `exactOptionalPropertyTypes`
  // distinguishes an absent optional field from an explicitly-undefined one.
  return {
    id: { name, scope: fields.scope, kind: 'mcp-server' },
    origin: fields.origin,
    state: fields.state,
    source: fields.source,
    transport,
    connection: fields.connection,
    ...(fields.owningPlugin !== undefined ? { owningPlugin: fields.owningPlugin } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(env !== undefined ? { env } : {}),
  };
}

/** `"<plugin>@<marketplace>"` → `<plugin>`. Last `@` wins: names may contain one. */
function pluginNameFromId(id: string): string {
  const at = id.lastIndexOf('@');
  return at > 0 ? id.slice(0, at) : id;
}

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------

/**
 * Every path this collector will touch, decided in one place. `fixtureRoot` is
 * the repo `fixtures/` directory (the convention shared by all five
 * collectors), and reading it is confined here so a change of convention is a
 * change to this function and nowhere else.
 */
function resolveSources(
  ctx: CollectContext,
  options: McpCollectorOptions,
): {
  claudeJsonPath: string;
  projectMcpJsonPath: string | undefined;
  mcpListPath: string | undefined;
  pluginListPath: string | undefined;
} {
  const claudeJsonPath =
    options.claudeJsonPath ??
    (ctx.fixtureRoot !== undefined
      ? path.join(ctx.fixtureRoot, 'files', 'claude.json')
      : path.join(os.homedir(), '.claude.json'));

  const projectMcpJsonPath =
    options.projectMcpJsonPath ??
    (ctx.project !== undefined ? path.join(ctx.project.displayPath, '.mcp.json') : undefined);

  // CLI artefacts are read from a fixture root only. There is no production
  // path here by design: the real ones would mean spawning the CLI, which this
  // collector never does. T1.8 injects them via `options` instead.
  const cliDir =
    ctx.fixtureRoot !== undefined && ctx.claudeCodeVersion !== undefined
      ? path.join(ctx.fixtureRoot, 'cli', ctx.claudeCodeVersion)
      : undefined;

  return {
    claudeJsonPath,
    projectMcpJsonPath,
    mcpListPath: cliDir !== undefined ? path.join(cliDir, 'mcp-list.txt') : undefined,
    pluginListPath: cliDir !== undefined ? path.join(cliDir, 'plugin-list.json') : undefined,
  };
}

/** `plugin list --json` rows, keeping only the fields this collector reads. */
function toPluginRecords(parsed: unknown): PluginMcpRecord[] {
  if (!Array.isArray(parsed)) return [];

  return parsed.flatMap((row: unknown) => {
    if (!isRecord(row) || typeof row['id'] !== 'string') return [];
    if (!isRecord(row['mcpServers'])) return [];
    const scope = row['scope'];
    return [
      {
        id: row['id'],
        scope: typeof scope === 'string' ? (scope as Scope) : 'user',
        mcpServers: row['mcpServers'],
      },
    ];
  });
}

const isMissing = (error: unknown): boolean =>
  isRecord(error) && (error['code'] === 'ENOENT' || error['code'] === 'ENOTDIR');

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// ---------------------------------------------------------------------------
// The collector
// ---------------------------------------------------------------------------

export function createMcpCollector(options: McpCollectorOptions = {}): Collector<McpServerEntity[]> {
  return {
    name: 'mcp',
    collect: (ctx) => collect(ctx, options),
  };
}

async function collect(
  ctx: CollectContext,
  options: McpCollectorOptions,
): Promise<CollectorResult<McpServerEntity[]>> {
  const started = performance.now();
  const warnings: Warning[] = [];
  const entities: McpServerEntity[] = [];

  const done = (data: McpServerEntity[]): CollectorResult<McpServerEntity[]> => ({
    ok: true,
    data,
    warnings,
    elapsedMs: performance.now() - started,
  });

  try {
    const { claudeJsonPath, projectMcpJsonPath, mcpListPath, pluginListPath } = resolveSources(
      ctx,
      options,
    );

    // --- 1 & 2: ~/.claude.json -------------------------------------------
    let slice: ClaudeJsonMcpSlice = { userServers: {}, projects: [] };
    try {
      slice = await readClaudeJsonMcp(claudeJsonPath);
    } catch (error: unknown) {
      // `partial`, not `collector-failed`: every other source is still read.
      warnings.push({
        code: 'partial',
        message: `could not read user and local scope MCP servers from ${claudeJsonPath} — ${message(error)}`,
        subject: claudeJsonPath,
      });
    }

    for (const [name, raw] of Object.entries(slice.userServers)) {
      const entity = toEntity(name, raw, {
        scope: 'user',
        origin: 'personal',
        source: 'file',
        state: 'enabled',
        connection: 'unknown',
      });
      if (entity) entities.push(entity);
    }

    // Grouped even when one project is in view: a collision is a defect in the
    // user's configuration, worth surfacing whatever the current scope is.
    const projectRefs = groupProjectKeys(slice.projects.map((p) => p.rawKey));
    warnings.push(...collisionWarnings(projectRefs));

    // Local scope belongs to one project. Without `ctx.project` there is no
    // project in view, and another project's local servers are not part of the
    // stack being inventoried — F9 supplies the project for that. A colliding
    // key contributes ALL its raw entries, since none of them was discarded.
    const activeRef = ctx.project !== undefined
      ? projectRefs.find((ref) => ref.key === ctx.project?.key)
      : undefined;
    const activeStates = activeRef
      ? slice.projects.filter((p) => activeRef.rawKeys.includes(p.rawKey))
      : [];

    const seenLocal = new Set<string>();
    for (const state of activeStates) {
      for (const [name, raw] of Object.entries(state.mcpServers)) {
        // Two colliding keys can declare the same server; first wins, and the
        // path-collision warning already points the reader at both entries.
        if (seenLocal.has(name)) continue;
        seenLocal.add(name);

        const entity = toEntity(name, raw, {
          scope: 'local',
          origin: 'project',
          source: 'file',
          state: state.disabledMcpServers.includes(name) ? 'disabled' : 'enabled',
          connection: 'unknown',
        });
        if (entity) entities.push(entity);
      }
    }

    // --- 3: <repo>/.mcp.json ---------------------------------------------
    if (projectMcpJsonPath !== undefined) {
      try {
        const parsed: unknown = JSON.parse(await readFile(projectMcpJsonPath, 'utf8'));
        const servers = isRecord(parsed) && isRecord(parsed['mcpServers']) ? parsed['mcpServers'] : {};

        const enabled = new Set(activeStates.flatMap((s) => s.enabledMcpjsonServers));
        const disabled = new Set(activeStates.flatMap((s) => s.disabledMcpjsonServers));

        for (const [name, raw] of Object.entries(servers)) {
          // A `.mcp.json` server the user has neither approved nor refused is
          // awaiting the trust prompt. Derived from files alone; matches the
          // live `claude-flow` case, and is overridden below by CLI state.
          const pending = !enabled.has(name) && !disabled.has(name);
          const entity = toEntity(name, raw, {
            scope: 'project',
            origin: 'project',
            source: 'file',
            state: disabled.has(name) ? 'disabled' : 'enabled',
            connection: pending ? 'pending-approval' : 'unknown',
          });
          if (entity) entities.push(entity);
        }
      } catch (error: unknown) {
        // Most repos have no .mcp.json. Absence is the normal case, not news.
        if (!isMissing(error)) {
          warnings.push({
            code: 'partial',
            message: `could not read ${projectMcpJsonPath} — ${message(error)}`,
            subject: projectMcpJsonPath,
          });
        }
      }
    }

    // --- 4: plugin-bundled servers ---------------------------------------
    let pluginRecords = options.pluginRecords;
    if (pluginRecords === undefined && pluginListPath !== undefined) {
      try {
        pluginRecords = toPluginRecords(JSON.parse(await readFile(pluginListPath, 'utf8')));
      } catch (error: unknown) {
        if (!isMissing(error)) {
          warnings.push({
            code: 'partial',
            message: `could not read ${pluginListPath} — ${message(error)}`,
            subject: pluginListPath,
          });
        }
      }
    }

    if (pluginRecords === undefined) {
      warnings.push({
        code: 'partial',
        message:
          'plugin-bundled MCP servers were not enumerated — no `plugin list --json` records ' +
          'were supplied to the mcp collector.',
      });
    } else {
      for (const record of pluginRecords) {
        if (!isRecord(record.mcpServers)) continue;
        const plugin = pluginNameFromId(record.id);

        for (const [name, raw] of Object.entries(record.mcpServers)) {
          const entity = toEntity(`plugin:${plugin}:${name}`, raw, {
            scope: record.scope,
            // A sideloaded plugin is scope "session" and was never installed
            // from a marketplace. Anything else reached the machine through one.
            origin: record.scope === 'session' ? 'inline' : 'marketplace',
            source: 'cli',
            state: 'enabled',
            connection: 'unknown',
            owningPlugin: plugin,
          });
          if (entity) entities.push(entity);
        }
      }
    }

    // --- connection state from `mcp list` display text --------------------
    let mcpListText = options.mcpListText;
    if (mcpListText === undefined && mcpListPath !== undefined) {
      try {
        mcpListText = await readFile(mcpListPath, 'utf8');
      } catch (error: unknown) {
        if (!isMissing(error)) {
          warnings.push({
            code: 'partial',
            message: `could not read ${mcpListPath} — ${message(error)}`,
            subject: mcpListPath,
          });
        }
      }
    }

    if (mcpListText === undefined) return done(entities);

    const rows = parseMcpListText(mcpListText);
    const byRowName = new Map(rows.map((row) => [row.name, row]));

    // A new array of new objects: collectors are pure, and an entity already
    // handed out is never rewritten under the caller.
    const withConnection = entities.map((entity) => {
      const row = byRowName.get(entity.id.name);
      // Only `connection` moves. `source` is the entity's DECLARATION
      // provenance — where it was configured — not the provenance of the last
      // fact learned about it. A server declared in a file is still file-
      // declared when its health is read from the CLI; per-fact provenance is
      // what `Sourced<T>` exists for.
      return row === undefined ? entity : { ...entity, connection: row.connection };
    });

    const declared = new Set(entities.map((entity) => entity.id.name));
    const unmatched = rows.filter((row) => !declared.has(row.name)).map((row) => row.name);
    if (unmatched.length > 0) {
      // Chiefly the claude.ai connectors, which live in claude.ai config — a
      // source T1.3 does not read. They are reported rather than turned into
      // entities, because an entity would need a scope and an origin this
      // collector would have to invent.
      warnings.push({
        code: 'reconciliation',
        message:
          `${unmatched.length} MCP server(s) appear in \`claude mcp list\` but in none of the ` +
          `configuration files read by this collector: ${unmatched.join(', ')}.`,
      });
    }

    return done(withConnection);
  } catch (error: unknown) {
    // Nothing above should reach here, but a collector never throws across its
    // boundary: one broken collector degrades one report section, not the run.
    return {
      ok: false,
      data: null,
      warnings: [
        ...warnings,
        { code: 'collector-failed', message: `mcp collector failed — ${message(error)}` },
      ],
      error: { code: 'mcp-collector-failed', message: message(error) },
      elapsedMs: performance.now() - started,
    };
  }
}

/** Default instance: real paths, no CLI input. */
export const mcpCollector: Collector<McpServerEntity[]> = createMcpCollector();
