/**
 * T1.4 — the `skills` collector.
 *
 * Reads the on-disk component tree: `~/.claude/skills`, `~/.claude/agents`,
 * `~/.claude/commands`, and the same three under a project's `.claude/`.
 * Everything it emits is tagged `source: 'file'`; the CLI knows none of this.
 *
 * Four silent-failure modes shape the code:
 *
 *  1. A directory under the skills root carrying `.claude-plugin/plugin.json` is
 *     an `@skills-dir` PLUGIN, not a personal skill. None exists on the reference
 *     machine (161 of 161 plain) — proved against `fixtures/synthetic/skills-dir-plugin`.
 *  2. FORMATS.md trap 14 — sibling `.cursor-plugin/` `.codex-plugin/` `.kimi-plugin/`
 *     manifests make a filename search return ~2x the real count. Matching is on the
 *     `.claude-plugin/` PARENT DIRECTORY; the walk never enters a dot-directory.
 *  3. A bare name does not mean "personal" (plugin skills are bare too) and a colon
 *     does not mean "plugin" (personal commands namespace `<dir>:<name>`). Owner
 *     attribution is T1.6/T1.7's, against the inventory: entities carry
 *     `origin`/`owningPlugin` here and no shadowing winner is picked.
 *  4. `/model` `/clear` `/compact` `/mcp` `/plugin` `/effort` are CLI built-ins — not
 *     files, not prunable, never synthesised here. `isCliBuiltinCommand` is exported
 *     so the transcripts collector can filter the bare hits that DO name them.
 *
 * Read-only and non-throwing by construction: every read is individually guarded,
 * so an unreadable subtree degrades that subtree and a malformed `SKILL.md`
 * degrades that one entry (`state: 'error'`), never the run. Both raise
 * `partial` — incomplete output that never says so is the failure mode.
 */

import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type {
  CollectContext,
  Collector,
  CollectorResult,
  ComponentCounts,
  Entity,
  EntityId,
  EntityState,
  Origin,
  Scope,
  VersionInfo,
  Warning,
} from '../types.ts';

// --- Emitted shapes ----------------------------------------------------------

/** Fields every file-derived component shares. */
interface FileBackedEntity extends Entity {
  /** Absolute path of the defining file — `SKILL.md`, or the `.md` itself. */
  path: string;
  description?: string;
  /** Set only for components contributed by an `@skills-dir` plugin. */
  owningPlugin?: string;
  /** Set with `state: 'error'`. The entry degrades; the run does not. */
  parseError?: string;
}

export interface SkillEntity extends FileBackedEntity { id: EntityId & { kind: 'skill' } }

export interface AgentEntity extends FileBackedEntity { id: EntityId & { kind: 'agent' } }

export interface CommandEntity extends FileBackedEntity {
  id: EntityId & { kind: 'command' };
  /**
   * The name matches a CLI built-in. The file is still a real, prunable entity;
   * which one a slash reaches is unobserved, so this is a flag, not precedence.
   */
  collidesWithCliBuiltin?: boolean;
}

/**
 * `ComponentCounts` mirrors the CLI's "Component inventory", which has no
 * commands row. On-disk plugins do contribute commands, so the count is added
 * here rather than by editing the shared contract.
 */
export interface SkillsDirContributions extends ComponentCounts {
  commands: number;
}

/**
 * A plugin whose home is the personal skills root, not `plugins/cache/<m>/…`.
 *
 * Deliberately NOT a `PluginEntity`: that requires a `marketplace` and a boolean
 * `enabled`, and this population has neither — no marketplace in the path, and
 * no key in `settings.json → enabledPlugins`, the only home of the enabled bit.
 * The id form is T1.6's choice to make, not this collector's to invent.
 */
export interface SkillsDirPlugin {
  name: string;
  origin: Extract<Origin, 'skills-dir'>;
  scope: Scope;
  source: 'file';
  state: EntityState;
  /** The plugin directory. */
  path: string;
  /** Always `<path>/.claude-plugin/plugin.json` — the only manifest that loads. */
  manifestPath: string;
  version: VersionInfo;
  contributes: SkillsDirContributions;
  /**
   * Component paths as the manifest declares them. Recorded, never acted on:
   * collection walks the conventional `skills/` `agents/` `commands/`, and no
   * fixture exists in which a declared path diverges from those.
   */
  declaredPaths: { skills: string[]; agents: string[]; commands: string[] };
  parseError?: string;
}

export interface SkillsInventory {
  skills: SkillEntity[];
  agents: AgentEntity[];
  commands: CommandEntity[];
  skillsDirPlugins: SkillsDirPlugin[];
}

// --- CLI built-in commands — FORMATS.md trap 4 -------------------------------

export const CLI_BUILTIN_COMMANDS: readonly string[] = ['clear', 'compact', 'effort', 'mcp', 'model', 'plugin'];

const BUILTIN_SET = new Set(CLI_BUILTIN_COMMANDS);

/** Accepts both `clear` and `/clear`; transcripts record the leading slash. */
export function isCliBuiltinCommand(name: string): boolean {
  return BUILTIN_SET.has(name.startsWith('/') ? name.slice(1) : name);
}

// --- Frontmatter -------------------------------------------------------------

export interface Frontmatter {
  name?: string;
  description?: string;
  /** Set when the block opened and never closed. Absent frontmatter is normal. */
  error?: string;
}

const FRONTMATTER_KEYS = new Set(['name', 'description']);

/**
 * Enough YAML for the two keys that matter, and no more. The opening `---` must
 * be the FIRST line (a BOM aside): many real command files have no frontmatter
 * and start with a heading, and a parser that hunts for the first `---`
 * anywhere swallows the body of any file containing a horizontal rule.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = body.split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') return {};

  const end = lines.findIndex((line, index) => index > 0 && ['---', '...'].includes(line.trim()));
  if (end === -1) return { error: 'unterminated frontmatter block' };

  const result: Frontmatter = {};
  let currentKey: string | undefined;

  for (const raw of lines.slice(1, end)) {
    const line = raw.replace(/\s+$/, '');
    if (line === '' || line.trimStart().startsWith('#')) continue;

    // Indented lines fold into the key above — block scalars and wrapped values.
    const key = currentKey as 'name' | 'description';
    if (/^\s/.test(line) && currentKey) {
      result[key] = `${result[key] ?? ''} ${line.trim()}`.trim();
      continue;
    }

    const separator = line.indexOf(':');
    if (separator === -1) {
      currentKey = undefined;
      continue;
    }
    const declared = line.slice(0, separator).trim();
    currentKey = FRONTMATTER_KEYS.has(declared) ? declared : undefined;
    if (currentKey) result[currentKey as 'name' | 'description'] = scalar(line.slice(separator + 1));
  }

  return result;
}

/** Unwraps quotes and block-scalar markers; the folded text arrives as continuations. */
function scalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '>' || trimmed === '|' || /^[>|][-+]?$/.test(trimmed)) return '';
  const quoted = /^(["'])([\s\S]*)\1$/.exec(trimmed);
  return quoted?.[2] ?? trimmed;
}

// --- Walk --------------------------------------------------------------------

/** Grouping directories are shallow in practice; the cap bounds a symlink-free cycle. */
const MAX_DEPTH = 5;

/**
 * One guarded read per directory. An ABSENT directory is normal — a fresh
 * machine has no `~/.claude/commands` — and is silently empty. Anything else
 * (EPERM, ENOTDIR) means uncollected components exist, and reporting those as
 * "none" is the exact failure this tool exists to avoid: it degrades loudly.
 */
async function readDir(dir: string, warnings: Warning[]): Promise<Dirent[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch (err) {
    const reason = message(err);
    if (!/ENOENT/.test(reason)) {
      warnings.push({ code: 'partial', message: `unreadable directory: ${reason}`, subject: dir });
    }
    return [];
  }
}

/** Dot-directories are never component sources — and this is the trap-14 defence. */
function walkableDirs(entries: readonly Dirent[]): Dirent[] {
  return entries.filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.'));
}

interface ReadResult {
  frontmatter: Frontmatter;
  error?: string;
}

async function readFrontmatter(file: string): Promise<ReadResult> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    return { frontmatter: {}, error: `unreadable file: ${message(err)}` };
  }
  const frontmatter = parseFrontmatter(text);
  return frontmatter.error ? { frontmatter: {}, error: frontmatter.error } : { frontmatter };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- Collection --------------------------------------------------------------

interface Placement {
  scope: Scope;
  origin: Origin;
  owningPlugin?: string;
}

/** Where a walk deposits what it finds, and where it reports what it could not read. */
interface Sink {
  out: SkillsInventory;
  warnings: Warning[];
}

/**
 * Common tail of every emitted entity: state, provenance and the optional
 * fields. A degraded entry also raises `partial`, so a reader looking only at
 * `warnings` still learns the section is incomplete.
 */
function decorate(
  file: string,
  placement: Placement,
  read: ReadResult,
  sink: Sink,
): Omit<FileBackedEntity, 'id' | 'origin'> {
  if (read.error) sink.warnings.push({ code: 'partial', message: read.error, subject: file });
  return {
    state: read.error ? 'error' : 'enabled',
    source: 'file',
    path: file,
    ...(read.frontmatter.description ? { description: read.frontmatter.description } : {}),
    ...(placement.owningPlugin ? { owningPlugin: placement.owningPlugin } : {}),
    ...(read.error ? { parseError: read.error } : {}),
  };
}

/**
 * Classifies one directory under a skills root: plugin, skill, or a grouping
 * directory to descend into. `detectPlugins` is off inside a plugin's own
 * `skills/` tree — a plugin nested in a plugin is unobserved, and promoting one
 * would double-count its components.
 */
async function classifySkillDir(
  dir: string,
  depth: number,
  placement: Placement,
  detectPlugins: boolean,
  sink: Sink,
): Promise<void> {
  const entries = await readDir(dir, sink.warnings);

  if (detectPlugins && entries.some((e) => e.name === '.claude-plugin' && e.isDirectory())) {
    const manifestPath = path.join(dir, '.claude-plugin', 'plugin.json');
    const collected = await collectSkillsDirPlugin(dir, manifestPath, placement.scope, sink);
    if (collected) return;
  }

  if (entries.some((e) => e.name === 'SKILL.md' && e.isFile())) {
    const file = path.join(dir, 'SKILL.md');
    const read = await readFrontmatter(file);
    sink.out.skills.push({
      id: { name: read.frontmatter.name ?? path.basename(dir), scope: placement.scope, kind: 'skill' },
      origin: placement.origin,
      ...decorate(file, placement, read, sink),
    });
    return;
  }

  if (depth >= MAX_DEPTH) return;
  for (const entry of walkableDirs(entries)) {
    await classifySkillDir(path.join(dir, entry.name), depth + 1, placement, detectPlugins, sink);
  }
}

async function walkSkillsRoot(
  root: string,
  placement: Placement,
  detectPlugins: boolean,
  sink: Sink,
): Promise<void> {
  for (const entry of walkableDirs(await readDir(root, sink.warnings))) {
    await classifySkillDir(path.join(root, entry.name), 1, placement, detectPlugins, sink);
  }
}

/**
 * Collects `.md` component files. Namespacing is the difference between the two
 * kinds: a command in a subdirectory is addressed `<dir>:<name>` (`sparc:tdd`),
 * an agent is not (`agents/swarm/adaptive-coordinator.md` → bare
 * `adaptive-coordinator`). Command names come from the path, never frontmatter
 * — that is what the live session roster shows.
 */
async function collectMarkdownDir(
  dir: string,
  kind: 'agent' | 'command',
  placement: Placement,
  sink: Sink,
  segments: readonly string[] = [],
): Promise<void> {
  if (segments.length > MAX_DEPTH) return;
  const entries = await readDir(dir, sink.warnings);

  for (const entry of entries) {
    if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
    const child = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await collectMarkdownDir(child, kind, placement, sink, [...segments, entry.name]);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;

    const stem = entry.name.slice(0, -'.md'.length);
    const read = await readFrontmatter(child);

    if (kind === 'agent') {
      sink.out.agents.push({
        id: { name: read.frontmatter.name ?? stem, scope: placement.scope, kind: 'agent' },
        origin: placement.origin,
        ...decorate(child, placement, read, sink),
      });
      continue;
    }

    const name = [...segments, stem].join(':');
    sink.out.commands.push({
      id: { name, scope: placement.scope, kind: 'command' },
      origin: placement.origin,
      ...decorate(child, placement, read, sink),
      ...(isCliBuiltinCommand(name) ? { collidesWithCliBuiltin: true } : {}),
    });
  }
}

// --- @skills-dir plugins -----------------------------------------------------

interface PluginManifest {
  name?: unknown;
  version?: unknown;
  skills?: unknown;
  agents?: unknown;
  commands?: unknown;
}

function declaredList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

/**
 * Returns false when the manifest is absent — a `.claude-plugin/` holding no
 * `plugin.json` is a personal skill with an odd subdirectory, not a plugin.
 */
async function collectSkillsDirPlugin(dir: string, manifestPath: string, scope: Scope, sink: Sink): Promise<boolean> {
  let manifest: PluginManifest = {};
  let parseError: string | undefined;

  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PluginManifest;
  } catch (err) {
    const reason = message(err);
    // No manifest at all: not a plugin. Malformed manifest: still a plugin
    // Claude Code will try and fail to load — reporting it is the point.
    if (/ENOENT|EISDIR/.test(reason)) return false;
    parseError = `unreadable or invalid plugin.json: ${reason}`;
  }

  const name = typeof manifest.name === 'string' && manifest.name ? manifest.name : path.basename(dir);
  const version = typeof manifest.version === 'string' && manifest.version ? manifest.version : undefined;
  const placement: Placement = { scope, origin: 'skills-dir', owningPlugin: name };

  // Collected aside first so `contributes` counts what was actually found on
  // disk, not what the manifest claims.
  const contributed: SkillsInventory = { skills: [], agents: [], commands: [], skillsDirPlugins: [] };
  const nested: Sink = { out: contributed, warnings: sink.warnings };
  await walkSkillsRoot(path.join(dir, 'skills'), placement, false, nested);
  await collectMarkdownDir(path.join(dir, 'agents'), 'agent', placement, nested);
  await collectMarkdownDir(path.join(dir, 'commands'), 'command', placement, nested);

  sink.out.skills.push(...contributed.skills);
  sink.out.agents.push(...contributed.agents);
  sink.out.commands.push(...contributed.commands);

  sink.out.skillsDirPlugins.push({
    name,
    origin: 'skills-dir',
    scope,
    source: 'file',
    state: parseError ? 'error' : 'enabled',
    path: dir,
    manifestPath,
    version: version
      ? { version, versionSource: 'plugin-json' }
      : { version: 'unknown', versionSource: 'unknown' },
    contributes: {
      skills: contributed.skills.length,
      agents: contributed.agents.length,
      commands: contributed.commands.length,
      // Hook, MCP and LSP contributions of an @skills-dir plugin are unobserved
      // and belong to the config and mcp collectors; zero here is "not counted",
      // not "verified absent".
      hooks: 0,
      mcpServers: 0,
      lspServers: 0,
    },
    declaredPaths: {
      skills: declaredList(manifest.skills),
      agents: declaredList(manifest.agents),
      commands: declaredList(manifest.commands),
    },
    ...(parseError ? { parseError } : {}),
  });

  return true;
}

// --- Entry point -------------------------------------------------------------

/**
 * The corpus directory this collector reads in fixture mode. `ctx.fixtureRoot`
 * is the repository's `fixtures/`, NOT a `$HOME` substitute, so the `~/.claude`
 * stand-in is named here: the oracle's `rootStandsInFor` says its `./skills/`
 * stands in for `~/.claude/skills/`.
 */
export const SKILLS_DIR_FIXTURE = { dir: 'synthetic/skills-dir-plugin' } as const;

export interface CollectSkillsOptions {
  /**
   * Overrides for the roots this collector walks, so path resolution can be
   * exercised against a throwaway tree — `fixtureRoot` names `fixtures/` and
   * cannot stand in for a home directory. Never set in production.
   */
  readonly roots?: { readonly home?: string; readonly projectDir?: string };
}

interface Root {
  dir: string;
  origin: Origin;
  scope: Scope;
}

/**
 * Fixture mode reads the synthetic corpus and nothing else — no home directory,
 * no project tree — which is what makes "never hits the real machine" testable.
 *
 * Outside it, `CLAUDE_CONFIG_DIR` is honoured because Claude Code honours it.
 * It names the config directory ITSELF, replacing `~/.claude` rather than
 * `~`, and is isolated here so T1.6 can lift one implementation for all five
 * collectors — `config` currently does not consult it.
 */
function resolveRoots(ctx: CollectContext, options: CollectSkillsOptions): Root[] {
  if (ctx.fixtureRoot !== undefined) {
    const dir = path.join(ctx.fixtureRoot, ...SKILLS_DIR_FIXTURE.dir.split('/'));
    const out: Root[] = [{ dir, origin: 'personal', scope: 'user' }];
    // `ctx.project` is production data and would point the walk at a real tree,
    // so it is ignored here. An explicit `roots.projectDir` is the caller opting
    // in — the corpus has no project-scope fixture, and without this the
    // project branch would be unreachable whenever `fixtureRoot` is set.
    if (options.roots?.projectDir !== undefined) {
      out.push({ dir: path.join(options.roots.projectDir, '.claude'), origin: 'project', scope: 'project' });
    }
    return out;
  }

  const home = options.roots?.home;
  const configured = process.env['CLAUDE_CONFIG_DIR'];
  const userRoot = home
    ? path.join(home, '.claude')
    : configured && configured.trim()
      ? configured
      : path.join(os.homedir(), '.claude');

  const out: Root[] = [{ dir: userRoot, origin: 'personal', scope: 'user' }];
  const projectDir = options.roots?.projectDir ?? ctx.project?.displayPath;
  if (projectDir !== undefined) {
    out.push({ dir: path.join(projectDir, '.claude'), origin: 'project', scope: 'project' });
  }
  return out;
}

async function collectRoot(root: Root, sink: Sink): Promise<void> {
  const placement: Placement = { scope: root.scope, origin: root.origin };
  await walkSkillsRoot(path.join(root.dir, 'skills'), placement, true, sink);
  await collectMarkdownDir(path.join(root.dir, 'agents'), 'agent', placement, sink);
  await collectMarkdownDir(path.join(root.dir, 'commands'), 'command', placement, sink);
}

export async function collectSkills(
  ctx: CollectContext,
  options: CollectSkillsOptions = {},
): Promise<CollectorResult<SkillsInventory>> {
  const started = performance.now();
  const warnings: Warning[] = [];

  try {
    const data: SkillsInventory = { skills: [], agents: [], commands: [], skillsDirPlugins: [] };
    const sink: Sink = { out: data, warnings };

    for (const root of resolveRoots(ctx, options)) await collectRoot(root, sink);

    return { ok: true, data, warnings, elapsedMs: Math.round(performance.now() - started) };
  } catch (err) {
    // Unreachable by design — every read is guarded — but the contract is that
    // a failure is a value, so the catch stays.
    const reason = message(err);
    return {
      ok: false,
      data: null,
      warnings: [...warnings, { code: 'collector-failed', message: `skills collector failed: ${reason}` }],
      error: { code: 'skills-collector-failed', message: reason },
      elapsedMs: Math.round(performance.now() - started),
    };
  }
}

export const skillsCollector: Collector<SkillsInventory> = {
  name: 'skills',
  collect: collectSkills,
};
