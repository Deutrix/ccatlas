/**
 * Inventory service — T1.6 (entity model), T1.7 (shadowing), T1.8
 * (reconciliation), T1.9 (version resolution).
 *
 * The first module above the collector layer, and therefore the first place
 * the layering rule bites: **nothing here reads a source.** Every input
 * arrives as a `CollectorOutcome` from `collectors/isolate.ts`, which is also
 * why one broken collector degrades one section here rather than throwing.
 *
 * ## The invariant this module exists to hold
 *
 * `merge` never picks a winner between the CLI and the files. When they
 * disagree it keeps **both** — the survivor in `Sourced.value`, the loser in
 * `Sourced.conflictsWith` — and emits a `reconciliation` warning. "Prefer CLI,
 * fall back to file" typechecks perfectly and is the wrong program: the two
 * layers hold different things (only the CLI reports `enabled`; only
 * `installed_plugins.json` reports `gitCommitSha`), so a disagreement is
 * evidence about the machine, not noise to be resolved away.
 *
 * ## Keying
 *
 * `(name, scope)`, never name alone. `installed_plugins.json` stores an array
 * per plugin with one element per scope, and a plugin installed at two scopes
 * can hold two different versions. Collapsing on name loses that, silently.
 */

import { SETTINGS_PRECEDENCE } from '../collectors/config.ts';
import type { CollectorOutcome, TaggedWarning } from '../collectors/isolate.ts';
import type { CliInventory } from '../collectors/cli.ts';
import type { ConfigData } from '../collectors/config.ts';
import type { InstalledPluginRecord, RegistryData } from '../collectors/registry.ts';
import type { SkillsInventory } from '../collectors/skills.ts';
import type {
  Entity,
  EntityId,
  FactSource,
  MarketplaceEntity,
  McpServerEntity,
  PluginEntity,
  Scope,
  Sourced,
  VersionInfo,
  VersionSource,
  Warning,
} from '../types.ts';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** A plugin after CLI and file records have been merged, not chosen between. */
export interface MergedPlugin extends Omit<PluginEntity, 'version'> {
  /** Which layers contributed. Both means the record was reconciled. */
  readonly sources: FactSource[];
  readonly version: VersionInfo;
  /** Set only where the two layers disagreed. Absent is the common case. */
  readonly reconciled?: Record<string, Sourced<string | boolean>>;
}

export interface MergedMarketplace extends MarketplaceEntity {
  readonly sources: FactSource[];
  readonly headSha?: string;
  readonly reconciled?: Record<string, Sourced<string>>;
}

/**
 * A warning as the inventory reports it. `collector` is present when the
 * warning came from a collector and absent when this service derived it — a
 * reconciliation or a shadowing finding belongs to no single section, and
 * inventing an attribution for it would be a lie a surface would then render.
 */
export type InventoryWarning = Warning & { collector?: string };

/** A name claimed at more than one scope. Both records are reported. */
export interface ShadowGroup {
  readonly kind: EntityId['kind'];
  readonly name: string;
  /** The record precedence selects. */
  readonly effective: EntityId;
  /** Everything precedence discards, highest first. Never dropped silently. */
  readonly shadowed: EntityId[];
}

export interface Inventory {
  readonly plugins: MergedPlugin[];
  readonly marketplaces: MergedMarketplace[];
  readonly mcpServers: McpServerEntity[];
  readonly skills: Entity[];
  readonly agents: Entity[];
  readonly commands: Entity[];
  readonly shadowing: ShadowGroup[];
  /** Collector sections that failed. Empty data elsewhere means empty. */
  readonly degraded: string[];
  /** Sections that succeeded but knowingly returned less than everything. */
  readonly partial: string[];
  readonly warnings: InventoryWarning[];
  readonly elapsedMs: number;
}

/** Collector outputs, each still carrying whether its section is trustworthy. */
export interface InventoryInputs {
  readonly cli?: CollectorOutcome<CliInventory>;
  readonly config?: CollectorOutcome<ConfigData>;
  readonly registry?: CollectorOutcome<RegistryData>;
  readonly mcp?: CollectorOutcome<McpServerEntity[]>;
  readonly skills?: CollectorOutcome<SkillsInventory>;
  /** Wall-clock for the collector run, for the T1.11 budget. */
  readonly elapsedMs?: number;
  /**
   * Warnings from collectors that were run but are **not** passed above — a
   * `transcripts` outcome, say. Deliberately *supplemental*: every outcome
   * handed to `buildInventory` has its own warnings harvested here, so a
   * caller that also threads `aggregate()`'s list through this field would
   * report each one twice. Pass `aggregate()` output only for sections this
   * service does not consume.
   */
  readonly extraWarnings?: readonly TaggedWarning[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const warn = (code: Warning['code'], message: string, subject?: string): Warning => ({
  code,
  message,
  ...(subject !== undefined ? { subject } : {}),
});

/**
 * Reads a section only when it is trustworthy. `data` is present on both
 * members of `CollectorOutcome` and null-or-empty on both, so branching on
 * `status` is the only way to tell "nothing configured" from "the parser
 * died" — and conflating them is how a tool says *you used nothing, prune
 * everything* after a collector broke.
 */
function payload<T>(outcome: CollectorOutcome<T> | undefined): T | undefined {
  if (outcome === undefined || outcome.status !== 'ok') return undefined;
  return outcome.data ?? undefined;
}

/**
 * Composite-key separator.
 *
 * NUL rather than a space or a colon, because a plugin name, a marketplace
 * name and a path can all contain those — and a separator that can appear
 * inside its own operands aliases two distinct keys onto one. NUL cannot
 * appear in any of them.
 *
 * Written as the `\u0000` escape, never as the raw byte: a literal control
 * character makes the whole file binary to `grep`, invisible in diffs, and
 * unreliable to edit. It got in as a raw byte once, which is how this
 * comment came to exist.
 */
const KEY_SEP = '\u0000';

/** `(name, scope)`. Trap 12: one plugin can hold two scopes, two versions. */
const keyOf = (name: string, scope: Scope): string => `${name}${KEY_SEP}${scope}`;

/**
 * Precedence for shadowing. Highest first.
 *
 * **Derived from `SETTINGS_PRECEDENCE`, not copied.** A shadowed skill and a
 * shadowed setting must be resolved by one rule; two hand-written constants
 * with a comment claiming they agree is exactly how they stop agreeing. That
 * list is lowest-first, so it is reversed here rather than restated.
 */
export const SCOPE_RANK: readonly Scope[] = [...SETTINGS_PRECEDENCE].reverse();
const rank = (scope: Scope): number => {
  const at = SCOPE_RANK.indexOf(scope);
  return at === -1 ? SCOPE_RANK.length : at;
};

// ---------------------------------------------------------------------------
// T1.8 — reconciliation
// ---------------------------------------------------------------------------

/**
 * Merges one field from two layers. This is the whole of T1.8 in four
 * branches, and the third one is the point of the exercise.
 *
 * - Only one layer has it        → that layer's value, tagged.
 * - Both agree                   → the value, tagged `cli` (arbitrary; equal).
 * - **Both disagree**            → CLI's value **plus** the file's, kept in
 *                                  `conflictsWith`, plus a warning. Nothing is
 *                                  discarded and nothing is silently preferred.
 * - Neither has it               → undefined.
 */
export function reconcile<T>(
  field: string,
  subject: string,
  cli: T | undefined,
  file: T | undefined,
  warnings: Warning[],
): Sourced<T> | undefined {
  if (cli === undefined && file === undefined) return undefined;
  if (file === undefined) return { value: cli as T, source: 'cli' };
  if (cli === undefined) return { value: file, source: 'file' };
  if (cli === file) return { value: cli, source: 'cli' };

  warnings.push(
    warn(
      'reconciliation',
      `${subject}: \`${field}\` is "${String(cli)}" per the CLI and "${String(file)}" ` +
        'per the registry file. Both are recorded; neither was chosen.',
      subject,
    ),
  );
  return { value: cli, source: 'cli', conflictsWith: { value: file, source: 'file' } };
}

// ---------------------------------------------------------------------------
// T1.9 — version resolution
// ---------------------------------------------------------------------------

/**
 * Decides `versionSource`. **Four values, not five.** The design-stage "all
 * four rules" wording is stale: rule 3 — "git commit SHA used as the version
 * string" — does not exist. `gitCommitSha` is recorded *alongside* a semver
 * version, so it is carried as `installedSha`, a separate field, and never as
 * a version source. The genuine fifth mechanism is the marketplace entry's
 * `source.sha`, which is the majority pin in the largest marketplace (142 of
 * 276 entries) and gets its own enum member.
 *
 * `marketplace-entry` is **unverifiable** on the reference corpus: it was
 * never observed *deciding*, because every entry declaring a version also had
 * a `plugin.json` that pre-empted it. It is returned when it is the only
 * declaration present, and that branch is uncertified — see FORMATS.md §5.
 */
export function resolveVersion(input: {
  readonly pluginJsonVersion?: string;
  readonly marketplaceEntryVersion?: string;
  readonly sourceSha?: string;
  readonly gitCommitSha?: string;
}): VersionInfo {
  const { pluginJsonVersion, marketplaceEntryVersion, sourceSha, gitCommitSha } = input;

  let version = 'unknown';
  let versionSource: VersionSource = 'unknown';

  if (pluginJsonVersion !== undefined && pluginJsonVersion !== '' && pluginJsonVersion !== 'unknown') {
    version = pluginJsonVersion;
    versionSource = 'plugin-json';
  } else if (marketplaceEntryVersion !== undefined && marketplaceEntryVersion !== '') {
    version = marketplaceEntryVersion;
    versionSource = 'marketplace-entry';
  } else if (sourceSha !== undefined && sourceSha !== '') {
    // Pinned to a commit with no version string anywhere. Re-pinning is an
    // upstream marketplace edit, not a version bump — different update
    // semantics, which is exactly why the rule that fired is recorded.
    version = sourceSha;
    versionSource = 'marketplace-source-sha';
  } else if (pluginJsonVersion === 'unknown') {
    // The literal string "unknown" is a real, observed value — a relative path
    // inside a non-git marketplace clone yields it, and the cache directory is
    // literally `…/unknown/`. Recorded as `unknown`, not as absent.
    version = 'unknown';
  }

  const info: VersionInfo = { version, versionSource };

  return {
    ...info,
    ...(sourceSha !== undefined && sourceSha !== '' ? { sourceSha } : {}),
    ...(gitCommitSha !== undefined && gitCommitSha !== '' ? { installedSha: gitCommitSha } : {}),
    // T2.5's rule: flag ONLY when both are declared AND differ. Flagging
    // equality would trip on every well-maintained plugin and train the user
    // to ignore the diagnostic.
    ...(pluginJsonVersion !== undefined &&
    marketplaceEntryVersion !== undefined &&
    pluginJsonVersion !== marketplaceEntryVersion
      ? { doubleDeclared: { effective: pluginJsonVersion, masked: marketplaceEntryVersion } }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// T1.6 — normalisation and merge
// ---------------------------------------------------------------------------

/**
 * Indexes the file layer by `(key, scope)`. Two elements of the same array
 * with the same scope would be an upstream anomaly; the later wins and says
 * so, rather than one of them vanishing.
 */
function indexInstalled(
  records: readonly InstalledPluginRecord[],
  warnings: Warning[],
): Map<string, InstalledPluginRecord> {
  const byKey = new Map<string, InstalledPluginRecord>();
  for (const record of records) {
    const composite = keyOf(record.key, record.scope);
    if (byKey.has(composite)) {
      warnings.push(
        warn(
          'partial',
          `installed_plugins.json holds two "${record.scope}"-scope records for this plugin; ` +
            'the later one is used',
          record.key,
        ),
      );
    }
    byKey.set(composite, record);
  }
  return byKey;
}

/**
 * Merges CLI plugin rows with registry-file records — T1.6 + T1.8 + T1.9.
 *
 * Plugins present in only one layer are kept and marked with the single source
 * that saw them. A plugin the CLI reports but the file does not is not an
 * error: `--plugin-dir` sideloads surface with scope `session` and never touch
 * `installed_plugins.json` at all.
 */
export function mergePlugins(
  cliPlugins: readonly PluginEntity[],
  fileRecords: readonly InstalledPluginRecord[],
  marketplaceEntryVersions: ReadonlyMap<string, string> = new Map(),
): { plugins: MergedPlugin[]; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const files = indexInstalled(fileRecords, warnings);
  const seen = new Set<string>();
  const plugins: MergedPlugin[] = [];

  for (const row of cliPlugins) {
    const composite = keyOf(row.id.name, row.id.scope);
    seen.add(composite);
    const file = files.get(composite);

    const subject = row.id.name;
    const reconciled: Record<string, Sourced<string | boolean>> = {};

    const version = reconcile('version', subject, row.version.version, file?.version, warnings);
    const installPath = reconcile('installPath', subject, row.installPath, file?.installPath, warnings);
    const installedAt = reconcile('installedAt', subject, row.installedAt, file?.installedAt, warnings);
    const lastUpdated = reconcile('lastUpdated', subject, row.lastUpdated, file?.lastUpdated, warnings);

    for (const [field, value] of Object.entries({ version, installPath, installedAt, lastUpdated })) {
      if (value?.conflictsWith !== undefined) reconciled[field] = value;
    }

    plugins.push({
      ...row,
      sources: file === undefined ? ['cli'] : ['cli', 'file'],
      version: resolveVersion({
        ...(version !== undefined ? { pluginJsonVersion: version.value } : {}),
        ...(marketplaceEntryVersions.has(row.id.name)
          ? { marketplaceEntryVersion: marketplaceEntryVersions.get(row.id.name) as string }
          : {}),
        ...(row.version.sourceSha !== undefined ? { sourceSha: row.version.sourceSha } : {}),
        ...(file?.gitCommitSha !== undefined ? { gitCommitSha: file.gitCommitSha } : {}),
      }),
      ...(installPath !== undefined ? { installPath: installPath.value } : {}),
      ...(installedAt !== undefined ? { installedAt: installedAt.value } : {}),
      ...(lastUpdated !== undefined ? { lastUpdated: lastUpdated.value } : {}),
      ...(Object.keys(reconciled).length > 0 ? { reconciled } : {}),
    });
  }

  // File-only records. A plugin in installed_plugins.json that `plugin list`
  // does not report is a real finding — a half-removed install — so it is
  // surfaced rather than dropped for failing to appear in the primary layer.
  for (const [composite, record] of files) {
    if (seen.has(composite)) continue;

    // `record.key` is already `"<plugin>@<marketplace>"` and is used whole as
    // the entity name, matching the `id` the CLI reports — it never contains
    // KEY_SEP, so nothing needs splitting off it. Only the marketplace is
    // extracted, and on the LAST `@`, because plugin names may contain one.
    const name = record.key;
    const atSign = record.key.lastIndexOf('@');
    const marketplace = atSign > 0 ? record.key.slice(atSign + 1) : '';

    warnings.push(
      warn(
        'reconciliation',
        'present in installed_plugins.json but absent from `claude plugin list --json`; ' +
          'the install may be half-removed',
        record.key,
      ),
    );

    plugins.push({
      id: { name, scope: record.scope, kind: 'plugin' },
      origin: 'marketplace',
      state: 'error',
      source: 'file',
      sources: ['file'],
      marketplace,
      enabled: false,
      version: resolveVersion({
        ...(record.version !== undefined ? { pluginJsonVersion: record.version } : {}),
        ...(record.gitCommitSha !== undefined ? { gitCommitSha: record.gitCommitSha } : {}),
      }),
      ...(record.installPath !== undefined ? { installPath: record.installPath } : {}),
      ...(record.installedAt !== undefined ? { installedAt: record.installedAt } : {}),
      ...(record.lastUpdated !== undefined ? { lastUpdated: record.lastUpdated } : {}),
      contributes: { skills: 0, agents: 0, hooks: 0, mcpServers: 0, lspServers: 0 },
    });
  }

  return { plugins, warnings };
}

/** Merges CLI marketplace rows with `known_marketplaces.json`. */
export function mergeMarketplaces(
  cliMarketplaces: readonly MarketplaceEntity[],
  fileRecords: RegistryData['marketplaces'],
): { marketplaces: MergedMarketplace[]; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const files = new Map(fileRecords.map((entry) => [entry.name, entry]));
  const seen = new Set<string>();
  const marketplaces: MergedMarketplace[] = [];

  for (const row of cliMarketplaces) {
    const name = row.id.name;
    seen.add(name);
    const file = files.get(name);

    const installLocation = reconcile(
      'installLocation',
      name,
      row.installLocation,
      file?.installLocation,
      warnings,
    );

    // The probe beats the name-based guess: `distribution` from the CLI
    // collector is inferred from a hardcoded set of known-GCS names, whereas
    // the registry collector looked at the clone. A probe result of `unknown`
    // means "not reachable", so it never overrides a real inference.
    const distribution =
      file !== undefined && file.distribution !== 'unknown' ? file.distribution : row.distribution;

    const reconciled: Record<string, Sourced<string>> = {};
    if (installLocation?.conflictsWith !== undefined) reconciled['installLocation'] = installLocation;

    marketplaces.push({
      ...row,
      sources: file === undefined ? ['cli'] : ['cli', 'file'],
      distribution,
      ...(installLocation !== undefined ? { installLocation: installLocation.value } : {}),
      // `lastUpdated` exists ONLY in the file layer — it is the staleness
      // signal the respecified T2.6 report is built on, and `marketplace list
      // --json` does not carry it.
      ...(file?.lastUpdated !== undefined ? { lastUpdated: file.lastUpdated } : {}),
      ...(file?.headSha !== undefined ? { headSha: file.headSha } : {}),
      ...(Object.keys(reconciled).length > 0 ? { reconciled } : {}),
    });
  }

  for (const [name, file] of files) {
    if (seen.has(name)) continue;
    warnings.push(
      warn(
        'reconciliation',
        'present in known_marketplaces.json but absent from `marketplace list --json`',
        name,
      ),
    );
    marketplaces.push({
      id: { name, scope: 'user', kind: 'marketplace' },
      origin: 'marketplace',
      state: 'error',
      source: 'file',
      sources: ['file'],
      distribution: file.distribution,
      ...(file.installLocation !== undefined ? { installLocation: file.installLocation } : {}),
      ...(file.lastUpdated !== undefined ? { lastUpdated: file.lastUpdated } : {}),
      ...(file.headSha !== undefined ? { headSha: file.headSha } : {}),
    });
  }

  return { marketplaces, warnings };
}

// ---------------------------------------------------------------------------
// MCP — two disjoint sources, unioned
// ---------------------------------------------------------------------------

/**
 * Unions the two places MCP servers come from. **A union, not a preference.**
 *
 * This was `payload(inputs.mcp) ?? cli?.mcpServers ?? []` — a `??` where a
 * merge belonged, which silently discarded every plugin-bundled server the
 * moment the `mcp` collector succeeded. Measured on the reference machine: 7
 * servers dropped, leaving 3 of 10. The two sources are near-disjoint by
 * construction and are keyed differently, so neither can stand in for the
 * other:
 *
 * - `cli` — plugin-bundled servers from `plugin list --json`'s per-plugin
 *   `mcpServers` object, keyed `plugin:<plugin>:<server>`.
 * - `mcp` — user scope from `~/.claude.json` and project scope from
 *   `.mcp.json`, keyed by the bare server name.
 *
 * Where a name IS in both, the config side wins on `command`/`args`/`env`,
 * matching the same decision the `cli` collector already makes internally:
 * `mcp get` refuses to describe a plugin stdio server at all, so the config
 * record is the richer one.
 */
export function mergeMcpSources(
  fromCli: readonly McpServerEntity[],
  fromMcp: readonly McpServerEntity[],
): { servers: McpServerEntity[]; warnings: Warning[] } {
  const merged = new Map<string, McpServerEntity>();
  const warnings: Warning[] = [];

  for (const server of fromCli) merged.set(keyOf(server.id.name, server.id.scope), server);

  for (const server of fromMcp) {
    const key = keyOf(server.id.name, server.id.scope);
    const known = merged.get(key);
    if (known === undefined) {
      merged.set(key, server);
      continue;
    }

    if (known.connection !== server.connection && known.connection !== 'unknown') {
      warnings.push(
        warn(
          'reconciliation',
          `connection state is "${known.connection}" per the CLI and "${server.connection}" ` +
            'per the config files; both are recorded',
          server.id.name,
        ),
      );
    }

    merged.set(key, {
      ...known,
      ...server,
      ...(known.command !== undefined ? { command: known.command } : {}),
      ...(known.args !== undefined ? { args: known.args } : {}),
      ...(known.env !== undefined ? { env: known.env } : {}),
      ...(known.owningPlugin !== undefined ? { owningPlugin: known.owningPlugin } : {}),
    });
  }

  return { servers: [...merged.values()], warnings };
}

// ---------------------------------------------------------------------------
// T1.7 — shadowing
// ---------------------------------------------------------------------------

/**
 * Finds names claimed at more than one scope and reports **both** records.
 *
 * The naive implementation resolves precedence and returns the winner, which
 * is what Claude Code itself does — and is precisely why the user cannot see
 * the problem. A personal skill silently masked by a project one of the same
 * name is invisible from inside the session; the value here is showing the
 * loser, so `state` is set to `shadowed` on it rather than the record being
 * dropped.
 *
 * Comparison is case-insensitive: two files differing only in case shadow each
 * other on Windows and macOS but not on Linux, and reporting the pair on all
 * three is the useful behaviour — a stack that behaves differently per
 * platform is the finding.
 */
export function detectShadowing(entities: readonly Entity[]): {
  groups: ShadowGroup[];
  annotated: Entity[];
  warnings: Warning[];
} {
  const buckets = new Map<string, Entity[]>();
  for (const entity of entities) {
    const bucket = `${entity.id.kind}${KEY_SEP}${entity.id.name.toLowerCase()}`;
    const existing = buckets.get(bucket);
    if (existing === undefined) buckets.set(bucket, [entity]);
    else existing.push(entity);
  }

  const groups: ShadowGroup[] = [];
  const warnings: Warning[] = [];
  const shadowedIds = new Map<Entity, EntityId>();
  const shadowerIds = new Map<Entity, EntityId[]>();

  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;

    // Distinct scopes only. The same name at the same scope is one entity seen
    // twice, not a shadow — dedupe belongs to the merge, not here.
    const scopes = new Set(bucket.map((entity) => entity.id.scope));
    if (scopes.size < 2) continue;

    const ordered = [...bucket].sort((a, b) => rank(a.id.scope) - rank(b.id.scope));
    const [effective, ...shadowed] = ordered as [Entity, ...Entity[]];

    groups.push({
      kind: effective.id.kind,
      name: effective.id.name,
      effective: effective.id,
      shadowed: shadowed.map((entity) => entity.id),
    });

    shadowerIds.set(effective, shadowed.map((entity) => entity.id));
    for (const loser of shadowed) shadowedIds.set(loser, effective.id);

    warnings.push(
      warn(
        'shadowed',
        `${effective.id.kind} "${effective.id.name}" is defined at ${ordered.length} scopes ` +
          `(${ordered.map((e) => e.id.scope).join(', ')}); ` +
          `the ${effective.id.scope}-scope one wins and the rest never load`,
        effective.id.name,
      ),
    );
  }

  const annotated = entities.map((entity) => {
    const shadowedBy = shadowedIds.get(entity);
    const shadows = shadowerIds.get(entity);
    if (shadowedBy === undefined && shadows === undefined) return entity;
    return {
      ...entity,
      ...(shadows !== undefined ? { shadows } : {}),
      ...(shadowedBy !== undefined ? { shadowedBy, state: 'shadowed' as const } : {}),
    };
  });

  return { groups, annotated, warnings };
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * Builds the unified inventory from collector outcomes. Pure: no IO, no
 * clock beyond what the caller passed in, so it is testable without a
 * filesystem and callers that already ran the collectors need not run them
 * twice.
 */
export function buildInventory(inputs: InventoryInputs): Inventory {
  const warnings: InventoryWarning[] = [...(inputs.extraWarnings ?? [])];
  const degraded: string[] = [];
  const partial: string[] = [];

  const sections: ReadonlyArray<readonly [string, CollectorOutcome<unknown> | undefined]> = [
    ['cli', inputs.cli],
    ['config', inputs.config],
    ['registry', inputs.registry],
    ['mcp', inputs.mcp],
    ['skills', inputs.skills],
  ];

  for (const [name, outcome] of sections) {
    if (outcome === undefined) continue;

    // Harvested, not merely classified. `degraded: ['cli']` with the reason
    // dropped defeats isolate.ts's own guarantee that a degraded section
    // explains its own emptiness — and the loss would be invisible, because
    // the section names still look right.
    for (const warning of outcome.warnings) warnings.push({ ...warning, collector: name });

    if (outcome.status === 'failed') degraded.push(name);
    else if (outcome.warnings.some((w) => w.code === 'partial')) partial.push(name);
  }

  const cli = payload(inputs.cli);
  const registry = payload(inputs.registry);
  const config = payload(inputs.config);
  const skills = payload(inputs.skills);

  // Marketplace-entry versions, for T1.9's second rule and T2.5's double
  // declaration. `available[]` is the only layer that carries them — and it
  // excludes every installed plugin, so the map is usually empty for the
  // plugins being merged. That is a corpus fact, not a bug: FORMATS.md §5
  // records rule 2 as never observed deciding.
  const marketplaceEntryVersions = new Map<string, string>();
  for (const entry of cli?.available ?? []) {
    if (entry.version.version !== 'unknown') {
      marketplaceEntryVersions.set(entry.id.name, entry.version.version);
    }
  }

  const merged = mergePlugins(
    cli?.plugins ?? [],
    registry?.installed ?? [],
    marketplaceEntryVersions,
  );
  warnings.push(...merged.warnings);

  const markets = mergeMarketplaces(cli?.marketplaces ?? [], registry?.marketplaces ?? []);
  warnings.push(...markets.warnings);

  // The `enabled` bit lives in `settings.enabledPlugins` and nowhere else. The
  // CLI reports it too, so this is a third reconciliation input rather than a
  // fallback — a plugin the CLI calls enabled while settings disable it is a
  // finding, not a tie to break.
  //
  // The key form is `"<plugin>@<marketplace>"`, identical to `plugin.id.name`,
  // to the keys of `installed_plugins.json → plugins`, and to `plugin list
  // --json`'s `id` — verified against `fixtures/files/settings-shape.json` and
  // the T1.29 scale tree, not assumed. If it were not identical, `declared`
  // would be `undefined` on every plugin and this whole branch would be dead
  // code that no hand-built test could distinguish from working.
  const enabledPlugins = config?.enabledPlugins ?? {};
  const plugins = merged.plugins.map((plugin) => {
    const declared = enabledPlugins[plugin.id.name]?.value;
    if (declared === undefined || declared === plugin.enabled) return plugin;
    warnings.push(
      warn(
        'reconciliation',
        `\`enabled\` is ${plugin.enabled} per the CLI and ${declared} per settings.enabledPlugins; ` +
          'both are recorded',
        plugin.id.name,
      ),
    );
    return {
      ...plugin,
      reconciled: {
        ...plugin.reconciled,
        enabled: {
          value: plugin.enabled,
          source: 'cli' as const,
          conflictsWith: { value: declared, source: 'file' as const },
        },
      },
    };
  });

  // Shadowing runs over the file-backed kinds, where two scopes can define one
  // name.
  //
  // Two kinds are excluded, both deliberately:
  //
  // - **Plugins.** Keyed `<name>@<marketplace>`, so a same-name pair across two
  //   marketplaces is two distinct plugins, not a shadow.
  // - **MCP servers.** A project `.mcp.json` server and a user-scope one in
  //   `~/.claude.json` sharing a name IS a real shadowing case, and the
  //   entities are already in hand. It is left for T1.13/T1.27 rather than
  //   folded in here, because an MCP server has a second axis this function
  //   knows nothing about: `pending-approval` contributes zero always-on cost,
  //   so "declared" and "active" are not the same question, and reporting a
  //   pending server as shadowing an active one would be wrong in the
  //   direction that matters. Tracked, not overlooked.
  const shadowable: Entity[] = [
    ...(skills?.skills ?? []),
    ...(skills?.agents ?? []),
    ...(skills?.commands ?? []),
  ];
  const shadowing = detectShadowing(shadowable);
  warnings.push(...shadowing.warnings);

  const byKind = (kind: EntityId['kind']): Entity[] =>
    shadowing.annotated.filter((entity) => entity.id.kind === kind);

  const mcp = mergeMcpSources(cli?.mcpServers ?? [], payload(inputs.mcp) ?? []);
  warnings.push(...mcp.warnings);
  const mergedMcp = mcp.servers;

  return {
    plugins,
    marketplaces: markets.marketplaces,
    mcpServers: mergedMcp,
    skills: byKind('skill'),
    agents: byKind('agent'),
    commands: byKind('command'),
    shadowing: shadowing.groups,
    degraded,
    partial,
    warnings,
    elapsedMs: inputs.elapsedMs ?? 0,
  };
}
