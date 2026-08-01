/**
 * `updates --apply` and `--check` — T2.9, T2.10.
 *
 * ## ccatlas does not update anything itself
 *
 * Every mutation is a `claude` CLI invocation. ccatlas never writes into
 * `~/.claude/plugins/`, and this module's job is to decide *which commands to
 * run* and to run them in an order that works — not to move files. That is an
 * architecture invariant, and it is also the only way the result stays
 * consistent with whatever Claude Code's own installer does next.
 *
 * ## The plan is built before anything runs
 *
 * `--apply` is explicit and `--dry-run` is the default shape: the plan is
 * always computed, always renderable, and only then executed. A user who
 * cannot see what is about to happen cannot refuse it.
 *
 * ## Marketplaces first, then plugins
 *
 * A plugin update pulls from the marketplace clone. Updating plugins before
 * refreshing the clone re-installs the same stale `source.sha` and reports
 * success — the exact pathology T2.4 exists to detect, reproduced by the tool
 * meant to fix it.
 */

import { execFile } from 'node:child_process';
import process from 'node:process';

import type { UpdatesReport } from './updates.ts';

export type ActionKind = 'marketplace-update' | 'plugin-update';

export interface PlannedAction {
  readonly kind: ActionKind;
  readonly subject: string;
  /** The exact argv. Disclosed in full — no collapsing behind "12 actions". */
  readonly argv: readonly string[];
  readonly reason: string;
}

export interface ApplyPlan {
  readonly actions: PlannedAction[];
  /**
   * Things that need doing but have no command that would do them. Reported
   * rather than omitted: a plan that silently covers 3 of 5 findings reads as
   * complete.
   */
  readonly manual: Array<{ readonly subject: string; readonly reason: string }>;
}

/**
 * Builds the plan.
 *
 * Pure — no IO, no clock — so the ordering and the argv can be asserted
 * exactly. Every command is spelled out rather than summarised, per F5's rule
 * that a plan discloses every executable surface in full.
 */
export function planUpdates(report: UpdatesReport, staleDays: number): ApplyPlan {
  const actions: PlannedAction[] = [];
  const manual: Array<{ subject: string; reason: string }> = [];

  // Marketplaces first. A plugin update pulls from the clone, so refreshing
  // afterwards would leave the just-installed copy pinned to the old sha.
  for (const market of report.marketplaces) {
    if (market.autoRefreshed) continue;
    if (market.ageDays === undefined || market.ageDays < staleDays) continue;

    actions.push({
      kind: 'marketplace-update',
      subject: market.name,
      argv: ['plugin', 'marketplace', 'update', market.name],
      reason: `last updated ${market.ageDays} days ago`,
    });
  }

  // Then the plugins whose entry has genuinely moved.
  for (const record of [...report.stalePins, ...report.upgrades]) {
    if (actions.some((action) => action.kind === 'plugin-update' && action.subject === record.id)) {
      continue;
    }

    actions.push({
      kind: 'plugin-update',
      subject: record.id,
      argv: ['plugin', 'update', record.id],
      reason:
        record.stalePin !== undefined
          ? `pinned at ${record.stalePin.installedSha.slice(0, 8)}, entry now points at ` +
            `${record.stalePin.entrySha.slice(0, 8)}`
          : `${record.installedVersion} → ${record.availableVersion ?? '?'}`,
    });
  }

  // A double declaration is an upstream authoring problem — the marketplace
  // entry was never bumped alongside plugin.json. Nothing the user runs
  // locally fixes it, so offering a command would be offering a placebo.
  for (const record of report.updates) {
    if (record.doubleDeclared === undefined) continue;
    manual.push({
      subject: record.id,
      reason:
        `plugin.json declares ${record.doubleDeclared.effective} and the marketplace entry ` +
        `declares ${record.doubleDeclared.masked}; only the upstream author can reconcile them`,
    });
  }

  for (const record of report.entriesBehind) {
    manual.push({
      subject: record.id,
      reason:
        `the marketplace entry (${record.availableVersion ?? '?'}) is behind what is installed ` +
        `(${record.installedVersion}); updating would move you backwards`,
    });
  }

  return { actions, manual };
}

// ---------------------------------------------------------------------------
// T2.10 — exit codes
// ---------------------------------------------------------------------------

/**
 * Exit codes for `--check`.
 *
 * This is the one place a nonzero exit means *findings*, and it is why
 * `status` and `doctor` deliberately do not: a cron job wants
 * `ccatlas updates --check || notify`, and that idiom needs exactly one
 * command where nonzero is the signal rather than the error.
 *
 * `1` is used rather than a spread of codes per finding type. A script can
 * branch on the JSON; a shell can only usefully branch on zero/nonzero, and
 * inventing codes invites scripts that break when a new finding class lands.
 */
export const CHECK_CLEAN = 0;
export const CHECK_FINDINGS = 1;

export function checkExitCode(report: UpdatesReport): number {
  const actionable = report.stalePins.length + report.upgrades.length;
  return actionable > 0 ? CHECK_FINDINGS : CHECK_CLEAN;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface ExecutedAction {
  readonly action: PlannedAction;
  readonly code: number;
  readonly output: string;
}

export interface ApplyOptions {
  /** Injected in tests. Never set in production. */
  readonly run?: (argv: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
}

const defaultRun = (
  argv: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(
      'claude',
      [...argv],
      { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const raw = error === null ? 0 : (error as { code?: unknown }).code;
        resolve({
          code: typeof raw === 'number' ? raw : error === null ? 0 : 1,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        });
      },
    );
  });

/**
 * Runs the plan in order, **stopping at the first failure**.
 *
 * Sequential and fail-fast, unlike everything else in this codebase, and both
 * on purpose. The actions are ordered because they depend on each other, so
 * running them concurrently would defeat the ordering; and continuing past a
 * failed marketplace refresh would install plugins from a clone that is known
 * to be in an unexpected state.
 */
export async function applyPlan(
  plan: ApplyPlan,
  options: ApplyOptions = {},
): Promise<{ executed: ExecutedAction[]; ok: boolean }> {
  const run = options.run ?? defaultRun;
  const executed: ExecutedAction[] = [];

  for (const action of plan.actions) {
    const outcome = await run(action.argv);
    executed.push({
      action,
      code: outcome.code,
      output: (outcome.stdout + outcome.stderr).trim(),
    });
    if (outcome.code !== 0) return { executed, ok: false };
  }

  return { executed, ok: true };
}

/**
 * The reminder that has to follow any successful apply.
 *
 * Claude Code loads plugins at session start. A plugin updated mid-session is
 * on disk but not in the running session, so a user who checks immediately
 * sees the old behaviour and concludes the update failed.
 */
export const RELOAD_REMINDER =
  'run /reload-plugins in your Claude Code session, or restart it — updated plugins are on ' +
  'disk but the running session still holds the previous copies';
