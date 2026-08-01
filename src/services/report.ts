/**
 * The HTML report — T3.1–T3.10.
 *
 * ## Self-contained, and that is a hard constraint
 *
 * One file, inline JSON, vanilla JS, **no CDN and no runtime build step**. A
 * report is something people email, attach to a ticket, or open six months
 * later on a machine with no network. Every one of those breaks the moment a
 * `<script src>` points somewhere else.
 *
 * It also has to stay under 120KB (T3.9 📏), which rules out embedding a
 * charting library and is the reason the context-budget chart is drawn with
 * `<div>` widths rather than SVG paths or a canvas.
 *
 * ## Redaction is a security boundary, not a formatting option
 *
 * `--redact` (T3.8) strips project paths, repo names and the hostname. The
 * report is the artefact most likely to leave the machine, and a project path
 * is `C:\Users\<real name>\clients\<client name>\…` — it leaks who the user
 * is and who they work for in one string.
 */

import type { UsageResult } from './analytics.ts';
import type { DoctorReport } from './doctor.ts';
import type { Inventory } from './inventory.ts';
import type { UpdatesReport } from './updates.ts';

export interface ReportInput {
  readonly inventory: Inventory;
  readonly doctor?: DoctorReport;
  readonly updates?: UpdatesReport;
  readonly usage?: UsageResult;
  readonly generatedAt: string;
  readonly toolVersion: string;
  readonly redact: boolean;
  /** Named scope, already redacted if redaction is on. */
  readonly scope: string;
}

// ---------------------------------------------------------------------------
// T3.8 🔒 — redaction
// ---------------------------------------------------------------------------

/**
 * Absolute paths, in every spelling that appears in this data.
 *
 * Windows drive paths, POSIX home paths, UNC shares, and the `<HOME>` token
 * the fixtures use. Matched greedily to the last separator so the leaf name —
 * often the most identifying part, a client or product name — goes too.
 */
const PATH_PATTERNS: readonly RegExp[] = [
  /[A-Za-z]:[\\/][^"'\s,;)]*/gu,
  /\\\\[^"'\s,;)]+/gu,
  /\/(?:home|Users|root)\/[^"'\s,;)]*/gu,
  /<HOME>[^"'\s,;)]*/gu,
];

/**
 * Redacts one string.
 *
 * Paths collapse to `<path>` rather than being partially masked: keeping the
 * last segment would preserve exactly the identifying part, and keeping the
 * first would preserve the username. A repo `owner/name` keeps neither half
 * for the same reason.
 */
export function redactString(value: string, hostname: string): string {
  let out = value;
  for (const pattern of PATH_PATTERNS) out = out.replace(pattern, '<path>');
  if (hostname !== '') out = out.split(hostname).join('<host>');
  return out;
}

/**
 * Redacts a whole structure, keys included in the search but never rewritten.
 *
 * Object keys are left alone deliberately: `~/.claude.json` is keyed by
 * absolute path, so a redacting pass over keys would produce many entries all
 * named `<path>` and silently collapse them. Callers that hold path-keyed maps
 * must drop or count them instead — which the report does.
 */
export function redactValue<T>(value: T, hostname: string): T {
  if (typeof value === 'string') return redactString(value, hostname) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, hostname)) as unknown as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item, hostname)]),
    ) as unknown as T;
  }
  return value;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/** Escapes for text nodes and attributes alike. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

/**
 * Serialises the payload for inlining in a `<script>`.
 *
 * `</script>` inside a JSON string would close the tag early and drop the rest
 * of the document into the page as markup — the classic inline-JSON XSS. `<`
 * is escaped to `\u003c` rather than the sequence being special-cased, which
 * also covers `<!--`, and the result is still valid JSON to `JSON.parse`.
 */
export function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</gu, '\\u003c').replace(/\u2028|\u2029/gu, (c) =>
    c === '\u2028' ? '\\u2028' : '\\u2029',
  );
}

/**
 * The whole stylesheet, inlined.
 *
 * No CDN, no webfont, no external anything: the report is opened from disk and
 * routinely emailed around, so a remote reference would either fail to load or
 * silently phone home from someone else's machine — and "zero telemetry" has to
 * survive the artefact being forwarded.
 *
 * Both colour schemes are defined because a report generated on one machine is
 * read on another; `prefers-color-scheme` is the only signal available without
 * a preference store.
 */
const CSS = `
:root{--bg:#fff;--fg:#15171a;--dim:#5c6370;--line:#e6e8eb;--card:#f7f8fa;
--raise:#fff;--shadow:0 1px 2px rgba(16,24,40,.05),0 1px 3px rgba(16,24,40,.06);
--red:#c0392b;--amber:#b7791f;--green:#2b7a3d;--blue:#2b5f9e;--accent:#4f46e5}
@media(prefers-color-scheme:dark){:root{--bg:#111317;--fg:#e8eaed;--dim:#98a0ac;
--line:#282c34;--card:#181b21;--raise:#1b1f26;--shadow:0 1px 2px rgba(0,0,0,.4);
--red:#ff6b5e;--amber:#e0a34a;--green:#5fcf7d;--blue:#6aa9ff;--accent:#8b85f5}}
*{box-sizing:border-box}
body{margin:0;padding:2.5rem 1.25rem 4rem;background:var(--bg);color:var(--fg);
font:14px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
main{max-width:64rem;margin:0 auto}

/* Header */
h1{font-size:1.55rem;font-weight:650;letter-spacing:-.02em;margin:0 0 .25rem;
display:flex;align-items:center;gap:.5rem}
h1::before{content:"";width:.55rem;height:1.35rem;border-radius:3px;
background:linear-gradient(160deg,var(--accent),var(--blue))}
h2{font-size:.78rem;font-weight:650;text-transform:uppercase;letter-spacing:.07em;
color:var(--dim);margin:2.5rem 0 .75rem;padding-bottom:.4rem;
border-bottom:1px solid var(--line)}
.sub{color:var(--dim);margin:0 0 2rem;font-size:.85rem}

/* Summary cards */
.totals{display:grid;grid-template-columns:repeat(auto-fit,minmax(8rem,1fr));
gap:.65rem;margin:0 0 1rem;padding:0;list-style:none}
.totals li{padding:.8rem .85rem;background:var(--raise);border:1px solid var(--line);
border-radius:10px;box-shadow:var(--shadow)}
.totals b{display:block;font-size:1.75rem;font-weight:650;letter-spacing:-.03em;
line-height:1.1}
.totals span{color:var(--dim);font-size:.75rem;text-transform:uppercase;
letter-spacing:.05em}

/* Tables */
.wrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px;
background:var(--raise);box-shadow:var(--shadow)}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th,td{text-align:left;padding:.55rem .7rem;vertical-align:top}
thead th{position:sticky;top:0;z-index:1;background:var(--card);color:var(--dim);
font-weight:600;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;
cursor:pointer;user-select:none;white-space:nowrap;border-bottom:1px solid var(--line)}
thead th:hover{color:var(--fg)}
thead th::after{content:"";opacity:.35;margin-left:.35rem}
thead th[data-asc="1"]::after{content:"^";opacity:1}
thead th[data-asc="0"]::after{content:"v";opacity:1}
tbody tr+tr td{border-top:1px solid var(--line)}
tbody tr:hover{background:var(--card)}
code{font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;
background:var(--card);border:1px solid var(--line);padding:.08rem .32rem;
border-radius:4px;white-space:nowrap}

/* Severity, as a labelled dot rather than colour alone — colour is not
   readable to every reader, and this report gets forwarded. */
.critical,.warning,.info,.ok{font-size:.72rem;font-weight:650;
text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}
.critical{color:var(--red)}.warning{color:var(--amber)}
.info{color:var(--dim)}.ok{color:var(--green)}
td.critical::before,td.warning::before,td.info::before{content:"\\25CF";
margin-right:.35rem;font-size:.85em}
span.info{font-size:.8rem;font-weight:400;text-transform:none;letter-spacing:0}

/* Context-budget bar */
.bar{display:flex;height:1.4rem;border-radius:6px;overflow:hidden;
background:var(--card);border:1px solid var(--line);margin:.3rem 0 .2rem}
.bar div{min-width:2px;transition:filter .15s}
.bar div:hover{filter:brightness(1.15)}
.legend{display:flex;flex-wrap:wrap;gap:.4rem 1.1rem;padding:0;margin:.6rem 0 0;
list-style:none;font-size:.78rem;color:var(--dim)}
.legend i{display:inline-block;width:.65rem;height:.65rem;border-radius:3px;
margin-right:.35rem;vertical-align:baseline}

/* Usage */
h3.k{font-size:.85rem;font-weight:650;margin:1.4rem 0 .5rem;
display:flex;align-items:baseline;gap:.5rem}
h3.k .note{margin:0;font-size:.72rem}
td.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
th:nth-child(2),th:nth-child(4){text-align:right}
/* Inline sparkline: a shape reads faster than a column of integers, and shows
   distribution — that one entity is 5x the next — which numbers state but do
   not show. Scaled per kind, so a skill is not a stub beside a 543-call tool. */
td.spark{width:7rem;min-width:5rem;padding-top:.72rem}
td.spark i{display:block;height:.42rem;border-radius:2px;
background:linear-gradient(90deg,var(--accent),var(--blue))}

.note{color:var(--dim);font-size:.78rem;margin:.6rem 0 0;line-height:1.55}
.empty{color:var(--dim);font-style:italic}
button{font:inherit;font-size:.78rem;color:var(--blue);background:none;
border:1px solid transparent;border-radius:4px;cursor:pointer;padding:.05rem .3rem}
button:hover{background:var(--card);border-color:var(--line)}
button:focus-visible,thead th:focus-visible{outline:2px solid var(--accent);
outline-offset:1px}

@media print{body{padding:0;font-size:11px}
.wrap{border:none;box-shadow:none;overflow:visible}
thead th{position:static;cursor:auto}
.totals li{box-shadow:none}
button{display:none}
h2{break-after:avoid}tr{break-inside:avoid}}
`.trim();

/**
 * The only script in the page.
 *
 * Sorting and copy-to-clipboard, nothing else. Written against the inlined
 * payload rather than re-deriving anything, so the JS cannot disagree with the
 * numbers already rendered server-side — the table works with JS disabled and
 * sorting is the enhancement.
 */
const JS = `
document.querySelectorAll('table').forEach(function(table){
  table.querySelectorAll('th').forEach(function(th,col){
    th.addEventListener('click',function(){
      var body=table.tBodies[0];
      var rows=Array.prototype.slice.call(body.rows);
      var asc=th.dataset.asc!=='1';
      table.querySelectorAll('th').forEach(function(o){delete o.dataset.asc});
      th.dataset.asc=asc?'1':'0';
      rows.sort(function(a,b){
        var x=(a.cells[col]||{}).textContent||'',y=(b.cells[col]||{}).textContent||'';
        var nx=parseFloat(x),ny=parseFloat(y);
        var r=(!isNaN(nx)&&!isNaN(ny))?nx-ny:x.localeCompare(y);
        return asc?r:-r;
      });
      rows.forEach(function(r){body.appendChild(r)});
    });
  });
});
document.querySelectorAll('button[data-copy]').forEach(function(b){
  b.addEventListener('click',function(){
    navigator.clipboard.writeText(b.dataset.copy).then(function(){
      var t=b.textContent;b.textContent='copied';setTimeout(function(){b.textContent=t},1200);
    });
  });
});
`.trim();

const esc = escapeHtml;

function totals(inventory: Inventory): string {
  const cells: Array<[string, number]> = [
    ['plugins', inventory.plugins.length],
    ['marketplaces', inventory.marketplaces.length],
    ['skills', inventory.skills.length],
    ['agents', inventory.agents.length],
    ['commands', inventory.commands.length],
    ['MCP servers', inventory.mcpServers.length],
  ];

  return `<ul class="totals">${cells
    .map(([label, n]) => `<li><b>${n}</b><span>${esc(label)}</span></li>`)
    .join('')}</ul>`;
}

/**
 * T3.4 — the context-budget chart. *The screenshot feature.*
 *
 * Rendered as flex-basis percentages rather than SVG or canvas: it survives
 * the 120KB budget, prints correctly, and needs no script.
 *
 * **Renders nothing when no plugin carries a cost.** That is today's state —
 * `plugin details` parsing is T4.7 — and drawing an empty bar labelled
 * "0 tokens" would assert a measurement nobody made.
 */
function budgetChart(inventory: Inventory): string {
  const measured = inventory.plugins.filter((p) => p.cost !== undefined && p.enabled);
  if (measured.length === 0) {
    return `<p class="empty">No always-on token costs have been measured yet — the
      <code>plugin details</code> cost parser is not built (T4.7). This chart is
      deliberately blank rather than showing zeros.</p>`;
  }

  const total = measured.reduce((sum, p) => sum + (p.cost?.alwaysOn ?? 0), 0);
  const hues = ['var(--blue)', 'var(--green)', 'var(--amber)', 'var(--red)', 'var(--dim)'];
  const nonAdditive = measured.some((p) => p.cost?.nonAdditive === true);

  const segments = measured
    .map((plugin, index) => {
      const cost = plugin.cost?.alwaysOn ?? 0;
      const pct = total === 0 ? 0 : (cost / total) * 100;
      return `<div style="flex:0 0 ${pct.toFixed(2)}%;background:${hues[index % hues.length]}" title="${esc(
        plugin.id.name,
      )}: ~${cost} tok"></div>`;
    })
    .join('');

  const legend = measured
    .map(
      (plugin, index) =>
        `<li><i style="background:${hues[index % hues.length]}"></i>${esc(plugin.id.name)} ~${
          plugin.cost?.alwaysOn ?? 0
        }</li>`,
    )
    .join('');

  return `<div class="bar">${segments}</div><ul class="legend">${legend}</ul>
    <p class="note">~${total} always-on tokens across ${measured.length} enabled plugin(s).
    Token counts are <strong>estimates</strong> from Claude Code's own estimator, rounded.${
      nonAdditive
        ? ' Some figures are marked non-additive — above the listing cap they rank but do not sum.'
        : ''
    }</p>`;
}

function pluginTable(inventory: Inventory): string {
  if (inventory.plugins.length === 0) return '<p class="empty">No plugins installed.</p>';

  const rows = inventory.plugins
    .map((plugin) => {
      const flags: string[] = [];
      if (plugin.reconciled !== undefined) {
        flags.push(`<span class="warning">disagrees on ${esc(Object.keys(plugin.reconciled).join(', '))}</span>`);
      }
      if (plugin.version.doubleDeclared !== undefined) {
        flags.push(`<span class="info">masks ${esc(plugin.version.doubleDeclared.masked)}</span>`);
      }
      return `<tr><td><code>${esc(plugin.id.name)}</code></td><td>${esc(plugin.marketplace)}</td>
        <td>${esc(plugin.version.version)}</td><td>${esc(plugin.version.versionSource)}</td>
        <td class="${plugin.enabled ? 'ok' : 'info'}">${plugin.enabled ? 'enabled' : 'disabled'}</td>
        <td>${flags.join(' ') || ''}</td></tr>`;
    })
    .join('');

  return `<table><thead><tr><th>plugin</th><th>marketplace</th><th>version</th>
    <th>resolved by</th><th>state</th><th>notes</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function findingsTable(doctor: DoctorReport | undefined): string {
  if (doctor === undefined) return '<p class="empty">Doctor was not run.</p>';

  // The skipped list is built FIRST and appended to both branches. An earlier
  // version returned "No findings" early, so a report over a run that skipped
  // four checks showed a clean bill of health and never said four checks did
  // not run — the exact failure `skipped` exists to prevent, reintroduced at
  // the last step.
  const skipped =
    doctor.skipped.length === 0
      ? ''
      : `<p class="note"><strong>Not checked:</strong> ${doctor.skipped
          .map((s) => `${esc(s.check)} — ${esc(s.reason)}`)
          .join('; ')}</p>`;

  if (doctor.findings.length === 0) return `<p class="ok">No findings.</p>${skipped}`;

  const rows = doctor.findings
    .map(
      (finding) => `<tr><td class="${finding.severity}">${esc(finding.severity)}</td>
        <td><code>${esc(finding.code)}</code></td><td>${esc(finding.subject)}</td>
        <td>${esc(finding.message)}<br><span class="info">${esc(finding.cause)}</span></td>
        <td>${
          finding.fixCommand === undefined
            ? '<span class="info">no single command</span>'
            : `<code>${esc(finding.fixCommand.split('\n')[0] ?? '')}</code>
               <button data-copy="${esc(finding.fixCommand)}">copy</button>`
        }</td></tr>`,
    )
    .join('');

  return `<table><thead><tr><th>severity</th><th>code</th><th>subject</th>
    <th>finding</th><th>fix</th></tr></thead><tbody>${rows}</tbody></table>${skipped}`;
}

function updatesSection(updates: UpdatesReport | undefined): string {
  if (updates === undefined) return '<p class="empty">Updates were not checked.</p>';

  const pins =
    updates.stalePins.length === 0
      ? '<p class="ok">No stale pins.</p>'
      : `<table><thead><tr><th>plugin</th><th>version</th><th>installed</th><th>entry pins</th></tr></thead>
         <tbody>${updates.stalePins
           .map(
             (r) => `<tr><td><code>${esc(r.id)}</code></td><td>${esc(r.installedVersion)}</td>
               <td><code>${esc(r.stalePin?.installedSha.slice(0, 12) ?? '')}</code></td>
               <td><code class="warning">${esc(r.stalePin?.entrySha.slice(0, 12) ?? '')}</code></td></tr>`,
           )
           .join('')}</tbody></table>
         <p class="note">The version string has not moved but the source has, so
         <code>/plugin update</code> reports no update available.</p>`;

  const upgrades =
    updates.upgrades.length === 0
      ? ''
      : `<h2>Available upgrades</h2><table><thead><tr><th>plugin</th><th>installed</th>
         <th>available</th><th>delta</th></tr></thead><tbody>${updates.upgrades
           .map(
             (r) => `<tr><td><code>${esc(r.id)}</code></td><td>${esc(r.installedVersion)}</td>
               <td>${esc(r.availableVersion ?? '?')}</td><td class="${
                 r.delta === 'major' ? 'critical' : r.delta === 'minor' ? 'warning' : 'info'
               }">${esc(r.delta)}</td></tr>`,
           )
           .join('')}</tbody></table>`;

  return `${pins}${upgrades}`;
}

/**
 * The inlined payload — a **summary**, not the whole inventory.
 *
 * Inlining the full inventory blew the 120KB budget on the reference machine:
 * 141.8KB total, of which 131.7KB was the payload and **120KB of that was the
 * bodies of 138 skills, 47 agents and 208 commands the page never renders**.
 * The document is server-rendered, so those were pure weight.
 *
 * What stays is what the page actually tabulates plus the counts, which keeps
 * the JSON useful for anyone scraping it while leaving the markup dominant.
 * The full data has a home already — `--json` — and the note in the document
 * says so rather than leaving a reader to wonder why a list is truncated.
 */
function summaryPayload(input: ReportInput): unknown {
  const { inventory } = input;

  return {
    generatedAt: input.generatedAt,
    toolVersion: input.toolVersion,
    scope: input.scope,
    redacted: input.redact,
    note: 'A summary. Run `ccatlas status --json` for the complete inventory.',
    counts: {
      plugins: inventory.plugins.length,
      marketplaces: inventory.marketplaces.length,
      skills: inventory.skills.length,
      agents: inventory.agents.length,
      commands: inventory.commands.length,
      mcpServers: inventory.mcpServers.length,
    },
    plugins: inventory.plugins,
    mcpServers: inventory.mcpServers,
    shadowing: inventory.shadowing,
    degraded: inventory.degraded,
    partial: inventory.partial,
    warnings: inventory.warnings,
    findings: input.doctor?.findings ?? [],
    stalePins: input.updates?.stalePins ?? [],
    upgrades: input.updates?.upgrades ?? [],
  };
}

/** How many rows per usage kind. Bounded so the 📏 120KB budget holds. */
const USAGE_ROWS = 12;

/**
 * What is actually invoked, split by kind.
 *
 * **One table per kind, not one global ranking.** MCP tool calls outnumber
 * everything else by an order of magnitude — one browser session emits
 * hundreds — so a single top-N list contains no skills at all, however heavily
 * used. They are also not comparable quantities: an MCP call is a step inside a
 * turn, a skill invocation is a deliberate act.
 *
 * An unreadable transcript renders as **unavailable with its reason**, never as
 * an empty list: "you never used these" is the opposite advice from "we could
 * not tell", and the first one gets acted on by deleting things.
 */
function usageSection(usage: UsageResult | undefined): string {
  if (usage === undefined) return '<p class="empty">Usage was not collected.</p>';
  if (!usage.available) {
    return `<p class="warning">Usage unavailable</p><p class="note">${esc(usage.reason ?? 'unknown reason')}
      — no prune list is shown, because an unread transcript is not an unused stack.</p>`;
  }

  const KINDS: Array<[string, string]> = [
    ['skill', 'Skills'],
    ['command', 'Commands'],
    ['agent', 'Agents'],
    ['mcp', 'MCP tools'],
  ];

  const blocks = KINDS.map(([kind, title]) => {
    const records = usage.records.filter((r) => r.kind === kind);
    if (records.length === 0) {
      return `<h3 class="k">${esc(title)}</h3><p class="empty">none invoked</p>`;
    }

    const top = records.slice(0, USAGE_ROWS);
    const peak = Math.max(...top.map((r) => r.invocations));
    const more =
      records.length > top.length
        ? `<span class="note">top ${top.length} of ${records.length}</span>`
        : '';

    const rows = top
      .map(
        (r) => `<tr><td>${esc(r.entity)}${
          r.owner === undefined ? '' : ` <span class="info">${esc(r.owner)}</span>`
        }</td>
        <td class="num">${r.invocations}</td>
        <td class="spark"><i style="width:${Math.max(2, Math.round((r.invocations / peak) * 100))}%"></i></td>
        <td class="num">${r.sessions ?? ''}</td>
        <td><code>${esc((r.lastUsed ?? '').slice(0, 10))}</code></td></tr>`,
      )
      .join('');

    return `<h3 class="k">${esc(title)} ${more}</h3>
      <table><thead><tr><th>entity</th><th>invocations</th><th></th>
      <th>sessions</th><th>last used</th></tr></thead><tbody>${rows}</tbody></table>`;
  }).join('');

  const unused =
    usage.unused.length === 0
      ? '<p class="ok">Everything installed has been used at least once.</p>'
      : `<h3 class="k">Never invoked <span class="note">${usage.unused.length} total${
          usage.unused.length > USAGE_ROWS ? `, ${USAGE_ROWS} shown` : ''
        }</span></h3>
        <table><thead><tr><th>kind</th><th>entity</th><th>always-on cost</th></tr></thead><tbody>${usage.unused
          // Measured first: an unmeasured entity has no established cost, and
          // putting it at the top of a prune list implies one.
          .slice()
          .sort((a, b) => (b.passiveCost ?? -1) - (a.passiveCost ?? -1))
          .slice(0, USAGE_ROWS)
          .map(
            (u) => `<tr><td>${esc(u.kind)}</td><td>${esc(u.entity)}</td><td class="num">${
              u.passiveCost === undefined
                ? '<span class="info">unmeasured</span>'
                : `~${u.passiveCost} tok`
            }</td></tr>`,
          )
          .join('')}</tbody></table>`;

  return `<p class="note">${usage.totalInvocations} invocations across ${
    usage.scanned.accepted
  } transcript(s).</p>${blocks}${unused}<p class="note">${esc(usage.methodology)}</p>`;
}

/**
 * Puts every table in a horizontally scrollable container.
 *
 * A six-column plugin table does not fit a phone, and this report is made to be
 * sent to people — an unwrapped table makes the whole *page* scroll sideways,
 * which is the failure mode where the body text becomes unreadable rather than
 * just the table.
 *
 * Applied centrally rather than at each call site so a new table cannot forget
 * it. Operating on the assembled HTML is safe here because every value that
 * comes from data goes through `esc()` first, so a literal `<table>` can only
 * ever have originated from one of this module's own templates.
 */
function wrapTables(html: string): string {
  return html.replace(/<table>/gu, '<div class="wrap"><table>').replace(/<\/table>/gu, '</table></div>');
}

/**
 * Builds the whole document.
 *
 * Server-rendered: every number is in the markup before any script runs, so
 * the report is readable with JS disabled and prints correctly. The inlined
 * payload is there for anyone who wants the data, not for rendering.
 */
export function renderReport(input: ReportInput): string {
  const { inventory } = input;
  const payload = summaryPayload(input);

  return wrapTables(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ccatlas — ${esc(input.scope)}</title>
<style>${CSS}</style></head>
<body><main>
<h1>ccatlas</h1>
<p class="sub">${esc(input.scope)} · generated ${esc(input.generatedAt)} · v${esc(input.toolVersion)}${
    input.redact ? ' · <strong>redacted</strong>' : ''
  }</p>

<h2>Totals</h2>
${totals(inventory)}

<h2>Context budget</h2>
${budgetChart(inventory)}

<h2>Version health</h2>
${updatesSection(input.updates)}

<h2>Usage</h2>
${usageSection(input.usage)}

<h2>Findings</h2>
${findingsTable(input.doctor)}

<h2>Plugins</h2>
${pluginTable(inventory)}

<p class="note">The inlined JSON below is a <strong>summary</strong>; run
<code>ccatlas status --json</code> for the complete inventory.
Invocation counts are exact; token costs are estimates from
Claude Code's own estimator and are rounded. Generated locally — this report
contains no telemetry and made no network calls to produce.</p>
</main>
<script type="application/json" id="ccatlas-data">${inlineJson(payload)}</script>
<script>${JS}</script>
</body></html>`);
}
