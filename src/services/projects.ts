/**
 * The `projects` module — T1.25, and the input T1.24/T1.26/T1.27 all key off.
 *
 * ## Two enumeration sources, and they are not symmetric
 *
 * ```
 * ~/.claude.json → projects   Record<absolutePath, …>   102 keys, real paths
 * ~/.claude/projects/<dir>/   the ENCODED form           35 dirs, lossy
 * ```
 *
 * The first holds genuine absolute paths. The second holds names produced by
 * folding `\`, `/`, `:` **and `.`** onto `-`, which is many-to-one and has no
 * inverse — `C:\lod-expo` and `C:\lod.expo` produce the same directory name.
 * `project-path.ts` refuses to decode them on principle, and this module keeps
 * that refusal.
 *
 * So a directory is only ever matched **forward**: encode each known key and
 * see which directory name it produces. A directory that no key explains is
 * emitted as an `unresolved` entry rather than being dropped or guessed at —
 * with 35 directories against 102 keys, most keys have no transcripts and some
 * directories may have no key, and silently discarding either would make the
 * count wrong in a way nobody could audit.
 *
 * ## Three separate questions, deliberately not merged
 *
 * 1. **Do two keys spell the same path?** — the string normaliser.
 * 2. **Do two keys reach the same directory?** — `resolveProjectRefs`,
 *    covering junctions, symlinks, `subst` drives and 8.3 short names.
 * 3. **Is the directory still there?** — `probeExistence`, which separates
 *    *gone* from *unreachable*. An unmounted drive is not a deleted project,
 *    and T1.27's orphan finding turns entirely on that distinction.
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  collisionWarnings,
  groupProjectKeys,
  isCandidateProjectDir,
} from '../util/project-path.ts';
import { probeExistence, resolveProjectRefs, resolveRealKey } from '../util/project-resolve.ts';
import type { Existence, ResolvedProjectRef } from '../util/project-resolve.ts';
import type { ProjectRef, Warning } from '../types.ts';

/** Where a project was learned from. Both is the healthy case. */
export type ProjectSource = 'claude-json' | 'transcripts';

export interface ProjectRecord {
  readonly ref: ResolvedProjectRef;
  readonly sources: ProjectSource[];
  /** Transcript directory names this project's path encodes to, if present. */
  readonly transcriptDirs: string[];
  readonly existence: Existence;
}

/**
 * A transcript directory no known key explains.
 *
 * It is **not** given a `ProjectRef`: the only honest path for it comes from
 * the `cwd` field on a record inside the file, and reading transcripts is
 * T4.1's quarantined job, not this module's. Emitting a guessed path here
 * would put an unreliable string into the identity layer everything else keys
 * on.
 */
export interface UnresolvedTranscriptDir {
  readonly dirName: string;
  readonly reason: string;
}

export interface ProjectsInventory {
  readonly projects: ProjectRecord[];
  readonly unresolved: UnresolvedTranscriptDir[];
  readonly warnings: Warning[];
}

export interface ProjectsOptions {
  /** Project keys from `~/.claude.json`. The authoritative source. */
  readonly claudeJsonKeys?: readonly string[];
  /** Directory names under `~/.claude/projects/`. Encoded, lossy. */
  readonly transcriptDirNames?: readonly string[];
  /** Off for pure tests; on in production. */
  readonly probe?: boolean;
}

/** Reads the transcript directory names. Absent is normal, not an error. */
export async function readTranscriptDirNames(projectsRoot: string): Promise<string[]> {
  try {
    return (await readdir(projectsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Builds the project inventory.
 *
 * Pure when `probe` is false, which is how the matching logic is tested
 * without a filesystem; the probe is the only IO and runs concurrently across
 * all keys, because 102 serial `stat` calls against a network share is the
 * difference between negligible and visible against T1.11's budget.
 */
export async function collectProjects(options: ProjectsOptions = {}): Promise<ProjectsInventory> {
  const keys = options.claudeJsonKeys ?? [];
  const dirNames = options.transcriptDirNames ?? [];

  // Grouping first: the 10 colliding keys on the reference machine collapse to
  // one ref each here, keeping every raw spelling.
  const grouped = groupProjectKeys(keys);
  const warnings: Warning[] = [...collisionWarnings(grouped)];

  const { refs, warnings: linkWarnings } = options.probe === true
    ? await resolveProjectRefs(grouped)
    : { refs: grouped.map(asUnprobed), warnings: [] as Warning[] };
  warnings.push(...linkWarnings);

  const claimed = new Set<string>();

  // Forward-encoded matching only. Every raw spelling is tried, because two
  // keys that collided into one ref can encode to two different directory
  // names — the encoding folds separators, and the raw keys differ in exactly
  // those. Pure, so it runs in the loop; the IO does not.
  const matches = refs.map((ref) => {
    const matched = dirNames.filter((dirName) =>
      ref.rawKeys.some((raw) => isCandidateProjectDir(raw, dirName)),
    );
    for (const dirName of matched) claimed.add(dirName);
    return matched;
  });

  // Concurrent, and this is load-bearing rather than tidiness: 93 refs on the
  // reference machine, and `await` inside the loop above would mean 93 serial
  // `stat` calls on every `doctor` run — visible against T1.11's budget the
  // moment one of those paths is on a network share.
  const existences = options.probe === true
    ? await Promise.all(refs.map((ref) => probeExistence(ref.displayPath)))
    : refs.map((): Existence => 'unreachable');

  const projects: ProjectRecord[] = refs.map((ref, index) => {
    const matched = matches[index] as string[];
    const sources: ProjectSource[] = ['claude-json'];
    if (matched.length > 0) sources.push('transcripts');

    return {
      ref,
      sources,
      transcriptDirs: matched,
      existence: existences[index] as Existence,
    };
  });

  const unresolved: UnresolvedTranscriptDir[] = dirNames
    .filter((dirName) => !claimed.has(dirName))
    .map((dirName) => ({
      dirName,
      reason:
        'no known project key encodes to this directory name, and the encoding has no ' +
        'inverse — the real path can only come from the `cwd` field on a record inside it',
    }));

  if (unresolved.length > 0) {
    warnings.push({
      code: 'partial',
      message:
        `${unresolved.length} transcript director${unresolved.length === 1 ? 'y' : 'ies'} ` +
        'match no known project key; usage attributed to them cannot be named from here',
      subject: 'projects',
    });
  }

  return { projects, unresolved, warnings };
}

/** A ref carrying the shape but none of the filesystem answers. */
function asUnprobed(ref: ProjectRef): ResolvedProjectRef {
  return { ...ref, resolution: 'unresolvable', linkedTo: [] };
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Finds the record for a path spelling, **by string only**.
 *
 * Covers separators, case, trailing separators and UNC — everything
 * `normaliseProjectPath` folds. It does **not** resolve junctions, symlinks,
 * `subst` drives or 8.3 short names: those need `realpath`, which is IO, and
 * this function does none. An earlier version of this comment claimed
 * otherwise while comparing a *string-normalised input* against a
 * *realpath-normalised known project* — a comparison that only ever succeeds
 * when the caller already typed the target's spelling, which the first lookup
 * catches anyway.
 *
 * Use `resolveProject` when the input may be a link. T3.12's `--project`
 * should.
 */
export function findProject(
  inventory: ProjectsInventory,
  rawPath: string,
): ProjectRecord | undefined {
  const { key } = groupProjectKeys([rawPath])[0] as ProjectRef;
  if (key === '') return undefined;

  return inventory.projects.find((record) => record.ref.key === key);
}

/**
 * Finds the record for a path spelling, resolving links.
 *
 * The string match is tried first because it is free and answers for the
 * overwhelming majority. Only on a miss is the input realpath'd and compared
 * against the known projects' resolved identities — so `--project` given
 * through a junction finds the project registered under its target, which is
 * what the sync version was wrongly documented as doing.
 *
 * A project whose own `realKey` was never computed (`probe: false`) cannot be
 * matched this way, and is not: guessing would defeat the point.
 */
export async function resolveProject(
  inventory: ProjectsInventory,
  rawPath: string,
): Promise<ProjectRecord | undefined> {
  const direct = findProject(inventory, rawPath);
  if (direct !== undefined) return direct;

  const realKey = await resolveRealKey(rawPath);
  if (realKey === undefined) return undefined;

  return inventory.projects.find((record) => record.ref.realKey === realKey);
}

/** Absolute path to the transcript root, given a home directory. */
export const transcriptsRoot = (home: string): string =>
  path.join(home, '.claude', 'projects');
