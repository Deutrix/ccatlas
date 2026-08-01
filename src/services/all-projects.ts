/**
 * `report --all-projects` — T3.13, T3.14 🔒📏, T3.15 📏.
 *
 * ## One global scan, N overlays
 *
 * The global inventory is collected **once** and every project report is that
 * baseline plus the repo's overlay. Re-collecting per project would multiply
 * the `claude` subprocess cost — already the entire wall clock, ~1.9s — by the
 * number of projects, which on this machine is 93.
 *
 * ## The redaction gate is the point of T3.14
 *
 * `--all-projects` writes one file per project, and a project is identified by
 * its absolute path: `C:\Users\<real name>\clients\<client name>\<product>`.
 * A directory of those is a disclosure of who someone is, who they work for,
 * and what they are building — from a command whose output people share
 * precisely because it looks like a dashboard.
 *
 * So `--all-projects` **refuses to run without `--redact`** unless the refusal
 * is explicitly overridden, and the assertion covers **filenames as well as
 * contents**: `p-<hash>.html` rather than `p-clients-bigcorp.html`, because a
 * directory listing leaks just as effectively as a page body.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Hash used for per-project filenames. */
export function projectSlug(projectPath: string): string {
  // FNV-1a, same as the cache key. Not cryptographic — it exists so a filename
  // carries no information, not to resist an attacker who already has the
  // report. A 32-bit space over a few hundred projects is ample.
  let hash = 0x811c9dc5;
  for (const char of projectPath.toLowerCase()) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `p-${hash.toString(16).padStart(8, '0')}`;
}

export interface AllProjectsGate {
  readonly allowed: boolean;
  readonly reason?: string;
}

/**
 * T3.14 🔒 — decides whether `--all-projects` may run.
 *
 * Fails **closed**. The override exists because a user genuinely may want an
 * unredacted local sweep, but it has to be typed, and it is not `--yes`: an
 * explicit `--allow-paths` says what is being permitted rather than merely
 * agreeing to something unnamed.
 */
export function allProjectsGate(options: {
  readonly redact: boolean;
  readonly allowPaths: boolean;
}): AllProjectsGate {
  if (options.redact) return { allowed: true };
  if (options.allowPaths) return { allowed: true };

  return {
    allowed: false,
    reason:
      '--all-projects writes one file per project and a project is identified by its absolute ' +
      'path, which discloses who you are, who you work for, and what you are building. ' +
      'Re-run with --redact, or with --allow-paths if you have decided the output stays local.',
  };
}

export interface ProjectReportResult {
  readonly projectPath: string;
  readonly file: string;
  readonly bytes: number;
  readonly overBudget: boolean;
  /** Set when this project's report could not be produced. */
  readonly error?: string;
}

export interface IndexEntry {
  readonly slug: string;
  readonly label: string;
  readonly bytes: number;
  readonly overBudget: boolean;
  readonly error?: string;
}

/**
 * Renders the index page.
 *
 * Labels are the **slug** when redacting, never the path — a link text leaks
 * as readily as a filename, and an index whose body is clean while its anchors
 * spell out client names has redacted nothing.
 */
export function renderIndex(entries: readonly IndexEntry[], redacted: boolean): string {
  const esc = (v: string): string =>
    v.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');

  const rows = entries
    .map(
      (entry) =>
        `<li><a href="${esc(entry.slug)}.html">${esc(entry.label)}</a>` +
        `<span> — ${(entry.bytes / 1024).toFixed(1)}KB${entry.overBudget ? ' (over budget)' : ''}` +
        `${entry.error !== undefined ? ` — <em>${esc(entry.error)}</em>` : ''}</span></li>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ccatlas — projects</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--dim:#666}
@media(prefers-color-scheme:dark){:root{--bg:#16181c;--fg:#e6e6e6;--dim:#9aa0a6}}
body{margin:0;padding:2rem 1.25rem;background:var(--bg);color:var(--fg);
font:14px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:50rem;margin:0 auto}ul{padding-left:1.1rem}li{margin:.3rem 0}
span{color:var(--dim);font-size:.85rem}em{color:var(--dim)}
</style></head><body><main>
<h1>ccatlas — ${entries.length} project(s)</h1>
<p><span>${redacted ? 'Redacted: paths and hostnames are stripped, filenames are hashed.' : 'NOT redacted — this output contains absolute project paths.'}</span></p>
<ul>${rows}</ul>
</main></body></html>`;
}

/**
 * Writes one project's report, converting a failure into an entry.
 *
 * T3.15's rule: **one failing project renders an error card without failing
 * the run.** A sweep over 93 projects that aborts on the first unreadable
 * `.mcp.json` produces nothing, which is strictly worse than 92 reports and a
 * note.
 */
export async function writeProjectReport(
  outDir: string,
  projectPath: string,
  html: string | Error,
): Promise<ProjectReportResult> {
  const slug = projectSlug(projectPath);
  const file = path.join(outDir, `${slug}.html`);

  if (html instanceof Error) {
    return { projectPath, file, bytes: 0, overBudget: false, error: html.message };
  }

  await writeFile(file, html, 'utf8');
  const bytes = Buffer.byteLength(html, 'utf8');
  return { projectPath, file, bytes, overBudget: bytes > 120 * 1024 };
}
