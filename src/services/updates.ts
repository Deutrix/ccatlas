/**
 * Updates and version health — T2.1–T2.6. **The product's differentiator.**
 *
 * ## The design changed twice, and the second time in our favour
 *
 * T2.1 originally read `plugin list --json --available` for upgrade targets.
 * T0.1 proved that command **excludes every installed plugin** — 0 of 5
 * present in 276 rows — so it yields no upgrade targets at all and cannot be
 * the data source. T2.2, the "fallback" resolver, was promoted to primary.
 *
 * T2.2 was then specified as `git ls-remote` per source type, on the
 * assumption that finding out whether a source had moved required the network.
 * **It does not.** The marketplace clone already on disk carries, per plugin
 * entry, the `source.sha` that the next `plugin install` would fetch, and
 * `installed_plugins.json` carries the `gitCommitSha` that was actually
 * installed. Comparing those two answers the whole question offline.
 *
 * Measured on the reference machine the moment this was wired up: **2 of 5
 * plugins are stale-pinned** — `superpowers` installed at `eafe962b` while its
 * entry now pins `44c9b2d6`, and `figma` at `a72c41ef` against `ef474d18`.
 * Both report version strings that have not changed, so `/plugin update` says
 * *already at the latest version* while the user runs old code. That is
 * precisely the pathology F2 exists to surface, and it turns out to be visible
 * with zero egress.
 *
 * The network path is still needed for one thing — whether the *marketplace
 * clone itself* is behind its remote — and that is T2.7/T2.8's territory,
 * gated by `--offline`.
 */

import type { MarketplaceEntry, RegistryData } from '../collectors/registry.ts';
import type { Inventory, MergedPlugin } from './inventory.ts';
import type { Warning } from '../types.ts';

/** How far apart two versions are. `unknown` when either is not semver. */
export type SemverDelta = 'same' | 'patch' | 'minor' | 'major' | 'unknown';

/**
 * Which way the difference runs.
 *
 * **Not cosmetic.** The reference machine has `ui-ux-pro-max` installed at
 * 2.5.0 with its marketplace entry declaring 2.2.1 — the entry is *behind* the
 * installed copy. Rendering that as "2.5.0 → 2.2.1" under a heading called
 * "available updates" tells the user to upgrade to an older version, which is
 * worse than saying nothing. `entry-behind` is a marketplace that has not been
 * bumped, not an update.
 */
export type UpdateDirection = 'upgrade' | 'entry-behind' | 'same' | 'unknown';

export interface UpdateRecord {
  /** `<plugin>@<marketplace>`. */
  readonly id: string;
  readonly installedVersion: string;
  /** What the marketplace entry declares, when it declares one. */
  readonly availableVersion?: string;
  readonly delta: SemverDelta;
  /** Which way the difference runs — an entry BEHIND the install is not an update. */
  readonly direction: UpdateDirection;
  /**
   * **The stale-pin flag.** The version string has not moved, but the source
   * the entry points at has. `/plugin update` will report no update available.
   */
  readonly stalePin?: StalePin;
  /** Both `version` fields set and different — T2.5. */
  readonly doubleDeclared?: { readonly effective: string; readonly masked: string };
  /** No marketplace entry matched. Not an error; sideloads have none. */
  readonly unresolved?: string;
}

export interface StalePin {
  /** The commit actually installed, from `installed_plugins.json`. */
  readonly installedSha: string;
  /** The commit the marketplace entry now pins. */
  readonly entrySha: string;
}

export interface MarketplaceStaleness {
  readonly name: string;
  readonly lastUpdated?: string;
  readonly ageDays?: number;
  /**
   * `claude-plugins-official` is auto-installed and refreshes at session
   * start, so its age says nothing about user action. Excluded from the
   * report rather than shown as always-fresh, which would be noise.
   */
  readonly autoRefreshed: boolean;
}

export interface UpdatesReport {
  readonly updates: UpdateRecord[];
  readonly stalePins: UpdateRecord[];
  /** Genuine upgrades — the entry is ahead of what is installed. */
  readonly upgrades: UpdateRecord[];
  /**
   * The entry is BEHIND the install. Not an update; an un-bumped marketplace.
   * Kept separate so it can never be rendered as something to act on.
   */
  readonly entriesBehind: UpdateRecord[];
  readonly marketplaces: MarketplaceStaleness[];
  readonly warnings: Warning[];
}

/**
 * Marketplaces Claude Code refreshes on its own.
 *
 * `claude-plugins-official` is auto-installed (`~/.claude.json →
 * officialMarketplaceAutoInstalled`) and refreshed at session start. It is
 * special-cased by **how it is registered**, not by a flag — §3.2.1 verified
 * that no auto-update flag exists anywhere, which is why T2.6 is a staleness
 * report rather than a settings audit. An Anthropic-owned but *user-added*
 * marketplace gets no such treatment and is not on this list.
 */
const AUTO_REFRESHED = new Set(['claude-plugins-official']);

/** Beyond this, a third-party marketplace is worth mentioning. */
export const STALE_MARKETPLACE_DAYS = 30;

// ---------------------------------------------------------------------------
// T2.3 — semver delta
// ---------------------------------------------------------------------------

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)/u;

/**
 * Classifies the distance between two version strings.
 *
 * `unknown` covers the literal `"unknown"` version — a real, observed value
 * for a relative path inside a non-git clone — and anything else that is not
 * semver. Returning `patch` for an unparseable pair would be inventing a
 * reassurance.
 */
export function semverDelta(installed: string, available: string): SemverDelta {
  if (installed === available) return 'same';

  const a = SEMVER.exec(installed);
  const b = SEMVER.exec(available);
  if (a === null || b === null) return 'unknown';

  if (a[1] !== b[1]) return 'major';
  if (a[2] !== b[2]) return 'minor';
  if (a[3] !== b[3]) return 'patch';

  // Equal numerics but different strings — a prerelease or build suffix.
  return 'unknown';
}

/** Which way the version difference runs. See {@link UpdateDirection}. */
export function updateDirection(installed: string, available: string): UpdateDirection {
  if (installed === available) return 'same';

  const a = SEMVER.exec(installed);
  const b = SEMVER.exec(available);
  if (a === null || b === null) return 'unknown';

  for (let part = 1; part <= 3; part += 1) {
    const mine = Number(a[part]);
    const theirs = Number(b[part]);
    if (mine === theirs) continue;
    return theirs > mine ? 'upgrade' : 'entry-behind';
  }

  return 'unknown';
}

// ---------------------------------------------------------------------------
// T2.2 / T2.4 / T2.5 — the resolver and the two pathologies
// ---------------------------------------------------------------------------

const idOf = (entry: MarketplaceEntry): string => `${entry.name}@${entry.marketplace}`;

/**
 * Builds one update record per installed plugin.
 *
 * The upgrade target is the marketplace **entry**, not `--available`. Where an
 * entry declares no version — 221 of 276 official entries do not — there is no
 * version comparison to make, and the record says so rather than reporting
 * `same` and implying it checked.
 */
export function resolveUpdates(
  plugins: readonly MergedPlugin[],
  entries: readonly MarketplaceEntry[],
): { records: UpdateRecord[]; warnings: Warning[] } {
  const byId = new Map(entries.map((entry) => [idOf(entry), entry]));
  const records: UpdateRecord[] = [];
  const warnings: Warning[] = [];

  for (const plugin of plugins) {
    const entry = byId.get(plugin.id.name);
    const installedVersion = plugin.version.version;

    if (entry === undefined) {
      records.push({
        id: plugin.id.name,
        installedVersion,
        delta: 'unknown',
        direction: 'unknown',
        // Ordinary for a `--plugin-dir` sideload, and for a marketplace whose
        // clone could not be read. Reported so the absence is visible rather
        // than presenting as "up to date".
        unresolved: 'no marketplace entry matched this plugin',
      });
      continue;
    }

    const delta =
      entry.version === undefined ? 'unknown' : semverDelta(installedVersion, entry.version);
    const direction =
      entry.version === undefined ? 'unknown' : updateDirection(installedVersion, entry.version);

    // T2.5, computed HERE rather than carried from T1.9.
    //
    // The merge populates `doubleDeclared` from `cli.available`, and T0.1
    // proved `--available` excludes every installed plugin — so for an
    // installed plugin that field is never set and the detection was dead
    // code. The marketplace entry is the right source, for exactly the same
    // reason it is the right source for upgrade targets.
    //
    // Flagged only when the two DIFFER, or every well-maintained plugin trips
    // it. Live example: ui-ux-pro-max declares 2.5.0 in plugin.json and 2.2.1
    // in its entry; everything-claude-code declares 1.9.0 in both and must
    // stay silent.
    const doubleDeclared =
      entry.version !== undefined && entry.version !== installedVersion
        ? { effective: installedVersion, masked: entry.version }
        : undefined;

    // T2.4. The installed commit and the commit the entry now points at, both
    // recorded facts — no network, no inference. Flagged only when BOTH are
    // known and they differ: an absent `gitCommitSha` (frontend-design has
    // none) means there is nothing to compare, not that nothing moved.
    const installedSha = plugin.version.installedSha;
    const stalePin =
      installedSha !== undefined && entry.sourceSha !== undefined && installedSha !== entry.sourceSha
        ? { installedSha, entrySha: entry.sourceSha }
        : undefined;

    if (stalePin !== undefined) {
      warnings.push({
        code: 'reconciliation',
        message:
          `installed at ${stalePin.installedSha.slice(0, 8)} but the marketplace entry now pins ` +
          `${stalePin.entrySha.slice(0, 8)}, while the version string stays "${installedVersion}" — ` +
          '`/plugin update` will report no update available',
        subject: plugin.id.name,
      });
    }

    records.push({
      id: plugin.id.name,
      installedVersion,
      ...(entry.version !== undefined ? { availableVersion: entry.version } : {}),
      delta,
      direction,
      ...(stalePin !== undefined ? { stalePin } : {}),
      ...(doubleDeclared !== undefined ? { doubleDeclared } : {}),
    });
  }

  return { records, warnings };
}

// ---------------------------------------------------------------------------
// T2.6 — marketplace staleness
// ---------------------------------------------------------------------------

/**
 * Ages every marketplace by `lastUpdated`.
 *
 * The original F2 wording was "every third-party marketplace with auto-update
 * off", which §3.2.1 disproved: **no such flag exists**, in
 * `known_marketplaces.json`, in `marketplace list --json`, or in
 * `marketplace add --help`. The posture it described is real but arises from
 * two other mechanisms, and `lastUpdated` is the one that is observable — the
 * reference machine had official refreshed the same day and two third-party
 * marketplaces **123 days** stale.
 *
 * Beware the naming trap this replaced: `settings.json → autoUpdatesChannel`
 * and `~/.claude.json → autoUpdates` both govern the Claude Code **self**
 * updater. A grep for `autoUpdate` finds them and yields a confident wrong
 * answer.
 */
export function marketplaceStaleness(
  marketplaces: RegistryData['marketplaces'],
  now: number,
): MarketplaceStaleness[] {
  return marketplaces.map((market) => {
    const autoRefreshed = AUTO_REFRESHED.has(market.name);
    if (market.lastUpdated === undefined) {
      return { name: market.name, autoRefreshed };
    }

    const parsed = Date.parse(market.lastUpdated);
    if (Number.isNaN(parsed)) {
      return { name: market.name, lastUpdated: market.lastUpdated, autoRefreshed };
    }

    return {
      name: market.name,
      lastUpdated: market.lastUpdated,
      ageDays: Math.max(0, Math.floor((now - parsed) / 86_400_000)),
      autoRefreshed,
    };
  });
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface UpdatesInputs {
  readonly inventory: Inventory;
  readonly entries: readonly MarketplaceEntry[];
  readonly marketplaces: RegistryData['marketplaces'];
  /** Injected so the report is reproducible in tests. */
  readonly now: number;
}

export function buildUpdatesReport(inputs: UpdatesInputs): UpdatesReport {
  const { records, warnings } = resolveUpdates(inputs.inventory.plugins, inputs.entries);

  return {
    updates: records,
    // Surfaced as its own list because it is the finding no other tool shows,
    // and it would otherwise be one optional field on a row nobody reads.
    stalePins: records.filter((record) => record.stalePin !== undefined),
    upgrades: records.filter((record) => record.direction === 'upgrade'),
    entriesBehind: records.filter((record) => record.direction === 'entry-behind'),
    marketplaces: marketplaceStaleness(inputs.marketplaces, inputs.now),
    warnings,
  };
}
