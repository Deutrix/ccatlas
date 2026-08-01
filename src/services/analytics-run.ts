/**
 * The IO half of `usage` — the transcript scan and the cost enrichment.
 *
 * `services/analytics.ts` is pure; this feeds it. The split matters more here
 * than elsewhere because the input is an undocumented format and the pure half
 * has to be testable against constructed records rather than against whatever
 * happens to be on the machine.
 */

import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { parsePluginDetails } from '../collectors/details.ts';
import { enumerateTranscripts, scanTranscript } from '../collectors/transcripts.ts';
import { buildUsageReport } from './analytics.ts';
import { status } from './status.ts';
import type { Signal } from '../collectors/transcripts.ts';
import type { UsageResult } from './analytics.ts';
import type { StatusOptions } from './status.ts';

export interface UsageOptions extends StatusOptions {
  readonly since?: string;
  readonly until?: string;
  /** Skip the per-plugin `claude plugin details` calls. */
  readonly skipCosts?: boolean;
}

export interface UsageRunResult {
  readonly report: UsageResult;
  readonly elapsedMs: number;
}

/**
 * Reads always-on cost per plugin.
 *
 * One `claude plugin details` per plugin, run with a small concurrency cap.
 * This is the expensive part of `usage` — each call is a process spawn, and
 * spawn is already the entire wall clock of `status` — so it is skippable and
 * a failure degrades one plugin's row rather than the report.
 */
async function readCosts(
  names: readonly string[],
  offline: boolean,
): Promise<{ costs: Map<string, number>; failed: string[] }> {
  const costs = new Map<string, number>();
  const failed: string[] = [];
  const queue = [...names];

  const run = (name: string): Promise<{ code: number; stdout: string }> =>
    new Promise((resolve) => {
      execFile(
        'claude',
        ['plugin', 'details', name],
        {
          encoding: 'utf8',
          windowsHide: true,
          shell: process.platform === 'win32',
          timeout: 30_000,
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, stdout) => {
          const raw = error === null ? 0 : (error as { code?: unknown }).code;
          resolve({ code: typeof raw === 'number' ? raw : error === null ? 0 : 1, stdout: stdout ?? '' });
        },
      );
    });

  const worker = async (): Promise<void> => {
    for (;;) {
      const name = queue.shift();
      if (name === undefined) return;

      const outcome = await run(name);
      // Trap 7: the exit code is the ONLY success signal. `plugin details
      // <missing>` writes its error to stdout with an empty stderr.
      if (outcome.code !== 0) {
        failed.push(name);
        continue;
      }

      const parsed = parsePluginDetails(name, outcome.stdout);
      if (parsed.warnings.some((w) => w.includes('not a `plugin details` document'))) {
        failed.push(name);
        continue;
      }
      costs.set(name, parsed.cost.alwaysOn);
    }
  };

  // Four at a time. `plugin details` reaches the token estimator, so a wide
  // fan-out is both a process storm and a burst of estimator calls.
  await Promise.all(Array.from({ length: Math.min(4, Math.max(1, names.length)) }, worker));
  if (offline) return { costs: new Map(), failed: [...names] };
  return { costs, failed };
}

export async function usage(options: UsageOptions = {}): Promise<UsageRunResult> {
  const started = performance.now();
  const home = options.roots?.home ?? os.homedir();

  const { inventory } = await status(options);

  const knownPlugins = new Set(
    inventory.plugins.map((plugin) => plugin.id.name.split('@')[0] ?? plugin.id.name),
  );

  const files = await enumerateTranscripts(path.join(home, '.claude', 'projects'));
  const signals: Signal[] = [];
  let accepted = 0;
  let rejected = 0;

  // Sequential. Each file is streamed line by line and the set is ~300k lines;
  // reading many concurrently trades a bounded memory profile for a wide one
  // with no wall-clock gain, since this is IO on one disk.
  for (const file of files) {
    const scan = await scanTranscript(file, knownPlugins);
    if (scan.probe.available) {
      accepted += 1;
      signals.push(...scan.signals);
    } else {
      rejected += 1;
    }
  }

  const { costs } = options.skipCosts === true
    ? { costs: new Map<string, number>() }
    : await readCosts(inventory.plugins.filter((p) => p.enabled).map((p) => p.id.name), options.offline ?? false);

  const project =
    options.target?.kind === 'project'
      ? options.target.path.replace(/\\/gu, '/').toLowerCase().replace(/\/+$/u, '')
      : undefined;

  return {
    report: buildUsageReport({
      inventory,
      signals,
      scanned: { accepted, rejected },
      costs,
      ...(options.since !== undefined ? { since: options.since } : {}),
      ...(options.until !== undefined ? { until: options.until } : {}),
      ...(project !== undefined ? { project } : {}),
    }),
    elapsedMs: Math.round(performance.now() - started),
  };
}
