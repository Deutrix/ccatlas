/**
 * Collector error isolation — T1.5.
 *
 * Architecture principle 3: one broken collector degrades one report section,
 * never the run. ccatlas exists to inspect machines that may be in a bad state,
 * so a corrupt config, an absent CLI, or a hung health check is the *use* case,
 * not the edge case. Every failure mode below was converted into a value here
 * precisely so no caller has to remember to wrap a collector in try/catch.
 *
 * The load-bearing property is the one in `CollectorOutcome`: a section that is
 * empty because there is nothing must be distinguishable from a section that is
 * empty because the collector broke. Conflating them is how a tool ends up
 * saying "you have used nothing, prune everything" after a parser died — a
 * confidently wrong recommendation that deletes working configuration.
 *
 * Runtime import constraint: this module imports NO project file as a value.
 * The repo's NodeNext convention writes sibling imports as `./x.js`, which
 * resolves under esbuild and tsc but not under Node's type stripping, where the
 * `.mjs` tests load this file directly. Type-only imports erase, so `import
 * type` here is not a style choice — a value import from `../types.js` would
 * break the test path. `verbatimModuleSyntax` in tsconfig enforces the spelling.
 */

import type { CollectContext, Collector, CollectorResult, Warning } from '../types.js';

/**
 * Generous on purpose. `claude mcp list` live-health-checks every configured
 * server and took ~40s on the reference machine, so a budget under that would
 * time out a perfectly healthy machine and report its MCP section as broken —
 * a false degradation, which is the failure this module exists to prevent.
 * Tighten per call via `IsolateOptions.timeoutMs`, not here.
 */
export const DEFAULT_COLLECTOR_TIMEOUT_MS = 60_000;

/**
 * How a collector failed. `reported` means the collector did its job and
 * returned `{ok:false}`; every other value means the harness converted
 * something that would otherwise have propagated.
 */
export type FailureMode = 'reported' | 'rejected' | 'threw' | 'timeout' | 'invalid-result';

/** Error codes the harness synthesises. A `reported` failure keeps its own. */
export const FAILURE_CODES = {
  rejected: 'collector-rejected',
  threw: 'collector-threw',
  timeout: 'collector-timeout',
  'invalid-result': 'collector-invalid-result',
  reported: 'collector-failed',
} as const satisfies Record<FailureMode, string>;

/**
 * The name is widened to `string` at this boundary. `Collector['name']` is a
 * closed union of the five real collectors; the harness never interprets the
 * name, and test stubs and fixture collectors need to pass one that is not in
 * the union.
 */
export type IsolatedCollector<T> = Omit<Collector<T>, 'name'> & { readonly name: string };

/**
 * A collector that ran and returned. `data` may still be `null` or empty —
 * that is a real answer ("nothing configured"), and it is `status` that says
 * whether the answer is trustworthy.
 */
export interface SucceededOutcome<T> extends CollectorResult<T> {
  name: string;
  status: 'ok';
  ok: true;
}

/** A collector that did not produce a usable answer. Its section is degraded. */
export interface FailedOutcome extends CollectorResult<never> {
  name: string;
  status: 'failed';
  ok: false;
  data: null;
  mode: FailureMode;
  /** Always present here, unlike the optional field on `CollectorResult`. */
  error: { code: string; message: string };
}

/**
 * Branch on `status` before reading `data`. `data` is present on both members
 * and `null` or empty on both, so the payload alone cannot tell "there is
 * nothing configured" from "the collector broke" — that is precisely why
 * `status` exists. The compiler will not stop you reading `data` off the
 * union; nothing here enforces the branch for you.
 */
export type CollectorOutcome<T> = SucceededOutcome<T> | FailedOutcome;

/** A warning plus the collector it came from, for the aggregated list. */
export interface TaggedWarning extends Warning {
  collector: string;
}

export interface CollectorRunReport {
  /**
   * True when every collector succeeded. False means some section is degraded.
   * Says nothing about completeness: `ok === true` with a non-empty `partial`
   * is a usable run in which some section is only right as far as it goes.
   */
  ok: boolean;
  /** In the order the collectors were passed, regardless of completion order. */
  outcomes: CollectorOutcome<unknown>[];
  warnings: TaggedWarning[];
  /** Names of the degraded sections. Never inferred from empty data. */
  failed: string[];
  /**
   * Names of sections that succeeded but warned `partial` — ok, and knowingly
   * incomplete because an input was absent. Distinct from `failed`: the data
   * is real and must be used, it just is not the whole answer. Surfaced here
   * rather than left buried in `warnings` because a caller checking only `ok`
   * would otherwise present an incomplete section as a complete one.
   */
  partial: string[];
  /** Wall-clock ms for the whole run — not the sum of the parts, they overlap. */
  elapsedMs: number;
}

export interface IsolateOptions {
  /** Per-collector budget. Defaults to `DEFAULT_COLLECTOR_TIMEOUT_MS`. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------

/** Sentinel resolved by the timeout race; never leaks past `runCollector`. */
const TIMED_OUT = Symbol('ccatlas.collector.timeout');

function now(): number {
  return performance.now();
}

/**
 * Renders any thrown value as a message. Must never throw itself: it runs on
 * the failure path, where a second failure would take down the run it exists
 * to protect. `JSON.stringify` throws on circular structures and BigInt, and a
 * hostile `toString` can throw too, so both are guarded.
 */
function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) {
    return thrown.message !== '' ? thrown.message : thrown.name;
  }
  if (typeof thrown === 'string') {
    return thrown !== '' ? thrown : 'threw an empty string';
  }
  if (thrown === null) return 'threw null';
  if (thrown === undefined) return 'threw undefined';

  try {
    const json = JSON.stringify(thrown);
    if (typeof json === 'string' && json !== '') return json;
  } catch {
    // Circular, BigInt, or a throwing toJSON. Fall through.
  }
  try {
    return String(thrown);
  } catch {
    return `threw a non-renderable ${typeof thrown}`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Lenient where leniency is safe, strict where it is not. A missing or
 * non-array `warnings` is coerced rather than failing the whole section, but a
 * result with no boolean `ok` has no readable meaning at all — treating it as
 * success would be inventing an answer.
 */
function warningsOf(value: unknown): Warning[] {
  return Array.isArray(value) ? [...(value as Warning[])] : [];
}

function fail(
  name: string,
  mode: FailureMode,
  message: string,
  elapsedMs: number,
  warnings: Warning[],
  code: string = FAILURE_CODES[mode],
): FailedOutcome {
  const outcome: FailedOutcome = {
    name,
    status: 'failed',
    ok: false,
    data: null,
    mode,
    error: { code, message },
    warnings,
    elapsedMs,
  };

  // A degraded section must say so on its own, so a surface rendering one
  // section in isolation still explains the emptiness. Skip it when the
  // collector already warned about the same thing.
  const alreadyWarned = warnings.some((w) => w.code === 'collector-failed' && w.subject === name);
  if (!alreadyWarned) {
    outcome.warnings = [
      ...warnings,
      { code: 'collector-failed', message: `${name}: ${message}`, subject: name },
    ];
  }

  return outcome;
}

/**
 * Runs one collector, converting every failure mode into a value.
 *
 * Never rejects. Never throws. The returned promise always settles with an
 * outcome, including when the collector is not shaped like a collector at all.
 */
export async function runCollector<T>(
  collector: IsolatedCollector<T>,
  ctx: CollectContext,
  options: IsolateOptions = {},
): Promise<CollectorOutcome<T>> {
  const name = isRecord(collector) && typeof collector.name === 'string' ? collector.name : 'unknown';
  const timeoutMs = options.timeoutMs ?? DEFAULT_COLLECTOR_TIMEOUT_MS;
  const startedAt = now();
  const elapsed = (): number => Math.round(now() - startedAt);

  if (!isRecord(collector) || typeof collector.collect !== 'function') {
    return fail(name, 'invalid-result', 'collector exposes no collect() function', elapsed(), []);
  }

  let pending: Promise<CollectorResult<T>>;
  try {
    // Called directly rather than deferred through a microtask so that a batch
    // of collectors is genuinely in flight before the first await.
    pending = Promise.resolve(collector.collect(ctx));
  } catch (thrown: unknown) {
    // A throw before the promise ever existed. Distinct from a rejection only
    // as a diagnostic, but the distinction is free and points at the bug.
    return fail(name, 'threw', describeThrown(thrown), elapsed(), []);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled: CollectorResult<T> | typeof TIMED_OUT;
  try {
    settled = await Promise.race([
      pending,
      new Promise<typeof TIMED_OUT>((resolve) => {
        // Deliberately NOT unref'd. A hung collector leaves nothing else
        // pending, so an unref'd timer lets the event loop drain and the race
        // never settles at all — the stall this exists to prevent. The timer
        // is bounded instead: it either fires or is cleared below.
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
  } catch (thrown: unknown) {
    return fail(name, 'rejected', describeThrown(thrown), elapsed(), []);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  if (settled === TIMED_OUT) {
    // The collector is abandoned, not cancelled — a promise cannot be
    // cancelled and `CollectContext` carries no AbortSignal. Safe because
    // collectors are contractually read-only and pure, so whatever it is still
    // doing cannot corrupt anything. See the report note on adding a signal.
    return fail(
      name,
      'timeout',
      `timed out after ${timeoutMs}ms and was abandoned; this section is degraded, not empty`,
      elapsed(),
      [],
    );
  }

  if (!isRecord(settled) || typeof settled.ok !== 'boolean') {
    return fail(
      name,
      'invalid-result',
      `collect() resolved with ${describeThrown(settled)} instead of a CollectorResult`,
      elapsed(),
      [],
    );
  }

  const warnings = warningsOf(settled.warnings);

  if (settled.ok === false) {
    const reported = isRecord(settled.error) ? settled.error : undefined;
    const code = typeof reported?.code === 'string' ? reported.code : FAILURE_CODES.reported;
    const message =
      typeof reported?.message === 'string' && reported.message !== ''
        ? reported.message
        : 'collector reported failure without an error message';
    return fail(name, 'reported', message, elapsed(), warnings, code);
  }

  // `data` is taken as the collector gave it, `null` included: a collector
  // saying "there is nothing here" is a real answer, and `status` already
  // carries the distinction that matters. `elapsedMs` is overwritten because
  // one clock must be authoritative for the T1.11 budget.
  return {
    name,
    status: 'ok',
    ok: true,
    data: settled.data as T | null,
    warnings,
    elapsedMs: elapsed(),
  };
}

/**
 * Folds outcomes into one report. Pure, so callers that need per-collector
 * types can run `runCollector` themselves and still get the aggregate view.
 */
export function aggregate(
  outcomes: readonly CollectorOutcome<unknown>[],
  elapsedMs?: number,
): CollectorRunReport {
  const warnings: TaggedWarning[] = [];
  const failed: string[] = [];
  const partial: string[] = [];

  for (const outcome of outcomes) {
    if (outcome.status === 'failed') failed.push(outcome.name);

    let incomplete = false;
    for (const warning of outcome.warnings) {
      // Spread first so the tag cannot be clobbered by a collector emitting a
      // `collector` field of its own, and so `subject` survives untouched.
      warnings.push({ ...warning, collector: outcome.name });
      if (warning.code === 'partial') incomplete = true;
    }

    // Named once however many reasons it gave — every reason still lands in
    // `warnings`. A failed section is never also "partial": its data is absent
    // entirely, and listing it as merely incomplete would understate that.
    if (incomplete && outcome.status === 'ok') partial.push(outcome.name);
  }

  return {
    ok: failed.length === 0,
    outcomes: [...outcomes],
    warnings,
    failed,
    partial,
    // Falls back to the slowest part, which is the tightest lower bound
    // available without having timed the run.
    elapsedMs: elapsedMs ?? outcomes.reduce((max, o) => Math.max(max, o.elapsedMs), 0),
  };
}

/**
 * Runs every collector concurrently and reports all of them.
 *
 * Never rejects: `runCollector` cannot reject, so the `Promise.all` cannot
 * either, and one collector's failure never withholds another's success.
 */
export async function runCollectors(
  collectors: readonly IsolatedCollector<unknown>[],
  ctx: CollectContext,
  options: IsolateOptions = {},
): Promise<CollectorRunReport> {
  const startedAt = now();
  const outcomes = await Promise.all(collectors.map((c) => runCollector(c, ctx, options)));
  return aggregate(outcomes, Math.round(now() - startedAt));
}
