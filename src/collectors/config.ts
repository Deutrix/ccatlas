/**
 * T1.2 — the `config` collector: settings resolution across four scopes.
 *
 * WHAT THIS FILE ASSERTS THAT THE REFERENCE MACHINE COULD NOT WITNESS
 * ------------------------------------------------------------------
 * FORMATS.md §5 records that the capture machine has no project-scope
 * `.claude/settings.json`, no local-scope plugin keys, and no `pluginConfigs`
 * at all — so four-scope precedence is untestable there. The behaviour below is
 * therefore built against documented rules and verified against the synthetic
 * oracle in `fixtures/synthetic/precedence/`, which deliberately refuses to
 * pick a merge model and demands that this file declare one. It does, in
 * `mergeModel` / `permissionModel`, and the declaration is part of the output
 * so a consumer never has to infer it.
 *
 * DECLARED MODEL — per-key merge, one level deep.
 *   For each ENTRY of a Record-shaped setting, the highest-precedence scope
 *   defining THAT entry supplies the whole value verbatim. Values are never
 *   recursed into: two scopes declaring the same marketplace with differently
 *   shaped `source` objects must not produce a hybrid of the two.
 *   Permission lists are unioned across every scope instead (primary docs:
 *   "permission rules merge across scopes rather than override").
 *
 * FOUR FACTS FROM PHASE 0, ENCODED HERE
 *   1. `enabledPlugins` is the only home of the enabled bit — not
 *      installed_plugins.json, not the plugin manifest. A `false` is therefore
 *      load-bearing and is never conflated with an absent key.
 *   2. `pluginConfigs` is read from user settings, `--settings` and managed
 *      settings ONLY. Project and local are IGNORED — not outranked, ignored —
 *      because a cloned repo could otherwise inject values into hook commands
 *      and MCP server configs (docs/02-architecture.md:158). Security boundary.
 *   3. `extraKnownMarketplaces` legitimately holds fewer entries than
 *      known_marketplaces.json: the auto-installed official marketplace is
 *      absent from settings. Not an error, never reported as one.
 *   4. `autoUpdatesChannel` (settings) and `autoUpdates` (~/.claude.json) drive
 *      the Claude Code CLI self-updater, NOT marketplaces. Nothing in this file
 *      reads them, and no marketplace fact is derived from them.
 *
 * Read-only and pure: no writes, no mutation of inputs, no egress, and no throw
 * across the collector boundary — a broken settings file degrades its own scope.
 */

import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type {
  CollectContext,
  Collector,
  CollectorResult,
  FactSource,
  PluginSource,
  Scope,
  Warning,
} from '../types.ts';

// ---------------------------------------------------------------------------
// Scope order
// ---------------------------------------------------------------------------

/**
 * Lowest precedence first. From primary documentation (code.claude.com/docs/en/
 * settings): managed > command-line settings > local > project > user. The
 * `--settings` layer is carried as scope `session`, the existing vocabulary for
 * a per-invocation origin.
 *
 * The synthetic oracle grades this order ASSERTED because no project- or
 * managed-scope file exists on the reference machine to observe it with; the
 * documentation above is what upgrades it, not the corpus.
 */
export const SETTINGS_PRECEDENCE = [
  'user',
  'project',
  'local',
  'session',
  'managed',
] as const satisfies readonly Scope[];

export type SettingsScope = (typeof SETTINGS_PRECEDENCE)[number];

/**
 * The `pluginConfigs` allowlist. `session` stands for `--settings`, the third
 * permitted source named at docs/02-architecture.md:158. Modelled as a set that
 * filters layers BEFORE merging, not as an ordering — a resolver that merely
 * reorders these scopes still lets a cloned repo supply a value.
 */
export const PLUGIN_CONFIG_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  'user',
  'session',
  'managed',
]);

/**
 * Managed settings locations, from primary documentation. The legacy Windows
 * path `C:\ProgramData\ClaudeCode\managed-settings.json` was dropped in v2.1.75
 * and is deliberately not consulted (the corpus is v2.1.220). Each file has an
 * optional `managed-settings.d/` drop-in directory beside it.
 */
export const MANAGED_SETTINGS_PATHS = {
  darwin: '/Library/Application Support/ClaudeCode/managed-settings.json',
  linux: '/etc/claude-code/managed-settings.json',
  win32: 'C:\\Program Files\\ClaudeCode\\managed-settings.json',
} as const;

/**
 * `ctx.fixtureRoot` is the repository's `fixtures/` directory, so in fixture
 * mode the four scopes come from the synthetic precedence corpus — the only
 * four-scope settings set that exists anywhere. The corpus README is explicit
 * that its `managed-settings.json` is PATH-AGNOSTIC and must be loaded by
 * content, not location: this mapping is that loading step, and says nothing
 * about where a real managed file lives (see MANAGED_SETTINGS_PATHS for that).
 */
export const PRECEDENCE_FIXTURE = {
  dir: 'synthetic/precedence',
  files: {
    user: 'user-settings.json',
    project: 'project-settings.json',
    local: 'local-settings.json',
    managed: 'managed-settings.json',
  },
} as const satisfies { dir: string; files: Record<string, string> };

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type RawSettings = Readonly<Record<string, unknown>>;

export interface SettingsLayer {
  readonly scope: Scope;
  /** Where it came from. Diagnostic only — precedence never depends on it. */
  readonly path: string;
  readonly settings: RawSettings;
}

export type ScopeStatus = 'read' | 'absent' | 'unreadable' | 'malformed';

export interface ScopeReport {
  readonly scope: Scope;
  readonly path: string;
  readonly status: ScopeStatus;
  readonly detail?: string;
}

export interface Provenance<T> {
  readonly value: T;
  /** The scope that supplied the winning value. */
  readonly scope: Scope;
  /** Scopes that defined this entry and lost, highest precedence first. */
  readonly shadowed: Scope[];
  /** Scopes that defined it but are not permitted to. `pluginConfigs` only. */
  readonly ignored?: Scope[];
  readonly source: FactSource;
}

export type ResolvedMap<T> = Record<string, Provenance<T>>;

/** An input that was read and deliberately not used. Reported, never silent. */
export interface DroppedInput {
  readonly setting: string;
  readonly entry: string;
  readonly definedAt: Scope[];
  readonly reason: string;
}

export interface MarketplaceRef {
  readonly source?: PluginSource;
  readonly [key: string]: unknown;
}

export interface PermissionRule {
  readonly rule: string;
  /** Every scope that contributed this rule, highest precedence first. */
  readonly scopes: Scope[];
}

export interface ResolvedPermissions {
  readonly defaultMode?: Provenance<string>;
  readonly allow: PermissionRule[];
  readonly deny: PermissionRule[];
  readonly ask: PermissionRule[];
  readonly additionalDirectories: PermissionRule[];
}

export interface ConfigData {
  /** Declared, not inferred. See the header. */
  readonly mergeModel: 'per-key-merge';
  readonly permissionModel: 'array-union-deny-wins';
  readonly scopes: ScopeReport[];
  readonly enabledPlugins: ResolvedMap<boolean>;
  readonly extraKnownMarketplaces: ResolvedMap<MarketplaceRef>;
  readonly pluginConfigs: ResolvedMap<Record<string, unknown>>;
  readonly env: ResolvedMap<string>;
  readonly permissions: ResolvedPermissions;
  readonly droppedInputs: DroppedInput[];
}

export interface CollectConfigOptions {
  /** Paths passed via `--settings`. Resolved as scope `session`. */
  readonly settingsArgPaths?: readonly string[];
  /**
   * Overrides for the roots discovery walks. Exists so the path-resolution
   * logic can be exercised against a throwaway tree: `fixtureRoot` names the
   * repository's `fixtures/` directory and therefore cannot stand in for a
   * home directory. Never set in production.
   */
  readonly roots?: {
    readonly home?: string;
    readonly projectDir?: string;
    readonly managedBase?: string;
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const rank = (scope: Scope): number =>
  (SETTINGS_PRECEDENCE as readonly Scope[]).indexOf(scope);

/** Accumulator for one entry of one Record-shaped setting. */
interface Accumulator<T> {
  value: T | undefined;
  scope: Scope | undefined;
  /** Losing scopes in discovery order; reversed on the way out. */
  lost: Scope[];
  /** Scopes rejected by the allowlist, in discovery order (oracle's order). */
  ignored: Scope[];
}

function mergeRecordSetting<T>(
  layers: readonly SettingsLayer[],
  setting: string,
  isValid: (value: unknown) => value is T,
  expected: string,
  dropped: DroppedInput[],
  allowed?: ReadonlySet<Scope>,
): ResolvedMap<T> {
  const accumulators = new Map<string, Accumulator<T>>();

  for (const layer of layers) {
    const raw = layer.settings[setting];
    if (raw === undefined) continue;
    if (!isRecord(raw)) {
      dropped.push({
        setting,
        entry: '*',
        definedAt: [layer.scope],
        reason: `unexpected value type: ${setting} must be an object`,
      });
      continue;
    }

    for (const [entry, value] of Object.entries(raw)) {
      const acc: Accumulator<T> = accumulators.get(entry) ?? {
        value: undefined,
        scope: undefined,
        lost: [],
        ignored: [],
      };

      if (allowed && !allowed.has(layer.scope)) {
        acc.ignored.push(layer.scope);
        accumulators.set(entry, acc);
        continue;
      }
      if (!isValid(value)) {
        // Deliberately NOT stored, so the accumulator map holds only entries
        // that either won or were refused by the allowlist. An entry can still
        // collect one record here AND one allowlist record from another scope:
        // two causes at two scopes are two facts, and both are reported.
        dropped.push({
          setting,
          entry,
          definedAt: [layer.scope],
          reason: `unexpected value type: expected ${expected}`,
        });
        continue;
      }
      if (acc.scope !== undefined) acc.lost.push(acc.scope);
      acc.value = value;
      acc.scope = layer.scope;
      accumulators.set(entry, acc);
    }
  }

  return finalise(accumulators, setting, dropped, allowed);
}

/** Turns accumulators into provenance, dropping entries that never won. */
function finalise<T>(
  accumulators: ReadonlyMap<string, Accumulator<T>>,
  setting: string,
  dropped: DroppedInput[],
  allowed: ReadonlySet<Scope> | undefined,
): ResolvedMap<T> {
  const out: ResolvedMap<T> = {};

  for (const [entry, acc] of accumulators) {
    if (acc.scope === undefined || acc.value === undefined) {
      // Defined only at scopes that are not permitted to define it. The
      // strongest form of the pluginConfigs rule: no entry at all.
      if (allowed !== undefined && acc.ignored.length > 0) {
        dropped.push({
          setting,
          entry,
          definedAt: dedupe(acc.ignored),
          reason: `ignored by rule: ${setting} is read only from ${describeScopes(allowed)} settings`,
        });
      }
      continue;
    }
    // An entry can be ignored at some scopes and still resolve from a
    // permitted one. That is STILL a rule-drop and belongs in droppedInputs
    // alongside the resolves-to-nothing case above — otherwise enumerating
    // every rule-drop means checking two different places depending on
    // whether the entry happened to survive, and a caller that checks only
    // droppedInputs silently under-reports the security-relevant ones.
    if (allowed !== undefined && acc.ignored.length > 0) {
      dropped.push({
        setting,
        entry,
        definedAt: dedupe([acc.scope, ...acc.lost, ...acc.ignored]),
        reason:
          `ignored by rule: ${setting} is read only from ${describeScopes(allowed)} settings; ` +
          `resolved from ${acc.scope}`,
      });
    }

    out[entry] = {
      value: acc.value,
      scope: acc.scope,
      shadowed: dedupe([...acc.lost].reverse()),
      ...(acc.ignored.length > 0 ? { ignored: dedupe(acc.ignored) } : {}),
      source: 'file' satisfies FactSource,
    };
  }

  return out;
}

const dedupe = (scopes: readonly Scope[]): Scope[] => [...new Set(scopes)];

/** `session` is this file's name for the `--settings` layer; say so out loud. */
const describeScopes = (scopes: ReadonlySet<Scope>): string =>
  [...scopes].map((scope) => (scope === 'session' ? '--settings' : scope)).join(', ');

const PERMISSION_LISTS = ['allow', 'deny', 'ask', 'additionalDirectories'] as const;
type PermissionList = (typeof PERMISSION_LISTS)[number];

function mergePermissions(layers: readonly SettingsLayer[], dropped: DroppedInput[]): ResolvedPermissions {
  const lists = new Map<PermissionList, Map<string, Scope[]>>(
    PERMISSION_LISTS.map((name) => [name, new Map<string, Scope[]>()]),
  );
  const mode: Accumulator<string> = { value: undefined, scope: undefined, lost: [], ignored: [] };

  for (const layer of layers) {
    const raw = layer.settings['permissions'];
    if (raw === undefined) continue;
    if (!isRecord(raw)) {
      dropped.push({
        setting: 'permissions',
        entry: '*',
        definedAt: [layer.scope],
        reason: 'unexpected value type: permissions must be an object',
      });
      continue;
    }

    const defaultMode = raw['defaultMode'];
    if (typeof defaultMode === 'string') {
      if (mode.scope !== undefined) mode.lost.push(mode.scope);
      mode.value = defaultMode;
      mode.scope = layer.scope;
    }

    for (const name of PERMISSION_LISTS) {
      const rules = raw[name];
      if (rules === undefined) continue;
      if (!Array.isArray(rules)) {
        dropped.push({
          setting: `permissions.${name}`,
          entry: '*',
          definedAt: [layer.scope],
          reason: 'unexpected value type: expected an array of strings',
        });
        continue;
      }
      const bucket = lists.get(name)!;
      for (const rule of rules) {
        if (typeof rule !== 'string') {
          dropped.push({
            setting: `permissions.${name}`,
            entry: String(rule),
            definedAt: [layer.scope],
            reason: 'unexpected value type: expected a string rule',
          });
          continue;
        }
        // Highest precedence first: layers arrive ascending, so unshift.
        const scopes = bucket.get(rule) ?? [];
        if (!scopes.includes(layer.scope)) scopes.unshift(layer.scope);
        bucket.set(rule, scopes);
      }
    }
  }

  const toRules = (name: PermissionList): PermissionRule[] =>
    [...lists.get(name)!].map(([rule, scopes]) => ({ rule, scopes }));

  return {
    ...(mode.scope !== undefined && mode.value !== undefined
      ? {
          defaultMode: {
            value: mode.value,
            scope: mode.scope,
            shadowed: dedupe([...mode.lost].reverse()),
            source: 'file' satisfies FactSource,
          },
        }
      : {}),
    allow: toRules('allow'),
    deny: toRules('deny'),
    ask: toRules('ask'),
    additionalDirectories: toRules('additionalDirectories'),
  };
}

/**
 * Effective decision for one rule pattern. Deny outranks ask outranks allow,
 * whatever scope each came from — an allow at user scope must never defeat a
 * managed deny. Exact-match only: pattern semantics belong to Claude Code, and
 * guessing them here would produce a confident wrong answer.
 */
export function permissionDecision(
  permissions: ResolvedPermissions,
  rule: string,
): 'deny' | 'ask' | 'allow' | 'unset' {
  if (permissions.deny.some((r) => r.rule === rule)) return 'deny';
  if (permissions.ask.some((r) => r.rule === rule)) return 'ask';
  if (permissions.allow.some((r) => r.rule === rule)) return 'allow';
  return 'unset';
}

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isString = (value: unknown): value is string => typeof value === 'string';
const isMarketplaceRef = (value: unknown): value is MarketplaceRef => isRecord(value);
const isPluginConfig = (value: unknown): value is Record<string, unknown> => isRecord(value);

/**
 * The pure core. Layers may arrive in any order; they are sorted by scope
 * precedence, stably, so several files sharing one scope (the two
 * `settings.local.json` locations) keep their given order within it.
 */
export function resolveSettings(
  layers: readonly SettingsLayer[],
  reports?: readonly ScopeReport[],
): ConfigData {
  const ordered = layers
    .map((layer, index) => ({ layer, index }))
    .sort((a, b) => rank(a.layer.scope) - rank(b.layer.scope) || a.index - b.index)
    .map((entry) => entry.layer);

  const droppedInputs: DroppedInput[] = [];

  return {
    mergeModel: 'per-key-merge',
    permissionModel: 'array-union-deny-wins',
    scopes: [...(reports ?? ordered.map((l) => ({ scope: l.scope, path: l.path, status: 'read' as const })))],
    enabledPlugins: mergeRecordSetting(ordered, 'enabledPlugins', isBoolean, 'a boolean', droppedInputs),
    extraKnownMarketplaces: mergeRecordSetting(
      ordered,
      'extraKnownMarketplaces',
      isMarketplaceRef,
      'an object',
      droppedInputs,
    ),
    pluginConfigs: mergeRecordSetting(
      ordered,
      'pluginConfigs',
      isPluginConfig,
      'an object',
      droppedInputs,
      PLUGIN_CONFIG_SCOPES,
    ),
    env: mergeRecordSetting(ordered, 'env', isString, 'a string', droppedInputs),
    permissions: mergePermissions(ordered, droppedInputs),
    droppedInputs,
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

interface Candidate {
  readonly scope: Scope;
  readonly path: string;
}

function managedBasePath(): string {
  const platform = process.platform;
  if (platform === 'darwin') return MANAGED_SETTINGS_PATHS.darwin;
  if (platform === 'win32') return MANAGED_SETTINGS_PATHS.win32;
  return MANAGED_SETTINGS_PATHS.linux;
}

/**
 * Fixture mode. Guarantees the collector touches nothing outside `fixtures/`:
 * no home directory, no system managed path, no project tree.
 */
function fixtureCandidates(fixtureRoot: string, options: CollectConfigOptions): Candidate[] {
  const dir = path.join(fixtureRoot, ...PRECEDENCE_FIXTURE.dir.split('/'));
  const out: Candidate[] = [
    { scope: 'user', path: path.join(dir, PRECEDENCE_FIXTURE.files.user) },
    { scope: 'project', path: path.join(dir, PRECEDENCE_FIXTURE.files.project) },
    { scope: 'local', path: path.join(dir, PRECEDENCE_FIXTURE.files.local) },
  ];
  for (const settingsArg of options.settingsArgPaths ?? []) {
    out.push({ scope: 'session', path: settingsArg });
  }
  out.push({ scope: 'managed', path: path.join(dir, PRECEDENCE_FIXTURE.files.managed) });
  return out;
}

/**
 * Candidate files, lowest precedence first.
 *
 * ASSERTED, and nothing in the corpus discriminates it: `~/.claude/
 * settings.local.json` exists on the reference machine but is absent from the
 * documented precedence list, which names only the per-project
 * `.claude/settings.local.json`. Both are treated as scope `local`, with the
 * project file ranked above the home one. If that sub-order turns out to
 * matter, this is the one line to change.
 */
async function candidates(
  ctx: CollectContext,
  options: CollectConfigOptions,
): Promise<Candidate[]> {
  if (ctx.fixtureRoot !== undefined) return fixtureCandidates(ctx.fixtureRoot, options);

  const home = options.roots?.home ?? os.homedir();
  const projectDir = options.roots?.projectDir ?? ctx.project?.displayPath;

  const out: Candidate[] = [{ scope: 'user', path: path.join(home, '.claude', 'settings.json') }];
  if (projectDir !== undefined) {
    out.push({ scope: 'project', path: path.join(projectDir, '.claude', 'settings.json') });
  }
  out.push({ scope: 'local', path: path.join(home, '.claude', 'settings.local.json') });
  if (projectDir !== undefined) {
    out.push({ scope: 'local', path: path.join(projectDir, '.claude', 'settings.local.json') });
  }
  for (const settingsArg of options.settingsArgPaths ?? []) {
    out.push({ scope: 'session', path: settingsArg });
  }

  const managed = options.roots?.managedBase ?? managedBasePath();
  out.push({ scope: 'managed', path: managed });
  for (const dropIn of await dropInFiles(managed)) {
    out.push({ scope: 'managed', path: dropIn });
  }
  return out;
}

/** `managed-settings.d/*.json`, lexicographic — later files rank higher. */
async function dropInFiles(managed: string): Promise<string[]> {
  const dir = managed.replace(/\.json$/, '.d');
  try {
    const names = await readdir(dir);
    return names
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

interface LoadedLayer {
  readonly report: ScopeReport;
  readonly layer?: SettingsLayer;
}

async function loadCandidate(candidate: Candidate): Promise<LoadedLayer> {
  const { scope, path: file } = candidate;
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { report: { scope, path: file, status: 'absent' } };
    }
    return {
      report: { scope, path: file, status: 'unreadable', detail: describe(error) },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    return { report: { scope, path: file, status: 'malformed', detail: describe(error) } };
  }
  if (!isRecord(parsed)) {
    return {
      report: { scope, path: file, status: 'malformed', detail: 'top-level value is not an object' },
    };
  }
  return { report: { scope, path: file, status: 'read' }, layer: { scope, path: file, settings: parsed } };
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Everything the result knows it does not know.
 *
 * All of these are `partial`: the collection succeeded and is knowingly
 * incomplete. Never `reconciliation` — T1.8 consumes that code and an absent
 * input is not a disagreement between two sources. Never `collector-failed`
 * either: a degraded scope is not a dead collector, and `data.scopes[]` carries
 * the structural detail for anyone who needs more than the code.
 */
function incompleteness(
  reports: readonly ScopeReport[],
  layers: readonly SettingsLayer[],
): Warning[] {
  const warnings: Warning[] = reports
    .filter((report) => report.status === 'malformed' || report.status === 'unreadable')
    .map((report) => ({
      code: 'partial',
      message: `settings scope "${report.scope}" was skipped (${report.status}${report.detail ? `: ${report.detail}` : ''}); values it defined are missing from this result`,
      subject: report.path,
    }));

  // Absent, not empty. The distinction is the whole point of the code: nobody
  // should read "no plugin options" off a file that was never there.
  if (!layers.some((l) => l.settings['pluginConfigs'] !== undefined)) {
    warnings.push({
      code: 'partial',
      message:
        'no scope defined pluginConfigs; plugin option values are unknown, not empty (absent on the reference machine too)',
      subject: 'pluginConfigs',
    });
  }

  const project = reports.find((report) => report.scope === 'project');
  if (project !== undefined && project.status === 'absent') {
    warnings.push({
      code: 'partial',
      message: 'no project-scope settings file; project-scope overrides are unknown, not absent',
      subject: project.path,
    });
  }

  return warnings;
}

/**
 * Reads every scope and resolves them. `ctx.offline` needs no handling: this
 * collector only ever touches the local filesystem.
 */
export async function collectConfig(
  ctx: CollectContext,
  options: CollectConfigOptions = {},
): Promise<CollectorResult<ConfigData>> {
  const started = performance.now();
  try {
    const loaded = await Promise.all((await candidates(ctx, options)).map(loadCandidate));
    const reports = loaded.map((entry) => entry.report);
    const layers = loaded.flatMap((entry) => (entry.layer ? [entry.layer] : []));

    const data = resolveSettings(layers, reports);
    return {
      ok: true,
      data,
      warnings: incompleteness(reports, layers),
      elapsedMs: performance.now() - started,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      data: null,
      warnings: [{ code: 'collector-failed', message: describe(error), subject: 'config' }],
      error: { code: 'config-collector-failed', message: describe(error) },
      elapsedMs: performance.now() - started,
    };
  }
}

export const configCollector: Collector<ConfigData> = {
  name: 'config',
  collect: (ctx: CollectContext) => collectConfig(ctx),
};
