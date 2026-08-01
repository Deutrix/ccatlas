/**
 * Bundle schema v1 — T5.1–T5.12. **The schema is frozen** (`docs/05-bundle-schema.md`).
 *
 * Every field here traces to a decision of record in that document, and the
 * nine decisions are load-bearing rather than stylistic. The ones that shape
 * this file most:
 *
 * - **D3.** Both SHAs are recorded and they do different jobs. `sourceSha` is
 *   the *install coordinate* — what `claude plugin install` will fetch.
 *   `installedSha` is *drift evidence* — what is actually on disk. They
 *   diverge on 2 of 5 plugins on the reference machine, so recording only one
 *   loses either reproducibility or the ability to see a stale pin.
 * - **D4.** Plugins are keyed by `(id, scope)`. `installed_plugins.json`
 *   stores an array per plugin, one element per scope.
 * - **D5.** `@inline` sideloads are never exported — they are `scope:
 *   "session"`, have no `installedAt`, and are not reproducible state.
 * - **D8.** Unknown fields are preserved and warned about, never dropped. A
 *   v1 reader meeting a v1.x field must round-trip it intact.
 *
 * ## Fail closed 🔒
 *
 * T5.6: if a detected secret cannot be safely templated to `${VAR}`, the
 * export **fails** unless `--allow-secrets` is passed. Not a warning, not a
 * redaction — a refusal. A bundle is a thing people commit and share, and the
 * cost of shipping a live token is unbounded.
 */

import { createHash } from 'node:crypto';

import { inspectValue, scanValue } from '../util/secrets.ts';
import type { SecretFinding } from '../util/secrets.ts';
import type { Inventory, MergedPlugin } from './inventory.ts';
import type { McpServerEntity, PluginSource } from '../types.ts';

export const BUNDLE_SCHEMA_VERSION = 1;
export const BUNDLE_KIND = 'ccatlas.bundle/1';

/** 📏 T5.3 caps. Enforced, not documented. */
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;

export interface BundleManifest {
  readonly generatedAt: string;
  readonly generatedBy: string;
  readonly source: {
    readonly hostname: string;
    readonly os: string;
    readonly claudeCodeVersion?: string;
  };
  readonly counts: Record<string, number>;
  readonly includes: string[];
  /** §6 — a bundle carrying `fallback` must not present costs as authoritative. */
  readonly estimatorRegime: 'tokenizer' | 'fallback' | 'unknown';
}

export interface BundleMarketplace {
  readonly name: string;
  readonly source?: PluginSource;
  readonly distribution: 'git' | 'gcs' | 'local' | 'unknown';
  readonly scope: string;
}

export interface BundlePlugin {
  readonly id: string;
  readonly scope: string;
  readonly enabled: boolean;
  readonly version: string;
  readonly versionSource: string;
  readonly sourceSha?: string;
  readonly installedSha?: string;
  readonly config?: Record<string, unknown>;
}

export interface BundleFile {
  readonly path: string;
  readonly encoding: 'utf8' | 'base64';
  readonly content: string;
}

export interface Bundle {
  readonly schemaVersion: number;
  readonly kind: string;
  readonly manifest: BundleManifest;
  readonly marketplaces: BundleMarketplace[];
  readonly plugins: BundlePlugin[];
  readonly mcpServers: Record<string, unknown>;
  readonly settings: Record<string, unknown>;
  readonly files: BundleFile[];
  readonly project?: Record<string, unknown>;
  /** Env vars the importer must supply. Names only — never values. */
  readonly secretsRequired: string[];
  readonly signature: string | null;
  readonly integrity: string;
}

// ---------------------------------------------------------------------------
// §4 — exclusions, enforced rather than documented
// ---------------------------------------------------------------------------

/**
 * Never exported, under any flag.
 *
 * `--allow-secrets` does **not** unlock these. It exists for a value that
 * could not be templated, not for the credential store itself: exporting
 * `.credentials.json` is not a judgement call a user should be able to make by
 * accident, and transcripts carry conversation content plus full hook command
 * lines in `attachment.hook_success.command`.
 */
export const NEVER_EXPORTED: readonly string[] = [
  '.credentials.json',
  'sessions/',
  'history.jsonl',
  'todos/',
  'statsig/',
  'plugins/cache/',
  'projects/',
  'shell-snapshots/',
];

export function isExcluded(relativePath: string): boolean {
  const normalised = relativePath.replace(/\\/gu, '/').toLowerCase();
  return NEVER_EXPORTED.some(
    (excluded) =>
      normalised === excluded.toLowerCase().replace(/\/$/u, '') ||
      normalised.startsWith(excluded.toLowerCase()) ||
      normalised.includes(`/${excluded.toLowerCase()}`),
  );
}

/**
 * §5 — the settings allowlist.
 *
 * Only user-scope keys with portable meaning. `env` is excluded outright, and
 * `autoUpdates`/`autoUpdatesChannel` govern the **CLI self-updater** rather
 * than stack state — the naming trap that also caught T2.6.
 */
export const SETTINGS_ALLOWLIST: readonly string[] = [
  'enabledPlugins',
  'extraKnownMarketplaces',
  'pluginConfigs',
  'permissions',
  'alwaysThinkingEnabled',
  'effortLevel',
  'model',
  'outputStyle',
  'statusLine',
  'hooks',
];

export function allowlistSettings(settings: Record<string, unknown>): {
  kept: Record<string, unknown>;
  dropped: string[];
} {
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(settings)) {
    if (!SETTINGS_ALLOWLIST.includes(key)) {
      dropped.push(key);
      continue;
    }
    kept[key] = value;
  }

  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// 🔒 T5.5 / T5.6 — templating, and failing closed
// ---------------------------------------------------------------------------

export interface TemplateOutcome {
  readonly value: unknown;
  /** Env var names the importer must supply. */
  readonly required: string[];
  /** Secrets that could NOT be templated. Non-empty means fail closed. */
  readonly untemplatable: SecretFinding[];
}

/**
 * Turns a literal secret into `${VAR}` where the shape allows it.
 *
 * A value sitting in `env.GITHUB_TOKEN` templates cleanly to
 * `${GITHUB_TOKEN}`: the key names the variable, so the importer knows what to
 * supply. A secret embedded **inside** a larger string — a password in a
 * connection URL, a PEM block, a `Bearer …` header value — has no such name,
 * and inventing one would produce a bundle that silently does not work.
 *
 * Those are reported as untemplatable, which is what makes the export fail.
 */
export function templateSecrets(
  root: unknown,
  basePath = '',
): TemplateOutcome {
  const required: string[] = [];
  const untemplatable: SecretFinding[] = [];

  const walk = (node: unknown, path: string, key: string | undefined): unknown => {
    if (typeof node === 'string') {
      const finding = inspectValue(path, node);
      if (finding === undefined) return node;

      // Templatable only when an env-var-shaped KEY names it. `shape` findings
      // — a URL with a password, a PEM block — are embedded in a larger
      // string and have no name to template to.
      const nameable =
        key !== undefined && /^[A-Z][A-Z0-9_]*$/u.test(key) && !finding.heuristics.includes('shape');

      if (!nameable) {
        untemplatable.push(finding);
        return node;
      }

      required.push(key);
      return `\${${key}}`;
    }

    if (Array.isArray(node)) return node.map((item, i) => walk(item, `${path}[${i}]`, undefined));

    if (typeof node === 'object' && node !== null) {
      return Object.fromEntries(
        Object.entries(node).map(([k, v]) => [k, walk(v, path === '' ? k : `${path}.${k}`, k)]),
      );
    }

    return node;
  };

  return { value: walk(root, basePath, undefined), required: [...new Set(required)], untemplatable };
}

export interface ExportRefusal {
  readonly refused: true;
  readonly reason: string;
  readonly findings: SecretFinding[];
}

/**
 * 🔒 T5.6 — the fail-closed gate.
 *
 * Returns a refusal rather than throwing, so the caller renders it. The
 * override is `--allow-secrets`, which is deliberately *not* the same flag as
 * anything else: a user who wants a bundle containing a live credential has to
 * say precisely that.
 */
export function secretGate(
  untemplatable: readonly SecretFinding[],
  allowSecrets: boolean,
): ExportRefusal | undefined {
  if (untemplatable.length === 0) return undefined;
  if (allowSecrets) return undefined;

  return {
    refused: true,
    reason:
      `${untemplatable.length} credential(s) could not be safely templated to \${VAR} and the ` +
      'export was refused. A bundle is something people commit and share, so shipping a live ' +
      'token has unbounded cost. Move the value to an environment variable, or pass ' +
      '--allow-secrets if you have decided this bundle stays private.',
    findings: [...untemplatable],
  };
}

// ---------------------------------------------------------------------------
// §7 — canonical JSON and integrity
// ---------------------------------------------------------------------------

/**
 * Canonical JSON: keys sorted at every level, no insignificant whitespace.
 *
 * §7 is explicit that this must be specified precisely enough that two
 * implementations agree, "or `--verify` is theatre". Sorting is by code unit —
 * `Array.prototype.sort`'s default — because a locale-aware sort would make
 * the digest depend on the exporting machine's locale.
 */
export function canonicalise(value: unknown): string {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === 'object' && node !== null) {
      return Object.fromEntries(
        Object.keys(node as Record<string, unknown>)
          .sort()
          .map((key) => [key, walk((node as Record<string, unknown>)[key])]),
      );
    }
    return node;
  };

  return JSON.stringify(walk(value));
}

/** `sha256` over the canonical form with `integrity` and `signature` removed. */
export function computeIntegrity(bundle: Omit<Bundle, 'integrity' | 'signature'>): string {
  const hash = createHash('sha256').update(canonicalise(bundle), 'utf8').digest('hex');
  return `sha256:${hash}`;
}

export function verifyIntegrity(bundle: Bundle): boolean {
  const { integrity, signature, ...rest } = bundle;
  void signature;
  return computeIntegrity(rest as Omit<Bundle, 'integrity' | 'signature'>) === integrity;
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

export interface BuildBundleInputs {
  readonly inventory: Inventory;
  readonly settings: Record<string, unknown>;
  readonly mcpServers: readonly McpServerEntity[];
  readonly files: readonly BundleFile[];
  readonly generatedAt: string;
  readonly generatedBy: string;
  readonly os: string;
  readonly claudeCodeVersion?: string;
  /** Hostname is `<REDACTED>` unless the caller explicitly allows it. */
  readonly hostname?: string;
  readonly allowSecrets?: boolean;
}

export type BuildResult =
  | { readonly ok: true; readonly bundle: Bundle; readonly warnings: string[] }
  | { readonly ok: false; readonly refusal: ExportRefusal };

export function buildBundle(inputs: BuildBundleInputs): BuildResult {
  const warnings: string[] = [];

  // D5: `@inline` sideloads are never exported.
  const exportable = inputs.inventory.plugins.filter((plugin) => {
    if (plugin.origin === 'inline' || plugin.id.scope === 'session') {
      warnings.push(`${plugin.id.name}: a --plugin-dir sideload, not reproducible state (D5)`);
      return false;
    }
    return true;
  });

  const { kept: settings, dropped } = allowlistSettings(inputs.settings);
  if (dropped.length > 0) {
    warnings.push(`settings keys held back as machine-specific or non-portable: ${dropped.join(', ')}`);
  }

  // Template the two places credentials live before anything is assembled.
  const mcpRecord: Record<string, unknown> = {};
  for (const server of inputs.mcpServers) {
    mcpRecord[server.id.name] = {
      scope: server.id.scope,
      type: server.transport,
      ...(server.command !== undefined ? { command: server.command } : {}),
      ...(server.args !== undefined ? { args: server.args } : {}),
      ...(server.url !== undefined ? { url: server.url } : {}),
      ...(server.env !== undefined ? { env: server.env } : {}),
    };
  }

  const mcpTemplated = templateSecrets(mcpRecord, 'mcpServers');
  const settingsTemplated = templateSecrets(settings, 'settings');

  const untemplatable = [...mcpTemplated.untemplatable, ...settingsTemplated.untemplatable];
  const refusal = secretGate(untemplatable, inputs.allowSecrets ?? false);
  if (refusal !== undefined) return { ok: false, refusal };

  if (untemplatable.length > 0) {
    warnings.push(
      `--allow-secrets: ${untemplatable.length} live credential(s) are in this bundle. ` +
        'Treat it as a secret itself.',
    );
  }

  const plugins: BundlePlugin[] = exportable.map((plugin) => toBundlePlugin(plugin));

  const marketplaces: BundleMarketplace[] = inputs.inventory.marketplaces.map((market) => ({
    name: market.id.name,
    ...(market.source !== undefined && typeof market.source !== 'string'
      ? {}
      : {}),
    distribution: market.distribution,
    scope: market.id.scope,
  }));

  const rest = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    kind: BUNDLE_KIND,
    manifest: {
      generatedAt: inputs.generatedAt,
      generatedBy: inputs.generatedBy,
      source: {
        // Redacted by default — the hostname is machine identity, not stack.
        hostname: inputs.hostname ?? '<REDACTED>',
        os: inputs.os,
        ...(inputs.claudeCodeVersion !== undefined
          ? { claudeCodeVersion: inputs.claudeCodeVersion }
          : {}),
      },
      counts: {
        marketplaces: marketplaces.length,
        plugins: plugins.length,
        skills: inputs.inventory.skills.length,
        mcpServers: Object.keys(mcpRecord).length,
      },
      includes: ['marketplaces', 'plugins', 'mcp', 'settings', 'files'],
      // §6: never claimed as `tokenizer` on the exporter's say-so. The two
      // regimes are indistinguishable in `plugin details` output and differ by
      // ~40%, so an unearned label would make an import trust a wrong number.
      estimatorRegime: 'unknown' as const,
    },
    marketplaces,
    plugins,
    mcpServers: mcpTemplated.value as Record<string, unknown>,
    settings: settingsTemplated.value as Record<string, unknown>,
    files: [...inputs.files],
    secretsRequired: [...new Set([...mcpTemplated.required, ...settingsTemplated.required])].sort(),
  };

  return {
    ok: true,
    bundle: { ...rest, signature: null, integrity: computeIntegrity(rest) },
    warnings,
  };
}

/** D3 and D4 in one place: both SHAs, keyed by (id, scope). */
function toBundlePlugin(plugin: MergedPlugin): BundlePlugin {
  return {
    id: plugin.id.name,
    scope: plugin.id.scope,
    enabled: plugin.enabled,
    version: plugin.version.version,
    versionSource: plugin.version.versionSource,
    ...(plugin.version.sourceSha !== undefined ? { sourceSha: plugin.version.sourceSha } : {}),
    ...(plugin.version.installedSha !== undefined
      ? { installedSha: plugin.version.installedSha }
      : {}),
  };
}

/**
 * 📏 T5.3 — the size caps.
 *
 * Checked against the serialised bundle rather than the sum of its parts,
 * because the JSON envelope and base64 expansion are both real bytes that a
 * per-file check would miss.
 */
export function checkSizeCaps(bundle: Bundle): string[] {
  const problems: string[] = [];

  for (const file of bundle.files) {
    const bytes = Buffer.byteLength(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
    if (bytes > MAX_FILE_BYTES) {
      problems.push(`${file.path} is ${(bytes / 1024).toFixed(0)}KB, over the 1MB per-file cap`);
    }
  }

  const total = Buffer.byteLength(JSON.stringify(bundle), 'utf8');
  if (total > MAX_BUNDLE_BYTES) {
    problems.push(`the bundle is ${(total / 1024 / 1024).toFixed(1)}MB, over the 10MB cap`);
  }

  return problems;
}

/** Every secret finding in an assembled bundle. The T5.7 fuzz gate reads this. */
export function auditBundle(bundle: Bundle): SecretFinding[] {
  return scanValue(bundle);
}
