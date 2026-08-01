/**
 * `status` renderers — T1.21. Tree (default) and flat.
 *
 * There is deliberately **no third renderer for JSON**: `--json` serialises the
 * envelope directly. A JSON path that went through a formatter would drift
 * from the schema skills consume, and the schema is the contract — the table
 * layout is not.
 *
 * ## The rule these renderers exist to honour
 *
 * A section that is empty because a collector broke must not look like a
 * section that is empty because there is nothing there. `isolate.ts` and
 * `buildInventory` both go out of their way to keep those distinguishable;
 * a renderer that prints `Plugins: 0` for both throws that away at the last
 * step, which is the most expensive place to lose it — it is what the user
 * actually sees.
 *
 * So a degraded section renders as `unavailable` with its reason, never as a
 * zero, and warnings are printed rather than counted.
 */

import type { DoctorReport, Severity } from '../services/doctor.ts';
import type { ApplyPlan, ExecutedAction } from '../services/apply.ts';
import type { UpdatesReport } from '../services/updates.ts';
import type { Inventory, MergedPlugin } from '../services/inventory.ts';
import type { StatusResult } from '../services/status.ts';

/** ANSI, applied only when the caller says colour is wanted. */
const CODES = {
  reset: '[0m',
  dim: '[2m',
  bold: '[1m',
  red: '[31m',
  yellow: '[33m',
  green: '[32m',
} as const;

type Style = keyof Omit<typeof CODES, 'reset'>;

const paint = (color: boolean) => (text: string, style: Style): string =>
  color ? `${CODES[style]}${text}${CODES.reset}` : text;

export interface RenderOptions {
  readonly color: boolean;
  readonly verbose: boolean;
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/**
 * Describes a section's contents, or why it has none.
 *
 * `degraded` is checked before `count === 0`, which is the whole point: the
 * two produce different text.
 */
function describeSection(
  inventory: Inventory,
  label: string,
  count: number,
  collectors: readonly string[],
): { text: string; broken: boolean } {
  const broken = collectors.filter((name) => inventory.degraded.includes(name));
  if (broken.length > 0) {
    // A section can be degraded and still hold real rows: a machine whose
    // `cli` collector died still has everything the registry file knows. The
    // count is stated alongside the failure rather than suppressed, because
    // hiding data we actually have is its own kind of wrong answer — the
    // header's job is to stop the number being read as complete.
    const partial = count > 0 ? `, ${count} known from the other source` : '';
    return { text: `${label}: unavailable (${broken.join(', ')} failed${partial})`, broken: true };
  }

  const incomplete = collectors.filter((name) => inventory.partial.includes(name));
  const suffix = incomplete.length > 0 ? ' (incomplete)' : '';
  return { text: `${label}: ${count}${suffix}`, broken: false };
}

/**
 * Per-section outcome and cost. Only under `--verbose`, which is what the flag
 * promises: per-section detail *and* timings.
 */
function sectionLines(inventory: Inventory, options: RenderOptions): string[] {
  if (!options.verbose || inventory.sections.length === 0) return [];

  const c = paint(options.color);
  const lines = ['', c('Collectors', 'bold')];

  for (const section of [...inventory.sections].sort((a, b) => b.elapsedMs - a.elapsedMs)) {
    const style: Style = section.status === 'failed' ? 'red' : section.status === 'partial' ? 'yellow' : 'green';
    const detail = section.error !== undefined ? ` — ${section.error}` : '';
    lines.push(`  ${section.name.padEnd(9)} ${c(section.status.padEnd(7), style)} ${section.elapsedMs}ms${detail}`);
  }

  // Sorted slowest first and totalled, so a section that dominates the T1.11
  // budget is attributable rather than merely felt. Not the sum of the parts:
  // the collectors run concurrently.
  lines.push(c(`  ${'total'.padEnd(9)} ${''.padEnd(7)} ${inventory.elapsedMs}ms wall clock`, 'dim'));
  return lines;
}

const versionOf = (plugin: MergedPlugin): string => {
  const { version, versionSource, doubleDeclared } = plugin.version;
  const shown = versionSource === 'marketplace-source-sha' ? `${version.slice(0, 8)} (sha)` : version;
  return doubleDeclared !== undefined ? `${shown} (masks ${doubleDeclared.masked})` : shown;
};

function header(result: StatusResult, options: RenderOptions): string[] {
  const c = paint(options.color);
  const { inventory } = result;

  const source =
    result.origin === 'cache'
      ? `cached ${result.cachedAt ?? ''}`.trim()
      : `collected in ${inventory.elapsedMs}ms`;

  // The scope is named, always. T1.24's whole subject is that global is one
  // value of an axis — an axis the reader cannot see is one they will forget
  // is there, and a project report that looks identical to a global one is
  // worse than no project report.
  const scope =
    result.target.kind === 'project' ? `project ${result.target.path}` : 'global';

  const lines = [`${c('ccatlas status', 'bold')} ${c(`— ${scope} · ${source}`, 'dim')}`];
  if (result.cacheMiss !== undefined) {
    lines.push(c(`  --cached not honoured: ${result.cacheMiss}`, 'yellow'));
  }
  return lines;
}

/**
 * Prints warnings in full.
 *
 * Not summarised as a count, and not hidden behind `--verbose`. A
 * reconciliation warning says the CLI and the files disagree about the machine
 * the user is standing on; "3 warnings" is not that information, it is the
 * absence of it.
 */
function warningLines(inventory: Inventory, options: RenderOptions): string[] {
  if (inventory.warnings.length === 0) return [];

  const c = paint(options.color);
  const lines = ['', c('Warnings', 'bold')];

  for (const warning of inventory.warnings) {
    const style: Style = warning.code === 'collector-failed' ? 'red' : 'yellow';
    const tag = warning.collector !== undefined ? `${warning.collector}/${warning.code}` : warning.code;
    lines.push(`  ${c(tag, style)} ${warning.message}`);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Tree — the default
// ---------------------------------------------------------------------------

export function renderTree(result: StatusResult, options: RenderOptions): string {
  const c = paint(options.color);
  const { inventory } = result;
  const lines = header(result, options);

  const sections = [
    { label: 'Marketplaces', count: inventory.marketplaces.length, collectors: ['cli', 'registry'] },
    { label: 'Plugins', count: inventory.plugins.length, collectors: ['cli', 'registry'] },
    { label: 'Skills', count: inventory.skills.length, collectors: ['skills'] },
    { label: 'Agents', count: inventory.agents.length, collectors: ['skills'] },
    { label: 'Commands', count: inventory.commands.length, collectors: ['skills'] },
    { label: 'MCP servers', count: inventory.mcpServers.length, collectors: ['mcp', 'cli'] },
  ];

  lines.push('');
  for (const section of sections) {
    const described = describeSection(inventory, section.label, section.count, section.collectors);
    lines.push(described.broken ? c(described.text, 'red') : described.text);
  }

  // Rendered whenever there are rows, degraded `cli` included. A registry-only
  // machine has real plugins and hiding them would discard data we hold; the
  // section header above is what stops the list reading as complete.
  if (inventory.plugins.length > 0) {
    lines.push('', c('Plugins', 'bold'));
    const byMarketplace = new Map<string, MergedPlugin[]>();
    for (const plugin of inventory.plugins) {
      const key = plugin.marketplace === '' ? '(no marketplace)' : plugin.marketplace;
      const existing = byMarketplace.get(key);
      if (existing) existing.push(plugin);
      else byMarketplace.set(key, [plugin]);
    }

    const markets = [...byMarketplace.entries()].sort(([a], [b]) => a.localeCompare(b));
    markets.forEach(([marketplace, plugins], marketIndex) => {
      const lastMarket = marketIndex === markets.length - 1;
      lines.push(`${lastMarket ? '└─' : '├─'} ${marketplace}`);

      const sorted = [...plugins].sort((a, b) => a.id.name.localeCompare(b.id.name));
      sorted.forEach((plugin, index) => {
        const last = index === sorted.length - 1;
        const stem = `${lastMarket ? '   ' : '│  '}${last ? '└─' : '├─'}`;
        const state = plugin.enabled ? c('on', 'green') : c('off', 'dim');
        // The bare plugin name; the marketplace is already the parent node.
        const at = plugin.id.name.lastIndexOf('@');
        const bare = at > 0 ? plugin.id.name.slice(0, at) : plugin.id.name;

        const notes: string[] = [];
        if (plugin.reconciled !== undefined) {
          notes.push(c(`disagrees on ${Object.keys(plugin.reconciled).join(', ')}`, 'yellow'));
        }
        if (plugin.sources.length === 1) notes.push(c(`${plugin.sources[0]}-only`, 'dim'));

        lines.push(
          `${stem} ${bare} ${c(versionOf(plugin), 'dim')} ${state}` +
            (notes.length > 0 ? ` ${notes.join(' ')}` : ''),
        );

        if (options.verbose && plugin.version.installedSha !== undefined) {
          lines.push(
            `${lastMarket ? '   ' : '│  '}${last ? '  ' : '│ '}   ` +
              c(`sha ${plugin.version.installedSha.slice(0, 12)} · via ${plugin.version.versionSource}`, 'dim'),
          );
        }
      });
    });
  }

  if (inventory.shadowing.length > 0) {
    lines.push('', c('Shadowed', 'bold'));
    for (const group of inventory.shadowing) {
      lines.push(
        `  ${group.kind} ${group.name}: ${group.effective.scope} wins, ` +
          c(`${group.shadowed.map((id) => id.scope).join(', ')} never load`, 'yellow'),
      );
    }
  }

  lines.push(...sectionLines(inventory, options));
  lines.push(...warningLines(inventory, options));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Doctor — T1.19's contract, rendered
// ---------------------------------------------------------------------------

const SEVERITY_STYLE: Record<Severity, Style> = {
  critical: 'red',
  warning: 'yellow',
  info: 'dim',
};

/**
 * Renders findings.
 *
 * The `fixCommand` is printed on its own line and never wrapped or truncated:
 * it exists to be copied, and a command that has been elided is worse than no
 * command, because it looks runnable.
 */
export function renderDoctor(report: DoctorReport, options: RenderOptions): string {
  const c = paint(options.color);
  const { critical, warning, info } = report.counts;

  const summary =
    report.findings.length === 0
      ? c('no findings', 'green')
      : `${critical} critical · ${warning} warning · ${info} info`;

  const lines = [`${c('ccatlas doctor', 'bold')} ${c(`— ${summary}`, 'dim')}`];

  for (const finding of report.findings) {
    lines.push('');
    lines.push(
      `${c(finding.severity.toUpperCase(), SEVERITY_STYLE[finding.severity])} ` +
        `${c(finding.code, 'dim')} ${finding.subject}`,
    );
    lines.push(`  ${finding.message}`);
    // The consequence, not a restatement — a finding the user cannot weigh is
    // a finding they will skip.
    lines.push(`  ${c(finding.cause, 'dim')}`);

    if (finding.fixCommand !== undefined) {
      for (const line of finding.fixCommand.split('\n')) lines.push(`  ${c(line, 'green')}`);
    }
  }

  // Always shown, even when everything passed: "no findings" over a run that
  // skipped four checks is a clean bill of health it did not earn.
  if (report.skipped.length > 0) {
    lines.push('', c('Not checked', 'bold'));
    for (const skip of report.skipped) {
      lines.push(`  ${c(skip.check, 'dim')} — ${skip.reason}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Flat
// ---------------------------------------------------------------------------

/**
 * One entity per line, greppable. Deliberately not aligned into columns: an
 * aligned table is for reading, and anything reading this in bulk should be
 * reading `--json` instead.
 */
export function renderFlat(result: StatusResult, options: RenderOptions): string {
  const c = paint(options.color);
  const { inventory } = result;
  const lines = header(result, options);

  lines.push('');
  for (const plugin of [...inventory.plugins].sort((a, b) => a.id.name.localeCompare(b.id.name))) {
    lines.push(
      `plugin\t${plugin.id.name}\t${plugin.id.scope}\t${versionOf(plugin)}\t` +
        `${plugin.enabled ? 'enabled' : 'disabled'}\t${plugin.sources.join('+')}`,
    );
  }

  for (const [kind, entities] of [
    ['skill', inventory.skills],
    ['agent', inventory.agents],
    ['command', inventory.commands],
  ] as const) {
    for (const entity of entities) {
      lines.push(`${kind}\t${entity.id.name}\t${entity.id.scope}\t${entity.state}`);
    }
  }

  for (const server of inventory.mcpServers) {
    lines.push(`mcp\t${server.id.name}\t${server.id.scope}\t${server.connection}`);
  }

  // Degraded sections are announced even in the flat form, where their absence
  // would otherwise be indistinguishable from nothing being installed.
  for (const name of inventory.degraded) {
    lines.push(c(`degraded\t${name}\t-\tsection unavailable`, 'red'));
  }

  lines.push(...sectionLines(inventory, options));
  lines.push(...warningLines(inventory, options));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Updates — T2.1-T2.6
// ---------------------------------------------------------------------------

const DELTA_STYLE: Record<string, Style> = {
  major: 'red',
  minor: 'yellow',
  patch: 'green',
  same: 'dim',
  unknown: 'dim',
};

/**
 * Renders the updates report.
 *
 * **Stale pins come first, above the version table.** They are the finding no
 * other tool shows, and a plugin whose version string has not moved sorts to
 * the bottom of any version-ordered list — exactly where the user stops
 * reading. Burying the differentiator inside a column would waste it.
 */
export function renderUpdates(report: UpdatesReport, options: RenderOptions): string {
  const c = paint(options.color);
  const lines = [c('ccatlas updates', 'bold')];

  if (report.stalePins.length > 0) {
    lines.push('', c('Stale pins', 'bold'));
    lines.push(
      c('  the version string has not moved, but the source has — /plugin update reports nothing', 'dim'),
    );
    for (const record of report.stalePins) {
      const pin = record.stalePin as { installedSha: string; entrySha: string };
      lines.push(
        `  ${c('STALE', 'red')} ${record.id} ${c(`v${record.installedVersion}`, 'dim')}`,
      );
      lines.push(
        `    installed ${c(pin.installedSha.slice(0, 12), 'dim')} → entry pins ${c(pin.entrySha.slice(0, 12), 'yellow')}`,
      );
    }
  }

  if (report.upgrades.length > 0) {
    lines.push('', c('Available upgrades', 'bold'));
    for (const record of report.upgrades) {
      lines.push(
        `  ${c(record.delta.toUpperCase().padEnd(7), DELTA_STYLE[record.delta] ?? 'dim')} ` +
          `${record.id} ${record.installedVersion} → ${record.availableVersion ?? '?'}`,
      );
    }
  }

  if (report.entriesBehind.length > 0) {
    lines.push('', c('Marketplace entry is behind the install', 'bold'));
    // NOT an upgrade. Rendering these under 'available updates' would tell the
    // user to move to an older version.
    for (const record of report.entriesBehind) {
      lines.push(
        `  ${record.id}: installed ${record.installedVersion}, entry still declares ${record.availableVersion ?? '?'}`,
      );
    }
  }

  const doubles = report.updates.filter((r) => r.doubleDeclared !== undefined);
  if (doubles.length > 0) {
    lines.push('', c('Double declarations', 'bold'));
    for (const record of doubles) {
      const d = record.doubleDeclared as { effective: string; masked: string };
      lines.push(`  ${record.id}: plugin.json ${d.effective} masks marketplace entry ${d.masked}`);
    }
  }

  const unresolved = report.updates.filter((r) => r.unresolved !== undefined);
  if (unresolved.length > 0) {
    lines.push('', c('No upgrade target', 'bold'));
    // Stated rather than shown as "up to date" — an absent entry means the
    // question was not answered, not answered in the affirmative.
    for (const record of unresolved) {
      lines.push(`  ${record.id} ${c(record.unresolved ?? '', 'dim')}`);
    }
  }

  const stale = report.marketplaces.filter(
    (m) => !m.autoRefreshed && m.ageDays !== undefined && m.ageDays >= 30,
  );
  if (stale.length > 0) {
    lines.push('', c('Stale marketplaces', 'bold'));
    for (const market of stale) {
      lines.push(`  ${market.name} ${c(`last updated ${market.ageDays} days ago`, 'yellow')}`);
    }
    lines.push(c('  refresh with: claude plugin marketplace update <name>', 'green'));
  }

  if (lines.length === 1) lines.push('', c('nothing to report', 'green'));
  return lines.join('\n');
}

/**
 * Renders the apply plan.
 *
 * **Every command in full**, per F5's rule: no collapsing behind "12 actions".
 * A user who cannot read what is about to run cannot refuse it, and the whole
 * value of a dry run is that it is legible.
 */
export function renderPlan(plan: ApplyPlan, options: RenderOptions, willRun: boolean): string {
  const c = paint(options.color);
  const lines = [c(willRun ? 'ccatlas updates --apply' : 'ccatlas updates — plan', 'bold')];

  if (plan.actions.length === 0) {
    lines.push('', c('nothing to run', 'green'));
  } else {
    lines.push('', c(`${plan.actions.length} command(s), in order:`, 'bold'));
    plan.actions.forEach((action, index) => {
      lines.push(`  ${index + 1}. ${c(`claude ${action.argv.join(' ')}`, 'green')}`);
      lines.push(`     ${c(action.reason, 'dim')}`);
    });
    // Marketplaces before plugins is load-bearing, not tidiness.
    lines.push(c('  marketplaces are refreshed first; a plugin update pulls from the clone', 'dim'));
  }

  if (plan.manual.length > 0) {
    lines.push('', c('No command fixes these', 'bold'));
    for (const item of plan.manual) {
      lines.push(`  ${item.subject}`);
      lines.push(`     ${c(item.reason, 'dim')}`);
    }
  }

  return lines.join('\n');
}

/** Renders what actually ran. */
export function renderExecuted(
  executed: readonly ExecutedAction[],
  ok: boolean,
  options: RenderOptions,
): string {
  const c = paint(options.color);
  const lines = [];

  for (const step of executed) {
    const label = step.code === 0 ? c('ok', 'green') : c(`exit ${step.code}`, 'red');
    lines.push(`  ${label} claude ${step.action.argv.join(' ')}`);
    if (step.code !== 0 && step.output !== '') lines.push(`     ${c(step.output.split('\n')[0] ?? '', 'dim')}`);
  }

  if (!ok) {
    // Fail-fast: the actions depend on each other, so continuing past a failed
    // marketplace refresh would install from a clone in an unexpected state.
    lines.push('', c('stopped at the first failure; nothing after it was run', 'red'));
  }

  return lines.join('\n');
}
