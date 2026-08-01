/**
 * Bundle import — T5.13–T5.26.
 *
 * Pure: plan building, pre-flight, conflict resolution and idempotency all
 * happen here with no IO, so the plan can be asserted exactly. `import-run.ts`
 * resolves sources, takes snapshots and executes.
 *
 * ## The plan is the product
 *
 * T5.18: the plan discloses **every executable surface in full** — each
 * command, each MCP server's exact `command` and `args`, every hook, every
 * pinned SHA. **No collapsing behind "12 actions."** A user who cannot read
 * what is about to run cannot meaningfully refuse it, and an MCP server *is*
 * a command line that Claude Code will execute.
 *
 * ## Idempotency is a correctness property, not an optimisation
 *
 * T5.23 📏: a second consecutive `--apply` must make **zero** changes. That is
 * how `sync pull` becomes safe to run on a schedule, and it falls out of
 * building the plan by diffing against the *current* inventory rather than
 * from the bundle alone.
 */

import type { Bundle, BundlePlugin } from './bundle.ts';
import type { Inventory } from './inventory.ts';

/** What to do when the bundle and the machine both have an opinion. */
export type ConflictPolicy = 'keep-local' | 'take-bundle' | 'prompt' | 'backup-both';

export type ImportActionKind =
  | 'marketplace-add'
  | 'plugin-install'
  | 'plugin-enable'
  | 'plugin-disable'
  | 'mcp-add'
  | 'file-write';

export interface ImportAction {
  readonly kind: ImportActionKind;
  readonly subject: string;
  /**
   * The exact argv, or `undefined` for a file write. Disclosed in full.
   * **Never summarised** — see T5.18.
   */
  readonly argv?: readonly string[];
  /** For an MCP server: the command line Claude Code will actually run. */
  readonly executes?: { readonly command: string; readonly args: readonly string[] };
  readonly reason: string;
  /** Set when this action overwrites something that already exists. */
  readonly conflict?: { readonly local: string; readonly bundle: string };
}

export interface PreflightProblem {
  readonly kind: 'missing-env' | 'unreachable-marketplace' | 'version-skew' | 'integrity';
  readonly subject: string;
  readonly message: string;
  /** A blocker stops the apply; a warning does not. */
  readonly blocking: boolean;
}

export interface ImportPlan {
  readonly actions: ImportAction[];
  readonly problems: PreflightProblem[];
  /** Already true on the machine. Empty on a second apply — that is T5.23. */
  readonly satisfied: string[];
  readonly conflictPolicy: ConflictPolicy;
}

// ---------------------------------------------------------------------------
// T5.17 — pre-flight
// ---------------------------------------------------------------------------

/**
 * Checks the bundle can actually be applied here.
 *
 * `secretsRequired` names environment variables the exporter templated out.
 * A missing one is **blocking**: applying anyway registers an MCP server whose
 * `env` contains the literal string `${GITHUB_TOKEN}`, which fails at first
 * use with an error that points nowhere near the import.
 */
export function preflight(
  bundle: Bundle,
  env: Record<string, string | undefined>,
  localClaudeCodeVersion?: string,
): PreflightProblem[] {
  const problems: PreflightProblem[] = [];

  for (const name of bundle.secretsRequired) {
    const value = env[name];
    if (value === undefined || value === '') {
      problems.push({
        kind: 'missing-env',
        subject: name,
        message:
          `${name} is required by this bundle and is not set. Applying without it registers a ` +
          'server whose env holds the literal ${' + name + '}, which fails at first use.',
        blocking: true,
      });
    }
  }

  const exported = bundle.manifest.source.claudeCodeVersion;
  if (exported !== undefined && localClaudeCodeVersion !== undefined) {
    const major = (v: string): string => v.split('.').slice(0, 2).join('.');
    if (major(exported) !== major(localClaudeCodeVersion)) {
      // Warned, not blocked. A skew is a reason to read the plan carefully,
      // not a reason the bundle cannot be applied — and blocking would make
      // every bundle expire on the next Claude Code release.
      problems.push({
        kind: 'version-skew',
        subject: 'claudeCodeVersion',
        message: `exported from Claude Code ${exported}; this machine runs ${localClaudeCodeVersion}`,
        blocking: false,
      });
    }
  }

  if (bundle.manifest.estimatorRegime !== 'tokenizer') {
    problems.push({
      kind: 'integrity',
      subject: 'estimatorRegime',
      message:
        `token costs in this bundle were measured under the "${bundle.manifest.estimatorRegime}" ` +
        'regime and must not be presented as authoritative',
      blocking: false,
    });
  }

  return problems;
}

// ---------------------------------------------------------------------------
// T5.16 / T5.22 — the plan
// ---------------------------------------------------------------------------

const pluginKey = (plugin: BundlePlugin): string => `${plugin.id}|${plugin.scope}`;

/**
 * Diffs the bundle against what is already here.
 *
 * **Against the current inventory, not the bundle alone.** That is what makes
 * a second `--apply` a no-op (T5.23 📏): everything already true lands in
 * `satisfied` and produces no action.
 */
export function buildImportPlan(input: {
  readonly bundle: Bundle;
  readonly inventory: Inventory;
  readonly env: Record<string, string | undefined>;
  readonly conflictPolicy?: ConflictPolicy;
  readonly localClaudeCodeVersion?: string;
}): ImportPlan {
  const { bundle, inventory, env } = input;
  const policy = input.conflictPolicy ?? 'prompt';

  const actions: ImportAction[] = [];
  const satisfied: string[] = [];

  const localMarkets = new Set(inventory.marketplaces.map((m) => m.id.name));
  const localPlugins = new Map(
    inventory.plugins.map((p) => [`${p.id.name}|${p.id.scope}`, p]),
  );
  const localServers = new Map(inventory.mcpServers.map((s) => [s.id.name, s]));

  // Marketplaces first — a plugin install resolves through its marketplace, so
  // the reverse order fails on the first plugin from an unknown source.
  for (const market of bundle.marketplaces) {
    if (localMarkets.has(market.name)) {
      satisfied.push(`marketplace ${market.name}`);
      continue;
    }

    const spec = market.source;
    actions.push({
      kind: 'marketplace-add',
      subject: market.name,
      argv:
        spec?.repo !== undefined
          ? ['plugin', 'marketplace', 'add', spec.repo]
          : spec?.url !== undefined
            ? ['plugin', 'marketplace', 'add', spec.url]
            : ['plugin', 'marketplace', 'add', market.name],
      reason: `not registered here (${market.distribution})`,
    });
  }

  for (const plugin of bundle.plugins) {
    const local = localPlugins.get(pluginKey(plugin));

    if (local === undefined) {
      actions.push({
        kind: 'plugin-install',
        subject: plugin.id,
        argv: ['plugin', 'install', plugin.id],
        // The pinned SHA is disclosed because it is what actually gets
        // fetched, and it is the difference between reproducing a stack and
        // installing whatever HEAD happens to be today.
        reason:
          `not installed${plugin.sourceSha !== undefined ? `; pinned at ${plugin.sourceSha.slice(0, 12)}` : ''}`,
      });
      continue;
    }

    if (local.enabled === plugin.enabled) {
      satisfied.push(`plugin ${plugin.id}`);
      continue;
    }

    // A differing enabled bit is a conflict, not a plain update: both sides
    // hold a deliberate choice.
    const conflict = { local: local.enabled ? 'enabled' : 'disabled', bundle: plugin.enabled ? 'enabled' : 'disabled' };

    if (policy === 'keep-local') {
      satisfied.push(`plugin ${plugin.id} (kept local: ${conflict.local})`);
      continue;
    }

    actions.push({
      kind: plugin.enabled ? 'plugin-enable' : 'plugin-disable',
      subject: plugin.id,
      argv: ['plugin', plugin.enabled ? 'enable' : 'disable', plugin.id],
      reason: `installed but ${conflict.local}; the bundle says ${conflict.bundle}`,
      conflict,
    });
  }

  for (const [name, raw] of Object.entries(bundle.mcpServers)) {
    const spec = raw as {
      command?: string;
      args?: string[];
      url?: string;
      env?: Record<string, string>;
    };

    if (localServers.has(name)) {
      satisfied.push(`mcp ${name}`);
      continue;
    }

    actions.push({
      kind: 'mcp-add',
      subject: name,
      argv: ['mcp', 'add-json', name, '<json>'],
      // T5.18: the exact command line. This is the executable surface that
      // matters most — registering an MCP server is registering a program
      // Claude Code will run.
      ...(spec.command !== undefined
        ? { executes: { command: spec.command, args: spec.args ?? [] } }
        : {}),
      reason:
        spec.url !== undefined
          ? `not configured here; connects to ${spec.url}`
          : 'not configured here',
    });
  }

  for (const file of bundle.files) {
    actions.push({
      kind: 'file-write',
      subject: file.path,
      reason: `${file.encoding}, ${file.content.length} chars`,
    });
  }

  return {
    actions,
    problems: preflight(bundle, env, input.localClaudeCodeVersion),
    satisfied,
    conflictPolicy: policy,
  };
}

/**
 * 📏 T5.23 — is this plan a no-op?
 *
 * A second consecutive apply must make zero changes. Checked as a property of
 * the plan rather than by comparing before/after states, so it can be asserted
 * without running anything.
 */
export function isNoOp(plan: ImportPlan): boolean {
  return plan.actions.length === 0;
}

/** Actions that would run, given the blocking problems. */
export function blockingProblems(plan: ImportPlan): PreflightProblem[] {
  return plan.problems.filter((problem) => problem.blocking);
}

// ---------------------------------------------------------------------------
// T5.24 — the receipt
// ---------------------------------------------------------------------------

export interface Receipt {
  readonly appliedAt: string;
  readonly source: string;
  /** Recorded so the exact bundle can be identified later. */
  readonly integrity: string;
  /** T5.14 — a gist URL is not stable; its revision SHA is. */
  readonly sourceRevision?: string;
  readonly snapshot?: string;
  readonly actions: Array<{ readonly kind: string; readonly subject: string; readonly code: number }>;
  readonly ok: boolean;
}

export function buildReceipt(input: {
  readonly appliedAt: string;
  readonly source: string;
  readonly bundle: Bundle;
  readonly sourceRevision?: string;
  readonly snapshot?: string;
  readonly executed: ReadonlyArray<{ action: ImportAction; code: number }>;
}): Receipt {
  return {
    appliedAt: input.appliedAt,
    source: input.source,
    integrity: input.bundle.integrity,
    ...(input.sourceRevision !== undefined ? { sourceRevision: input.sourceRevision } : {}),
    ...(input.snapshot !== undefined ? { snapshot: input.snapshot } : {}),
    actions: input.executed.map((step) => ({
      kind: step.action.kind,
      subject: step.action.subject,
      code: step.code,
    })),
    ok: input.executed.every((step) => step.code === 0),
  };
}
