/**
 * Inventory cache — T1.10, and the mechanism the `status --cached` <200ms
 * floor in T1.11 depends on.
 *
 * ## Where it lives
 *
 * `${CLAUDE_PLUGIN_DATA}/cache/` when running as a plugin, which resolves to
 * `~/.claude/plugins/data/ccatlas-deutrix/` and **survives plugin updates**.
 * Standalone npm installs use `~/.ccatlas/` with the identical layout.
 *
 * `${CLAUDE_PLUGIN_ROOT}` is never written to: it changes on every update, so
 * a cache there is silently discarded exactly when the user updates and then
 * wonders why the tool got slow. That is one env var away from being a bug
 * nobody can reproduce, so the two are kept textually distinct here and the
 * root is not read at all.
 *
 * ## Invalidation, two mechanisms, on purpose
 *
 * 1. **A dirty flag** — a file the `ConfigChange` hook (T7.9) touches. Cheap:
 *    one stat. But it only fires when Claude Code is running, so it cannot be
 *    the only mechanism.
 * 2. **An input fingerprint** — size and mtime of the files the answer was
 *    derived from. Catches an edit made with an editor, by a script, or on
 *    another machine via `sync pull`.
 *
 * Either one alone produces stale answers in a case the user will hit. A
 * fingerprint mismatch is the authority; the flag is the fast path.
 *
 * ## The failure posture
 *
 * Every read miss is a **value**, never a throw, and every write failure is
 * swallowed after being reported. A cache that can fail the run is worse than
 * no cache: the whole point is that `status` still works on a machine in a bad
 * state, and a read-only `$HOME` is one of those states.
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { SCHEMA_VERSION } from '../types.ts';
import type { Warning } from '../types.ts';

/** Written into every entry; a mismatch is a miss, never a parse attempt. */
export const CACHE_FORMAT_VERSION = 1;

/** Touched by the `ConfigChange` hook. Presence alone invalidates everything. */
export const DIRTY_FLAG = '.dirty';

export interface CacheEntry<T> {
  readonly cacheFormatVersion: number;
  /** The payload's own schema version, so the two can move independently. */
  readonly schemaVersion: number;
  readonly writtenAt: string;
  /** ccatlas version that wrote it. A different build may compute differently. */
  readonly toolVersion: string;
  /**
   * The files this answer was derived from, **recorded by the run that
   * produced it** rather than supplied by the reader.
   *
   * A caller that had to hand the reader a path list would be maintaining that
   * list separately from the collectors that actually do the reading, and the
   * two would drift the moment a collector learned to read something new —
   * producing a cache that validates against a stale set of inputs and serves
   * stale answers silently, which is the exact failure `fingerprintInputs`
   * exists to prevent. Recording it here makes the list self-healing: a new
   * input is picked up on the next cold write.
   *
   * The list includes files that were **absent** at write time. That is not an
   * oversight — creating a project `settings.json` that did not exist must
   * invalidate, and it only can if the absence was fingerprinted.
   */
  readonly inputs: string[];
  readonly fingerprint: string;
  readonly value: T;
}

export type CacheMiss =
  | { readonly hit: false; readonly reason: 'absent' }
  | { readonly hit: false; readonly reason: 'dirty' }
  | { readonly hit: false; readonly reason: 'stale-inputs' }
  | { readonly hit: false; readonly reason: 'format-changed' }
  | { readonly hit: false; readonly reason: 'unreadable'; readonly detail: string };

export type CacheRead<T> =
  | { readonly hit: true; readonly value: T; readonly writtenAt: string; readonly fingerprint: string }
  | CacheMiss;

export interface CacheOptions {
  /** Overrides the state directory. Set in tests; never in production. */
  readonly stateDir?: string;
  readonly toolVersion?: string;
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

/**
 * Resolves the state directory. Plugin data dir if Claude Code set one,
 * otherwise the standalone layout. Deliberately does not fall back to
 * `${CLAUDE_PLUGIN_ROOT}` under any circumstance.
 */
export function resolveStateDir(override?: string): string {
  if (override !== undefined) return override;

  const pluginData = process.env['CLAUDE_PLUGIN_DATA'];
  if (pluginData !== undefined && pluginData.trim() !== '') return pluginData;

  return path.join(os.homedir(), '.ccatlas');
}

export const cacheDir = (stateDir: string): string => path.join(stateDir, 'cache');

const entryPath = (stateDir: string, name: string): string =>
  path.join(cacheDir(stateDir), `${name}.json`);

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

/**
 * A cheap, order-stable fingerprint of the inputs an answer was derived from.
 *
 * Size and mtime, not content: hashing `~/.claude.json` (~193KB) plus every
 * settings layer on every run would eat a meaningful slice of the 200ms
 * budget, and the failure mode this guards against — an edit — moves both.
 * A file edited within the same mtime tick and back to the same size defeats
 * it; that is a knowingly accepted gap, not an oversight.
 *
 * Absent files are fingerprinted as `-` rather than skipped, so that *creating*
 * a settings file invalidates the cache too.
 */
export async function fingerprintInputs(paths: readonly string[]): Promise<string> {
  const parts = await Promise.all(
    [...paths].sort().map(async (target) => {
      try {
        const info = await stat(target);
        return `${target}:${info.size}:${Math.floor(info.mtimeMs)}`;
      } catch {
        return `${target}:-`;
      }
    }),
  );
  return parts.join('|');
}

// ---------------------------------------------------------------------------
// Dirty flag
// ---------------------------------------------------------------------------

export async function isDirty(stateDir: string): Promise<boolean> {
  try {
    await stat(path.join(cacheDir(stateDir), DIRTY_FLAG));
    return true;
  } catch {
    return false;
  }
}

/**
 * Marks the cache dirty. The one write the hook path performs, and it must
 * stay this cheap: T7.10 caps hooks at 150ms with no network.
 */
export async function markDirty(stateDir: string): Promise<void> {
  try {
    await mkdir(cacheDir(stateDir), { recursive: true });
    await writeFile(path.join(cacheDir(stateDir), DIRTY_FLAG), '', 'utf8');
  } catch {
    // A cache that cannot be invalidated is a correctness problem, but
    // throwing here would take down the session-start hook. The fingerprint
    // is the backstop precisely so this path can fail quietly.
  }
}

async function clearDirty(stateDir: string): Promise<void> {
  try {
    await rm(path.join(cacheDir(stateDir), DIRTY_FLAG), { force: true });
  } catch {
    // Next read re-reports dirty and recomputes. Wasteful, never wrong.
  }
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

/**
 * Reads an entry and validates it. Never throws.
 *
 * **The caller supplies no fingerprint.** The entry names the files it was
 * derived from, and this re-fingerprints those — so a reader cannot validate
 * against a path list that has drifted from what the collectors read. The
 * check is self-healing rather than merely enforced.
 *
 * The order of checks is the cost order: the dirty flag is one stat, the entry
 * is one read, and the fingerprint is N stats — so the expensive check runs
 * last and only when the cheap ones passed.
 */
export async function readCache<T>(
  name: string,
  options: CacheOptions = {},
): Promise<CacheRead<T>> {
  const stateDir = resolveStateDir(options.stateDir);

  if (await isDirty(stateDir)) return { hit: false, reason: 'dirty' };

  let text: string;
  try {
    text = await readFile(entryPath(stateDir, name), 'utf8');
  } catch (error: unknown) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT') return { hit: false, reason: 'absent' };
    return {
      hit: false,
      reason: 'unreadable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // A truncated entry — an interrupted write, a full disk. Treated as a
    // miss so the run self-heals on the next write.
    return { hit: false, reason: 'unreadable', detail: 'cache entry is not valid JSON' };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { hit: false, reason: 'format-changed' };
  }

  const entry = parsed as Partial<CacheEntry<T>>;
  if (
    entry.cacheFormatVersion !== CACHE_FORMAT_VERSION ||
    entry.schemaVersion !== SCHEMA_VERSION ||
    typeof entry.writtenAt !== 'string' ||
    !Array.isArray(entry.inputs) ||
    typeof entry.fingerprint !== 'string'
  ) {
    return { hit: false, reason: 'format-changed' };
  }

  // An entry recording NO inputs could never be invalidated by an edit, so it
  // is treated as unusable rather than as trivially fresh. A caller that
  // genuinely has no file inputs has nothing to cache.
  if (entry.inputs.length === 0) return { hit: false, reason: 'stale-inputs' };

  const current = await fingerprintInputs(entry.inputs);
  if (entry.fingerprint !== current) return { hit: false, reason: 'stale-inputs' };

  return {
    hit: true,
    value: entry.value as T,
    writtenAt: entry.writtenAt,
    fingerprint: entry.fingerprint,
  };
}

/**
 * Writes an entry and clears the dirty flag. Returns a warning on failure
 * rather than throwing: a machine with a read-only `$HOME` should get a
 * correct, uncached answer plus an explanation — not a crash.
 */
export async function writeCache<T>(
  name: string,
  inputs: readonly string[],
  value: T,
  options: CacheOptions = {},
): Promise<Warning[]> {
  const stateDir = resolveStateDir(options.stateDir);
  const recorded = [...inputs];
  const entry: CacheEntry<T> = {
    cacheFormatVersion: CACHE_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    writtenAt: new Date().toISOString(),
    toolVersion: options.toolVersion ?? 'unknown',
    inputs: recorded,
    // Computed here, from the same list that is stored, so the two cannot
    // disagree. A caller passing a fingerprint alongside a path list could.
    fingerprint: await fingerprintInputs(recorded),
    value,
  };

  const target = entryPath(stateDir, name);
  // Written to a sibling and renamed so a concurrent reader never sees a
  // half-written entry. The temp name carries the pid because two ccatlas
  // runs in one repo is an ordinary thing, not a race worth locking against.
  const temp = `${target}.${process.pid}.tmp`;

  try {
    await mkdir(cacheDir(stateDir), { recursive: true });
    await writeFile(temp, JSON.stringify(entry), 'utf8');
    await rename(temp, target);
    await clearDirty(stateDir);
    return [];
  } catch (error: unknown) {
    try {
      await rm(temp, { force: true });
    } catch {
      // Nothing further to do; a stray temp file is harmless.
    }
    return [
      {
        code: 'partial',
        message:
          `the inventory cache could not be written to ${cacheDir(stateDir)}: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          'Answers stay correct; every run pays the cold cost.',
        subject: name,
      },
    ];
  }
}

/** Drops every entry. Backs `--rebuild` (T4.16) and doctor's repair path. */
export async function clearCache(options: CacheOptions = {}): Promise<void> {
  const stateDir = resolveStateDir(options.stateDir);
  try {
    await rm(cacheDir(stateDir), { recursive: true, force: true });
  } catch {
    // Best effort: the next read fails its format or fingerprint check anyway.
  }
}
