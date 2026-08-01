/**
 * Argument parsing — T1.20.
 *
 * A pure function: `argv` in, a decision out. No `process` reads, no IO, no
 * exit calls. That is what lets the whole flag surface be tested without
 * spawning a binary, and it keeps `index.ts` down to parse → dispatch → print.
 *
 * `node:util`'s `parseArgs` is deliberately not used. It throws on an unknown
 * option, and a CLI whose job is diagnosing broken machines should answer
 * "I do not know that flag, here are the ones I do" rather than surface a
 * stack trace — and it should collect *every* problem in one pass rather than
 * making the user rediscover them one run at a time.
 */

/** Every global flag. Listed once; help text and the parser both read it. */
export const GLOBAL_FLAGS = [
  { flag: '--json', help: 'emit the versioned JSON envelope instead of a table' },
  { flag: '--cached', help: 'read the recorded answer; do not collect' },
  { flag: '--offline', help: 'guarantee zero network egress (status makes none anyway)' },
  { flag: '--no-color', help: 'disable ANSI colour' },
  { flag: '--verbose', help: 'include per-section detail and timings' },
] as const;

export const COMMANDS = ['status', 'doctor', 'updates'] as const;
export type Command = (typeof COMMANDS)[number];

export interface Flags {
  readonly json: boolean;
  /**
   * Scope the run to a project directory. `undefined` means the global
   * baseline — what you get in any repo.
   *
   * Formally T3.12's flag; landed early so Group E's services are reachable
   * from the binary. Running against the real machine is the check that has
   * caught most of this project's defects, and a service with no surface
   * cannot be run that way.
   */
  readonly project?: string;
  readonly cached: boolean;
  readonly offline: boolean;
  readonly color: boolean;
  readonly verbose: boolean;
  /** `status --flat`. Renderer selection, not a global. */
  readonly flat: boolean;
  /**
   * `updates --check`. Exit nonzero when there is something to act on.
   *
   * The ONE place a nonzero exit means findings rather than failure — a cron
   * job wants `ccatlas updates --check || notify`, and that idiom needs
   * exactly one command with that meaning.
   */
  readonly check: boolean;
  /** `updates --apply`. Explicit by design; the plan is shown either way. */
  readonly apply: boolean;
}

export type Parsed =
  | { readonly kind: 'run'; readonly command: Command; readonly flags: Flags }
  | { readonly kind: 'version' }
  | { readonly kind: 'help'; readonly command?: Command }
  | { readonly kind: 'error'; readonly errors: string[] };

const DEFAULTS: Flags = {
  json: false,
  cached: false,
  offline: false,
  color: true,
  verbose: false,
  flat: false,
  check: false,
  apply: false,
};

/**
 * Should colour be used, absent an explicit `--no-color`?
 *
 * Separate from parsing because it reads the environment, and parsing must
 * not. Callers pass the answer in.
 *
 * `NO_COLOR` wins over `FORCE_COLOR` because it is the one a user sets to
 * protect a pipeline, and a non-TTY defaults to off — otherwise
 * `ccatlas status > report.txt` embeds escape codes in the file, which is the
 * failure people hit before they ever find `--no-color`.
 */
export function colorDefault(env: Record<string, string | undefined>, isTty: boolean): boolean {
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return false;
  if (env['FORCE_COLOR'] !== undefined && env['FORCE_COLOR'] !== '') return true;
  return isTty;
}

const isFlagLike = (arg: string): boolean => arg.startsWith('-') && arg !== '-';

const suggest = (unknown: string): string => {
  const known = [
    ...GLOBAL_FLAGS.map((f) => f.flag),
    '--flat',
    '--project',
    '--check',
    '--apply',
    '--help',
    '--version',
  ];
  // Prefix match only. A fuzzy distance would confidently propose `--json`
  // for `--jsom` and also for `--jason`, and a wrong suggestion costs more
  // than none at all.
  const near = known.filter((flag) => flag.startsWith(unknown) || unknown.startsWith(flag));
  return near.length > 0 ? ` Did you mean ${near.join(' or ')}?` : '';
};

/**
 * Parses argv (already stripped of `node` and the script path).
 *
 * Every error is collected rather than thrown at the first one: a user who
 * mistyped two flags should learn both now.
 */
export function parseArgs(
  argv: readonly string[],
  options: { readonly colorDefault?: boolean } = {},
): Parsed {
  const errors: string[] = [];
  let command: Command | undefined;
  let wantsHelp = false;
  let wantsVersion = false;

  // The environment's answer is the starting point; an explicit `--color` or
  // `--no-color` overrides it. Passed in rather than read here so this
  // function stays pure.
  const flags: {
    -readonly [K in keyof Flags]: Flags[K];
  } = { ...DEFAULTS, color: options.colorDefault ?? DEFAULTS.color };

  const args = [...argv];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;

    // The only value-taking flag. Handled before the switch so the value is
    // never mistaken for a positional — `--project .` would otherwise be
    // reported as an unknown command.
    if (arg === '--project' || arg.startsWith('--project=')) {
      const inline = arg.startsWith('--project=') ? arg.slice('--project='.length) : undefined;
      const value = inline ?? args[index + 1];
      if (inline === undefined) index += 1;

      if (value === undefined || value === '' || isFlagLike(value)) {
        errors.push('--project needs a directory path');
        continue;
      }
      flags.project = value;
      continue;
    }

    if (!isFlagLike(arg)) {
      if (command !== undefined) {
        errors.push(`unexpected argument "${arg}" — ${command} takes no positional arguments`);
        continue;
      }
      if ((COMMANDS as readonly string[]).includes(arg)) {
        command = arg as Command;
        continue;
      }
      errors.push(`unknown command "${arg}". Known commands: ${COMMANDS.join(', ')}`);
      continue;
    }

    switch (arg) {
      case '--help':
      case '-h':
        wantsHelp = true;
        break;
      case '--version':
      case '-v':
        wantsVersion = true;
        break;
      case '--json':
        flags.json = true;
        break;
      case '--cached':
        flags.cached = true;
        break;
      case '--offline':
        flags.offline = true;
        break;
      case '--no-color':
        flags.color = false;
        break;
      case '--color':
        flags.color = true;
        break;
      case '--verbose':
        flags.verbose = true;
        break;
      case '--flat':
        flags.flat = true;
        break;
      case '--check':
        flags.check = true;
        break;
      case '--apply':
        flags.apply = true;
        break;
      default:
        errors.push(`unknown flag "${arg}".${suggest(arg)}`);
    }
  }

  // `--version` and `--help` win over everything, including errors: a user who
  // cannot remember the flags is exactly the user typing them wrong.
  if (wantsVersion) return { kind: 'version' };
  if (wantsHelp) return command !== undefined ? { kind: 'help', command } : { kind: 'help' };
  if (errors.length > 0) return { kind: 'error', errors };
  if (command === undefined) return { kind: 'help' };

  if (flags.check && flags.apply) {
    return {
      kind: 'error',
      errors: ['--check reports without changing anything; --apply changes things. Pick one.'],
    };
  }

  if ((flags.check || flags.apply) && command !== 'updates') {
    return {
      kind: 'error',
      errors: [`--${flags.check ? 'check' : 'apply'} applies to \`updates\`, not \`${command}\``],
    };
  }

  if (flags.json && flags.flat) {
    return {
      kind: 'error',
      errors: ['--flat selects a text renderer and has no meaning with --json'],
    };
  }

  return {
    kind: 'run',
    command,
    // JSON output is never coloured — it is parsed, not read. Left explicit
    // rather than handled in the renderer so `flags.color` means one thing.
    flags: { ...flags, color: flags.json ? false : flags.color },
  };
}

export function helpText(version: string): string {
  const flagHelp = GLOBAL_FLAGS.map(({ flag, help }) => `  ${flag.padEnd(12)} ${help}`).join('\n');

  return `ccatlas ${version} — inventory, freshness, usage ROI, and portability
for your Claude Code stack.

USAGE
  ccatlas <command> [flags]

COMMANDS
  status       what is installed, from where, and whether it agrees with itself
  doctor       findings with a severity, a cause, and the exact command to fix it
  updates      version differences, stale pins, and marketplace staleness

FLAGS
${flagHelp}
  --flat       render a flat list instead of a tree (status only)
  --project P  scope to a project directory instead of the global baseline
  --check      exit 1 when there is something to act on (updates only)
  --apply      run the plan instead of only printing it (updates only)
  --help       print this message
  --version    print the version

Every command supports --json against a versioned schema. Skills consume the
JSON, never the tables — the table layout is not a contract.`;
}
