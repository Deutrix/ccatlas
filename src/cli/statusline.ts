/**
 * The statusline segment — T7.12.
 *
 * ## Three hard rules, all for the same reason
 *
 * The statusline renders on **every prompt**. So it must:
 *
 * 1. **Never block.** A slow segment is felt on every keystroke-to-render,
 *    which is the most visible latency in the product.
 * 2. **Never network.** Same reason, worse variance.
 * 3. **Read the cache only.** Never collect. A cold collection spawns `claude`
 *    three times and takes ~2s — in a statusline that is unusable.
 *
 * A cache miss therefore renders **nothing at all** rather than falling back to
 * a collection. An empty segment is invisible; a two-second stall is not.
 */

import type { Inventory } from '../services/inventory.ts';

export interface StatuslineInput {
  readonly inventory?: Inventory;
  /** Stale pins, from a cached updates report. */
  readonly stalePins?: number;
  /** Findings at `critical` severity. */
  readonly critical?: number;
}

/**
 * Renders the segment, or `''` when there is nothing worth a prompt's width.
 *
 * Only *actionable* state is shown. A count of installed plugins is not news —
 * it is the same on every prompt of every session, so it would be pure noise
 * that trains the user to stop reading the segment.
 */
export function renderStatusline(input: StatuslineInput): string {
  const parts: string[] = [];

  const critical = input.critical ?? 0;
  if (critical > 0) parts.push(`⛔ ${critical}`);

  const stale = input.stalePins ?? 0;
  if (stale > 0) parts.push(`⇡ ${stale} stale`);

  const degraded = input.inventory?.degraded ?? [];
  if (degraded.length > 0) parts.push(`⚠ ${degraded.join(',')}`);

  // Nothing actionable ⇒ nothing rendered. The segment earns its width or
  // takes none.
  return parts.length === 0 ? '' : `ccatlas ${parts.join(' ')}`;
}

/**
 * The budget a statusline invocation must respect.
 *
 * Not enforced here — this function is pure and instant. It is the contract
 * the *caller* honours by passing cached data, and it is stated so the number
 * is reviewable rather than folklore.
 */
export const STATUSLINE_BUDGET_MS = 50;
