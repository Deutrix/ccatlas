/**
 * The import trust model — T5.27 🔒⛔, T5.28 🔒, T5.30 🔒⛔.
 *
 * ## What this is actually defending against
 *
 * Importing a bundle installs plugins and registers MCP servers. That is
 * **arbitrary code execution by design** — an MCP server is a `command` and
 * `args` that Claude Code will run. So the question "may this bundle be
 * applied" is not a UX question; it is the whole security boundary.
 *
 * The specific attack is prompt injection. A bundle URL can arrive inside a
 * fetched web page, an MCP tool result, a repository README, or an issue
 * comment — all of which Claude reads as text and none of which the user
 * wrote. If Claude can act on such a URL, then anything Claude reads can
 * install software on the user's machine.
 *
 * ## The rule, in the strictest form the spec allows
 *
 * **Claude may never apply a remote bundle.** Not with a trusted host, not
 * with a flag, not with a config setting. Skills expose `--dry-run` only, and
 * `--apply` from a remote source requires a human turn with an interactive
 * confirmation and **no `--yes` escape**.
 *
 * The trust store (T5.28) narrows further rather than widening: an untrusted
 * host is dry-run only *even for a human*. It is not a way for Claude to earn
 * apply rights.
 *
 * ## Why there is no `--yes`
 *
 * A confirmation an automated caller can pre-answer is not a confirmation. The
 * entire value of the prompt is that a human is present to read the plan, and
 * a flag that satisfies it in advance converts the boundary into a formality.
 */

export type SourceKind = 'local' | 'remote';

export interface BundleSource {
  /** As the user or caller supplied it. */
  readonly raw: string;
  readonly kind: SourceKind;
  /** Host for a remote source, lowercased. */
  readonly host?: string;
}

/**
 * Classifies a bundle source.
 *
 * **Fails safe: anything not provably local is remote.** A path that looks
 * local but resolves through a UNC share or a mapped drive reaches a machine
 * the user may not control, and misclassifying it as local would skip the
 * confirmation entirely.
 */
export function classifySource(raw: string): BundleSource {
  const value = raw.trim();

  const url = /^([a-z][\w+.-]*):\/\/([^/\s]+)/iu.exec(value);
  if (url !== null) {
    const scheme = (url[1] ?? '').toLowerCase();
    const host = (url[2] ?? '').toLowerCase().replace(/^[^@]*@/u, '');
    // `file://` is the one URL scheme that is genuinely local.
    if (scheme === 'file') return { raw: value, kind: 'local' };
    return { raw: value, kind: 'remote', host };
  }

  // GitHub shorthand — `owner/repo` — is remote.
  //
  // Neither segment may START with a dot, or `./bundle.json` matches: a
  // relative path would be classified as a GitHub repository. That errs in the
  // safe direction, but it would block every legitimate local import written
  // the way people actually write them.
  if (/^[\w-][\w.-]*\/[\w-][\w.-]*$/u.test(value)) {
    return { raw: value, kind: 'remote', host: 'github.com' };
  }
  if (value.startsWith('gist:')) return { raw: value, kind: 'remote', host: 'gist.github.com' };

  // A UNC path reaches another machine. Treated as remote deliberately.
  if (value.startsWith('\\\\') || value.startsWith('//')) {
    return { raw: value, kind: 'remote', host: value.replace(/^[\\/]+/u, '').split(/[\\/]/u)[0]?.toLowerCase() ?? '' };
  }

  return { raw: value, kind: 'local' };
}

/** Who is asking. The distinction this whole module exists to enforce. */
export type Actor = 'human' | 'claude';

export type ApplyDecision =
  | { readonly allowed: true; readonly requiresConfirmation: boolean }
  | { readonly allowed: false; readonly reason: string };

export interface TrustStore {
  /** Hosts the user has explicitly trusted. Never populated automatically. */
  readonly hosts: string[];
}

export const EMPTY_TRUST_STORE: TrustStore = { hosts: [] };

export function isTrusted(store: TrustStore, source: BundleSource): boolean {
  if (source.kind === 'local') return true;
  if (source.host === undefined) return false;
  return store.hosts.map((h) => h.toLowerCase()).includes(source.host);
}

/**
 * 🔒 The decision. Every import path routes through here.
 *
 * Order matters, and the first rule is absolute:
 *
 * 1. **Claude + remote ⇒ refused.** No trust store entry, no flag, no config
 *    overrides this. T5.30.
 * 2. Untrusted host ⇒ dry-run only, even for a human. T5.28.
 * 3. Human + remote + trusted ⇒ allowed, **with interactive confirmation**.
 *    T5.27, and the confirmation cannot be pre-answered.
 * 4. Local ⇒ allowed. A path on this machine is something the user already
 *    controls, and requiring a prompt for it would train them to click through.
 */
export function canApply(input: {
  readonly actor: Actor;
  readonly source: BundleSource;
  readonly store: TrustStore;
}): ApplyDecision {
  const { actor, source, store } = input;

  if (actor === 'claude' && source.kind === 'remote') {
    return {
      allowed: false,
      reason:
        'Claude may not apply a remote bundle. Importing installs plugins and registers MCP ' +
        'servers, which is arbitrary code execution by design — and a bundle URL can arrive ' +
        'inside a fetched page, an MCP tool result, or a README, none of which you wrote. ' +
        'A dry-run plan is available; applying it needs you.',
    };
  }

  if (source.kind === 'local') return { allowed: true, requiresConfirmation: false };

  if (!isTrusted(store, source)) {
    return {
      allowed: false,
      reason:
        `${source.host ?? 'this host'} is not in the trust store, so this bundle is dry-run ` +
        'only. Review the plan, then add the host explicitly if you want to apply from it.',
    };
  }

  // Remote, trusted, human. Allowed — and still confirmed, because "trusted
  // host" means the host is not the threat, not that the bundle is harmless.
  return { allowed: true, requiresConfirmation: true };
}

/**
 * What a skill is permitted to do. T5.30's surface.
 *
 * Deliberately narrow and deliberately not parameterised: there is no argument
 * a skill can pass that widens it. The function takes no options for exactly
 * that reason — an options bag is an invitation to add the escape hatch later.
 */
export function skillCapabilities(): { readonly dryRun: true; readonly apply: false } {
  return { dryRun: true, apply: false };
}

/**
 * 🔒 T5.31 — the gist privacy warning.
 *
 * A "secret" gist is unlisted, **not private**: anyone with the URL can read
 * it, it is not authenticated, and it stays readable after deletion via the
 * revision API. Users routinely believe otherwise, which is exactly why the
 * warning fires at export time rather than being left to the docs.
 */
export function gistWarning(target: string): string | undefined {
  if (!/gist\.github\.com|^gist:/iu.test(target)) return undefined;

  return (
    'A secret gist is UNLISTED, not private: anyone with the URL can read it, no ' +
    'authentication is required, and revisions remain retrievable after deletion. ' +
    'Do not put a bundle containing credentials in one.'
  );
}
