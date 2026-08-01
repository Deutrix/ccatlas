#!/usr/bin/env node
/**
 * 📏 T7.6 — the always-on context budget gate. **Fails the build above 600.**
 *
 * This is the number the whole product argues for. ccatlas exists to tell
 * people what their stack costs them in context; a version of it that quietly
 * costs 2,000 always-on tokens would be the thing it warns about. So the
 * budget is a build failure, not a README claim.
 *
 * ## Measured against the STAGED package
 *
 * `claude --plugin-dir <dir> plugin details <name>` works on an uninstalled
 * checkout and reports identical cost figures — only `Source:` differs. That
 * means the gate runs in CI without installing anything, which is what made it
 * possible to move this check from Phase 7 to the day the manifest existed.
 *
 * ## Trap 7 applies here too
 *
 * `plugin details` writes some errors to **stdout** with an empty stderr, so
 * the exit code is the only reliable signal. A parse of error prose would
 * otherwise yield "0 tokens" and pass the gate.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parsePluginDetails } from '../src/collectors/details.ts';

const BUDGET = 600;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = process.argv[2] ?? path.join(repoRoot, 'dist', 'plugin');
const pluginName = 'ccatlas';

const run = () =>
  new Promise((resolve) => {
    execFile(
      'claude',
      ['--plugin-dir', pluginDir, 'plugin', 'details', pluginName],
      {
        encoding: 'utf8',
        windowsHide: true,
        shell: process.platform === 'win32',
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const raw = error === null ? 0 : (error && error.code);
        resolve({
          code: typeof raw === 'number' ? raw : error === null ? 0 : 1,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        });
      },
    );
  });

const outcome = await run();

if (outcome.code !== 0) {
  process.stderr.write(
    `token-budget: \`claude plugin details\` exited ${outcome.code}.\n` +
      `${(outcome.stderr || outcome.stdout).split('\n').slice(0, 3).join('\n')}\n`,
  );
  // A gate that cannot measure must not pass. "Could not check" and "within
  // budget" are the same shape and opposite conclusions.
  process.exit(1);
}

const details = parsePluginDetails(pluginName, outcome.stdout);

if (details.warnings.some((w) => w.includes('not a `plugin details` document'))) {
  process.stderr.write('token-budget: output was not a details document — nothing was measured\n');
  process.exit(1);
}

const alwaysOn = details.cost.alwaysOn;
const headroom = BUDGET - alwaysOn;
const components = details.components
  .filter((c) => (c.alwaysOn ?? 0) > 0)
  .sort((a, b) => (b.alwaysOn ?? 0) - (a.alwaysOn ?? 0));

process.stdout.write(`always-on: ~${alwaysOn} tok against a ${BUDGET} budget`);
process.stdout.write(headroom >= 0 ? ` — ${headroom} to spare\n` : ` — OVER by ${-headroom}\n`);

for (const component of components) {
  process.stdout.write(`  ${component.name.padEnd(18)} ~${component.alwaysOn}\n`);
}

if (alwaysOn > BUDGET) {
  process.stderr.write(
    '\ntoken-budget: FAILED. Every session pays this. Shorten skill descriptions — they are ' +
      'the always-on part; bodies are only read on invoke and cost nothing until then.\n',
  );
  process.exit(1);
}
