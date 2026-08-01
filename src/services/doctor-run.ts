/**
 * The IO half of `doctor` — T1.12/T1.15/T1.16 need the filesystem, and
 * `services/doctor.ts` is deliberately pure so every detector can be tested
 * without one.
 *
 * This module does the reading and hands the results across. It is the only
 * place in the doctor path that touches disk, which keeps the split honest:
 * a detector that quietly grew an `fs` import would stop being testable
 * against constructed inputs, and constructed inputs are how the negative
 * cases are written.
 */

import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { enumerateCacheVersions } from '../collectors/registry.ts';
import { buildDoctorReport } from './doctor.ts';
import { status } from './status.ts';
import type { CacheVersionDir, DoctorReport, SecretScanTarget } from './doctor.ts';
import type { StatusOptions } from './status.ts';

export interface DoctorRunResult {
  readonly report: DoctorReport;
  /** The inventory the findings were derived from, for the renderer's header. */
  readonly elapsedMs: number;
  readonly degraded: string[];
}

const exists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

const readJson = async (file: string): Promise<unknown | undefined> => {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    // Absent or corrupt. Either way there is nothing to scan, and a doctor
    // that fails because one of its inputs is malformed is a doctor that
    // cannot examine the machines most in need of it.
    return undefined;
  }
};

/**
 * The files worth scanning for credentials.
 *
 * `~/.claude.json` and `~/.claude/settings*.json` are always candidates. A
 * repo's `.mcp.json` is scanned when a project directory is given, and is
 * marked `committed` — the severity difference is not cosmetic, since a
 * tracked credential stays in history after the fix.
 *
 * Deliberately **not** scanned: `.credentials.json`, which is where Claude
 * Code is *supposed* to keep credentials. Reporting it would be reporting the
 * product working correctly.
 */
async function secretTargets(
  home: string,
  projectDir: string | undefined,
): Promise<SecretScanTarget[]> {
  const candidates: Array<{ file: string; committed?: boolean; scope?: string }> = [
    { file: path.join(home, '.claude.json'), scope: 'user' },
    { file: path.join(home, '.claude', 'settings.json'), scope: 'user' },
    { file: path.join(home, '.claude', 'settings.local.json'), scope: 'local' },
  ];

  if (projectDir !== undefined) {
    candidates.push(
      { file: path.join(projectDir, '.mcp.json'), committed: true, scope: 'project' },
      { file: path.join(projectDir, '.claude', 'settings.json'), committed: true, scope: 'project' },
      { file: path.join(projectDir, '.claude', 'settings.local.json'), scope: 'local' },
    );
  }

  const targets: SecretScanTarget[] = [];
  for (const candidate of candidates) {
    const contents = await readJson(candidate.file);
    if (contents === undefined) continue;
    targets.push({
      file: candidate.file,
      contents,
      ...(candidate.committed !== undefined ? { committed: candidate.committed } : {}),
      ...(candidate.scope !== undefined ? { scope: candidate.scope } : {}),
    });
  }

  return targets;
}

export interface DoctorOptions extends StatusOptions {
  /** Repo root, for `.mcp.json` and project-scope settings. */
  readonly projectDir?: string;
}

export async function doctor(options: DoctorOptions = {}): Promise<DoctorRunResult> {
  const home = options.roots?.home ?? os.homedir();

  // Doctor is built on `status`, not beside it. Two paths to the same
  // inventory would drift, and the findings promoted from T1.7/T1.8/T1.9 must
  // be the same ones `status` reports or the two commands would disagree
  // about the machine in front of them.
  const { inventory } = await status(options);

  const [targets, cacheDirs, existingPaths] = await Promise.all([
    secretTargets(home, options.projectDir),
    enumerateCacheVersions(path.join(home, '.claude', 'plugins', 'cache')) as Promise<
      CacheVersionDir[]
    >,
    resolveExistingPaths(inventory.plugins.map((plugin) => plugin.installPath)),
  ]);

  return {
    report: buildDoctorReport({ inventory, secretTargets: targets, cacheDirs, existingPaths }),
    elapsedMs: inventory.elapsedMs,
    degraded: inventory.degraded,
  };
}

/** Which of the given paths are actually on disk. Concurrent; never throws. */
async function resolveExistingPaths(
  paths: ReadonlyArray<string | undefined>,
): Promise<Set<string>> {
  const defined = [...new Set(paths.filter((p): p is string => p !== undefined))];
  const results = await Promise.all(defined.map(async (p) => [p, await exists(p)] as const));
  return new Set(results.filter(([, present]) => present).map(([p]) => p));
}
