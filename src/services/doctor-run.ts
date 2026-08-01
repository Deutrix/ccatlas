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

import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { enumerateCacheVersions } from '../collectors/registry.ts';
import { buildDoctorReport } from './doctor.ts';
import { collectProjects, readTranscriptDirNames, transcriptsRoot } from './projects.ts';
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

type ReadResult =
  | { status: 'read'; contents: unknown }
  | { status: 'absent' }
  | { status: 'unreadable'; reason: string };

/**
 * Reads and parses, distinguishing **absent** from **unreadable**.
 *
 * A file that is not there is nothing to scan. A file that is there and will
 * not parse is a check that did not run, and collapsing the two would let a
 * corrupt `~/.claude.json` quietly reduce the scan by one file while the
 * report still says clean. A doctor that fails because an input is malformed
 * cannot examine the machines most in need of it — so neither case throws.
 */
const readJson = async (file: string): Promise<ReadResult> => {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error: unknown) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT') return { status: 'absent' };
    return { status: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }

  try {
    return { status: 'read', contents: JSON.parse(text) as unknown };
  } catch (error: unknown) {
    return { status: 'unreadable', reason: error instanceof Error ? error.message : 'invalid JSON' };
  }
};

/**
 * Walks up from `start` to the nearest directory containing `.git`.
 *
 * **Not optional.** `.mcp.json` and `.claude/settings.json` live at the *repo
 * root*, and `doctor` is run from wherever the user happens to be. Trusting
 * `cwd` means that running it from `src/` finds neither — and the
 * committed-credential check is the `critical`-severity half of T1.16, so it
 * would be silently unreachable in ordinary use while still reporting a clean
 * bill of health.
 *
 * Falls back to `start` when there is no repository above it, which is the
 * right answer for a bare directory: scan what is here and mark nothing
 * committed.
 */
async function findRepoRoot(start: string): Promise<{ root: string; isRepo: boolean }> {
  let current = path.resolve(start);

  for (;;) {
    if (await exists(path.join(current, '.git'))) return { root: current, isRepo: true };
    const parent = path.dirname(current);
    // `dirname` of a root returns the root, which is the only termination
    // signal available and works for `/`, `C:\` and a UNC share alike.
    if (parent === current) return { root: path.resolve(start), isRepo: false };
    current = parent;
  }
}

/**
 * Is this path tracked by git?
 *
 * Asked rather than assumed. An untracked or gitignored `.mcp.json` is not a
 * committed credential: marking it `critical` and handing the user a
 * `git rm --cached` that will fail is worse than the `warning` it deserves.
 * Shelling out to `git` is the project's declared approach — there is no JS
 * git implementation here by design.
 */
async function isTracked(root: string, file: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', root, 'ls-files', '--error-unmatch', file],
      { windowsHide: true, timeout: 5_000 },
      (error) => resolve(error === null),
    );
  });
}

/**
 * The files worth scanning for credentials.
 *
 * `~/.claude.json` and `~/.claude/settings*.json` are always candidates. Repo
 * files are resolved from the **repo root**, not from cwd, and `committed` is
 * checked against git rather than assumed — the severity difference is not
 * cosmetic, since a tracked credential stays in history after the fix.
 *
 * Deliberately **not** scanned: `.credentials.json`, which is where Claude
 * Code is *supposed* to keep credentials. Reporting it would be reporting the
 * product working correctly.
 */
async function secretTargets(
  home: string,
  projectDir: string | undefined,
  skipped: Array<{ check: string; reason: string }>,
): Promise<SecretScanTarget[]> {
  const candidates: Array<{ file: string; scope?: string; repoRoot?: string }> = [
    { file: path.join(home, '.claude.json'), scope: 'user' },
    { file: path.join(home, '.claude', 'settings.json'), scope: 'user' },
    { file: path.join(home, '.claude', 'settings.local.json'), scope: 'local' },
  ];

  if (projectDir !== undefined) {
    const { root, isRepo } = await findRepoRoot(projectDir);
    const repoRoot = isRepo ? root : undefined;

    candidates.push(
      { file: path.join(root, '.mcp.json'), scope: 'project', ...(repoRoot ? { repoRoot } : {}) },
      {
        file: path.join(root, '.claude', 'settings.json'),
        scope: 'project',
        ...(repoRoot ? { repoRoot } : {}),
      },
      { file: path.join(root, '.claude', 'settings.local.json'), scope: 'local' },
    );
  }

  const targets: SecretScanTarget[] = [];
  for (const candidate of candidates) {
    const read = await readJson(candidate.file);

    if (read.status === 'unreadable') {
      // "Not checked" and "checked and clean" must not read alike — a corrupt
      // `~/.claude.json` silently covering one file fewer is the failure the
      // `skipped` list exists for.
      skipped.push({
        check: `secret scan of ${candidate.file}`,
        reason: `the file exists but could not be parsed: ${read.reason}`,
      });
      continue;
    }
    if (read.status === 'absent') continue;

    // Checked, not assumed. An untracked or gitignored file is not a
    // committed credential, and telling the user to `git rm --cached`
    // something git does not know about wastes the one action they take.
    const committed =
      candidate.repoRoot !== undefined && (await isTracked(candidate.repoRoot, candidate.file));

    targets.push({
      file: candidate.file,
      contents: read.contents,
      ...(committed ? { committed } : {}),
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

  const skipped: Array<{ check: string; reason: string }> = [];

  const [targets, cacheDirs, existingPaths, projects] = await Promise.all([
    secretTargets(home, options.projectDir, skipped),
    enumerateCacheVersions(path.join(home, '.claude', 'plugins', 'cache')) as Promise<
      CacheVersionDir[]
    >,
    resolveExistingPaths(inventory.plugins.map((plugin) => plugin.installPath)),
    collectKnownProjects(home),
  ]);

  return {
    report: buildDoctorReport({
      inventory,
      secretTargets: targets,
      cacheDirs,
      existingPaths,
      projectRecords: projects.records,
      skipped: [...skipped, ...projects.skipped],
    }),
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

/**
 * Enumerates known projects for T1.27's orphan check.
 *
 * A failure here degrades one check rather than the run:  is
 * ~193KB of undocumented state, and a machine whose copy will not parse is
 * exactly the machine someone is running  on.
 */
async function collectKnownProjects(home: string): Promise<{
  records: Array<{ displayPath: string; existence: 'present' | 'gone' | 'unreachable'; collides: boolean }>;
  skipped: Array<{ check: string; reason: string }>;
}> {
  const read = await readJson(path.join(home, '.claude.json'));
  if (read.status !== 'read') {
    return {
      records: [],
      skipped:
        read.status === 'unreadable'
          ? [
              {
                check: 'orphaned projects (T1.27)',
                reason: `~/.claude.json could not be parsed: ${read.reason}`,
              },
            ]
          : [],
    };
  }

  const projects = (read.contents as { projects?: Record<string, unknown> }).projects;
  const claudeJsonKeys = typeof projects === 'object' && projects !== null ? Object.keys(projects) : [];
  const transcriptDirNames = await readTranscriptDirNames(transcriptsRoot(home));

  const inventory = await collectProjects({ claudeJsonKeys, transcriptDirNames, probe: true });

  return {
    records: inventory.projects.map((record) => ({
      displayPath: record.ref.displayPath,
      existence: record.existence,
      collides: record.ref.collides,
    })),
    skipped: [],
  };
}
