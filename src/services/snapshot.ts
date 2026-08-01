/**
 * Snapshots and rollback — T5.19, T5.25, T5.26 📏.
 *
 * ## No mutation without a snapshot
 *
 * A global rule, not an import-specific one. Every `--apply` path takes one
 * first, because the failure this guards against is not "the apply errored" —
 * that is handled by fail-fast ordering — but "the apply succeeded and the
 * result is wrong", which is only recoverable if the previous state still
 * exists.
 *
 * ## What a snapshot is, and what it deliberately is not
 *
 * It captures the **files ccatlas can restore**: settings, `~/.claude.json`,
 * and the plugin registry. It does **not** copy `plugins/cache/` — that is
 * gigabytes of plugin bodies which `claude plugin install` can reproduce from
 * the registry, and copying it would make snapshots too expensive to take by
 * default. A snapshot that people disable is a snapshot that is not there when
 * it matters.
 *
 * Rollback therefore restores *configuration*, and reinstalls follow from it.
 * T5.26's byte-identical requirement applies to the files captured.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Files a snapshot captures, relative to the home directory. */
export const SNAPSHOT_FILES: readonly string[] = [
  '.claude.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/plugins/installed_plugins.json',
  '.claude/plugins/known_marketplaces.json',
  '.claude/plugins/config.json',
];

export interface SnapshotEntry {
  readonly path: string;
  /** `undefined` means the file did not exist — restoring must DELETE it. */
  readonly content?: string;
  readonly sha256?: string;
}

export interface Snapshot {
  readonly id: string;
  readonly takenAt: string;
  readonly reason: string;
  readonly entries: SnapshotEntry[];
}

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Captures the current state.
 *
 * An **absent** file is recorded as an entry with no content, not omitted.
 * That distinction is what makes rollback exact: if an apply *created*
 * `settings.local.json`, restoring must delete it again, and an omitted entry
 * would leave it in place. Byte-identical (T5.26 📏) means the absence too.
 */
export async function takeSnapshot(
  home: string,
  reason: string,
  now: string,
): Promise<Snapshot> {
  const entries: SnapshotEntry[] = [];

  for (const relative of SNAPSHOT_FILES) {
    const file = path.join(home, ...relative.split('/'));
    try {
      const content = await readFile(file, 'utf8');
      entries.push({ path: relative, content, sha256: digest(content) });
    } catch (error: unknown) {
      const code = (error as { code?: unknown }).code;
      if (code === 'ENOENT') {
        entries.push({ path: relative });
        continue;
      }
      // Unreadable is NOT absent. Recording it as absent would make rollback
      // delete a file it merely failed to read.
      throw new Error(`snapshot could not read ${relative}: ${String(code ?? 'unknown')}`);
    }
  }

  // Sortable and unique without a clock dependency in the id itself.
  const id = `${now.replace(/[:.]/gu, '-')}-${digest(now + reason).slice(0, 8)}`;
  return { id, takenAt: now, reason, entries };
}

const snapshotDir = (stateDir: string): string => path.join(stateDir, 'snapshots');

export async function writeSnapshot(stateDir: string, snapshot: Snapshot): Promise<string> {
  const dir = snapshotDir(stateDir);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${snapshot.id}.json`);
  await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return file;
}

export async function listSnapshots(stateDir: string): Promise<string[]> {
  try {
    return (await readdir(snapshotDir(stateDir)))
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.replace(/\.json$/u, ''))
      .sort();
  } catch {
    return [];
  }
}

export async function readSnapshot(stateDir: string, id: string): Promise<Snapshot | undefined> {
  try {
    return JSON.parse(await readFile(path.join(snapshotDir(stateDir), `${id}.json`), 'utf8')) as Snapshot;
  } catch {
    return undefined;
  }
}

export interface RestoreResult {
  readonly restored: string[];
  readonly deleted: string[];
  readonly failed: Array<{ readonly path: string; readonly reason: string }>;
}

/**
 * 📏 T5.26 — restores a snapshot exactly.
 *
 * Files that existed are rewritten byte for byte; files that did **not** exist
 * are deleted. Both halves are needed: an apply that created a file is only
 * fully undone when that file is gone again.
 *
 * A failure on one file does not abandon the rest. A partial restore is worse
 * than a complete one but far better than stopping halfway and leaving the
 * machine in a third state that matches neither.
 */
export async function restoreSnapshot(home: string, snapshot: Snapshot): Promise<RestoreResult> {
  const restored: string[] = [];
  const deleted: string[] = [];
  const failed: Array<{ path: string; reason: string }> = [];

  for (const entry of snapshot.entries) {
    const file = path.join(home, ...entry.path.split('/'));

    try {
      if (entry.content === undefined) {
        await rm(file, { force: true });
        deleted.push(entry.path);
        continue;
      }

      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, entry.content, 'utf8');
      restored.push(entry.path);
    } catch (error: unknown) {
      failed.push({
        path: entry.path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { restored, deleted, failed };
}

/**
 * Verifies a restore was byte-identical — T5.26's actual assertion.
 *
 * Re-reads from disk and compares digests rather than trusting the write. The
 * gate is *apply → corrupt → rollback → byte-identical*, and only a re-read
 * proves the last step.
 */
export async function verifyRestore(home: string, snapshot: Snapshot): Promise<string[]> {
  const mismatches: string[] = [];

  for (const entry of snapshot.entries) {
    const file = path.join(home, ...entry.path.split('/'));

    let actual: string | undefined;
    try {
      actual = await readFile(file, 'utf8');
    } catch {
      actual = undefined;
    }

    if (entry.content === undefined) {
      if (actual !== undefined) mismatches.push(`${entry.path} should not exist`);
      continue;
    }

    if (actual === undefined) {
      mismatches.push(`${entry.path} is missing`);
      continue;
    }
    if (digest(actual) !== entry.sha256) mismatches.push(`${entry.path} differs`);
  }

  return mismatches;
}
