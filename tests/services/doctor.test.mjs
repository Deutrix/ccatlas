/**
 * T1.12–T1.19 — the doctor service.
 *
 * Every detector here gets a **negative** case as well as a positive one. The
 * last three review rounds each found a test that could not fail — D3 slipped
 * through because every test supplied one MCP source and never both, and the
 * degraded-cache test early-returned on every run. The doctor analogue is a
 * detector exercised only against inputs that trigger it: a matcher that fires
 * on everything looks perfect under that regime.
 *
 * The reference machine is the standing negative corpus, and the composition
 * test at the bottom runs the real fixtures through and asserts it stays quiet.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createCliCollector } from '../../src/collectors/cli.ts';
import { createRegistryCollector } from '../../src/collectors/registry.ts';
import { runCollector } from '../../src/collectors/isolate.ts';
import { buildInventory } from '../../src/services/inventory.ts';
import {
  buildDoctorReport,
  inventoryFindings,
  mcpFindings,
  orphanedCacheFindings,
  pluginInstallFindings,
  secretFindings,
  sortFindings,
  UNIMPLEMENTED_CHECKS,
} from '../../src/services/doctor.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtureRoot = path.join(repoRoot, 'fixtures');
const ctx = { offline: true, fixtureRoot };

const emptyInventory = (over = {}) => ({
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
  installPath: '/install/p',
  version: { version: '1.0.0', versionSource: 'plugin-json' },
  contributes: { skills: 0, agents: 0, hooks: 0, mcpServers: 0, lspServers: 0 },
  ...over,
});

const server = (name, connection) => ({
  id: { name, scope: 'user', kind: 'mcp-server' },
  origin: 'personal',
  state: 'enabled',
  source: 'file',
  transport: 'stdio',
  connection,
});

// ---------------------------------------------------------------------------
// T1.19 — the contract every finding honours
// ---------------------------------------------------------------------------

test('every finding carries severity, cause and a subject', () => {
  const report = buildDoctorReport({
    inventory: emptyInventory({
      plugins: [plugin({ sources: ['file'] })],
      mcpServers: [server('broken', 'failed')],
      shadowing: [
        {
          kind: 'skill',
          name: 'deploy',
          effective: { name: 'deploy', scope: 'project', kind: 'skill' },
          shadowed: [{ name: 'deploy', scope: 'user', kind: 'skill' }],
        },
      ],
    }),
    secretTargets: [{ file: '.mcp.json', contents: { env: { T: `ghp_${'a'.repeat(36)}` } } }],
  });

  assert.ok(report.findings.length >= 4);
  for (const finding of report.findings) {
    assert.ok(['critical', 'warning', 'info'].includes(finding.severity), finding.code);
    assert.equal(typeof finding.code, 'string');
    assert.equal(typeof finding.subject, 'string');
    assert.ok(finding.message.length > 0, `${finding.code} has no message`);
    // The cause is the consequence, not a restatement — a finding the user
    // cannot act on because they do not know why it matters is noise.
    assert.ok(finding.cause.length > 0, `${finding.code} has no cause`);
  }
});

test('a finding with no one-line fix omits fixCommand rather than inventing one', () => {
  const findings = inventoryFindings(
    emptyInventory({
      shadowing: [
        {
          kind: 'skill',
          name: 'x',
          effective: { name: 'x', scope: 'project', kind: 'skill' },
          shadowed: [{ name: 'x', scope: 'user', kind: 'skill' }],
        },
      ],
    }),
  );

  // A user who runs a wrong fix is worse off than one told there is no
  // one-liner. Absence is the honest answer for a name collision across two
  // files this layer does not know the paths of.
  assert.equal(findings[0].fixCommand, undefined);
  assert.ok(!('fixCommand' in findings[0]), 'the key is omitted, not set to undefined');
});

test('findings sort most severe first, then stably by subject', () => {
  const sorted = sortFindings([
    { code: 'orphaned-cache-dir', severity: 'info', subject: 'b', message: 'm', cause: 'c' },
    { code: 'mcp-server-failed', severity: 'critical', subject: 'z', message: 'm', cause: 'c' },
    { code: 'shadowed-entity', severity: 'info', subject: 'a', message: 'm', cause: 'c' },
  ]);

  assert.deepEqual(sorted.map((f) => f.subject), ['z', 'a', 'b']);
});

test('counts are per severity and match the findings', () => {
  const report = buildDoctorReport({
    inventory: emptyInventory({ mcpServers: [server('a', 'failed'), server('b', 'needs-auth')] }),
  });

  assert.equal(report.counts.warning, 1);
  assert.equal(report.counts.info, 1);
  assert.equal(report.counts.critical, 0);
  assert.equal(
    report.counts.critical + report.counts.warning + report.counts.info,
    report.findings.length,
  );
});

// ---------------------------------------------------------------------------
// T1.16 🔒 — secrets
// ---------------------------------------------------------------------------

test('a plaintext credential is a warning; a COMMITTED one is critical', () => {
  const contents = { mcpServers: { gh: { env: { TOKEN: `ghp_${'a1b2c3d4e5'.repeat(3)}12` } } } };

  const local = secretFindings([{ file: '~/.claude.json', contents }]);
  const committed = secretFindings([{ file: '.mcp.json', contents, committed: true }]);

  // Different in kind, not degree: a tracked file exposes the credential to
  // everyone with repo access and keeps it in history after the edit.
  assert.equal(local[0].severity, 'warning');
  assert.equal(committed[0].severity, 'critical');
  assert.match(committed[0].fixCommand, /rotate/);
  assert.match(committed[0].cause, /history/);
});

test('the finding never contains the credential it found', () => {
  const token = `ghp_${'x'.repeat(36)}`;
  const findings = secretFindings([{ file: '.mcp.json', contents: { env: { T: token } } }]);

  // A doctor report is something users paste into issues.
  assert.ok(!JSON.stringify(findings).includes(token));
  assert.match(findings[0].message, /ghp_…/);
});

test('a clean config produces no secret findings — the negative case', () => {
  const clean = {
    mcpServers: {
      a: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], env: {} },
      b: { env: { GITHUB_TOKEN: '${GITHUB_TOKEN}', AWS_REGION: 'eu-west-1' } },
    },
  };

  assert.deepEqual(secretFindings([{ file: '.mcp.json', contents: clean }]), []);
});

test('the location points at the value, not just the file', () => {
  const findings = secretFindings([
    { file: '.mcp.json', contents: { mcpServers: { gh: { env: { T: `ghp_${'a'.repeat(36)}` } } } } },
  ]);

  assert.match(findings[0].subject, /\.mcp\.json → mcpServers\.gh\.env\.T/);
});

// ---------------------------------------------------------------------------
// T1.12 (partial) — broken installs
// ---------------------------------------------------------------------------

test('an installPath that is not on disk is critical', () => {
  const findings = pluginInstallFindings(
    emptyInventory({ plugins: [plugin()] }),
    new Set(), // nothing exists
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'plugin-install-path-missing');
  assert.equal(findings[0].severity, 'critical');
  assert.match(findings[0].fixCommand, /^claude plugin install p@mkt$/);
});

test('an installPath that IS on disk produces nothing — the negative case', () => {
  const findings = pluginInstallFindings(
    emptyInventory({ plugins: [plugin()] }),
    new Set(['/install/p']),
  );

  assert.deepEqual(findings, []);
});

test('a plugin with no installPath is skipped, not reported', () => {
  // Absent is normal for --plugin-dir sideloads; flagging them would fire on
  // every development session.
  const findings = pluginInstallFindings(
    emptyInventory({ plugins: [plugin({ installPath: undefined })] }),
    new Set(),
  );

  assert.deepEqual(findings, []);
});

test('a file-only plugin is reported as half-removed, not as a missing path', () => {
  const findings = pluginInstallFindings(
    emptyInventory({ plugins: [plugin({ sources: ['file'], state: 'error' })] }),
    new Set(),
  );

  assert.equal(findings.length, 1, 'one finding, not two — the two causes are distinct');
  assert.equal(findings[0].code, 'plugin-half-removed');
  assert.match(findings[0].fixCommand, /uninstall/);
});

// ---------------------------------------------------------------------------
// T1.13 (partial) — MCP connection state
// ---------------------------------------------------------------------------

test('a failed server is a warning with a diagnostic command', () => {
  const findings = mcpFindings(emptyInventory({ mcpServers: [server('broken', 'failed')] }));

  assert.equal(findings[0].code, 'mcp-server-failed');
  assert.equal(findings[0].severity, 'warning');
  assert.match(findings[0].fixCommand, /^claude mcp get broken$/);
});

test('needs-auth is info, not a failure', () => {
  const findings = mcpFindings(emptyInventory({ mcpServers: [server('gmail', 'needs-auth')] }));
  assert.equal(findings[0].severity, 'info');
});

test('PENDING-APPROVAL is never a finding — it is a normal state', () => {
  // It contributes zero always-on cost and is what every fresh clone of a repo
  // carrying a .mcp.json looks like. Reporting it would fire constantly and
  // teach users to ignore the whole report.
  assert.deepEqual(mcpFindings(emptyInventory({ mcpServers: [server('p', 'pending-approval')] })), []);
});

test('connected and unknown servers produce nothing — the negative case', () => {
  const inventory = emptyInventory({
    mcpServers: [server('ok', 'connected'), server('unmeasured', 'unknown')],
  });

  // `unknown` is the default-run state, since `mcp list` is skipped. If it
  // flagged, every server on every normal run would be a finding.
  assert.deepEqual(mcpFindings(inventory), []);
});

// ---------------------------------------------------------------------------
// T1.15 — orphaned cache directories
// ---------------------------------------------------------------------------

const installed = (name, ...versions) => new Map([[name, new Set(versions)]]);

test('a cache version nothing refers to is an orphan', () => {
  // The live example: superpowers 6.2.0 installed, 6.1.1 left beside it.
  const findings = orphanedCacheFindings(
    [
      { marketplace: 'claude-plugins-official', plugin: 'superpowers', version: '6.1.1' },
      { marketplace: 'claude-plugins-official', plugin: 'superpowers', version: '6.2.0' },
    ],
    installed('superpowers@claude-plugins-official', '6.2.0'),
  );

  assert.equal(findings.length, 1);
  assert.match(findings[0].subject, /6\.1\.1/);
  assert.equal(findings[0].severity, 'info', 'disk, not breakage');
});

test('the installed version is never reported — the negative case', () => {
  const findings = orphanedCacheFindings(
    [{ marketplace: 'm', plugin: 'p', version: '1.0.0' }],
    installed('p@m', '1.0.0'),
  );

  assert.deepEqual(findings, []);
});

test('.in_use PRESENCE does not veto — only the installed version does', () => {
  // The reference machine's superpowers has 6.2.0 installed and 6.1.1 beside
  // it, and BOTH carry a `.in_use` directory. An earlier version of this
  // detector skipped anything carrying the marker and went silent on the one
  // real example the ledger cites. FORMATS is precise: `.in_use` is a
  // directory and its MTIME is the signal — a leftover marker says nothing
  // about currency.
  const findings = orphanedCacheFindings(
    [
      { marketplace: 'official', plugin: 'superpowers', version: '6.1.1', inUseMtimeMs: 1_700_000_000_000 },
      { marketplace: 'official', plugin: 'superpowers', version: '6.2.0', inUseMtimeMs: 1_800_000_000_000 },
    ],
    installed('superpowers@official', '6.2.0'),
  );

  assert.equal(findings.length, 1);
  assert.match(findings[0].subject, /6\.1\.1/);
  // The mtime is supporting detail, never a veto.
  assert.match(findings[0].message, /last loaded \d{4}-\d{2}-\d{2}/);
});

test('a version never marked in use says so rather than inventing a date', () => {
  const findings = orphanedCacheFindings(
    [{ marketplace: 'm', plugin: 'p', version: '0.9.0' }],
    installed('p@m', '1.0.0'),
  );

  assert.match(findings[0].message, /never marked in use/);
});

test('the 14-day TTL is NOT asserted anywhere in the output', () => {
  const findings = orphanedCacheFindings(
    [{ marketplace: 'm', plugin: 'p', version: '0.1.0' }],
    new Map(),
  );

  // FORMATS records the TTL as unverified. Promising a date the tool cannot
  // stand behind is how a diagnostic loses credibility on the one detail the
  // user checks.
  const text = JSON.stringify(findings[0]);
  assert.ok(!/14[- ]day|fourteen/iu.test(text), 'an unverified TTL was asserted');
  assert.match(findings[0].cause, /on its own schedule/);
});

// ---------------------------------------------------------------------------
// Findings promoted from the inventory
// ---------------------------------------------------------------------------

test('shadowing becomes a finding naming what never loads', () => {
  const findings = inventoryFindings(
    emptyInventory({
      shadowing: [
        {
          kind: 'skill',
          name: 'deploy',
          effective: { name: 'deploy', scope: 'project', kind: 'skill' },
          shadowed: [{ name: 'deploy', scope: 'user', kind: 'skill' }],
        },
      ],
    }),
  );

  assert.equal(findings[0].code, 'shadowed-entity');
  assert.match(findings[0].message, /user never load/);
  assert.equal(findings[0].scope, 'project');
});

test('a reconciliation conflict becomes an actionable finding', () => {
  const findings = inventoryFindings(
    emptyInventory({
      plugins: [
        plugin({
          reconciled: { version: { value: '2.0.0', source: 'cli', conflictsWith: { value: '1.0.0', source: 'file' } } },
        }),
      ],
    }),
  );

  assert.equal(findings[0].code, 'reconciliation-conflict');
  assert.match(findings[0].message, /disagree about version/);
});

test('a double declaration is info and names the masked value', () => {
  const findings = inventoryFindings(
    emptyInventory({
      plugins: [
        plugin({
          version: {
            version: '2.5.0',
            versionSource: 'plugin-json',
            doubleDeclared: { effective: '2.5.0', masked: '2.2.1' },
          },
        }),
      ],
    }),
  );

  assert.equal(findings[0].severity, 'info');
  assert.match(findings[0].message, /masks 2\.2\.1/);
});

test('a healthy inventory promotes nothing — the negative case', () => {
  assert.deepEqual(inventoryFindings(emptyInventory({ plugins: [plugin()] })), []);
});

// ---------------------------------------------------------------------------
// Honesty about what did not run
// ---------------------------------------------------------------------------

test('unimplemented checks are reported, never silently absent', () => {
  const report = buildDoctorReport({ inventory: emptyInventory() });

  // A doctor that silently skips a check reports a clean bill of health it did
  // not earn. Each entry says which task and why the data is missing.
  assert.ok(report.skipped.length >= UNIMPLEMENTED_CHECKS.length);
  for (const skip of UNIMPLEMENTED_CHECKS) {
    assert.ok(report.skipped.some((s) => s.check === skip.check));
    assert.ok(skip.reason.length > 20, `${skip.check} has no real reason`);
  }
});

test('a degraded collector adds its own skip entry', () => {
  const report = buildDoctorReport({ inventory: emptyInventory({ degraded: ['mcp'] }) });

  // "Nothing found" and "nothing looked" must not read alike.
  assert.ok(report.skipped.some((s) => s.check.includes('mcp') && s.reason.includes('failed')));
});

// ---------------------------------------------------------------------------
// The standing negative corpus — the real fixtures
// ---------------------------------------------------------------------------

test('the reference machine fixtures produce a quiet report', async () => {
  const cli = await runCollector(createCliCollector(), ctx);
  const registry = await runCollector(createRegistryCollector(), ctx);
  const inventory = buildInventory({ cli, registry });

  const report = buildDoctorReport({
    inventory,
    // Every installPath is present, so nothing should flag.
    existingPaths: new Set(inventory.plugins.map((p) => p.installPath).filter(Boolean)),
  });

  // The whole point of a negative corpus: a detector that fires on a healthy
  // machine is worse than one that misses, because it trains the user to stop
  // reading. 5 real plugins, 4 marketplaces, no findings.
  assert.deepEqual(
    report.findings.filter((f) => f.severity !== 'info'),
    [],
    `false positives on the reference corpus: ${report.findings.map((f) => f.code).join(', ')}`,
  );
});

test('the real fixture corpus contains no plaintext secrets', async () => {
  // The reference machine's env objects are all empty — this asserts the
  // detector agrees, which is what makes the synthetic positives meaningful.
  const cli = await runCollector(createCliCollector(), ctx);
  const findings = secretFindings([{ file: 'plugin-list.json', contents: cli.data }]);

  assert.deepEqual(findings, [], `false positives: ${findings.map((f) => f.subject).join(', ')}`);
});
