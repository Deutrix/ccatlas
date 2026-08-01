/**
 * Collector contract and unified entity model — T1.6, T1.22.
 *
 * This file is the vocabulary every collector emits and every service consumes.
 * It is authored once, deliberately, because five collectors inventing five
 * type vocabularies is how the inventory service ends up doing translation
 * instead of reconciliation.
 *
 * Every shape here traces to an observed format in docs/FORMATS.md. Where a
 * field looks over-engineered, it is almost certainly encoding a Phase 0
 * finding — the comment says which. Do not "simplify" one without reading it.
 */

/** Versioned envelope. Every `--json` surface emits this. Skills consume it. */
export const SCHEMA_VERSION = 1 as const;

export interface JsonEnvelope<T> {
  schemaVersion: typeof SCHEMA_VERSION;
  tool: 'ccatlas';
  version: string;
  command: string;
  generatedAt: string;
  /** Non-fatal degradation. A failed collector lands here, never as a throw. */
  warnings: Warning[];
  data: T;
}

export interface Warning {
  code: WarningCode;
  message: string;
  /** Entity or path the warning concerns, when there is one. */
  subject?: string;
}

export type WarningCode =
  | 'collector-failed'      // one collector died; its section is degraded
  | 'partial'               // ok, but knowingly incomplete — an input was absent
  | 'reconciliation'        // CLI and file disagree — T1.8, reported not resolved
  | 'shadowed'              // same name in two scopes — T1.7
  | 'path-collision'        // two project keys normalise to one — 10 of 102 locally
  | 'unverified-estimate'   // token figure may be from the silent fallback
  | 'unsupported-version';  // Claude Code build outside the tested range

/**
 * Provenance. Every fact carries where it came from, because the CLI and the
 * files each hold things the other does not: the CLI alone reports `enabled`
 * and per-plugin `mcpServers`; only installed_plugins.json carries
 * `gitCommitSha`. T1.8 merges them and reports disagreement — it never picks.
 */
export type FactSource = 'cli' | 'file';

export interface Sourced<T> {
  value: T;
  source: FactSource;
  /** Set when cli and file disagreed. Both are kept; neither is discarded. */
  conflictsWith?: { value: T; source: FactSource };
}

// ---------------------------------------------------------------------------
// Identity and scope
// ---------------------------------------------------------------------------

/**
 * `@inline` is a real fifth origin — `--plugin-dir` sideloads surface with
 * scope "session" and no installedAt. They are never exported (bundle D5).
 */
export type Origin =
  | 'marketplace'
  | 'personal'
  | 'project'
  | 'skills-dir'
  | 'inline'
  | 'managed';

export type Scope = 'user' | 'project' | 'local' | 'managed' | 'session';

export type EntityKind =
  | 'plugin' | 'marketplace' | 'skill' | 'agent'
  | 'command' | 'hook' | 'mcp-server' | 'lsp-server';

export type EntityState = 'enabled' | 'disabled' | 'error' | 'shadowed';

/**
 * A plugin is keyed by (id, scope), never by id alone: installed_plugins.json
 * stores an ARRAY per plugin, one element per scope. Reading [0] silently
 * drops scopes. FORMATS.md trap 12.
 */
export interface EntityId {
  /** "<name>@<marketplace>" for plugins; bare name otherwise. */
  name: string;
  scope: Scope;
  kind: EntityKind;
}

// ---------------------------------------------------------------------------
// Version resolution — FORMATS.md §4
// ---------------------------------------------------------------------------

/**
 * Four values, not five. The original design listed "git commit SHA" as a
 * resolution rule; Phase 0 proved no plugin uses a SHA as its version string.
 * gitCommitSha is recorded ALONGSIDE a version, so it is a separate field
 * below — not a member of this union.
 */
export type VersionSource =
  | 'plugin-json'
  | 'marketplace-entry'
  | 'marketplace-source-sha'
  | 'unknown';

export interface VersionInfo {
  /** Literal "unknown" is a valid, meaningful value — not null, not absent. */
  version: string;
  versionSource: VersionSource;
  /** Install coordinate: what `claude plugin install` will fetch. */
  sourceSha?: string;
  /** Drift evidence: what is actually on disk. Diverges from sourceSha. */
  installedSha?: string;
  /** Both version fields set and DIFFERENT. Equal values must not flag. */
  doubleDeclared?: { effective: string; masked: string };
}

/**
 * Polymorphic in real output: bare string in 55 of 276 entries, plus four
 * object shapes. Collectors normalise to this; a reader assuming an object
 * breaks on 20% of entries. FORMATS.md §3.
 */
export interface PluginSource {
  source: string;
  url?: string;
  repo?: string;
  path?: string;
  ref?: string;
  sha?: string;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface Entity {
  id: EntityId;
  origin: Origin;
  state: EntityState;
  source: FactSource;
  /** Set when this entity is shadowed by, or shadows, another. T1.7. */
  shadows?: EntityId[];
  shadowedBy?: EntityId;
}

export interface PluginEntity extends Entity {
  id: EntityId & { kind: 'plugin' };
  marketplace: string;
  enabled: boolean;          // lives in settings.enabledPlugins, not the plugin file
  installPath?: string;
  installedAt?: string;      // absent on sideloads
  lastUpdated?: string;      // absent on sideloads
  version: VersionInfo;
  pluginSource?: PluginSource;
  contributes: ComponentCounts;
  cost?: TokenCost;
}

export interface ComponentCounts {
  skills: number; agents: number; hooks: number;
  mcpServers: number; lspServers: number;
}

/**
 * Token costs are estimates from Claude Code's estimator, and the estimator
 * fails SILENTLY: a bogus model and an unreachable endpoint both return
 * plausible, identically-formatted numbers ~40% off. `regime` records which
 * we believe we got. Any surface rendering these must say so.
 */
export interface TokenCost {
  alwaysOn: number;
  onInvoke?: number;
  regime: 'tokenizer' | 'fallback' | 'unknown';
  model?: string;
  /**
   * True once the roster exceeds the ~30k-char listing cap, above which
   * per-entity always-on figures DO NOT SUM to the session total. Valid for
   * ranking; invalid for addition. FORMATS.md trap 4.
   */
  nonAdditive?: boolean;
}

export interface MarketplaceEntity extends Entity {
  id: EntityId & { kind: 'marketplace' };
  installLocation?: string;
  lastUpdated?: string;
  /**
   * Not every clone is a git checkout: claude-plugins-official ships as a GCS
   * tarball with a .gcs-sha sidecar and no HEAD to read — and it holds 276 of
   * 281 available plugins, so this is the common case.
   */
  /**
   * `unknown` is not a fourth kind of distribution — it means the clone could
   * not be probed. Kept distinct from `git` because T2.2 branches on this, and
   * defaulting an unprobed clone to `git` would send the resolver at a `.git`
   * directory that is not there.
   */
  distribution: 'git' | 'gcs' | 'local' | 'unknown';
  /** Deliberately absent: autoUpdate. No such flag exists. FORMATS.md trap 5. */
}

export interface McpServerEntity extends Entity {
  id: EntityId & { kind: 'mcp-server' };
  /** Set for plugin-bundled servers; canonical form is plugin:<p>:<server>. */
  owningPlugin?: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  /** `Pending approval` is a real state and contributes ZERO always-on cost. */
  connection: 'connected' | 'failed' | 'needs-auth' | 'pending-approval' | 'unknown';
  toolsExposed?: number;
}

// ---------------------------------------------------------------------------
// Project identity — the shared normaliser, T1.3 / T1.25 / T4.6
// ---------------------------------------------------------------------------

/**
 * ONE implementation, consumed by the mcp collector, the projects module, and
 * analytics attribution. Built twice, they will disagree about what a project
 * is — and the disagreement is not hypothetical: ~/.claude.json holds 102
 * project keys of which 10 collide once lowercased and separator-normalised
 * (72 forward-slash, 30 backslash, two drive letters).
 *
 * Collisions are REPORTED, never silently merged: the colliding entries carry
 * divergent state, and picking one loses real configuration.
 */
export interface ProjectRef {
  /** Normalised key: lowercase, forward slashes, no trailing separator. */
  key: string;
  /** The raw key(s) as they appear on disk. More than one means a collision. */
  rawKeys: string[];
  /** Never reconstructed from the projects/ directory name — that is lossy. */
  displayPath: string;
  collides: boolean;
}

// ---------------------------------------------------------------------------
// Collector contract
// ---------------------------------------------------------------------------

/**
 * Collectors are read-only and pure. They never write, never mutate, and never
 * throw across this boundary: a failure is a value, so that one broken
 * collector degrades one report section rather than the run.
 */
export interface CollectorResult<T> {
  ok: boolean;
  data: T | null;
  warnings: Warning[];
  /** Populated when ok === false. The run continues regardless. */
  error?: { code: string; message: string };
  /** Wall-clock ms, for the T1.11 perf budget. */
  elapsedMs: number;
}

export interface Collector<T> {
  /**
   * `registry` is the sixth, added at T1.8: `installed_plugins.json` carries
   * `gitCommitSha`, which the CLI does not expose at all, so the file layer is
   * a genuine second input rather than a fallback. Reconciliation with one
   * input is not reconciliation. See `collectors/registry.ts`.
   */
  readonly name: 'cli' | 'config' | 'mcp' | 'registry' | 'skills' | 'transcripts';
  collect(ctx: CollectContext): Promise<CollectorResult<T>>;
}

export interface CollectContext {
  /**
   * Fixture root — **the repository's `fixtures/` directory**, not a $HOME
   * substitute. Collectors map e.g. `<fixtureRoot>/files/claude-json-structure.json`
   * and `<fixtureRoot>/cli/<version>/mcp-list.txt`. Set in tests; collectors
   * must never hit the real machine when it is present.
   */
  fixtureRoot?: string;
  /** Guarantees zero egress when true. Asserted in tests. */
  offline: boolean;
  claudeCodeVersion?: string;
  /** Present for project-scoped collection (F9). */
  project?: ProjectRef;
}
