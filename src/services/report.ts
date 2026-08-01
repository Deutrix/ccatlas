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

import type { DoctorReport } from './doctor.ts';
import type { Inventory } from './inventory.ts';
import type { UpdatesReport } from './updates.ts';

export interface ReportInput {
  readonly inventory: Inventory;
  readonly doctor?: DoctorReport;
  readonly updates?: UpdatesReport;
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

const CSS = `
:root{--bg:#fff;--fg:#1a1a1a;--dim:#666;--line:#e3e3e3;--card:#fafafa;
--red:#c0392b;--amber:#b7791f;--green:#2b7a3d;--blue:#2b5f9e}
@media(prefers-color-scheme:dark){:root{--bg:#16181c;--fg:#e6e6e6;--dim:#9aa0a6;
--line:#2c2f36;--card:#1d2026;--red:#ff6b5e;--amber:#e0a34a;--green:#5fcf7d;--blue:#6aa9ff}}
*{box-sizing:border-box}
body{margin:0;padding:2rem 1.25rem;background:var(--bg);color:var(--fg);
font:14px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:60rem;margin:0 auto}
h1{font-size:1.4rem;margin:0 0 .2rem}h2{font-size:1rem;margin:2rem 0 .6rem;
padding-bottom:.3rem;border-bottom:1px solid var(--line)}
.sub{color:var(--dim);margin:0 0 1.5rem}
.totals{display:flex;flex-wrap:wrap;gap:.6rem;margin:0 0 1rem;padding:0;list-style:none}
.totals li{flex:1 1 7rem;padding:.6rem .7rem;background:var(--card);
border:1px solid var(--line);border-radius:6px}
.totals b{display:block;font-size:1.5rem;font-weight:600}
.totals span{color:var(--dim);font-size:.8rem}
table{width:100%;border-collapse:collapse;font-size:.86rem}
th,td{text-align:left;padding:.4rem .5rem;border-bottom:1px solid var(--line);
vertical-align:top}
th{color:var(--dim);font-weight:600;cursor:pointer;user-select:none;white-space:nowrap}
th:hover{color:var(--fg)}
code{font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;
background:var(--card);padding:.1rem .3rem;border-radius:3px}
.critical{color:var(--red);font-weight:600}.warning{color:var(--amber)}
.info{color:var(--dim)}.ok{color:var(--green)}
.bar{display:flex;height:1.1rem;border-radius:3px;overflow:hidden;
background:var(--card);border:1px solid var(--line);margin:.2rem 0 .1rem}
.bar div{min-width:2px}
.legend{display:flex;flex-wrap:wrap;gap:.5rem 1rem;padding:0;margin:.4rem 0 0;
list-style:none;font-size:.8rem;color:var(--dim)}
.legend i{display:inline-block;width:.6rem;height:.6rem;border-radius:2px;
margin-right:.3rem;vertical-align:baseline}
.note{color:var(--dim);font-size:.8rem;margin:.4rem 0 0}
.empty{color:var(--dim);font-style:italic}
button{font:inherit;color:var(--blue);background:none;border:none;cursor:pointer;padding:0}
button:hover{text-decoration:underline}
@media print{body{padding:0}th{cursor:auto}button{display:none}
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

  return `<!doctype html>
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
</body></html>`;
}
