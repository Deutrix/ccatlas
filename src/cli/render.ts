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
    return { text: `${label}: unavailable (${broken.join(', ')} failed)`, broken: true };
  }

  const incomplete = collectors.filter((name) => inventory.partial.includes(name));
  const suffix = incomplete.length > 0 ? ' (incomplete)' : '';
  return { text: `${label}: ${count}${suffix}`, broken: false };
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

  const lines = [`${c('ccatlas status', 'bold')} ${c(`— ${source}`, 'dim')}`];
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

  if (inventory.plugins.length > 0 && !inventory.degraded.includes('cli')) {
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

  lines.push(...warningLines(inventory, options));
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

  lines.push(...warningLines(inventory, options));
  return lines.join('\n');
}
