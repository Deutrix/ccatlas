#!/usr/bin/env node
/**
 * Repository leak scan.
 *
 * The fixture corpus is captured from a real machine, so this gate exists to
 * make "we redacted it" a checked claim rather than an assertion. It runs in
 * CI and fails the build on any hit.
 *
 * Two rules that keep it honest, because a gate that cries wolf gets ignored:
 *
 *  1. `fixtures/synthetic/` is EXCLUDED from the leak rules and held to the
 *     opposite standard instead — everything credential-shaped in there MUST
 *     look unmistakably fake. Those fixtures exist precisely to trip secret
 *     detectors (T1.16, T5.5-T5.7); scanning them as if they were real would
 *     guarantee a permanent red build. See fixtures/synthetic/SECRETS-README.md.
 *
 *  2. Prose that *documents* a redaction pattern is not a leak. A findings
 *     file saying "scanned for the local username, hostname and token
 *     prefixes" is evidence the work was done. Only ALLOWLISTED files get this
 *     latitude, and only for identifier patterns — never for anything
 *     credential-shaped.
 *
 * Usage:  node scripts/leak-scan.mjs
 * Exit:   0 clean · 1 leak found
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Scope, and why it is split.
 *
 * IDENTIFIER patterns (username, hostname, home paths) are checked ONLY in the
 * captured fixtures, because that is where redaction was promised. Authored
 * code is different in kind: `tests/util/project-path.test.mjs` contains real
 * Windows/WSL path forms *as its subject* — a normaliser that has never seen a
 * real path shape is untested. Flagging those would be flagging the test for
 * doing its job, and a gate that flags correct work gets switched off.
 *
 * CREDENTIAL patterns are checked everywhere. A real token has no legitimate
 * place in this repository.
 */
const CAPTURED_ROOTS = ['fixtures/cli', 'fixtures/files', 'fixtures/transcripts'];
const AUTHORED_ROOTS = ['src', 'tests', 'docs', 'scripts'];

/** Deliberately fake by design — inverted rule, see checkSynthetic(). */
const SYNTHETIC_ROOT = 'fixtures/synthetic';

/**
 * Files permitted to name identifier patterns in prose, because describing a
 * redaction is not performing a leak. Credential patterns are NEVER excused.
 */
const PROSE_ALLOWLIST = [
  /fixtures[\\/].*FINDINGS\.md$/,
  /docs[\\/]FORMATS\.md$/,
  /scripts[\\/]leak-scan\.mjs$/,
];

/** Credential-shaped. Never excused, anywhere outside the synthetic root. */
const CREDENTIAL = [
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'openai-style key'],
  [/\bghp_[A-Za-z0-9]{20,}/g, 'github pat (classic)'],
  [/\bgho_[A-Za-z0-9]{20,}/g, 'github oauth token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github pat (fine-grained)'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, 'slack token'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'aws access key id'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'jwt'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, 'private key block'],
  [/\b[a-z+]{2,15}:\/\/[^\s:@/"']+:[^\s@/"']+@/g, 'url with inline credentials'],
];

/** Escapes a machine-derived string for safe use inside a RegExp. */
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * Whoever is running this, plus the pieces of their machine identity worth
 * catching. Derived from the OS rather than hardcoded.
 *
 * This gate used to name one contributor literally, which meant it protected
 * exactly that person: anyone else could commit their own username and paths
 * and the build stayed green. A public repo makes that the common case, not
 * the edge case.
 *
 * Short, generic values are dropped — a username like `dev` or `ci` would match
 * inside ordinary words and turn every run red. That is a deliberate hole: the
 * path and email patterns below still fire, and a gate nobody can keep green
 * gets disabled, which protects nobody at all.
 */
function machineIdentity() {
  const out = [];
  const add = (value, label) => {
    if (typeof value === 'string' && value.length >= 4) {
      out.push([new RegExp(reEscape(value), 'gi'), label]);
    }
  };

  try {
    add(os.userInfo().username, 'username');
  } catch {
    // No passwd entry (some containers). The patterns below still apply.
  }
  add(os.hostname().split('.')[0], 'hostname');
  return out;
}

/** Machine identity. Excused only in allowlisted prose. */
const IDENTIFIER = [
  ...machineIdentity(),
  [/[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/g, 'windows user path'],
  [/\/mnt\/[a-z]\/Users\/[A-Za-z0-9._-]+/gi, 'wsl user path'],
  [/\/(?:home|Users)\/[A-Za-z0-9._-]+\//g, 'posix home path'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'email'],
];

/** A synthetic credential must announce itself as fake. */
const SENTINEL = /SYNTHETIC|FAKE|EXAMPLE|NOTREAL|PLACEHOLDER|DUMMY|0000|XXXX/i;

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(f));
    else out.push(f);
  }
  return out;
}

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

/**
 * Reserved-for-documentation values. RFC 2606 reserves example.com; `user:pass`
 * and friends are placeholders naming a *shape*, which is what the architecture
 * doc does when it lists secret-detection heuristics. Describing the shape of a
 * credential is not disclosing one.
 */
const GENERIC = /example\.(com|org|net)|user:pass|username:password|<[A-Z_-]+>|\$\{[A-Z_]+\}|SYNTHETIC|FAKE|REDACTED|PLACEHOLDER/i;

function checkReal() {
  const findings = [];

  // Credentials: everywhere, no exemption beyond obvious documentation shapes.
  for (const root of [...CAPTURED_ROOTS, ...AUTHORED_ROOTS]) {
    for (const file of walk(root)) {
      const s = read(file);
      if (s === null) continue;
      for (const [re, label] of CREDENTIAL) {
        for (const m of s.match(re) || []) {
          const window = s.slice(Math.max(0, s.indexOf(m) - 40), s.indexOf(m) + 160);
          if (GENERIC.test(m) || GENERIC.test(window)) continue;
          findings.push({ file, label, sample: m.slice(0, 40) });
        }
      }
    }
  }

  // Identifiers: captured fixtures only — see the scope note above.
  for (const root of CAPTURED_ROOTS) {
    for (const file of walk(root)) {
      const s = read(file);
      if (s === null) continue;
      if (PROSE_ALLOWLIST.some((re) => re.test(file))) continue;
      for (const [re, label] of IDENTIFIER) {
        for (const m of s.match(re) || []) findings.push({ file, label, sample: m.slice(0, 40) });
      }
    }
  }

  return findings;
}

function checkSynthetic() {
  const findings = [];
  let total = 0;
  for (const file of walk(SYNTHETIC_ROOT)) {
    const s = read(file);
    if (s === null) continue;
    for (const [re, label] of CREDENTIAL) {
      for (const m of s.match(re) || []) {
        total++;
        // A PEM header is a fixed format string and cannot itself carry a
        // sentinel; judge the block that follows it instead.
        const idx = s.indexOf(m);
        const window = s.slice(idx, idx + 200);
        if (!SENTINEL.test(window)) {
          findings.push({ file, label, sample: m.slice(0, 40) });
        }
      }
    }
  }
  return { findings, total };
}

const real = checkReal();
const synth = checkSynthetic();

console.log(`real corpus  — ${real.length} finding(s)`);
for (const f of real) console.log(`   LEAK  ${f.label}: ${JSON.stringify(f.sample)}  <- ${f.file}`);

console.log(`synthetic    — ${synth.total} credential-shaped string(s), ${synth.findings.length} not marked fake`);
for (const f of synth.findings) console.log(`   UNMARKED  ${f.label}: ${JSON.stringify(f.sample)}  <- ${f.file}`);

if (real.length || synth.findings.length) {
  console.error('\nleak-scan FAILED');
  process.exit(1);
}
console.log('\nleak-scan clean');
