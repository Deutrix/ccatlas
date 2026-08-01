/**
 * The transcript adapter — T4.1 ⛔. **Quarantined by design.**
 *
 * `~/.claude/projects/**\/*.jsonl` is undocumented and unstable. This is the
 * **only** module that parses it, and only the `analytics` service may import
 * it. If Claude Code changes the format, exactly one report section goes dark
 * and every other command is unaffected — that isolation is the entire reason
 * this file exists as its own layer rather than as a helper inside analytics.
 *
 * ## The probe is the safety mechanism, and it is per FILE
 *
 * Not once globally. Files are written by different Claude Code builds — the
 * corpus spans 2.1.197–2.1.220, nineteen of them — so a single global probe
 * blesses the whole set on the strength of whichever file happened to be
 * checked.
 *
 * The load-bearing assertion is **`Array.isArray(message.content)`**. Every
 * signal lives inside that array. If `content` ever becomes a string, a
 * coarser probe still passes, extraction quietly returns zero, and the report
 * says *you used nothing, prune everything* — a confidently wrong
 * recommendation that deletes working configuration. That is the specific
 * failure this design exists to make impossible.
 *
 * ## Unavailable is a value, never a throw
 *
 * An unrecognised shape yields `{ available: false, reason }`. Callers render
 * the reason; they never see an exception, and they can always tell "no
 * invocations" from "could not read invocations".
 */

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

/** Signals worth counting. `attribution*` fields are deliberately absent. */
export type SignalKind = 'skill' | 'agent' | 'command' | 'mcp';

export interface Signal {
  readonly kind: SignalKind;
  /** Skill name, subagent type, bare command name, or `<server>/<tool>`. */
  readonly entity: string;
  /** Plugin that owns it, when the name carries one. */
  readonly plugin?: string;
  /** MCP server, for `mcp` signals. */
  readonly server?: string;
  /** ISO-8601, verbatim. **Never** an epoch int — trap: `ts` is a string. */
  readonly ts: string;
  readonly sessionId: string;
  /** Strict partition: false in every top-level file, true in every sidecar. */
  readonly isSidechain: boolean;
  /** `cwd` off the record. The only reliable project identity. */
  readonly cwd?: string;
  /** Claude Code build that wrote the record. */
  readonly ccVersion?: string;
}

export type ProbeResult =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

export interface FileScan {
  readonly file: string;
  readonly probe: ProbeResult;
  readonly signals: Signal[];
  readonly lines: number;
  /** Bytes consumed, for T4.3's incremental offset. */
  readonly bytes: number;
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** ISO-8601 with milliseconds and `Z`. Never an epoch int. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

/**
 * Probes one `assistant` record.
 *
 * Exported so the assertion set is testable directly. Every field here was
 * observed on 100% of timeline records across 276,870 lines; a missing one
 * means the format moved.
 */
export function probeAssistantRecord(record: unknown): ProbeResult {
  if (!isRecord(record)) return { available: false, reason: 'record is not an object' };
  if (record['type'] !== 'assistant') {
    return { available: false, reason: 'probe was given a non-assistant record' };
  }

  if (typeof record['uuid'] !== 'string') return { available: false, reason: 'no string `uuid`' };
  if (typeof record['sessionId'] !== 'string') {
    return { available: false, reason: 'no string `sessionId`' };
  }
  if (typeof record['timestamp'] !== 'string' || !ISO.test(record['timestamp'])) {
    return { available: false, reason: '`timestamp` is not ISO-8601 — it must not be an epoch int' };
  }
  if (typeof record['isSidechain'] !== 'boolean') {
    return { available: false, reason: '`isSidechain` is not a boolean' };
  }

  const message = record['message'];
  if (!isRecord(message)) return { available: false, reason: 'no `message` object' };

  // The load-bearing one. A string `content` would let a coarser probe pass
  // while extraction silently returns zero — and a zero here reads as "you
  // used nothing, prune everything".
  if (!Array.isArray(message['content'])) {
    return {
      available: false,
      reason: '`message.content` is not an array — every signal lives inside it, so a ' +
        'changed shape here would silently yield zero invocations',
    };
  }

  return { available: true };
}

// ---------------------------------------------------------------------------
// Tool-name parsing
// ---------------------------------------------------------------------------

/**
 * Splits an MCP tool name.
 *
 * Two forms, and they must be parsed **distinctly** — a matcher written
 * against the bare server key never fires on the plugin form:
 *
 * ```
 * mcp__<server>__<tool>                      user / project scope
 * mcp__plugin_<plugin>_<server>__<tool>      plugin-bundled
 * ```
 *
 * The plugin↔server boundary in the second form is a **single `_`**, and both
 * plugin and server names may themselves contain `_` and `-`. That is
 * genuinely ambiguous from the string alone, so the split is resolved against
 * the known plugin list when one is supplied; without it, the longest-plugin
 * guess is recorded and flagged by returning the whole thing as the server.
 */
export function parseMcpToolName(
  name: string,
  knownPlugins: ReadonlySet<string> = new Set(),
): { server: string; tool: string; plugin?: string } | undefined {
  if (!name.startsWith('mcp__')) return undefined;

  const rest = name.slice('mcp__'.length);
  const split = rest.indexOf('__');
  if (split < 0) return undefined;

  const head = rest.slice(0, split);
  const tool = rest.slice(split + 2);
  if (tool === '') return undefined;

  if (!head.startsWith('plugin_')) return { server: head, tool };

  const scoped = head.slice('plugin_'.length);

  // Prefer a known plugin. `everything-claude-code_playwright` splits
  // correctly only because `everything-claude-code` is a plugin we know —
  // guessing at the first `_` would yield plugin `everything` and server
  // `claude-code_playwright`.
  for (const plugin of knownPlugins) {
    if (scoped === plugin) return { server: plugin, tool, plugin };
    if (scoped.startsWith(`${plugin}_`)) {
      return { plugin, server: scoped.slice(plugin.length + 1), tool };
    }
  }

  // No match. Recorded whole rather than split on a guess: a wrong attribution
  // is worse than an unattributed one, because it silently credits the wrong
  // plugin in the prune ranking.
  return { server: scoped, tool };
}

/** CLI built-ins. Counting these tells the user nothing they can act on. */
export const CLI_BUILTIN_COMMANDS = new Set([
  'model', 'clear', 'compact', 'mcp', 'plugin', 'effort', 'help', 'exit', 'quit',
  'resume', 'config', 'cost', 'doctor', 'init', 'login', 'logout', 'status', 'vim',
]);

/** `<command-name>/plan</command-name>` → `plan`. The name is **bare**. */
export function parseCommandName(content: string): string | undefined {
  const match = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/u.exec(content);
  if (match === undefined || match === null) return undefined;
  const name = match[1];
  return name === undefined || name === '' ? undefined : name;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

interface Envelope {
  ts: string;
  sessionId: string;
  isSidechain: boolean;
  cwd?: string;
  ccVersion?: string;
}

function envelopeOf(record: Record<string, unknown>): Envelope | undefined {
  const ts = record['timestamp'];
  const sessionId = record['sessionId'];
  const isSidechain = record['isSidechain'];
  if (typeof ts !== 'string' || typeof sessionId !== 'string' || typeof isSidechain !== 'boolean') {
    return undefined;
  }

  const cwd = record['cwd'];
  const version = record['version'];
  return {
    ts,
    sessionId,
    isSidechain,
    ...(typeof cwd === 'string' ? { cwd } : {}),
    ...(typeof version === 'string' ? { ccVersion: version } : {}),
  };
}

/**
 * Extracts every signal from one record. Pure.
 *
 * `attachment` records are **57.5% of the corpus** and carry no invocation
 * signal, so they are rejected first — the cheapest possible win on a 276,870
 * record scan.
 */
export function extractSignals(
  record: unknown,
  knownPlugins: ReadonlySet<string> = new Set(),
): Signal[] {
  if (!isRecord(record)) return [];

  const type = record['type'];
  if (type === 'attachment') return [];

  const envelope = envelopeOf(record);
  if (envelope === undefined) return [];

  const message = record['message'];
  if (!isRecord(message)) return [];

  // Commands are a `user` record whose content is a STRING, not an array.
  if (type === 'user') {
    const content = message['content'];
    if (typeof content !== 'string') return [];
    const name = parseCommandName(content);
    if (name === undefined || CLI_BUILTIN_COMMANDS.has(name)) return [];
    return [{ kind: 'command', entity: name, ...envelope }];
  }

  if (type !== 'assistant' || !Array.isArray(message['content'])) return [];

  const signals: Signal[] = [];
  for (const block of message['content'] as unknown[]) {
    if (!isRecord(block) || block['type'] !== 'tool_use') continue;

    const name = block['name'];
    if (typeof name !== 'string') continue;
    const input = isRecord(block['input']) ? block['input'] : {};

    if (name === 'Skill') {
      const skill = input['skill'];
      if (typeof skill === 'string') signals.push({ kind: 'skill', entity: skill, ...envelope });
      continue;
    }

    // **`Agent`, not `Task`.** Never prefix-match `Task`: TaskCreate,
    // TaskUpdate, TaskList and TaskStop are a different feature entirely, so
    // a prefix matcher hits the wrong tool 244 times and the right one never.
    if (name === 'Agent') {
      const subagent = input['subagent_type'];
      if (typeof subagent === 'string') signals.push({ kind: 'agent', entity: subagent, ...envelope });
      continue;
    }

    const mcp = parseMcpToolName(name, knownPlugins);
    if (mcp !== undefined) {
      signals.push({
        kind: 'mcp',
        entity: `${mcp.server}/${mcp.tool}`,
        server: mcp.server,
        ...(mcp.plugin !== undefined ? { plugin: mcp.plugin } : {}),
        ...envelope,
      });
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Enumerates transcript files **recursively**.
 *
 * Sidecars live at `<session-uuid>/subagents/agent-<id>.jsonl` and are **324
 * of 384 files** on the reference machine — 46% of assistant records. A
 * non-recursive walk misses nearly half the data and reports the rest as the
 * whole picture.
 *
 * Third-party plugins also write `.jsonl` under `projects/**` (memory,
 * session-memory, workflows). They are not rejected by path — a name-based
 * exclusion list would need updating for every new plugin — but by the probe,
 * which they fail because they are not transcripts.
 */
export async function enumerateTranscripts(projectsRoot: string): Promise<string[]> {
  const out: string[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    // Bounded: the observed layout is at most projects/<p>/<session>/subagents/.
    if (depth > 4) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
    }
  };

  await walk(projectsRoot, 0);
  return out;
}

/**
 * Scans one file: probe, then extract.
 *
 * Streamed line by line rather than read whole. The corpus is 276,870 records
 * and a single session file can be tens of megabytes; `readFile` on the set
 * would hold all of it in memory at once for no benefit, since every line is
 * independent.
 *
 * A malformed line is skipped rather than failing the file. 0 parse failures
 * were observed in 276,870 lines, but a file being appended to *while* it is
 * read has a legitimately truncated last line.
 */
export async function scanTranscript(
  file: string,
  knownPlugins: ReadonlySet<string> = new Set(),
  startOffset = 0,
): Promise<FileScan> {
  let bytes = startOffset;
  try {
    bytes = (await stat(file)).size;
  } catch {
    return {
      file,
      probe: { available: false, reason: 'file could not be stat-ed' },
      signals: [],
      lines: 0,
      bytes: startOffset,
    };
  }

  const signals: Signal[] = [];
  let lines = 0;
  let probe: ProbeResult | undefined;

  /**
   * Records seen before the probe could run.
   *
   * The probe fires on the first `assistant` record, but signals appear
   * *before* one: the first four records of every file are session-state, and
   * a slash command typed at the very start of a session is a `user` record
   * that precedes any model reply. Extracting only after the probe silently
   * dropped those — measured on the reference machine as 3 of 4 non-builtin
   * commands found instead of 4, which is a 25% undercount on the signal the
   * prune ranking is built from.
   *
   * Buffered rather than extracted eagerly, because a file that goes on to
   * FAIL the probe must contribute nothing at all.
   */
  const pending: unknown[] = [];

  const stream = createReadStream(file, { encoding: 'utf8', start: startOffset });
  const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  try {
    for await (const line of reader) {
      if (line.trim() === '') continue;
      lines += 1;

      let record: unknown;
      try {
        record = JSON.parse(line) as unknown;
      } catch {
        continue;
      }

      // Probe on the FIRST assistant record, then trust the file. The first
      // four records of every file are session-state — no uuid, no timestamp,
      // no cwd — so probing record 0 would reject every transcript there is.
      if (probe === undefined && isRecord(record) && record['type'] === 'assistant') {
        probe = probeAssistantRecord(record);
        // A file that fails the probe contributes nothing — including the
        // records already buffered, which is why they were buffered.
        if (!probe.available) break;
        for (const buffered of pending) signals.push(...extractSignals(buffered, knownPlugins));
        pending.length = 0;
      }

      if (probe === undefined) pending.push(record);
      else signals.push(...extractSignals(record, knownPlugins));
    }
  } catch (error: unknown) {
    return {
      file,
      probe: {
        available: false,
        reason: `read failed: ${error instanceof Error ? error.message : String(error)}`,
      },
      signals: [],
      lines,
      bytes,
    };
  } finally {
    reader.close();
    stream.destroy();
  }

  return {
    file,
    // A file with no assistant record at all is not a broken transcript — it
    // is a session where the model never replied, or a plugin's state file.
    // Reported as unavailable-with-reason so it is never counted as empty.
    probe: probe ?? { available: false, reason: 'no assistant record to probe' },
    signals,
    lines,
    bytes,
  };
}
