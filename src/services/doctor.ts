/**
 * Doctor — T1.12–T1.19.
 *
 * ## T1.19 first, deliberately
 *
 * "Every finding carries severity and the exact fix command" is a *contract*,
 * and seven detectors written before it produce seven slightly-different
 * finding shapes. That is defect D1 again, whose lesson this ledger already
 * records: the shared vocabulary goes in before the things that speak it, not
 * after.
 *
 * ## Doctor never mutates
 *
 * `fixCommand` is **a string the user runs**, not something this module
 * executes. Every repair delegates to the `claude` CLI, and ccatlas never
 * writes into `~/.claude/plugins/`. A doctor that fixed things would need a
 * dry-run plan and a snapshot (F5's rules), which is a different feature.
 *
 * ## What is NOT built, and why
 *
 * Four of the eight task rows have no data source in the corpus. They are
 * recorded here rather than implemented against invented inputs:
 *
 * - **T1.14 LSP extension collisions** — every `plugin details` fixture reports
 *   `LSP servers (0)`. No LSP server exists anywhere in the corpus, so there
 *   are no extension claims to collide. Needs a synthetic fixture.
 * - **T1.12 LSP binary on `$PATH`** — same absence.
 * - **T1.13 "connects with zero tools"** — `mcp get` returns only `Scope` and
 *   `Status`; no tool count exists in any CLI output, and FORMATS §1 records
 *   MCP schema cost as unavailable outright. The connection-state half ships;
 *   the zero-tools half is a respecify.
 * - **T1.17 always-on cost threshold** — needs a `plugin details` text parser,
 *   which is formally T4.7's and carries its own traps (mixed number formats
 *   in one table, per-component values that do not sum to the total, the
 *   silently-falling-back estimator). Pulling it forward would import all of
 *   that; deferred to Phase 4 with the threshold plumbing left unbuilt rather
 *   than built over a number that does not exist.
 */

import path from 'node:path';

import { scanValue } from '../util/secrets.ts';
import type { SecretFinding } from '../util/secrets.ts';
import type { Inventory } from './inventory.ts';

// ---------------------------------------------------------------------------
// T1.19 — the contract
// ---------------------------------------------------------------------------

/**
 * Three levels, not the code-review five.
 *
 * A diagnostic tool's severities answer "how soon does this hurt", which is a
 * different question from a review's "how much does this block a merge". More
 * levels would invite fine gradations nobody acts on differently.
 */
export type Severity = 'critical' | 'warning' | 'info';

export const SEVERITY_ORDER: readonly Severity[] = ['critical', 'warning', 'info'];

export interface Finding {
  /** Stable, greppable, and safe to match on in a skill. */
  readonly code: FindingCode;
  readonly severity: Severity;
  /** The entity or path this is about. */
  readonly subject: string;
  /** What is wrong, in one sentence. */
  readonly message: string;
  /** Why it matters — the consequence, not a restatement of the message. */
  readonly cause: string;
  /**
   * The exact command to run, or `undefined` when no single command fixes it.
   * **Never executed by ccatlas.** An honest absence beats a plausible command
   * that does not work: a user who runs a wrong fix is worse off than one who
   * was told there is no one-liner.
   */
  readonly fixCommand?: string;
  /**
   * Scope this finding belongs to, for T1.27's project reports. Carried from
   * the start because adding it later means re-shaping every detector.
   */
  readonly scope?: string;
}

export type FindingCode =
  | 'secret-in-config'
  | 'plugin-install-path-missing'
  | 'plugin-half-removed'
  | 'mcp-server-failed'
  | 'mcp-server-needs-auth'
  | 'orphaned-cache-dir'
  | 'shadowed-entity'
  | 'reconciliation-conflict'
  | 'double-declared-version'
  | 'plugin-validate-failed';

export interface DoctorReport {
  readonly findings: Finding[];
  readonly counts: Record<Severity, number>;
  /**
   * Detector classes that could not run, and why. Distinct from "found
   * nothing": a doctor that silently skips a check reports a clean bill of
   * health it did not earn.
   */
  readonly skipped: Array<{ readonly check: string; readonly reason: string }>;
}

const rank = (severity: Severity): number => SEVERITY_ORDER.indexOf(severity);

/**
 * Case-folded, forward-slashed, no trailing separator — enough to compare two
 * spellings of one path on Windows, where `installPath` and a directory walk
 * can differ in separator and case for the same directory. Deliberately not
 * `normaliseProjectPath`: that is the *project identity* normaliser with its
 * own collision-reporting contract, and borrowing it here would tie cache
 * comparison to a function that exists to answer a different question.
 */
const normalisePath = (value: string): string =>
  value.replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase();

/** Sorts most severe first, then by subject so output is stable across runs. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) => rank(a.severity) - rank(b.severity) || a.subject.localeCompare(b.subject),
  );
}

// ---------------------------------------------------------------------------
// T1.16 🔒 — plaintext secrets
// ---------------------------------------------------------------------------

export interface SecretScanTarget {
  /** Display path of the file the values came from. */
  readonly file: string;
  readonly contents: unknown;
  /** True for a file tracked by git — a committed credential is worse. */
  readonly committed?: boolean;
  readonly scope?: string;
}

/**
 * Turns secret findings into doctor findings.
 *
 * A committed `.mcp.json` is `critical` rather than `warning` because the
 * blast radius is different in kind: a token in `~/.claude.json` is exposed to
 * whoever has the machine, while one in a tracked file is exposed to everyone
 * with repository access and stays in history after the fix. The fix command
 * reflects that — rotating comes first, because editing the file does not
 * un-leak it.
 */
export function secretFindings(targets: readonly SecretScanTarget[]): Finding[] {
  const findings: Finding[] = [];

  for (const target of targets) {
    for (const secret of scanValue(target.contents)) {
      findings.push(toSecretFinding(target, secret));
    }
  }

  return findings;
}

function toSecretFinding(target: SecretScanTarget, secret: SecretFinding): Finding {
  const committed = target.committed === true;
  const where = `${target.file} → ${secret.location}`;

  return {
    code: 'secret-in-config',
    severity: committed ? 'critical' : 'warning',
    subject: where,
    // The redaction, never the value. A doctor report is something users paste
    // into issues; printing the token it just warned about leaks it twice.
    message: `a credential appears in plaintext (${secret.redacted}) — ${secret.evidence}`,
    cause: committed
      ? 'this file is tracked by git, so the credential is exposed to everyone with ' +
        'repository access and remains in history after it is edited out'
      : 'anything that can read this file can use the credential, including any ' +
        'process running as you',
    fixCommand: committed
      ? `# rotate the credential first — editing the file does not un-leak it\n` +
        `# then replace the literal with \${ENV_VAR} and: git rm --cached ${target.file}`
      : `# replace the literal with \${ENV_VAR}; hooks read CLAUDE_PLUGIN_OPTION_* from the environment`,
    ...(target.scope !== undefined ? { scope: target.scope } : {}),
  };
}

// ---------------------------------------------------------------------------
// T1.12 (partial) — plugins whose install is broken
// ---------------------------------------------------------------------------

/**
 * Plugins whose `installPath` is not on disk, and plugins the registry file
 * knows but the CLI does not report.
 *
 * `plugin list --json` carries **no error field** — the key set is
 * `id · version · scope · enabled · installPath · installedAt · lastUpdated ·
 * mcpServers` and nothing else — so "plugin load errors" as the task row
 * imagines them are not reported by the CLI at all. What *is* checkable is
 * whether the directory the CLI names actually exists, which catches the same
 * user-visible symptom by a different route.
 *
 * `pathExists` is injected so this stays pure and testable; the caller does the
 * IO. A plugin with no `installPath` is skipped rather than reported: absence
 * is normal for `--plugin-dir` sideloads.
 */
export function pluginInstallFindings(
  inventory: Inventory,
  existing: ReadonlySet<string>,
): Finding[] {
  const findings: Finding[] = [];

  for (const plugin of inventory.plugins) {
    if (plugin.sources.length === 1 && plugin.sources[0] === 'file') {
      findings.push({
        code: 'plugin-half-removed',
        severity: 'warning',
        subject: plugin.id.name,
        message: 'recorded in installed_plugins.json but not reported by `claude plugin list`',
        cause:
          'an uninstall that did not complete leaves the registry and the CLI disagreeing; ' +
          'the plugin contributes nothing but still occupies a cache directory',
        fixCommand: `claude plugin uninstall ${plugin.id.name}`,
      });
      continue;
    }

    if (plugin.installPath === undefined) continue;
    if (existing.has(plugin.installPath)) continue;

    findings.push({
      code: 'plugin-install-path-missing',
      severity: 'critical',
      subject: plugin.id.name,
      message: `installPath does not exist on disk: ${plugin.installPath}`,
      cause:
        'the plugin is registered and enabled but its files are gone, so every component ' +
        'it contributes silently fails to load',
      fixCommand: `claude plugin install ${plugin.id.name}`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// T1.13 (partial) — MCP servers that do not connect
// ---------------------------------------------------------------------------

/**
 * MCP servers in a bad connection state.
 *
 * **The zero-tools half of T1.13 is not built**, because no CLI output carries
 * a tool count: `mcp get` returns `Scope` and `Status` only. See the module
 * header.
 *
 * `pending-approval` is deliberately **not** a finding. It is a normal state
 * for a project-scope server the user has not yet accepted, it contributes
 * zero always-on cost, and reporting it as a problem would fire on every fresh
 * clone of every repo carrying a `.mcp.json`.
 */
export function mcpFindings(inventory: Inventory): Finding[] {
  const findings: Finding[] = [];

  for (const server of inventory.mcpServers) {
    if (server.connection === 'failed') {
      findings.push({
        code: 'mcp-server-failed',
        severity: 'warning',
        subject: server.id.name,
        message: 'configured but fails to connect',
        cause:
          'its tools are absent from every session while it still costs a startup attempt; ' +
          'a server that never connects is pure overhead',
        fixCommand: `claude mcp get ${server.id.name}`,
        ...(server.id.scope !== undefined ? { scope: server.id.scope } : {}),
      });
      continue;
    }

    if (server.connection === 'needs-auth') {
      findings.push({
        code: 'mcp-server-needs-auth',
        severity: 'info',
        subject: server.id.name,
        message: 'connected but unauthenticated',
        cause: 'its tools are listed but every call fails until authentication completes',
        fixCommand: `claude mcp get ${server.id.name}`,
        ...(server.id.scope !== undefined ? { scope: server.id.scope } : {}),
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// T1.15 — orphaned cache directories
// ---------------------------------------------------------------------------

export interface CacheVersionDir {
  /** Absolute path — compared against `installPath`, never re-parsed. */
  readonly dir: string;
  readonly marketplace: string;
  readonly plugin: string;
  readonly version: string;
  readonly inUseMtimeMs?: number;
}

/**
 * Cache directories holding a version nothing installed refers to.
 *
 * Live example on the reference machine: `superpowers` 6.2.0 installed with
 * 6.1.1 left beside it.
 *
 * **The ~14-day TTL is not asserted.** FORMATS records it as unverified, so
 * this reports the orphan and says Claude Code removes them eventually rather
 * than promising a date it cannot stand behind. Severity is `info` for the
 * same reason: it is disk, not breakage, and the sweeper may well handle it.
 *
 * **`.in_use` presence is not liveness.** An earlier version of this function
 * skipped any version carrying the marker, which silenced it on the exact case
 * the ledger cites — `superpowers` with 6.2.0 installed and 6.1.1 beside it,
 * *both* carrying `.in_use`. FORMATS is precise on the point: `.in_use` is a
 * directory and **its mtime** is the signal, so a marker left over from the
 * last time a version was loaded says nothing about whether it is current.
 *
 * The deciding question is therefore only ever *does an installed plugin refer
 * to this version*. The mtime is reported as supporting detail — it tells the
 * user when the directory was last touched — and never used as a veto.
 */
export function orphanedCacheFindings(
  dirs: readonly CacheVersionDir[],
  installedPaths: ReadonlySet<string>,
): Finding[] {
  const findings: Finding[] = [];
  const live = new Set([...installedPaths].map(normalisePath));

  for (const dir of dirs) {
    // Compared as a PATH, not as a reconstructed `<plugin>@<marketplace>` key.
    // Rebuilding an identity out of directory segments is the same mistake
    // `project-path.ts` refuses to make about `~/.claude/projects/` names: it
    // happens to hold on this machine, and fails silently the first time a
    // cache directory and a plugin id disagree. `installPath` is exact and
    // both layers already carry it.
    if (live.has(normalisePath(dir.dir))) continue;

    const lastUsed =
      dir.inUseMtimeMs !== undefined
        ? `; last loaded ${new Date(dir.inUseMtimeMs).toISOString().slice(0, 10)}`
        : '; never marked in use';

    findings.push({
      code: 'orphaned-cache-dir',
      severity: 'info',
      subject: `${dir.plugin}@${dir.marketplace} ${dir.version}`,
      message: `a cached version no installed plugin refers to${lastUsed}`,
      cause:
        'left behind by an update or an uninstall; it occupies disk and Claude Code removes ' +
        'these on its own schedule, which this tool does not predict',
      fixCommand: `# safe to delete once you are sure nothing pins it:\n` +
        `# ${path.join('~', '.claude', 'plugins', 'cache', dir.marketplace, dir.plugin, dir.version)}`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Findings the inventory already computed
// ---------------------------------------------------------------------------

/**
 * Promotes inventory-level facts into findings.
 *
 * Shadowing, reconciliation conflicts and double declarations are detected in
 * T1.7/T1.8/T1.9 rather than here, because they fall out of the merge. Doctor
 * re-presents them with a severity and a fix so they are actionable rather
 * than merely reported — which is the whole difference between `status` and
 * `doctor`.
 */
export function inventoryFindings(inventory: Inventory): Finding[] {
  const findings: Finding[] = [];

  for (const group of inventory.shadowing) {
    findings.push({
      code: 'shadowed-entity',
      severity: 'warning',
      subject: `${group.kind} ${group.name}`,
      message:
        `defined at ${group.shadowed.length + 1} scopes; the ${group.effective.scope}-scope ` +
        `one wins and ${group.shadowed.map((id) => id.scope).join(', ')} never load`,
      cause:
        'Claude Code shows only the winner, so the masked copies look installed and working ' +
        'while contributing nothing — edits to them have no effect',
      scope: group.effective.scope,
    });
  }

  for (const plugin of inventory.plugins) {
    if (plugin.reconciled !== undefined) {
      const fields = Object.keys(plugin.reconciled).join(', ');
      findings.push({
        code: 'reconciliation-conflict',
        severity: 'warning',
        subject: plugin.id.name,
        message: `the CLI and the registry file disagree about ${fields}`,
        cause:
          'one of the two layers is stale; which one is not decidable from here, so both ' +
          'are recorded rather than one being silently preferred',
        fixCommand: `claude plugin update ${plugin.id.name}`,
      });
    }

    const declared = plugin.version.doubleDeclared;
    if (declared !== undefined) {
      findings.push({
        code: 'double-declared-version',
        severity: 'info',
        subject: plugin.id.name,
        message: `version ${declared.effective} in plugin.json masks ${declared.masked} in the marketplace entry`,
        cause:
          'plugin.json wins silently, so the marketplace entry can go stale indefinitely and ' +
          'anyone reading the catalogue sees a version that is not what installs',
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface DoctorInputs {
  readonly inventory: Inventory;
  readonly secretTargets?: readonly SecretScanTarget[];
  readonly cacheDirs?: readonly CacheVersionDir[];
  /** Install paths confirmed present on disk. The caller does the IO. */
  readonly existingPaths?: ReadonlySet<string>;
  /** Checks the caller could not run, with the reason. */
  readonly skipped?: ReadonlyArray<{ readonly check: string; readonly reason: string }>;
}

/** The checks with no data source in the corpus. Reported, never silently absent. */
export const UNIMPLEMENTED_CHECKS: ReadonlyArray<{ check: string; reason: string }> = [
  {
    check: 'lsp-extension-collisions (T1.14)',
    reason: 'no LSP server exists in the corpus — every `plugin details` reports LSP servers (0)',
  },
  {
    check: 'lsp-binary-on-path (T1.12)',
    reason: 'no LSP server exists in the corpus, so there is no binary to look for',
  },
  {
    check: 'mcp-zero-tools (T1.13)',
    reason: '`mcp get` returns Scope and Status only; no CLI output carries a tool count',
  },
  {
    check: 'always-on-cost-threshold (T1.17)',
    reason: 'needs the `plugin details` cost parser, which is T4.7 and not yet built',
  },
];

export function buildDoctorReport(inputs: DoctorInputs): DoctorReport {
  // The cache directories every installed plugin actually occupies, taken
  // from `installPath` rather than rebuilt from a name.
  const installedPaths = new Set(
    inputs.inventory.plugins
      .map((plugin) => plugin.installPath)
      .filter((p): p is string => p !== undefined),
  );

  const findings = sortFindings([
    ...secretFindings(inputs.secretTargets ?? []),
    ...pluginInstallFindings(inputs.inventory, inputs.existingPaths ?? new Set()),
    ...mcpFindings(inputs.inventory),
    ...orphanedCacheFindings(inputs.cacheDirs ?? [], installedPaths),
    ...inventoryFindings(inputs.inventory),
  ]);

  const counts: Record<Severity, number> = { critical: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;

  // A degraded collector means some check ran against absent data. Saying so
  // is the difference between "nothing found" and "nothing looked".
  const degradedSkips = inputs.inventory.degraded.map((name) => ({
    check: `checks over the ${name} section`,
    reason: `the ${name} collector failed, so this data was not available to examine`,
  }));

  return {
    findings,
    counts,
    skipped: [...UNIMPLEMENTED_CHECKS, ...degradedSkips, ...(inputs.skipped ?? [])],
  };
}
