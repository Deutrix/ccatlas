/**
 * Extension usage and context cost — T4.9–T4.12.
 *
 * **Cost here means context, never money.** The figure is roughly how many
 * tokens an extension occupies in every turn whether or not it is used. This
 * service reads transcripts and an estimator; it has no billing data, no
 * pricing table, and no notion of spend.
 *
 * **The only service permitted to import the transcript adapter.** That
 * quarantine is the whole reason T4.1 is its own layer: if the undocumented
 * JSONL format moves, this report goes dark and `status`, `doctor`, `updates`
 * and `report` are untouched.
 *
 * ## Counts are exact; costs are estimates. The distinction is load-bearing
 *
 * An invocation count is a fact — it was in the transcript or it was not. A
 * token cost comes from Claude Code's own estimator, which **falls back
 * silently** across three regimes ~40% apart. So any ratio of invocations to
 * cost is a fact divided by an estimate, and every surface that renders one
 * has to say so.
 *
 * ## `--unused` is the headline, and it is where a wrong answer costs most
 *
 * "Zero invocations, sorted by passive cost" is a prune list — the user acts
 * on it by deleting things. So an entity is only ever reported unused when the
 * transcript layer was **available and read**; a degraded scan yields
 * `{ available: false }` and no list at all, because "I could not read your
 * usage" and "you have not used these" are the same shape and opposite advice.
 */

import type { Signal, SignalKind } from '../collectors/transcripts.ts';
import type { Inventory, MergedPlugin } from './inventory.ts';

export interface UsageRecord {
  readonly kind: SignalKind;
  readonly entity: string;
  readonly invocations: number;
  /** ISO-8601 of the most recent invocation. */
  readonly lastUsed?: string;
  /** Owning plugin, resolved against the inventory — never parsed from a name. */
  readonly owner?: string;
  /** Sessions the entity was invoked in. Distinct from invocations. */
  readonly sessions: number;
}

export interface UnusedRecord {
  readonly kind: SignalKind | 'plugin';
  readonly entity: string;
  readonly owner?: string;
  /**
   * Always-on tokens this costs whether or not it is used. `undefined` when
   * nothing measured it — which must never render as 0, since 0 would mean
   * "free to keep" and the whole point of the list is what to remove.
   */
  readonly passiveCost?: number;
}

export interface UsageReport {
  readonly available: true;
  readonly records: UsageRecord[];
  readonly unused: UnusedRecord[];
  /** Files read and rejected, so coverage is auditable. */
  readonly scanned: { readonly accepted: number; readonly rejected: number };
  readonly totalInvocations: number;
  /** Set when some entity's cost could not be measured. */
  readonly costIncomplete: boolean;
  readonly methodology: string;
}

export type UsageResult = UsageReport | { readonly available: false; readonly reason: string };

/**
 * The note that must appear on every usage surface.
 *
 * T4.14 requires it, and the reason is that two very different kinds of number
 * sit side by side in this report. A reader who assumes both are measured will
 * over-trust the cost column.
 */
export const METHODOLOGY =
  'Invocation counts are exact — they come from transcript records. Token costs are ' +
  'ESTIMATES from Claude Code\'s own estimator, which falls back silently across regimes ' +
  'that differ by ~40%, and are rounded. Above the ~30k-character listing cap, per-entity ' +
  'always-on figures rank but do not sum. Transcripts are an undocumented format; a run ' +
  'that could not read them reports no usage rather than zero usage.';

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

const key = (kind: SignalKind, entity: string): string => `${kind} ${entity}`;

/**
 * Folds signals into per-entity records.
 *
 * Sidechain signals are **counted**. They are 46% of assistant records, and a
 * skill invoked by a subagent is still a skill the user's stack ran — treating
 * only top-level invocations as real would understate the most-used entities
 * by roughly half.
 */
export function aggregate(signals: readonly Signal[]): UsageRecord[] {
  const buckets = new Map<
    string,
    { kind: SignalKind; entity: string; count: number; last?: string; sessions: Set<string>; plugin?: string }
  >();

  for (const signal of signals) {
    const id = key(signal.kind, signal.entity);
    const bucket = buckets.get(id) ?? {
      kind: signal.kind,
      entity: signal.entity,
      count: 0,
      sessions: new Set<string>(),
    };

    bucket.count += 1;
    bucket.sessions.add(signal.sessionId);
    if (bucket.last === undefined || signal.ts > bucket.last) bucket.last = signal.ts;
    // ISO-8601 with a fixed offset sorts lexically, so no Date parsing is
    // needed to find the maximum — and parsing 293,084 timestamps to compare
    // them would be the single most expensive thing this function does.
    if (signal.plugin !== undefined) bucket.plugin = signal.plugin;

    buckets.set(id, bucket);
  }

  return [...buckets.values()]
    .map((bucket) => ({
      kind: bucket.kind,
      entity: bucket.entity,
      invocations: bucket.count,
      ...(bucket.last !== undefined ? { lastUsed: bucket.last } : {}),
      ...(bucket.plugin !== undefined ? { owner: bucket.plugin } : {}),
      sessions: bucket.sessions.size,
    }))
    .sort((a, b) => b.invocations - a.invocations || a.entity.localeCompare(b.entity));
}

/**
 * Resolves an entity's owning plugin against the inventory.
 *
 * **Against the inventory, never by parsing the name.** A recorded command
 * name is bare — `/plan`, with no plugin namespace — so the string carries no
 * owner at all. A name colliding across two plugins remains unobserved and
 * would be genuinely ambiguous; it resolves to `undefined` rather than to
 * whichever plugin sorted first.
 */
export function resolveOwner(
  inventory: Inventory,
  kind: SignalKind,
  entity: string,
): string | undefined {
  if (kind === 'mcp') return undefined;

  const pool =
    kind === 'skill' ? inventory.skills : kind === 'agent' ? inventory.agents : inventory.commands;

  const matches = pool.filter((item) => item.id.name.toLowerCase() === entity.toLowerCase());
  if (matches.length !== 1) return undefined;

  const only = matches[0];
  return only?.origin === 'marketplace' ? only.id.scope : undefined;
}


/**
 * Which plugins had something of theirs invoked.
 *
 * **The most consequential function in this file**, because `--unused` is a
 * prune list: a plugin wrongly reported unused gets deleted.
 *
 * An earlier version derived plugin usage *only* from `signal.plugin`, which
 * the transcript adapter sets for MCP tool names and nothing else. Measured
 * on the reference machine, that reported `superpowers` as never invoked
 * while `superpowers:brainstorming` had run **11 times** and
 * `superpowers:systematic-debugging` 7 — it recommended deleting an actively
 * used plugin. `frontend-design` was wrong the same way.
 *
 * Three carriers, because the plugin appears differently in each:
 *
 * 1. `signal.plugin` — MCP, parsed out of `mcp__plugin_<p>_<srv>__<tool>`.
 * 2. A `<plugin>:<component>` prefix — how plugin-provided skills, agents and
 *    commands are named (`superpowers:brainstorming`).
 * 3. The bare plugin name as the entity itself — a plugin whose component
 *    shares its name (`frontend-design`).
 *
 * Every candidate is matched against the INSTALLED set rather than trusted
 * from the string, so a personal skill containing a colon cannot conjure a
 * plugin that is not there.
 */
export function pluginsUsedBy(
  signals: readonly Signal[],
  inventory: Inventory,
): Set<string> {
  const installed = new Set(
    inventory.plugins.map((plugin) =>
      (plugin.id.name.split('@')[0] ?? plugin.id.name).toLowerCase(),
    ),
  );

  const used = new Set<string>();

  for (const signal of signals) {
    if (signal.plugin !== undefined && installed.has(signal.plugin.toLowerCase())) {
      used.add(signal.plugin.toLowerCase());
    }

    const entity = signal.entity.toLowerCase();

    const colon = entity.indexOf(':');
    if (colon > 0 && installed.has(entity.slice(0, colon))) used.add(entity.slice(0, colon));

    if (installed.has(entity)) used.add(entity);
  }

  return used;
}

// ---------------------------------------------------------------------------
// T4.12 — the headline
// ---------------------------------------------------------------------------

/**
 * Entities the transcripts never mention, sorted by what they cost to keep.
 *
 * Sorted by passive cost **descending**, with unmeasured entities last rather
 * than first: an unmeasured entity has no established cost, and putting it at
 * the top of a prune list implies one.
 */
export function findUnused(
  inventory: Inventory,
  used: ReadonlySet<string>,
  costOf: (plugin: MergedPlugin) => number | undefined,
): UnusedRecord[] {
  const unused: UnusedRecord[] = [];

  for (const plugin of inventory.plugins) {
    if (!plugin.enabled) continue;

    // A plugin counts as used when anything it owns was invoked. Its own name
    // never appears in a transcript — plugins are not invoked, their
    // components are.
    const bare = (plugin.id.name.split('@')[0] ?? plugin.id.name).toLowerCase();
    if (used.has(`plugin ${bare}`)) continue;

    const cost = costOf(plugin);
    unused.push({
      kind: 'plugin',
      entity: plugin.id.name,
      ...(cost !== undefined ? { passiveCost: cost } : {}),
    });
  }

  for (const [kind, pool] of [
    ['skill', inventory.skills],
    ['agent', inventory.agents],
    ['command', inventory.commands],
  ] as const) {
    for (const item of pool) {
      // A shadowed entity never loads, so it is not "unused" — it is masked,
      // which doctor already reports with a different remedy.
      if (item.state === 'shadowed') continue;
      if (used.has(key(kind, item.id.name.toLowerCase()))) continue;
      unused.push({ kind, entity: item.id.name });
    }
  }

  return unused.sort((a, b) => {
    if (a.passiveCost === undefined && b.passiveCost === undefined) {
      return a.entity.localeCompare(b.entity);
    }
    if (a.passiveCost === undefined) return 1;
    if (b.passiveCost === undefined) return -1;
    return b.passiveCost - a.passiveCost;
  });
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface AnalyticsInputs {
  readonly inventory: Inventory;
  readonly signals: readonly Signal[];
  readonly scanned: { readonly accepted: number; readonly rejected: number };
  /** Per-plugin always-on cost, when T4.7 measured it. */
  readonly costs?: ReadonlyMap<string, number>;
  /** Only signals at or after this ISO timestamp. */
  readonly since?: string;
  readonly until?: string;
  /** Restrict to one project's `cwd`. Normalised by the caller. */
  readonly project?: string;
}

export function buildUsageReport(inputs: AnalyticsInputs): UsageResult {
  // The quarantine's whole purpose. "Could not read your usage" and "you have
  // not used these" are the same shape and opposite advice, and the second is
  // acted on by deleting things.
  if (inputs.scanned.accepted === 0) {
    return {
      available: false,
      reason:
        inputs.scanned.rejected > 0
          ? `no transcript passed the schema probe (${inputs.scanned.rejected} rejected) — the ` +
            'format may have changed; usage cannot be reported'
          : 'no transcripts were found',
    };
  }

  const filtered = inputs.signals.filter((signal) => {
    if (inputs.since !== undefined && signal.ts < inputs.since) return false;
    if (inputs.until !== undefined && signal.ts > inputs.until) return false;
    if (inputs.project !== undefined) {
      const cwd = signal.cwd?.replace(/\\/gu, '/').toLowerCase().replace(/\/+$/u, '');
      if (cwd !== inputs.project) return false;
    }
    return true;
  });

  const records = aggregate(filtered).map((record) => {
    const owner = record.owner ?? resolveOwner(inputs.inventory, record.kind, record.entity);
    return owner === undefined ? record : { ...record, owner };
  });

  const used = new Set(filtered.map((s) => key(s.kind, s.entity.toLowerCase())));
  for (const plugin of pluginsUsedBy(filtered, inputs.inventory)) used.add(`plugin ${plugin}`);

  const costs = inputs.costs;
  const costOf = (plugin: MergedPlugin): number | undefined =>
    costs?.get(plugin.id.name) ?? plugin.cost?.alwaysOn;

  const unused = findUnused(inputs.inventory, used, costOf);

  return {
    available: true,
    records,
    unused,
    scanned: inputs.scanned,
    totalInvocations: filtered.length,
    costIncomplete: unused.some((u) => u.kind === 'plugin' && u.passiveCost === undefined),
    methodology: METHODOLOGY,
  };
}
