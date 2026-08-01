/**
 * Claude Code version detection and feature gating — TX.1.
 *
 * ## Warn, never crash
 *
 * The minimum is v2.1.143. Below it, some commands this tool shells out to
 * behave differently or do not exist. But a hard refusal is the wrong response
 * to an old CLI: ccatlas is a *diagnostic*, and a machine running something
 * unexpected is exactly the machine somebody is trying to diagnose. So an
 * out-of-range version degrades specific features and says so.
 *
 * The same applies above the tested range. A newer Claude Code is far more
 * likely to work than not, and refusing on it would make ccatlas expire on
 * every release.
 */

export const MINIMUM_VERSION = '2.1.143';
/** The build the fixture corpus was captured against — TX.2's baseline. */
export const TESTED_VERSION = '2.1.220';

export type VersionPosition = 'below-minimum' | 'supported' | 'above-tested' | 'unknown';

export interface VersionVerdict {
  readonly position: VersionPosition;
  readonly detected?: string;
  readonly message?: string;
  /** Features that should be skipped rather than attempted. */
  readonly degrade: string[];
}

/** Numeric comparison. `2.1.9` is below `2.1.10`, which a string compare gets wrong. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    (/^v?(\d+)\.(\d+)\.(\d+)/u.exec(v) ?? []).slice(1, 4).map(Number);

  const left = parse(a);
  const right = parse(b);
  if (left.length !== 3 || right.length !== 3) return Number.NaN;

  for (let i = 0; i < 3; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l - r;
  }
  return 0;
}

/** `2.1.220 (Claude Code)` → `2.1.220`. */
export function parseVersionOutput(raw: string): string | undefined {
  return /(\d+\.\d+\.\d+)/u.exec(raw.trim())?.[1];
}

export function assessVersion(detected: string | undefined): VersionVerdict {
  if (detected === undefined) {
    return {
      position: 'unknown',
      // Not a failure. `claude --version` can be absent on a machine where the
      // file layer still works perfectly, and the file layer is most of what
      // ccatlas reads.
      message:
        'the Claude Code version could not be determined; CLI-sourced facts may be unavailable ' +
        'but the file layer is unaffected',
      degrade: [],
    };
  }

  if (compareVersions(detected, MINIMUM_VERSION) < 0) {
    return {
      position: 'below-minimum',
      detected,
      message:
        `Claude Code ${detected} is below the supported minimum ${MINIMUM_VERSION}. ccatlas will ` +
        'still read what it can, but CLI-sourced facts may be wrong or missing.',
      // These are the surfaces that depend on CLI shapes verified at 2.1.143+.
      degrade: ['plugin-details-cost', 'marketplace-entries', 'mcp-connection-state'],
    };
  }

  if (compareVersions(detected, TESTED_VERSION) > 0) {
    return {
      position: 'above-tested',
      detected,
      message:
        `Claude Code ${detected} is newer than the ${TESTED_VERSION} the fixture corpus was ` +
        'captured against. Output shapes are unverified here; a parse warning is expected rather ' +
        'than alarming.',
      degrade: [],
    };
  }

  return { position: 'supported', detected, degrade: [] };
}

/** Should this feature run, given the verdict? */
export function isDegraded(verdict: VersionVerdict, feature: string): boolean {
  return verdict.degrade.includes(feature);
}
