/**
 * The `status` service — the composition point for T1.20/T1.21.
 *
 * This is the only place that knows how to turn a set of flags into an
 * inventory: which collectors to run, what `--offline` and `--cached` actually
 * do, and which files the answer derives from. `index.ts` stays a parser and a
 * printer; putting any of this there would put IO decisions in the surface
 * layer, which is the rule the architecture is built around.
 *
 * ## What `--offline` means here
 *
 * It is threaded into `CollectContext.offline`, which every collector honours.
 *
 * **As of Phase 1 it changes nothing, and that is worth stating plainly.** The
 * only command that dials the network is `claude mcp list`, which
 * live-health-checks every configured server (~40s for 14 on the reference
 * machine) — and it is off by default because that cost blows the T1.11 budget
 * on its own. So `status` makes zero network calls with or without the flag.
 *
 * The flag is not therefore decoration. TX.5 requires zero egress to be
 * *asserted*, and the assertion lives against the collector rather than here,
 * so it keeps holding when Phase 2 adds `git ls-remote` and the guarantee
 * starts having something to guarantee. What must not happen is the help text
 * implying the knob does work today that it does not.
 *
 * ## What `--cached` means here
 *
 * Read the recorded answer and do not collect. A miss is **reported, not
 * silently upgraded to a cold run**: a user who asked for the fast path and
 * got a 2s answer should be told why, and a script that asked for it and got a
 * miss needs to know the number it printed is fresh rather than the cached one
 * it expected.
 *
 * **A miss also populates the cache**, so `--cached` is not purely a read. That
 * is deliberate — it makes the flag self-healing, and the alternative is a
 * machine where `--cached` never works until someone happens to run `status`
 * without it. The cost is that the *next* `--cached` reports `origin: 'cache'`
 * and shows no sign the previous one was cold; the warning on the miss itself
 * is what carries that, which is why it is emitted rather than inferred.
 */

import os from 'node:os';
import path from 'node:path';

import { createCliCollector } from '../collectors/cli.ts';
import { collectConfig } from '../collectors/config.ts';
import { createMcpCollector } from '../collectors/mcp.ts';
import { createRegistryCollector } from '../collectors/registry.ts';
import { collectSkills } from '../collectors/skills.ts';
import { runCollector } from '../collectors/isolate.ts';
import { buildInventory } from './inventory.ts';
import { readCache, writeCache } from './cache.ts';
import type { CliInventory } from '../collectors/cli.ts';
import type { ConfigData } from '../collectors/config.ts';
import type { RegistryData } from '../collectors/registry.ts';
import type { SkillsInventory } from '../collectors/skills.ts';
import type { Inventory, InventoryWarning } from './inventory.ts';
import type { CacheRead } from './cache.ts';
import type { CollectContext, McpServerEntity } from '../types.ts';

/** The cache entry `status` reads and writes. */
export const STATUS_CACHE_KEY = 'inventory';

export interface StatusOptions {
  readonly offline?: boolean;
  readonly cached?: boolean;
  /** Overrides discovery roots. Set in tests; never in production. */
  readonly roots?: { readonly home?: string; readonly projectDir?: string };
  /** Fixture replay. Set in tests; never in production. */
  readonly fixtureRoot?: string;
  readonly stateDir?: string;
  readonly toolVersion?: string;
  /**
   * Opt in to `claude mcp list`. Off by default because it dials every
   * configured server and blows the T1.11 budget on its own; the collector
   * refuses it under `--offline` regardless.
   */
  readonly includeMcpList?: boolean;
}

export interface StatusResult {
  readonly inventory: Inventory;
  /** `cache` means nothing was collected — the answer is the recorded one. */
  readonly origin: 'collected' | 'cache';
  /** Set when the answer came from cache. */
  readonly cachedAt?: string;
  /** Set when `--cached` was asked for and could not be honoured. */
  readonly cacheMiss?: Exclude<CacheRead<unknown>, { hit: true }>['reason'];
  readonly warnings: InventoryWarning[];
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const claudeHome = (home: string): string => path.join(home, '.claude');

/**
 * The files a cold `status` derives from — every one that, if edited, must
 * make a cached answer stale.
 *
 * The settings layers are **not** listed here. They come back from the config
 * collector's own `scopes[].path`, which reports every candidate it consulted
 * including the absent ones — so the settings half of the list is discovered
 * rather than maintained, and cannot drift from what the collector actually
 * reads. What remains below is the fixed set, each annotated with its reader.
 */
function fixedInputs(home: string): string[] {
  const claude = claudeHome(home);
  return [
    path.join(home, '.claude.json'), //                          mcp collector
    path.join(claude, 'plugins', 'installed_plugins.json'), //    registry
    path.join(claude, 'plugins', 'known_marketplaces.json'), //   registry
    path.join(claude, 'skills'), //                               skills
    path.join(claude, 'agents'), //                               skills
    path.join(claude, 'commands'), //                             skills
  ];
}

/**
 * Assembles the full input list from the fixed set plus whatever the config
 * collector reports having consulted. Deduplicated and sorted, so two runs
 * over an unchanged machine produce byte-identical fingerprints.
 */
export function inventoryInputs(home: string, config: ConfigData | undefined): string[] {
  const discovered = (config?.scopes ?? []).map((scope) => scope.path);
  return [...new Set([...fixedInputs(home), ...discovered])].sort();
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

export interface Collected {
  readonly inventory: Inventory;
  readonly config: ConfigData | undefined;
  readonly elapsedMs: number;
}

async function collect(options: StatusOptions): Promise<Collected> {
  const home = options.roots?.home ?? os.homedir();
  const offline = options.offline ?? false;

  const ctx: CollectContext = {
    offline,
    ...(options.fixtureRoot !== undefined ? { fixtureRoot: options.fixtureRoot } : {}),
  };

  const roots = {
    roots: {
      ...(options.roots?.home !== undefined ? { home: options.roots.home } : { home }),
      ...(options.roots?.projectDir !== undefined ? { projectDir: options.roots.projectDir } : {}),
    },
  };

  const started = performance.now();

  // Concurrent, and each isolated: one broken collector degrades one section.
  // `Promise.all` cannot reject here because `runCollector` never does.
  const [cli, config, registry, skills, mcp] = await Promise.all([
    runCollector<CliInventory>(
      // The opt-in is passed through UNCHANGED even when offline, and the
      // collector refuses on `ctx.offline` itself. Forcing it to false here
      // instead would suppress the command correctly and then explain it
      // wrongly — the user would be told to "pass includeMcpList to opt in"
      // when they already had, and the real reason (`--offline`) would never
      // be named. The zero-egress guarantee is asserted directly against the
      // collector, so it does not rest on this call site being careful.
      createCliCollector({ includeMcpList: options.includeMcpList ?? false }),
      ctx,
    ),
    runCollector<ConfigData>({ name: 'config', collect: (c) => collectConfig(c, roots) }, ctx),
    runCollector<RegistryData>(createRegistryCollector(roots), ctx),
    runCollector<SkillsInventory>({ name: 'skills', collect: (c) => collectSkills(c, roots) }, ctx),
    runCollector<McpServerEntity[]>(
      createMcpCollector({ claudeJsonPath: path.join(home, '.claude.json') }),
      ctx,
    ),
  ]);

  const elapsedMs = Math.round(performance.now() - started);

  // `extraWarnings` is deliberately not passed: `buildInventory` harvests the
  // warnings off every outcome handed to it, and threading an `aggregate()`
  // report through as well would report each one twice. The field is for
  // collectors NOT passed above.
  const inventory = buildInventory({ cli, config, registry, skills, mcp, elapsedMs });

  return {
    inventory,
    config: config.status === 'ok' ? (config.data ?? undefined) : undefined,
    elapsedMs,
  };
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * Produces the inventory `status` renders.
 *
 * Writing the cache is best effort and never fails the run: a machine with a
 * read-only `$HOME` gets a correct, uncached answer and an explanation.
 */
export async function status(options: StatusOptions = {}): Promise<StatusResult> {
  const cacheOptions = {
    ...(options.stateDir !== undefined ? { stateDir: options.stateDir } : {}),
    ...(options.toolVersion !== undefined ? { toolVersion: options.toolVersion } : {}),
  };

  if (options.cached === true) {
    const read = await readCache<Inventory>(STATUS_CACHE_KEY, cacheOptions);
    if (read.hit) {
      return {
        inventory: read.value,
        origin: 'cache',
        cachedAt: read.writtenAt,
        warnings: read.value.warnings,
      };
    }

    // Reported, not silently upgraded. A caller who asked for the fast path
    // and got a cold one must be able to tell — otherwise a script prints a
    // fresh number believing it is the cached one, and the 200ms budget it
    // was written against is quietly gone.
    const collected = await collect(options);
    const warning: InventoryWarning = {
      code: 'partial',
      message:
        `--cached could not be honoured (${read.reason}); this answer was collected fresh. ` +
        'It is correct, but it is not the cached one and did not meet the cached budget.',
      subject: STATUS_CACHE_KEY,
    };

    const warnings = [warning, ...collected.inventory.warnings];
    const persisted = await persistInventory(collected, options, cacheOptions);

    return {
      inventory: { ...collected.inventory, warnings: [...warnings, ...persisted] },
      origin: 'collected',
      cacheMiss: read.reason,
      warnings: [...warnings, ...persisted],
    };
  }

  const collected = await collect(options);
  const persisted = await persistInventory(collected, options, cacheOptions);
  const warnings = [...collected.inventory.warnings, ...persisted];

  return {
    inventory: { ...collected.inventory, warnings },
    origin: 'collected',
    warnings,
  };
}

/**
 * Records the answer, unless it is one that should not be recorded.
 *
 * Exported so the refusal branch can be tested directly. Reaching it through
 * `status()` would mean engineering a genuinely failing collector, and a test
 * that cannot force the condition ends up asserting the healthy path and
 * quietly proving nothing — which is what the first version of it did.
 */
export async function persistInventory(
  collected: Collected,
  options: StatusOptions,
  cacheOptions: { stateDir?: string; toolVersion?: string } = {},
): Promise<InventoryWarning[]> {
  // A degraded run is not cached. Recording an answer that is missing a
  // section would serve that hole back for as long as the inputs sit still —
  // and the inputs sitting still is exactly what a broken collector does not
  // depend on. The next run would then be fast, wrong, and indistinguishable
  // from a good one.
  if (collected.inventory.degraded.length > 0) {
    return [
      {
        code: 'partial',
        message:
          `not cached: ${collected.inventory.degraded.join(', ')} degraded, and caching a ` +
          'partial answer would serve the hole back until an unrelated file changed.',
        subject: STATUS_CACHE_KEY,
      },
    ];
  }

  const home = options.roots?.home ?? os.homedir();
  const inputs = inventoryInputs(home, collected.config);
  return writeCache(STATUS_CACHE_KEY, inputs, collected.inventory, cacheOptions);
}
