/**
 * ccatlas entry point.
 *
 * Deliberately thin: parse, dispatch, print, set an exit code. Every decision
 * with IO in it lives in `services/`, and every decision about layout lives in
 * `cli/render.ts`. A surface that collected anything itself would break the
 * one-way layering the whole design rests on.
 */

import process from 'node:process';

import { colorDefault, helpText, parseArgs } from './cli/args.ts';
import { renderFlat, renderTree } from './cli/render.ts';
import { envelope } from './json.ts';
import { status } from './services/status.ts';

const VERSION = __CCATLAS_VERSION__;

/**
 * Exit codes.
 *
 * `0` covers a run that found problems — degraded sections, reconciliation
 * conflicts, shadowed skills. That is ccatlas working, not ccatlas failing,
 * and establishing "nonzero means findings" here would collide with T2.10,
 * which wants exactly that meaning for `updates --check`. Reserving it now
 * costs nothing; reclaiming it later would break every script written against
 * the earlier meaning.
 */
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

export async function run(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv, {
    colorDefault: colorDefault(process.env, process.stdout.isTTY === true),
  });

  if (parsed.kind === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return EXIT_OK;
  }

  if (parsed.kind === 'help') {
    process.stdout.write(`${helpText(VERSION)}\n`);
    return EXIT_OK;
  }

  if (parsed.kind === 'error') {
    for (const message of parsed.errors) process.stderr.write(`ccatlas: ${message}\n`);
    process.stderr.write(`\n${helpText(VERSION)}\n`);
    return EXIT_USAGE;
  }

  try {
    const result = await status({
      offline: parsed.flags.offline,
      cached: parsed.flags.cached,
      toolVersion: VERSION,
    });

    if (parsed.flags.json) {
      // The envelope is the contract skills read. Serialised straight from the
      // service output — no renderer in between, so the tables can change
      // shape without the schema moving.
      const payload = envelope(parsed.command, VERSION, result.inventory, result.warnings);
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return EXIT_OK;
    }

    const options = { color: parsed.flags.color, verbose: parsed.flags.verbose };
    const text = parsed.flags.flat ? renderFlat(result, options) : renderTree(result, options);
    process.stdout.write(`${text}\n`);
    return EXIT_OK;
  } catch (error: unknown) {
    // Reaching here means something escaped the isolation harness, which is a
    // bug in ccatlas rather than a fact about the machine — so it exits
    // nonzero, unlike every finding the tool is designed to report.
    process.stderr.write(
      `ccatlas: unexpected failure: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EXIT_ERROR;
  }
}

process.exitCode = await run(process.argv.slice(2));
