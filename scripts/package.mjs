#!/usr/bin/env node
/**
 * Stages the shippable plugin into `dist/plugin/`.
 *
 * ## Why staging, rather than validating the repo root
 *
 * The repo root and the plugin package are the same directory during
 * development, which is convenient and misleading. `claude plugin validate .
 * --strict` fails there on `CLAUDE.md` — correctly, since a `CLAUDE.md` at a
 * plugin root is not loaded as project context and the validator says so — but
 * that file is this repository's own development instructions and never ships.
 *
 * Validating the staged copy tests the thing users actually install. It also
 * catches the opposite mistake: a component that works in the working tree
 * because of a file the package does not include.
 *
 * ## The packaging constraints this enforces
 *
 * - `.claude-plugin/` holds **only** `plugin.json`. Components placed inside it
 *   silently fail to load — no error, no warning, they simply never appear.
 * - Installed plugins are copied into `~/.claude/plugins/cache` and **cannot
 *   reference files outside their own directory**, so nothing is symlinked and
 *   no `../` path is emitted.
 */

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stageDir = path.join(repoRoot, 'dist', 'plugin');

/**
 * Everything the plugin ships, and nothing else.
 *
 * An allowlist rather than a denylist: a denylist ships every new top-level
 * file by default, and the failure mode is publishing something private.
 */
const SHIPPED = [
  '.claude-plugin',
  'bin',
  'skills',
  'commands',
  'hooks',
  'LICENSE',
  'README.md',
  'CHANGELOG.md',
];

await rm(stageDir, { recursive: true, force: true });
await mkdir(stageDir, { recursive: true });

const copied = [];
for (const entry of SHIPPED) {
  const from = path.join(repoRoot, entry);
  try {
    await cp(from, path.join(stageDir, entry), { recursive: true, errorOnExist: false });
    copied.push(entry);
  } catch (error) {
    // A missing optional file is not a packaging failure; a missing required
    // one shows up immediately in validation.
    if ((error && error.code) !== 'ENOENT') throw error;
  }
}

// The manifest is the one thing whose absence is fatal — without it the
// directory is not a plugin at all and `validate` reports something confusing.
const manifestPath = path.join(stageDir, '.claude-plugin', 'plugin.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

if (typeof manifest.version !== 'string' || manifest.version === '') {
  throw new Error('plugin.json has no version — a pinned plugin ships no commits until it moves');
}

// T7.14 🧠: `version` lives in plugin.json ONLY, never also in the marketplace
// entry. plugin.json wins silently, so a second declaration masks the
// marketplace value and nobody finds out until the versions diverge.
const marketplacePath = path.join(repoRoot, '.claude-plugin', 'marketplace.json');
try {
  const marketplace = JSON.parse(await readFile(marketplacePath, 'utf8'));
  const doubled = (marketplace.plugins ?? []).filter((entry) => entry.version !== undefined);
  if (doubled.length > 0) {
    throw new Error(
      `marketplace.json declares a version for ${doubled.map((e) => e.name).join(', ')} — ` +
        'T7.14: version belongs in plugin.json only, never both',
    );
  }
} catch (error) {
  if ((error && error.code) !== 'ENOENT') throw error;
}

await writeFile(
  path.join(stageDir, '.ccatlas-package.json'),
  `${JSON.stringify({ stagedAt: new Date().toISOString(), version: manifest.version, contents: copied }, null, 2)}\n`,
  'utf8',
);

process.stdout.write(
  `staged ${manifest.name} ${manifest.version} → ${path.relative(repoRoot, stageDir)} ` +
    `(${copied.join(', ')})\n`,
);
