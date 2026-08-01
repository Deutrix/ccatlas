/**
 * Remote resolution — T2.7, T2.8.
 *
 * The one part of `updates` that needs the network, and the only part. T2.4's
 * stale-pin diagnostic is answered entirely offline from the clone already on
 * disk; what this adds is the *other* staleness question — whether the
 * marketplace clone is itself behind its upstream.
 *
 * ## Why that question is separate, and second
 *
 * A clone that is behind upstream means every entry in it may be stale,
 * including the `source.sha` values T2.4 compares against. So a stale-pin
 * report from a stale clone understates the problem. But it never *over*states
 * it: the pins it does flag are real regardless. That ordering — offline
 * answer first, network answer as an amplifier — is why `--offline` can be an
 * honest guarantee rather than a degraded mode.
 *
 * ## `--offline` is enforced here, not asked about
 *
 * TX.5 requires zero egress and requires it asserted. Every function in this
 * module takes the flag and returns `{ checked: false, reason }` rather than
 * dialling, so the guarantee is a property of the code path and not of every
 * caller remembering.
 */

import { execFile } from 'node:child_process';

import type { KnownMarketplaceRecord } from '../collectors/registry.ts';
import type { Warning } from '../types.ts';

/**
 * Git timeout.
 *
 * `CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS` is honoured because Claude Code honours
 * it — a user who raised it for a slow private remote should not have ccatlas
 * time out where `claude` succeeds. The 120s default matches Claude Code's.
 */
export function gitTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = env['CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS'];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}

/**
 * Concurrency cap for remote checks.
 *
 * Six because that is roughly what a git host tolerates from one client
 * without rate-limiting, and because an unbounded fan-out over 20 marketplaces
 * would open 20 TLS connections at once on a laptop that may be on a phone
 * tether.
 */
export const REMOTE_CONCURRENCY = 6;

/** How long a remote answer stays good. */
export const REMOTE_TTL_MS = 6 * 60 * 60 * 1000;

export type RemoteCheck =
  | { readonly checked: true; readonly headSha: string }
  | { readonly checked: false; readonly reason: string };

export interface RemoteOptions {
  readonly offline?: boolean;
  readonly env?: Record<string, string | undefined>;
  /** Injected in tests. Never set in production. */
  readonly run?: (argv: readonly string[], timeoutMs: number) => Promise<{ code: number; stdout: string }>;
}

const defaultRun = (
  argv: readonly string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string }> =>
  new Promise((resolve) => {
    execFile(
      'git',
      [...argv],
      { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        const raw = error === null ? 0 : (error as { code?: unknown }).code;
        resolve({ code: typeof raw === 'number' ? raw : error === null ? 0 : 1, stdout: stdout ?? '' });
      },
    );
  });

/**
 * The upstream URL for a marketplace, when one is derivable.
 *
 * Only `github` and explicit-`url` sources yield one. A `local` source has no
 * remote by definition, and a source type this has never seen returns
 * `undefined` rather than a guessed URL — T0.5 observed only `github` locally,
 * so every other branch is unverified and must fail closed.
 */
export function remoteUrlFor(market: KnownMarketplaceRecord): string | undefined {
  const source = market.source;
  if (source === undefined) return undefined;

  if (source.source === 'github' && source.repo !== undefined) {
    return `https://github.com/${source.repo}.git`;
  }
  if (source.url !== undefined && /^https?:\/\//u.test(source.url)) return source.url;
  return undefined;
}

/**
 * Asks a remote for its HEAD commit.
 *
 * `git ls-remote` rather than a fetch: it is one round trip, writes nothing,
 * and needs no working copy. **`GIT_TERMINAL_PROMPT=0` is set** because a
 * private remote without a credential helper otherwise blocks on an
 * interactive password prompt — and a diagnostic tool that hangs waiting for
 * stdin in a CI job is worse than one that reports it could not check.
 */
export async function resolveRemoteHead(
  market: KnownMarketplaceRecord,
  options: RemoteOptions = {},
): Promise<RemoteCheck> {
  if (options.offline === true) {
    return { checked: false, reason: '--offline: no remote was contacted' };
  }

  // A GCS-distributed marketplace has no git remote at all. That is not a
  // failure to check; there is nothing to check against.
  if (market.distribution === 'gcs') {
    return { checked: false, reason: 'distributed as a GCS tarball; there is no git remote' };
  }

  const url = remoteUrlFor(market);
  if (url === undefined) {
    return { checked: false, reason: 'no upstream URL is derivable from this source type' };
  }

  const env = options.env ?? {};
  const run = options.run ?? defaultRun;
  const outcome = await run(['ls-remote', url, 'HEAD'], gitTimeoutMs(env));

  if (outcome.code !== 0) {
    return { checked: false, reason: `git ls-remote exited ${outcome.code}` };
  }

  const sha = /^([0-9a-f]{40})\s/u.exec(outcome.stdout.trim())?.[1];
  return sha === undefined
    ? { checked: false, reason: 'git ls-remote returned no parseable HEAD' }
    : { checked: true, headSha: sha };
}

/**
 * Checks every marketplace, capped at {@link REMOTE_CONCURRENCY}.
 *
 * A worker-pool rather than a chunked `Promise.all`: chunking makes every
 * batch wait for its slowest member, which on a set containing one
 * unreachable private remote means the whole check runs at timeout speed.
 */
export async function resolveRemoteHeads(
  marketplaces: readonly KnownMarketplaceRecord[],
  options: RemoteOptions = {},
): Promise<{ results: Map<string, RemoteCheck>; warnings: Warning[] }> {
  const results = new Map<string, RemoteCheck>();
  const warnings: Warning[] = [];
  const queue = [...marketplaces];

  const worker = async (): Promise<void> => {
    for (;;) {
      const market = queue.shift();
      if (market === undefined) return;
      results.set(market.name, await resolveRemoteHead(market, options));
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(REMOTE_CONCURRENCY, Math.max(1, marketplaces.length)) }, worker),
  );

  for (const market of marketplaces) {
    const check = results.get(market.name);
    if (check === undefined || check.checked) continue;
    warnings.push({
      code: 'partial',
      message: `upstream not checked: ${check.reason}`,
      subject: market.name,
    });
  }

  return { results, warnings };
}

/**
 * Is the local clone behind its upstream?
 *
 * `undefined` when either side is unknown — an unchecked remote and a clone
 * with no readable HEAD both mean *cannot tell*, which must not render as
 * *up to date*.
 */
export function cloneIsBehind(
  market: KnownMarketplaceRecord,
  check: RemoteCheck | undefined,
): boolean | undefined {
  if (check === undefined || !check.checked) return undefined;
  if (market.headSha === undefined) return undefined;
  return market.headSha.toLowerCase() !== check.headSha.toLowerCase();
}
