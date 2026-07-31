/**
 * The shared project-path normaliser — T1.3 / T1.25 / T4.6.
 *
 * ONE implementation, three call sites: the mcp collector, the projects module,
 * and analytics attribution. Built twice they will disagree about what a
 * project is, and the disagreement is measured rather than hypothetical:
 * `~/.claude.json` holds 102 project keys of which 10 are duplicates of another
 * key once lowercased and separator-normalised (72 forward-slash, 30
 * backslash, drive letters C: and E:). Same project, two entries, divergent
 * state.
 *
 * Two rules govern everything here.
 *
 * 1. **Collisions are reported, never merged.** A `ProjectRef` keeps every raw
 *    key that normalised onto it. Picking one loses the configuration held by
 *    the others, silently, which is the failure mode ccatlas exists to avoid.
 *
 * 2. **The `~/.claude/projects/` directory name is never decoded.** That
 *    encoding collapses the drive colon, both separators AND dots onto a single
 *    `-`; it is many-to-one and has no inverse. The real path comes from the
 *    `cwd` field on a transcript record. FORMATS.md trap 17.
 *
 * Deliberately NOT done: `/mnt/c/...` is not rewritten to `c:/...`. The DrvFs
 * mount point is configurable and on a plain Linux box that path is an ordinary
 * directory, so the rewrite would be an inference beyond the three rules the
 * `ProjectRef` contract states. See the negative assertion in the test matrix.
 */

import type { ProjectRef, Warning } from '../types.ts';

/** Windows extended-length prefix in its UNC form, post separator-unification. */
const EXTENDED_UNC_PREFIX = '//?/unc/';
/** Windows extended-length prefix, plain form. */
const EXTENDED_PREFIX = '//?/';

/** A path that is nothing but a drive letter, e.g. `c:` — a root, not a name. */
const BARE_DRIVE = /^[a-z]:$/;

/**
 * Characters the `~/.claude/projects/` directory encoding folds onto `-`.
 *
 * FORMATS.md trap 17 and §3 both state `[\/:]`. The reference machine shows the
 * class is wider: `C:\Users\alex.WORKSTN` is stored as `C--Users-alex-WORKSTN`,
 * so dots fold too. The wider class makes the encoding MORE lossy, never less,
 * which is why it is only ever used to narrow candidates — see
 * `isCandidateProjectDir`.
 */
const LOSSY_DIR_NAME_CLASS = /[\\/:.]/g;

/**
 * Normalise a project path to its identity key: lowercase, forward slashes, no
 * trailing separator.
 *
 * Lowercasing is correct on Windows and over-eager on a case-sensitive
 * filesystem. That is deliberate and safe here precisely because collisions are
 * reported rather than merged: two genuinely distinct POSIX paths differing
 * only in case surface as a flagged collision the caller can inspect, not as
 * one silently-chosen entry.
 *
 * Returns `''` for empty or whitespace-only input; callers treat that as "no
 * project", never as a key.
 */
export function normaliseProjectPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';

  // Separators first: every rule below is expressed in forward slashes.
  // `toLowerCase` (not `toLocaleLowerCase`) — locale-invariant, so a Turkish
  // locale cannot turn `I` into a dotless `ı` and split one project in two.
  let p = trimmed.replace(/\\/g, '/').toLowerCase();

  // Extended-length prefixes. The UNC form is rewritten back to a UNC path
  // rather than stripped outright, or `\\?\UNC\server\share` would come out as
  // the local path `/server/share`.
  if (p.startsWith(EXTENDED_UNC_PREFIX)) p = `//${p.slice(EXTENDED_UNC_PREFIX.length)}`;
  else if (p.startsWith(EXTENDED_PREFIX)) p = p.slice(EXTENDED_PREFIX.length);

  // Collapse duplicate separators, preserving a leading `//`. The UNC prefix is
  // load-bearing: collapsing it would alias `\\server\share` onto the local
  // absolute path `/server/share`.
  const isUnc = p.startsWith('//');
  p = p.replace(/\/{2,}/g, '/');
  if (isUnc) p = `/${p}`;

  p = p.replace(/\/+$/, '');

  // Roots must survive the trailing-separator rule. Stripping must never yield
  // an empty key, and a bare drive must land on the same key as `C:\`.
  if (p === '' || p === '/') return '/';
  if (BARE_DRIVE.test(p)) return `${p}/`;

  return p;
}

/**
 * Group raw project keys into `ProjectRef`s, one per normalised identity.
 *
 * Input order is preserved, both across groups (first appearance wins) and
 * within `rawKeys`, so the output is stable for a stable `~/.claude.json`.
 * `displayPath` is the first raw key of the group — an actual key from disk,
 * never a path this module invented.
 */
export function groupProjectKeys(rawKeys: Iterable<string>): ProjectRef[] {
  const groups = new Map<string, string[]>();

  for (const rawKey of rawKeys) {
    const key = normaliseProjectPath(rawKey);
    const existing = groups.get(key);
    if (existing) existing.push(rawKey);
    else groups.set(key, [rawKey]);
  }

  return Array.from(groups, ([key, keys]) => ({
    key,
    rawKeys: keys,
    // Non-null: a group only exists because at least one key created it.
    displayPath: keys[0] as string,
    collides: keys.length > 1,
  }));
}

/** The single-key form of {@link groupProjectKeys}. Never collides. */
export function toProjectRef(rawKey: string): ProjectRef {
  return groupProjectKeys([rawKey])[0] as ProjectRef;
}

/**
 * One `path-collision` warning per colliding ref, naming the raw keys.
 *
 * A warning that reports a collision without saying which entries collide is
 * not actionable — the caller's next move is to go and read the divergent
 * state off each one.
 */
export function collisionWarnings(refs: readonly ProjectRef[]): Warning[] {
  return refs
    .filter((ref) => ref.collides)
    .map((ref) => ({
      code: 'path-collision' as const,
      message:
        `${ref.rawKeys.length} project keys normalise to "${ref.key}" and are NOT merged: ` +
        // Quoted, not JSON-escaped: a warning naming a Windows path must show
        // `"C:\a"`, not `"C:\\a"`, or the reader cannot match it against the
        // key they are looking at on disk.
        `${ref.rawKeys.map((k) => `"${k}"`).join(', ')}. ` +
        'Each entry may hold different state; inspect them individually.',
      subject: ref.key,
    }));
}

/**
 * Resolve an arbitrary path spelling — a `~/.claude.json` key, a transcript
 * `cwd`, a `--project` argument — against a known project set. T4.6's lookup.
 */
export function findProjectRef(
  refs: readonly ProjectRef[],
  rawPath: string,
): ProjectRef | undefined {
  const key = normaliseProjectPath(rawPath);
  if (key === '') return undefined;
  return refs.find((ref) => ref.key === key);
}

/**
 * Encode a real path the way Claude Code names its `~/.claude/projects/`
 * directories. **Forward only — there is deliberately no inverse.**
 *
 * The encoding folds `\`, `/`, `:` and `.` all onto `-`, so it is many-to-one:
 * `C:\lod-expo` and `C:\lod.expo` produce the same directory name. Any
 * "decoder" would have to guess, and would guess wrong silently.
 *
 * Case is preserved because the on-disk names preserve the `cwd`'s case.
 */
export function encodeProjectDirName(realPath: string): string {
  return realPath.trim().replace(LOSSY_DIR_NAME_CLASS, '-');
}

/**
 * Could `dirName` be the transcript directory for `realPath`?
 *
 * A **candidate matcher, not an authority.** Use it to narrow a directory
 * listing cheaply, then confirm identity by reading `cwd` off a record inside.
 * Because the encoding is many-to-one, a `true` here is necessary but not
 * sufficient — and because the exact character class is inferred from observed
 * names, a wrong guess about it degrades matching without ever producing a
 * wrong path.
 */
export function isCandidateProjectDir(realPath: string, dirName: string): boolean {
  return encodeProjectDirName(realPath).toLowerCase() === dirName.trim().toLowerCase();
}
