/**
 * ccatlas entry point.
 *
 * Scaffold stage (T0.8). This implements the minimum needed to prove the
 * toolchain end to end — build, run, test — and nothing else. Real commands
 * arrive in Phase 1 and must be built against the T0.1–T0.5 fixture corpus,
 * which does not exist yet.
 */

import process from 'node:process';

import { envelope } from './envelope.js';

const VERSION = __CCATLAS_VERSION__;

const USAGE = `ccatlas ${VERSION} — inventory, freshness, usage ROI, and portability
for your Claude Code stack.

  ccatlas --version    print the version
  ccatlas --json       emit the versioned JSON envelope
  ccatlas --help       print this message

Design stage: no working features yet. See docs/04-tasks.md.`;

/** Exit codes. 2 = usage error, matching common CLI convention. */
const EXIT_USAGE = 2;

export function run(argv: readonly string[]): number {
  const args = [...argv];

  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (args.includes('--json')) {
    const payload = envelope('root', VERSION, {
      status: 'scaffold',
      message: 'No features implemented yet — see T0.8 in docs/04-tasks.md.',
    });
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  process.stderr.write(`ccatlas: unrecognised arguments: ${args.join(' ')}\n\n${USAGE}\n`);
  return EXIT_USAGE;
}

process.exitCode = run(process.argv.slice(2));
