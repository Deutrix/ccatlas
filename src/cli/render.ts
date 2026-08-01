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
import type { UsageResult } from '../services/analytics.ts';
import type { ImportPlan } from '../services/import.ts';
import type { UpdatesReport } from '../services/updates.ts';
import type { Inventory, MergedPlugin } from '../services/inventory.ts';
import type { StatusResult } from '../services/status.ts';
import { bar, table } from './table.ts';

/** ANSI, applied only when the caller says colour is wanted. */
const CODES = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  green: '\u001b[32m',
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
 * One summary row per section: label, count, and the status of that count.
 *
 * **`degraded` is tested before the count**, which is the whole point — a zero
 * from a broken collector and a genuine zero are different facts, and only the
 * order of these branches keeps them apart.
 *
 * A degraded section can still hold real rows: a machine whose `cli` collector
 * died still has everything the registry file knows. The count is therefore
 * shown alongside the failure rather than suppressed — hiding data we actually
 * hold is its own kind of wrong answer — and the status column is what stops
 * the number being read as complete.
 */
function summaryRow(
  inventory: Inventory,
  label: string,
  count: number,
  collectors: readonly string[],
  c: (text: string, style: Style) => string,
): string[] {
  const broken = collectors.filter((name) => inventory.degraded.includes(name));
  if (broken.length > 0) {
    return [
      label,
      c(count > 0 ? String(count) : '—', 'red'),
      c(`unavailable — ${broken.join(', ')} failed`, 'red'),
    ];
  }

  const incomplete = collectors.filter((name) => inventory.partial.includes(name));
  if (incomplete.length > 0) {
    return [label, String(count), c(`incomplete — ${incomplete.join(', ')}`, 'yellow')];
  }
  return [label, String(count), c('ok', 'green')];
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

  // Grouped by tag. Eight path-collision warnings differing only in which path
  // collided are one finding repeated eight times, and printing them as eight
  // paragraphs buries the *other* warnings between them — which is how a
  // reconciliation warning goes unread. The count stays visible and every
  // message is still printed, just under one heading.
  const groups = new Map<string, { style: Style; messages: string[] }>();
  for (const warning of inventory.warnings) {
    const style: Style = warning.code === 'collector-failed' ? 'red' : 'yellow';
    const tag = warning.collector !== undefined ? `${warning.collector}/${warning.code}` : warning.code;
    const existing = groups.get(tag);
    if (existing) existing.messages.push(warning.message);
    else groups.set(tag, { style, messages: [warning.message] });
  }

  for (const [tag, group] of groups) {
    if (group.messages.length === 1) {
      lines.push(`  ${c(tag, group.style)} ${group.messages[0] ?? ''}`);
      continue;
    }

    lines.push(`  ${c(tag, group.style)} ${c(`×${group.messages.length}`, 'dim')}`);
    // Verbose prints every one; the default prints three and says how many it
    // held back, so the line count stays bounded without the truncation being
    // silent.
    const shown = options.verbose ? group.messages : group.messages.slice(0, 3);
    for (const message of shown) lines.push(`    ${message}`);
    if (shown.length < group.messages.length) {
      lines.push(c(`    … and ${group.messages.length - shown.length} more — pass --verbose`, 'dim'));
    }
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

  // A table rather than `Label: n` lines, because the *status* of a count is
  // as important as the count. In a flat list `Plugins: 5 (incomplete)` reads
  // as a number with a footnote; in its own column it reads as a caveat.
  lines.push('');
  const summaryRows = sections.map((section) =>
    summaryRow(inventory, section.label, section.count, section.collectors, c),
  );

  lines.push(
    ...table(
      [{ header: '' }, { header: '', align: 'right' }, { header: '' }],
      summaryRows,
      { indent: 2 },
    ).slice(1), // the header row is empty here; the labels carry it
  );

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

  // Grouped by (severity, code, message, cause). Five orphaned projects share
  // one explanation, and repeating it five times made the *list of paths* —
  // the only part that differs, and the only part that is actionable — the
  // hardest thing on screen to find.
  const groups = new Map<string, typeof report.findings>();
  for (const finding of report.findings) {
    const key = [finding.severity, finding.code, finding.message, finding.cause].join('\u0000');
    const existing = groups.get(key);
    if (existing) existing.push(finding);
    else groups.set(key, [finding]);
  }

  for (const group of groups.values()) {
    const first = group[0];
    if (first === undefined) continue;

    lines.push('');
    const count = group.length > 1 ? c(` ×${group.length}`, 'dim') : '';
    lines.push(
      `${c(first.severity.toUpperCase(), SEVERITY_STYLE[first.severity])} ` +
        `${c(first.code, 'dim')}${count}`,
    );
    lines.push(`  ${first.message}`);
    // The consequence, not a restatement — a finding the user cannot weigh is
    // a finding they will skip. Printed once per group.
    lines.push(`  ${c(first.cause, 'dim')}`);

    // The subjects are what differ, so they get a column of their own.
    lines.push(
      ...table([{ header: '' }], group.map((f) => [f.subject]), { indent: 4 }).slice(1),
    );

    // Fix commands can differ per subject even inside a group, so they are
    // collected distinctly rather than assumed uniform.
    const fixes = [...new Set(group.flatMap((f) => (f.fixCommand === undefined ? [] : [f.fixCommand])))];
    const blocks = fixes.map((fix) => fix.split('\n'));

    // When every fix opens with the same caveat — and they do, because the
    // caveat belongs to the *finding* — printing it once above the commands
    // beats repeating it between each pair of paths.
    const lead = blocks[0]?.[0];
    const shared =
      blocks.length > 1 && lead !== undefined && blocks.every((b) => b[0] === lead) ? lead : undefined;

    if (shared !== undefined) lines.push(`  ${c(shared, 'green')}`);
    for (const block of blocks) {
      for (const line of shared === undefined ? block : block.slice(1)) {
        lines.push(`  ${c(line, 'green')}`);
      }
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
    lines.push(
      ...table(
        [
          { header: 'plugin', max: 40 },
          { header: 'version' },
          { header: 'installed' },
          { header: '' },
          { header: 'entry pins' },
        ],
        report.stalePins.map((record) => {
          const pin = record.stalePin as { installedSha: string; entrySha: string };
          return [
            record.id,
            c(`v${record.installedVersion}`, 'dim'),
            c(pin.installedSha.slice(0, 12), 'dim'),
            '→',
            c(pin.entrySha.slice(0, 12), 'yellow'),
          ];
        }),
        { indent: 2, paint: (t) => c(t, 'dim') },
      ),
    );
  }

  if (report.upgrades.length > 0) {
    lines.push('', c('Available upgrades', 'bold'));
    lines.push(
      ...table(
        [
          { header: 'delta' },
          { header: 'plugin', max: 40 },
          { header: 'installed', align: 'right' },
          { header: '' },
          { header: 'available' },
        ],
        report.upgrades.map((record) => [
          c(record.delta.toUpperCase(), DELTA_STYLE[record.delta] ?? 'dim'),
          record.id,
          record.installedVersion,
          '→',
          record.availableVersion ?? '?',
        ]),
        { indent: 2, paint: (t) => c(t, 'dim') },
      ),
    );
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

/**
 * Renders the usage report.
 *
 * `--unused` leads, because it is the headline and it is what the user acts
 * on. The methodology note prints every time, never behind a flag: two very
 * different kinds of number sit side by side here, and a reader who assumes
 * both are measured will over-trust the cost column.
 */
export function renderUsage(
  result: UsageResult,
  options: RenderOptions,
  unusedOnly: boolean,
): string {
  const c = paint(options.color);

  if (!result.available) {
    // "Could not read your usage" and "you have not used these" are the same
    // shape and opposite advice — and the second is acted on by deleting.
    return [
      c('ccatlas usage', 'bold'),
      '',
      c(`usage is unavailable: ${result.reason}`, 'yellow'),
      c('  no prune list is shown — an unread transcript is not an unused stack', 'dim'),
    ].join('\n');
  }

  const lines = [
    `${c('ccatlas usage', 'bold')} ${c(
      `— ${result.totalInvocations} invocations across ${result.scanned.accepted} transcript(s)`,
      'dim',
    )}`,
  ];

  const withCost = result.unused.filter((u) => u.passiveCost !== undefined);
  const withoutCost = result.unused.filter((u) => u.passiveCost === undefined);

  lines.push('', c(`Never invoked (${result.unused.length})`, 'bold'));
  if (result.unused.length === 0) {
    lines.push(c('  everything installed has been used at least once', 'green'));
  } else {
    // Measured first, and as a table: a cost column that lines up is the
    // difference between a prune list you can skim and one you have to parse.
    lines.push(
      ...table(
        [
          { header: 'kind' },
          { header: 'entity', max: 44 },
          { header: 'always-on', align: 'right' },
        ],
        withCost.map((item) => [
          c(item.kind, 'dim'),
          item.entity,
          c(`~${item.passiveCost ?? 0} tok`, 'yellow'),
        ]),
        { indent: 2, paint: (t) => c(t, 'dim') },
      ),
    );

    // Unmeasured LAST: an unmeasured entity has no established cost, and
    // putting it at the top of a prune list implies one.
    const shown = unusedOnly ? withoutCost : withoutCost.slice(0, 15);
    if (withCost.length > 0 && shown.length > 0) lines.push('');
    lines.push(
      ...table(
        [{ header: 'kind' }, { header: 'entity', max: 60 }],
        shown.map((item) => [c(item.kind, 'dim'), item.entity]),
        { indent: 2, paint: (t) => c(t, 'dim') },
      ),
    );
    if (!unusedOnly && withoutCost.length > 15) {
      lines.push(
        c(`  … and ${withoutCost.length - 15} more — pass --unused for the full list`, 'dim'),
      );
    }
  }

  if (!unusedOnly && result.records.length > 0) {
    // **One table per kind, not one global top-N.** A single ranked list is
    // dominated by MCP tool calls — one browser session emits hundreds — so
    // skills and commands never appear in it at all, however heavily used.
    // They are also not comparable quantities: an MCP call is a step inside a
    // turn, a skill invocation is a deliberate act. Ranking them against each
    // other answers a question nobody asked, and hides the one they did.
    //
    // Ordered deliberate-first, because that is the end of the list a user can
    // actually act on.
    const KINDS = [
      { kind: 'skill', title: 'Skills' },
      { kind: 'command', title: 'Commands' },
      { kind: 'agent', title: 'Agents' },
      { kind: 'mcp', title: 'MCP tools' },
    ];

    for (const { kind, title } of KINDS) {
      const records = result.records.filter((r) => r.kind === kind);
      if (records.length === 0) continue;

      const top = records.slice(0, 10);
      // Scaled per kind, so each bar shows distribution *within* its own
      // category rather than every skill rendering as a stub next to a
      // 543-call MCP tool.
      const peak = Math.max(...top.map((r) => r.invocations));
      const shownOf = records.length > top.length ? ` ${c(`(top ${top.length} of ${records.length})`, 'dim')}` : '';

      lines.push('', `${c(title, 'bold')}${shownOf}`);
      lines.push(
        ...table(
          [
            { header: 'count', align: 'right' },
            { header: '' },
            { header: 'entity', max: 50 },
            { header: 'last used' },
          ],
          top.map((record) => [
            String(record.invocations),
            c(bar(record.invocations, peak, 12), 'dim'),
            record.entity + (record.owner !== undefined ? c(` (${record.owner})`, 'dim') : ''),
            c((record.lastUsed ?? '').slice(0, 10), 'dim'),
          ]),
          { indent: 2, paint: (t) => c(t, 'dim') },
        ),
      );
    }
  }

  lines.push('', c(result.methodology, 'dim'));
  return lines.join('\n');
}

/**
 * Renders an import plan — T5.18.
 *
 * **Every executable surface in full.** No collapsing behind "12 actions".
 * An MCP server's command line is printed because registering one registers
 * a program Claude Code will run, and that is the single thing a user most
 * needs to see before agreeing.
 */
export function renderImportPlan(plan: ImportPlan, options: RenderOptions): string {
  const c = paint(options.color);
  const lines = [c('ccatlas import — plan', 'bold')];

  if (plan.actions.length === 0) {
    lines.push('', c('nothing to do — this bundle is already satisfied', 'green'));
  } else {
    lines.push('', c(`${plan.actions.length} action(s):`, 'bold'));
    plan.actions.forEach((action, index) => {
      lines.push(`  ${index + 1}. ${c(action.kind, 'bold')} ${action.subject}`);
      lines.push(`     ${c(action.reason, 'dim')}`);
      if (action.argv !== undefined) {
        lines.push(`     ${c(`claude ${action.argv.join(' ')}`, 'green')}`);
      }
      if (action.executes !== undefined) {
        lines.push(
          `     ${c('runs:', 'yellow')} ${action.executes.command} ${action.executes.args.join(' ')}`,
        );
      }
      if (action.conflict !== undefined) {
        lines.push(
          `     ${c(`conflict: local ${action.conflict.local}, bundle ${action.conflict.bundle}`, 'yellow')}`,
        );
      }
    });
  }

  if (plan.satisfied.length > 0) {
    lines.push('', c(`Already satisfied (${plan.satisfied.length})`, 'dim'));
  }

  if (plan.problems.length > 0) {
    lines.push('', c('Pre-flight', 'bold'));
    for (const problem of plan.problems) {
      lines.push(
        `  ${c(problem.blocking ? 'BLOCKING' : 'note', problem.blocking ? 'red' : 'yellow')} ${problem.message}`,
      );
    }
  }

  return lines.join('\n');
}
