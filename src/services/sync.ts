/**
 * Git sync — T6.1–T6.14.
 *
 * ## Three-way status, **per entity, not per file**
 *
 * T6.3. A file-level diff on `plugins.json` says "changed" and stops being
 * useful: the interesting question is always *which plugin*, and a whole-file
 * answer forces the user to read a JSON diff to find out. The comparison is
 * therefore over entities, and the three sides are:
 *
 * ```
 * machine   what is installed here now
 * local     what the checked-out repo says
 * remote    what the fetched remote says
 * ```
 *
 * ## ⛔ T6.8 — never write conflict markers into JSON
 *
 * Git's default merge writes `<<<<<<<` into the file. For `settings.json` or
 * `installed_plugins.json` that produces a file **Claude Code parses at
 * startup** and fails on — so a routine merge conflict becomes a broken
 * install, and the user's first symptom is Claude Code not starting rather
 * than a merge to resolve. JSON is merged structurally, per entry, and an
 * unresolvable pair is reported as a conflict *record*, never as markers.
 *
 * Markdown takes a plain git merge, where markers are the expected idiom and
 * nothing parses the file.
 *
 * ## T6.9 — machine overlays apply last and always win
 *
 * `machines/<host>.json` holds `env.*`, model endpoints and absolute paths.
 * Pulling must never clobber a laptop's own endpoint with a desktop's, so the
 * overlay is applied after the merge, unconditionally.
 */

export type Side = 'machine' | 'local' | 'remote';

export type EntityStatus =
  | 'in-sync'
  | 'machine-only'
  | 'local-only'
  | 'remote-only'
  | 'machine-ahead'
  | 'remote-ahead'
  | 'diverged';

export interface EntityState {
  readonly key: string;
  readonly machine?: string;
  readonly local?: string;
  readonly remote?: string;
}

export interface EntityDiff {
  readonly key: string;
  readonly status: EntityStatus;
  readonly machine?: string;
  readonly local?: string;
  readonly remote?: string;
}

/**
 * Classifies one entity across the three sides.
 *
 * `diverged` is the case that matters: the machine and the remote both changed
 * away from the common local base, so neither can be taken without losing the
 * other. It is reported rather than resolved.
 */
export function classifyEntity(state: EntityState): EntityStatus {
  const { machine, local, remote } = state;

  if (machine === undefined && local === undefined && remote === undefined) return 'in-sync';
  if (machine !== undefined && local === undefined && remote === undefined) return 'machine-only';
  if (machine === undefined && local !== undefined && remote === undefined) return 'local-only';
  if (machine === undefined && local === undefined && remote !== undefined) return 'remote-only';

  if (machine === local && local === remote) return 'in-sync';

  // Base is the checked-out local copy: it is what both sides last agreed on.
  const machineMoved = machine !== local;
  const remoteMoved = remote !== local;

  if (machineMoved && remoteMoved) return machine === remote ? 'in-sync' : 'diverged';
  if (machineMoved) return 'machine-ahead';
  if (remoteMoved) return 'remote-ahead';
  return 'in-sync';
}

export function threeWayStatus(states: readonly EntityState[]): EntityDiff[] {
  return states
    .map((state) => ({
      key: state.key,
      status: classifyEntity(state),
      ...(state.machine !== undefined ? { machine: state.machine } : {}),
      ...(state.local !== undefined ? { local: state.local } : {}),
      ...(state.remote !== undefined ? { remote: state.remote } : {}),
    }))
    .filter((diff) => diff.status !== 'in-sync')
    .sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// ⛔ T6.6 / T6.8 — structured merge
// ---------------------------------------------------------------------------

export interface MergeConflict {
  readonly key: string;
  readonly ours: unknown;
  readonly theirs: unknown;
}

export interface MergeResult {
  readonly merged: Record<string, unknown>;
  readonly conflicts: MergeConflict[];
}

/**
 * Merges two JSON objects **per entry**.
 *
 * Where only one side changed relative to the base, that side wins with no
 * ceremony. Where both changed to different values, the entry is a conflict —
 * reported in `conflicts` and left at the base value in `merged`, so the file
 * stays **valid JSON that Claude Code can parse**.
 *
 * That last part is T6.8 and it is the whole point: emitting `<<<<<<<` here
 * would produce a settings file that breaks Claude Code at startup, turning a
 * routine conflict into a broken install.
 */
export function mergeJson(
  base: Record<string, unknown>,
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
): MergeResult {
  const merged: Record<string, unknown> = { ...base };
  const conflicts: MergeConflict[] = [];

  const keys = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);

  for (const key of keys) {
    const b = JSON.stringify(base[key]);
    const o = JSON.stringify(ours[key]);
    const t = JSON.stringify(theirs[key]);

    if (o === t) {
      if (ours[key] === undefined) delete merged[key];
      else merged[key] = ours[key];
      continue;
    }

    const ourChange = o !== b;
    const theirChange = t !== b;

    if (ourChange && !theirChange) {
      if (ours[key] === undefined) delete merged[key];
      else merged[key] = ours[key];
      continue;
    }
    if (theirChange && !ourChange) {
      if (theirs[key] === undefined) delete merged[key];
      else merged[key] = theirs[key];
      continue;
    }

    // Both moved, differently. Reported; the base value stays so the file
    // remains parseable.
    conflicts.push({ key, ours: ours[key], theirs: theirs[key] });
  }

  return { merged, conflicts };
}

// ---------------------------------------------------------------------------
// T6.9 — machine overlays
// ---------------------------------------------------------------------------

/**
 * Applies a machine overlay **last**, so it always wins.
 *
 * `env.*`, model endpoints and absolute paths are machine identity. A pull
 * that overwrote a laptop's endpoint with a desktop's would break the laptop
 * in a way that looks like the sync working.
 */
export function applyOverlay(
  merged: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  return { ...merged, ...overlay };
}

// ---------------------------------------------------------------------------
// 🔒 T6.11, T6.12, T6.13, T6.14 — auth and remote posture
// ---------------------------------------------------------------------------

/** 🔒 T6.11 — a public remote is the wrong place for a stack bundle. */
export function publicRemoteWarning(remoteUrl: string): string | undefined {
  if (!/github\.com|gitlab\.com|bitbucket\.org/iu.test(remoteUrl)) return undefined;

  return (
    'This looks like a public git host. A stack bundle names every plugin, marketplace and MCP ' +
    'server you run — useful to an attacker choosing what to target. Use a private repository ' +
    'unless you intend the stack to be public.'
  );
}

export interface AuthRemedy {
  readonly order: number;
  readonly title: string;
  readonly detail: string;
  readonly command?: string;
}

/**
 * 🔒 T6.12 — private-marketplace auth remedies, in the documented order.
 *
 * Claude Code's background marketplace refresh **disables git credential
 * helpers**, so an HTTPS pull against a private marketplace fails and falls
 * back to a full re-clone that can time out. These are the remedies, ordered
 * safest-first.
 *
 * T6.13's warning is attached to the last one deliberately: a **host-scoped**
 * URL rewrite overrides credentials for every fetch and push to that host —
 * including unrelated repositories — and typically writes a plaintext token
 * into gitconfig. Path-scoped is the only form worth recommending.
 */
export function authRemedies(): AuthRemedy[] {
  return [
    {
      order: 1,
      title: 'Use SSH',
      detail: 'An SSH remote sidesteps the credential-helper problem entirely; nothing is disabled.',
      command: 'claude plugin marketplace add git@github.com:owner/repo.git',
    },
    {
      order: 2,
      title: 'Keep the marketplace on failure',
      detail:
        'Stops a failed refresh from discarding the working clone, so a timeout degrades to a ' +
        'stale marketplace rather than a missing one.',
      command: 'CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE=1',
    },
    {
      order: 3,
      title: 'Configure a credential helper',
      detail:
        'Works for normal git operations. Note it does NOT help the background refresh, which ' +
        'disables helpers — combine with remedy 2.',
      command: 'gh auth setup-git',
    },
    {
      order: 4,
      title: 'PATH-SCOPED url rewrite (last resort)',
      detail:
        '⚠️ Scope it to the exact repository path. A HOST-scoped rewrite overrides credentials ' +
        'for every fetch and push to that host, including unrelated repositories, and usually ' +
        'puts a plaintext token in your gitconfig.',
      command: 'git config --global url."https://TOKEN@github.com/owner/repo".insteadOf "https://github.com/owner/repo"',
    },
  ];
}

/** T6.14 — a bare `GITHUB_TOKEN` does nothing on its own. */
export const GITHUB_TOKEN_NOTE =
  'Setting GITHUB_TOKEN alone does nothing for git: git does not read it. It needs a credential ' +
  'helper or a URL rewrite to be used at all.';

// ---------------------------------------------------------------------------
// 🔒 T6.10 — the pre-push secret guard
// ---------------------------------------------------------------------------

export interface PushGuardResult {
  readonly safe: boolean;
  readonly reason?: string;
  readonly locations: string[];
}

/**
 * 🔒 Refuses to push a bundle containing a live credential.
 *
 * `sync push` fails **loudly** rather than pushing a token. A push is
 * irreversible in practice — the object is on the remote and in every clone —
 * so this is the last point at which a mistake is still cheap.
 */
export function pushGuard(findings: ReadonlyArray<{ location: string; evidence: string }>): PushGuardResult {
  if (findings.length === 0) return { safe: true, locations: [] };

  return {
    safe: false,
    reason:
      `${findings.length} credential(s) would be pushed. A push is irreversible in practice — ` +
      'the object reaches the remote and every clone of it. Rotate the credential and replace ' +
      'the literal with ${VAR} before pushing.',
    locations: findings.map((f) => `${f.location} — ${f.evidence}`),
  };
}
