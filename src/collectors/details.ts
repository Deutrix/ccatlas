/**
 * `claude plugin details <name>` — the cost parser. T4.7, and T1.17's input.
 *
 * ## Text only, and that is settled
 *
 * T0.2 tried `--json`, `--format`, `--output`, `--plain`, `--quiet` and
 * `--model`. Every one is rejected with `exit=1, unknown option`. Only `-h`
 * exists. So this is a text parser, defensively written, and its output is
 * labelled as an estimate everywhere it surfaces.
 *
 * ## Four traps, all observed
 *
 * 1. **Number formats are mixed inside one table.** `~90`, `~2,069`, `~8k`,
 *    `~9.7k`, `~13,990` all appear. A parser handling only one shape reads
 *    `~9.7k` as 9 and understates by three orders of magnitude.
 * 2. **Per-component values do not sum to the always-on total.** Both sections
 *    round independently. Adding the components and presenting the result as
 *    the total produces a number the tool itself contradicts.
 * 3. **Component lists can contain duplicates.**
 * 4. **The estimator falls back silently.** A bogus model and an unreachable
 *    endpoint both produce byte-identical, well-formed output — three regimes
 *    observed, ~40% apart. Nothing in the text says which one you got, so
 *    `regime` is recorded as `unknown` unless the caller can establish it by
 *    other means. Never guess it from the numbers.
 *
 * MCP tool schema cost is **excluded** from always-on by Claude Code itself,
 * and hooks are genuinely free. Neither is inferred here.
 */

import type { ComponentCounts, TokenCost } from '../types.ts';

export interface ComponentCost {
  readonly name: string;
  readonly alwaysOn?: number;
  readonly onInvoke?: number;
}

export interface PluginDetails {
  readonly name: string;
  /** Absent when the version could not be resolved — a real, observed state. */
  readonly version?: string;
  readonly description?: string;
  /** `<plugin>@<marketplace>`, or `@inline` under `--plugin-dir`. */
  readonly source?: string;
  readonly contributes: ComponentCounts;
  readonly cost: TokenCost;
  readonly components: ComponentCost[];
  readonly warnings: string[];
}

/**
 * Parses one token figure.
 *
 * Handles every observed spelling: `~90`, `~2,069`, `~8k`, `~9.7k`,
 * `~13,990`. Returns `undefined` rather than 0 for anything unrecognised —
 * a zero would read as "this costs nothing", which is the opposite of "this
 * could not be read".
 */
export function parseTokenCount(raw: string): number | undefined {
  const match = /~?\s*([\d,]+(?:\.\d+)?)\s*([kKmM])?/u.exec(raw.trim());
  if (match === null) return undefined;

  const digits = match[1];
  if (digits === undefined) return undefined;

  const value = Number(digits.replace(/,/gu, ''));
  if (!Number.isFinite(value)) return undefined;

  const suffix = match[2]?.toLowerCase();
  if (suffix === 'k') return Math.round(value * 1000);
  if (suffix === 'm') return Math.round(value * 1_000_000);
  return Math.round(value);
}

/** `Skills (3)  a, b, c` → count 3. The list is optional and may repeat. */
const COMPONENT_LINE = /^\s{2}(Skills|Agents|Hooks|MCP servers|LSP servers)\s*\((\d+)\)/u;

/** `  Always-on:   ~2,069 tok   added to every session` */
const ALWAYS_ON = /^\s*Always-on:\s*(.+?)\s+tok/u;

/** `  <name><pad>~120  ~4.3k` — two figures, always-on then on-invoke. */
const PER_COMPONENT = /^\s{2}(\S.*?)\s{2,}(~?[\d,.]+[kKmM]?)(?:\s+(~?[\d,.]+[kKmM]?))?\s*$/u;

const HEADINGS = new Set([
  'Component inventory',
  'Projected token cost',
  'Per-component (rounded)',
]);

/**
 * Parses the whole document.
 *
 * Never throws. An unrecognised section is skipped with a warning rather than
 * failing the plugin: this runs across every installed plugin, and one
 * upstream formatting change should degrade one row, not the report.
 */
export function parsePluginDetails(name: string, text: string): PluginDetails {
  const warnings: string[] = [];

  // Trap 7: `plugin details <missing>` writes its error to STDOUT and leaves
  // stderr empty, so a caller that classifies on streams hands this function
  // an error message. The exit code is the real signal and callers check it —
  // but a document with no `Component inventory` heading is not a details
  // document whatever the exit code said, and parsing it produced a "version"
  // of `"42crunch-api-security-testing"` scraped out of the error prose.
  if (!text.includes('Component inventory')) {
    return {
      name,
      contributes: { skills: 0, agents: 0, hooks: 0, mcpServers: 0, lspServers: 0 },
      cost: { alwaysOn: 0, regime: 'unknown' },
      components: [],
      warnings: ['this is not a `plugin details` document — no component inventory was found'],
    };
  }
  const contributes: {
    -readonly [K in keyof ComponentCounts]: ComponentCounts[K];
  } = { skills: 0, agents: 0, hooks: 0, mcpServers: 0, lspServers: 0 };

  const components: ComponentCost[] = [];
  let alwaysOn: number | undefined;
  let version: string | undefined;
  let description: string | undefined;
  let source: string | undefined;
  let section: 'head' | 'inventory' | 'cost' | 'per-component' = 'head';

  const lines = text.split(/\r?\n/u);

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    if (HEADINGS.has(trimmed)) {
      section =
        trimmed === 'Component inventory'
          ? 'inventory'
          : trimmed === 'Projected token cost'
            ? 'cost'
            : 'per-component';
      continue;
    }

    if (section === 'head') {
      // `<name>[ <version>]` — the version is ABSENT when unresolved, which
      // is why it is optional rather than defaulted to "unknown" here.
      if (index === 0) {
        const head = /^(\S+)(?:\s+(\S+))?/u.exec(trimmed);
        if (head?.[2] !== undefined) version = head[2];
        continue;
      }
      if (trimmed.startsWith('Source:')) {
        source = trimmed.slice('Source:'.length).trim();
        continue;
      }
      if (description === undefined) description = trimmed;
      continue;
    }

    if (section === 'inventory') {
      const component = COMPONENT_LINE.exec(line);
      if (component === null) continue;
      const count = Number(component[2]);
      switch (component[1]) {
        case 'Skills': contributes.skills = count; break;
        case 'Agents': contributes.agents = count; break;
        case 'Hooks': contributes.hooks = count; break;
        case 'MCP servers': contributes.mcpServers = count; break;
        case 'LSP servers': contributes.lspServers = count; break;
        default: break;
      }
      continue;
    }

    if (section === 'cost') {
      const always = ALWAYS_ON.exec(line);
      if (always?.[1] !== undefined) {
        alwaysOn = parseTokenCount(always[1]);
        if (alwaysOn === undefined) {
          warnings.push(`could not parse the always-on figure "${always[1].trim()}"`);
        }
      }
      continue;
    }

    // Prose lines under the per-component table — the estimator's own caveats.
    if (trimmed.startsWith('On-invoke cost') || trimmed.startsWith('Token counts')) continue;
    if (/^component\s+always-on/iu.test(trimmed)) continue;

    const row = PER_COMPONENT.exec(line);
    if (row === null) continue;

    const componentName = row[1]?.trim();
    if (componentName === undefined || componentName === '') continue;

    const first = row[2] === undefined ? undefined : parseTokenCount(row[2]);
    const second = row[3] === undefined ? undefined : parseTokenCount(row[3]);

    components.push({
      name: componentName,
      ...(first !== undefined ? { alwaysOn: first } : {}),
      ...(second !== undefined ? { onInvoke: second } : {}),
    });
  }

  if (alwaysOn === undefined) {
    warnings.push('no always-on total was found; the cost section may have moved');
  }

  // Trap 2, made explicit rather than silently tolerated. The two sections
  // round independently, so a mismatch is EXPECTED — it is recorded as a note
  // only when it is large enough to suggest something other than rounding.
  const summed = components.reduce((sum, c) => sum + (c.alwaysOn ?? 0), 0);
  if (alwaysOn !== undefined && summed > 0 && Math.abs(summed - alwaysOn) > alwaysOn * 0.25) {
    warnings.push(
      `per-component always-on sums to ~${summed} against a stated total of ~${alwaysOn}; ` +
        'both sections round independently, so they are never added together',
    );
  }

  return {
    name,
    ...(version !== undefined ? { version } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(source !== undefined ? { source } : {}),
    contributes,
    cost: {
      alwaysOn: alwaysOn ?? 0,
      // `unknown` unless the caller establishes it. A bogus model and an
      // unreachable endpoint produce byte-identical output ~40% apart, so
      // there is nothing in the text to infer it from — and guessing would
      // put a confident label on a number that may be badly wrong.
      regime: 'unknown',
    },
    components,
    warnings,
  };
}

/**
 * The cache key T0.2 settled on.
 *
 * `plugin@version` alone is **not** sufficient: the figures vary with the
 * active model, and they vary again with which estimator regime answered. A
 * key missing either dimension serves one model's numbers for another's.
 */
export function detailsCacheKey(
  plugin: string,
  version: string,
  model: string | undefined,
  regime: TokenCost['regime'],
): string {
  return `${plugin}@${version}|${model ?? 'unknown-model'}|${regime}`;
}
