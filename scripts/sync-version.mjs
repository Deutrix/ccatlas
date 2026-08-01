/**
 * Copies `package.json`'s version into `.claude-plugin/plugin.json`.
 *
 * ## Why this is a surgical edit and not JSON.stringify
 *
 * The obvious one-liner — parse, assign, `JSON.stringify(j, null, 2)` — rewrites
 * the *whole file*. It collapses `"keywords": ["a", "b"]` onto separate lines
 * and reorders nothing but reformats everything, so a one-character version
 * bump arrives as an eight-line diff. That makes the release commit unreviewable
 * at exactly the moment review matters most.
 *
 * So this replaces the version string in place and touches nothing else. If the
 * field is missing or malformed it fails loudly rather than inventing one:
 * `plugin.json` is what Claude Code reads to decide whether an update exists,
 * and a silently-wrong version there is the *stale pin* pathology this tool was
 * built to detect, shipped by its own release script.
 *
 * Run: node scripts/sync-version.mjs   (or `npm run sync-version`)
 */

import { readFileSync, writeFileSync } from 'node:fs';

const PKG = 'package.json';
const PLUGIN = '.claude-plugin/plugin.json';

const version = JSON.parse(readFileSync(PKG, 'utf8')).version;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/u.test(version)) {
  console.error(`${PKG} has no usable version: ${JSON.stringify(version)}`);
  process.exit(1);
}

const before = readFileSync(PLUGIN, 'utf8');

// Anchored to the top-level "version" key. `userConfig` entries have their own
// nested objects, so an unanchored replace could rewrite the wrong field.
const VERSION_LINE = /^(\s*"version"\s*:\s*")([^"]*)(")/mu;
const match = VERSION_LINE.exec(before);
if (match === null) {
  console.error(`${PLUGIN} has no "version" field to sync — refusing to invent one`);
  process.exit(1);
}

if (match[2] === version) {
  console.log(`already in sync at ${version}`);
  process.exit(0);
}

const after = before.replace(VERSION_LINE, `$1${version}$3`);
writeFileSync(PLUGIN, after, 'utf8');

// The diff is the receipt: one line, one field.
const changed = after.split('\n').filter((l, i) => l !== before.split('\n')[i]).length;
console.log(`${PLUGIN}: ${match[2]} -> ${version} (${changed} line changed)`);
