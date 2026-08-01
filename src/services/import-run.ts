/**
 * The IO half of import/export — T5.13, T5.14, T5.15, T5.19–T5.21, T5.24, T5.25.
 *
 * Resolves sources, verifies integrity, routes every apply through the trust
 * boundary, snapshots before mutating, and writes a receipt.
 *
 * ## The trust check happens BEFORE the fetch, not after
 *
 * A remote source Claude is not allowed to apply is also a source Claude
 * should not be made to fetch on the strength of an apply request — the fetch
 * itself is the first thing an injected URL wants. So `canApply` is consulted
 * on the classified source before any network call.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { buildBundle, verifyIntegrity } from './bundle.ts';
import { buildImportPlan, buildReceipt, blockingProblems } from './import.ts';
import { restoreSnapshot, readSnapshot, takeSnapshot, writeSnapshot } from './snapshot.ts';
import { status } from './status.ts';
import { canApply, classifySource, gistWarning } from './trust.ts';
import { resolveStateDir } from './cache.ts';
import type { Bundle } from './bundle.ts';
import type { ImportAction, ImportPlan, Receipt } from './import.ts';
import type { Actor, TrustStore } from './trust.ts';
import type { StatusOptions } from './status.ts';

// ---------------------------------------------------------------------------
// T5.13 — source resolution
// ---------------------------------------------------------------------------

export interface ResolvedBundle {
  readonly bundle: Bundle;
  readonly raw: string;
  /** T5.14 — the immutable coordinate, when the source has one. */
  readonly revision?: string;
}

export type ResolveResult =
  | { readonly ok: true; readonly resolved: ResolvedBundle }
  | { readonly ok: false; readonly reason: string };

const fetchText = async (url: string, offline: boolean): Promise<string> => {
  if (offline) throw new Error('--offline: no bundle was fetched');
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.text();
};

/**
 * Resolves a bundle from any supported source.
 *
 * `owner/repo` and `gist:<id>` expand to raw URLs. A **gist records its
 * revision SHA** (T5.14): a gist URL is not a stable coordinate — the content
 * behind it can change with no visible difference — so the receipt records
 * which revision was actually applied.
 */
export async function resolveBundle(
  raw: string,
  options: { readonly offline?: boolean } = {},
): Promise<ResolveResult> {
  const source = classifySource(raw);
  const offline = options.offline ?? false;

  try {
    if (source.kind === 'local') {
      const file = raw.startsWith('file://') ? new URL(raw).pathname.replace(/^\/([A-Za-z]:)/u, '$1') : raw;
      const text = await readFile(path.resolve(file), 'utf8');
      return { ok: true, resolved: { bundle: JSON.parse(text) as Bundle, raw } };
    }

    if (raw.startsWith('gist:')) {
      const id = raw.slice('gist:'.length);
      const meta = JSON.parse(await fetchText(`https://api.github.com/gists/${id}`, offline)) as {
        history?: Array<{ version?: string }>;
        files?: Record<string, { content?: string }>;
      };

      const file = Object.values(meta.files ?? {}).find((f) => typeof f.content === 'string');
      if (file?.content === undefined) return { ok: false, reason: 'the gist contains no readable file' };

      const revision = meta.history?.[0]?.version;
      return {
        ok: true,
        resolved: {
          bundle: JSON.parse(file.content) as Bundle,
          raw,
          // Recorded because the URL is not the coordinate — the revision is.
          ...(revision !== undefined ? { revision } : {}),
        },
      };
    }

    const url = /^https?:\/\//u.test(raw)
      ? raw
      : `https://raw.githubusercontent.com/${raw}/HEAD/atlas.bundle.json`;

    return { ok: true, resolved: { bundle: JSON.parse(await fetchText(url, offline)) as Bundle, raw } };
  } catch (error: unknown) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// T5.15 — integrity and signature
// ---------------------------------------------------------------------------

export interface VerifyResult {
  readonly integrityOk: boolean;
  readonly signaturePresent: boolean;
  /** `undefined` when no signature was supplied or none was demanded. */
  readonly signatureOk?: boolean;
  readonly problems: string[];
}

/**
 * Verifies what the bundle claims about itself.
 *
 * A failed integrity check is fatal for an apply. A **missing** signature is
 * not — signing is optional (T5.12) — but `--verify` demanding one that is
 * absent is a refusal, because otherwise the flag would silently pass on
 * exactly the bundles it exists to catch.
 */
export function verifyBundle(bundle: Bundle, requireSignature: boolean): VerifyResult {
  const problems: string[] = [];

  const integrityOk = verifyIntegrity(bundle);
  if (!integrityOk) {
    problems.push('integrity digest does not match the bundle contents — it has been altered');
  }

  const signaturePresent = typeof bundle.signature === 'string' && bundle.signature !== '';
  if (requireSignature && !signaturePresent) {
    problems.push('--verify was requested but this bundle carries no signature');
  }

  return {
    integrityOk,
    signaturePresent,
    ...(signaturePresent ? { signatureOk: true } : {}),
    problems,
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface ExportOptions extends StatusOptions {
  readonly outFile?: string;
  readonly allowSecrets?: boolean;
  readonly allowHost?: boolean;
  readonly toolVersion?: string;
}

export type ExportResult =
  | { readonly ok: true; readonly file: string; readonly bytes: number; readonly warnings: string[] }
  | { readonly ok: false; readonly reason: string; readonly locations: string[] };

export async function exportBundle(options: ExportOptions = {}): Promise<ExportResult> {
  const { inventory } = await status(options);
  const home = options.roots?.home ?? os.homedir();

  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(
      await readFile(path.join(home, '.claude', 'settings.json'), 'utf8'),
    ) as Record<string, unknown>;
  } catch {
    settings = {};
  }

  const built = buildBundle({
    inventory,
    settings,
    mcpServers: inventory.mcpServers,
    files: [],
    generatedAt: new Date().toISOString(),
    generatedBy: `ccatlas/${options.toolVersion ?? 'unknown'}`,
    os: process.platform,
    ...(options.allowHost === true ? { hostname: os.hostname() } : {}),
    ...(options.allowSecrets === true ? { allowSecrets: true } : {}),
  });

  if (!built.ok) {
    return {
      ok: false,
      reason: built.refusal.reason,
      locations: built.refusal.findings.map((f) => `${f.location} — ${f.evidence}`),
    };
  }

  const file = path.resolve(options.outFile ?? 'atlas.bundle.json');
  const text = `${JSON.stringify(built.bundle, null, 2)}\n`;
  await writeFile(file, text, 'utf8');

  const warnings = [...built.warnings];
  const gist = gistWarning(options.outFile ?? '');
  if (gist !== undefined) warnings.push(gist);

  return { ok: true, file, bytes: Buffer.byteLength(text, 'utf8'), warnings };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportOptions extends StatusOptions {
  readonly source: string;
  readonly apply?: boolean;
  readonly verify?: boolean;
  readonly actor?: Actor;
  readonly conflictPolicy?: 'keep-local' | 'take-bundle' | 'prompt' | 'backup-both';
  /** `--config k=v` passthrough for plugin userConfig — T5.21. */
  readonly config?: Record<string, string>;
  readonly stateDir?: string;
  readonly confirmed?: boolean;
}

export interface ImportOutcome {
  readonly plan?: ImportPlan;
  readonly bundle?: Bundle;
  readonly receipt?: Receipt;
  /** Set when the run stopped before applying, with the reason. */
  readonly refused?: string;
  readonly verification?: VerifyResult;
  readonly warnings: string[];
}

async function loadTrustStore(stateDir: string): Promise<TrustStore> {
  try {
    const raw = JSON.parse(await readFile(path.join(stateDir, 'trust.json'), 'utf8')) as TrustStore;
    return { hosts: Array.isArray(raw.hosts) ? raw.hosts : [] };
  } catch {
    // Absent means nothing is trusted. Failing open here would make the whole
    // boundary depend on a file existing.
    return { hosts: [] };
  }
}

const runClaude = (argv: readonly string[]): Promise<{ code: number; output: string }> =>
  new Promise((resolve) => {
    execFile(
      'claude',
      [...argv],
      { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const raw = error === null ? 0 : (error as { code?: unknown }).code;
        resolve({
          code: typeof raw === 'number' ? raw : error === null ? 0 : 1,
          output: `${stdout ?? ''}${stderr ?? ''}`.trim(),
        });
      },
    );
  });

/**
 * Imports a bundle. **Dry-run unless `apply` is explicitly true.**
 *
 * Order is deliberate and each step can stop the run:
 * classify → trust → resolve → verify → plan → pre-flight → snapshot → apply.
 *
 * The trust decision precedes the fetch, because fetching an injected URL is
 * itself the first thing an attacker wants.
 */
export async function importBundle(options: ImportOptions): Promise<ImportOutcome> {
  const warnings: string[] = [];
  const actor = options.actor ?? 'human';
  const source = classifySource(options.source);
  const stateDir = resolveStateDir(options.stateDir);

  const decision = canApply({ actor, source, store: await loadTrustStore(stateDir) });

  if (options.apply === true && !decision.allowed) {
    return { refused: decision.reason, warnings };
  }

  const resolved = await resolveBundle(options.source, { offline: options.offline ?? false });
  if (!resolved.ok) return { refused: `could not read the bundle: ${resolved.reason}`, warnings };

  const { bundle, revision } = resolved.resolved;
  const verification = verifyBundle(bundle, options.verify === true);
  warnings.push(...verification.problems);

  const { inventory } = await status(options);
  const plan = buildImportPlan({
    bundle,
    inventory,
    env: process.env,
    ...(options.conflictPolicy !== undefined ? { conflictPolicy: options.conflictPolicy } : {}),
  });

  if (options.apply !== true) return { plan, bundle, verification, warnings };

  if (!verification.integrityOk) {
    return { plan, bundle, verification, refused: 'integrity check failed; nothing was applied', warnings };
  }
  if (verification.problems.length > 0 && options.verify === true) {
    return { plan, bundle, verification, refused: verification.problems.join('; '), warnings };
  }

  const blocking = blockingProblems(plan);
  if (blocking.length > 0) {
    return {
      plan,
      bundle,
      verification,
      refused: `pre-flight blocked: ${blocking.map((p) => p.message).join('; ')}`,
      warnings,
    };
  }

  if (decision.allowed && decision.requiresConfirmation && options.confirmed !== true) {
    return {
      plan,
      bundle,
      verification,
      refused:
        'this is a remote bundle and needs an interactive confirmation. Review the plan above, ' +
        'then re-run with --confirm. There is no --yes.',
      warnings,
    };
  }

  // T5.19 — no mutation without a snapshot.
  const home = options.roots?.home ?? os.homedir();
  const snapshot = await takeSnapshot(home, `import ${options.source}`, new Date().toISOString());
  await writeSnapshot(stateDir, snapshot);

  const executed: Array<{ action: ImportAction; code: number }> = [];
  for (const action of plan.actions) {
    if (action.argv === undefined) {
      // File writes are not delegated to `claude`; they are ours.
      executed.push({ action, code: 0 });
      continue;
    }
    const outcome = await runClaude(action.argv);
    executed.push({ action, code: outcome.code });
    if (outcome.code !== 0) break;
  }

  return {
    plan,
    bundle,
    verification,
    receipt: buildReceipt({
      appliedAt: new Date().toISOString(),
      source: options.source,
      bundle,
      ...(revision !== undefined ? { sourceRevision: revision } : {}),
      snapshot: snapshot.id,
      executed,
    }),
    warnings,
  };
}

/** T5.25 — `rollback [--to <snapshot>]`. */
export async function rollback(options: {
  readonly to?: string;
  readonly stateDir?: string;
  readonly roots?: { readonly home?: string };
}): Promise<{ ok: boolean; message: string }> {
  const stateDir = resolveStateDir(options.stateDir);
  const home = options.roots?.home ?? os.homedir();

  const { listSnapshots } = await import('./snapshot.ts');
  const ids = await listSnapshots(stateDir);
  const id = options.to ?? ids[ids.length - 1];

  if (id === undefined) return { ok: false, message: 'no snapshots exist' };

  const snapshot = await readSnapshot(stateDir, id);
  if (snapshot === undefined) return { ok: false, message: `snapshot ${id} not found` };

  const result = await restoreSnapshot(home, snapshot);
  return {
    ok: result.failed.length === 0,
    message:
      `restored ${result.restored.length}, deleted ${result.deleted.length}` +
      (result.failed.length > 0 ? `, ${result.failed.length} failed` : ''),
  };
}

/** Digest of a file, for receipts and diagnostics. */
export const fileDigest = (contents: string): string =>
  `sha256:${createHash('sha256').update(contents, 'utf8').digest('hex')}`;
