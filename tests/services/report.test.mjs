/**
 * T3.1–T3.10 — the HTML report.
 *
 * Two things carry weight: **redaction** (T3.8 🔒), because the report is the
 * artefact most likely to leave the machine, and **self-containment**, because
 * a report that fetches anything is broken the moment it is emailed or opened
 * offline six months later.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  escapeHtml,
  inlineJson,
  redactString,
  redactValue,
  renderReport,
} from '../../src/services/report.ts';

const inventory = (over = {}) => ({
  plugins: [],
  marketplaces: [],
  mcpServers: [],
  skills: [],
  agents: [],
  commands: [],
  shadowing: [],
  degraded: [],
  partial: [],
  sections: [],
  warnings: [],
  elapsedMs: 1,
  ...over,
});

const plugin = (over = {}) => ({
  id: { name: 'p@mkt', scope: 'user', kind: 'plugin' },
  origin: 'marketplace',
  state: 'enabled',
  source: 'cli',
  sources: ['cli', 'file'],
  marketplace: 'mkt',
  enabled: true,
  version: { version: '1.0.0', versionSource: 'plugin-json' },
  contributes: { skills: 0, agents: 0, hooks: 0, mcpServers: 0, lspServers: 0 },
  ...over,
});

const input = (over = {}) => ({
  inventory: inventory(),
  generatedAt: '2026-08-01T00:00:00.000Z',
  toolVersion: '1.0.0',
  redact: false,
  scope: 'global',
  ...over,
});

// ---------------------------------------------------------------------------
// T3.8 🔒 — redaction
// ---------------------------------------------------------------------------

test('Windows, POSIX and UNC paths all redact', () => {
  const host = 'MYBOX';
  for (const path of [
    'C:\\Users\\realname\\clients\\bigcorp\\app',
    '/home/realname/work/bigcorp',
    '/Users/realname/Desktop/secret-project',
    '\\\\fileserver\\share\\project',
  ]) {
    assert.equal(redactString(path, host), '<path>', path);
  }
});

test('a path collapses whole — keeping the leaf would keep the identifying part', () => {
  // `C:\Users\<real name>\clients\<client name>` leaks who the user is AND who
  // they work for. Masking only the middle preserves both ends.
  const out = redactString('C:\\Users\\jane\\clients\\acme\\repo', 'BOX');
  assert.ok(!out.includes('jane'));
  assert.ok(!out.includes('acme'));
  assert.ok(!out.includes('repo'));
});

test('the hostname is replaced everywhere it appears', () => {
  assert.equal(redactString('failed on WORKBOX-01 twice', 'WORKBOX-01'), 'failed on <host> twice');
});

test('an empty hostname does not blank the string', () => {
  // `''.split()` would explode the value into characters.
  assert.equal(redactString('nothing to redact', ''), 'nothing to redact');
});

test('redaction walks nested structures', () => {
  const out = redactValue(
    { a: ['C:\\secret\\path'], b: { c: '/home/me/x' }, n: 42, t: true },
    'BOX',
  );

  assert.deepEqual(out, { a: ['<path>'], b: { c: '<path>' }, n: 42, t: true });
});

test('object KEYS are not rewritten', () => {
  // `~/.claude.json` is keyed by absolute path; rewriting keys would produce
  // many entries all called `<path>` and silently collapse them.
  const out = redactValue({ 'C:\\a': 1, 'C:\\b': 2 }, 'BOX');
  assert.deepEqual(Object.keys(out).sort(), ['C:\\a', 'C:\\b']);
});

test('a redacted report contains no path and no hostname', () => {
  const raw = inventory({
    plugins: [plugin({ installPath: 'C:\\Users\\jane\\plugins\\p' })],
    warnings: [{ code: 'partial', message: 'could not read C:\\Users\\jane\\.claude.json' }],
  });

  // Redaction is the RUNNER's boundary, applied once over the whole payload
  // before rendering — deliberately not per-section, since a per-renderer pass
  // is one forgotten call away from a leak. The test mirrors that ordering
  // rather than expecting the renderer to redact.
  const html = renderReport(
    input({ redact: true, scope: 'project <path>', inventory: redactValue(raw, 'MYBOX') }),
  );

  assert.ok(!html.includes('jane'), 'a username survived redaction');
  assert.ok(html.includes('&lt;path&gt;'), 'nothing was redacted at all');
});

test('an UNREDACTED report keeps the paths — the control', () => {
  const html = renderReport(
    input({
      inventory: inventory({
        warnings: [{ code: 'partial', message: 'could not read C:\\Users\\jane\\.claude.json' }],
      }),
    }),
  );

  // Without this, the redaction test would pass against a renderer that
  // simply never emits warnings.
  assert.ok(html.includes('jane'));
});

test('the redacted flag is stated in the document', () => {
  assert.match(renderReport(input({ redact: true })), /redacted/);
});

// ---------------------------------------------------------------------------
// Self-containment
// ---------------------------------------------------------------------------

test('the document references NO external resource', () => {
  const html = renderReport(
    input({ inventory: inventory({ plugins: [plugin()] }) }),
  );

  // A report is emailed, attached to tickets, and opened offline. Every one
  // of those breaks the moment something points elsewhere.
  assert.ok(!/<script[^>]+src=/u.test(html), 'external script');
  assert.ok(!/<link[^>]+href=/u.test(html), 'external stylesheet');
  assert.ok(!/<img/u.test(html), 'external image');
  assert.ok(!/https?:\/\//u.test(html.replace(/<script type="application\/json"[\s\S]*?<\/script>/u, '')));
});

test('it declares a charset and a viewport', () => {
  const html = renderReport(input());
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /viewport/);
});

test('dark mode is handled by prefers-color-scheme, not a toggle', () => {
  assert.match(renderReport(input()), /prefers-color-scheme:dark/);
});

test('print styles exist so the report survives print-to-PDF', () => {
  assert.match(renderReport(input()), /@media print/);
});

// ---------------------------------------------------------------------------
// Escaping — the report renders user-controlled strings
// ---------------------------------------------------------------------------

test('HTML metacharacters are escaped', () => {
  assert.equal(escapeHtml('<script>&"\''), '&lt;script&gt;&amp;&quot;&#39;');
});

test('a plugin named with markup cannot inject it', () => {
  const html = renderReport(
    input({
      inventory: inventory({
        plugins: [plugin({ id: { name: '<img onerror=alert(1)>', scope: 'user', kind: 'plugin' } })],
      }),
    }),
  );

  assert.ok(!html.includes('<img onerror'), 'markup from a plugin name reached the document');
  assert.ok(html.includes('&lt;img onerror'));
});

test('the inline JSON cannot close its own script tag', () => {
  // The classic inline-JSON injection: `</script>` inside a string ends the
  // tag early and drops the rest of the document in as markup.
  const encoded = inlineJson({ evil: '</script><img onerror=alert(1)>' });

  assert.ok(!encoded.includes('</script>'));
  assert.ok(encoded.includes('\\u003c'));
  assert.deepEqual(JSON.parse(encoded), { evil: '</script><img onerror=alert(1)>' });
});

test('line and paragraph separators are escaped — they break JS string literals', () => {
  const encoded = inlineJson({ x: 'a\u2028b\u2029c' });
  assert.ok(!encoded.includes('\u2028'));
  assert.deepEqual(JSON.parse(encoded), { x: 'a\u2028b\u2029c' });
});

// ---------------------------------------------------------------------------
// T3.4 — the context-budget chart
// ---------------------------------------------------------------------------

test('with NO measured cost the chart says so rather than drawing zeros', () => {
  const html = renderReport(input({ inventory: inventory({ plugins: [plugin()] }) }));

  // Today's state — the `plugin details` parser is T4.7. An empty bar labelled
  // "0 tokens" would assert a measurement nobody made.
  assert.match(html, /No always-on token costs have been measured/);
  assert.ok(!/class="bar"/u.test(html));
});

test('with measured costs the chart is drawn and labelled as estimates', () => {
  const html = renderReport(
    input({
      inventory: inventory({
        plugins: [
          plugin({ cost: { alwaysOn: 300, regime: 'tokenizer' } }),
          plugin({
            id: { name: 'q@mkt', scope: 'user', kind: 'plugin' },
            cost: { alwaysOn: 100, regime: 'tokenizer' },
          }),
        ],
      }),
    }),
  );

  assert.match(html, /class="bar"/);
  assert.match(html, /~400 always-on tokens/);
  // Estimates are labelled on every surface.
  assert.match(html, /<strong>estimates<\/strong>/);
});

test('a DISABLED plugin contributes nothing to the chart', () => {
  const html = renderReport(
    input({
      inventory: inventory({
        plugins: [
          plugin({ cost: { alwaysOn: 300, regime: 'tokenizer' } }),
          plugin({
            id: { name: 'off@mkt', scope: 'user', kind: 'plugin' },
            enabled: false,
            cost: { alwaysOn: 9000, regime: 'tokenizer' },
          }),
        ],
      }),
    }),
  );

  assert.match(html, /~300 always-on tokens/);
});

test('a non-additive cost is called out rather than silently summed', () => {
  const html = renderReport(
    input({
      inventory: inventory({
        plugins: [plugin({ cost: { alwaysOn: 300, regime: 'tokenizer', nonAdditive: true } })],
      }),
    }),
  );

  // Above the ~30k-char listing cap per-entity figures rank but do not add.
  assert.match(html, /non-additive/);
});

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

test('totals reflect the inventory', () => {
  const entity = (name, kind) => ({
    id: { name, scope: 'user', kind },
    origin: 'personal',
    state: 'enabled',
    source: 'file',
  });

  const html = renderReport(
    input({
      inventory: inventory({
        plugins: [plugin()],
        skills: [entity('a', 'skill'), entity('b', 'skill')],
      }),
    }),
  );

  assert.match(html, /<b>2<\/b><span>skills<\/span>/);
  assert.match(html, /<b>1<\/b><span>plugins<\/span>/);
});

test('a stale pin is rendered with both shas', () => {
  const html = renderReport(
    input({
      updates: {
        updates: [],
        stalePins: [
          {
            id: 'p@mkt',
            installedVersion: '1.0.0',
            delta: 'unknown',
            direction: 'unknown',
            stalePin: { installedSha: 'a'.repeat(40), entrySha: 'b'.repeat(40) },
          },
        ],
        upgrades: [],
        entriesBehind: [],
        marketplaces: [],
        warnings: [],
      },
    }),
  );

  assert.match(html, /aaaaaaaaaaaa/);
  assert.match(html, /bbbbbbbbbbbb/);
  assert.match(html, /reports no update available/);
});

test('a finding with no fix says so rather than showing an empty cell', () => {
  const html = renderReport(
    input({
      doctor: {
        findings: [
          { code: 'shadowed-entity', severity: 'warning', subject: 's', message: 'm', cause: 'c' },
        ],
        counts: { critical: 0, warning: 1, info: 0 },
        skipped: [],
      },
    }),
  );

  assert.match(html, /no single command/);
});

test('skipped checks are stated in the report, not only in the CLI', () => {
  const html = renderReport(
    input({
      doctor: {
        findings: [],
        counts: { critical: 0, warning: 0, info: 0 },
        skipped: [{ check: 'lsp (T1.14)', reason: 'no LSP server exists in the corpus' }],
      },
    }),
  );

  // A clean report over a run that skipped four checks is a clean bill of
  // health it did not earn.
  assert.match(html, /Not checked/);
  assert.match(html, /no LSP server exists/);
});

test('a run with no doctor or updates says they were not run', () => {
  const html = renderReport(input());
  assert.match(html, /Doctor was not run/);
  assert.match(html, /Updates were not checked/);
});

// ---------------------------------------------------------------------------
// T3.9 📏 — the size budget
// ---------------------------------------------------------------------------

test('📏 a realistic report stays well inside 120KB', (t) => {
  const many = (n, kind) =>
    Array.from({ length: n }, (_, i) => ({
      id: { name: `${kind}-${i}`, scope: 'user', kind },
      origin: 'personal',
      state: 'enabled',
      source: 'file',
    }));

  const html = renderReport(
    input({
      inventory: inventory({
        plugins: Array.from({ length: 25 }, (_, i) =>
          plugin({ id: { name: `plug-${i}@mkt`, scope: 'user', kind: 'plugin' } }),
        ),
        skills: many(160, 'skill'),
        agents: many(50, 'agent'),
        commands: many(210, 'command'),
      }),
    }),
  );

  const kb = Buffer.byteLength(html, 'utf8') / 1024;
  t.diagnostic(`report: ${kb.toFixed(1)}KB (budget 120KB)`);

  // Inlining the FULL inventory blew this at 141.8KB on the reference machine
  // — 120KB of it the bodies of skills and commands the page never renders.
  // The payload is a summary for that reason.
  assert.ok(kb < 120, `report is ${kb.toFixed(1)}KB`);
});

test('the inlined payload is a summary, and says so', () => {
  const html = renderReport(
    input({ inventory: inventory({ skills: [{ id: { name: 's', scope: 'user', kind: 'skill' }, origin: 'personal', state: 'enabled', source: 'file' }] }) }),
  );

  const json = /<script type="application\/json" id="ccatlas-data">([\s\S]*?)<\/script>/u.exec(html);
  const payload = JSON.parse(json[1]);

  assert.equal(payload.counts.skills, 1);
  assert.ok(!('skills' in payload), 'skill bodies were inlined again');
  assert.match(payload.note, /status --json/);
  // …and the document tells the reader where the full data lives.
  assert.match(html, /complete inventory/);
});

// ---------------------------------------------------------------------------
// Usage section
// ---------------------------------------------------------------------------

const usageResult = (over = {}) => ({
  available: true,
  totalInvocations: 12,
  scanned: { accepted: 3, rejected: 0 },
  records: [
    { kind: 'skill', entity: 'superpowers:brainstorming', invocations: 11, sessions: 9, lastUsed: '2026-07-31T08:28:14.283Z' },
    { kind: 'mcp', entity: 'chrome/computer', invocations: 543, sessions: 20, lastUsed: '2026-07-31T08:28:14.283Z' },
  ],
  unused: [],
  methodology: 'counts are exact; costs are estimates',
  ...over,
});

test('skills appear in the report even when an MCP tool outnumbers them 50x', () => {
  const html = renderReport(input({ usage: usageResult() }));

  // The reason the section is split by kind at all: a single global ranking
  // is all MCP calls, and the skill a user actually wants to see is nowhere.
  assert.match(html, /superpowers:brainstorming/);
  assert.match(html, /Skills/);
  assert.match(html, /MCP tools/);
});

test('UNAVAILABLE usage is not rendered as an empty prune list', () => {
  const html = renderReport(
    input({ usage: { available: false, reason: 'unrecognised transcript shape' } }),
  );

  // "You never used these" and "we could not tell" are opposite advice, and
  // the first is acted on by deleting things.
  assert.match(html, /Usage unavailable/);
  assert.match(html, /unrecognised transcript shape/);
  assert.ok(!/Never invoked/.test(html), 'a prune list must not appear when usage could not be read');
});

test('usage that ran and found everything used says so, distinctly', () => {
  const html = renderReport(input({ usage: usageResult({ unused: [] }) }));
  assert.match(html, /used at least once/);
  assert.ok(!/Usage unavailable/.test(html));
});

test('the never-invoked list puts MEASURED costs first', () => {
  const html = renderReport(
    input({
      usage: usageResult({
        unused: [
          { kind: 'skill', entity: 'unmeasured-one' },
          { kind: 'skill', entity: 'costly-one', passiveCost: 400 },
        ],
      }),
    }),
  );

  // An unmeasured entity has no established cost; ranking it above a measured
  // one implies it has the larger cost, which is precisely backwards.
  assert.ok(
    html.indexOf('costly-one') < html.indexOf('unmeasured-one'),
    'measured costs must sort above unmeasured ones',
  );
  assert.match(html, /unmeasured/);
});

test('a missing usage service degrades only its own section', () => {
  const html = renderReport(input({ usage: undefined, inventory: inventory({ plugins: [plugin()] }) }));
  assert.match(html, /Usage was not collected/);
  // The rest of the document still renders.
  assert.match(html, /p@mkt/);
});

test('every table is wrapped so a phone scrolls the TABLE, not the page', () => {
  const html = renderReport(input({ usage: usageResult(), inventory: inventory({ plugins: [plugin()] }) }));
  const tables = (html.match(/<table>/gu) ?? []).length;
  const wraps = (html.match(/<div class="wrap"><table>/gu) ?? []).length;
  assert.ok(tables > 0, 'no tables rendered');
  assert.equal(wraps, tables, 'every table must be wrapped');
});
