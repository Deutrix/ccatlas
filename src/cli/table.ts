/**
 * Terminal tables — the shared primitive behind every table ccatlas prints.
 *
 * ## Why this is not `padEnd`
 *
 * `String.prototype.length` counts UTF-16 code units, which is the wrong number
 * three separate ways, and a column padded with it is misaligned the moment any
 * of them appears:
 *
 * | Text | `.length` | Columns on screen |
 * |---|---|---|
 * | `ESC[31m` + `red` + `ESC[0m` | 14 | 3 — ANSI is invisible |
 * | `✅` | 1 | 2 — emoji are double-width |
 * | `⛔` | 1 | 2 | |
 * | `é` as `e` + U+0301 | 2 | 1 — the accent is zero-width |
 *
 * Every one of these occurs in ccatlas output: severity badges are emoji, all
 * styling is ANSI, and plugin names come from strangers' manifests. So width is
 * measured properly, once, here.
 *
 * ## Truncation is width-aware too
 *
 * Cutting a styled string at a code-unit offset can land inside an escape
 * sequence and spray `[31m` across the terminal, or split a surrogate pair into
 * a replacement character. `truncate` walks code points and re-appends a reset.
 */

/** Matches a CSI escape sequence — the only ANSI form these renderers emit. */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/gu;

export const stripAnsi = (text: string): string => text.replace(ANSI, '');

/**
 * Code points that occupy two terminal columns.
 *
 * Deliberately a short list of the ranges that actually reach this tool —
 * emoji, CJK, and the symbol blocks severity badges come from — rather than a
 * full UAX #11 table, which would be several hundred lines of data to serve
 * output that is already only a convenience over `--json`.
 */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana .. CJK compatibility
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // Emoji: symbols, pictographs, faces
    (cp >= 0x1f680 && cp <= 0x1f6ff) || // Transport
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x2600 && cp <= 0x27bf) // Misc symbols + dingbats: ⛔ ✅ ⚠ ✔ ✘
  );
}

/** Combining marks and zero-width joiners occupy no columns of their own. */
function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) || // Combining diacriticals
    (cp >= 0x200b && cp <= 0x200f) || // ZWSP .. RLM
    cp === 0xfeff ||
    (cp >= 0xfe00 && cp <= 0xfe0f) // Variation selectors
  );
}

/** How many terminal columns `text` occupies once printed. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of stripAnsi(text)) {
    const cp = char.codePointAt(0);
    if (cp === undefined || isZeroWidth(cp)) continue;
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

/**
 * Truncates to `max` columns, appending `…` when it cuts.
 *
 * Walks code points rather than slicing, so it can neither split a surrogate
 * pair nor land inside an escape sequence.
 */
export function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  if (displayWidth(text) <= max) return text;

  let width = 0;
  let out = '';
  let styled = false;

  for (const char of text) {
    if (char === '\u001b') styled = true;
    const cp = char.codePointAt(0);
    const w = cp === undefined || isZeroWidth(cp) ? 0 : isWide(cp) ? 2 : 1;

    // Reserve one column for the ellipsis itself.
    if (width + w > max - 1) break;
    out += char;
    width += w;
  }

  // A truncated styled cell would otherwise leak its colour into the border.
  return `${out}…${styled ? '\u001b[0m' : ''}`;
}

const pad = (text: string, width: number, align: Align): string => {
  const gap = Math.max(0, width - displayWidth(text));
  if (align === 'right') return ' '.repeat(gap) + text;
  if (align === 'center') {
    const left = Math.floor(gap / 2);
    return ' '.repeat(left) + text + ' '.repeat(gap - left);
  }
  return text + ' '.repeat(gap);
};

export type Align = 'left' | 'right' | 'center';

export interface Column {
  readonly header: string;
  readonly align?: Align;
  /** Hard ceiling in columns; longer cells are truncated with `…`. */
  readonly max?: number;
}

export interface TableOptions {
  /** Box-drawing borders. Off by default: most tables read better without. */
  readonly bordered?: boolean;
  /** Applied to the header row when colour is on. */
  readonly paint?: (text: string) => string;
  /** Left margin, in spaces. */
  readonly indent?: number;
}

const BORDER = { h: '─', v: '│', tl: '┌', tr: '┐', bl: '└', br: '┘', lt: '├', rt: '┤', tt: '┬', bt: '┴', x: '┼' };

/**
 * Renders `rows` under `columns`.
 *
 * Empty input returns `[]` rather than a header with nothing under it — an
 * empty table is a visually loud way of saying nothing, and "empty ≠ broken"
 * means the *caller* decides what nothing looks like.
 */
export function table(
  columns: readonly Column[],
  rows: readonly (readonly string[])[],
  options: TableOptions = {},
): string[] {
  if (rows.length === 0) return [];

  const indent = ' '.repeat(options.indent ?? 0);
  const paintHeader = options.paint ?? ((t: string) => t);

  const cells = rows.map((row) =>
    columns.map((col, i) => {
      const raw = row[i] ?? '';
      return col.max !== undefined ? truncate(raw, col.max) : raw;
    }),
  );

  const widths = columns.map((col, i) =>
    Math.max(displayWidth(col.header), ...cells.map((row) => displayWidth(row[i] ?? ''))),
  );

  const line = (cs: readonly string[], sep: string): string =>
    indent + cs.map((c, i) => pad(c, widths[i] ?? 0, columns[i]?.align ?? 'left')).join(sep).trimEnd();

  if (options.bordered !== true) {
    // Two spaces between columns: enough to separate, cheap in width.
    return [
      line(
        columns.map((c) => paintHeader(c.header)),
        '  ',
      ),
      ...cells.map((row) => line(row, '  ')),
    ];
  }

  const rule = (l: string, mid: string, r: string): string =>
    indent + l + widths.map((w) => BORDER.h.repeat(w + 2)).join(mid) + r;

  const bordered = (cs: readonly string[]): string =>
    `${indent}${BORDER.v} ${cs
      .map((c, i) => pad(c, widths[i] ?? 0, columns[i]?.align ?? 'left'))
      .join(` ${BORDER.v} `)} ${BORDER.v}`;

  return [
    rule(BORDER.tl, BORDER.tt, BORDER.tr),
    bordered(columns.map((c) => paintHeader(c.header))),
    rule(BORDER.lt, BORDER.x, BORDER.rt),
    ...cells.map(bordered),
    rule(BORDER.bl, BORDER.bt, BORDER.br),
  ];
}

/**
 * A proportional bar, for counts that are more legible as a shape than a
 * number. Uses eighth-blocks so short bars stay visible instead of rounding
 * away to nothing — a plugin used twice should not render as empty space.
 */
export function bar(value: number, max: number, width = 12): string {
  if (max <= 0 || value <= 0) return '';
  const filled = Math.max(1, Math.round((value / max) * width * 8) / 8);
  const full = Math.floor(filled);
  const remainder = Math.round((filled - full) * 8);
  const PARTIAL = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
  return '█'.repeat(full) + (PARTIAL[remainder] ?? '');
}
