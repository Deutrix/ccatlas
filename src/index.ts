/**
 * ccatlas entry point.
 *
 * Deliberately thin: parse, dispatch, print, set an exit code. Every decision
 * with IO in it lives in `services/`, and every decision about layout lives in
 * `cli/render.ts`. A surface that collected anything itself would break the
 * one-way layering the whole design rests on.
 */

import path from 'node:path';
import process from 'node:process';

import { colorDefault, helpText, parseArgs } from './cli/args.ts';
import {
  renderDoctor,
  renderExecuted,
  renderFlat,
  renderPlan,
  renderTree,
  renderUpdates,
  renderUsage,
  renderImportPlan,
} from './cli/render.ts';
import { envelope } from './json.ts';
import { doctor } from './services/doctor-run.ts';
import { status } from './services/status.ts';
import {
  applyPlan,
  checkExitCode,
  planUpdates,
  RELOAD_REMINDER,
} from './services/apply.ts';
import { STALE_MARKETPLACE_DAYS } from './services/updates.ts';
import { usage } from './services/analytics-run.ts';
import { exportBundle, importBundle, rollback } from './services/import-run.ts';
import { report, reportAllProjects } from './services/report-run.ts';
import { updates } from './services/updates-run.ts';

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

  const serviceOptions = {
    // A project path makes this a scoped run; absent means the global baseline.
    ...(parsed.flags.project !== undefined
      ? { target: { kind: 'project' as const, path: path.resolve(parsed.flags.project) } }
      : {}),
    offline: parsed.flags.offline,
    cached: parsed.flags.cached,
    toolVersion: VERSION,
  };
  const renderOptions = { color: parsed.flags.color, verbose: parsed.flags.verbose };

  try {
    if (parsed.command === 'doctor') {
      const { report } = await doctor({
        ...serviceOptions,
        projectDir: parsed.flags.project ?? process.cwd(),
      });

      if (parsed.flags.json) {
        // `skipped` travels in the payload, not as a warning: a skill reading
        // this needs to distinguish "checked and clean" from "not checked",
        // and a warnings array is the wrong place to make that decidable.
        const payload = envelope(parsed.command, VERSION, report);
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return EXIT_OK;
      }

      process.stdout.write(`${renderDoctor(report, renderOptions)}\n`);
      return EXIT_OK;
    }

    if (parsed.command === 'updates') {
      const { report } = await updates(serviceOptions);

      if (parsed.flags.apply) {
        const plan = planUpdates(report, STALE_MARKETPLACE_DAYS);
        process.stdout.write(`${renderPlan(plan, renderOptions, true)}\n\n`);

        const { executed, ok } = await applyPlan(plan);
        process.stdout.write(`${renderExecuted(executed, ok, renderOptions)}\n`);
        if (ok && executed.length > 0) process.stdout.write(`\n${RELOAD_REMINDER}\n`);

        // A failed mutation is a real failure, unlike a finding.
        return ok ? EXIT_OK : EXIT_ERROR;
      }

      if (parsed.flags.json) {
        const payload = envelope(parsed.command, VERSION, report, report.warnings);
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return parsed.flags.check ? checkExitCode(report) : EXIT_OK;
      }

      process.stdout.write(`${renderUpdates(report, renderOptions)}\n`);

      // The one command where nonzero means findings. Reserved deliberately:
      // status and doctor exit 0 on findings so this idiom stays unambiguous.
      return parsed.flags.check ? checkExitCode(report) : EXIT_OK;
    }

    if (parsed.command === 'report' && parsed.flags.allProjects) {
      const swept = await reportAllProjects({
        ...serviceOptions,
        ...(parsed.flags.out !== undefined ? { outDir: parsed.flags.out } : {}),
        redact: parsed.flags.redact,
        allowPaths: parsed.flags.allowPaths,
        toolVersion: VERSION,
      });

      if (swept.refused !== undefined) {
        // 🔒 T3.14. Refused before collecting anything: a command that reads
        // for two seconds and THEN declines has already read what it was told
        // not to disclose.
        process.stderr.write(`ccatlas: ${swept.refused}\n`);
        return EXIT_USAGE;
      }

      process.stdout.write(
        `wrote ${swept.written} report(s)${swept.failed > 0 ? `, ${swept.failed} failed` : ''} — ${swept.indexFile ?? ''}\n`,
      );
      return EXIT_OK;
    }

    if (parsed.command === 'report') {
      const written = await report({
        ...serviceOptions,
        ...(parsed.flags.out !== undefined ? { outFile: parsed.flags.out } : {}),
        redact: parsed.flags.redact,
        open: parsed.flags.open,
        toolVersion: VERSION,
        projectDir: parsed.flags.project ?? process.cwd(),
      });

      const kb = (written.bytes / 1024).toFixed(1);
      process.stdout.write(`wrote ${written.file} — ${kb}KB${written.redacted ? ', redacted' : ''}
`);

      // 📏 T3.9. Reported rather than enforced at runtime: the user has the
      // file either way, and a tool that deletes its own output over a size
      // budget helps nobody. CI is where the number is a gate.
      if (written.overBudget) {
        process.stderr.write(`ccatlas: report exceeds the 120KB budget (${kb}KB)
`);
      }
      return EXIT_OK;
    }

    if (parsed.command === 'usage') {
      const { report: usageReport } = await usage(serviceOptions);

      if (parsed.flags.json) {
        const payload = envelope(parsed.command, VERSION, usageReport);
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return EXIT_OK;
      }

      process.stdout.write(`${renderUsage(usageReport, renderOptions, parsed.flags.unused)}\n`);
      return EXIT_OK;
    }

    if (parsed.command === 'export') {
      const result = await exportBundle({
        ...serviceOptions,
        ...(parsed.flags.out !== undefined ? { outFile: parsed.flags.out } : {}),
        allowSecrets: parsed.flags.allowSecrets,
        allowHost: parsed.flags.allowHost,
        toolVersion: VERSION,
      });

      if (!result.ok) {
        // 🔒 T5.6 fails closed. The refusal names every value, so the user
        // can fix them rather than reaching for --allow-secrets.
        process.stderr.write(`ccatlas: ${result.reason}\n`);
        for (const where of result.locations) process.stderr.write(`  ${where}\n`);
        return EXIT_USAGE;
      }

      process.stdout.write(`wrote ${result.file} — ${(result.bytes / 1024).toFixed(1)}KB\n`);
      for (const warning of result.warnings) process.stderr.write(`  ${warning}\n`);
      return EXIT_OK;
    }

    if (parsed.command === 'rollback') {
      const result = await rollback({
        ...(parsed.flags.target !== undefined ? { to: parsed.flags.target } : {}),
      });
      process.stdout.write(`${result.message}\n`);
      return result.ok ? EXIT_OK : EXIT_ERROR;
    }

    if (parsed.command === 'import') {
      const outcome = await importBundle({
        ...serviceOptions,
        source: parsed.flags.target as string,
        apply: parsed.flags.apply,
        verify: parsed.flags.verify,
        confirmed: parsed.flags.confirm,
        // The CLI is a human surface. A skill invoking ccatlas gets the
        // same refusals because trust.ts refuses on `remote`, not on who
        // typed the command.
        actor: 'human',
      });

      if (parsed.flags.json) {
        const payload = envelope(parsed.command, VERSION, outcome);
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return outcome.refused === undefined ? EXIT_OK : EXIT_USAGE;
      }

      if (outcome.plan !== undefined) {
        process.stdout.write(`${renderImportPlan(outcome.plan, renderOptions)}\n`);
      }
      for (const warning of outcome.warnings) process.stderr.write(`  ${warning}\n`);

      if (outcome.refused !== undefined) {
        process.stderr.write(`\nccatlas: ${outcome.refused}\n`);
        return EXIT_USAGE;
      }

      if (outcome.receipt !== undefined) {
        process.stdout.write(
          `\napplied ${outcome.receipt.actions.length} action(s); snapshot ${outcome.receipt.snapshot}\n`,
        );
        return outcome.receipt.ok ? EXIT_OK : EXIT_ERROR;
      }
      return EXIT_OK;
    }

    const result = await status(serviceOptions);

    if (parsed.flags.json) {
      // The envelope is the contract skills read. Serialised straight from the
      // service output — no renderer in between, so the tables can change
      // shape without the schema moving.
      //
      // `scope` travels **inside** `data`. Without it a scoped payload is
      // byte-identical in shape to a global one and a skill has no way to
      // tell what it is looking at — which defeats T1.24, whose entire
      // subject is that global is one value of an axis.
      const payload = envelope(
        parsed.command,
        VERSION,
        { scope: result.target, ...result.inventory },
        result.warnings,
      );
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return EXIT_OK;
    }

    const text = parsed.flags.flat
      ? renderFlat(result, renderOptions)
      : renderTree(result, renderOptions);
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
