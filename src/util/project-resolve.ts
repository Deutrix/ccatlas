/**
 * Link-aware project identity — the second half of T1.28, and defect D2.
 *
 * ## Why this is a separate module
 *
 * `normaliseProjectPath` is a **pure string function** and must stay one: it
 * runs over 102 keys on every collection, it is called from a collector, and
 * collectors are contractually pure. But junctions and symlinks are precisely
 * the case where two *different* strings name the *same* directory — and no
 * amount of string rewriting can decide that. It needs `realpath`, which is
 * IO. Putting the syscall inside the normaliser would make every caller
 * async and give a pure function a filesystem dependency; so the resolution
 * lives here, one layer up, and callers opt in.
 *
 * ## Two distinct collision classes
 *
 * The string normaliser catches keys that are *spelled* alike — case variants,
 * `\` vs `/`, trailing separators. It cannot catch the other class:
 *
 * ```
 * C:\Users\me\work\proj          <- the real directory
 * C:\dev\proj                    <- a junction pointing at it
 * ```
 *
 * These normalise to two different keys, so the string layer reports no
 * collision at all — yet Claude Code, invoked from each, writes two project
 * entries for one directory. That is the *more* dangerous class, because
 * nothing else in the system will ever notice it.
 *
 * ## Still reported, never merged
 *
 * Rule 1 of `project-path.ts` holds here unchanged. A link alias is surfaced
 * as a `path-collision` with both spellings named. Merging would pick one
 * entry's state and discard the other's, which is the failure this whole
 * subsystem exists to prevent — and it stays wrong even when the two paths
 * provably name one directory, because the two *entries* still hold different
 * configuration.
 */

import { realpath as realpathCallback } from 'node:fs';
import { realpath } from 'node:fs/promises';

import { normaliseProjectPath } from './project-path.ts';
import type { ProjectRef, Warning } from '../types.ts';

/**
 * A `ProjectRef` after the filesystem has been consulted.
 *
 * `realKey` is absent when the path could not be resolved, which is an
 * ordinary state: `~/.claude.json` accumulates keys for directories that were
 * since deleted, moved, or live on a drive that is not mounted right now.
 * An unresolvable ref is **not** an error and **not** an alias of anything —
 * it simply keeps its string identity.
 */
export interface ResolvedProjectRef extends ProjectRef {
  readonly realKey?: string;
  /**
   * `resolved` — realpath succeeded. `unresolvable` — it did not, so this ref
   * can only ever be compared as a string. Recorded rather than inferred from
   * `realKey === undefined` so a surface can say *why* a project shows no
   * alias information.
   */
  readonly resolution: 'resolved' | 'unresolvable';
  /**
   * Other refs' keys that resolve to the same real directory through a
   * different spelling. Non-empty means a junction, a symlink, a `subst`
   * drive, or a bind mount.
   */
  readonly linkedTo: string[];
}

/**
 * Resolves one path to its real location, normalised.
 *
 * Returns `undefined` rather than throwing on every failure mode — missing
 * directory, permission denied, unmounted drive, a loop. `realpath` resolves
 * the *whole* chain, so a junction inside a junction lands on the final target
 * in one call and cannot be walked into an infinite one.
 *
 * It also expands **8.3 short names** on Windows, which is a *sixth* alias
 * class alongside case, separators, trailing separators, UNC and junctions:
 * `C:\Users\ALEX~1.WOR\…` and `C:\Users\alex.WORKSTN\…` are two spellings of
 * one directory, and the short form is what `os.tmpdir()` itself returns on
 * the reference machine — so this is an everyday path, not an exotic one.
 *
 * Which binding does the expanding is not obvious and was measured rather than
 * assumed. `fs.realpathSync` — the JS implementation — leaves short names
 * untouched; `fs.realpathSync.native` expands them; and **`fsPromises.realpath`
 * expands them too**, because the promise API goes through libuv rather than
 * the JS resolver. `fsPromises.realpath` also has no `.native` property at
 * all, so `await realpath.native(…)` throws a TypeError on every call and
 * degrades silently. The callback binding below is kept only as the fallback
 * for a platform where the promise path does not expand; on Windows and POSIX
 * as measured, the first branch already answers correctly.
 */
const realpathNative = (target: string): Promise<string> =>
  new Promise((resolve, reject) => {
    realpathCallback.native(target, 'utf8', (error, resolved) => {
      if (error) reject(error);
      else resolve(resolved);
    });
  });

export async function resolveRealKey(rawPath: string): Promise<string | undefined> {
  const trimmed = rawPath.trim();
  if (trimmed === '') return undefined;

  try {
    return normaliseProjectPath(await realpath(trimmed));
  } catch {
    // Fall through. A genuinely absent path fails both, and the second call
    // costs nothing next to having reported two spellings as two projects.
  }

  try {
    return normaliseProjectPath(await realpathNative(trimmed));
  } catch {
    return undefined;
  }
}

/**
 * Annotates refs with their real identity and cross-links the aliases.
 *
 * Resolution runs concurrently: on a machine with 102 project keys, serial
 * `realpath` calls against a network share are the difference between a
 * negligible cost and a visible one against T1.11's 2s cold budget.
 *
 * A ref never links to itself, and a ref whose `realKey` equals its own `key`
 * — the overwhelming majority — costs one syscall and adds nothing.
 */
export async function resolveProjectRefs(
  refs: readonly ProjectRef[],
): Promise<{ refs: ResolvedProjectRef[]; warnings: Warning[] }> {
  const realKeys = await Promise.all(refs.map((ref) => resolveRealKey(ref.displayPath)));

  // Index by real identity. Unresolvable refs are deliberately excluded: two
  // paths that both failed to resolve are not thereby the same directory, and
  // bucketing them on `undefined` would invent an alias out of two absences.
  const byReal = new Map<string, number[]>();
  realKeys.forEach((realKey, index) => {
    if (realKey === undefined) return;
    const existing = byReal.get(realKey);
    if (existing) existing.push(index);
    else byReal.set(realKey, [index]);
  });

  const resolved: ResolvedProjectRef[] = refs.map((ref, index) => {
    const realKey = realKeys[index];
    const siblings = realKey === undefined ? [] : (byReal.get(realKey) ?? []);
    const linkedTo = siblings
      .filter((other) => other !== index)
      .map((other) => (refs[other] as ProjectRef).key);

    return {
      ...ref,
      ...(realKey !== undefined ? { realKey } : {}),
      resolution: realKey === undefined ? 'unresolvable' : 'resolved',
      linkedTo,
      // A ref that is a link alias collides even when its spelling is unique:
      // two `~/.claude.json` entries exist for one directory, and each holds
      // its own state.
      collides: ref.collides || linkedTo.length > 0,
    };
  });

  const warnings: Warning[] = [];
  for (const [realKey, indices] of byReal) {
    if (indices.length < 2) continue;

    const group = indices.map((index) => refs[index] as ProjectRef);
    warnings.push({
      code: 'path-collision',
      message:
        `${group.length} project keys resolve to the same directory "${realKey}" through ` +
        'a junction, symlink, or substituted drive, and are NOT merged: ' +
        `${group.map((ref) => `"${ref.displayPath}"`).join(', ')}. ` +
        'They normalise to different strings, so no string-level check catches this. ' +
        'Each entry may hold different state; inspect them individually.',
      subject: realKey,
    });
  }

  return { refs: resolved, warnings };
}

/**
 * Do two spellings name the same directory? The single-pair form.
 *
 * Answers `false` when either side cannot be resolved — an honest "cannot
 * tell" rendered as "not proven the same", which is the safe direction: the
 * caller keeps two entries rather than merging on a guess.
 */
export async function sameRealDirectory(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([resolveRealKey(a), resolveRealKey(b)]);
  return left !== undefined && left === right;
}
