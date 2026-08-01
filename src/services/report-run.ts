/**
 * The IO half of `report` — T3.8, T3.9, T3.10.
 *
 * Composes the three services into one document, writes it, and optionally
 * opens it. `services/report.ts` stays pure so the markup, the escaping and
 * the redaction can all be asserted without a filesystem.
 */

import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { doctor } from './doctor-run.ts';
import { redactString, redactValue, renderReport } from './report.ts';
import { status } from './status.ts';
import { updates } from './updates-run.ts';
import type { DoctorOptions } from './doctor-run.ts';

/** 📏 T3.9. Asserted after generation, not hoped for. */
export const SIZE_BUDGET_BYTES = 120 * 1024;

export interface ReportOptions extends DoctorOptions {
  readonly outFile?: string;
  readonly redact?: boolean;
  readonly open?: boolean;
  readonly toolVersion?: string;
}

export interface ReportResult {
  readonly file: string;
  readonly bytes: number;
  /** True when the output exceeded the 120KB budget. */
  readonly overBudget: boolean;
  readonly redacted: boolean;
}

/**
 * Opens a file with the platform's handler.
 *
 * Three different commands, and no shell in any of them: passing a path
 * through `cmd /c start` re-parses it, and a path containing `&` becomes two
 * commands. `detached` + `unref` so ccatlas exits rather than waiting for the
 * browser to close.
 */
export async function openFile(file: string): Promise<void> {
  const platform = process.platform;
  const [command, args] =
    platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', file]]
      : platform === 'darwin'
        ? ['open', [file]]
        : ['xdg-open', [file]];

  await new Promise<void>((resolve) => {
    const child = execFile(command, args, { windowsHide: true }, () => resolve());
    child.unref();
    // Never block on the opener: a machine with no handler registered would
    // otherwise hang the command that just succeeded.
    setTimeout(resolve, 1500).unref();
  });
}

export async function report(options: ReportOptions = {}): Promise<ReportResult> {
  const redact = options.redact ?? false;
  const hostname = redact ? os.hostname() : '';

  // All three services, concurrently. Each already isolates its own failures,
  // so a broken section degrades one part of the document rather than the run.
  const [statusResult, doctorResult, updatesResult] = await Promise.all([
    status(options),
    doctor({ ...options, projectDir: options.projectDir ?? process.cwd() }),
    updates(options),
  ]);

  const scope =
    statusResult.target.kind === 'project'
      ? `project ${redact ? redactString(statusResult.target.path, hostname) : statusResult.target.path}`
      : 'global';

  const html = renderReport({
    // Redaction runs over the whole payload, once, at the boundary — not per
    // renderer. A per-section pass is one forgotten call away from a leak, and
    // the leak is exactly the thing this flag exists to prevent.
    inventory: redact ? redactValue(statusResult.inventory, hostname) : statusResult.inventory,
    doctor: redact ? redactValue(doctorResult.report, hostname) : doctorResult.report,
    updates: redact ? redactValue(updatesResult.report, hostname) : updatesResult.report,
    generatedAt: new Date().toISOString(),
    toolVersion: options.toolVersion ?? 'unknown',
    redact,
    scope,
  });

  const file = path.resolve(options.outFile ?? 'ccatlas-report.html');
  await writeFile(file, html, 'utf8');

  const bytes = Buffer.byteLength(html, 'utf8');
  if (options.open === true) await openFile(file);

  return { file, bytes, overBudget: bytes > SIZE_BUDGET_BYTES, redacted: redact };
}
