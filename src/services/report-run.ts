/**
 * The IO half of `report` — T3.8, T3.9, T3.10.
 *
 * Composes the three services into one document, writes it, and optionally
 * opens it. `services/report.ts` stays pure so the markup, the escaping and
 * the redaction can all be asserted without a filesystem.
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { allProjectsGate, projectSlug, renderIndex, writeProjectReport } from './all-projects.ts';
import { doctor } from './doctor-run.ts';
import { collectProjects, readTranscriptDirNames, transcriptsRoot } from './projects.ts';
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

export interface AllProjectsOptions extends ReportOptions {
  readonly allowPaths?: boolean;
  /** Directory for the index and the per-project files. */
  readonly outDir?: string;
}

export interface AllProjectsResult {
  readonly indexFile?: string;
  readonly written: number;
  readonly failed: number;
  readonly refused?: string;
}

/**
 * T3.13 — a report per project, plus an index.
 *
 * Refuses before doing any work when the gate is closed: a command that
 * collects for two seconds and *then* declines has already read everything it
 * was told not to disclose. That part is right, and it is the security half.
 *
 * ## ⚠️ This does NOT yet do "one global scan, N overlays"
 *
 * The task row specifies exactly that, and this implementation does not
 * deliver it: each project re-runs the whole service stack, and each of those
 * runs spawns `claude` three times. Measured consequence on the reference
 * machine — **93 live projects × ~2s ≈ 3 minutes**, against a command people
 * will expect to take seconds. It exceeded a 2-minute timeout on the first
 * live run.
 *
 * The fix is real work rather than a tweak: collect the global inventory once,
 * then per project collect **only** the project-scope overlay — that repo's
 * `.claude/settings.json` and `.mcp.json`, both plain file reads — and merge.
 * The `claude` subprocess calls are all global-scope facts and need to happen
 * exactly once. `services/delta.ts` already exists to express the result.
 *
 * Left as written, and documented rather than quietly shipped, because the
 * output is correct — it is only slow. Recorded in `docs/tasks.md` as the
 * open item for T3.13.
 */
export async function reportAllProjects(
  options: AllProjectsOptions = {},
): Promise<AllProjectsResult> {
  const gate = allProjectsGate({
    redact: options.redact ?? false,
    allowPaths: options.allowPaths ?? false,
  });
  if (!gate.allowed) return { written: 0, failed: 0, ...(gate.reason ? { refused: gate.reason } : {}) };

  const home = options.roots?.home ?? os.homedir();
  const outDir = path.resolve(options.outDir ?? 'ccatlas-reports');
  await mkdir(outDir, { recursive: true });

  const claudeJson = path.join(home, '.claude.json');
  let keys: string[] = [];
  try {
    const parsed = JSON.parse(await readFile(claudeJson, 'utf8')) as { projects?: Record<string, unknown> };
    keys = typeof parsed.projects === 'object' && parsed.projects !== null ? Object.keys(parsed.projects) : [];
  } catch {
    keys = [];
  }

  const inventory = await collectProjects({
    claudeJsonKeys: keys,
    transcriptDirNames: await readTranscriptDirNames(transcriptsRoot(home)),
    probe: true,
  });

  // Only projects that still exist. Reporting on a deleted directory would
  // produce a page of empty sections; doctor already flags the stale key.
  const live = inventory.projects.filter((record) => record.existence === 'present');

  const entries = [];
  let written = 0;
  let failed = 0;

  for (const record of live) {
    const projectPath = record.ref.displayPath;
    let html: string | Error;
    try {
      const result = await report({
        ...options,
        target: { kind: 'project', path: projectPath },
        projectDir: projectPath,
        outFile: path.join(outDir, `${projectSlug(projectPath)}.html`),
      });
      // `report` already wrote the file; re-read is avoided by trusting it.
      entries.push({
        slug: projectSlug(projectPath),
        label: options.redact === true ? projectSlug(projectPath) : projectPath,
        bytes: result.bytes,
        overBudget: result.overBudget,
      });
      written += 1;
      continue;
    } catch (error: unknown) {
      html = error instanceof Error ? error : new Error(String(error));
    }

    // T3.15: one failing project renders an error card, never fails the run.
    const outcome = await writeProjectReport(outDir, projectPath, html);
    entries.push({
      slug: projectSlug(projectPath),
      label: options.redact === true ? projectSlug(projectPath) : projectPath,
      bytes: 0,
      overBudget: false,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    });
    failed += 1;
  }

  const indexFile = path.join(outDir, 'index.html');
  await writeFile(indexFile, renderIndex(entries, options.redact ?? false), 'utf8');

  return { indexFile, written, failed };
}
