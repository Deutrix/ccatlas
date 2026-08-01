/**
 * The plugin-registry file layer — the `file` half of T1.8.
 *
 * ## Why this collector exists at all
 *
 * The architecture is CLI-first, and four collectors already honour that. But
 * `installed_plugins.json` carries `gitCommitSha` and **`claude plugin list
 * --json` does not expose it** (FORMATS.md §2, confirmed by T0.1 against
 * 2.1.220). It is the only source for the field that T2.4's stale-pin
 * diagnostic — the product's differentiator — is computed from.
 *
 * That makes this the one place where the file layer beats the CLI rather than
 * merely backing it up, so T1.8 **merges** the two rather than preferring one.
 * A reconciliation service with only one input cannot reconcile: without this
 * collector, `Sourced<T>.conflictsWith` would never be populated and "CLI and
 * file disagree" would be undetectable by construction.
 *
 * ## Why a sixth collector rather than a slice of `config`
 *
 * `config` resolves *settings* across four scopes and is dominated by
 * precedence logic. These are flat registries with no precedence at all —
 * folding them in would put two unrelated resolution models in one 700-line
 * module. `02-architecture.md` §2's collector list is amended to six.
 *
 * ## Read-only, like every collector
 *
 * Nothing here writes, and nothing here shells out. `ctx.offline` needs no
 * handling: only the local filesystem is touched.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
  CollectContext,
  Collector,
  CollectorResult,
  PluginSource,
  Scope,
  Warning,
} from '../types.ts';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * One element of `installed_plugins.json → plugins["<p>@<m>"]`, which is an
 * **array**, one entry per scope. Trap 12: reading `[0]` silently drops every
 * scope but the first, and the drop is invisible because the result still
 * looks like a plugin.
 */
export interface InstalledPluginRecord {
  /** `"<plugin>@<marketplace>"`, verbatim. Split for display only. */
  readonly key: string;
  readonly scope: Scope;
  readonly installPath?: string;
  /** May be the literal string `"unknown"` — a real value, not an absence. */
  readonly version?: string;
  readonly installedAt?: string;
  readonly lastUpdated?: string;
  /** **The CLI never exposes this.** T2.4's drift evidence. */
  readonly gitCommitSha?: string;
}

/**
 * `known_marketplaces.json` value. The key set is complete at four fields —
 * there is **no auto-update flag** anywhere (§3.2.1, trap 5); the F2 posture
 * report is a staleness report over `lastUpdated`.
 */
export interface KnownMarketplaceRecord {
  readonly name: string;
  readonly source?: PluginSource;
  readonly installLocation?: string;
  readonly lastUpdated?: string;
  /**
   * Probed from the clone on disk, never guessed from the name. `unknown`
   * means the clone was not reachable (redacted fixture paths, or a
   * marketplace registered but never fetched) — it is not a fourth kind of
   * distribution, it is an admission.
   */
  readonly distribution: 'git' | 'gcs' | 'local' | 'unknown';
  /** `.gcs-sha`'s contents, or `.git/HEAD`'s resolved commit, when readable. */
  readonly headSha?: string;
}

/**
 * One plugin entry from a marketplace clone's `.claude-plugin/marketplace.json`.
 *
 * **This is the upgrade target**, and T0.1's finding is why: `plugin list
 * --json --available` excludes every installed plugin, so it yields no upgrade
 * targets at all. The clone's own manifest is what the next `plugin install`
 * would actually fetch.
 */
export interface MarketplaceEntry {
  readonly marketplace: string;
  readonly name: string;
  /** Entry-declared version. Absent on 221 of 276 official entries. */
  readonly version?: string;
  /** `source.sha` — the majority pin in the largest marketplace. */
  readonly sourceSha?: string;
  readonly source?: PluginSource;
}

export interface RegistryData {
  /** `installed_plugins.json → version`. 2 as observed; a bump is a warning. */
  readonly registryVersion?: number;
  readonly installed: InstalledPluginRecord[];
  readonly marketplaces: KnownMarketplaceRecord[];
  /** Entries from every readable marketplace clone. The upgrade targets. */
  readonly entries: MarketplaceEntry[];
}

export interface RegistryCollectorOptions {
  /** Overrides the discovery root. Never set in production. */
  readonly roots?: { readonly home?: string };
  /**
   * Probing a clone costs three stats per marketplace. Off in fixture mode,
   * where `installLocation` is a redacted `<HOME>\…` string that resolves to
   * nothing and every probe would be a guaranteed miss.
   */
  readonly probeClones?: boolean;
}

/** The registry-file schema version this collector was written against. */
export const SUPPORTED_REGISTRY_VERSION = 2;

/** Fixture layout: `<fixtureRoot>/files/<name>.json`, as captured by T0.5. */
export const REGISTRY_FIXTURE = { dir: 'files' } as const;

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const SCOPES = new Set<string>(['user', 'project', 'local', 'managed', 'session']);

const warn = (code: Warning['code'], message: string, subject?: string): Warning => ({
  code,
  message,
  ...(subject !== undefined ? { subject } : {}),
});

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// ---------------------------------------------------------------------------
// Parsers — pure, exported so the shapes can be tested without a filesystem
// ---------------------------------------------------------------------------

/**
 * Normalises `source`, which is polymorphic upstream: 55 of 276 marketplace
 * entries are a bare string. Kept deliberately separate from the `cli`
 * collector's `normalisePluginSource` — that one synthesises a
 * `relative-path` discriminator for plugin sources inside a marketplace
 * manifest, whereas `known_marketplaces.json` has only ever been observed
 * holding the object form. Sharing one function would import a synthetic
 * discriminator into a file layer that has no use for it.
 */
function parseMarketplaceSource(raw: unknown): PluginSource | undefined {
  if (typeof raw === 'string') return { source: raw };
  if (!isRecord(raw)) return undefined;

  const source = str(raw['source']);
  if (source === undefined) return undefined;

  const url = str(raw['url']);
  const repo = str(raw['repo']);
  const p = str(raw['path']);
  const ref = str(raw['ref']);
  const sha = str(raw['sha']);

  return {
    source,
    ...(url !== undefined ? { url } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(p !== undefined ? { path: p } : {}),
    ...(ref !== undefined ? { ref } : {}),
    ...(sha !== undefined ? { sha } : {}),
  };
}

/**
 * Parses `installed_plugins.json`. Every array element is kept: a plugin
 * installed at both user and project scope is two records, and collapsing them
 * loses the fact that the two can hold different versions.
 */
export function parseInstalledPlugins(raw: unknown): {
  registryVersion?: number;
  installed: InstalledPluginRecord[];
  warnings: Warning[];
} {
  const warnings: Warning[] = [];

  if (!isRecord(raw)) {
    return {
      installed: [],
      warnings: [warn('unsupported-version', 'installed_plugins.json is not an object')],
    };
  }

  const rawVersion = raw['version'];
  const registryVersion = typeof rawVersion === 'number' ? rawVersion : undefined;
  if (registryVersion !== undefined && registryVersion !== SUPPORTED_REGISTRY_VERSION) {
    // Not fatal — the shape may well be unchanged. But a silent parse of an
    // unknown schema version is how a field quietly starts meaning something
    // else, so the run says so and continues.
    warnings.push(
      warn(
        'unsupported-version',
        `installed_plugins.json is version ${registryVersion}; parsed against ` +
          `version ${SUPPORTED_REGISTRY_VERSION}. Fields may have moved.`,
      ),
    );
  }

  const plugins = raw['plugins'];
  if (!isRecord(plugins)) {
    warnings.push(warn('unsupported-version', 'installed_plugins.json has no `plugins` object'));
    return { ...(registryVersion !== undefined ? { registryVersion } : {}), installed: [], warnings };
  }

  const installed: InstalledPluginRecord[] = [];

  for (const [key, value] of Object.entries(plugins)) {
    if (!Array.isArray(value)) {
      // Trap 12's inverse: if upstream ever flattens the array to a single
      // object, silently accepting it would hide the schema change.
      warnings.push(
        warn('unsupported-version', 'plugin entry is not an array of scope records', key),
      );
      continue;
    }

    for (const element of value) {
      if (!isRecord(element)) {
        warnings.push(warn('unsupported-version', 'skipped an unrecognised scope record', key));
        continue;
      }

      const rawScope = str(element['scope']);
      if (rawScope !== undefined && !SCOPES.has(rawScope)) {
        warnings.push(warn('unsupported-version', `unknown scope "${rawScope}"`, key));
      }

      const installPath = str(element['installPath']);
      const version = str(element['version']);
      const installedAt = str(element['installedAt']);
      const lastUpdated = str(element['lastUpdated']);
      const gitCommitSha = str(element['gitCommitSha']);

      installed.push({
        key,
        // Defaulting to `user` matches the `cli` collector's `toScope`, so a
        // novel scope string reconciles as equal rather than as a spurious
        // conflict. The warning above is what carries the news.
        scope: rawScope !== undefined && SCOPES.has(rawScope) ? (rawScope as Scope) : 'user',
        ...(installPath !== undefined ? { installPath } : {}),
        ...(version !== undefined ? { version } : {}),
        ...(installedAt !== undefined ? { installedAt } : {}),
        ...(lastUpdated !== undefined ? { lastUpdated } : {}),
        ...(gitCommitSha !== undefined ? { gitCommitSha } : {}),
      });
    }
  }

  return { ...(registryVersion !== undefined ? { registryVersion } : {}), installed, warnings };
}

/** Parses `known_marketplaces.json`. Distribution is filled in by the probe. */
export function parseKnownMarketplaces(raw: unknown): {
  marketplaces: KnownMarketplaceRecord[];
  warnings: Warning[];
} {
  if (!isRecord(raw)) {
    return {
      marketplaces: [],
      warnings: [warn('unsupported-version', 'known_marketplaces.json is not an object')],
    };
  }

  const marketplaces: KnownMarketplaceRecord[] = [];
  const warnings: Warning[] = [];

  for (const [name, value] of Object.entries(raw)) {
    if (!isRecord(value)) {
      warnings.push(warn('unsupported-version', 'skipped an unrecognised marketplace entry', name));
      continue;
    }

    const source = parseMarketplaceSource(value['source']);
    const installLocation = str(value['installLocation']);
    const lastUpdated = str(value['lastUpdated']);

    marketplaces.push({
      name,
      distribution: 'unknown',
      ...(source !== undefined ? { source } : {}),
      ...(installLocation !== undefined ? { installLocation } : {}),
      ...(lastUpdated !== undefined ? { lastUpdated } : {}),
    });
  }

  return { marketplaces, warnings };
}

/**
 * Parses a marketplace clone's manifest into entries.
 *
 * `plugins` is an array of objects whose `source` is polymorphic — a bare
 * string in 55 of 276 official entries, an object in the rest. Only the `sha`
 * is lifted out here because that is what T2.4 compares against; the rest is
 * kept whole for T2.2's resolver.
 *
 * A `metadata.version` at the top level is deliberately **not** read. It is a
 * third version-bearing field that tracked the *stale* value in the one
 * observed divergence, and T2.5's decision was to compare the two that
 * actually decide what installs.
 */
export function parseMarketplaceManifest(
  marketplace: string,
  raw: unknown,
): { entries: MarketplaceEntry[]; warnings: Warning[] } {
  if (!isRecord(raw) || !Array.isArray(raw['plugins'])) {
    return {
      entries: [],
      warnings: [
        warn('unsupported-version', 'marketplace.json has no `plugins` array', marketplace),
      ],
    };
  }

  const entries: MarketplaceEntry[] = [];
  const warnings: Warning[] = [];

  for (const row of raw['plugins'] as unknown[]) {
    if (!isRecord(row)) continue;
    const name = str(row['name']);
    if (name === undefined) {
      warnings.push(warn('unsupported-version', 'marketplace entry has no name', marketplace));
      continue;
    }

    const source = parseMarketplaceSource(row['source']);
    const version = str(row['version']);
    const sourceSha = isRecord(row['source']) ? str((row['source'] as Record<string, unknown>)['sha']) : undefined;

    entries.push({
      marketplace,
      name,
      ...(version !== undefined ? { version } : {}),
      ...(sourceSha !== undefined ? { sourceSha } : {}),
      ...(source !== undefined ? { source } : {}),
    });
  }

  return { entries, warnings };
}

// ---------------------------------------------------------------------------
// Clone probe
// ---------------------------------------------------------------------------

const exists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

const readIfPresent = async (file: string): Promise<string | undefined> => {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
};

/**
 * Decides how a marketplace clone is distributed by looking at it, because
 * nothing in the JSON says. `claude-plugins-official` — which holds 276 of 281
 * available plugins — ships as a GCS tarball with a `.gcs-sha` sidecar and no
 * `.git` at all, so a resolver that assumes every clone is a git checkout
 * fails on the majority case. That is T2.2's `.gcs-sha` branch, and this is
 * where the branch is decided.
 */
export async function probeDistribution(
  installLocation: string | undefined,
): Promise<{ distribution: KnownMarketplaceRecord['distribution']; headSha?: string }> {
  if (installLocation === undefined) return { distribution: 'unknown' };
  if (!(await exists(installLocation))) return { distribution: 'unknown' };

  const gcs = (await readIfPresent(path.join(installLocation, '.gcs-sha')))?.trim();
  if (gcs !== undefined && gcs !== '') return { distribution: 'gcs', headSha: gcs };

  if (await exists(path.join(installLocation, '.git'))) {
    const head = (await readIfPresent(path.join(installLocation, '.git', 'HEAD')))?.trim();
    // A detached HEAD holds the SHA directly; otherwise it names a ref that
    // must be dereferenced. Shelling out to `git` is deliberately avoided —
    // this is a collector, and a hung git call would take the section with it.
    if (head !== undefined && /^[0-9a-f]{40}$/iu.test(head)) {
      return { distribution: 'git', headSha: head };
    }
    const ref = /^ref:\s*(\S+)$/u.exec(head ?? '')?.[1];
    if (ref !== undefined) {
      const resolved = (await readIfPresent(path.join(installLocation, '.git', ...ref.split('/'))))?.trim();
      if (resolved !== undefined && /^[0-9a-f]{40}$/iu.test(resolved)) {
        return { distribution: 'git', headSha: resolved };
      }
    }
    return { distribution: 'git' };
  }

  // Reachable, but neither a git checkout nor a GCS unpack: a local directory
  // registered directly. Distinct from `unknown`, which means unreachable.
  return { distribution: 'local' };
}

// ---------------------------------------------------------------------------
// The collector
// ---------------------------------------------------------------------------

interface Located {
  readonly installedPluginsPath: string;
  readonly knownMarketplacesPath: string;
  readonly probe: boolean;
}

function locate(ctx: CollectContext, options: RegistryCollectorOptions): Located {
  if (ctx.fixtureRoot !== undefined) {
    const dir = path.join(ctx.fixtureRoot, REGISTRY_FIXTURE.dir);
    return {
      installedPluginsPath: path.join(dir, 'installed_plugins.json'),
      knownMarketplacesPath: path.join(dir, 'known_marketplaces.json'),
      // Fixture `installLocation` values are redacted to `<HOME>\…`; probing
      // them would stat paths that cannot exist and report `unknown` after
      // paying for the syscalls.
      probe: options.probeClones ?? false,
    };
  }

  const home = options.roots?.home ?? os.homedir();
  const plugins = path.join(home, '.claude', 'plugins');
  return {
    installedPluginsPath: path.join(plugins, 'installed_plugins.json'),
    knownMarketplacesPath: path.join(plugins, 'known_marketplaces.json'),
    probe: options.probeClones ?? true,
  };
}

/**
 * Reads one registry file. An absent file is `partial`, not a failure: a
 * machine with no plugins installed has no `installed_plugins.json`, and
 * reporting that as a broken section would be a confidently wrong diagnosis.
 */
async function readJson(
  file: string,
  label: string,
  warnings: Warning[],
): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error: unknown) {
    const code = (error as { code?: unknown }).code;
    warnings.push(
      code === 'ENOENT'
        ? warn('partial', `${label} is absent; nothing is installed, or the path moved`, label)
        : warn('partial', `${label} could not be read: ${describe(error)}`, label),
    );
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    // Corrupt registry: a real state on a machine mid-crash. Degrade the
    // section; the run continues with the CLI's view alone.
    warnings.push(warn('partial', `${label} is not valid JSON: ${describe(error)}`, label));
    return undefined;
  }
}

export function createRegistryCollector(
  options: RegistryCollectorOptions = {},
): Collector<RegistryData> {
  return {
    name: 'registry',
    async collect(ctx: CollectContext): Promise<CollectorResult<RegistryData>> {
      const started = performance.now();
      const warnings: Warning[] = [];

      try {
        const at = locate(ctx, options);

        const installedRaw = await readJson(at.installedPluginsPath, 'installed_plugins.json', warnings);
        const marketRaw = await readJson(at.knownMarketplacesPath, 'known_marketplaces.json', warnings);

        const installed =
          installedRaw === undefined
            ? { installed: [], warnings: [] as Warning[] }
            : parseInstalledPlugins(installedRaw);
        warnings.push(...installed.warnings);

        const markets =
          marketRaw === undefined
            ? { marketplaces: [] as KnownMarketplaceRecord[], warnings: [] as Warning[] }
            : parseKnownMarketplaces(marketRaw);
        warnings.push(...markets.warnings);

        let marketplaces = markets.marketplaces;
        if (at.probe) {
          marketplaces = await Promise.all(
            marketplaces.map(async (entry) => {
              const probed = await probeDistribution(entry.installLocation);
              return { ...entry, ...probed };
            }),
          );
        } else if (marketplaces.length > 0) {
          warnings.push(
            warn(
              'partial',
              'marketplace clones were not probed; `distribution` is unknown for every entry',
            ),
          );
        }

        // The manifests. Read only when the clones are reachable — in fixture
        // mode `installLocation` is a redacted `<HOME>\…` string and every
        // read would be a guaranteed miss.
        const entries: MarketplaceEntry[] = [];
        if (at.probe) {
          for (const market of marketplaces) {
            if (market.installLocation === undefined) continue;
            const manifest = await readIfPresent(
              path.join(market.installLocation, '.claude-plugin', 'marketplace.json'),
            );
            if (manifest === undefined) {
              warnings.push(
                warn('partial', 'marketplace clone has no readable manifest', market.name),
              );
              continue;
            }
            try {
              const parsed = parseMarketplaceManifest(market.name, JSON.parse(manifest) as unknown);
              entries.push(...parsed.entries);
              warnings.push(...parsed.warnings);
            } catch {
              warnings.push(
                warn('partial', 'marketplace manifest is not valid JSON', market.name),
              );
            }
          }
        }

        return {
          ok: true,
          data: {
            ...(installed.registryVersion !== undefined
              ? { registryVersion: installed.registryVersion }
              : {}),
            installed: installed.installed,
            marketplaces,
            entries,
          },
          warnings,
          elapsedMs: performance.now() - started,
        };
      } catch (error: unknown) {
        return {
          ok: false,
          data: null,
          warnings,
          error: { code: 'registry-collector-failed', message: describe(error) },
          elapsedMs: performance.now() - started,
        };
      }
    },
  };
}

export const registryCollector: Collector<RegistryData> = createRegistryCollector();

/**
 * Enumerates `plugins/cache/<marketplace>/<plugin>/<version>/` — T1.15's
 * orphan input. Exported separately from `collect` because it walks three
 * directory levels and most callers do not need it.
 *
 * `<version>` may be the literal string `unknown`, and `.in_use` is a
 * **directory**, so an `[ -f ]`-style check reports every live version as
 * orphaned. Its mtime is the liveness signal; the ~14-day TTL is unverified
 * and must not be asserted.
 */
export async function enumerateCacheVersions(cacheRoot: string): Promise<
  Array<{ dir: string; marketplace: string; plugin: string; version: string; inUseMtimeMs?: number }>
> {
  const out: Array<{
    dir: string;
    marketplace: string;
    plugin: string;
    version: string;
    inUseMtimeMs?: number;
  }> = [];

  const dirs = async (at: string): Promise<string[]> => {
    try {
      return (await readdir(at, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  };

  for (const marketplace of await dirs(cacheRoot)) {
    for (const plugin of await dirs(path.join(cacheRoot, marketplace))) {
      for (const version of await dirs(path.join(cacheRoot, marketplace, plugin))) {
        const dir = path.join(cacheRoot, marketplace, plugin, version);

        let inUseMtimeMs: number | undefined;
        try {
          inUseMtimeMs = (await stat(path.join(dir, '.in_use'))).mtimeMs;
        } catch {
          inUseMtimeMs = undefined;
        }

        // The absolute path is returned so callers can compare against
        // `installPath` directly rather than rebuilding a plugin id out of
        // path segments — the same refusal `project-path.ts` makes about
        // decoding `~/.claude/projects/` directory names.
        out.push({
          dir,
          marketplace,
          plugin,
          version,
          ...(inUseMtimeMs !== undefined ? { inUseMtimeMs } : {}),
        });
      }
    }
  }

  return out;
}
